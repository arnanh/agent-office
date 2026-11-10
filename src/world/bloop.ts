// "Bloops": the little round office workers. Each one is a squishy gumdrop with big
// eyes, a status antenna and a hat, animated procedurally (no assets needed).

import * as THREE from "three";
import type { Activity } from "../../shared/types.ts";
import type { Seat } from "./layout.ts";
import { flat, hashString, mesh, toon, toonUnique } from "./toon.ts";

export const ACTIVITY_COLORS: Record<Activity, string> = {
  working: "#4aa3ff",
  "needs-input": "#ffc531",
  done: "#3ddc84",
  error: "#ff5d5d",
  idle: "#b9bccb",
};

import { bloopName } from "../../shared/names.ts";
export { bloopName };

const HATS = ["none", "beanie", "sprout", "bow", "tophat", "headphones", "cap", "party"] as const;
type Hat = (typeof HATS)[number] | "crown" | "visor";

export function bloopColor(id: string) {
  const h = hashString(id) % 360;
  return new THREE.Color().setHSL(h / 360, 0.62, 0.64);
}

// Shared geometries
const GEO = {
  body: new THREE.SphereGeometry(0.32, 24, 18),
  eye: new THREE.SphereGeometry(0.085, 14, 10),
  pupil: new THREE.SphereGeometry(0.052, 12, 8),
  glint: new THREE.SphereGeometry(0.02, 6, 4),
  cheek: new THREE.SphereGeometry(0.045, 10, 6),
  mouth: new THREE.TorusGeometry(0.045, 0.013, 6, 14, Math.PI),
  mouthO: new THREE.TorusGeometry(0.03, 0.012, 6, 14),
  antenna: new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6),
  bulb: new THREE.SphereGeometry(0.052, 12, 8),
  arm: new THREE.CapsuleGeometry(0.055, 0.12, 4, 8),
  foot: new THREE.SphereGeometry(0.085, 10, 8),
  box: new THREE.BoxGeometry(0.46, 0.3, 0.34),
  boxFlap: new THREE.BoxGeometry(0.46, 0.02, 0.16),
  paper: new THREE.BoxGeometry(0.22, 0.24, 0.02),
  leaf: new THREE.IcosahedronGeometry(0.08, 0),
};

const BODY_Y = 0.42;
const GLOSSY = { rough: 0.16, f0: 0.05 };
/** Height of the bottom of the body above the root (feet level). */
const BODY_BOTTOM = BODY_Y - 0.32 * 1.08;
/** Default seat-cushion height when a seat doesn't say. */
const DEFAULT_SEAT_TOP = 0.5;
/** How far the body sinks into a cushion. */
const CUSHION_SINK = 0.025;
/** Seated bodies scoot forward so they sit in the seat instead of inside the backrest. */
const SIT_FORWARD = 0.07;

interface Hop {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromY: number;
  toY: number;
  /** Yaw held during the jump (turned to first, during `turn`). */
  yaw: number;
  arc: number;
  turn: number;
  dur: number;
  t: number;
  /** true = getting into the seat, false = getting out. */
  mount: boolean;
  then: (() => void) | null;
}

export interface BloopOptions {
  id: string;
  color?: THREE.ColorRepresentation;
  hat?: Hat;
  scale?: number;
}

type Mode = "stand" | "walk" | "sit" | "hop";

export class Bloop {
  readonly id: string;
  readonly root = new THREE.Group();
  readonly name: string;
  activity: Activity = "idle";
  mode: Mode = "stand";
  /** Set while the agent is somewhere other than its desk (meeting, break, leaving...). */
  errand: string | null = null;
  carrying = false;
  inMeeting = false;
  removeWhenArrived = false;
  /** Index of the break spot this agent is using, if any. */
  hangout?: number;

