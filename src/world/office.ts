// Builds the 3D office from the floor plan data (floorplan.ts): floors per room,
// curtain walls, partitions with doorways, glass meeting rooms, columns, a ceiling
// with light panels, and all the furniture. Returns handles the game uses at runtime.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import * as plan from "./floorplan.ts";
import { DESKS, MANAGER_SLOT, PM_SLOT, type DeskSlot } from "./layout.ts";
import { canvasTexture, flat, hashString, mesh, toon, toonUnique } from "./toon.ts";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { fitFootprint, InstancedPlacer, type AssetLibrary } from "./assets.ts";
import { SwivelChairs } from "./chairs.ts";
import { Elevators } from "./elevator.ts";

/** Theme accent shared by procedural props and Blender assets ("accent*" materials). */
export const accentMaterial = toonUnique("#6f9de0");

/** Every model the office may use; missing ones fall back to primitives. */
export const OFFICE_ASSETS = [
  "office_chair", "office_chair_base", "office_chair_top", "bench_desk", "monitor", "keyboard", "mouse", "mug", "mug_b", "laptop", "desk_lamp", "notebook_stack",
  "pen_cup", "photo_frame", "succulent", "headphones", "desk_divider", "pedestal_drawers", "meeting_chair",
  "table_conference", "table_meeting", "table_small", "table_round", "table_cafe", "side_table", "high_table", "bar_counter",
  "bar_stool", "credenza", "tv", "whiteboard", "bookshelf", "bookshelf_b", "reception_desk", "printer", "trash_bin",
  "recycling_bin", "wall_art_a", "wall_art_b", "wall_art_c", "wall_clock", "coat_rack", "filing_cabinet",
  "sofa", "armchair", "coffee_table", "beanbag", "floor_lamp", "pendant_lamp", "pendant_lamp_linear", "plant_monstera",
  "plant_fiddle", "plant_snake", "plant_small", "plant_hanging", "planter_box", "kitchen_counter", "kitchen_island", "fridge",
  "coffee_machine", "microwave", "water_cooler", "cafe_chair", "drinking_fountain", "rug_round", "rug_rect",
  "vending_machine", "umbrella_stand", "magazine_rack",
];

/** Monitor model: the display face (material "screen") in the monitor's own frame (y up, front +z). */
const MONITOR_SCREEN = { y: 0.34, z: -0.012, w: 0.58, h: 0.34 };
const DESK_TOP = 0.74;

export interface Box2 {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Monitor {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  slot: DeskSlot;
  lastDrawKey: string;
}

export interface Office {
  root: THREE.Group;
  colliders: Box2[];
  monitors: Monitor[]; // index = desk index
  pmMonitor: Monitor;
  managerMonitor: Monitor;
  hireMarkers: THREE.Object3D[];
  pmMarker: THREE.Object3D;
  managerMarker: THREE.Object3D;
  board: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture };
  /** The roster on the manager's office wall. */
  staffBoard: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture };
  /** Nameplate over the manager's door. */
  managerSign: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture };
  sign: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture };
  setTheme(theme: Theme): void;
  /** Overview mode: hide the ceiling and cut the walls down so you can see in from above. */
  setCutaway(on: boolean): void;
  /** Swivelling desk chair tops (null when the chair models are missing). */
  chairs: SwivelChairs | null;
  /** Everything vertical (scaled down in cutaway) and the ceiling (hidden in cutaway). */
  walls: THREE.Group;
  ceiling: THREE.Group;
  /** The lifts: sliding doors, cars with floor buttons, the lobby directory. */
  elevators: Elevators;
}

/** Floor finishes for the ray tracer: everything is sealed or polished, so it reflects. */
const FLOOR_RT: Record<string, { rough: number; f0?: number }> = {
  carpet: { rough: 0.3 },
  "carpet-accent": { rough: 0.28 },
  wood: { rough: 0.14, f0: 0.05 },
  tile: { rough: 0.06, f0: 0.05 },
  vinyl: { rough: 0.1, f0: 0.05 },
  stone: { rough: 0.02, f0: 0.06 },
  concrete: { rough: 0.35 },
};

export interface Theme {
  carpet: string;
  accent: string;
  wall: string;
}

export const THEMES: Theme[] = [
  { carpet: "#bfd0e6", accent: "#6f9de0", wall: "#f3efe6" },
  { carpet: "#c9dcc0", accent: "#6fb36a", wall: "#f4f1e7" },
  { carpet: "#e4cdbf", accent: "#e08a62", wall: "#f6efe8" },
  { carpet: "#d3c8e6", accent: "#9a7ad6", wall: "#f2eef6" },
  { carpet: "#e8dbb0", accent: "#d9a73a", wall: "#f6f2e6" },
  { carpet: "#bfdcd8", accent: "#4fb0a6", wall: "#eef4f2" },
  { carpet: "#e8c9d6", accent: "#d76d97", wall: "#f7eef2" },
];

const H = plan.CEILING_HEIGHT;
const DOOR_H = plan.DOOR_HEIGHT;
/** In the overview, walls are cut down to about this height (meters). */
const CUTAWAY_SCALE = 1.05 / H;

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
  sphere: new THREE.SphereGeometry(0.5, 16, 12),
  plane: new THREE.PlaneGeometry(1, 1),
};

function rbox(w: number, h: number, d: number, r = 0.06) {
  return new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, shadow = true) {
  const m = mesh(G.box, mat, { pos: [x, y, z], shadow });
  m.scale.set(w, h, d);
  return m;
}

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  return { canvas, ctx, texture: canvasTexture(canvas) };
}

export function drawScreenOff(ctx: CanvasRenderingContext2D) {
  const { width: w, height: h } = ctx.canvas;
  ctx.fillStyle = "#1d2030";
  ctx.fillRect(0, 0, w, h);
}

function tileTexture(a: string, b: string, repeat = 1) {
  const t = makeCanvas(64, 64);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      t.ctx.fillStyle = (i + j) % 2 ? a : b;
      t.ctx.fillRect(i * 32, j * 32, 32, 32);
    }
  }
  t.texture.wrapS = t.texture.wrapT = THREE.RepeatWrapping;
  t.texture.repeat.set(repeat, repeat);
  t.texture.needsUpdate = true;
  return t.texture;
}

function plankTexture() {
  const t = makeCanvas(128, 128);
  t.ctx.fillStyle = "#dcb98e";
  t.ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 8; i++) {
    t.ctx.fillStyle = i % 2 ? "#d4b085" : "#e2c197";
    t.ctx.fillRect(0, i * 16, 128, 15);
    t.ctx.fillStyle = "#c9a477";
    t.ctx.fillRect(((i * 53) % 128), i * 16, 2, 15);
  }
  t.texture.wrapS = t.texture.wrapT = THREE.RepeatWrapping;
  t.texture.needsUpdate = true;
  return t.texture;
}

