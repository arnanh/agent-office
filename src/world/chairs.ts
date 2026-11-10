// Desk chairs whose tops swivel. The base (star, casters) is static and instanced with the
// rest of the office; the top is its own InstancedMesh so each chair can turn with the agent
// sitting in it and bounce a little when someone plops down.

import * as THREE from "three";
import type { Asset } from "./assets.ts";
import type { DeskSlot } from "./layout.ts";

interface ChairState {
  pos: THREE.Vector3;
  /** Yaw when nobody is using it (front to the desk). */
  rest: number;
  yaw: number;
  /** Seat sink from a landing, springs back to 0. */
  sink: number;
  sinkVel: number;
  dirty: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/** A chair turned or sunk away from the pose the ray tracer baked it in. */
export interface MovingChair {
  /** Instance index, which is also the chair's id in the ray tracer's BVH. */
  id: number;
  /** Where the swivel axis is now (rest position plus seat sink). */
  pivot: THREE.Vector3;
  /** Yaw now, radians (the chair's own frame turned by this is world space). */
  yaw: number;
  /** Bounding sphere of the chair top, in world space. */
  center: THREE.Vector3;
  radius: number;
}

export class SwivelChairs {
  private meshes: THREE.InstancedMesh[] = [];
  private chairs: ChairState[] = [];
  private byDesk = new Map<number, number>();
  /** Each chair facing its desk. The ray tracer bakes chairs in this pose (see `moving`). */
  private readonly restMatrices: THREE.Matrix4[];
  private readonly bound = new THREE.Sphere();

  constructor(top: Asset, slots: DeskSlot[], parent: THREE.Object3D) {
    slots.forEach((slot, i) => {
      const rest = Math.atan2(slot.facing.x, slot.facing.z);
      this.chairs.push({ pos: slot.pos.clone(), rest, yaw: rest, sink: 0, sinkVel: 0, dirty: true });
      this.byDesk.set(slot.index, i);
    });
    this.restMatrices = this.chairs.map((c) => new THREE.Matrix4().compose(c.pos, new THREE.Quaternion().setFromAxisAngle(UP, c.rest), ONE));
    const box = new THREE.Box3();
    for (const part of top.parts) {
      part.geometry.computeBoundingBox();
      box.union(part.geometry.boundingBox!);
    }
    box.getBoundingSphere(this.bound);
    this.bound.radius += 0.05;
    for (const part of top.parts) {
      const inst = new THREE.InstancedMesh(part.geometry, part.material, slots.length);
      inst.userData.rtRest = this.restMatrices;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false; // instances move; the bounding sphere would go stale
      parent.add(inst);
      this.meshes.push(inst);
    }
    this.flush();
  }

  /** Little bounce when an agent lands in the chair. */
  bump(desk: number, strength = 1) {
    const c = this.get(desk);
    if (c) c.sinkVel -= 0.55 * strength;
  }

  /**
   * Advance one frame. `held` maps desk index -> yaw for chairs someone is sitting in (the chair
   * turns exactly with them); every other chair drifts back to face its desk.
   */
  update(dt: number, held: Map<number, number>) {
    for (const [desk, i] of this.byDesk) {
      const c = this.chairs[i];
      const want = held.get(desk);
      if (want !== undefined) {
        if (Math.abs(angleDiff(want, c.yaw)) > 1e-4) {
          c.yaw = want;
          c.dirty = true;
        }
      } else {
        const d = angleDiff(c.rest, c.yaw);
        if (Math.abs(d) > 1e-3) {
          c.yaw += d * Math.min(1, dt * 2.5);
          c.dirty = true;
        } else if (c.yaw !== c.rest) {
          c.yaw = c.rest;
          c.dirty = true;
        }
      }
      if (c.sink !== 0 || c.sinkVel !== 0) {
        // damped spring back to 0
        c.sinkVel += (-c.sink * 260 - c.sinkVel * 18) * dt;
        c.sink += c.sinkVel * dt;
        if (Math.abs(c.sink) < 1e-4 && Math.abs(c.sinkVel) < 1e-3) c.sink = c.sinkVel = 0;
        c.dirty = true;
      }
    }
    this.flush();
  }

  /** Chairs away from their rest pose right now, for the ray tracer. */
  moving(): MovingChair[] {
    const out: MovingChair[] = [];
    this.chairs.forEach((c, id) => {
      const delta = angleDiff(c.yaw, c.rest);
      if (Math.abs(delta) < 0.002 && Math.abs(c.sink) < 0.002) return;
      const pivot = c.pos.clone().setY(c.pos.y + c.sink);
      const center = this.bound.center.clone().applyAxisAngle(UP, c.yaw).add(pivot);
      out.push({ id, pivot, yaw: c.yaw, center, radius: this.bound.radius });
    });
    return out;
  }

  private get(desk: number) {
    const i = this.byDesk.get(desk);
    return i === undefined ? undefined : this.chairs[i];
  }

  private flush() {
    let any = false;
    this.chairs.forEach((c, i) => {
      if (!c.dirty) return;
      c.dirty = false;
      any = true;
      tmpQ.setFromAxisAngle(UP, c.yaw);
      tmpP.copy(c.pos).setY(c.pos.y + c.sink);
      tmpM.compose(tmpP, tmpQ, ONE);
      for (const m of this.meshes) m.setMatrixAt(i, tmpM);
    });
    if (any) for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }
}

function angleDiff(a: number, b: number) {
  const d = a - b;
  return Math.atan2(Math.sin(d), Math.cos(d));
}
