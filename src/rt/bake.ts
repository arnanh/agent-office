// Flattens the office into one triangle soup with per-vertex material data, builds a BVH over it
// (three-mesh-bvh, SAH), and pulls every emissive surface out as an area light.

import * as THREE from "three";
import { FloatVertexAttributeTexture, MeshBVH, MeshBVHUniformStruct, SAH } from "three-mesh-bvh";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
// @ts-expect-error: the worker helper ships without type declarations.
import { GenerateMeshBVHWorker } from "three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js";
import { classify, textureAverage, type RTInfo } from "./materials.ts";

export const LIGHT_RECT = 0;
export const LIGHT_SPHERE = 1;
/** Chairs that can swivel are tagged 2 + id in rtMat.w; the shader keeps a 31-bit mask of them. */
export const MAX_CHAIR_IDS = 31;
/**
 * One extra chair top, in its own frame, is stashed this far below the office (tagged 2 + 31).
 * Rays near a turned chair are moved into that frame, so turning chairs need no extra textures.
 */
export const CHAIR_STASH = new THREE.Vector3(0, -200, 0);

export interface RTLight {
  type: number;
  pos: THREE.Vector3;
  /** Rect: half-extent vectors (emits along cross(u, v)). Sphere: u.x is the radius. */
  u: THREE.Vector3;
  v: THREE.Vector3;
  radiance: THREE.Color;
  group: number;
  twoSided: boolean;
  /** For lights whose colour follows a canvas (monitors). */
  live?: { texture: THREE.Texture; strength: number };
}

export interface BakedMesh {
  bvh: MeshBVHUniformStruct;
  normal: FloatVertexAttributeTexture;
  color: FloatVertexAttributeTexture;
  mat: FloatVertexAttributeTexture;
}

export interface Bake {
  bvh: MeshBVH;
  uniforms: BakedMesh;
  /** Whether a swivel chair is stashed at CHAIR_STASH. */
  hasChair: boolean;
  lights: RTLight[];
  triangles: number;
  ms: number;
  dispose(): void;
}

const geoCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/** A position + normal (indexed) copy of a geometry, the only attributes the tracer needs. */
function lean(src: THREE.BufferGeometry) {
  let g = geoCache.get(src);
  if (g) return g;
  g = new THREE.BufferGeometry();
  g.setAttribute("position", src.attributes.position);
  if (src.attributes.normal) g.setAttribute("normal", src.attributes.normal);
  else {
    g.computeVertexNormals();
  }
  if (src.index) g.setIndex(src.index);
  else {
    const n = src.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (src.attributes.color) g.setAttribute("color", src.attributes.color);
  if (!g.attributes.normal) g.computeVertexNormals();
  g.computeBoundingBox();
  geoCache.set(src, g);
  return g;
}

/** "lights": hidden, but under a group whose lights stay on (the ceiling in the overview cutaway). */
function visibility(o: THREE.Object3D | null): "yes" | "lights" | "no" {
  let lightsOnly = false;
  for (let p = o; p; p = p.parent) {
    if (p.visible) continue;
    if (p.userData.rtKeepLights) lightsOnly = true;
    else return "no";
  }
  return lightsOnly ? "lights" : "yes";
}

const _m3 = new THREE.Matrix3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Area light matching an emissive mesh: a rectangle when it's flat, a sphere otherwise. */
function lightFor(g: THREE.BufferGeometry, matrix: THREE.Matrix4, radiance: THREE.Color, info: RTInfo, live: RTLight["live"]): RTLight | null {
  const box = g.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  box.getCenter(_c);
  const pos = _c.clone().applyMatrix4(matrix);
  _m3.setFromMatrix4(matrix);
  const axes = [new THREE.Vector3(size.x / 2, 0, 0), new THREE.Vector3(0, size.y / 2, 0), new THREE.Vector3(0, 0, size.z / 2)].map((a) => a.applyMatrix3(_m3));
  const order = [0, 1, 2].sort((a, b) => axes[a].length() - axes[b].length());
  const [thin, mid, big] = order.map((i) => axes[i]);
  if (big.length() < 1e-4) return null;
  // Average normal of the geometry decides which way a flat light faces.
  const nrm = g.attributes.normal;
  _n.set(0, 0, 0);
  for (let i = 0; i < nrm.count; i++) _n.x += nrm.getX(i), _n.y += nrm.getY(i), _n.z += nrm.getZ(i);
  _n.applyMatrix3(_m3.clone().invert().transpose());
  // True emitting area, so a ring or a lamp shade isn't treated as a solid rectangle or ball.
  const area = surfaceArea(g, matrix);
  if (thin.length() < 0.3 * mid.length()) {
    const u = big.clone();
    const v = mid.clone();
    const twoSided = _n.length() < 0.1 * nrm.count; // closed shapes (boxes) emit both ways
    if (new THREE.Vector3().crossVectors(u, v).dot(_n) < 0) v.negate();
    const rectArea = 4 * u.length() * v.length() * (twoSided ? 2 : 1);
    const scaled = radiance.clone().multiplyScalar(Math.min(1, area / rectArea));
    return { type: LIGHT_RECT, pos, u, v, radiance: scaled, group: info.group, twoSided, live };
  }
  const r = (thin.length() + mid.length() + big.length()) / 3;
  const scaled = radiance.clone().multiplyScalar(Math.min(1, area / 4 / (Math.PI * r * r)));
  return { type: LIGHT_SPHERE, pos, u: new THREE.Vector3(r, 0, 0), v: new THREE.Vector3(), radiance: scaled, group: info.group, twoSided: true, live };
}

function surfaceArea(g: THREE.BufferGeometry, matrix: THREE.Matrix4) {
  const pos = g.attributes.position;
  const idx = g.index!;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let sum = 0;
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(matrix);
    b.fromBufferAttribute(pos, idx.getX(i + 1)).applyMatrix4(matrix);
    c.fromBufferAttribute(pos, idx.getX(i + 2)).applyMatrix4(matrix);
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

/** Builds BVHs off the main thread, one at a time. */
let worker: GenerateMeshBVHWorker | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Snapshots the office as it is now (synchronously), then builds the BVH in a worker so the
 * game doesn't freeze while switching floors or views.
 */
export function bakeScene(root: THREE.Object3D): Promise<Bake> {
  const t0 = performance.now();
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  const lights: RTLight[] = [];
  const inst = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const tint = new THREE.Color();
  let hasChair = false;

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const vis = visibility(mesh);
    if (vis === "no") return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const info = classify(mesh, material);
    if (info.kind !== "opaque") return;
    const lightsOnly = vis === "lights";
    if (lightsOnly && !info.light) return;
    const g = lean(mesh.geometry);
    const albedo = info.albedo.clone();
    if (info.map?.image) albedo.multiply(textureAverage(info.map));
    const im = mesh as THREE.InstancedMesh;
    const count = im.isInstancedMesh ? im.count : 1;
    // Swivel chairs are baked facing their desks and tagged with their id; the tracer turns
    // the rays instead of the chair while one is swivelled (see MovingChair).
    const rest = mesh.userData.rtRest as THREE.Matrix4[] | undefined;
    // Moving parts with a fixed baked pose (lift doors, shut) give it in parent space.
    const bakeLocal = mesh.userData.rtBakeLocal as THREE.Matrix4 | undefined;
    for (let i = 0; i < count; i++) {
      if (bakeLocal && mesh.parent) world.multiplyMatrices(mesh.parent.matrixWorld, bakeLocal);
      else world.copy(mesh.matrixWorld);
      tint.setRGB(1, 1, 1);
      const chairId = rest && i < MAX_CHAIR_IDS ? i : -1;
      if (im.isInstancedMesh) {
        if (rest) inst.copy(rest[i]);
        else im.getMatrixAt(i, inst);
        world.multiply(inst);
        if (im.instanceColor) im.getColorAt(i, tint);
      }
      const c = albedo.clone().multiply(tint);
      if (lightsOnly) {
        const l = lightFor(g, world, c.clone().multiplyScalar(info.emissive), info, undefined);
        if (l) lights.push(l);
        continue;
      }
      const vc = (material as THREE.MeshBasicMaterial).vertexColors ? g.attributes.color : undefined;
      parts.push(tagged(g, world, c, vc, info, info.light ? 1 : chairId >= 0 ? 2 + chairId : 0));
      if (rest && i === 0) parts.push(tagged(g, new THREE.Matrix4().makeTranslation(CHAIR_STASH), c, vc, info, 2 + MAX_CHAIR_IDS));
      if (rest) hasChair = true;
      if (info.light && info.emissive > 0) {
        const radiance = c.clone().multiplyScalar(info.emissive);
        const live = info.liveMap && info.map ? { texture: info.map, strength: info.emissive } : undefined;
        const l = lightFor(g, world, radiance, info, live);
        if (l) lights.push(l);
      }
    }
  });

  const t1 = performance.now();
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  const t2 = performance.now();
  const job = queue.then(async () => {
    let bvh: MeshBVH;
    try {
      worker ??= new GenerateMeshBVHWorker();
      bvh = await worker.generate(merged, { strategy: SAH, maxLeafTris: 4 });
    } catch (err) {
      console.warn("[rt] BVH worker failed, building on the main thread", err);
      bvh = new MeshBVH(merged, { strategy: SAH, maxLeafTris: 4 });
    }
    console.info(`[rt] bake: collect ${(t1 - t0).toFixed(0)} ms, merge ${(t2 - t1).toFixed(0)} ms (main thread), bvh ${(performance.now() - t2).toFixed(0)} ms (worker)`);
    return finish(bvh, merged, lights, hasChair, t0);
  });
  queue = job.catch(() => undefined);
  return job;
}