const inside = (x: number, z: number, r: plan.Rect) => x > r[0] && x < r[2] && z > r[1] && z < r[3];
const serviceRooms = plan.ROOMS.filter((r) => r.service);
const inService = (x: number, z: number) => serviceRooms.some((r) => inside(x, z, r.rect));

// ------------------------------------------------------------------ build

export function buildOffice(lib?: AssetLibrary): Office {
  const root = new THREE.Group();
  const walls = new THREE.Group(); // everything vertical: scaled down in cutaway mode
  const ceiling = new THREE.Group();
  root.add(walls, ceiling);
  const colliders: Box2[] = [];

  const carpetMat = toonUnique("#bfd0e6");
  const accentCarpetMat = toonUnique("#d6cfe8");
  const accentMat = accentMaterial;
  const placer = new InstancedPlacer();
  // Wall-hung models go with the walls (cut down in the overview); ceiling-hung ones with the ceiling.
  const wallPlacer = new InstancedPlacer();
  const hungPlacer = new InstancedPlacer();
  const has = (name: string) => !!lib?.has(name);
  const chairMat = toonUnique("#6f9de0");
  const wallMat = toonUnique("#f3efe6");

  // ---------------------------------------------------------------- floors
  const P = plan.PLATE;
  const base = mesh(new THREE.PlaneGeometry(P.maxX - P.minX + 1, P.maxZ - P.minZ + 1), toon("#d9d6cf"), { rot: [-Math.PI / 2, 0, 0], shadow: false });
  base.position.y = -0.01;
  base.userData.rt = { rough: 0.4 };
  root.add(base);
  const wood = plankTexture();
  const tile = tileTexture("#f2efe8", "#e4e0d6");
  const finishMat = (r: plan.Room): THREE.Material => {
    switch (r.finish) {
      case "carpet":
        return carpetMat;
      case "carpet-accent":
        return accentCarpetMat;
      case "wood": {
        const t = wood.clone();
        t.repeat.set((r.rect[2] - r.rect[0]) / 2, (r.rect[3] - r.rect[1]) / 2);
        t.needsUpdate = true;
        return new THREE.MeshToonMaterial({ map: t });
      }
      case "tile": {
        const t = tile.clone();
        t.repeat.set((r.rect[2] - r.rect[0]) / 1.2, (r.rect[3] - r.rect[1]) / 1.2);
        t.needsUpdate = true;
        return new THREE.MeshToonMaterial({ map: t });
      }
      case "vinyl":
        return toon("#e9e6df");
      case "stone":
        return toon("#dedad2");
      case "concrete":
        return toon("#c9c7c2");
    }
  };
  for (const r of plan.ROOMS) {
    const [x0, z0, x1, z1] = r.rect;
    const m = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), finishMat(r), { rot: [-Math.PI / 2, 0, 0], shadow: false });
    m.position.set((x0 + x1) / 2, 0.002, (z0 + z1) / 2);
    m.userData.rt = FLOOR_RT[r.finish];
    root.add(m);
  }

  // ---------------------------------------------------------------- walls
  const exteriorGlass = toon("#cfe8ff", { transparent: 0.12 });
  const glassMat = toon("#cfe8ff", { transparent: 0.25 });
  const frameMat = toon("#8f97a8");
  const mullionMat = toon("#6d7385");
  const doorMat = toon("#c99a6b");
  const metalDoorMat = toon("#b8bfcc");
  // Ray tracer finishes: brushed-steel frames, mirror-polished lift doors.
  frameMat.userData.rt = { metal: 1, rough: 0.45, color: "#c9ced8" };
  mullionMat.userData.rt = { metal: 1, rough: 0.25, color: "#b4bac6" };
  metalDoorMat.userData.rt = { metal: 1, rough: 0.07, color: "#d4d9e2" };
  doorMat.userData.rt = { rough: 0.22 };
  wallMat.userData.rt = { rough: 0.6 };

  function addCollider(x0: number, z0: number, x1: number, z1: number, t: number) {
    colliders.push({
      minX: Math.min(x0, x1) - (x0 === x1 ? t / 2 : 0),
      maxX: Math.max(x0, x1) + (x0 === x1 ? t / 2 : 0),
      minZ: Math.min(z0, z1) - (z0 === z1 ? t / 2 : 0),
      maxZ: Math.max(z0, z1) + (z0 === z1 ? t / 2 : 0),
    });
  }

  /** A vertical slab from s0..s1 along the wall, y0..y1 high. */
  function slab(w: plan.Wall, s0: number, s1: number, y0: number, y1: number, t: number, mat: THREE.Material, offset = 0) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const dx = (w.b[0] - w.a[0]) / len;
    const dz = (w.b[1] - w.a[1]) / len;
    const mid = (s0 + s1) / 2;
    const m = new THREE.Mesh(G.box, mat);
    m.position.set(w.a[0] + dx * mid - dz * offset, (y0 + y1) / 2, w.a[1] + dz * mid + dx * offset);
    m.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
    m.scale.set(s1 - s0, y1 - y0, t);
    m.receiveShadow = true;
    walls.add(m);
    return m;
  }

  const thickness = (k: plan.WallKind) =>
    k === "exterior" ? plan.EXTERIOR_WALL : k === "core" ? plan.CORE_WALL : k === "glass" ? 0.06 : plan.INTERIOR_WALL;

  for (const w of plan.WALLS) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const dx = (w.b[0] - w.a[0]) / len;
    const dz = (w.b[1] - w.a[1]) / len;
    const at = (s: number): [number, number] => [w.a[0] + dx * s, w.a[1] + dz * s];
    const t = w.thickness ?? thickness(w.kind);
    const openings = [...(w.openings ?? [])].sort((p, q) => p.at - q.at);
    const solidSpans: [number, number][] = [];
    let cur = 0;
    for (const o of openings) {
      const s0 = o.at - o.width / 2;
      if (s0 > cur) solidSpans.push([cur, s0]);
      cur = o.at + o.width / 2;
    }
    if (cur < len) solidSpans.push([cur, len]);

    if (w.kind === "exterior") {
      // Curtain wall: low spandrel, tall clear glass (the city is real geometry outside),
      // mullions every 1.5 m, a slim head under the ceiling.
      const sill = plan.WINDOW_SILL;
      const head = plan.WINDOW_HEAD;
      slab(w, 0, len, 0, sill, t, wallMat);
      slab(w, 0, len, head, H, t, wallMat);
      const win = slab(w, 0, len, sill, head, 0.02, exteriorGlass, 0);
      win.renderOrder = 3;
      win.castShadow = false;
      for (let s = 0; s <= len + 1e-6; s += 1.5) slab(w, s - 0.03, s + 0.03, sill, head, 0.14, mullionMat);
      slab(w, 0, len, sill - 0.03, sill + 0.03, 0.2, mullionMat, 0); // sill
      slab(w, 0, len, head - 0.02, head + 0.02, 0.16, mullionMat, 0); // head rail
      addCollider(w.a[0], w.a[1], w.b[0], w.b[1], t);
      continue;
    }

    for (const [s0, s1] of solidSpans) {
      const [x0, z0] = at(s0);
      const [x1, z1] = at(s1);
      if (w.kind === "glass") {
        const g = slab(w, s0, s1, 0.05, H - 0.05, 0.03, glassMat);
        g.renderOrder = 2;
        slab(w, s0, s1, 0, 0.08, 0.07, frameMat);
        slab(w, s0, s1, H - 0.08, H, 0.07, frameMat);
        for (let s = s0; s <= s1 + 1e-6; s += Math.max(0.6, (s1 - s0) / Math.ceil((s1 - s0) / 1.2))) slab(w, s - 0.025, s + 0.025, 0, H, 0.07, frameMat);
        // transom rail in line with the door heads, so the tall glass reads as clerestory above
        slab(w, s0, s1, DOOR_H - 0.03, DOOR_H + 0.03, 0.07, frameMat);
        // privacy band
        slab(w, s0, s1, 1.1, 1.35, 0.035, toon("#ffffff", { transparent: 0.55 }));
      } else {
        slab(w, s0, s1, 0, H, t, wallMat);
        // skirting
        slab(w, s0, s1, 0, 0.1, t + 0.02, accentMat);
      }
      addCollider(x0, z0, x1, z1, t);
    }

    for (const o of openings) {
      const s0 = o.at - o.width / 2;
      const s1 = o.at + o.width / 2;
      // header above the door
      if (w.kind === "glass") slab(w, s0, s1, DOOR_H, H, 0.05, glassMat);
      else slab(w, s0, s1, DOOR_H, H, t, wallMat);
      // Frame. Each piece overlaps the wall and the opening a little so no frame face sits
      // in the same plane as a wall face (coplanar faces of different colors z-fight).
      slab(w, s0 - 0.02, s0 + 0.05, 0, DOOR_H, t + 0.04, frameMat);
      slab(w, s1 - 0.05, s1 + 0.02, 0, DOOR_H, t + 0.04, frameMat);
      slab(w, s0 - 0.02, s1 + 0.02, DOOR_H - 0.05, DOOR_H + 0.03, t + 0.04, frameMat);

      // Lift doors slide and have a car behind them: see elevator.ts (which also owns their colliders).
      const closed = o.kind !== "elevator" && (o.kind === "stair-door" || w.kind === "core");
      if (o.kind === "elevator") {
        // nothing here
      } else if (closed) {
        slab(w, s0 + 0.02, s1 - 0.02, 0, DOOR_H - 0.02, 0.05, o.kind === "stair-door" ? metalDoorMat : doorMat, 0);
      } else {
        // Door leaf held open (swung 90°) on its hinge side.
        const side = o.swing ?? 1;
        const [hx, hz] = at(s0);
        const nx = dz * side;
        const nz = -dx * side;
        const leafLen = o.width - 0.04;
        const leaf = new THREE.Mesh(G.box, o.kind === "glass-door" ? glassMat : doorMat);
        leaf.position.set(hx + nx * (leafLen / 2), DOOR_H / 2, hz + nz * (leafLen / 2));
        leaf.rotation.y = Math.atan2(nx, nz) + Math.PI / 2;
        leaf.scale.set(leafLen, DOOR_H - 0.03, 0.045);
        walls.add(leaf);
        // The open leaf is solid: agents and the player walk around it.
        const lx = hx + nx * leafLen;
        const lz = hz + nz * leafLen;
        colliders.push({ minX: Math.min(hx, lx) - 0.03, maxX: Math.max(hx, lx) + 0.03, minZ: Math.min(hz, lz) - 0.03, maxZ: Math.max(hz, lz) + 0.03 });
        if (o.kind === "glass-door") {
          const handle = new THREE.Mesh(G.box, frameMat);
          handle.position.set(hx + nx * (leafLen - 0.1), 1.0, hz + nz * (leafLen - 0.1));
          handle.scale.set(0.03, 0.5, 0.03);
          walls.add(handle);
        }
      }
      if (closed) addCollider(...at(s0), ...at(s1), t);
      if (o.kind === "stair-door") {
        // green EXIT sign above the door, on both faces
        for (const side of [1, -1]) {
          const [cx, cz] = at(o.at);
          const sign = new THREE.Mesh(G.box, flat("#2fbf71"));
          sign.material.userData.rt = { emissive: 3, group: 6, light: true };
          sign.position.set(cx + dz * side * (t / 2 + 0.03), DOOR_H + 0.22, cz - dx * side * (t / 2 + 0.03));
          sign.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
          sign.scale.set(0.42, 0.16, 0.04);
          walls.add(sign);
        }
      }
    }
  }

  // Columns
  const columnMat = toon("#ece8df");
  for (const [x, z] of plan.COLUMNS) {
    const c = plan.COLUMN_SIZE;
    walls.add(box(c, H, c, columnMat, x, H / 2, z, false));
    colliders.push({ minX: x - c / 2, maxX: x + c / 2, minZ: z - c / 2, maxZ: z + c / 2 });
  }

  // ---------------------------------------------------------------- ceiling + lights
  // Acoustic ceiling tiles (unlit, so the underside reads bright instead of in shadow).
  const tiles = makeCanvas(64, 64);
  tiles.ctx.fillStyle = "#f1efe9";
  tiles.ctx.fillRect(0, 0, 64, 64);
  tiles.ctx.fillStyle = "#dcd8cf";
  tiles.ctx.fillRect(0, 0, 64, 2);
  tiles.ctx.fillRect(0, 0, 2, 64);
  tiles.texture.wrapS = tiles.texture.wrapT = THREE.RepeatWrapping;
  tiles.texture.repeat.set((P.maxX - P.minX) / 0.6, (P.maxZ - P.minZ) / 0.6);
  tiles.texture.needsUpdate = true;
  const ceil = mesh(new THREE.PlaneGeometry(P.maxX - P.minX, P.maxZ - P.minZ), new THREE.MeshBasicMaterial({ map: tiles.texture, color: "#e4e1da" }), { rot: [Math.PI / 2, 0, 0], shadow: false });
  ceil.position.set(0, H, 0);
  ceil.receiveShadow = false;
  ceil.userData.rt = { emissive: 0, rough: 0.9 };
  ceiling.add(ceil);
  const lightSpots: [number, number][] = [];
  for (let x = P.minX + 2.25; x < P.maxX - 1; x += 3) {
    for (let z = P.minZ + 1.9; z < P.maxZ - 1; z += 2.9) {
      if (inside(x, z, plan.CORE)) continue;
      lightSpots.push([x, z]);
    }
  }
  const panels = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.6, 1.2), new THREE.MeshBasicMaterial({ color: "#fffdf6", toneMapped: false }), lightSpots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  lightSpots.forEach(([x, z], i) => {
    m4.compose(new THREE.Vector3(x, H - 0.01, z), q, new THREE.Vector3(1, 1, 1));
    panels.setMatrixAt(i, m4);
  });
  panels.userData.rt = { emissive: 7, group: 1, light: true };
  ceiling.add(panels);

  // ---------------------------------------------------------------- desks
  const useDeskAssets = has("bench_desk") && has("monitor");
  const monitors: Monitor[] = DESKS.map((slot) => (useDeskAssets ? placeDesk(slot, root, placer, lib!) : buildDesk(slot, root, chairMat)));
  const pmMonitor = useDeskAssets ? placeDesk(PM_SLOT, root, placer, lib!) : buildDesk(PM_SLOT, root, toon("#ffb347"));
  const managerMonitor = useDeskAssets ? placeDesk(MANAGER_SLOT, root, placer, lib!) : buildDesk(MANAGER_SLOT, root, toon("#7a5cc4"));
  if (useDeskAssets && has("desk_divider")) {
    for (const cx of plan.BENCH_CENTERS_X) for (const z of plan.BENCH_DESK_Z) placer.add("desk_divider", cx, DESK_TOP, z, { rotY: Math.PI / 2 });
  }
  for (const cx of plan.BENCH_CENTERS_X) {
    const z0 = Math.min(...plan.BENCH_DESK_Z) - plan.DESK_W / 2;
    const z1 = Math.max(...plan.BENCH_DESK_Z) + plan.DESK_W / 2;
    colliders.push({ minX: cx - plan.DESK_D, maxX: cx + plan.DESK_D, minZ: z0, maxZ: z1 });
  }
  for (const d of [plan.PM_DESK, plan.MANAGER_DESK]) {
    // Desks are long across the direction their agent faces.
    const [x, z] = d.desk;
    const hx = (d.facing[0] !== 0 ? plan.DESK_D : plan.DESK_W) / 2;
    const hz = (d.facing[0] !== 0 ? plan.DESK_W : plan.DESK_D) / 2;
    colliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz });
  }

  // ---------------------------------------------------------------- furniture
  for (const f of plan.FURNITURE) {
    if (inService(f.x, f.z)) continue;
    if (useDeskAssets && f.kind === "divider" && has("desk_divider")) continue;
    const placedAsset = lib ? placeFurnitureAsset(f, WALL_MOUNTED.has(f.kind) ? wallPlacer : placer, lib) : false;
    if (placedAsset) {
      if (!NO_COLLIDE.has(f.kind)) addFootprintCollider(f);
      continue;
    }
    const obj = buildFurniture(f, accentMat);
    if (!obj) continue;
    obj.position.set(f.x, 0, f.z);
    obj.rotation.y = f.rot;
    (WALL_MOUNTED.has(f.kind) ? walls : root).add(obj);
    if (!NO_COLLIDE.has(f.kind)) addFootprintCollider(f);
  }

  // Decor: pure set dressing from the plan (only drawn when its model exists). Ceiling-hung
  // items live in the ceiling group so they hide with it in the cutaway overview.
  if (lib) {
    for (const d of plan.DECOR) {
      if (!has(d.asset)) continue;
      (d.ceiling ? hungPlacer : d.wall ? wallPlacer : placer).add(d.asset, d.x, d.y ?? (d.ceiling ? H : 0), d.z, { rotY: d.rot ?? 0, scale: d.scale, tint: d.tint });
      if (d.collide) addFootprintCollider({ x: d.x, z: d.z, w: d.collide[0], d: d.collide[1], rot: d.rot ?? 0 });
    }
  }
  const instancedDrawCalls = lib ? placer.build(lib, root) + wallPlacer.build(lib, walls) + hungPlacer.build(lib, ceiling) : 0;
  const chairTop = useDeskAssets ? lib!.get("office_chair_top") : undefined;
  const chairs = chairTop && lib!.has("office_chair_base") ? new SwivelChairs(chairTop, [...DESKS, PM_SLOT, MANAGER_SLOT], root) : null;
  root.userData.instancedDrawCalls = instancedDrawCalls;

  function addFootprintCollider(f: { x: number; z: number; w: number; d: number; rot: number }) {
    const c = Math.abs(Math.cos(f.rot));
    const s = Math.abs(Math.sin(f.rot));
    const hw = (f.w * c + f.d * s) / 2;
    const hd = (f.w * s + f.d * c) / 2;
    colliders.push({ minX: f.x - hw, maxX: f.x + hw, minZ: f.z - hd, maxZ: f.z + hd });
  }

  // Hire markers (floating "+" over empty chairs)
  const hireTex = (() => {
    const c = makeCanvas(128, 128);
    c.ctx.fillStyle = "rgba(90,200,140,0.95)";
    c.ctx.beginPath();
    c.ctx.arc(64, 64, 56, 0, Math.PI * 2);
    c.ctx.fill();
    c.ctx.fillStyle = "#fff";
    c.ctx.fillRect(56, 30, 16, 68);
    c.ctx.fillRect(30, 56, 68, 16);
    c.texture.needsUpdate = true;
    return c.texture;
  })();
  const hireMat = new THREE.SpriteMaterial({ map: hireTex, transparent: true, opacity: 0.85, depthWrite: false });
  const hireMarkers = DESKS.map((slot) => {
    const s = new THREE.Sprite(hireMat);
    s.scale.set(0.42, 0.42, 1);
    s.position.copy(slot.pos).setY(1.15);
    root.add(s);
    return s;
  });
  const pmMarker = new THREE.Sprite(hireMat);
  pmMarker.scale.set(0.42, 0.42, 1);
  pmMarker.position.copy(PM_SLOT.pos).setY(1.15);
  root.add(pmMarker);
  const managerMarker = new THREE.Sprite(hireMat);
  managerMarker.scale.set(0.42, 0.42, 1);
  managerMarker.position.copy(MANAGER_SLOT.pos).setY(1.15);
  root.add(managerMarker);

  // Issue board (on the hub's south wall, facing north)
  const board = makeCanvas(1024, Math.round((1024 * plan.ISSUE_BOARD.height) / plan.ISSUE_BOARD.width));
  {
    const b = plan.ISSUE_BOARD;
    const yaw = Math.atan2(b.facing[0], b.facing[1]);
    const g = new THREE.Group();
    g.position.set(b.x, b.centerY, b.z);
    g.rotation.y = yaw;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(b.width, b.height), new THREE.MeshBasicMaterial({ map: board.texture, toneMapped: false }));
    face.position.z = 0.02;
    face.userData.rt = { emissive: 1.2, group: 6, light: true, liveMap: true };
    g.add(face);
    g.add(box(b.width + 0.12, b.height + 0.12, 0.03, frameMat, 0, 0, 0, false));
    g.add(box(b.width, 0.05, 0.12, toon("#c9ced9"), 0, -b.height / 2 - 0.06, 0.06, false));
    walls.add(g);
  }

  // Staff board (inside the manager's office, on the west wall, facing east): a wood-framed roster
  const staffBoard = makeCanvas(1024, Math.round((1024 * plan.STAFF_BOARD.height) / plan.STAFF_BOARD.width));
  {
    const b = plan.STAFF_BOARD;
    const g = new THREE.Group();
    g.position.set(b.x, b.centerY, b.z);
    g.rotation.y = Math.atan2(b.facing[0], b.facing[1]);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(b.width, b.height), new THREE.MeshBasicMaterial({ map: staffBoard.texture, toneMapped: false }));
    face.position.z = 0.025;
    g.add(face);
    g.add(box(b.width + 0.16, b.height + 0.16, 0.04, toon("#8a6440"), 0, 0, 0, false));
    walls.add(g);
  }

  // Nameplate over the manager's glass door, facing the lobby
  const managerSign = makeCanvas(512, 128);
  {
    const s = plan.MANAGER_SIGN;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s.width, s.height), new THREE.MeshBasicMaterial({ map: managerSign.texture, toneMapped: false, transparent: true }));
    m.position.set(s.x, s.y, s.z);
    m.rotation.y = Math.atan2(s.facing[0], s.facing[1]);
    walls.add(m);
  }

  // Floor sign above the elevators
  const sign = makeCanvas(512, 128);
  {
    const s = plan.FLOOR_SIGN;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshBasicMaterial({ map: sign.texture, toneMapped: false, transparent: true }));
    m.position.set(s.x, s.y, s.z);
    m.rotation.y = Math.atan2(s.facing[0], s.facing[1]);
    m.userData.rt = { emissive: 2.5, group: 6 };
    walls.add(m);
    // call button panel
    const [px, pz] = plan.ELEVATOR_PANEL;
    walls.add(box(0.14, 0.3, 0.04, toon("#55576a"), px, 1.15, plan.ELEVATOR_DOORS[0][1] + plan.CORE_WALL / 2 + 0.02, false));
    walls.add(box(0.06, 0.06, 0.03, flat("#7cf0a0"), px, 1.2, plan.ELEVATOR_DOORS[0][1] + plan.CORE_WALL / 2 + 0.045, false));
  }

  function setTheme(theme: Theme) {
    carpetMat.color.set(theme.carpet);
    accentCarpetMat.color.set(theme.carpet).lerp(new THREE.Color(theme.accent), 0.25);
    accentMat.color.set(theme.accent);
    accentMaterial.color.set(theme.accent);
    chairMat.color.set(theme.accent);
    wallMat.color.set(theme.wall);
  }

  function setCutaway(on: boolean) {
    walls.scale.y = on ? CUTAWAY_SCALE : 1;
    ceiling.visible = !on;
  }

  mergeStatic(walls);
  const elevators = new Elevators(walls, colliders);
  return { root, colliders, monitors, pmMonitor, managerMonitor, hireMarkers, pmMarker, managerMarker, board, staffBoard, managerSign, sign, setTheme, setCutaway, chairs, walls, ceiling, elevators };
}

