// The two lifts in the core: sliding doors, a car behind each one with a floor-button panel,
// and a directory sign in the lobby. Walk up and the doors open; step in, press a floor and
// the car takes you there (the office swaps floors while the doors are shut).

import * as THREE from "three";
import * as plan from "./floorplan.ts";
import type { Box2 } from "./office.ts";
import { canvasTexture, toon } from "./toon.ts";

export interface ElevatorFloor {
  id: string;
  number: number;
  title: string;
}

const H = plan.CEILING_HEIGHT;
const DOOR_H = plan.DOOR_HEIGHT;
const DOOR_W = 1.1;
const WALL_Z = plan.ELEVATOR_DOORS[0][1]; // the core wall the doors sit in
const INNER_Z = WALL_Z - plan.CORE_WALL / 2; // its face inside the shafts
const BACK_Z = 1.4 + plan.CORE_WALL / 2; // back wall of the shafts
/** Shaft interiors (between the core walls), one per door. */
const SHAFTS: [number, number][] = [
  [0 + plan.CORE_WALL / 2, 2.65 - plan.CORE_WALL / 2],
  [2.65 + plan.CORE_WALL / 2, 5 - plan.CORE_WALL / 2],
];
const OPEN_SECONDS = 0.8;
const NEAR = 1.5; // someone this close to a door opens it
const PANEL_ROWS = 8;

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  return { canvas, ctx, texture: canvasTexture(canvas) };
}

