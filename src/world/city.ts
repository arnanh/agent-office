// The downtown outside the office windows: our own tower's shell above and below the
// current floor, a street grid with neighboring towers, cars, trees, a park, a bay with a
// Ferris wheel, a distant skyline fading into haze, hills, a gradient sky and chunky clouds.
//
// Everything is merged into a handful of meshes (one per material) or instanced, so the
// whole city is roughly 20 draw calls. Nothing casts or receives shadows and the city
// needs no lights of its own. Local space: the street is at y = 0 inside `group`, and
// setElevation() slides the group down so the street sits `m` meters below the office floor.
//
// applyEnv() re-lights it for the time of day (see daynight.ts): the sky, fog and a tint on every
// lit material, plus night-only extras (lit windows, street lamps, headlights, beacons).

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { canvasTexture, flat, hashString, mesh, toon } from "./toon.ts";
import { CEILING_HEIGHT, FLOOR_TO_FLOOR, WINDOW_HEAD, WINDOW_SILL } from "./floorplan.ts";
import { NIGHT_SKY_GLSL, NightSky, nightSkyUniforms } from "./nightsky.ts";

/** Time-of-day lighting for the city, produced by DayNight. */
export interface CityEnv {
  top: THREE.Color;
  mid: THREE.Color;
  horizon: THREE.Color;
  glow: THREE.Color;
  glowAmt: number;
  /** Unit vectors in city space (x east, y up, -z north). */
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** Visibility 0..1. */
  moon: number;
  stars: number;
  /** Rotation from galactic coordinates to city space for the real sky right now (see nightsky.ts). */
  celestial: THREE.Matrix4;
  /** Multiplies every lit city material (white in daylight). */
  tint: THREE.Color;
  hills: THREE.Color;
  clouds: THREE.Color;
  /** 0 by day, 1 at night: street lamps, headlights, and the darkening of window glass. */
  night: number;
  /** 0 by day, 1 at full night: how far the office windows have come on (they light up one by one). */
  windows: number;
}

export interface City {
  group: THREE.Group;
  fog: THREE.Fog;
  background: THREE.Color;
  setElevation(m: number): void;
  update(dt: number, time: number): void;
  applyEnv(env: CityEnv): void;
  /** Our tower's shell and roof above the current floor. Hide it for a top-down cutaway view. */
  towerAbove: THREE.Object3D;
  /** Recommended camera far plane so the skyline and hills are not clipped. */
  cameraFar: number;
  /** Stars, Milky Way and shooting stars (e.g. nightSky.spawn(true) for a fireball). */
  nightSky: NightSky;
}

// ------------------------------------------------------------------ constants

const TX = 18.4; // our tower's half-extent in x (shell plane)
const TZ = 13.4; // ... and in z
const HOLE_Y0 = -0.4; // the office floor occupies HOLE_Y0..HOLE_Y1 (world space)
const HOLE_Y1 = CEILING_HEIGHT + 0.3;
const STOREY = FLOOR_TO_FLOOR;
const TOWER_ROOF = 182; // our tower's roof, meters above the street
const SIDEWALK = 4;
const HORIZON = "#dde9f2";
const FOG_NEAR = 140;
const FOG_FAR = 2700;
const WORLD = 2900; // half-size of the ground
const CAMERA_FAR = 3200;

const SUN_X = 0.555; // horizontal direction of the game's key light (6, 30, 9)
const SUN_Z = 0.832;

type V3 = [number, number, number];
type Loop = [number, number][];
type Rng = () => number;

function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const pick = <T>(r: Rng, arr: readonly T[]): T => arr[Math.floor(r() * arr.length) % arr.length];
const col = (hex: string) => new THREE.Color(hex);

// ------------------------------------------------------------------ geometry builder

/**
 * Accumulates flat-shaded, vertex-colored triangles (and optionally UVs) into one
 * BufferGeometry. Vertical faces get a gentle baked sun shade so façades read crisply
 * on top of the toon ramp.
 */
class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  clr: number[] = [];
  uvs: number[] = [];
  hasUv: boolean;
  shade: boolean;
  constructor(hasUv = false, shade = true) {
    this.hasUv = hasUv;
    this.shade = shade;
  }

  tri(a: V3, b: V3, c: V3, color: THREE.Color, ta?: [number, number], tb?: [number, number], tc?: [number, number]) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    let s = 1;
    if (this.shade) {
      if (ny > 0.6) s = 1;
      else if (ny < -0.6) s = 0.72;
      else {
        const h = Math.hypot(nx, nz) || 1;
        s = 0.86 + 0.14 * ((nx * SUN_X + nz * SUN_Z) / h);
      }
    }
    const r = color.r * s, g = color.g * s, bl = color.b * s;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.clr.push(r, g, bl);
    }
    if (this.hasUv) {
      const z: [number, number] = [0, 0];
      const A = ta ?? z, B = tb ?? z, C = tc ?? z;
      this.uvs.push(A[0], A[1], B[0], B[1], C[0], C[1]);
    }
  }

  /** a,b,c,d = bottom-left, bottom-right, top-right, top-left as seen from the front. */
  quad(a: V3, b: V3, c: V3, d: V3, color: THREE.Color, uv?: [number, number, number, number]) {
    if (uv) {
      const [u0, v0, u1, v1] = uv;
      this.tri(a, b, c, color, [u0, v0], [u1, v0], [u1, v1]);
      this.tri(a, c, d, color, [u0, v0], [u1, v1], [u0, v1]);
    } else {
      this.tri(a, b, c, color);
      this.tri(a, c, d, color);
    }
  }

  /** Horizontal rectangle facing up. */
  flatQuad(x0: number, z0: number, x1: number, z1: number, y: number, color: THREE.Color) {
    this.tri([x0, y, z0], [x0, y, z1], [x1, y, z1], color);
    this.tri([x0, y, z0], [x1, y, z1], [x1, y, z0], color);
  }

  /** Outward-facing walls around a loop (see rectLoop/circleLoop for orientation). */
  walls(loop: Loop, y0: number, y1: number, color: THREE.Color) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      this.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], color);
    }
  }

  /** Inward-facing walls (for parapets). */
  wallsIn(loop: Loop, y0: number, y1: number, color: THREE.Color) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      this.quad([q[0], y0, q[1]], [p[0], y0, p[1]], [p[0], y1, p[1]], [q[0], y1, q[1]], color);
    }
  }

  /** Convex cap facing up. */
  cap(loop: Loop, y: number, color: THREE.Color) {
    for (let i = 1; i < loop.length - 1; i++) {
      this.tri([loop[0][0], y, loop[0][1]], [loop[i][0], y, loop[i][1]], [loop[i + 1][0], y, loop[i + 1][1]], color);
    }
  }

  /** Ring between two loops of equal length facing up (outer, inner). */
  ring(outer: Loop, inner: Loop, y: number, color: THREE.Color) {
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      const o0 = outer[i], o1 = outer[j], i0 = inner[i], i1 = inner[j];
      this.tri([o0[0], y, o0[1]], [i0[0], y, i0[1]], [i1[0], y, i1[1]], color);
      this.tri([o0[0], y, o0[1]], [i1[0], y, i1[1]], [o1[0], y, o1[1]], color);
    }
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: THREE.Color, top: THREE.Color | null = color) {
    const loop = rectLoop(x0, z0, x1, z1);
    this.walls(loop, y0, y1, color);
    if (top) this.cap(loop, y1, top);
  }

  /** Bake a template (non-indexed positions) with a transform, flat-shaded. */
  bake(tpl: Float32Array, m: THREE.Matrix4, color: THREE.Color) {
    const e = m.elements;
    const P = (i: number): V3 => {
      const x = tpl[i], y = tpl[i + 1], z = tpl[i + 2];
      return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
    };
    for (let i = 0; i < tpl.length; i += 9) this.tri(P(i), P(i + 3), P(i + 6), color);
  }

  get triangles() {
    return this.pos.length / 9;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.clr, 3));
    if (this.hasUv) g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Counter-clockwise from above (walls face outward, caps face up). */
function rectLoop(x0: number, z0: number, x1: number, z1: number): Loop {
  return [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
}

function circleLoop(cx: number, cz: number, r: number, n: number, phase = 0): Loop {
  const out: Loop = [];
  for (let k = 0; k < n; k++) {
    const t = phase - (k / n) * Math.PI * 2;
    out.push([cx + Math.cos(t) * r, cz + Math.sin(t) * r]);
  }
  return out;
}

function tpl(g: THREE.BufferGeometry): Float32Array {
  const n = g.index ? g.toNonIndexed() : g;
  return new Float32Array(n.getAttribute("position").array);
}

const T = {
  cyl8: tpl(new THREE.CylinderGeometry(1, 1, 1, 8).translate(0, 0.5, 0)),
  cyl12: tpl(new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0)),
  cyl8open: tpl(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0)),
  cyl5: tpl(new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).translate(0, 0.5, 0)),
  cone8: tpl(new THREE.ConeGeometry(1, 1, 8).translate(0, 0.5, 0)),
  cone4: tpl(new THREE.ConeGeometry(1, 1, 4).translate(0, 0.5, 0).rotateY(Math.PI / 4)),
  box: tpl(new THREE.BoxGeometry(1, 1, 1)),
  ico0: tpl(new THREE.IcosahedronGeometry(1, 0)),
  ico1: tpl(new THREE.IcosahedronGeometry(1, 1)),
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
function M(x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, "YXZ");
  _q.setFromEuler(_e);
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

// ------------------------------------------------------------------ façade textures

const FCELLS = 8; // façade textures are 8 x 8 window cells

interface FacadeTex {
  map: THREE.Texture;
  /** Daytime emissive: sky reflections in the glass, no lights on. */
  emissive: THREE.Texture;
  /** After dark: the color of every window that will light up at full night, black elsewhere. */
  lights: THREE.Texture;
  /** R: when each lit window comes on (0 = first at dusk, 1 = last at full night). G: window coverage. */
  order: THREE.Texture;
}

interface PaneRec {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: Pane;
  /** Has a round arch on top (the low-rise style), lit together with the pane. */
  arch?: boolean;
}
/** While painting a façade, every window pane is recorded here so the night map can light it. */
let paneLog: PaneRec[] | null = null;

/**
 * The windows lit after dark: a share of the panes, each with its own switch-on point so they come
 * on one by one as dusk deepens. Panes painted as "lit" are the late workers: they come on first.
 */
function paintLights(width: number, height: number, panes: PaneRec[], seed: number) {
  const L = makeCanvas(width, height), O = makeCanvas(width, height);
  const n = L.x, o = O.x;
  n.fillStyle = "#000";
  n.fillRect(0, 0, width, height);
  o.fillStyle = "#ff0000"; // never on, no coverage
  o.fillRect(0, 0, width, height);
  const r = rng(seed);
  for (const p of panes) {
    const chance = p.kind === "lit" ? 1 : p.kind === "blind" ? 0.5 : p.kind === "glass" ? 0.38 : 0.12;
    if (r() > chance) continue;
    const v = r();
    const [hi, lo] = v < 0.58 ? ["#ffe0a0", "#f2b660"] : v < 0.84 ? ["#eef4ff", "#b9cdf2"] : ["#d79a58", "#9a6430"];
    const when = p.kind === "lit" ? r() * 0.45 : 0.1 + r() * 0.9;
    const x = p.x + 1, y = p.y + 1, w = Math.max(1, p.w - 2), h = Math.max(1, p.h - 2);
    const g = n.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, hi);
    g.addColorStop(1, lo);
    n.fillStyle = g;
    n.fillRect(x, y, w, h);
    const ord = `rgb(${Math.round(when * 255)},255,0)`;
    o.fillStyle = ord;
    o.fillRect(x, y, w, h);
    if (p.arch) {
      const cx = p.x + p.w / 2, rad = p.w / 2;
      for (const [c, fill] of [[n, hi], [o, ord]] as const) {
        c.fillStyle = fill;
        c.beginPath();
        c.arc(cx, p.y + 1, rad - 1, Math.PI, 0);
        c.fill();
      }
    }
    if (p.kind === "blind") {
      n.fillStyle = "#8a6a44";
      n.fillRect(x, y, w, h * (0.3 + r() * 0.35));
    }
  }
  const order = repeatTex(O.c);
  order.colorSpace = THREE.NoColorSpace; // data, not color: keep the switch-on points linear
  return { lights: repeatTex(L.c), order };
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, x: c.getContext("2d")! };
}