// ------------------------------------------------------------------ static merge

/** Merge plain meshes that share a material into one mesh each (hundreds of wall slabs -> a few draw calls). */
function mergeStatic(group: THREE.Group) {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of [...group.children]) {
    const m = child as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || m.children.length || Array.isArray(m.material)) continue;
    if ((m.material as THREE.MeshBasicMaterial).map) continue; // canvas screens, signs, boards stay separate
    const list = byMat.get(m.material) ?? [];
    list.push(m);
    byMat.set(m.material, list);
  }
  for (const [material, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => {
      m.updateMatrix();
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(key)) g.deleteAttribute(key);
      if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
      g.applyMatrix4(m.matrix);
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const out = new THREE.Mesh(merged, material);
    out.receiveShadow = true;
    out.castShadow = meshes.some((m) => m.castShadow);
    out.renderOrder = Math.max(...meshes.map((m) => m.renderOrder));
    for (const m of meshes) group.remove(m);
    group.add(out);
  }
}

// ------------------------------------------------------------------ desks from Blender assets

const DESK_DECOR: [string, number, number, number][] = [
  // asset, local x, local z (agent sits at -z), local yaw
  ["desk_lamp", -0.62, 0.18, 0.4],
  ["succulent", 0.62, 0.24, 0],
  ["notebook_stack", -0.42, -0.08, 0.2],
  ["photo_frame", 0.45, 0.24, -0.3],
  ["pen_cup", 0.32, 0.26, 0],
  ["headphones", -0.55, -0.12, 0.5],
  ["plant_small", -0.66, 0.22, 0],
];