function boxMesh(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface Door {
  x: number;
  leaves: THREE.Mesh[];
  open: number;
  hold: number;
  collider: Box2;
}

interface Ride {
  cab: number;
  phase: "closing" | "moving" | "arriving";
  t: number;
  duration: number;
  from: number;
  to: number;
  switched: boolean;
  switchFloor: () => void;
}

export class Elevators {
  readonly group = new THREE.Group();
  /** The floor-button panels, for aiming at a button. */
  readonly panels: THREE.Mesh[] = [];
  private doors: Door[] = [];
  private colliders: Box2[];
  private panel = makeCanvas(256, 512);
  private indicator = makeCanvas(256, 64);
  private directory = makeCanvas(512, 336);
  private floors: ElevatorFloor[] = [];
  private current: string | null = null;
  private hover = -1;
  private ride: Ride | null = null;
  /** Lets the camera feel the car start and stop (metres, added to the eye height). */
  cameraOffset = 0;
  /** Called with true once the doors open on arrival. */
  onDing: (() => void) | null = null;

  constructor(walls: THREE.Group, colliders: Box2[]) {
    this.colliders = colliders;
    walls.add(this.group);

    // Warm satin wall panels (bright and calm in a small lit box), brushed steel at the back.
    const steel = toon("#e4ddd0");
    steel.userData.rt = { rough: 0.38, f0: 0.04 };
    const polished = toon("#9aa1ae");
    polished.userData.rt = { metal: 1, rough: 0.18, color: "#d4d9e2" };
    // Wood laminate at the back: steel facing the steel doors is the ray tracer's noisiest case.
    const laminate = toon("#b48f68");
    laminate.userData.rt = { rough: 0.3, f0: 0.04 };
    const chrome = toon("#e3e6ec");
    chrome.userData.rt = { metal: 1, rough: 0.04, color: "#eef1f6" };
    const floorMat = toon("#3a3d4a");
    floorMat.userData.rt = { rough: 0.28, f0: 0.05 };
    const doorMat = toon("#b8bfcc");
    // Brushed rather than mirror: a mirror this size shows the noisy reflection of what's behind you.
    doorMat.userData.rt = { metal: 1, rough: 0.3, color: "#d4d9e2" };
    // A softly glowing diffuser ceiling around the lamp (an unlit one reflects as black specks).
    const ceilingMat = toon("#f6f1e8");
    ceilingMat.userData.rt = { emissive: 0.9, group: 4, rough: 0.6 };
    const lightMat = new THREE.MeshBasicMaterial({ color: "#fff7e8", toneMapped: false });
    lightMat.userData.rt = { emissive: 6, group: 4, light: true };

    const panelMat = new THREE.MeshBasicMaterial({ map: this.panel.texture, toneMapped: false });
    panelMat.userData.rt = { emissive: 1.4, group: 6 };
    const indicatorMat = new THREE.MeshBasicMaterial({ map: this.indicator.texture, toneMapped: false });
    indicatorMat.userData.rt = { emissive: 2, group: 6 };

    plan.ELEVATOR_DOOR_X.forEach((dx, i) => {
      const [x0, x1] = SHAFTS[i];
      const cx = (x0 + x1) / 2;
      const w = x1 - x0;
      const d = INNER_Z - BACK_Z;
      const cz = (BACK_Z + INNER_Z) / 2;
      // The car: steel walls, a polished back wall, a dark floor, handrails and a light.
      this.group.add(boxMesh(w, 0.02, d, floorMat, cx, 0.01, cz));
      this.group.add(boxMesh(w, H, 0.03, laminate, cx, H / 2, BACK_Z + 0.015));
      this.group.add(boxMesh(0.03, H, d, steel, x0 + 0.015, H / 2, cz));
      this.group.add(boxMesh(0.03, H, d, steel, x1 - 0.015, H / 2, cz));
      this.group.add(boxMesh(w - 0.2, 0.04, 0.04, chrome, cx, 0.95, BACK_Z + 0.08));
      this.group.add(boxMesh(0.04, 0.04, d - 0.5, chrome, x0 + 0.08, 0.95, cz - 0.1));
      this.group.add(boxMesh(0.04, 0.04, d - 0.5, chrome, x1 - 0.08, 0.95, cz - 0.1));
      this.group.add(boxMesh(w, 0.03, d, ceilingMat, cx, H - 0.015, cz));
      // Steel on the inside of the door wall too: either side of the doorway and above it.
      const fz = INNER_Z - 0.012;
      const l0 = dx - DOOR_W / 2 - 0.04 - x0;
      const l1 = x1 - (dx + DOOR_W / 2 + 0.04);
      this.group.add(boxMesh(l0, H, 0.024, steel, x0 + l0 / 2, H / 2, fz));
      this.group.add(boxMesh(l1, H, 0.024, steel, x1 - l1 / 2, H / 2, fz));
      this.group.add(boxMesh(DOOR_W + 0.08, H - DOOR_H, 0.024, steel, dx, (H + DOOR_H) / 2, fz));
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.6, d - 0.6), lightMat);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(cx, H - 0.035, cz);
      this.group.add(lamp);
      const bulb = new THREE.PointLight("#fff2dc", 3, 5, 1.6);
      bulb.position.set(cx, H - 0.4, cz);
      this.group.add(bulb);

      // Floor buttons on the wall beside the door (on your right as you face out).
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.6), panelMat);
      p.position.set(dx - 0.85, 1.3, INNER_Z - 0.046);
      p.rotation.y = Math.PI;
      p.userData.elevatorCab = i;
      this.group.add(p);
      this.panels.push(p);
      const plate = boxMesh(0.36, 0.68, 0.015, polished, dx - 0.85, 1.3, INNER_Z - 0.032);
      this.group.add(plate);
      // Which floor you're passing, above the door inside.
      const ind = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.125), indicatorMat);
      ind.position.set(dx, DOOR_H + 0.2, INNER_Z - 0.03);
      ind.rotation.y = Math.PI;
      this.group.add(ind);

      // Two leaves that slide apart into the wall.
      const leaves = [-1, 1].map((side) => {
        const leaf = boxMesh(DOOR_W / 2 + 0.01, DOOR_H, 0.06, doorMat, dx + (side * DOOR_W) / 4, DOOR_H / 2, WALL_Z);
        leaf.userData.side = side;
        // The ray tracer bakes the doors shut (see bake.ts).
        leaf.updateMatrix();
        leaf.userData.rtBakeLocal = leaf.matrix.clone();
        this.group.add(leaf);
        return leaf;
      });
      const collider = { minX: dx - DOOR_W / 2, maxX: dx + DOOR_W / 2, minZ: WALL_Z - plan.CORE_WALL / 2, maxZ: WALL_Z + plan.CORE_WALL / 2 };
      colliders.push(collider);
      this.doors.push({ x: dx, leaves, open: 0, hold: 0, collider });
    });

    // The lobby directory between the doors, above the call button.
    const dirMat = new THREE.MeshBasicMaterial({ map: this.directory.texture, toneMapped: false, transparent: true });
    dirMat.userData.rt = { emissive: 1.6, group: 6 };
    const dir = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.66), dirMat);
    dir.position.set(plan.ELEVATOR_PANEL[0], 1.85, WALL_Z + plan.CORE_WALL / 2 + 0.012);
    this.group.add(dir);
    this.draw();
  }

  /** The floors (top first) and the one you're on. */
  setFloors(floors: ElevatorFloor[], current: string | null) {
    const key = JSON.stringify([floors, current]);
    if (key === JSON.stringify([this.floors, this.current])) return;
    this.floors = floors.slice(0, PANEL_ROWS);
    this.current = current;
    this.draw();
  }

  /** Which car (0, 1) a position is inside, or -1. */
  cabAt(p: THREE.Vector3) {
    if (p.z > INNER_Z || p.z < BACK_Z) return -1;
    return SHAFTS.findIndex(([x0, x1]) => p.x > x0 && p.x < x1);
  }

  get riding() {
    return !!this.ride && this.ride.phase !== "arriving";
  }

  /** The floor button under a ray (aim + E), or null. Highlights it. */
  pick(ray: THREE.Raycaster): { cab: number; floor: ElevatorFloor } | null {
    const hit = ray.intersectObjects(this.panels, false)[0];
    let row = -1;
    if (hit?.uv) {
      const y = (1 - hit.uv.y) * 512;
      const r = Math.floor((y - 92) / 52);
      if (r >= 0 && r < this.floors.length) row = r;
    }
    if (row !== this.hover) {
      this.hover = row;
      this.drawPanel();
    }
    if (row < 0 || !hit) return null;
    return { cab: hit.object.userData.elevatorCab as number, floor: this.floors[row] };
  }

  clearHover() {
    if (this.hover !== -1) {
      this.hover = -1;
      this.drawPanel();
    }
  }

  /** Open a door for a while (the lobby call button). */
  call(near: THREE.Vector3) {
    const d = this.doors.reduce((a, b) => (Math.abs(b.x - near.x) < Math.abs(a.x - near.x) ? b : a));
    d.hold = 5;
  }

  /** Shut the doors of `cab`, travel, call `switchFloor` halfway, then open on the new floor. */
  go(cab: number, to: ElevatorFloor, switchFloor: () => void) {
    if (this.ride) return;
    const from = this.floors.find((f) => f.id === this.current)?.number ?? to.number;
    if (to.id === this.current) {
      this.doors[cab].hold = 3;
      return;
    }
    const storeys = Math.abs(to.number - from);
    this.ride = { cab, phase: "closing", t: 0, duration: THREE.MathUtils.clamp(1.4 + storeys * 0.12, 1.8, 4), from, to: to.number, switched: false, switchFloor };
    this.doors[cab].hold = 0;
  }

  /** Doors, the ride and the camera sway. `people` are everyone on the floor, you included. */
  update(dt: number, people: THREE.Vector3[]) {
    const ride = this.ride;
    this.cameraOffset = 0;
    if (ride) {
      ride.t += dt;
      if (ride.phase === "closing" && this.doors[ride.cab].open <= 0.001) {
        ride.phase = "moving";
        ride.t = 0;
      } else if (ride.phase === "moving") {
        const k = Math.min(1, ride.t / ride.duration);
        const up = ride.to > ride.from ? 1 : -1;
        // Pressed into the floor as it sets off, lighter as it stops, a little hum in between.
        this.cameraOffset = -up * 0.025 * Math.sin(k * Math.PI * 2) * (k < 0.5 ? 1 : 0.7) + Math.sin(ride.t * 37) * 0.0025;
        this.drawIndicator(Math.round(THREE.MathUtils.lerp(ride.from, ride.to, THREE.MathUtils.smootherstep(k, 0, 1))), up);
        if (!ride.switched && k >= 0.5) {
          ride.switched = true;
          ride.switchFloor();
        }
        if (k >= 1) {
          ride.phase = "arriving";
          ride.t = 0;
          this.doors[ride.cab].hold = 3;
          this.drawIndicator(ride.to, 0);
          this.onDing?.();
        }
      } else if (ride.phase === "arriving" && ride.t > 0.5) {
        this.ride = null;
      }
    }

    this.doors.forEach((d, i) => {
      d.hold = Math.max(0, d.hold - dt);
      const shutForRide = !!ride && ride.cab === i && ride.phase !== "arriving";
      const someone = people.some((p) => Math.hypot(p.x - d.x, p.z - WALL_Z) < NEAR);
      const want = shutForRide ? 0 : d.hold > 0 || someone ? 1 : 0;
      d.open = THREE.MathUtils.clamp(d.open + (want ? dt : -dt) / OPEN_SECONDS, 0, 1);
      const e = THREE.MathUtils.smoothstep(d.open, 0, 1);
      for (const leaf of d.leaves) leaf.position.x = d.x + (leaf.userData.side * DOOR_W) / 4 + leaf.userData.side * e * (DOOR_W / 2 - 0.04);
      // You can only walk through once they're mostly open.
      const i0 = this.colliders.indexOf(d.collider);
      if (d.open > 0.7 && i0 >= 0) this.colliders.splice(i0, 1);
      else if (d.open <= 0.7 && i0 < 0) this.colliders.push(d.collider);
    });
  }

  // ---------------------------------------------------------------- drawing

  private draw() {
    this.drawPanel();
    const cur = this.floors.find((f) => f.id === this.current);
    this.drawIndicator(cur?.number ?? 0, 0);
    this.drawDirectory();
  }

  private drawPanel() {
    const { ctx, texture } = this.panel;
    ctx.fillStyle = "#1b1d26";
    ctx.fillRect(0, 0, 256, 512);
    ctx.fillStyle = "#e9eef7";
    ctx.font = "800 26px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("FLOORS", 128, 42);
    ctx.font = "500 15px system-ui, sans-serif";
    ctx.fillStyle = "#8f98ad";
    ctx.fillText("aim and press E", 128, 70);
    ctx.textAlign = "left";
    this.floors.forEach((f, i) => {
      const y = 92 + i * 52;
      const here = f.id === this.current;
      const hot = i === this.hover;
      roundRect(ctx, 14, y + 4, 228, 44, 10);
      ctx.fillStyle = hot ? "#2c3550" : "#242733";
      ctx.fill();
      // the round button
      ctx.beginPath();
      ctx.arc(44, y + 26, 18, 0, Math.PI * 2);
      ctx.fillStyle = here ? "#ffd166" : hot ? "#7cf0a0" : "#3a3f52";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = here || hot ? "#ffffff" : "#596078";
      ctx.stroke();
      ctx.fillStyle = here || hot ? "#1b1d26" : "#e9eef7";
      ctx.font = "800 16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(f.number), 44, y + 32);
      ctx.textAlign = "left";
      ctx.fillStyle = here ? "#ffd166" : "#e9eef7";
      ctx.font = "700 17px system-ui, sans-serif";
      ctx.fillText(f.title.length > 15 ? `${f.title.slice(0, 14)}…` : f.title, 72, y + 32);
    });
    if (!this.floors.length) {
      ctx.fillStyle = "#8f98ad";
      ctx.font = "500 16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No floors yet", 128, 140);
      ctx.textAlign = "left";
    }
    texture.needsUpdate = true;
  }

  private drawIndicator(n: number, dir: number) {
    const { ctx, texture } = this.indicator;
    ctx.fillStyle = "#0d0e14";
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = "#ff8a3d";
    ctx.font = "800 40px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${dir > 0 ? "▲" : dir < 0 ? "▼" : " "} ${n ? `${n}F` : "--"}`, 128, 47);
    texture.needsUpdate = true;
  }

  private drawDirectory() {
    const { ctx, texture } = this.directory;
    ctx.clearRect(0, 0, 512, 336);
    roundRect(ctx, 4, 4, 504, 328, 22);
    ctx.fillStyle = "rgba(24, 26, 36, 0.94)";
    ctx.fill();
    ctx.fillStyle = "#e9eef7";
    ctx.font = "800 34px system-ui, sans-serif";
    ctx.fillText("⇅ ELEVATORS", 28, 54);
    ctx.fillStyle = "#8f98ad";
    ctx.font = "500 19px system-ui, sans-serif";
    ctx.fillText("Walk in, then press a floor", 28, 84);
    const list = this.floors.slice(0, 5);
    list.forEach((f, i) => {
      const y = 126 + i * 40;
      const here = f.id === this.current;
      ctx.fillStyle = here ? "#ffd166" : "#7cf0a0";
      ctx.font = "800 24px ui-monospace, monospace";
      ctx.fillText(`${f.number}F`, 28, y);
      ctx.fillStyle = here ? "#ffd166" : "#e9eef7";
      ctx.font = "600 22px system-ui, sans-serif";
      const t = f.title.length > 22 ? `${f.title.slice(0, 21)}…` : f.title;
      ctx.fillText(here ? `${t}  · you are here` : t, 100, y);
    });
    if (this.floors.length > 5) {
      ctx.fillStyle = "#8f98ad";
      ctx.font = "500 18px system-ui, sans-serif";
      ctx.fillText(`+${this.floors.length - 5} more`, 100, 126 + 5 * 40);
    }
    texture.needsUpdate = true;
  }
}
