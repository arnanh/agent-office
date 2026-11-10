// Hybrid real-time ray tracer for the office.
//
//  1. City + sky are rasterized as before (they're outside, seen through glass).
//  2. The office and Bloops are rasterized into a G-buffer (albedo, normal, roughness, metalness, depth).
//  3. A full-screen pass traces, per pixel: one resampled shadow ray toward the office's lights,
//     a sun/moon shadow ray, one bounce of diffuse light, and one GGX reflection ray, against a BVH
//     of the whole office (three-mesh-bvh) plus analytic spheres for every Bloop.
//  4. Temporal accumulation (reprojected with the previous camera) and an edge-aware a-trous filter
//     denoise diffuse and specular separately.
//  5. Composite writes depth, so glass (which traces its own mirror reflection) and sprites draw on top.
//  6. Bloom + ACES tone mapping.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { FullScreenQuad, Pass } from "three/addons/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { bakeScene, LIGHT_RECT, MAX_CHAIR_IDS, type Bake, type RTLight } from "./bake.ts";
import type { MovingChair } from "../world/chairs.ts";
import { classify, textureAverage } from "./materials.ts";
import { MOODS, liveGroups } from "./moods.ts";
import * as plan from "../world/floorplan.ts";
import {
  ATROUS_FRAG,
  COMPOSITE_FRAG,
  FULLSCREEN_VERT,
  GBUFFER_FRAG,
  GBUFFER_VERT,
  GLASS_FRAG,
  GLASS_VERT,
  LIGHTS_PER_CELL,
  MAX_BLOOPS,
  MAX_MOVING_CHAIRS,
  TEMPORAL_FRAG,
  TRACE_FRAG,
} from "./glsl.ts";

export interface BloopProbe {
  body: THREE.Vector3;
  radius: number;
  color: THREE.Color;
  rough: number;
  bulb: THREE.Vector3;
  bulbOn: boolean;
  bulbColor: THREE.Color;
}

export interface RTHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cityGroup: THREE.Object3D;
  officeRoot: THREE.Object3D;
  /** Sun and moon from the day/night cycle (unit vectors, y up), 0..1 visibility, 0..1 night. */
  sky(): { sunDir: THREE.Vector3; sunElevation: number; moonDir: THREE.Vector3; moon: number; night: number };
  /** Every Bloop that should appear in reflections and cast shadows (including the player's). */
  bloops(): { root: THREE.Object3D; probe(out: BloopProbe): void }[];
  /** Swivel chairs turned away from their desks right now. */
  movingChairs(): MovingChair[];
  /** Changes whenever the office geometry changes (floor theme, cutaway view). */
  bakeKey(): string;
}

const MAX_LIGHTS = 1024;
const GRID = { minX: plan.PLATE.minX - 0.5, minZ: plan.PLATE.minZ - 0.5, cell: 1.5 };
const GRID_X = Math.ceil((plan.PLATE.maxX - plan.PLATE.minX + 1) / GRID.cell);
const GRID_Z = Math.ceil((plan.PLATE.maxZ - plan.PLATE.minZ + 1) / GRID.cell);
const ENCLOSED = plan.ROOMS.filter((r) => r.enclosed);

function roomAt(x: number, z: number) {
  for (let i = 0; i < ENCLOSED.length; i++) {
    const r = ENCLOSED[i].rect;
    if (x > r[0] && x < r[2] && z > r[1] && z < r[3]) return i;
  }
  return -1;
}

function target(count: number, type: THREE.TextureDataType, filter: THREE.MagnificationTextureFilter, depth = false) {
  const rt = new THREE.WebGLRenderTarget(1, 1, {
    count,
    type,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: depth,
    depthTexture: depth ? new THREE.DepthTexture(1, 1, THREE.FloatType) : undefined,
  });
  return rt;
}

export class RayTracer {
  enabled = true;
  moodIndex = 0;
  /** 0 final, 1 diffuse light, 2 reflections, 3 normals, 4 roughness/metal. */
  view = 0;
  specular = true;
  gi = true;
  denoise = true;
  /** Render resolution relative to CSS pixels. */
  pixelRatio = Math.min(window.devicePixelRatio, 1.25);
  readonly stats = { triangles: 0, lights: 0, bakeMs: 0, fps: 0, width: 0, height: 0 };