function placeDesk(slot: DeskSlot, parent: THREE.Group, placer: InstancedPlacer, lib: AssetLibrary): Monitor {
  const yaw = Math.atan2(slot.facing.x, slot.facing.z);
  const deskM = new THREE.Matrix4().compose(slot.desk.clone(), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
  const at = (name: string, x: number, y: number, z: number, localYaw: number, skip?: string[]) => {
    if (!lib.has(name)) return;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), localYaw), new THREE.Vector3(1, 1, 1));
    placer.addMatrix(name, deskM.clone().multiply(m), { skip });
  };
  // Asset fronts face +z; the agent sits at local -z, so desk-side items turn around (π).
  at("bench_desk", 0, 0, 0, Math.PI);
  at("monitor", 0, DESK_TOP, 0.18, Math.PI, ["screen"]);
  at("keyboard", 0, DESK_TOP, -0.14, Math.PI);
  at("mouse", 0.32, DESK_TOP, -0.14, Math.PI);
  const seed = hashString(`desk${slot.index}`);
  at(seed % 2 ? "mug" : "mug_b", 0.55, DESK_TOP, -0.02, (seed % 7) * 0.5);
  if (slot.index >= 0) at("pedestal_drawers", 0.48, 0, 0.08, Math.PI);
  // One or two personal touches per desk, picked deterministically.
  const first = DESK_DECOR[seed % DESK_DECOR.length];
  const second = DESK_DECOR[(seed >>> 5) % DESK_DECOR.length];
  const picks = [first];
  // Only add a second item if it sits on the other side of the desk (no stacking).
  if (second !== first && Math.sign(second[1]) !== Math.sign(first[1])) picks.push(second);
  for (const [name, x, z, ry] of picks) at(name, x, DESK_TOP, z, Math.PI + ry);
  // Chair at the seat, facing the desk.
  // The top half swivels and is built separately (SwivelChairs); only the base is static here.
  const chairM = new THREE.Matrix4().compose(slot.pos.clone(), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
  if (lib.has("office_chair_base") && lib.has("office_chair_top")) placer.addMatrix("office_chair_base", chairM);
  else if (lib.has("office_chair")) placer.addMatrix("office_chair", chairM);

  // Per-desk canvas screen laid over the monitor's display face.
  const mon = makeCanvas(384, 240);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(MONITOR_SCREEN.w, MONITOR_SCREEN.h), new THREE.MeshBasicMaterial({ map: mon.texture, toneMapped: false }));
  const monitorM = deskM.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, DESK_TOP, 0.18), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI), new THREE.Vector3(1, 1, 1)));
  const screenLocal = new THREE.Matrix4().makeTranslation(0, MONITOR_SCREEN.y, MONITOR_SCREEN.z + 0.004);
  screen.applyMatrix4(monitorM.clone().multiply(screenLocal));
  screen.userData.rt = SCREEN_RT;
  parent.add(screen);
  drawScreenOff(mon.ctx);
  mon.texture.needsUpdate = true;
  return { ...mon, slot, lastDrawKey: "" };
}