function repeatTex(c: HTMLCanvasElement) {
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

type Pane = "glass" | "lit" | "blind" | "dark";

/** Paints one pane into the diffuse (d) and emissive (e) canvases. */
function pane(d: CanvasRenderingContext2D, e: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, kind: Pane, glassDiffuse = "#59606c") {
  paneLog?.push({ x, y, w, h, kind });
  // By day every pane is glass; "lit" ones only differ after dark (see paintLights).
  d.fillStyle = glassDiffuse;
  d.fillRect(x, y, w, h);
  const g = e.createLinearGradient(0, y, 0, y + h);
  if (kind === "dark") {
    g.addColorStop(0, "#3c5478");
    g.addColorStop(1, "#22324c");
  } else {
    g.addColorStop(0, "#7aa0d0");
    g.addColorStop(1, "#3f6292");
  }
  e.fillStyle = g;
  e.fillRect(x, y, w, h);
  if (kind === "blind") {
    e.fillStyle = "#a59c88";
    e.fillRect(x, y, w, h * (0.35 + ((x * 7 + y * 3) % 5) * 0.08));
    d.fillStyle = "#8d8676";
    d.fillRect(x, y, w, h * 0.3);
  }
}

function paneKind(r: Rng, lit = 0.09, blind = 0.14, dark = 0.12): Pane {
  const v = r();
  if (v < lit) return "lit";
  if (v < lit + blind) return "blind";
  if (v < lit + blind + dark) return "dark";
  return "glass";
}

/** Shared procedural façades. The diffuse map is tinted per building by vertex color. */
function paintFacade(style: number): FacadeTex {
  const S = 512, C = S / FCELLS;
  const D = makeCanvas(S, S), E = makeCanvas(S, S);
  const d = D.x, e = E.x;
  const r = rng(91 + style * 1013);
  const panes: PaneRec[] = [];
  paneLog = panes;
  d.fillStyle = "#ffffff";
  d.fillRect(0, 0, S, S);
  e.fillStyle = "#000000";
  e.fillRect(0, 0, S, S);

  for (let j = 0; j < FCELLS; j++) {
    for (let i = 0; i < FCELLS; i++) {
      const x = i * C, y = j * C;
      switch (style) {
        case 0: {
          // Punched windows with sills.
          d.fillStyle = "#e9e5de";
          d.fillRect(x + 12, y + 50, 40, 4);
          d.fillStyle = "#6c7280";
          d.fillRect(x + 14, y + 13, 36, 37);
          pane(d, e, x + 16, y + 15, 32, 33, paneKind(r));
          d.fillStyle = "#6c7280";
          d.fillRect(x + 31, y + 15, 2, 33);
          break;
        }
        case 1: {
          // Ribbon windows: a spandrel band and a continuous glass band per floor.
          d.fillStyle = "#e3e6ea";
          d.fillRect(x, y + 56, C, 2);
          for (let k = 0; k < 4; k++) pane(d, e, x + k * 16, y + 20, 16, 34, paneKind(r, 0.08, 0.16, 0.1));
          d.fillStyle = "#7d8494";
          for (let k = 0; k < 4; k++) d.fillRect(x + k * 16, y + 20, 2, 34);
          e.fillStyle = "#000";
          for (let k = 0; k < 4; k++) e.fillRect(x + k * 16, y + 20, 2, 34);
          break;
        }
        case 2: {
          // Glass curtain wall: diffuse glass is light so the building tint colors it.
          const kind = paneKind(r, 0.05, 0.08, 0.14);
          panes.push({ x: x + 3, y, w: 29, h: 54, kind }, { x: x + 34, y, w: C - 34, h: 54, kind });
          d.fillStyle = kind === "dark" ? "#a9b5c6" : "#c9d5e4";
          d.fillRect(x, y, C, C);
          const g = e.createLinearGradient(0, y, 0, y + C);
          g.addColorStop(0, kind === "dark" ? "#1c2c44" : "#33557f");
          g.addColorStop(1, kind === "dark" ? "#101a2c" : "#1d3454");
          e.fillStyle = g;
          e.fillRect(x, y, C, C);
          if (kind === "blind") {
            e.fillStyle = "#6a6458";
            e.fillRect(x, y, C, 22);
          }
          // Spandrel at the floor line, mullions.
          d.fillStyle = "#eef2f7";
          d.fillRect(x, y + 54, C, 10);
          e.fillStyle = "#0e1624";
          e.fillRect(x, y + 54, C, 10);
          d.fillStyle = "#ffffff";
          d.fillRect(x, y, 3, C);
          d.fillRect(x + 32, y, 2, C);
          e.fillStyle = "#000";
          e.fillRect(x, y, 3, C);
          e.fillRect(x + 32, y, 2, C);
          break;
        }
        case 3: {
          // Piers and spandrels (a classic stone tower).
          d.fillStyle = "#d9d4cc";
          d.fillRect(x + 14, y + 10, 50, 4);
          pane(d, e, x + 18, y + 14, 42, 42, paneKind(r), "#535a66");
          d.fillStyle = "#4a505c";
          d.fillRect(x + 38, y + 14, 2, 42);
          d.fillRect(x + 18, y + 14, 42, 3);
          d.fillStyle = "#f4f2ee";
          d.fillRect(x, y, 12, C);
          break;
        }
        default: {
          // Warm low-rise: two narrow arched windows per cell over faint brick coursing.
          d.fillStyle = "#f1ece8";
          for (let k = 0; k < C; k += 8) d.fillRect(x, y + k, C, 1);
          for (const ox of [9, 37]) {
            const kind = paneKind(r, 0.1, 0.18, 0.08);
            d.fillStyle = "#ffffff";
            d.fillRect(ox + x - 3, y + 14, 24, 38);
            e.fillStyle = "#3a3a3a";
            e.fillRect(ox + x - 3, y + 14, 24, 38);
            e.fillStyle = "#000";
            pane(d, e, x + ox, y + 22, 18, 27, kind);
            panes[panes.length - 1].arch = true;
            d.fillStyle = "#59606c";
            d.beginPath();
            d.arc(x + ox + 9, y + 22, 9, Math.PI, 0);
            d.fill();
            e.fillStyle = "#7aa0d0";
            e.beginPath();
            e.arc(x + ox + 9, y + 22, 9, Math.PI, 0);
            e.fill();
          }
          break;
        }
      }
    }
  }
  if (style === 2) {
    // Broad diagonal sky reflections across the glass.
    e.globalCompositeOperation = "lighter";
    for (let k = 0; k < 5; k++) {
      const x0 = r() * S * 1.5 - S * 0.25;
      const w = 30 + r() * 70;
      e.fillStyle = `rgba(120,150,190,${0.18 + r() * 0.14})`;
      e.beginPath();
      e.moveTo(x0, 0);
      e.lineTo(x0 + w, 0);
      e.lineTo(x0 + w - S * 0.6, S);
      e.lineTo(x0 - S * 0.6, S);
      e.fill();
    }
    e.globalCompositeOperation = "source-over";
  }
  paneLog = null;
  return { map: repeatTex(D.c), emissive: repeatTex(E.c), ...paintLights(S, S, panes, 517 + style * 31) };
}

/** Our own tower's curtain wall: 16 bays of 1.5 m x 8 storeys of 4 m (mullions match the office). */
const SHELL_U = 16 * 1.5;
const SHELL_V = 8 * STOREY;
function paintShell(): FacadeTex {
  const W = 512, H = 512, cw = W / 16, ch = H / 8;
  const D = makeCanvas(W, H), E = makeCanvas(W, H);
  const d = D.x, e = E.x;
  const r = rng(4242);
  const panes: PaneRec[] = [];
  paneLog = panes;
  const row = (t: number) => (t / STOREY) * ch; // meters above the storey's floor -> px from the storey's bottom
  d.fillStyle = "#d7dee8";
  d.fillRect(0, 0, W, H);
  e.fillStyle = "#000";
  e.fillRect(0, 0, W, H);
  for (let j = 0; j < 8; j++) {
    const bottom = H - j * ch; // canvas y of this storey's floor line
    // Glass band from sill to head, like the office's own curtain wall.
    const gy0 = bottom - row(WINDOW_HEAD), gy1 = bottom - row(WINDOW_SILL);
    // A floor's worth of lights tends to be on or off together.
    const floorLit = r() < 0.35 ? 0.35 : 0.06;
    for (let i = 0; i < 16; i++) {
      const v = r();
      const kind: Pane = v < floorLit ? "lit" : v < floorLit + 0.15 ? "blind" : v < floorLit + 0.25 ? "dark" : "glass";
      pane(d, e, i * cw, gy0, cw, gy1 - gy0, kind, "#4d5562");
    }
    // Slab edge band (the top 0.4 m of the storey, above the ceiling).
    d.fillStyle = "#aab5c4";
    d.fillRect(0, bottom - ch, W, row(0.4));
    d.fillStyle = "#eef2f6";
    d.fillRect(0, bottom - ch + row(0.4), W, 2);
    // Spandrel seam.
    d.fillStyle = "#c3ccd8";
    d.fillRect(0, bottom - row(WINDOW_SILL / 2), W, 1);
  }
  d.fillStyle = "#6d7385";
  e.fillStyle = "#000";
  for (let i = 0; i < 16; i++) {
    d.fillRect(i * cw - 1, 0, 3, H);
    e.fillRect(i * cw - 1, 0, 3, H);
  }
  paneLog = null;
  return { map: repeatTex(D.c), emissive: repeatTex(E.c), ...paintLights(W, H, panes, 4243) };
}

/** Shared by every façade material: 0 = daylight glass, 1 = glass dimmed for the night. */
const nightMix = { value: 0 };
/** Shared by every façade material: 0 = no windows lit, 1 = every window that lights at night is on. */
const windowsOn = { value: 0 };

function facadeMaterial(tex: FacadeTex, emissiveIntensity = 1) {
  const m = toon("#ffffff").clone();
  m.vertexColors = true;
  m.map = tex.map;
  m.emissiveMap = tex.emissive;
  m.emissive = new THREE.Color("#ffffff");
  m.emissiveIntensity = emissiveIntensity;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.lightsMap = { value: tex.lights };
    shader.uniforms.orderMap = { value: tex.order };
    shader.uniforms.nightMix = nightMix;
    shader.uniforms.windowsOn = windowsOn;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform sampler2D lightsMap;\nuniform sampler2D orderMap;\nuniform float nightMix;\nuniform float windowsOn;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#ifdef USE_EMISSIVEMAP
          vec3 glassE = texture2D(emissiveMap, vEmissiveMapUv).rgb;
          glassE *= mix(vec3(1.0), vec3(0.149, 0.173, 0.235), nightMix); // reflections fade with the sky
          vec2 ord = texture2D(orderMap, vEmissiveMapUv).rg;
          // Each window fades in over a short stretch once windowsOn passes its switch-on point.
          float on = clamp((windowsOn * 1.06 - ord.r) / 0.06, 0.0, 1.0) * ord.g;
          vec3 litE = texture2D(lightsMap, vEmissiveMapUv).rgb;
          totalEmissiveRadiance *= mix(glassE, litE, on);
        #endif`,
      );
  };
  m.customProgramCacheKey = () => "city-facade-daynight";
  return m;
}