  private host: RTHost;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private bakes = new Map<string, Bake>();
  private bake: Bake | null = null;
  private bakeKey = "";
  private gbuf = [target(3, THREE.HalfFloatType, THREE.NearestFilter, true), target(3, THREE.HalfFloatType, THREE.NearestFilter, true)];
  private trace = target(2, THREE.HalfFloatType, THREE.NearestFilter);
  private hist = [target(2, THREE.HalfFloatType, THREE.LinearFilter), target(2, THREE.HalfFloatType, THREE.LinearFilter)];
  private filt = [target(2, THREE.HalfFloatType, THREE.NearestFilter), target(2, THREE.HalfFloatType, THREE.NearestFilter)];
  /** Last frame's finished HDR image, which rays reuse when they hit something that was on screen. */
  private prevColor = target(1, THREE.HalfFloatType, THREE.NearestFilter);
  private copyMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: `in vec2 vUv; uniform sampler2D tSrc; out vec4 oColor; void main() { oColor = texture(tSrc, vUv); }`,
    uniforms: { tSrc: { value: null } },
    depthTest: false,
    depthWrite: false,
  });
  /** Reuse last frame's pixels for ray hits that were on screen. */
  reuse = true;
  private cur = 0;
  private frame = 0;
  private prevViewProj = new THREE.Matrix4();
  private envRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  private cubeCam: THREE.CubeCamera;
  private envTimer = 1e9;
  private lightData = new Float32Array(4 * 4 * MAX_LIGHTS);
  private lightTex = new THREE.DataTexture(this.lightData, 4, MAX_LIGHTS, THREE.RGBAFormat, THREE.FloatType);
  private gridData = new Float32Array(LIGHTS_PER_CELL * GRID_X * GRID_Z).fill(-1);
  private gridTex = new THREE.DataTexture(this.gridData, LIGHTS_PER_CELL, GRID_X * GRID_Z, THREE.RedFormat, THREE.FloatType);
  private gridTimer = 0;
  private lights: RTLight[] = [];
  private liveTimer = 0;
  private gbufferMats = new Map<string, THREE.ShaderMaterial>();
  private glassMats = new Map<string, THREE.ShaderMaterial>();
  private probe: BloopProbe = { body: new THREE.Vector3(), radius: 0, color: new THREE.Color(), rough: 0.2, bulb: new THREE.Vector3(), bulbOn: false, bulbColor: new THREE.Color() };
  private fpsAcc = 0;
  private fpsFrames = 0;
  private lastTime = performance.now();

  /** Uniforms shared by the trace pass and the glass material. */
  readonly shared = {
    bvh: { value: null as unknown },
    attrNormal: { value: null as THREE.Texture | null },
    attrColor: { value: null as THREE.Texture | null },
    attrMat: { value: null as THREE.Texture | null },
    uBloopCount: { value: 0 },
    uBloopBody: { value: Array.from({ length: MAX_BLOOPS }, () => new THREE.Vector4()) },
    uBloopColor: { value: Array.from({ length: MAX_BLOOPS }, () => new THREE.Vector4()) },
    uBloopBulb: { value: Array.from({ length: MAX_BLOOPS }, () => new THREE.Vector4()) },
    uBloopBulbColor: { value: Array.from({ length: MAX_BLOOPS }, () => new THREE.Vector4()) },
    uChairMoving: { value: 0 },
    uMovCount: { value: 0 },
    uMovA: { value: Array.from({ length: MAX_MOVING_CHAIRS }, () => new THREE.Vector4()) },
    uMovB: { value: Array.from({ length: MAX_MOVING_CHAIRS }, () => new THREE.Vector4()) },
    uMovS: { value: Array.from({ length: MAX_MOVING_CHAIRS }, () => new THREE.Vector4()) },
    uGroupScale: { value: [1, 1, 1, 1, 1, 1, 1, 1] },
    uEnv: { value: this.envRT.texture as THREE.Texture },
    uEnvScale: { value: 1 },
    uEnvMaxLod: { value: 8 },
    uAmbient: { value: new THREE.Color(0.02, 0.02, 0.02) },
    uLights: { value: this.lightTex as THREE.Texture },
    uLightGrid: { value: this.gridTex as THREE.Texture },
    uGrid: { value: new THREE.Vector4(GRID.minX, GRID.minZ, GRID.cell, GRID_X) },
    uGridSize: { value: new THREE.Vector2(GRID_X, GRID_Z) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0, 0, 0) },
    uSunCone: { value: Math.cos(THREE.MathUtils.degToRad(1.2)) },
  };
  private gbufUniforms = {
    gAlbedo: { value: null as THREE.Texture | null },
    gNormal: { value: null as THREE.Texture | null },
    gMat: { value: null as THREE.Texture | null },
    gDepth: { value: null as THREE.Texture | null },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
  };
  private traceMat: THREE.ShaderMaterial;
  private temporalMat: THREE.ShaderMaterial;
  private atrousMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();

  constructor(host: RTHost) {
    this.host = host;
    for (const t of [this.lightTex, this.gridTex]) {
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.needsUpdate = true;
    }
    this.cubeCam = new THREE.CubeCamera(0.5, 6000, this.envRT);
    const g = this.gbufUniforms;
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.traceMat = mk(TRACE_FRAG, {
      ...this.shared,
      ...g,
      uFrame: { value: 0 },
      uRes: { value: new THREE.Vector2() },
      uSpecular: { value: 1 },
      uGI: { value: 1 },
      prevColor: { value: this.prevColor.texture },
      prevDepth: { value: null },
      prevNormal: { value: null },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uReuse: { value: 1 },
    });
    this.temporalMat = mk(TEMPORAL_FRAG, {
      ...g,
      tDiffuse: { value: null },
      tSpec: { value: null },
      hDiffuse: { value: null },
      hSpec: { value: null },
      pNormal: { value: null },
      pDepth: { value: null },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uMaxHistory: { value: 24 },
      uTexel: { value: new THREE.Vector2() },
    });
    this.atrousMat = mk(ATROUS_FRAG, { ...g, tDiffuse: { value: null }, tSpec: { value: null }, uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 } });
    this.compositeMat = mk(COMPOSITE_FRAG, { ...g, fDiffuse: { value: null }, fSpec: { value: null }, uGroupScale: this.shared.uGroupScale, uView: { value: 0 } });
    this.compositeMat.depthTest = true;
    this.compositeMat.depthWrite = true;
    this.compositeMat.depthFunc = THREE.LessEqualDepth;

    this.composer = new EffectComposer(host.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true }));
    this.composer.addPass(new RTPass(this));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.4, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  get mood() {
    return MOODS[this.moodIndex];
  }

  cycleMood() {
    this.moodIndex = (this.moodIndex + 1) % MOODS.length;
    this.gridTimer = 1e9;
    return this.mood.name;
  }

  setSize(w: number, h: number) {
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    const W = Math.max(1, Math.floor(w * this.pixelRatio));
    const H = Math.max(1, Math.floor(h * this.pixelRatio));
    for (const t of [...this.gbuf, this.trace, ...this.hist, ...this.filt, this.prevColor]) t.setSize(W, H);
    this.stats.width = W;
    this.stats.height = H;
  }

  private cssW = 0;
  private cssH = 0;

  render() {
    const r = this.host.renderer;
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== this.cssW || size.y !== this.cssH) {
      this.cssW = size.x;
      this.cssH = size.y;
      this.setSize(size.x, size.y);
    }
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    this.update(dt);
    if (!this.bake) {
      // First BVH still building: show the original raster look meanwhile.
      r.setRenderTarget(null);
      r.render(this.host.scene, this.host.camera);
      return;
    }
    const prevTone = r.toneMapping;
    const prevExposure = r.toneMappingExposure;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = this.mood.exposure;
    this.composer.render(dt);
    r.toneMapping = prevTone;
    r.toneMappingExposure = prevExposure;
  }

  /** Forget cached BVHs (call when the office's materials or layout change). */
  invalidate() {
    for (const b of this.bakes.values()) b.dispose();
    this.bakes.clear();
    this.bakeKey = "";
  }

  private pending = new Set<string>();

  private useBake(b: Bake) {
    this.bake = b;
    this.shared.bvh.value = b.uniforms.bvh;
    this.shared.attrNormal.value = b.uniforms.normal;
    this.shared.attrColor.value = b.uniforms.color;
    this.shared.attrMat.value = b.uniforms.mat;
    this.stats.triangles = b.triangles;
    this.stats.bakeMs = b.ms;
    this.gridTimer = 1e9;
    this.envTimer = 1e9;
  }

  /** True once there's a BVH to trace against (the first one builds in the background). */
  get ready() {
    return !!this.bake;
  }

  // ---------------------------------------------------------------- per-frame state
  private update(dt: number) {
    const host = this.host;
    const key = host.bakeKey();
    if (key !== this.bakeKey) {
      this.bakeKey = key;
      const b = this.bakes.get(key);
      if (b) this.useBake(b);
      else if (!this.pending.has(key)) {
        // Keep tracing against the previous BVH until the new one is ready.
        this.pending.add(key);
        void bakeScene(host.officeRoot).then((nb) => {
          this.pending.delete(key);
          if (this.bakes.size >= 4) {
            const [oldKey, old] = this.bakes.entries().next().value!;
            if (old !== this.bake) old.dispose();
            this.bakes.delete(oldKey);
          }
          this.bakes.set(key, nb);
          console.info(`[rt] baked ${nb.triangles.toLocaleString()} triangles, ${nb.lights.length} lights in ${nb.ms.toFixed(0)} ms`);
          if (this.bakeKey === key) this.useBake(nb);
        });
      }
    }

    // Mood: light group scales, fill light, sun.
    const sky = host.sky();
    const mood = this.mood;
    const groups = this.moodIndex === 0 ? liveGroups(sky.night) : mood.groups;
    groups.forEach((v, i) => (this.shared.uGroupScale.value[i] = v));
    this.shared.uAmbient.value.copy(mood.ambient).multiplyScalar(this.moodIndex === 0 ? THREE.MathUtils.lerp(1, 0.45, sky.night) : 1);
    this.shared.uEnvScale.value = mood.env;
    const sunUp = THREE.MathUtils.smoothstep(sky.sunElevation, -1, 8);
    const sun = this.shared.uSunColor.value;
    if (sunUp > 0.001) {
      this.shared.uSunDir.value.copy(sky.sunDir).normalize();
      const warm = THREE.MathUtils.smoothstep(sky.sunElevation, 0, 25);
      sun.setRGB(1.0, 0.72 + 0.22 * warm, 0.5 + 0.4 * warm).multiplyScalar(1.6 * sunUp * mood.sun);
    } else if (sky.moon > 0.01 && sky.moonDir.y > 0) {
      this.shared.uSunDir.value.copy(sky.moonDir).normalize();
      sun.setRGB(0.55, 0.65, 1.0).multiplyScalar(0.05 * sky.moon * mood.sun);
    } else sun.setRGB(0, 0, 0);

    // Bloops: spheres for reflections/shadows and their status bulbs as lights.
    const list = host.bloops();
    const s = this.shared;
    let n = 0;
    const bulbs: RTLight[] = [];
    for (const b of list) {
      if (n >= MAX_BLOOPS) break;
      b.root.traverse((o) => (o.userData.rtDynamic = true));
      b.probe(this.probe);
      const p = this.probe;
      if (p.radius < 0.02) continue;
      s.uBloopBody.value[n].set(p.body.x, p.body.y, p.body.z, p.radius * 0.97);
      s.uBloopColor.value[n].set(p.color.r, p.color.g, p.color.b, p.rough);
      const bulbR = p.bulbOn ? 0.052 * (p.radius / 0.32) : 0;
      s.uBloopBulb.value[n].set(p.bulb.x, p.bulb.y, p.bulb.z, bulbR);
      const strength = 9;
      s.uBloopBulbColor.value[n].set(p.bulbColor.r * strength, p.bulbColor.g * strength, p.bulbColor.b * strength, 0);
      if (bulbR > 0) {
        bulbs.push({
          type: 1,
          pos: p.bulb.clone(),
          u: new THREE.Vector3(bulbR, 0, 0),
          v: new THREE.Vector3(),
          radiance: p.bulbColor.clone().multiplyScalar(strength),
          group: 5,
          twoSided: true,
        });
      }
      n++;
    }
    s.uBloopCount.value = n;

    // Turned chairs (nearest first): skip their baked copy and trace them in their own frame.
    let mask = 0;
    let m = 0;
    const cam = host.camera.position;
    const moving = host.movingChairs().sort((p, q) => p.center.distanceToSquared(cam) - q.center.distanceToSquared(cam));
    for (const c of this.bake?.hasChair ? moving : []) {
      if (m >= MAX_MOVING_CHAIRS || c.id >= MAX_CHAIR_IDS) continue;
      mask |= 1 << c.id;
      s.uMovA.value[m].set(c.pivot.x, c.pivot.y, c.pivot.z, c.id);
      s.uMovB.value[m].set(Math.cos(c.yaw), Math.sin(c.yaw), 0, 0);
      s.uMovS.value[m].set(c.center.x, c.center.y, c.center.z, c.radius);
      m++;
    }
    s.uChairMoving.value = mask;
    s.uMovCount.value = m;

    // Lights: baked emitters (+ live monitor colours) and the bulbs.
    const baked = this.bake?.lights ?? [];
    this.liveTimer += dt;
    if (this.liveTimer > 0.4) {
      this.liveTimer = 0;
      for (const l of baked) if (l.live) l.radiance.copy(textureAverage(l.live.texture)).multiplyScalar(l.live.strength);
    }
    this.lights = baked.length + bulbs.length <= MAX_LIGHTS ? baked.concat(bulbs) : baked.slice(0, MAX_LIGHTS - bulbs.length).concat(bulbs);
    const d = this.lightData;
    this.lights.forEach((l, i) => {
      const o = i * 16;
      d[o] = l.pos.x; d[o + 1] = l.pos.y; d[o + 2] = l.pos.z; d[o + 3] = l.type;
      d[o + 4] = l.radiance.r; d[o + 5] = l.radiance.g; d[o + 6] = l.radiance.b; d[o + 7] = l.group;
      d[o + 8] = l.u.x; d[o + 9] = l.u.y; d[o + 10] = l.u.z; d[o + 11] = 0;
      d[o + 12] = l.v.x; d[o + 13] = l.v.y; d[o + 14] = l.v.z; d[o + 15] = l.twoSided ? 1 : 0;
    });
    this.lightTex.needsUpdate = true;
    this.stats.lights = this.lights.length;
    this.gridTimer += dt;
    if (this.gridTimer > 0.25) {
      this.gridTimer = 0;
      this.buildGrid(groups);
    }
  }

  /** For each floor cell, the lights most likely to matter there (by unshadowed estimate, same room first). */
  private buildGrid(groups: number[]) {
    const K = LIGHTS_PER_CELL;
    const lights = this.lights;
    const info = lights.map((l) => {
      const area = l.type === LIGHT_RECT ? 4 * l.u.length() * l.v.length() : Math.PI * l.u.x * l.u.x;
      const nrm = l.type === LIGHT_RECT ? new THREE.Vector3().crossVectors(l.u, l.v).normalize() : null;
      const power = (l.radiance.r * 0.2126 + l.radiance.g * 0.7152 + l.radiance.b * 0.0722) * (groups[l.group] ?? 1) * area;
      return { area, nrm, power, room: roomAt(l.pos.x, l.pos.z) };
    });
    const score = new Float32Array(lights.length);
    const order: number[] = [];
    const c = new THREE.Vector3();
    for (let gz = 0; gz < GRID_Z; gz++) {
      for (let gx = 0; gx < GRID_X; gx++) {
        c.set(GRID.minX + (gx + 0.5) * GRID.cell, 0.8, GRID.minZ + (gz + 0.5) * GRID.cell);
        const room = roomAt(c.x, c.z);
        order.length = 0;
        for (let i = 0; i < lights.length; i++) {
          const l = lights[i];
          const li = info[i];
          if (li.power <= 0) continue;
          const dx = c.x - l.pos.x, dy = c.y - l.pos.y, dz = c.z - l.pos.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          let s = li.power / (d2 + li.area + 0.5);
          if (li.nrm && !l.twoSided) {
            const facing = (li.nrm.x * dx + li.nrm.y * dy + li.nrm.z * dz) / Math.sqrt(d2 + 1e-6);
            if (facing < -0.35) continue;
          }
          if (li.room !== room) s *= 0.03;
          score[i] = s;
          order.push(i);
        }
        order.sort((a, b) => score[b] - score[a]);
        const base = (gz * GRID_X + gx) * K;
        for (let k = 0; k < K; k++) this.gridData[base + k] = k < order.length && score[order[k]] > 1e-5 ? order[k] : -1;
      }
    }
    this.gridTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- materials
  private gbufferMaterial(o: THREE.Mesh, src: THREE.Material): THREE.ShaderMaterial | null {
    const info = classify(o, src);
    if (info.kind !== "opaque") return null;
    const dyn = o.userData.rtDynamic ? 1 : 0;
    const key = `${src.uuid}|${o.userData.role ?? ""}|${JSON.stringify(o.userData.rt ?? "")}|${dyn}`;
    let m = this.gbufferMats.get(key);
    if (!m) {
      const defines: Record<string, string> = {};
      if (info.map) defines.HAS_MAP = "";
      m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: GBUFFER_VERT,
        fragmentShader: GBUFFER_FRAG,
        defines,
        side: src.side,
        vertexColors: !!(src as THREE.MeshBasicMaterial).vertexColors,
        uniforms: {
          uColor: { value: info.albedo.clone() },
          uMap: { value: info.map },
          uvTransform: { value: new THREE.Matrix3() },
          uEmissive: { value: info.emissive },
          uRough: { value: info.rough },
          uMetal: { value: info.metal },
          uGroup: { value: info.group },
          uF0: { value: info.f0 },
          uDynamic: { value: dyn },
        },
      });
      m.userData.colorFrom = (o.userData.rt?.color ?? src.userData.rt?.color) === undefined ? src : null;
      this.gbufferMats.set(key, m);
    }
    const from = m.userData.colorFrom as THREE.MeshBasicMaterial | null;
    if (from?.color) m.uniforms.uColor.value.copy(from.color);
    const map = m.uniforms.uMap.value as THREE.Texture | null;
    if (map) {
      map.updateMatrix();
      m.uniforms.uvTransform.value.copy(map.matrix);
    }
    return m;
  }

  private glassMaterial(src: THREE.Material, opacity: number): THREE.ShaderMaterial {
    let m = this.glassMats.get(src.uuid);
    if (!m) {
      m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: GLASS_VERT,
        fragmentShader: GLASS_FRAG,
        uniforms: {
          ...this.shared,
          uCamPos: this.gbufUniforms.uCamPos,
          uTint: { value: new THREE.Color().copy((src as THREE.MeshBasicMaterial).color ?? new THREE.Color(1, 1, 1)) },
          uOpacity: { value: opacity },
          uTintLevel: { value: 0.25 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      this.glassMats.set(src.uuid, m);
    }
    m.uniforms.uTintLevel.value = 0.05 + this.shared.uAmbient.value.r * 8;
    return m;
  }

  // ---------------------------------------------------------------- the frame
  renderFrame(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget) {
    const { scene, camera, cityGroup } = this.host;
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    const autoClear = renderer.autoClear;
    renderer.autoClear = true; // the scene's background colour is only drawn on auto-clear
    const kids = scene.children.filter((c) => c !== cityGroup && !(c as THREE.Light).isLight);
    const kidVis = kids.map((k) => k.visible);
    kids.forEach((k) => (k.visible = false));

    // Environment for rays that leave the office (sky, city), refreshed about once a second.
    this.envTimer += 1;
    if (this.envTimer > 45) {
      this.envTimer = 0;
      this.cubeCam.position.set(0, 1.5, 0);
      this.cubeCam.update(renderer, scene);
    }

    // 1. City + sky.
    renderer.setRenderTarget(out);
    renderer.render(scene, camera);
    kids.forEach((k, i) => (k.visible = kidVis[i]));
    renderer.autoClear = false;

    // 2. G-buffer of the office.
    const bg = scene.background;
    const fog = scene.fog;
    scene.background = null;
    scene.fog = null;
    cityGroup.visible = false;
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const hidden: THREE.Object3D[] = [];
    const glass: [THREE.Mesh, THREE.Material, number][] = [];
    for (const k of kids) {
      k.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          const gm = this.gbufferMaterial(mesh, src);
          if (gm) {
            swapped.push([mesh, mesh.material]);
            mesh.material = gm;
          } else {
            const info = classify(mesh, src);
            if (info.kind === "glass") glass.push([mesh, src, info.opacity]);
            hidden.push(mesh);
            mesh.visible = false;
          }
        } else if ((o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) {
          hidden.push(o);
          o.visible = false;
        }
      });
    }
    const gb = this.gbuf[this.cur];
    const prev = this.gbuf[1 - this.cur];
    renderer.setRenderTarget(gb);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    for (const [m, mat] of swapped) m.material = mat;

    // 3. Trace.
    const g = this.gbufUniforms;
    g.gAlbedo.value = gb.textures[0];
    g.gNormal.value = gb.textures[1];
    g.gMat.value = gb.textures[2];
    g.gDepth.value = gb.depthTexture;
    g.uInvProj.value.copy(camera.projectionMatrixInverse);
    g.uCamWorld.value.copy(camera.matrixWorld);
    g.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    g.uNear.value = camera.near;
    g.uFar.value = camera.far;
    const texel = new THREE.Vector2(1 / gb.width, 1 / gb.height);
    const tu = this.traceMat.uniforms;
    tu.uFrame.value = this.frame++;
    tu.uRes.value.set(gb.width, gb.height);
    tu.uSpecular.value = this.specular ? 1 : 0;
    tu.uGI.value = this.gi ? 1 : 0;
    tu.prevDepth.value = prev.depthTexture;
    tu.prevNormal.value = prev.textures[1];
    tu.uPrevViewProj.value.copy(this.prevViewProj);
    tu.uReuse.value = this.reuse && this.frame > 2 ? 1 : 0;
    if (this.bake) {
      this.quad.material = this.traceMat;
      renderer.setRenderTarget(this.trace);
      this.quad.render(renderer);
    }

    // 4. Temporal accumulation.
    const hNew = this.hist[this.cur];
    const hOld = this.hist[1 - this.cur];
    const t = this.temporalMat.uniforms;
    t.tDiffuse.value = this.trace.textures[0];
    t.tSpec.value = this.trace.textures[1];
    t.hDiffuse.value = hOld.textures[0];
    t.hSpec.value = hOld.textures[1];
    t.pNormal.value = prev.textures[1];
    t.pDepth.value = prev.depthTexture;
    t.uPrevViewProj.value.copy(this.prevViewProj);
    t.uMaxHistory.value = this.denoise ? 32 : 1;
    t.uTexel.value.copy(texel);
    this.quad.material = this.temporalMat;
    renderer.setRenderTarget(hNew);
    this.quad.render(renderer);
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // 5. A-trous filter (3 iterations: 1, 2, 4 px).
    let src: THREE.WebGLRenderTarget = hNew;
    if (this.denoise) {
      const a = this.atrousMat.uniforms;
      a.uTexel.value.copy(texel);
      this.quad.material = this.atrousMat;
      [1, 2, 4].forEach((step, i) => {
        const dst = this.filt[i % 2];
        a.tDiffuse.value = src.textures[0];
        a.tSpec.value = src.textures[1];
        a.uStep.value = step;
        renderer.setRenderTarget(dst);
        this.quad.render(renderer);
        src = dst;
      });
    }

    // 6. Composite over the city, writing the office's depth.
    const c = this.compositeMat.uniforms;
    c.fDiffuse.value = src.textures[0];
    c.fSpec.value = src.textures[1];
    c.uView.value = this.view;
    this.quad.material = this.compositeMat;
    renderer.setRenderTarget(out);
    this.quad.render(renderer);

    // 7. Glass (traced reflections) and sprites on top.
    const overlay: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    for (const o of hidden) o.visible = true;
    const opaqueHidden: THREE.Object3D[] = [];
    for (const [m] of swapped) {
      m.visible = false;
      opaqueHidden.push(m);
    }
    for (const [m, srcMat, opacity] of glass) {
      overlay.push([m, m.material]);
      m.material = this.glassMaterial(srcMat, opacity);
    }
    renderer.setRenderTarget(out);
    renderer.render(scene, camera);
    for (const [m, mat] of overlay) m.material = mat;
    for (const o of opaqueHidden) o.visible = true;

    // Keep this frame for next frame's rays to reuse.
    this.copyMat.uniforms.tSrc.value = out.texture;
    this.quad.material = this.copyMat;
    renderer.setRenderTarget(this.prevColor);
    this.quad.render(renderer);

    cityGroup.visible = true;
    scene.background = bg;
    scene.fog = fog;
    renderer.autoClear = autoClear;
    this.cur = 1 - this.cur;
  }
}

class RTPass extends Pass {
  private rt: RayTracer;
  constructor(rt: RayTracer) {
    super();
    this.rt = rt;
    this.needsSwap = false;
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    this.rt.renderFrame(renderer, read);
  }
}