// ------------------------------------------------------------------ furniture from Blender assets

const ROUND_TABLES: [number, string][] = [[0.65, "side_table"], [1.0, "table_cafe"], [9, "table_round"]];
const BIG_PLANTS = ["plant_monstera", "plant_fiddle", "plant_snake"];

/** Places a plan furniture item using a Blender model. Returns false if no suitable model is loaded. */
function placeFurnitureAsset(f: plan.Furniture, placer: InstancedPlacer, lib: AssetLibrary): boolean {
  const put = (name: string, opts: { y?: number; scale?: THREE.Vector3 | number; rotY?: number; tint?: THREE.ColorRepresentation; fit?: boolean } = {}) => {
    const asset = lib.get(name);
    if (!asset) return false;
    let rotY = opts.rotY ?? f.rot;
    let scale = opts.scale;
    if (opts.fit) {
      const fit = fitFootprint(asset, f.w, f.d);
      scale = fit.scale;
      if (fit.rotate) rotY += Math.PI / 2;
    }
    placer.add(name, f.x, opts.y ?? 0, f.z, { rotY, scale, tint: opts.tint });
    return true;
  };
  const seed = hashString(`${f.kind}${f.x.toFixed(2)}${f.z.toFixed(2)}`);
  const kitchen = plan.ROOMS.find((r) => r.id === "kitchen")!.rect;
  const inKitchen = inside(f.x, f.z, kitchen);
  switch (f.kind) {
    case "chair":
      return inKitchen ? put("cafe_chair") : put("meeting_chair");
    case "stool":
      return put("bar_stool");
    case "table-rect": {
      const long = Math.max(f.w, f.d);
      const name = long >= 3.2 ? "table_conference" : long >= 1.9 ? "table_meeting" : "table_small";
      return put(name, { fit: true });
    }
    case "table-round": {
      const name = ROUND_TABLES.find(([max]) => f.w <= max)![1];
      return put(name, { scale: f.w / (name === "side_table" ? 0.5 : name === "table_cafe" ? 0.9 : 1.2) });
    }
    case "high-table":
      return put("high_table", { fit: true });
    case "bar-counter":
      return put("bar_counter", { fit: true });
    case "sofa":
      return put("sofa", { tint: ["#8fb8e8", "#f2a6a0", "#c9a7ff", "#9fc4a8"][seed % 4] });
    case "armchair":
      return put("armchair", { tint: ["#9fc4a8", "#ffd36b", "#f2a6a0", "#8fb8e8"][seed % 4] });
    case "coffee-table":
      return put("coffee_table", { fit: true });
    case "beanbag":
      return put("beanbag", { tint: ["#ffd36b", "#a4e59a", "#8fd3ff"][seed % 3] });
    case "counter":
      return put("kitchen_counter", { fit: true });
    case "island": {
      if (!put("kitchen_island", { fit: true })) return false;
      if (lib.has("bar_stool")) {
        // stools on the seating side (local +z), clear of the galley
        for (const k of [-1, 0, 1]) {
          const lx = k * (f.w / 3);
          const lz = f.d / 2 + 0.35;
          placer.add("bar_stool", f.x + Math.cos(f.rot) * lx + Math.sin(f.rot) * lz, 0, f.z - Math.sin(f.rot) * lx + Math.cos(f.rot) * lz, { rotY: f.rot + Math.PI });
        }
      }
      return true;
    }
    case "fridge":
      return put("fridge", { scale: f.w < 0.7 ? 0.62 : 1 });
    case "coffee-machine":
      return put("coffee_machine", { y: 0.9 });
    case "water-cooler":
      return put("water_cooler");
    case "reception-desk":
      return put("reception_desk", { fit: true });
    case "plant": {
      if (f.w <= 0.5) return put("plant_snake") || put("plant_small", { scale: 2.2 });
      return put(BIG_PLANTS[seed % 2]);
    }
    case "tv":
      return put("tv", { scale: f.w / 2.2, y: 0 });
    case "whiteboard":
      return put("whiteboard", { scale: new THREE.Vector3(f.w / 2.4, 1, 1) });
    case "bookshelf": {
      if (!lib.has("bookshelf")) return false;
      const n = Math.max(1, Math.round(f.w / 2.0));
      const unit = f.w / n;
      for (let i = 0; i < n; i++) {
        const lx = -f.w / 2 + unit * (i + 0.5);
        placer.add(i % 2 && lib.has("bookshelf_b") ? "bookshelf_b" : "bookshelf", f.x + Math.cos(f.rot) * lx, 0, f.z - Math.sin(f.rot) * lx, {
          rotY: f.rot,
          scale: new THREE.Vector3(unit / 2.0, 1, 1),
        });
      }
      return true;
    }
    case "credenza":
      return put("credenza", { fit: true });
    case "printer":
      return put("printer");
    case "rug":
      return put("rug_rect", { fit: true });
    case "drinking-fountain":
      return put("drinking_fountain", { y: 0 });
    case "planter":
      return put("planter_box", { scale: new THREE.Vector3(f.w / 1.6, 1, 1) });
    default:
      return false;
  }
}