/** Soft round glow, white center fading to transparent. */
let glowTexture: THREE.Texture | null = null;
function glowTex() {
  if (glowTexture) return glowTexture;
  const { c, x } = makeCanvas(64, 64);
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.85)");
  g.addColorStop(0.45, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

/** Headlight beam on the road: bright near the car (u = 0), fading with distance and toward the edges. */
function beamTex() {
  const { c, x } = makeCanvas(64, 32);
  const img = x.createImageData(64, 32);
  for (let j = 0; j < 32; j++) {
    for (let i = 0; i < 64; i++) {
      const u = i / 63, v = Math.abs(j / 31 - 0.5) * 2;
      const a = Math.pow(1 - u, 1.6) * Math.pow(Math.max(0, 1 - v * v), 1.5) * Math.min(1, u * 12 + 0.25);
      const o = (j * 64 + i) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  x.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

/** Additive glow material for night lights; fade with opacity. */
function glowMaterial(map: THREE.Texture, color: THREE.ColorRepresentation, vertexColors = false) {
  return new THREE.MeshBasicMaterial({
    map,
    color,
    vertexColors,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
}

function vertexToon() {
  const m = toon("#ffffff").clone();
  m.vertexColors = true;
  return m;
}

function vertexBasic(fog = true) {
  const m = flat("#ffffff").clone();
  m.vertexColors = true;
  m.fog = fog;
  return m;
}

// ------------------------------------------------------------------ palettes

const P = {
  asphalt: col("#9196a8"),
  sidewalk: col("#e6e1d8"),
  lot: col("#d5d1c7"),
  plaza: col("#efe6d6"),
  grass: col("#a9d68c"),
  grassDark: col("#97c77c"),
  path: col("#f1e4c6"),
  water: col("#84c6e0"),
  pond: col("#7ccbe2"),
  stone: col("#d9d2c4"),
  seawall: col("#cbc2b2"),
  white: col("#f7f7f2"),
  yellow: col("#ffd25e"),
  roofs: ["#d9d6d0", "#cdd3dc", "#e4dccd", "#c9c5bd", "#d5dace", "#e0d5d0"].map(col),
  ac: col("#e6e9ee"),
  acDark: col("#5b6271"),
  metal: col("#a2abb8"),
  red: col("#ff5d5d"),
  wood: col("#c8915f"),
  woodDark: col("#8b5a3c"),
  glassDark: col("#5d6c82"),
  accents: ["#7fcbb6", "#f0907e", "#f2c46d", "#8fb3ee", "#c49be8", "#f59fbf"].map(col),
};

const TINTS: string[][] = [
  ["#f4ead6", "#f3cdb4", "#cfe8d8", "#f5e3a7", "#f1c9cf", "#dcd3ee", "#cfe0f2", "#f7f5f0"], // punched
  ["#f4f4f2", "#e3e6ea", "#eadfcd", "#cbe6e3", "#d5e3f3", "#f2e0e8"], // ribbon
  ["#bcd6f2", "#b8e3dc", "#cfc8ee", "#c7dbe8", "#d9e7f5", "#a9c9ee", "#bfe6f0"], // curtain
  ["#e9dcc3", "#ddd6ca", "#ecc8bd", "#d3dfc8", "#c9d2de", "#efe1c8"], // piers
  ["#e8a48d", "#dfae8f", "#e9bfa0", "#d99a8a", "#f0c9a6", "#e4b4a4"], // brick
];

// ------------------------------------------------------------------ layout

interface Span {
  a: number;
  b: number;
  i: number;
}
interface Street {
  a: number;
  b: number;
  c: number;
  w: number;
}

function axis(r: Rng, half: number, limit: number) {
  const blocks: Span[] = [{ a: -half, b: half, i: 0 }];
  const streets: Street[] = [];
  for (const dir of [1, -1]) {
    let edge = half;
    let i = 0;
    while (edge < limit) {
      const w = Math.round((12 + r() * 4) * 2) / 2;
      const len = Math.round(70 + r() * 20);
      i++;
      const s0 = edge, s1 = edge + w, b1 = s1 + len;
      if (dir > 0) {
        streets.push({ a: s0, b: s1, c: (s0 + s1) / 2, w });
        blocks.push({ a: s1, b: b1, i });
      } else {
        streets.push({ a: -s1, b: -s0, c: -(s0 + s1) / 2, w });
        blocks.push({ a: -b1, b: -s1, i: -i });
      }
      edge = b1;
    }
  }
  blocks.sort((p, q) => p.a - q.a);
  streets.sort((p, q) => p.a - q.a);
  return { blocks, streets };
}

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

type Footprint = { kind: "rect"; x0: number; z0: number; x1: number; z1: number } | { kind: "round"; cx: number; cz: number; r: number; n: number };

function loopOf(f: Footprint, inset = 0): Loop {
  if (f.kind === "rect") return rectLoop(f.x0 + inset, f.z0 + inset, f.x1 - inset, f.z1 - inset);
  return circleLoop(f.cx, f.cz, f.r - inset, f.n, Math.PI / f.n);
}

function rectOf(f: Footprint): Rect {
  if (f.kind === "rect") return f;
  const s = f.r * 0.7;
  return { x0: f.cx - s, z0: f.cz - s, x1: f.cx + s, z1: f.cz + s };
}

interface Tier {
  f: Footprint;
  y0: number;
  y1: number;
}

interface Building {
  tiers: Tier[];
  style: number;
  tint: THREE.Color;
  roof: THREE.Color;
  bay: number;
  floorH: number;
  uOff: number;
  vOff: number;
  d: number; // distance from our tower
  cls: 0 | 1 | 2; // low, mid, tower
  crown: "none" | "spire" | "pyramid" | "stepped" | "mech" | "cap";
  lobby: boolean;
}

// ------------------------------------------------------------------ build

export function buildCity(): City {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = "city";
  const R = rng(hashString("agent-office-downtown"));
  const fog = new THREE.Fog(HORIZON, FOG_NEAR, FOG_FAR);
  const background = new THREE.Color(HORIZON);

  const xs = axis(R, 35, 2300);
  const zs = axis(R, 30, 2300);
  const shoreRow = zs.blocks.find((b) => b.a >= 470)!;
  const SHORE = shoreRow.b;

  const ground = new Builder();
  const marks = new Builder(false, false);
  const det = new Builder();
  const fac = [0, 1, 2, 3, 4].map(() => new Builder(true));
  const buildings: Building[] = [];
  const roundTrees: number[] = []; // x, y, z, scale, colorIndex
  const pineTrees: number[] = [];
  const tree = (list: number[], x: number, y: number, z: number, s: number) => list.push(x, y, z, s, Math.floor(R() * 5));

  // ---------------------------------------------------------------- ground and water
  ground.flatQuad(-WORLD, -WORLD, WORLD, SHORE, 0, P.asphalt);
  ground.flatQuad(-WORLD, SHORE, WORLD, WORLD, -1.4, P.water);
  ground.quad([-WORLD, -1.4, SHORE], [WORLD, -1.4, SHORE], [WORLD, 0.6, SHORE], [-WORLD, 0.6, SHORE], P.seawall);

  // ---------------------------------------------------------------- height model
  function pickHeight(r: Rng, cx: number, cz: number, minSide: number) {
    const d = Math.hypot(cx, cz);
    const core = Math.exp(-((d / 430) ** 2));
    const up = 0.9 * Math.exp(-((Math.hypot(cx - 1250, cz + 1100) / 330) ** 2));
    const west = 0.7 * Math.exp(-((Math.hypot(cx + 1450, cz + 350) / 280) ** 2));
    const f = Math.max(core, up, west);
    const x = r();
    let h: number;
    let cls: 0 | 1 | 2;
    if (x < 0.4 * f && minSide >= 18) {
      h = 72 + Math.pow(r(), 1.4) * (40 + 190 * f);
      cls = 2;
    } else if (x < 0.4 * f + 0.33) {
      h = 26 + r() * 46;
      cls = 1;
    } else {
      h = 8 + r() * 20;
      cls = 0;
    }
    h = Math.min(h, minSide * 7.5);
    if (h > 60 && cls < 2) cls = 2;
    if (h < 26) cls = 0;
    return { h, cls };
  }

  function addBuilding(r: Rng, rect: Rect, baseY: number, d: number, forceH?: number, forceStyle?: number) {
    let w = rect.x1 - rect.x0, dd = rect.z1 - rect.z0;
    let minSide = Math.min(w, dd);
    if (minSide < 8) return;
    let cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
    let { h, cls } = pickHeight(r, cx, cz, minSide);
    if (forceH !== undefined) {
      h = forceH;
      cls = h > 60 ? 2 : h > 26 ? 1 : 0;
    }
    if (d > 800) h *= 0.85;
    if (cls === 2) {
      // Towers keep a slender footprint; the rest of the parcel becomes forecourt.
      const maxW = 30 + r() * 12;
      if (w > maxW) {
        const s = r() * (w - maxW);
        rect = { ...rect, x0: rect.x0 + s, x1: rect.x0 + s + maxW };
        w = maxW;
      }
      if (dd > maxW) {
        const s = r() * (dd - maxW);
        rect = { ...rect, z0: rect.z0 + s, z1: rect.z0 + s + maxW };
        dd = maxW;
      }
    }
    const style =
      forceStyle ??
      (cls === 2 ? pick(r, [2, 2, 2, 3, 3, 1]) : cls === 1 ? pick(r, [0, 1, 1, 3, 2, 0]) : pick(r, [0, 4, 4, 0, 1]));
    cx = (rect.x0 + rect.x1) / 2;
    cz = (rect.z0 + rect.z1) / 2;
    minSide = Math.min(w, dd);
    const floorH = style === 4 ? 3.4 + r() * 0.4 : 3.7 + r() * 0.5;
    const bay = style === 2 ? 3 + r() * 1.5 : style === 4 ? 4 + r() * 1.2 : 2.8 + r() * 1.4;
    const snap = (y: number) => Math.max(1, Math.round(y / floorH)) * floorH;
    h = snap(h);
    const tiers: Tier[] = [];
    const rf = (x0: number, z0: number, x1: number, z1: number): Footprint => ({ kind: "rect", x0, z0, x1, z1 });
    const roll = r();
    if (cls === 2 && roll < 0.12 && Math.abs(w - dd) < 0.35 * minSide && d < 1500) {
      // Round tower on a low podium.
      const pod = snap(8 + r() * 8);
      tiers.push({ f: rf(rect.x0, rect.z0, rect.x1, rect.z1), y0: baseY, y1: baseY + pod });
      tiers.push({ f: { kind: "round", cx, cz, r: minSide / 2 - 2, n: 12 }, y0: baseY + pod, y1: baseY + h });
    } else if (cls === 2 && roll < 0.6 && minSide > 22) {
      // Wedding-cake setbacks.
      const n = minSide > 34 && r() < 0.6 ? 3 : 2;
      let y = baseY;
      let f = rf(rect.x0, rect.z0, rect.x1, rect.z1) as Extract<Footprint, { kind: "rect" }>;
      for (let k = 0; k < n; k++) {
        const top = k === n - 1 ? baseY + h : baseY + snap(h * (k === 0 ? 0.35 + r() * 0.25 : 0.7 + r() * 0.15));
        tiers.push({ f, y0: y, y1: top });
        y = top;
        const ix = 2.5 + r() * 3.5, iz = 2.5 + r() * 3.5;
        f = rf(f.x0 + ix, f.z0 + iz, f.x1 - ix * (r() < 0.5 ? 1 : 0.3), f.z1 - iz * (r() < 0.5 ? 1 : 0.3)) as typeof f;
        if (f.x1 - f.x0 < 10 || f.z1 - f.z0 < 10) break;
      }
      tiers[tiers.length - 1].y1 = baseY + h;
    } else if (cls === 2 && roll < 0.75 && minSide > 26) {
      // Podium plus slab tower.
      const pod = snap(10 + r() * 10);
      tiers.push({ f: rf(rect.x0, rect.z0, rect.x1, rect.z1), y0: baseY, y1: baseY + pod });
      const ix = 4 + r() * 5, iz = 4 + r() * 5;
      tiers.push({ f: rf(rect.x0 + ix, rect.z0 + iz, rect.x1 - ix, rect.z1 - iz), y0: baseY + pod, y1: baseY + h });
    } else {
      tiers.push({ f: rf(rect.x0, rect.z0, rect.x1, rect.z1), y0: baseY, y1: baseY + h });
    }
    const set = TINTS[style];
    const crown: Building["crown"] =
      cls === 2 ? pick(r, ["spire", "pyramid", "stepped", "mech", "mech", "cap", "none"] as const) : "none";
    buildings.push({
      tiers,
      style,
      tint: col(pick(r, set)),
      roof: pick(r, P.roofs),
      bay,
      floorH,
      uOff: Math.floor(r() * FCELLS),
      vOff: Math.floor(r() * FCELLS),
      d,
      cls,
      crown,
      lobby: d < 450 && cls > 0,
    });
  }

  // ---------------------------------------------------------------- blocks
  const parks = new Set(["1,0", "-4,-3", "-4,-4", "-3,-4", "3,-6", "-6,2", "5,3"]);
  let wheelSpot: [number, number] | null = null;

  for (const bx of xs.blocks) {
    for (const bz of zs.blocks) {
      if (bz.a >= SHORE) continue;
      const cx = (bx.a + bx.b) / 2, cz = (bz.a + bz.b) / 2;
      const d = Math.hypot(cx, cz);
      if (d > 2350) continue;
      const key = `${bx.i},${bz.i}`;
      const r = rng(hashString(key) ^ 0x9e3779b9);
      const slab = d < 380 ? 0.2 : Math.min(3, 0.2 + (d - 380) * 0.0016);
      const inner: Rect = { x0: bx.a + SIDEWALK, z0: bz.a + SIDEWALK, x1: bx.b - SIDEWALK, z1: bz.b - SIDEWALK };
      const ours = bx.i === 0 && bz.i === 0;
      const waterfront = bz.i === shoreRow.i;
      const isPark = parks.has(key) || (!ours && !waterfront && d > 500 && r() < 0.05);
      ground.box(bx.a, 0, bz.a, bx.b, slab, bz.b, P.sidewalk);
      const lotY = slab + 0.15;

      // Street trees along the sidewalks of nearby blocks.
      if (d < 300) {
        const inset = 1.7;
        const edges: [number, number, number, number][] = [
          [bx.a + inset, bz.a + inset, bx.b - inset, bz.a + inset],
          [bx.a + inset, bz.b - inset, bx.b - inset, bz.b - inset],
          [bx.a + inset, bz.a + inset, bx.a + inset, bz.b - inset],
          [bx.b - inset, bz.a + inset, bx.b - inset, bz.b - inset],
        ];
        for (const [x0, z0, x1, z1] of edges) {
          if (waterfront && z0 > cz && z1 > cz) continue;
          const len = Math.hypot(x1 - x0, z1 - z0);
          const n = Math.floor((len - 14) / 10.5);
          for (let k = 0; k <= n; k++) {
            if (r() < 0.12) continue;
            const t = (7 + k * ((len - 14) / Math.max(1, n))) / len;
            tree(roundTrees, lerp(x0, x1, t), slab, lerp(z0, z1, t), 0.75 + r() * 0.35);
          }
        }
      }

      if (ours) {
        ground.box(inner.x0, slab, inner.z0, inner.x1, lotY, inner.z1, P.plaza);
        // Planters with trees around the tower, benches.
        for (const [x, z] of [[-28, -22], [-10, -22], [10, -22], [28, -22], [-28, 22], [-10, 22], [10, 22], [28, 22], [-26, 0], [26, 0]] as [number, number][]) {
          det.box(x - 1.6, lotY, z - 1.6, x + 1.6, lotY + 0.6, z + 1.6, P.stone, P.grassDark);
          tree(roundTrees, x, lotY + 0.6, z, 0.9);
        }
        for (const x of [-19, 0, 19]) det.box(x - 1.5, lotY, 18.5, x + 1.5, lotY + 0.45, 19.2, P.wood);
        continue;
      }

      if (waterfront) {
        ground.box(inner.x0, slab, inner.z0, inner.x1, lotY, bz.b, P.grass);
        ground.box(inner.x0, lotY, bz.b - 9, inner.x1, lotY + 0.06, bz.b, P.path);
        for (let x = inner.x0 + 6; x < inner.x1 - 4; x += 9 + r() * 4) {
          tree(roundTrees, x, lotY, bz.b - 12 - r() * 3, 0.9 + r() * 0.3);
          if (r() < 0.5) tree(pineTrees, x + 3, lotY, inner.z0 + 4 + r() * 20, 0.9 + r() * 0.4);
        }
        if (!wheelSpot && cx > 60 && d < 900) wheelSpot = [cx, bz.b - 26];
        else if (d < 1600 && r() < 0.5) addBuilding(r, { x0: inner.x0 + 4, z0: inner.z0 + 2, x1: inner.x0 + 30, z1: inner.z0 + 24 }, lotY, d, 10 + r() * 10, 4);
        continue;
      }

      if (isPark) {
        ground.box(inner.x0, slab, inner.z0, inner.x1, lotY, inner.z1, P.grass);
        if (d < 700) buildPark(r, inner, lotY, d < 300);
        continue;
      }

      if (d < 750) ground.box(inner.x0, slab, inner.z0, inner.x1, lotY, inner.z1, P.lot);

      // Parcels.
      const parcels: Rect[] = [];
      if (d > 800) {
        if (r() < 0.72) parcels.push(inner);
        if (r() < 0.35) {
          const half = r() < 0.5;
          const mx = lerp(inner.x0, inner.x1, 0.5);
          parcels.length = 0;
          parcels.push(half ? { ...inner, x1: mx - 4 } : { ...inner, x0: mx + 4 });
          if (r() < 0.6) parcels.push(half ? { ...inner, x0: mx + 4 } : { ...inner, x1: mx - 4 });
        }
      } else {
        const longX = inner.x1 - inner.x0 >= inner.z1 - inner.z0;
        const len = longX ? inner.x1 - inner.x0 : inner.z1 - inner.z0;
        const k = len > 64 ? (r() < 0.55 ? 2 : 3) : r() < 0.7 ? 2 : 1;
        const cuts = [0];
        for (let i = 1; i < k; i++) cuts.push(i / k + (r() - 0.5) * 0.18);
        cuts.push(1);
        for (let i = 0; i < k; i++) {
          const a = cuts[i], b = cuts[i + 1];
          const p: Rect = longX
            ? { x0: lerp(inner.x0, inner.x1, a), x1: lerp(inner.x0, inner.x1, b), z0: inner.z0, z1: inner.z1 }
            : { z0: lerp(inner.z0, inner.z1, a), z1: lerp(inner.z0, inner.z1, b), x0: inner.x0, x1: inner.x1 };
          const other = longX ? p.z1 - p.z0 : p.x1 - p.x0;
          if (other > 44 && r() < 0.4) {
            const m = 0.4 + r() * 0.2;
            if (longX) {
              parcels.push({ ...p, z1: lerp(p.z0, p.z1, m) }, { ...p, z0: lerp(p.z0, p.z1, m) });
            } else {
              parcels.push({ ...p, x1: lerp(p.x0, p.x1, m) }, { ...p, x0: lerp(p.x0, p.x1, m) });
            }
          } else parcels.push(p);
        }
      }
      for (const p of parcels) {
        if (d < 750 && r() < 0.06) {
          // A little pocket plaza instead of a building.
          ground.box(p.x0 + 1, lotY, p.z0 + 1, p.x1 - 1, lotY + 0.06, p.z1 - 1, P.plaza);
          if (d < 420) for (let k = 0; k < 3; k++) tree(roundTrees, lerp(p.x0 + 4, p.x1 - 4, r()), lotY, lerp(p.z0 + 4, p.z1 - 4, r()), 0.9);
          continue;
        }
        const g = () => 1 + r() * 2.5;
        addBuilding(r, { x0: p.x0 + g(), z0: p.z0 + g(), x1: p.x1 - g(), z1: p.z1 - g() }, lotY, d);
      }
    }
  }

  // ---------------------------------------------------------------- parks
  function buildPark(r: Rng, b: Rect, y: number, fancy: boolean) {
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const w = b.x1 - b.x0, dd = b.z1 - b.z0;
    // Cross paths and a ring path.
    ground.box(b.x0, y, cz - 1.8, b.x1, y + 0.08, cz + 1.8, P.path, P.path);
    ground.box(cx - 1.8, y, b.z0, cx + 1.8, y + 0.08, b.z1, P.path, P.path);
    // Pond off-center.
    const px = cx + (r() < 0.5 ? -1 : 1) * w * 0.24, pz = cz + (r() < 0.5 ? -1 : 1) * dd * 0.22;
    const prx = w * 0.17, prz = dd * 0.16;
    const blob = (s: number): Loop =>
      circleLoop(0, 0, 1, 18).map(([x, z], k) => {
        const wob = 1 + 0.12 * Math.sin(k * 2.3) * s;
        return [px + x * prx * wob * s, pz + z * prz * wob * s] as [number, number];
      });
    ground.cap(blob(1.12), y + 0.1, P.stone);
    ground.cap(blob(1), y + 0.14, P.pond);
    ground.walls(blob(1.12), y, y + 0.1, P.stone);
    if (fancy) {
      // Paddle boats on the pond.
      for (let k = 0; k < 3; k++) {
        const a = r() * Math.PI * 2;
        const x = px + Math.cos(a) * prx * 0.5, z = pz + Math.sin(a) * prz * 0.5;
        det.box(x - 1.2, y + 0.14, z - 0.7, x + 1.2, y + 0.7, z + 0.7, k === 1 ? col("#ffb3c7") : P.white);
      }
      // Plaza with fountain at the center.
      const plaza = circleLoop(cx, cz, 9, 16);
      ground.cap(plaza, y + 0.12, P.plaza);
      det.bake(T.cyl12, M(cx, y, cz, 4, 0.7, 4), P.stone);
      det.bake(T.cyl12, M(cx, y + 0.7, cz, 3.4, 0.05, 3.4), P.pond);
      det.bake(T.cone8, M(cx, y + 0.7, cz, 0.8, 3, 0.8), col("#c9ecf7"));
      // Pavilion.
      const gx = cx - (px - cx) * 0.9, gz = cz + (pz - cz) * 0.9;
      det.bake(T.cyl8, M(gx, y, gz, 3.6, 0.3, 3.6), P.stone);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        det.box(gx + Math.cos(a) * 3 - 0.15, y + 0.3, gz + Math.sin(a) * 3 - 0.15, gx + Math.cos(a) * 3 + 0.15, y + 3, gz + Math.sin(a) * 3 + 0.15, P.white);
      }
      det.bake(T.cone8, M(gx, y + 3, gz, 4.4, 2.2, 4.4), col("#f0907e"));
      // Playground blobs.
      const kx = cx + (px - cx) * -0.8, kz = cz + (pz - cz) * -1;
      ground.box(kx - 7, y, kz - 5, kx + 7, y + 0.1, kz + 5, col("#f2d7a6"));
      det.box(kx - 4, y, kz - 1, kx - 1, y + 2.4, kz + 1, col("#ff8fa3"));
      det.box(kx + 1, y, kz - 2, kx + 4.5, y + 1.2, kz + 2, col("#7bdff2"));
      det.bake(T.cone4, M(kx - 2.5, y + 2.4, kz, 2.2, 1.4, 1.6), col("#ffd166"));
      // Benches along the paths.
      for (const s of [-1, 1]) {
        det.box(cx + s * 16 - 1.2, y, cz + 2.5, cx + s * 16 + 1.2, y + 0.45, cz + 3.1, P.wood);
        det.box(cx - 3.1, y, cz + s * 16 - 1.2, cx - 2.5, y + 0.45, cz + s * 16 + 1.2, P.wood);
      }
    }
    // Trees, avoiding paths, pond and plaza.
    const n = Math.round((w * dd) / (fancy ? 95 : 200));
    for (let k = 0; k < n * 3 && n > 0; k++) {
      const x = lerp(b.x0 + 3, b.x1 - 3, r()), z = lerp(b.z0 + 3, b.z1 - 3, r());
      if (Math.abs(x - cx) < 4.5 || Math.abs(z - cz) < 4.5) continue;
      if (((x - px) / (prx * 1.35)) ** 2 + ((z - pz) / (prz * 1.35)) ** 2 < 1) continue;
      if (fancy && Math.hypot(x - cx, z - cz) < 13) continue;
      tree(r() < 0.3 ? pineTrees : roundTrees, x, y, z, 0.8 + r() * 0.6);
    }
  }

  // ---------------------------------------------------------------- buildings -> geometry
  function facWalls(b: Building, loop: Loop, y0: number, y1: number, baseY: number) {
    const B = fac[b.style];
    let u = b.uOff;
    const v0 = ((y0 - baseY) / b.floorH + b.vOff) / FCELLS;
    const v1 = ((y1 - baseY) / b.floorH + b.vOff) / FCELLS;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const n = Math.max(1, Math.round(len / b.bay));
      B.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], b.tint, [u / FCELLS, v0, (u + n) / FCELLS, v1]);
      u += n;
    }
  }

  function parapet(f: Footprint, y: number, h: number, color: THREE.Color, inner: boolean) {
    if (inner) parapetTo(det, f, y, h, color);
    else det.walls(loopOf(f, -0.12), y, y + h, color);
  }

  // Rooftop features. The closest buildings are guaranteed a few charming ones.
  const quota = { helipad: 1, garden: 2, pool: 1, tanks: 3 };
  buildings.sort((a, b) => a.d - b.d);
  for (const b of buildings) {
    const r = rng(hashString(`${b.tiers[0].y0}|${b.d.toFixed(2)}`));
    const baseY = b.tiers[0].y0;
    const parapetCol = b.tint.clone().multiplyScalar(0.86);
    for (let ti = 0; ti < b.tiers.length; ti++) {
      const t = b.tiers[ti];
      const loop = loopOf(t.f);
      facWalls(b, loop, t.y0, t.y1, baseY);
      det.cap(loop, t.y1, b.roof);
      if (b.d < 700) parapet(t.f, t.y1, b.cls === 0 ? 0.8 : 1.1, parapetCol, b.d < 320);
      // Terraces on lower tiers of nearby towers.
      if (ti < b.tiers.length - 1 && b.d < 400 && t.f.kind === "rect" && r() < 0.55) {
        const nf = b.tiers[ti + 1].f;
        const nr = rectOf(nf);
        if (t.f.z1 - nr.z1 > 3) garden(r, { x0: t.f.x0 + 1, z0: nr.z1 + 0.5, x1: t.f.x1 - 1, z1: t.f.z1 - 1 }, t.y1, false);
        else if (nr.z0 - t.f.z0 > 3) garden(r, { x0: t.f.x0 + 1, z0: t.f.z0 + 1, x1: t.f.x1 - 1, z1: nr.z0 - 0.5 }, t.y1, false);
      }
    }
    if (b.lobby && b.tiers[0].f.kind === "rect") {
      const f = b.tiers[0].f;
      det.walls(loopOf(f, -0.15), baseY, baseY + 4.6, P.glassDark);
      det.ring(loopOf(f, -0.15), loopOf(f, 0.2), baseY + 4.6, b.tint);
    }
    const top = b.tiers[b.tiers.length - 1];
    const tr = rectOf(top.f);
    const y = top.y1;
    const rw = tr.x1 - tr.x0, rd = tr.z1 - tr.z0;
    if (b.d > 1200) continue;
    const near = b.d < 650;
    const tcx = (tr.x0 + tr.x1) / 2, tcz = (tr.z0 + tr.z1) / 2;
    const roofSpace: Rect = { x0: tr.x0 + 1.5, z0: tr.z0 + 1.5, x1: tr.x1 - 1.5, z1: tr.z1 - 1.5 };

    if (b.cls === 2) {
      const h = top.y1 - baseY;
      if (quota.helipad > 0 && b.d < 260 && rw > 20 && rd > 20 && h < 150) {
        quota.helipad--;
        helipad(tcx, tcz, y, Math.min(rw, rd) - 3);
        continue;
      }
      switch (b.crown) {
        case "spire":
          det.box(tcx - rw * 0.2, y, tcz - rd * 0.2, tcx + rw * 0.2, y + 5, tcz + rd * 0.2, parapetCol);
          {
            const sh = 22 + r() * 18;
            det.bake(T.cone8, M(tcx, y + 5, tcz, 1.1, sh, 1.1), col("#e4e8ee"));
            det.bake(T.ico0, M(tcx, y + 5 + sh, tcz, 0.45, 0.45, 0.45), P.red);
            acUnits(r, roofSpace, y, 3);
          }
          break;
        case "pyramid":
          if (rw > 30 || rd > 30) {
            mech(r, roofSpace, y, b.tint, near);
            break;
          }
          det.bake(top.f.kind === "round" ? T.cone8 : T.cone4, M(tcx, y, tcz, rw * 0.72, Math.min(rw, rd) * 0.45, rd * 0.72), pick(r, P.accents));
          break;
        case "stepped":
          det.box(tr.x0 + rw * 0.15, y, tr.z0 + rd * 0.15, tr.x1 - rw * 0.15, y + 5, tr.z1 - rd * 0.15, b.tint);
          det.box(tr.x0 + rw * 0.3, y + 5, tr.z0 + rd * 0.3, tr.x1 - rw * 0.3, y + 9, tr.z1 - rd * 0.3, pick(r, P.accents));
          break;
        case "cap":
          det.walls(loopOf(top.f, -0.3), y - 3, y + 1.5, pick(r, P.accents));
          mech(r, roofSpace, y, b.tint, near);
          break;
        default:
          mech(r, roofSpace, y, b.tint, near);
      }
      continue;
    }
    if (!near) {
      if (r() < 0.3) acUnits(r, roofSpace, y, 1);
      continue;
    }
    // Low and mid rises: the roofs you look down onto.
    const options: string[] = [];
    if (quota.garden > 0 && rw > 14 && rd > 14) options.push("garden");
    if (quota.pool > 0 && rw > 16 && rd > 14) options.push("pool");
    if (quota.tanks > 0) options.push("tanks");
    let choice = options.length && b.d < 220 ? options[0] : pick(r, ["ac", "ac", "tanks", "garden", "solar", "pool", "ac", "ac", "tanks"]);
    if (choice === "pool" && (rw < 14 || rd < 12)) choice = "ac";
    if (choice === "garden" && (rw < 10 || rd < 10)) choice = "tanks";
    if (choice in quota) quota[choice as keyof typeof quota]--;
    switch (choice) {
      case "garden":
        garden(r, roofSpace, y, true);
        break;
      case "pool":
        pool(r, roofSpace, y);
        break;
      case "tanks": {
        const n = rw > 18 ? 2 : 1;
        for (let k = 0; k < n; k++) waterTank(lerp(roofSpace.x0 + 3, roofSpace.x1 - 3, (k + 0.5) / n), lerp(roofSpace.z0 + 3, roofSpace.z1 - 3, r()), y, 0.9 + r() * 0.3);
        acUnits(r, { ...roofSpace, x0: lerp(roofSpace.x0, roofSpace.x1, 0.5) }, y, 3);
        break;
      }
      case "solar":
        solar(roofSpace, y);
        break;
      default:
        acUnits(r, roofSpace, y, 3 + Math.floor(r() * 4));
        if (r() < 0.4) antenna(lerp(roofSpace.x0, roofSpace.x1, r()), lerp(roofSpace.z0, roofSpace.z1, r()), y, 4 + r() * 5);
    }
  }

  // ---------------------------------------------------------------- rooftop props
  function acUnits(r: Rng, s: Rect, y: number, n: number) {
    for (let k = 0; k < n; k++) {
      const w = 1.6 + r() * 1.2, d = 1.2 + r() * 0.8, h = 0.9 + r() * 0.6;
      if (s.x1 - s.x0 < w + 1 || s.z1 - s.z0 < d + 1) return;
      const x = lerp(s.x0 + w / 2, s.x1 - w / 2, r()), z = lerp(s.z0 + d / 2, s.z1 - d / 2, r());
      det.box(x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2, P.ac);
      const f = Math.min(w, d) * 0.3;
      det.flatQuad(x - f, z - f, x + f, z + f, y + h + 0.02, P.acDark);
    }
  }

  function waterTank(x: number, z: number, y: number, s: number) {
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      det.walls(rectLoop(x + dx * 1.3 * s - 0.15, z + dz * 1.3 * s - 0.15, x + dx * 1.3 * s + 0.15, z + dz * 1.3 * s + 0.15), y, y + 2.6 * s, P.woodDark);
    }
    det.bake(T.cyl8open, M(x, y + 2.6 * s, z, 1.8 * s, 3.4 * s, 1.8 * s), P.wood);
    det.bake(T.cone8, M(x, y + 6 * s, z, 2.0 * s, 1.2 * s, 2.0 * s), P.woodDark);
  }

  function antenna(x: number, z: number, y: number, h: number) {
    det.bake(T.cyl5, M(x, y, z, 0.14, h, 0.14), P.metal);
    det.box(x - 0.9, y + h * 0.6, z - 0.06, x + 0.9, y + h * 0.6 + 0.12, z + 0.06, P.metal);
    det.bake(T.ico0, M(x, y + h, z, 0.35, 0.35, 0.35), P.red);
  }

  function helipad(x: number, z: number, y: number, size: number) {
    const s = Math.min(size, 22) / 2;
    det.box(x - s, y, z - s, x + s, y + 0.5, z + s, col("#6b7282"));
    const yy = y + 0.52;
    det.ring(circleLoop(x, z, s * 0.85, 24), circleLoop(x, z, s * 0.72, 24), yy, P.yellow);
    const hw = s * 0.32, hh = s * 0.42, t = s * 0.09;
    det.flatQuad(x - hw - t, z - hh, x - hw + t, z + hh, yy, P.white);
    det.flatQuad(x + hw - t, z - hh, x + hw + t, z + hh, yy, P.white);
    det.flatQuad(x - hw, z - t, x + hw, z + t, yy + 0.01, P.white);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      det.box(x + Math.cos(a) * s * 0.95 - 0.2, y + 0.5, z + Math.sin(a) * s * 0.95 - 0.2, x + Math.cos(a) * s * 0.95 + 0.2, y + 0.8, z + Math.sin(a) * s * 0.95 + 0.2, col("#9be37a"));
    }
  }

  function garden(r: Rng, s: Rect, y: number, full: boolean) {
    const w = s.x1 - s.x0, d = s.z1 - s.z0;
    if (w < 4 || d < 3) return;
    det.box(s.x0, y, s.z0, s.x1, y + 0.25, s.z1, col("#e8d8bc"));
    const nx = Math.max(1, Math.round(w / 7)), nz = Math.max(1, Math.round(d / 7));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x0 = lerp(s.x0, s.x1, i / nx) + 0.7, x1 = lerp(s.x0, s.x1, (i + 1) / nx) - 0.7;
        const z0 = lerp(s.z0, s.z1, j / nz) + 0.7, z1 = lerp(s.z0, s.z1, (j + 1) / nz) - 0.7;
        if (x1 - x0 < 1 || z1 - z0 < 1) continue;
        det.box(x0, y + 0.25, z0, x1, y + 0.7, z1, col("#b4885e"), r() < 0.25 ? col("#f5b8c8") : r() < 0.4 ? col("#ffe08a") : P.grass);
        if (full && r() < 0.45) {
          const bx = lerp(x0 + 1, x1 - 1, r()), bz = lerp(z0 + 1, z1 - 1, r());
          det.bake(T.ico0, M(bx, y + 1.5, bz, 1.3, 1.1, 1.3), pick(r, [col("#7cc46a"), col("#8fd17a"), col("#6bb36b")]));
        }
      }
    }
    if (full && w > 10) {
      // Pergola.
      const px = s.x1 - 3, pz = s.z0 + 3;
      for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) det.box(px + dx - 0.1, y + 0.25, pz + dz - 0.1, px + dx + 0.1, y + 2.6, pz + dz + 0.1, P.white);
      det.box(px - 2, y + 2.6, pz - 2, px + 2, y + 2.8, pz + 2, col("#f0907e"));
    }
  }

  function pool(r: Rng, s: Rect, y: number) {
    det.box(s.x0, y, s.z0, s.x1, y + 0.3, s.z1, col("#eedcbf"));
    const w = s.x1 - s.x0, d = s.z1 - s.z0;
    const px0 = s.x0 + 2, px1 = s.x0 + w * 0.65, pz0 = s.z0 + 2, pz1 = s.z1 - Math.max(2, d * 0.25);
    det.flatQuad(px0, pz0, px1, pz1, y + 0.32, col("#64d4ec"));
    det.flatQuad(px0 + 0.6, pz0 + 0.6, px1 - 0.6, pz0 + 1.2, y + 0.33, col("#a8ecf8"));
    for (let k = 0; k < 3; k++) {
      const x = lerp(px1 + 2, s.x1 - 1.5, (k + 0.5) / 3), z = lerp(s.z0 + 2, s.z1 - 2, r());
      det.bake(T.cyl5, M(x, y + 0.3, z, 0.07, 2.2, 0.07), P.white);
      det.bake(T.cone8, M(x, y + 2.2, z, 1.5, 0.7, 1.5), pick(r, [col("#ff8fa3"), col("#ffd166"), col("#7bdff2")]));
    }
    for (let k = 0; k < 4; k++) {
      const x = lerp(px0, px1, (k + 0.5) / 4);
      det.box(x - 0.4, y + 0.3, pz1 + 0.8, x + 0.4, y + 0.6, pz1 + 2.6, P.white);
    }
  }

  function solar(s: Rect, y: number) {
    // One tilted strip per row, facing the sun (south).
    const panel = col("#5a7fbe");
    for (let z = s.z0 + 1; z < s.z1 - 2; z += 2.6) {
      const x0 = s.x0 + 1, x1 = s.x1 - 1;
      det.quad([x0, y + 0.3, z + 1.6], [x1, y + 0.3, z + 1.6], [x1, y + 1.0, z], [x0, y + 1.0, z], panel);
    }
  }

  function mech(r: Rng, s: Rect, y: number, tint: THREE.Color, near: boolean) {
    const w = s.x1 - s.x0, d = s.z1 - s.z0;
    const mw = w * (0.35 + r() * 0.25), md = d * (0.35 + r() * 0.25);
    const mx = lerp(s.x0 + mw / 2, s.x1 - mw / 2, r()), mz = lerp(s.z0 + md / 2, s.z1 - md / 2, r());
    const mh = 4 + r() * 3;
    det.box(mx - mw / 2, y, mz - md / 2, mx + mw / 2, y + mh, mz + md / 2, tint.clone().multiplyScalar(0.92), col("#cfd4dc"));
    det.walls(rectLoop(mx - mw / 2 - 0.2, mz - md / 2 - 0.2, mx + mw / 2 + 0.2, mz + md / 2 + 0.2), y + mh * 0.55, y + mh * 0.8, P.acDark);
    if (near) {
      acUnits(r, { x0: s.x0, z0: s.z0, x1: mx - mw / 2 - 0.5, z1: s.z1 }, y, 2);
      if (r() < 0.6) antenna(mx + mw * 0.3, mz, y + mh, 8 + r() * 10);
    }
  }

  // ---------------------------------------------------------------- the waterfront
  const lighthouse = new THREE.Vector3();
  const wheel = new Builder();
  const wheelBulbs: number[] = []; // x, y, z, r, g, b in the wheel's local space
  let wheelGroup: THREE.Group | null = null;
  if (wheelSpot) {
    const [wx, wz] = wheelSpot;
    const RAD = 34, HUB = RAD + 6;
    const y0 = 0.5;
    // A-frame legs (static).
    for (const dz of [-3.2, 3.2]) {
      for (const dx of [-1, 1]) {
        const len = Math.hypot(RAD * 0.55, HUB);
        const ang = Math.atan2(RAD * 0.55, HUB);
        det.bake(T.box, M(wx + dx * RAD * 0.275, y0 + HUB / 2, wz + dz, 1.1, len, 1.1, 0, 0, dx * ang), P.white);
      }
    }
    det.box(wx - 9, y0, wz - 6, wx + 9, y0 + 3, wz + 6, col("#f0907e"));
    // The wheel (rotates in update()).
    const seg = 32;
    for (const dz of [-1.6, 1.6]) {
      for (let k = 0; k < seg; k++) {
        const a = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        const xm = (Math.cos(a) + Math.cos(a1)) / 2 * RAD, ym = (Math.sin(a) + Math.sin(a1)) / 2 * RAD;
        wheel.bake(T.box, M(xm, ym, dz, 0.8, (2 * Math.PI * RAD) / seg + 0.3, 0.8, 0, 0, a + (a1 - a) / 2), P.white);
      }
    }
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      wheel.bake(T.box, M((Math.cos(a) * RAD) / 2, (Math.sin(a) * RAD) / 2, 0, 0.35, RAD, 0.35, 0, 0, a - Math.PI / 2), col("#dfe6f0"));
      wheel.bake(T.box, M(Math.cos(a) * RAD, Math.sin(a) * RAD - 2, 0, 2.6, 2.6, 2.6), P.accents[k % P.accents.length]);
    }
    wheel.bake(T.cyl8, M(0, 0, -2.5, 2, 5, 2, 0, Math.PI / 2), P.metal);
    // Rim and spoke bulbs for the night.
    for (let k = 0; k < 96; k++) {
      const a = (k / 96) * Math.PI * 2;
      const c = P.accents[Math.floor(k / 6) % P.accents.length];
      for (const dz of [-1.9, 1.9]) wheelBulbs.push(Math.cos(a) * RAD, Math.sin(a) * RAD, dz, c.r, c.g, c.b);
    }
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (let t = 0.2; t < 0.95; t += 0.15) wheelBulbs.push(Math.cos(a) * RAD * t, Math.sin(a) * RAD * t, 0.3, 1, 0.92, 0.75);
    }
    wheelGroup = new THREE.Group();
    wheelGroup.position.set(wx, y0 + HUB, wz);
  }
  // Pier, lighthouse and boats.
  {
    const px = -140;
    det.box(px - 4, -1.4, SHORE, px + 4, 0.8, SHORE + 120, col("#d8c7a8"));
    det.box(px - 5, -1.4, SHORE + 120, px + 5, 0.8, SHORE + 130, col("#d8c7a8"));
    for (let k = 0; k < 5; k++) det.bake(T.cyl8, M(px, 0.8 + k * 3, SHORE + 125, 2.4 - k * 0.15, 3, 2.4 - k * 0.15), k % 2 ? P.red : P.white);
    det.bake(T.cyl8, M(px, 15.8, SHORE + 125, 1.8, 2, 1.8), col("#fff3c4"));
    lighthouse.set(px, 16.8, SHORE + 125);
    det.bake(T.cone8, M(px, 17.8, SHORE + 125, 2.4, 2, 2.4), P.red);
    const br = rng(77);
    for (let k = 0; k < 9; k++) {
      const bx = -500 + br() * 1000, bz = SHORE + 60 + br() * 700, ry = br() * Math.PI;
      const L = 8 + br() * 10;
      det.bake(T.box, M(bx, -1.0, bz, L, 1.6, L * 0.32, ry), P.white);
      det.bake(T.box, M(bx, 0.2, bz, L * 0.4, 1.6, L * 0.24, ry), pick(br, P.accents));
      if (br() < 0.5) det.bake(T.cone4, M(bx, 0.4, bz, 0.3, L * 0.9, L * 0.35, ry), P.white);
    }
  }

  // ---------------------------------------------------------------- road markings
  for (const sx of xs.streets) {
    for (const bz of zs.blocks) {
      if (bz.b > SHORE + 1) continue;
      const d = Math.hypot(sx.c, (bz.a + bz.b) / 2);
      if (d > 520) continue;
      roadMarks("z", sx.c, sx.w, bz.a, bz.b);
    }
  }
  for (const sz of zs.streets) {
    if (sz.b > SHORE) continue;
    for (const bx of xs.blocks) {
      const d = Math.hypot((bx.a + bx.b) / 2, sz.c);
      if (d > 520) continue;
      roadMarks("x", sz.c, sz.w, bx.a, bx.b);
    }
  }
  /** Markings for one road segment running along `along` between s0..s1, centered at c. */
  function roadMarks(along: "x" | "z", c: number, w: number, s0: number, s1: number) {
    const Y = 0.04;
    const q = (a0: number, a1: number, l0: number, l1: number, color: THREE.Color) => {
      if (along === "z") marks.flatQuad(c + l0, a0, c + l1, a1, Y, color);
      else marks.flatQuad(a0, c + l0, a1, c + l1, Y, color);
    };
    const half = w / 2;
    // Double yellow center line.
    q(s0 + 6, s1 - 6, -0.32, -0.16, P.yellow);
    q(s0 + 6, s1 - 6, 0.16, 0.32, P.yellow);
    // Dashed lane lines.
    for (const off of [-half / 2, half / 2]) {
      for (let s = s0 + 7; s < s1 - 9; s += 7) q(s, s + 3, off - 0.1, off + 0.1, P.white);
    }
    // Crosswalks and stop lines at both ends.
    for (const [a, dir] of [[s0, 1], [s1, -1]] as [number, number][]) {
      for (let l = -half + 0.6; l < half - 0.6; l += 1.3) {
        const x0 = a + dir * 0.8, x1 = a + dir * 4.2;
        q(Math.min(x0, x1), Math.max(x0, x1), l, l + 0.65, P.white);
      }
      const st0 = a + dir * 5.0, st1 = a + dir * 5.5;
      q(Math.min(st0, st1), Math.max(st0, st1), dir > 0 ? 0 : -half + 0.4, dir > 0 ? half - 0.4 : 0, P.white);
    }
  }

  // ---------------------------------------------------------------- street lamps
  // Posts with an arm over the road along the nearby streets. At night their heads glow and
  // each throws a pool of light on the road.
  const lampHeads: number[] = [];
  const lampPools = new Builder(true, false);
  {
    const LAMP_R = 640, SPACING = 26, HEAD_Y = 7.2;
    const post = col("#5d6472");
    const slabAt = (d: number) => (d < 380 ? 0.2 : Math.min(3, 0.2 + (d - 380) * 0.0016));
    /** Lamps along one street side; `side` is +1/-1 toward the road from the curb at `curb`. */
    const lampRow = (alongX: boolean, curb: number, side: number, s0: number, s1: number, phase: number) => {
      for (let s = s0 + 6 + phase; s < s1 - 6; s += SPACING) {
        const px = alongX ? s : curb - side * 0.7, pz = alongX ? curb - side * 0.7 : s;
        const d = Math.hypot(px, pz);
        if (d > LAMP_R) continue;
        const hx = alongX ? s : curb + side * 1.4, hz = alongX ? curb + side * 1.4 : s;
        det.box(px - 0.1, 0, pz - 0.1, px + 0.1, HEAD_Y, pz + 0.1, post);
        if (alongX) det.box(px - 0.08, HEAD_Y - 0.12, Math.min(pz, hz), px + 0.08, HEAD_Y, Math.max(pz, hz), post);
        else det.box(Math.min(px, hx), HEAD_Y - 0.12, pz - 0.08, Math.max(px, hx), HEAD_Y, pz + 0.08, post);
        lampHeads.push(hx, HEAD_Y - 0.25, hz);
        const R = 6.5, y = slabAt(d) + 0.05;
        lampPools.quad([hx - R, y, hz + R], [hx + R, y, hz + R], [hx + R, y, hz - R], [hx - R, y, hz - R], P.white, [0, 0, 1, 1]);
      }
    };
    for (const sx of xs.streets) {
      if (Math.abs(sx.c) > LAMP_R) continue;
      for (const bz of zs.blocks) {
        if (bz.b > SHORE + 1) continue;
        lampRow(false, sx.a, 1, bz.a, bz.b, 0);
        lampRow(false, sx.b, -1, bz.a, bz.b, SPACING / 2);
      }
    }
    for (const sz of zs.streets) {
      if (Math.abs(sz.c) > LAMP_R || sz.b > SHORE) continue;
      for (const bx of xs.blocks) {
        lampRow(true, sz.a, 1, bx.a, bx.b, 0);
        lampRow(true, sz.b, -1, bx.a, bx.b, SPACING / 2);
      }
    }
  }

  // ---------------------------------------------------------------- distant hills (pre-fogged)
  const hills = new Builder(false, false);
  {
    const hr = rng(31337);
    const hz = new THREE.Color(HORIZON);
    for (let k = 0; k < 46; k++) {
      const a = (k / 46) * Math.PI * 2 + hr() * 0.1;
      const dist = 2380 + hr() * 220;
      const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
      const h = 90 + hr() * 220, rad = 260 + hr() * 260;
      const base = col(pick(hr, ["#8fb5a8", "#9db7c9", "#a7b9a0", "#9fb0cc"]));
      // Rounded hills and the odd peak, shaded per face and blended toward the horizon color.
      const peak = hr() < 0.3;
      const tplPos = peak ? T.cone8 : T.ico1;
      const m = peak ? M(x, -40, z, rad, h * 1.3, rad * (0.7 + hr() * 0.5), hr() * 3) : M(x, -h * 0.25, z, rad * 1.2, h, rad * (0.8 + hr() * 0.5), hr() * 3);
      const tmp = new Builder(false, false);
      tmp.bake(tplPos, m, base);
      for (let i = 0; i < tmp.pos.length; i += 9) {
        const ny = tmp.nrm[i + 1], nx = tmp.nrm[i], nz = tmp.nrm[i + 2];
        const lit = 0.82 + 0.18 * Math.max(0, nx * SUN_X * 0.6 + ny * 0.8 + nz * SUN_Z * 0.6);
        const c = base.clone().multiplyScalar(lit).lerp(hz, 0.62);
        for (let v = 0; v < 3; v++) {
          hills.pos.push(tmp.pos[i + v * 3], tmp.pos[i + v * 3 + 1], tmp.pos[i + v * 3 + 2]);
          hills.nrm.push(nx, ny, nz);
          hills.clr.push(c.r, c.g, c.b);
        }
      }
    }
  }

  // ---------------------------------------------------------------- clouds
  const clouds = new Builder(false, false);
  {
    const cr = rng(2024);
    const top = col("#ffffff"), bottom = col("#d7def0");
    for (let k = 0; k < 22; k++) {
      const a = cr() * Math.PI * 2, dist = 350 + cr() * 1700;
      const cx = Math.cos(a) * dist, cz = Math.sin(a) * dist, cy = 330 + cr() * 330;
      const size = 40 + cr() * 70;
      const puffs = 4 + Math.floor(cr() * 4);
      for (let p = 0; p < puffs; p++) {
        const t = (p / (puffs - 1)) * 2 - 1;
        const s = size * (0.45 + 0.4 * (1 - Math.abs(t))) * (0.8 + cr() * 0.4);
        const tmp = new Builder(false, false);
        tmp.bake(T.ico1, M(cx + t * size * 1.1, cy + s * 0.15, cz + (cr() - 0.5) * size * 0.6, s, s * 0.62, s, cr() * 6), top);
        for (let i = 0; i < tmp.pos.length; i += 9) {
          const ny = tmp.nrm[i + 1];
          const c = bottom.clone().lerp(top, THREE.MathUtils.smoothstep(ny, -0.4, 0.5));
          for (let v = 0; v < 9; v++) clouds.pos.push(tmp.pos[i + v]);
          for (let v = 0; v < 3; v++) {
            clouds.nrm.push(tmp.nrm[i], tmp.nrm[i + 1], tmp.nrm[i + 2]);
            clouds.clr.push(c.r, c.g, c.b);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- sky dome
  const nightUniforms = nightSkyUniforms();
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      ...nightUniforms,
      top: { value: new THREE.Color("#6faae6") },
      mid: { value: new THREE.Color("#a9cdf0") },
      horizon: { value: new THREE.Color(HORIZON) },
      warm: { value: new THREE.Color("#fbe9d8") },
      glowAmt: { value: 0.45 },
      sunDir: { value: new THREE.Vector3(SUN_X, 0.6, SUN_Z).normalize() },
      moonDir: { value: new THREE.Vector3(0, -1, 0) },
      moon: { value: 0 },
      stars: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always on the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 warm;
      uniform float glowAmt; uniform vec3 sunDir; uniform vec3 moonDir;
      uniform float moon; uniform float stars; uniform float uTime;
      varying vec3 vDir;
      ${NIGHT_SKY_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.22, h));
        c = mix(c, top, smoothstep(0.22, 0.85, h));
        // Warm glow low in the sky toward the sun's bearing (sunrise/sunset colors at dusk).
        vec2 sh = normalize(sunDir.xz + vec2(1e-5));
        float az = max(0.0, dot(normalize(d.xz + vec2(1e-5)), sh));
        c = mix(c, warm, pow(az, 6.0) * (1.0 - smoothstep(0.0, 0.25, abs(h))) * glowAmt);
        // The sun: a halo and a disc.
        float sd = max(0.0, dot(d, sunDir));
        float up = smoothstep(-0.06, 0.02, sunDir.y);
        c += warm * pow(sd, 90.0) * 0.5 * up;
        c = mix(c, vec3(1.0, 0.95, 0.82), smoothstep(0.99955, 0.9997, sd) * up);
        // The Milky Way and shooting stars (the stars themselves are points; see nightsky.ts).
        if (stars > 0.0 && h > 0.0) {
          if (uGalaxy > 0.0) c += milkyWay(d) * uGalaxy * 0.24 * smoothstep(0.02, 0.38, h);
          c += meteors(d) * smoothstep(0.0, 0.08, h);
        }
        // The moon, lit from the sun's direction so it shows the right phase.
        float md = dot(d, moonDir);
        if (moon > 0.0 && md > 0.999) {
          vec3 right = normalize(cross(moonDir, vec3(0.0, 1.0, 0.0)));
          vec3 mup = cross(right, moonDir);
          vec3 off = d - moonDir;
          vec2 uv = vec2(dot(off, right), dot(off, mup)) / 0.02;
          float r2 = dot(uv, uv);
          if (r2 < 1.0) {
            vec3 n = uv.x * right + uv.y * mup - sqrt(1.0 - r2) * moonDir;
            float lit = smoothstep(-0.04, 0.12, dot(n, sunDir));
            float maria = 0.86 + 0.14 * smoothstep(0.25, 0.6, length(uv - vec2(-0.25, 0.2))) * smoothstep(0.15, 0.4, length(uv - vec2(0.3, -0.25)));
            vec3 mc = mix(c * 0.9 + vec3(0.02, 0.025, 0.04), vec3(0.97, 0.95, 0.88) * maria, lit);
            c = mix(c, mc, smoothstep(1.0, 0.86, r2) * moon);
          }
        }
        c += vec3(0.55, 0.62, 0.8) * pow(max(0.0, md), 600.0) * 0.18 * moon;
        if (h < 0.0) c = horizon;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), skyMat);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  sky.name = "sky";
  const nightSky = new NightSky(nightUniforms);
  sky.add(nightSky.stars);
  sky.onBeforeRender = (renderer, _scene, camera) => {
    if (skyMat.uniforms.stars.value > 0) nightSky.beforeSkyRender(renderer, camera);
  };

  // ---------------------------------------------------------------- trees (instanced)
  function treeTemplate(kind: "round" | "pine") {
    const parts: THREE.BufferGeometry[] = [];
    const trunk = new THREE.CylinderGeometry(0.22, 0.3, 2.6, 5, 1, true).translate(0, 1.3, 0).toNonIndexed();
    const canopy =
      kind === "round"
        ? new THREE.IcosahedronGeometry(1, 0).scale(2.6, 2.3, 2.6).translate(0, 4.1, 0)
        : new THREE.ConeGeometry(2.2, 6.5, 6).translate(0, 5.2, 0).toNonIndexed();
    for (const [g, c] of [[trunk, col("#a07a5c")], [canopy, col("#ffffff")]] as [THREE.BufferGeometry, THREE.Color][]) {
      g.deleteAttribute("uv");
      const n = g.getAttribute("position").count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      parts.push(g);
    }
    const merged = mergeGeometries(parts)!;
    merged.computeVertexNormals();
    return merged;
  }
  const greens = ["#7cc46a", "#8fd17a", "#6bb36b", "#a4d67a", "#79bf8a"].map(col);
  const pinkBlossom = col("#f6b8cc");
  function treeMesh(list: number[], kind: "round" | "pine") {
    const n = list.length / 5;
    const im = new THREE.InstancedMesh(treeTemplate(kind), vertexToon(), Math.max(1, n));
    const m = new THREE.Matrix4();
    const tr = rng(kind === "round" ? 5 : 6);
    for (let i = 0; i < n; i++) {
      const [x, y, z, s, ci] = list.slice(i * 5, i * 5 + 5);
      im.setMatrixAt(i, m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, tr() * 6, 0)), _s.set(s, s * (0.9 + tr() * 0.25), s)));
      im.setColorAt(i, kind === "round" && tr() < 0.06 ? pinkBlossom : greens[ci]);
    }
    im.count = n;
    im.name = `trees-${kind}`;
    return im;
  }

  // ---------------------------------------------------------------- cars (instanced)
  interface Car {
    alongX: boolean;
    lat: number;
    dir: number;
    s: number;
    min: number;
    max: number;
    v: number;
    sx: number;
    sy: number;
    sz: number;
  }
  const cars: Car[] = [];
  {
    const cr = rng(99);
    const addLane = (alongX: boolean, c: number, w: number, min: number, max: number, density: number) => {
      const half = w / 2;
      const lanes = Math.abs(c) < 260 ? [half * 0.25, half * 0.72] : [half * 0.5];
      for (const dir of [1, -1]) {
        for (const off of lanes) {
          // Right-hand traffic.
          const lat = alongX ? c + dir * off : c - dir * off;
          const n = Math.floor(((max - min) / 100) * density * (0.6 + cr() * 0.8));
          for (let k = 0; k < n; k++) {
            const bus = cr() < 0.08;
            cars.push({
              alongX,
              lat,
              dir,
              s: lerp(min, max, cr()),
              min,
              max,
              v: (bus ? 6 : 7 + cr() * 5) * (off < half * 0.5 ? 0.85 : 1),
              sx: bus ? 2.6 : 0.9 + cr() * 0.25,
              sy: bus ? 1.55 : 1,
              sz: bus ? 1.25 : 1,
            });
          }
        }
      }
    };
    for (const s of xs.streets) if (Math.abs(s.c) < 560) addLane(false, s.c, s.w, -600, SHORE - 3, Math.abs(s.c) < 260 ? 1.05 : 0.45);
    for (const s of zs.streets) if (Math.abs(s.c) < 560 && s.c < SHORE) addLane(true, s.c, s.w, -600, 600, Math.abs(s.c) < 260 ? 1.05 : 0.45);
  }
  const carColors = ["#ffd23f", "#ffd23f", "#ff6b6b", "#4dabf7", "#63e6be", "#ffa94d", "#f783ac", "#f8f9fa", "#b197fc", "#38d9a9", "#74c0fc"].map(col);
  function carTemplate() {
    const parts: THREE.BufferGeometry[] = [];
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color) => {
      const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
      g.deleteAttribute("uv");
      const n = g.getAttribute("position").count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      parts.push(g);
    };
    add(4.2, 0.95, 1.9, 0, 0.6, 0, col("#ffffff")); // body
    add(2.3, 0.62, 1.72, -0.25, 1.36, 0, col("#3b4252")); // windows
    add(2.1, 0.12, 1.6, -0.25, 1.72, 0, col("#ffffff")); // roof
    return mergeGeometries(parts)!;
  }
  const carMesh = new THREE.InstancedMesh(carTemplate(), vertexToon(), Math.max(1, cars.length));
  carMesh.name = "cars";
  carMesh.frustumCulled = false;
  cars.forEach((c, i) => carMesh.setColorAt(i, carColors[i % carColors.length]));
  function placeCars() {
    const a = carMesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      // Heading +x: yaw 0. -x: pi. +z: -pi/2. -z: +pi/2.
      const cs = c.alongX ? c.dir : 0;
      const sn = c.alongX ? 0 : -c.dir;
      const o = i * 16;
      a[o] = cs * c.sx; a[o + 1] = 0; a[o + 2] = -sn * c.sx; a[o + 3] = 0;
      a[o + 4] = 0; a[o + 5] = c.sy; a[o + 6] = 0; a[o + 7] = 0;
      a[o + 8] = sn * c.sz; a[o + 9] = 0; a[o + 10] = cs * c.sz; a[o + 11] = 0;
      a[o + 12] = c.alongX ? c.s : c.lat; a[o + 13] = 0; a[o + 14] = c.alongX ? c.lat : c.s; a[o + 15] = 1;
    }
    carMesh.instanceMatrix.needsUpdate = true;
  }
  placeCars();

  // Headlights and taillights: one mesh for the lamps themselves, one for the glow they throw on
  // the road. Both share the cars' instance matrices, so moving the cars moves the lights.
  function carLightsTemplate() {
    const parts: THREE.BufferGeometry[] = [];
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color) => {
      const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
      g.deleteAttribute("uv");
      const n = g.getAttribute("position").count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      parts.push(g);
    };
    for (const z of [-0.6, 0.6]) {
      add(0.08, 0.24, 0.46, 2.12, 0.74, z, col("#fff8e0"));
      add(0.08, 0.2, 0.42, -2.12, 0.8, z, col("#ff2b2b"));
    }
    return mergeGeometries(parts)!;
  }
  function carGlowTemplate() {
    const b = new Builder(true, false);
    const y = 0.09;
    // Headlight beam ahead (u runs from the bumper outward).
    b.quad([2.0, y, 0.95], [17, y, 3.6], [17, y, -3.6], [2.0, y, -0.95], col("#fff1cf"), [0, 0, 1, 1]);
    // Red glow behind.
    b.quad([-2.0, y, -1.1], [-6.0, y, -1.8], [-6.0, y, 1.8], [-2.0, y, 1.1], col("#ff3a2a"), [0, 0, 1, 1]);
    return b.build();
  }
  const carLampMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, fog: false });
  const carLamps = new THREE.InstancedMesh(carLightsTemplate(), carLampMat, Math.max(1, cars.length));
  carLamps.instanceMatrix = carMesh.instanceMatrix;
  carLamps.frustumCulled = false;
  const carGlowMat = glowMaterial(beamTex(), "#ffffff", true);
  const carGlow = new THREE.InstancedMesh(carGlowTemplate(), carGlowMat, Math.max(1, cars.length));
  carGlow.instanceMatrix = carMesh.instanceMatrix;
  carGlow.frustumCulled = false;
  carGlow.renderOrder = 2;

  // ---------------------------------------------------------------- our tower
  const shellTex = paintShell();
  const shellMat = facadeMaterial(shellTex, 0.95);
  const towerStatic = new Builder();
  {
    const white = col("#eef1f5");
    // Corner columns run the full height; they sit just outside the office box.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x0 = sx > 0 ? 18.3 : -18.9, z0 = sz > 0 ? 13.3 : -13.9;
        towerStatic.box(x0, 0.35, z0, x0 + 0.6, TOWER_ROOF + 1.6, z0 + 0.6, white);
      }
    }
    // Double-height lobby with canopies.
    const lobby = rectLoop(-TX - 0.3, -TZ - 0.3, TX + 0.3, TZ + 0.3);
    towerStatic.walls(lobby, 0.35, 8, col("#55667e"));
    towerStatic.ring(lobby, rectLoop(-TX, -TZ, TX, TZ), 8, white);
    for (const s of [-1, 1]) towerStatic.box(-7, 4.6, s > 0 ? TZ + 0.3 : -TZ - 3.6, 7, 5.0, s > 0 ? TZ + 3.6 : -TZ - 0.3, white);
  }
  // Roof (positioned at the roof height in setElevation).
  const roofB = new Builder();
  {
    const white = col("#eef1f5"), grey = col("#cfd5de");
    roofB.cap(rectLoop(-TX, -TZ, TX, TZ), 0, col("#c9ced6"));
    parapetTo(roofB, { kind: "rect", x0: -TX, z0: -TZ, x1: TX, z1: TZ }, 0, 1.6, white);
    roofB.box(-9, 0, -6, 7, 7, 5, grey, col("#dde2e8"));
    roofB.walls(rectLoop(-9.15, -6.15, 7.15, 5.15), 3.6, 5.6, P.acDark);
    for (const x of [10, 14]) {
      roofB.box(x - 1.6, 0, -9, x + 1.6, 2.4, -3, P.ac);
      for (const z of [-7.5, -4.5]) roofB.bake(T.cyl8, M(x, 2.4, z, 1.1, 0.12, 1.1), P.acDark);
    }
    roofB.bake(T.cyl8, M(-1, 7, 0, 0.5, 30, 0.5), P.metal);
    roofB.bake(T.cyl8, M(-1, 37, 0, 0.25, 8, 0.25), P.metal);
    for (const y of [16, 26]) roofB.box(-3, 7 + y - 0.1, -0.1, 1, 7 + y + 0.1, 0.1, P.metal);
    roofB.bake(T.ico0, M(-1, 45.2, 0, 0.6, 0.6, 0.6), P.red);
    // Window-washing gantry.
    roofB.box(-TX + 1, 1.6, TZ - 1.2, TX - 1, 2.2, TZ - 0.6, P.yellow);
    roofB.box(-3, 1.6, TZ - 3, -1, 3.6, TZ + 0.8, P.yellow);
  }
  function parapetTo(b: Builder, f: Footprint, y: number, h: number, color: THREE.Color) {
    const outer = loopOf(f, -0.12), inner = loopOf(f, 0.4);
    b.walls(outer, y, y + h, color);
    b.wallsIn(inner, y, y + h, color);
    b.ring(outer, inner, y + h, color);
  }

  /** Shell walls between two local heights; UVs follow world height so slab edges line up with the office floors. */
  function shellGeometry(y0: number, y1: number, worldZero: number) {
    const b = new Builder(true);
    if (y1 - y0 > 0.05) {
      const loop = rectLoop(-TX, -TZ, TX, TZ);
      const v0 = (y0 - worldZero) / SHELL_V, v1 = (y1 - worldZero) / SHELL_V;
      const white = new THREE.Color(1, 1, 1);
      for (let i = 0; i < 4; i++) {
        const p = loop[i], q = loop[(i + 1) % 4];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        // Mullions at -18 + 1.5k (x) / -13 + 1.5k (z), like the office's curtain wall.
        const u0 = -0.4 / SHELL_U, u1 = (len - 0.4) / SHELL_U;
        b.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], white, [u0, v0, u1, v1]);
      }
    }
    return b.build();
  }

  // ---------------------------------------------------------------- assemble
  const parts: THREE.Object3D[] = [];
  const add = (o: THREE.Object3D, name: string) => {
    o.name = name;
    group.add(o);
    parts.push(o);
    return o;
  };
  add(sky, "sky");
  add(mesh(hills.build(), vertexBasic(false), { shadow: false, receive: false }), "hills");
  const cloudMesh = add(mesh(clouds.build(), vertexBasic(true), { shadow: false, receive: false }), "clouds");
  add(mesh(ground.build(), vertexToon(), { shadow: false, receive: false }), "ground");
  const markMat = vertexToon();
  markMat.polygonOffset = true;
  markMat.polygonOffsetFactor = -2;
  markMat.polygonOffsetUnits = -4;
  add(mesh(marks.build(), markMat, { shadow: false, receive: false }), "road-markings");
  const facTex = [0, 1, 2, 3, 4].map(paintFacade);
  fac.forEach((b, i) => {
    if (b.triangles) add(mesh(b.build(), facadeMaterial(facTex[i], i === 2 ? 1 : 0.9), { shadow: false, receive: false }), `facades-${i}`);
  });
  add(mesh(det.build(), vertexToon(), { shadow: false, receive: false }), "details");
  add(treeMesh(roundTrees, "round"), "trees-round");
  if (pineTrees.length) add(treeMesh(pineTrees, "pine"), "trees-pine");
  add(carMesh, "cars");
  let wheelMesh: THREE.Mesh | null = null;
  if (wheelGroup) {
    wheelMesh = mesh(wheel.build(), vertexToon(), { shadow: false, receive: false });
    wheelGroup.add(wheelMesh);
    add(wheelGroup, "ferris-wheel");
  }
  let wheelLights: { p: THREE.Points; m: THREE.PointsMaterial } | null = null;
  add(mesh(towerStatic.build(), vertexToon(), { shadow: false, receive: false }), "tower-static");

  // Every lit (toon) material gets tinted for the time of day. Collected before the night-only
  // extras are added, since those are unlit and fade on their own.
  const litMats = new Set<THREE.MeshToonMaterial>();
  const hillsMat = (group.getObjectByName("hills") as THREE.Mesh).material as THREE.MeshBasicMaterial;
  const cloudMat = (cloudMesh as THREE.Mesh).material as THREE.MeshBasicMaterial;

  // Night lights.
  const nightObjs: THREE.Object3D[] = [];
  const glowMats: { m: THREE.Material & { opacity: number }; k: number }[] = [];
  const night = (o: THREE.Object3D, name: string, m: THREE.Material & { opacity: number }, k = 1) => {
    o.visible = false;
    nightObjs.push(add(o, name));
    glowMats.push({ m, k });
  };
  night(carLamps, "car-lamps", carLampMat);
  night(carGlow, "car-glow", carGlowMat, 0.55);
  const poolMat = glowMaterial(glowTex(), "#ffc982");
  const pools = mesh(lampPools.build(), poolMat, { shadow: false, receive: false });
  pools.renderOrder = 1;
  night(pools, "lamp-pools", poolMat, 0.5);
  const pointsOf = (xyz: number[], size: number, color: THREE.ColorRepresentation, rgb?: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(xyz, 3));
    if (rgb) g.setAttribute("color", new THREE.Float32BufferAttribute(rgb, 3));
    const m = new THREE.PointsMaterial({
      size,
      map: glowTex(),
      color,
      vertexColors: !!rgb,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return { p, m };
  };
  {
    const { p, m } = pointsOf(lampHeads, 2.6, "#ffd9a0");
    night(p, "lamp-heads", m);
  }
  // Red aviation beacons on the tall towers; they blink in update().
  const beaconXYZ: number[] = [];
  for (const b of buildings) {
    const t = b.tiers[b.tiers.length - 1];
    if (b.cls !== 2 || t.y1 < 100) continue;
    const r = rectOf(t.f);
    beaconXYZ.push((r.x0 + r.x1) / 2, t.y1 + (b.crown === "spire" ? 14 : 3), (r.z0 + r.z1) / 2);
  }
  const beacons = pointsOf(beaconXYZ, 9, "#ff3030");
  night(beacons.p, "beacons", beacons.m);
  // Our own mast's beacon rides on the roof (and hides with it in the cutaway view).
  const ownBeacon = new THREE.Points(pointsOf([-1, 45.2, 0], 9, "#ff3030").p.geometry, beacons.m);
  ownBeacon.frustumCulled = false;
  ownBeacon.visible = false;
  nightObjs.push(ownBeacon);
  const lighthouseGlow = pointsOf([lighthouse.x, lighthouse.y, lighthouse.z], 22, "#fff0c0");
  night(lighthouseGlow.p, "lighthouse-glow", lighthouseGlow.m);
  const lowerShell = mesh(new THREE.BufferGeometry(), shellMat, { shadow: false, receive: false });
  add(lowerShell, "tower-shell-below");
  const towerAbove = new THREE.Group();
  towerAbove.name = "tower-above";
  const upperShell = mesh(new THREE.BufferGeometry(), shellMat, { shadow: false, receive: false });
  upperShell.name = "tower-shell-above";
  const roofMesh = mesh(roofB.build(), vertexToon(), { shadow: false, receive: false });
  roofMesh.name = "tower-roof";
  towerAbove.add(upperShell, roofMesh);
  roofMesh.add(ownBeacon);
  group.add(towerAbove);
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m instanceof THREE.MeshToonMaterial) litMats.add(m);
  });

  group.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
  });

  let elevation = 0;
  function setElevation(m: number) {
    elevation = Math.max(8, m);
    group.position.y = -elevation;
    sky.position.y = elevation; // keep the sky centered on the viewer's height
    const roofY = Math.max(TOWER_ROOF, elevation + HOLE_Y1 + 8);
    lowerShell.geometry.dispose();
    lowerShell.geometry = shellGeometry(8, elevation + HOLE_Y0, elevation);
    upperShell.geometry.dispose();
    upperShell.geometry = shellGeometry(elevation + HOLE_Y1, roofY, elevation);
    roofMesh.position.y = roofY;
    group.updateMatrixWorld(true);
  }
  setElevation(90);

  if (wheelMesh) {
    const xyz: number[] = [], rgb: number[] = [];
    for (let i = 0; i < wheelBulbs.length; i += 6) {
      xyz.push(wheelBulbs[i], wheelBulbs[i + 1], wheelBulbs[i + 2]);
      rgb.push(wheelBulbs[i + 3], wheelBulbs[i + 4], wheelBulbs[i + 5]);
    }
    wheelLights = pointsOf(xyz, 3.6, "#ffffff", rgb);
    wheelLights.p.visible = false;
    wheelMesh.add(wheelLights.p);
    glowMats.push({ m: wheelLights.m, k: 1 });
    nightObjs.push(wheelLights.p);
  }

  let nightLevel = 0;
  function applyEnv(env: CityEnv) {
    const u = skyMat.uniforms;
    u.top.value.copy(env.top);
    u.mid.value.copy(env.mid);
    u.horizon.value.copy(env.horizon);
    u.warm.value.copy(env.glow);
    u.glowAmt.value = env.glowAmt;
    u.sunDir.value.copy(env.sunDir);
    u.moonDir.value.copy(env.moonDir);
    u.moon.value = env.moon;
    u.stars.value = env.stars;
    nightSky.setSky(env.stars, env.celestial, env.moonDir, env.moon);
    fog.color.copy(env.horizon);
    background.copy(env.horizon);
    for (const m of litMats) m.color.copy(env.tint);
    hillsMat.color.copy(env.hills);
    cloudMat.color.copy(env.clouds);
    nightLevel = env.night;
    nightMix.value = env.night;
    windowsOn.value = env.windows;
    for (const o of nightObjs) o.visible = env.night > 0.01;
    for (const { m, k } of glowMats) m.opacity = env.night * k;
  }

  let wheelAngle = 0;
  function update(dt: number, time: number) {
    skyMat.uniforms.uTime.value = time;
    nightSky.update(dt, time);
    if (nightLevel > 0.01) {
      // Beacons blink together, about once every two seconds; the lighthouse pulses.
      beacons.m.opacity = nightLevel * (time % 2 < 0.35 ? 1 : 0.08);
      lighthouseGlow.m.opacity = nightLevel * (0.55 + 0.45 * Math.max(0, Math.sin(time * 1.6)) ** 4);
    }
    const step = Math.min(dt, 1e6);
    for (const c of cars) {
      c.s += c.dir * c.v * step;
      const span = c.max - c.min;
      if (c.s > c.max) c.s = c.min + ((c.s - c.min) % span);
      else if (c.s < c.min) c.s = c.max - ((c.max - c.s) % span);
    }
    placeCars();
    cloudMesh.rotation.y += step * 0.0012;
    if (wheelMesh) {
      wheelAngle += step * 0.05;
      wheelMesh.rotation.z = wheelAngle;
    }
  }

  const ms = performance.now() - t0;
  if (import.meta.env?.DEV) console.debug(`[city] built in ${ms.toFixed(0)} ms, ${buildings.length} buildings, ${cars.length} cars, ${(roundTrees.length + pineTrees.length) / 5} trees`);

  return { group, fog, background, setElevation, update, applyEnv, towerAbove, cameraFar: CAMERA_FAR, nightSky };
}