  private pivot = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private footL: THREE.Mesh;
  private footR: THREE.Mesh;
  private eyes: THREE.Group[] = [];
  private mouth: THREE.Mesh;
  private mouthO: THREE.Mesh;
  private bulb: THREE.Mesh;
  private bulbMat: THREE.MeshBasicMaterial;
  private body: THREE.Mesh;
  private antenna = new THREE.Group();
  private boxGroup = new THREE.Group();
  private path: THREE.Vector3[] = [];
  private onArrive: (() => void) | null = null;
  targetYaw = 0;
  private phase = Math.random() * 10;
  private blinkTimer = 2 + Math.random() * 3;
  private hopTimer = 0;
  private lookTimer = 4 + Math.random() * 6;
  private lookYaw = 0;
  private seatFacingYaw = 0;
  /** 0 = standing pose, 1 = seated pose (blended during hops). */
  private sitPose = 0;
  private hop: Hop | null = null;
  /** Where we hopped into the current seat from (we hop back out the same way). */
  private seatExit: THREE.Vector3 | null = null;
  private landSquish = 0;
  private attention: THREE.Vector3 | null = null;
  private attentionHold = 0;
  /** The seat this agent is sitting in (or hopping into / out of). */
  seat: Seat | null = null;
  /** Called when the agent lands in a seat. */
  onLanded: ((seat: Seat) => void) | null = null;
  speed = 2.1;

  constructor(opts: BloopOptions) {
    this.id = opts.id;
    this.name = bloopName(opts.id);
    const color = new THREE.Color(opts.color ?? bloopColor(opts.id));
    const bodyMat = toonUnique(color);
    const bellyMat = toon(color.clone().lerp(new THREE.Color("#ffffff"), 0.45));
    const hat: Hat = opts.hat ?? HATS[hashString(opts.id + "hat") % HATS.length];

    this.root.add(this.pivot);
    this.pivot.position.y = 0;

    const body = mesh(GEO.body, bodyMat, { pos: [0, BODY_Y, 0] });
    body.scale.set(1, 1.08, 0.95);
    body.userData.rt = GLOSSY; // candy-coated vinyl toys in the ray tracer
    this.body = body;
    this.pivot.add(body);
    const belly = mesh(GEO.body, bellyMat, { pos: [0, BODY_Y - 0.08, 0.13], shadow: false });
    belly.userData.rt = GLOSSY;
    belly.scale.set(0.62, 0.58, 0.6);
    this.pivot.add(belly);

    // Face
    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(side * 0.115, BODY_Y + 0.08, 0.255);
      const white = mesh(GEO.eye, toon("#ffffff"), { shadow: false });
      white.userData.rt = { rough: 0.05, f0: 0.06 };
      eye.add(white);
      const pupil = mesh(GEO.pupil, flat("#262838"), { pos: [0, 0, 0.05], shadow: false });
      eye.add(pupil);
      eye.add(mesh(GEO.glint, flat("#ffffff"), { pos: [-0.018, 0.025, 0.098], shadow: false }));
      this.pivot.add(eye);
      this.eyes.push(eye);
      const cheek = mesh(GEO.cheek, flat("#ff9aa8"), { pos: [side * 0.2, BODY_Y - 0.01, 0.245], shadow: false });
      cheek.scale.set(1, 0.55, 0.3);
      this.pivot.add(cheek);
    }
    this.mouth = mesh(GEO.mouth, flat("#262838"), { pos: [0, BODY_Y - 0.03, 0.3], rot: [0, 0, Math.PI], shadow: false });
    this.pivot.add(this.mouth);
    this.mouthO = mesh(GEO.mouthO, flat("#262838"), { pos: [0, BODY_Y - 0.05, 0.3], shadow: false });
    this.mouthO.visible = false;
    this.pivot.add(this.mouthO);

    // Antenna
    this.antenna.position.set(0, BODY_Y + 0.32, 0);
    this.antenna.add(mesh(GEO.antenna, toon("#55576a"), { pos: [0, 0.1, 0], shadow: false }));
    this.bulbMat = new THREE.MeshBasicMaterial({ color: ACTIVITY_COLORS.idle });
    this.bulb = mesh(GEO.bulb, this.bulbMat, { pos: [0, 0.22, 0], shadow: false });
    this.bulb.userData.rt = { emissive: 4, group: 5 }; // a real light in the ray tracer (renderer.ts adds it)
    this.antenna.add(this.bulb);
    this.pivot.add(this.antenna);