// ------------------------------------------------------------------ desk

const deskTopGeo = rbox(1.5, 0.05, 0.74, 0.02);
const legGeo = new THREE.BoxGeometry(0.05, 0.7, 0.05);
const monitorGeo = rbox(0.62, 0.4, 0.04, 0.02);
const screenGeo = new THREE.PlaneGeometry(0.57, 0.35);
/** Monitor faces are lights in the ray tracer, coloured by whatever is on screen. */
const SCREEN_RT = { emissive: 1.8, group: 2, light: true, liveMap: true, rough: 0.04, f0: 0.05 };
const standGeo = new THREE.BoxGeometry(0.05, 0.16, 0.05);
const keyboardGeo = rbox(0.4, 0.022, 0.13, 0.008);
const mugGeo = new THREE.CylinderGeometry(0.04, 0.035, 0.09, 12);
const seatGeo = rbox(0.48, 0.07, 0.46, 0.035);
const backGeo = rbox(0.46, 0.46, 0.06, 0.03);

function buildDesk(slot: DeskSlot, parent: THREE.Group, chairMat: THREE.Material): Monitor {
  const g = new THREE.Group();
  g.position.copy(slot.desk);
  g.rotation.y = Math.atan2(slot.facing.x, slot.facing.z);
  // Local space: the agent sits at -z looking +z.
  g.add(mesh(deskTopGeo, toon("#ece0c8"), { pos: [0, 0.72, 0] }));
  for (const [x, z] of [[-0.68, -0.31], [0.68, -0.31], [-0.68, 0.31], [0.68, 0.31]]) {
    g.add(mesh(legGeo, toon("#9a9aa6"), { pos: [x, 0.36, z], shadow: false }));
  }
  g.add(mesh(standGeo, toon("#55576a"), { pos: [0, 0.82, 0.2] }));
  g.add(mesh(monitorGeo, toon("#3a3c4e"), { pos: [0, 1.05, 0.22] }));
  const mon = makeCanvas(384, 240);
  const screen = new THREE.Mesh(screenGeo, new THREE.MeshBasicMaterial({ map: mon.texture, toneMapped: false }));
  screen.position.set(0, 1.05, 0.198);
  screen.userData.rt = SCREEN_RT;
  screen.rotation.y = Math.PI;
  g.add(screen);
  g.add(mesh(keyboardGeo, toon("#f5f5f7"), { pos: [0, 0.755, -0.12] }));
  g.add(mesh(mugGeo, toon(["#ff8f8f", "#8fd3ff", "#ffd36b", "#a4e59a"][Math.abs(slot.index) % 4]), { pos: [0.55, 0.79, -0.05] }));
  parent.add(g);
  // chair at the seat
  const chair = new THREE.Group();
  chair.position.copy(slot.pos);
  chair.rotation.y = Math.atan2(slot.facing.x, slot.facing.z);
  chair.add(mesh(seatGeo, chairMat, { pos: [0, 0.42, 0] }));
  chair.add(mesh(backGeo, chairMat, { pos: [0, 0.7, -0.24] }));
  const pole = mesh(G.cyl, toon("#55576a"), { pos: [0, 0.2, 0], shadow: false });
  pole.scale.set(0.07, 0.38, 0.07);
  chair.add(pole);
  parent.add(chair);
  drawScreenOff(mon.ctx);
  mon.texture.needsUpdate = true;
  return { ...mon, slot, lastDrawKey: "" };
}