/** A world-space copy of `g` with the tracer's per-vertex colour and material. */
function tagged(g: THREE.BufferGeometry, world: THREE.Matrix4, c: THREE.Color, vc: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, info: RTInfo, flag: number) {
  const part = g.clone();
  part.applyMatrix4(world);
  const n = part.attributes.position.count;
  const col = new Float32Array(n * 4);
  const mat = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    const r = vc ? vc.getX(k) : 1, gg = vc ? vc.getY(k) : 1, b = vc ? vc.getZ(k) : 1;
    col.set([c.r * r, c.g * gg, c.b * b, info.emissive], k * 4);
    mat.set([info.rough, info.metal, info.group, flag], k * 4);
  }
  part.deleteAttribute("color");
  part.setAttribute("rtColor", new THREE.BufferAttribute(col, 4));
  part.setAttribute("rtMat", new THREE.BufferAttribute(mat, 4));
  return part;
}

function upload(bvh: MeshBVH, g: THREE.BufferGeometry): BakedMesh {
  const out: BakedMesh = {
    bvh: new MeshBVHUniformStruct(),
    normal: new FloatVertexAttributeTexture(),
    color: new FloatVertexAttributeTexture(),
    mat: new FloatVertexAttributeTexture(),
  };
  out.bvh.updateFrom(bvh);
  out.normal.updateFrom(g.attributes.normal as THREE.BufferAttribute);
  out.color.updateFrom(g.attributes.rtColor as THREE.BufferAttribute);
  out.mat.updateFrom(g.attributes.rtMat as THREE.BufferAttribute);
  return out;
}

function disposeBaked(m: BakedMesh) {
  m.bvh.dispose();
  m.normal.dispose();
  m.color.dispose();
  m.mat.dispose();
}

function finish(bvh: MeshBVH, merged: THREE.BufferGeometry, lights: RTLight[], hasChair: boolean, t0: number): Bake {
  const uniforms = upload(bvh, merged);
  const triangles = merged.index!.count / 3;
  return {
    bvh,
    uniforms,
    hasChair,
    lights,
    triangles,
    ms: performance.now() - t0,
    dispose() {
      disposeBaked(uniforms);
      merged.dispose();
    },
  };
}
