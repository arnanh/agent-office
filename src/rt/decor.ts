// Set dressing that shows off the ray tracer: synthwave neon (ceiling cove along the glazing,
// underglow beneath the desk benches), and a mirror-chrome sculpture in the lobby.
// Every neon strip is a real area light: it casts ray-traced soft shadows and shows up in reflections.
// It's only there while ray tracing is on, so the original look is unchanged.

import * as THREE from "three";
import * as plan from "../world/floorplan.ts";
import type { Office } from "../world/office.ts";
import { GROUP } from "./materials.ts";

const CYAN = "#29e7ff";
const PINK = "#ff2fa8";
const SEGMENT = 3;

function neonMaterial(color: string, strength: number) {
  const m = new THREE.MeshBasicMaterial({ color, toneMapped: false, side: THREE.DoubleSide });
  m.userData.rt = { emissive: strength, group: GROUP.neon, light: true };
  return m;
}

/** A thin emitting strip from a to b (xz), at height y, facing `normal`, split into short lights. */
function strip(parent: THREE.Object3D, mat: THREE.Material, a: [number, number], b: [number, number], y: number, width: number, normal: THREE.Vector3, out: THREE.Object3D[]) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.round(len / SEGMENT));
  const dir = new THREE.Vector3(b[0] - a[0], 0, b[1] - a[1]).normalize();
  for (let i = 0; i < n; i++) {
    const s0 = (i / n) * len;
    const s1 = ((i + 1) / n) * len;
    const geo = new THREE.PlaneGeometry(s1 - s0 - 0.02, width);
    const m = new THREE.Mesh(geo, mat);
    // Plane: x along the strip, normal along +z, then turned to face `normal`.
    const basis = new THREE.Matrix4().makeBasis(dir, new THREE.Vector3().crossVectors(normal, dir), normal);
    m.quaternion.setFromRotationMatrix(basis);
    const mid = (s0 + s1) / 2;
    m.position.set(a[0] + dir.x * mid, y, a[1] + dir.z * mid);
    m.castShadow = false;
    m.receiveShadow = false;
    parent.add(m);
    out.push(m);
  }
}

export interface RaytracedDecor {
  setVisible(on: boolean): void;
}

export function addRaytracedDecor(office: Office): RaytracedDecor {
  const added: THREE.Object3D[] = [];
  const P = plan.PLATE;
  const H = plan.CEILING_HEIGHT;
  const down = new THREE.Vector3(0, -1, 0);
  // In the overview cutaway the ceiling is hidden, but its lights keep lighting the office.
  office.ceiling.userData.rtKeepLights = true;

  // Ceiling cove along the curtain wall, washing the glass and mullions with cyan.
  const cove = neonMaterial(CYAN, 7);
  const inset = plan.EXTERIOR_WALL / 2 + 0.22;
  const x0 = P.minX + inset, x1 = P.maxX - inset, z0 = P.minZ + inset, z1 = P.maxZ - inset;
  strip(office.ceiling, cove, [x0, z0], [x1, z0], H - 0.04, 0.07, down, added);
  strip(office.ceiling, cove, [x1, z0], [x1, z1], H - 0.04, 0.07, down, added);
  strip(office.ceiling, cove, [x1, z1], [x0, z1], H - 0.04, 0.07, down, added);
  strip(office.ceiling, cove, [x0, z1], [x0, z0], H - 0.04, 0.07, down, added);

  // Underglow beneath every desk bench: pink pools on the polished floor.
  const under = neonMaterial(PINK, 9);
  const zs = plan.BENCH_DESK_Z;
  const za = Math.min(...zs) - plan.DESK_W / 2 + 0.15;
  const zb = Math.max(...zs) + plan.DESK_W / 2 - 0.15;
  for (const cx of plan.BENCH_CENTERS_X) strip(office.root, under, [cx, za], [cx, zb], 0.66, 0.05, down, added);

  // Lobby sculpture: a mirror-chrome sphere on a black glass plinth, ringed by a cyan floor light.
  const sx = -1.6, sz = 6.3;
  const plinthMat = new THREE.MeshToonMaterial({ color: "#121218" });
  plinthMat.userData.rt = { rough: 0.05, f0: 0.06 };
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.78, 0.62), plinthMat);
  plinth.position.set(sx, 0.39, sz);
  const chromeMat = new THREE.MeshToonMaterial({ color: "#eef1f6" });
  chromeMat.userData.rt = { metal: 1, rough: 0.015, color: "#f4f6fa" };
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.42, 96, 64), chromeMat);
  sphere.position.set(sx, 0.78 + 0.42, sz);
  const ringMat = neonMaterial(CYAN, 6);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.56, 48), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(sx, 0.006, sz);
  office.root.add(plinth, sphere, ring);
  added.push(plinth, sphere, ring);
  // You bump into the sculpture only while it's there. (Agents' paths always step round the spot.)
  const collider = { minX: sx - 0.36, maxX: sx + 0.36, minZ: sz - 0.36, maxZ: sz + 0.36 };
  office.colliders.push(collider);
  return {
    setVisible(on) {
      for (const o of added) o.visible = on;
      const i = office.colliders.indexOf(collider);
      if (on && i < 0) office.colliders.push(collider);
      if (!on && i >= 0) office.colliders.splice(i, 1);
    },
  };
}