// ------------------------------------------------------------------ furniture

const NO_COLLIDE = new Set<plan.FurnitureKind>(["chair", "stool", "rug", "tv", "whiteboard", "divider", "coffee-machine", "beanbag", "bookshelf"]);
const WALL_MOUNTED = new Set<plan.FurnitureKind>(["tv", "whiteboard"]);

const BOOK_COLORS = ["#ff8f8f", "#8fd3ff", "#ffd36b", "#a4e59a", "#c9a7ff"];

function buildFurniture(f: plan.Furniture, accent: THREE.Material): THREE.Object3D | null {
  const g = new THREE.Group();
  const { w, d } = f;
  const add = (o: THREE.Object3D) => (g.add(o), o);
  switch (f.kind) {
    case "chair":
      add(mesh(seatGeo, accent, { pos: [0, 0.44, 0] }));
      add(mesh(backGeo, accent, { pos: [0, 0.72, -0.22] }));
      add(box(0.05, 0.42, 0.05, toon("#55576a"), 0, 0.21, 0, false));
      break;
    case "stool":
      add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 14), toon("#ffb347"), { pos: [0, 0.66, 0] }));
      add(box(0.04, 0.64, 0.04, toon("#9a9aa6"), 0, 0.32, 0, false));
      break;
    case "table-rect":
      add(mesh(rbox(w, 0.05, d, 0.02), toon("#f1e6d2"), { pos: [0, 0.73, 0] }));
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(box(0.05, 0.7, 0.05, toon("#9a9aa6"), x * (w / 2 - 0.1), 0.35, z * (d / 2 - 0.1), false));
      break;
    case "table-round":
      add(mesh(new THREE.CylinderGeometry(w / 2, w / 2, 0.05, 28), toon("#ffffff"), { pos: [0, 0.73, 0] }));
      add(mesh(new THREE.CylinderGeometry(0.05, 0.22, 0.71, 12), toon("#9a9aa6"), { pos: [0, 0.355, 0] }));
      break;
    case "high-table":
      add(mesh(rbox(w, 0.05, d, 0.02), toon("#f1e6d2"), { pos: [0, 1.05, 0] }));
      add(box(0.12, 1.03, d * 0.6, toon("#9a9aa6"), 0, 0.515, 0, false));
      break;
    case "sofa":
    case "armchair": {
      const col = toon(f.kind === "armchair" ? "#9fc4a8" : ["#8fb8e8", "#f2a6a0", "#c9a7ff"][Math.abs(Math.round(f.x * 3 + f.z)) % 3]);
      add(mesh(rbox(w, 0.4, d, 0.1), col, { pos: [0, 0.22, 0] }));
      add(mesh(rbox(w, 0.5, 0.24, 0.1), col, { pos: [0, 0.62, -d / 2 + 0.12] }));
      add(mesh(rbox(0.22, 0.52, d, 0.1), col, { pos: [-w / 2 + 0.11, 0.38, 0] }));
      add(mesh(rbox(0.22, 0.52, d, 0.1), col, { pos: [w / 2 - 0.11, 0.38, 0] }));
      const n = f.kind === "sofa" ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const cw = (w - 0.44) / n;
        add(mesh(rbox(cw - 0.04, 0.12, d - 0.3, 0.05), toon("#ffffff"), { pos: [-w / 2 + 0.22 + cw * (i + 0.5), 0.48, 0.08] }));
      }
      break;
    }
    case "coffee-table":
      add(mesh(rbox(w, 0.08, d, 0.03), toon("#e8d3b0"), { pos: [0, 0.38, 0] }));
      add(box(w * 0.8, 0.34, d * 0.7, toon("#cfb48f"), 0, 0.17, 0, false));
      break;
    case "beanbag": {
      const b = mesh(G.sphere, toon(["#ffd36b", "#a4e59a", "#8fd3ff"][Math.abs(Math.round(f.x)) % 3]), { pos: [0, 0.27, 0] });
      b.scale.set(w, 0.55, d);
      add(b);
      break;
    }
    case "counter":
    case "island":
      add(mesh(rbox(w, 0.86, d, 0.03), toon("#f4f4f6"), { pos: [0, 0.43, 0] }));
      add(mesh(rbox(w + 0.04, 0.05, d + 0.04, 0.015), toon("#7d8496"), { pos: [0, 0.885, 0] }));
      if (f.kind === "counter") {
        // upper cabinets + sink
        add(mesh(rbox(w, 0.7, 0.35, 0.03), toon("#f4f4f6"), { pos: [0, 1.85, -d / 2 + 0.175] }));
        add(box(0.6, 0.02, 0.4, toon("#c9ced9"), -w / 4, 0.915, 0, false));
      } else {
        // Stools on the seating side only (local +z), keeping the galley to the counter clear.
        for (const k of [-1, 0, 1]) {
          const stool = buildFurniture({ kind: "stool", x: 0, z: 0, w: 0.4, d: 0.4, rot: 0 }, accent)!;
          stool.position.set(k * (w / 3), 0, d / 2 + 0.35);
          add(stool);
        }
      }
      break;
    case "fridge":
      add(mesh(rbox(w, 1.9, d, 0.05), toon("#dfe6ee"), { pos: [0, 0.95, 0] }));
      add(box(0.03, 0.5, 0.03, toon("#8f97a8"), w / 2 - 0.1, 1.2, d / 2 + 0.01, false));
      break;
    case "coffee-machine":
      add(mesh(rbox(w, 0.5, d, 0.05), toon("#3a3c4e"), { pos: [0, 0.91 + 0.25, 0] }));
      add(box(0.14, 0.08, 0.04, flat("#ff6b6b"), 0, 1.3, d / 2, false));
      break;
    case "water-cooler":
      add(mesh(rbox(w, 0.95, d, 0.05), toon("#f4f4f6"), { pos: [0, 0.475, 0] }));
      add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.42, 14), toon("#9fd8ff", { transparent: 0.75 }), { pos: [0, 1.16, 0] }));
      break;
    case "reception-desk":
      add(mesh(rbox(w, 1.05, d, 0.06), toon("#e9dcc4"), { pos: [0, 0.525, 0] }));
      add(mesh(rbox(w + 0.06, 0.05, d * 0.5, 0.02), toon("#ffffff"), { pos: [0, 1.08, d * 0.25] }));
      add(box(w - 0.1, 0.2, 0.02, accent, 0, 0.75, d / 2 + 0.005, false));
      break;
    case "plant":
      add(mesh(new THREE.CylinderGeometry(w * 0.4, w * 0.3, 0.42, 12), toon("#d9825b"), { pos: [0, 0.21, 0] }));
      add(mesh(new THREE.IcosahedronGeometry(w * 0.6, 0), toon("#5fb86a"), { pos: [0, 0.7, 0] }));
      add(mesh(new THREE.IcosahedronGeometry(w * 0.42, 0), toon("#6cc777"), { pos: [w * 0.15, 1.0, 0.05] }));
      add(mesh(new THREE.IcosahedronGeometry(w * 0.32, 0), toon("#4ea85a"), { pos: [-w * 0.12, 1.18, -0.04] }));
      break;
    case "tv": {
      const hgt = w * 0.56;
      add(box(w, hgt, 0.06, toon("#2a2c3a"), 0, 1.55, 0, false));
      const screen = new THREE.Mesh(G.plane, flat("#3d6fd8"));
      screen.scale.set(w - 0.08, hgt - 0.08, 1);
      screen.position.set(0, 1.55, 0.035);
      add(screen);
      break;
    }
    case "whiteboard":
      add(box(w, 1.15, 0.04, toon("#ffffff"), 0, 1.45, 0, false));
      add(box(w + 0.05, 0.04, 0.08, toon("#c9ced9"), 0, 0.86, 0.03, false));
      for (let i = 0; i < 4; i++) add(box(0.4 + (i % 2) * 0.3, 0.025, 0.005, flat(["#3d6fd8", "#e05a5a", "#2fbf71", "#3a3c4e"][i]), -w / 4 + (i % 2) * 0.5, 1.75 - i * 0.18, 0.025, false));
      break;
    case "bookshelf":
      add(mesh(rbox(w, 2.0, d, 0.03), toon("#c99a6b"), { pos: [0, 1.0, 0] }));
      for (let row = 0; row < 4; row++) {
        for (let i = 0; i < Math.floor(w / 0.22); i++) {
          if ((i * 7 + row * 3) % 5 === 0) continue;
          add(box(0.16, 0.3, d * 0.7, toon(BOOK_COLORS[(i + row) % 5]), -w / 2 + 0.15 + i * 0.22, 0.3 + row * 0.47, 0.03, false));
        }
      }
      break;
    case "credenza":
      add(mesh(rbox(w, 0.72, d, 0.03), toon("#c99a6b"), { pos: [0, 0.36, 0] }));
      break;
    case "printer":
      add(mesh(rbox(w, 1.0, d, 0.04), toon("#e6e8ee"), { pos: [0, 0.5, 0] }));
      add(box(w * 0.7, 0.04, d * 0.5, toon("#55576a"), 0, 1.02, 0, false));
      break;
    case "rug": {
      const r = new THREE.Mesh(G.plane, accent);
      r.rotation.x = -Math.PI / 2;
      r.scale.set(w, d, 1);
      r.position.y = 0.012;
      r.receiveShadow = true;
      add(r);
      break;
    }
    case "sink-counter":
      add(mesh(rbox(w, 0.82, d, 0.03), toon("#f4f4f6"), { pos: [0, 0.41, 0] }));
      add(mesh(rbox(w + 0.02, 0.04, d + 0.02, 0.015), toon("#dfe3ea"), { pos: [0, 0.84, 0] }));
      add(mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.05, 18), toon("#ffffff"), { pos: [0, 0.86, 0.02] }));
      add(box(0.03, 0.2, 0.03, toon("#c9ced9"), 0, 0.95, -d / 2 + 0.08, false));
      break;
    case "planter":
      add(mesh(rbox(w, 0.5, d, 0.04), toon("#e9dcc4"), { pos: [0, 0.25, 0] }));
      for (let i = 0; i < Math.max(2, Math.round(w / 0.45)); i++) {
        const x = -w / 2 + 0.25 + i * ((w - 0.5) / Math.max(1, Math.round(w / 0.45) - 1));
        add(mesh(new THREE.IcosahedronGeometry(0.22 + ((i * 37) % 5) * 0.02, 0), toon(i % 2 ? "#5fb86a" : "#6cc777"), { pos: [x, 0.62 + (i % 3) * 0.06, 0] }));
      }
      break;
    case "drinking-fountain":
      add(mesh(rbox(0.42, 0.18, 0.36, 0.05), toon("#c9ced9"), { pos: [-0.22, 0.95, 0] }));
      add(mesh(rbox(0.42, 0.18, 0.36, 0.05), toon("#c9ced9"), { pos: [0.24, 0.74, 0] }));
      add(box(0.1, 0.5, 0.08, toon("#9a9eab"), -0.22, 0.6, -0.12, false));
      break;
    case "bar-counter":
      add(mesh(rbox(w, 0.05, d, 0.02), toon("#e2c197"), { pos: [0, 1.05, 0] }));
      add(box(w - 0.1, 1.02, 0.08, toon("#c99a6b"), 0, 0.51, d / 2 - 0.08, false));
      break;
    case "divider":
      add(box(0.04, 0.38, d, toon("#cfd8e6"), 0, 0.93, 0, false));
      break;
    default:
      return null;
  }
  return g;
}