    // Arms
    for (const [arm, side] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(side * 0.29, BODY_Y - 0.02, 0);
      const m = mesh(GEO.arm, bodyMat, { pos: [0, -0.1, 0] });
      arm.add(m);
      arm.rotation.z = side * 0.25;
      this.pivot.add(arm);
    }

    // Feet stay with the root so they can step.
    this.footL = mesh(GEO.foot, toon(color.clone().multiplyScalar(0.75)), { pos: [-0.12, 0.05, 0.04] });
    this.footR = mesh(GEO.foot, toon(color.clone().multiplyScalar(0.75)), { pos: [0.12, 0.05, 0.04] });
    for (const f of [this.footL, this.footR]) {
      f.scale.set(1, 0.6, 1.3);
      this.root.add(f);
    }

    this.buildHat(hat, color);
    this.buildBox();

    this.root.scale.setScalar(opts.scale ?? 1);
    this.root.userData.bloop = this;
    this.root.traverse((o) => (o.userData.bloop = this));
  }

  private buildHat(hat: Hat, color: THREE.Color) {
    const top = BODY_Y + 0.33;
    const g = new THREE.Group();
    g.position.y = top;
    const accent = toon(new THREE.Color().setHSL((color.getHSL({ h: 0, s: 0, l: 0 }).h + 0.45) % 1, 0.6, 0.6));
    switch (hat) {
      case "beanie": {
        const m = mesh(new THREE.SphereGeometry(0.25, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), accent, { pos: [0, -0.1, 0] });
        g.add(m);
        g.add(mesh(new THREE.SphereGeometry(0.06, 8, 6), toon("#ffffff"), { pos: [0, 0.16, 0] }));
        this.antenna.visible = true;
        this.antenna.position.x = 0.12;
        break;
      }
      case "sprout": {
        g.add(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.12, 5), toon("#5fb86a"), { pos: [-0.1, 0.0, 0] }));
        const l1 = mesh(GEO.leaf, toon("#6cc777"), { pos: [-0.15, 0.07, 0] });
        l1.scale.set(1.2, 0.5, 0.8);
        const l2 = mesh(GEO.leaf, toon("#5fb86a"), { pos: [-0.05, 0.08, 0] });
        l2.scale.set(1.2, 0.5, 0.8);
        g.add(l1, l2);
        break;
      }
      case "bow": {
        const m = toon("#ff6f91");
        const a = mesh(new THREE.ConeGeometry(0.07, 0.12, 8), m, { pos: [0.1, -0.02, 0.05], rot: [0, 0, Math.PI / 2] });
        const b = mesh(new THREE.ConeGeometry(0.07, 0.12, 8), m, { pos: [0.22, -0.02, 0.05], rot: [0, 0, -Math.PI / 2] });
        g.add(a, b, mesh(new THREE.SphereGeometry(0.035, 8, 6), m, { pos: [0.16, -0.02, 0.05] }));
        break;
      }
      case "tophat": {
        g.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 18), toon("#2e3040"), { pos: [0, -0.04, 0] }));
        g.add(mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.2, 18), toon("#2e3040"), { pos: [0, 0.06, 0] }));
        g.add(mesh(new THREE.CylinderGeometry(0.133, 0.133, 0.04, 18), toon("#e05a5a"), { pos: [0, -0.01, 0] }));
        this.antenna.position.x = -0.2;
        break;
      }
      case "headphones": {
        const band = mesh(new THREE.TorusGeometry(0.3, 0.025, 6, 20, Math.PI), toon("#3a3c4e"), { pos: [0, -0.2, 0] });
        g.add(band);
        for (const s of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.07, 12), accent, { pos: [s * 0.3, -0.22, 0], rot: [0, 0, Math.PI / 2] }));
        break;
      }
      case "cap": {
        g.add(mesh(new THREE.SphereGeometry(0.24, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), accent, { pos: [0, -0.1, 0] }));
        g.add(mesh(new THREE.BoxGeometry(0.26, 0.02, 0.2), accent, { pos: [0, -0.08, 0.25] }));
        this.antenna.position.x = 0.12;
        break;
      }
      case "party": {
        g.add(mesh(new THREE.ConeGeometry(0.11, 0.28, 12), accent, { pos: [0.08, 0.06, 0], rot: [0, 0, -0.25] }));
        g.add(mesh(new THREE.SphereGeometry(0.035, 8, 6), toon("#ffd36b"), { pos: [0.12, 0.21, 0] }));
        this.antenna.position.x = -0.12;
        break;
      }
      case "crown": {
        const gold = toon("#ffcc33");
        g.add(mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.08, 10, 1, true), gold, { pos: [0, 0.0, 0] }));
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          g.add(mesh(new THREE.ConeGeometry(0.035, 0.09, 6), gold, { pos: [Math.cos(a) * 0.13, 0.08, Math.sin(a) * 0.13] }));
        }
        this.antenna.visible = false;
        break;
      }
      case "visor": {
        g.add(mesh(new THREE.TorusGeometry(0.26, 0.03, 6, 20), accent, { pos: [0, -0.12, 0], rot: [Math.PI / 2, 0, 0] }));
        break;
      }
      default:
        break;
    }
    this.pivot.add(g);
  }

  private buildBox() {
    const brown = toon("#c8955c");
    this.boxGroup.add(mesh(GEO.box, brown, { pos: [0, 0, 0] }));
    const flapL = mesh(GEO.boxFlap, toon("#b9844d"), { pos: [0, 0.16, -0.12], rot: [-0.6, 0, 0] });
    const flapR = mesh(GEO.boxFlap, toon("#b9844d"), { pos: [0, 0.16, 0.12], rot: [0.6, 0, 0] });
    this.boxGroup.add(flapL, flapR);
    this.boxGroup.add(mesh(GEO.paper, toon("#ffffff"), { pos: [-0.08, 0.2, 0], rot: [0, 0, 0.15] }));
    this.boxGroup.add(mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.08, 8), toon("#d9825b"), { pos: [0.12, 0.17, 0.02] }));
    this.boxGroup.add(mesh(GEO.leaf, toon("#5fb86a"), { pos: [0.12, 0.26, 0.02] }));
    this.boxGroup.add(mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.08, 10), toon("#8fd3ff"), { pos: [0.02, 0.18, -0.08] }));
    this.boxGroup.position.set(0, BODY_Y + 0.02, 0.36);
    this.boxGroup.visible = false;
    this.pivot.add(this.boxGroup);
  }

  // ---------------------------------------------------------------- control

  setActivity(activity: Activity) {
    if (activity === this.activity) return;
    const prev = this.activity;
    this.activity = activity;
    this.bulbMat.color.set(ACTIVITY_COLORS[activity]);
    if (activity === "done" && prev !== "done") this.hopTimer = 1.2;
  }

  get position() {
    return this.root.position;
  }

  /** Teleport to a seat and sit down. */
  sitAt(seat: Seat) {
    this.root.position.copy(seat.pos).setY(this.seatHeight(seat));
    this.seatFacingYaw = Math.atan2(seat.facing.x, seat.facing.z);
    this.root.rotation.y = this.targetYaw = this.seatFacingYaw;
    this.path = [];
    this.hop = null;
    this.seat = seat;
    this.seatExit = seat.approaches?.[0]?.clone() ?? null;
    this.mode = "sit";
    this.sitPose = 1;
  }

  placeStanding(pos: THREE.Vector3, yaw = 0) {
    this.root.position.copy(pos).setY(0);
    this.root.rotation.y = this.targetYaw = yaw;
    this.mode = "stand";
    this.hop = null;
    this.seat = null;
    this.sitPose = 0;
  }

  walk(path: THREE.Vector3[], onArrive?: () => void) {
    // Mid-hop: finish the hop, then go.
    if (this.hop) {
      this.hop.then = () => this.walk(path, onArrive);
      return;
    }
    // Seated: hop out of the chair first (the way we came in), then walk.
    if (this.mode === "sit" && this.seat) {
      const seat = this.seat;
      const exit = this.seatExit ?? seat.pos.clone().addScaledVector(seat.facing, -0.6);
      const out = new THREE.Vector3(exit.x - seat.pos.x, 0, exit.z - seat.pos.z);
      // Drop the leading path points that would lead back into the chair.
      const away = out.length() + 0.15;
      const rest = path.map((p) => p.clone());
      while (rest.length > 1 && Math.hypot(rest[0].x - seat.pos.x, rest[0].z - seat.pos.z) < away) rest.shift();
      this.startHop({
        to: exit,
        toY: 0,
        yaw: Math.atan2(out.x, out.z),
        arc: 0.12,
        turn: 0.3,
        dur: 0.36,
        mount: false,
        then: () => {
          this.seat = null;
          this.walk(rest, onArrive);
        },
      });
      return;
    }
    this.path = path.map((p) => p.clone().setY(0));
    this.onArrive = onArrive ?? null;
    this.mode = path.length ? "walk" : "stand";
    if (!path.length) {
      this.onArrive = null;
      onArrive?.();
    }
  }

  /**
   * Walk a path and sit in `seat`. The path should end beside the seat (one of
   * `seat.approaches`); the agent turns its back to the seat and hops up into it.
   */
  walkToSeat(path: THREE.Vector3[], seat: Seat, then?: () => void) {
    this.walk(path, () => this.hopInto(seat, then));
  }

  private hopInto(seat: Seat, then?: () => void) {
    const pos = this.root.position;
    const toward = new THREE.Vector3(seat.pos.x - pos.x, 0, seat.pos.z - pos.z);
    const dist = toward.length();
    this.seat = seat;
    this.seatFacingYaw = Math.atan2(seat.facing.x, seat.facing.z);
    this.seatExit = dist > 0.2 ? pos.clone().setY(0) : null;
    // Coming from behind the seat: vault over the backrest facing forward.
    // Otherwise: turn around, back up to the seat and hop in (then swivel to face forward).
    const fromBehind = dist > 0.2 && toward.clone().normalize().dot(seat.facing) > 0.5;
    const yaw = dist < 0.2 || fromBehind ? this.seatFacingYaw : Math.atan2(-toward.x, -toward.z);
    this.startHop({
      to: seat.pos.clone(),
      toY: this.seatHeight(seat),
      yaw,
      arc: fromBehind ? 0.55 : 0.2,
      turn: 0.3,
      dur: fromBehind ? 0.55 : 0.42,
      mount: true,
      then: then ?? null,
    });
  }

  private startHop(h: Omit<Hop, "from" | "fromY" | "t">) {
    this.path = [];
    this.onArrive = null;
    this.hop = { ...h, from: this.root.position.clone(), fromY: this.root.position.y, t: 0 };
    this.mode = "hop";
  }

  /** Root height that puts the bottom of the body on the seat cushion. */
  private seatHeight(seat: Seat) {
    const top = seat.height ?? DEFAULT_SEAT_TOP;
    return Math.max(0, top - BODY_BOTTOM * this.root.scale.y - CUSHION_SINK);
  }

  /** Swivel to look at `point` (call every frame while it applies; lapses shortly after). */
  attend(point: THREE.Vector3) {
    (this.attention ??= new THREE.Vector3()).copy(point);
    this.attentionHold = 0.8;
  }

  /**
   * Yaw the chair under this agent should have, or null when the agent isn't in (or getting
   * into / out of) its seat. Chairs turn with whoever sits in them.
   */
  get chairYaw(): number | null {
    if (this.mode === "sit") return this.root.rotation.y;
    if (this.mode === "hop" && this.hop) {
      const h = this.hop;
      // Getting in: the chair turns to meet us. Getting out: it turns with us until we jump.
      if (h.mount || h.t < h.turn) return this.root.rotation.y;
    }
    return null;
  }

  setCarrying(on: boolean) {
    this.carrying = on;
    this.boxGroup.visible = on;
  }

  get isWalking() {
    return this.mode === "walk";
  }

  // ---------------------------------------------------------------- animation

  update(dt: number, time: number) {
    this.phase += dt;
    const p = this.pivot;

    // Movement
    if (this.mode === "walk" && this.path.length) {
      const target = this.path[0];
      const pos = this.root.position;
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (dist <= step) {
        pos.x = target.x;
        pos.z = target.z;
        this.path.shift();
        if (!this.path.length) {
          this.mode = "stand";
          const cb = this.onArrive;
          this.onArrive = null;
          cb?.();
        }
      } else {
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        this.targetYaw = Math.atan2(dx, dz);
      }
    }

    // Hopping into / out of a seat: turn first, then jump along an arc.
    let hopK = -1;
    if (this.mode === "hop" && this.hop) {
      const h = this.hop;
      h.t += dt;
      const pos = this.root.position;
      if (h.t < h.turn) {
        this.targetYaw = h.yaw;
      } else {
        const k = Math.min(1, (h.t - h.turn) / h.dur);
        hopK = k;
        const e = k * k * (3 - 2 * k);
        pos.x = THREE.MathUtils.lerp(h.from.x, h.to.x, e);
        pos.z = THREE.MathUtils.lerp(h.from.z, h.to.z, e);
        pos.y = THREE.MathUtils.lerp(h.fromY, h.toY, e) + Math.sin(Math.PI * k) * h.arc;
        if (k >= 1) {
          this.hop = null;
          if (h.mount) {
            this.mode = "sit";
            this.targetYaw = this.seatFacingYaw;
            this.landSquish = 1;
            if (this.seat) this.onLanded?.(this.seat);
          } else {
            this.mode = "stand";
          }
          h.then?.();
        }
      }
    }

    // Attention lapses unless renewed.
    if (this.attention) {
      this.attentionHold -= dt;
      if (this.attentionHold <= 0) this.attention = null;
    }

    // Turn. Seated agents swivel (with their chair) toward whatever has their attention.
    let want = this.targetYaw;
    let rate = 10;
    if (this.mode === "sit") {
      rate = 5;
      if (this.attention) {
        want = Math.atan2(this.attention.x - this.root.position.x, this.attention.z - this.root.position.z);
        this.lookYaw = 0;
      } else {
        want = this.seatFacingYaw + this.lookYaw;
      }
    } else if (this.mode === "hop") {
      rate = 14;
    }
    let dy = want - this.root.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.root.rotation.y += dy * Math.min(1, dt * rate);
    /** How far the agent has swivelled away from its desk (radians). */
    const offDesk = this.mode === "sit" ? Math.abs(Math.atan2(Math.sin(this.root.rotation.y - this.seatFacingYaw), Math.cos(this.root.rotation.y - this.seatFacingYaw))) : 0;

    // Seated pose blend
    if (this.mode === "sit") this.sitPose = 1;
    else if (this.mode === "hop" && this.hop) this.sitPose = hopK < 0 ? (this.hop.mount ? 0 : 1) : this.hop.mount ? hopK : 1 - hopK;
    else this.sitPose = 0;
    if (this.mode !== "hop" && this.mode !== "sit") this.root.position.y = 0;

    // Reset pose
    p.position.set(0, 0, 0);
    p.rotation.set(0, 0, 0);
    p.scale.set(1, 1, 1);
    this.armL.rotation.set(0, 0, -0.25);
    this.armR.rotation.set(0, 0, 0.25);
    this.footL.position.set(-0.12, 0.05, 0.04);
    this.footR.position.set(0.12, 0.05, 0.04);
    this.footL.rotation.set(0, 0, 0);
    this.footR.rotation.set(0, 0, 0);
    this.antenna.rotation.set(0, 0, 0);
    this.mouth.visible = true;
    this.mouthO.visible = false;

    const t = this.phase;
    if (this.mode === "walk") {
      const w = t * 11;
      p.position.y = Math.abs(Math.sin(w)) * 0.07;
      p.rotation.z = Math.sin(w) * 0.09;
      this.footL.position.z = 0.04 + Math.sin(w) * 0.1;
      this.footR.position.z = 0.04 - Math.sin(w) * 0.1;
      this.footL.position.y = 0.05 + Math.max(0, Math.sin(w)) * 0.05;
      this.footR.position.y = 0.05 + Math.max(0, -Math.sin(w)) * 0.05;
      if (this.carrying) {
        this.armL.rotation.set(-1.35, 0, -0.35);
        this.armR.rotation.set(-1.35, 0, 0.35);
      } else {
        this.armL.rotation.x = Math.sin(w) * 0.6;
        this.armR.rotation.x = -Math.sin(w) * 0.6;
      }
      this.antenna.rotation.z = Math.sin(w) * 0.25;
    } else {
      // breathing
      const breathe = Math.sin(t * 2.2) * 0.02;
      p.scale.set(1 - breathe * 0.5, 1 + breathe, 1 - breathe * 0.5);
      if (this.sitPose > 0) this.poseSeated(t, dt, offDesk);
      if (this.mode === "hop") {
        // tuck in mid-air
        this.armL.rotation.set(0, 0, -0.9 * Math.sin(Math.PI * Math.max(0, hopK)));
        this.armR.rotation.set(0, 0, 0.9 * Math.sin(Math.PI * Math.max(0, hopK)));
      } else if (this.carrying) {
        this.armL.rotation.set(-1.35, 0, -0.35);
        this.armR.rotation.set(-1.35, 0, 0.35);
      } else if (this.mode === "sit" && !this.inMeeting) {
        this.animateSeated(t, dt, offDesk);
      } else if (this.inMeeting) {
        if (this.activity === "working") {
          // gesturing while talking
          this.armR.rotation.set(-0.8 + Math.sin(t * 5) * 0.3, 0, 0.5);
          this.mouth.visible = Math.sin(t * 12) > 0;
          this.mouthO.visible = !this.mouth.visible;
        }
      }
    }

    // Done: happy hops
    if (this.hopTimer > 0) {
      this.hopTimer -= dt;
      const k = Math.abs(Math.sin(this.hopTimer * 8));
      p.position.y += k * 0.14;
      this.armL.rotation.set(0, 0, -2.4);
      this.armR.rotation.set(0, 0, 2.4);
    }

    // Blink
    this.blinkTimer -= dt;
    const blink = this.blinkTimer < 0.12;
    if (this.blinkTimer < 0) this.blinkTimer = 2.5 + Math.random() * 3.5;
    for (const e of this.eyes) e.scale.y = blink ? 0.12 : 1;

    // Antenna bulb pulse for attention states
    if (this.activity === "needs-input" || this.activity === "error") {
      const s = 1 + Math.abs(Math.sin(time * 5)) * 0.5;
      this.bulb.scale.setScalar(s);
      this.antenna.rotation.z += Math.sin(time * 9) * 0.15;
    } else if (this.activity === "working") {
      this.bulb.scale.setScalar(Math.sin(time * 10) > 0 ? 1.15 : 0.9);
    } else {
      this.bulb.scale.setScalar(1);
    }
  }

  /** Body scooted into the seat, little legs dangling off the front of the cushion. */
  private poseSeated(t: number, dt: number, offDesk: number) {
    const s = this.sitPose;
    this.pivot.position.z += SIT_FORWARD * s;
    // Plop: squash on landing, then settle.
    if (this.landSquish > 0) {
      this.landSquish = Math.max(0, this.landSquish - dt * 3.5);
      const q = Math.sin(this.landSquish * Math.PI) * this.landSquish;
      this.pivot.scale.multiply(new THREE.Vector3(1 + q * 0.1, 1 - q * 0.14, 1 + q * 0.1));
    }
    // Feet hang just under the front edge of the seat (root sits at cushion level).
    const swing = this.activity === "idle" || this.activity === "done" || offDesk > 0.6 ? 0.25 : 0.06;
    const speed = this.activity === "working" && offDesk < 0.6 ? 6 : 3;
    for (const [foot, side, ph] of [[this.footL, -1, 0], [this.footR, 1, Math.PI]] as const) {
      const k = Math.sin(t * speed + ph);
      const sx = side * 0.13;
      const sy = -0.01 + Math.max(0, k) * 0.02;
      const sz = SIT_FORWARD + 0.27 + k * 0.03 * (swing / 0.25);
      foot.position.set(
        THREE.MathUtils.lerp(foot.position.x, sx, s),
        THREE.MathUtils.lerp(foot.position.y, sy, s),
        THREE.MathUtils.lerp(foot.position.z, sz, s),
      );
      foot.rotation.x = s * (0.55 + k * swing);
    }
  }

  private animateSeated(t: number, dt: number, offDesk: number) {
    const a = this.activity;
    if (offDesk > 0.6 && (a === "working" || a === "idle")) {
      // Turned around to chat: hands in the lap, a little head-tilt and a smile.
      this.armL.rotation.set(-0.55, 0, -0.12);
      this.armR.rotation.set(-0.55, 0, 0.12);
      this.pivot.rotation.z = Math.sin(t * 1.6) * 0.04;
      this.pivot.rotation.x = -0.04;
      return;
    }
    if (a === "working") {
      // typing!
      const k = t * 16;
      this.armL.rotation.set(-1.15 + Math.sin(k) * 0.18, 0, -0.15);
      this.armR.rotation.set(-1.15 + Math.sin(k + Math.PI) * 0.18, 0, 0.15);
      this.pivot.position.y += Math.abs(Math.sin(k * 0.5)) * 0.008;
      this.pivot.rotation.x = 0.08;
      this.lookYaw *= 0.9;
    } else if (a === "needs-input") {
      // raised hand, waving
      this.armR.rotation.set(0, 0, 2.6 + Math.sin(t * 7) * 0.25);
      this.mouth.visible = false;
      this.mouthO.visible = true;
      this.pivot.rotation.z = Math.sin(t * 2) * 0.05;
      this.lookYaw = Math.sin(t * 0.8) * 0.5;
    } else if (a === "error") {
      // flustered shake
      this.pivot.rotation.z = Math.sin(t * 25) * 0.04;
      this.armL.rotation.set(-0.3, 0, -1.6);
      this.armR.rotation.set(-0.3, 0, 1.6);
      this.mouth.visible = false;
      this.mouthO.visible = true;
    } else if (a === "done") {
      this.armL.rotation.set(0, 0, -0.9 - Math.abs(Math.sin(t * 3)) * 0.4);
      this.armR.rotation.set(0, 0, 0.9 + Math.abs(Math.sin(t * 3)) * 0.4);
      this.pivot.position.y += Math.abs(Math.sin(t * 3)) * 0.03;
    } else {
      // idle: lean back and look around now and then
      this.pivot.rotation.x = -0.1;
      this.lookTimer -= dt;
      if (this.lookTimer < 0) {
        this.lookTimer = 3 + Math.random() * 6;
        this.lookYaw = (Math.random() - 0.5) * 1.2;
      }
    }
  }

  /** World position for UI bubbles. */
  headWorld(out: THREE.Vector3) {
    return out.copy(this.root.position).setY(this.root.position.y + (BODY_Y + 0.75) * this.root.scale.y);
  }

  dispose() {
    this.root.removeFromParent();
  }

  /** For the ray tracer: the body as a sphere and the status bulb, in world space. */
  rtProbe(out: { body: THREE.Vector3; radius: number; color: THREE.Color; rough: number; bulb: THREE.Vector3; bulbOn: boolean; bulbColor: THREE.Color }) {
    this.body.getWorldPosition(out.body);
    out.radius = 0.32 * this.root.scale.x;
    out.color.copy((this.body.material as THREE.MeshToonMaterial).color);
    out.rough = GLOSSY.rough;
    this.bulb.getWorldPosition(out.bulb);
    out.bulbOn = this.antenna.visible && this.bulb.visible;
    out.bulbColor.copy(this.bulbMat.color);
  }
}
