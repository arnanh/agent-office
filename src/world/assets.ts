// Loads the Blender-made models (public/models/*.glb), converts their materials to the
// game's toon style, and places repeated items with GPU instancing so 24 desks or chairs
// cost a handful of draw calls instead of hundreds.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { toon } from "./toon.ts";

export interface AssetPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Material name from Blender (drives runtime behavior such as accent color or screens). */
  role: string;
}

export interface Asset {
  name: string;
  parts: AssetPart[];
  /** Bounding box of the whole asset in game space (y up, front facing +z). */
  box: THREE.Box3;
}

const loader = new GLTFLoader();

function convertMaterial(src: THREE.Material, accent: THREE.Material): THREE.Material {
  const name = (src.name || "").toLowerCase();
  const color = (src as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color("#ffffff");
  if (name.startsWith("accent")) return accent;
  if (name.startsWith("screen")) return new THREE.MeshBasicMaterial({ color: "#1d2030" });
  if (name.startsWith("emissive")) return new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color("#fff8e0"), 0.35), toneMapped: false });
  if (name.startsWith("glass")) return toon(`#${color.getHexString()}`, { transparent: 0.35 });
  return toon(`#${color.getHexString()}`);
}

export class AssetLibrary {
  private assets = new Map<string, Asset>();
  private readonly accent: THREE.Material;

  constructor(accent: THREE.Material) {
    this.accent = accent;
  }

  get(name: string): Asset | undefined {
    return this.assets.get(name);
  }

  has(name: string) {
    return this.assets.has(name);
  }

  /** Loads every listed model that exists; missing ones are skipped (callers fall back to primitives). */
  async preload(names: string[], timeoutMs = 10000) {
    const jobs = names.map(async (name) => {
      try {
        const gltf = await loader.loadAsync(`/models/${name}.glb`);
        gltf.scene.updateMatrixWorld(true);
        const parts: AssetPart[] = [];
        const box = new THREE.Box3();
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const geometry = mesh.geometry.clone();
          geometry.applyMatrix4(mesh.matrixWorld);
          geometry.computeBoundingBox();
          box.union(geometry.boundingBox!);
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const src = mats[0];
          parts.push({ geometry, material: convertMaterial(src, this.accent), role: (src.name || "").toLowerCase() });
        });
        if (parts.length) this.assets.set(name, { name, parts, box });
      } catch {
        /* not built yet */
      }
    });
    await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}

export interface PlaceOptions {
  rotY?: number;
  scale?: THREE.Vector3 | number;
  /** Tint for "fabric*" parts. */
  tint?: THREE.ColorRepresentation;
  /** Skip parts whose material role starts with any of these (e.g. "screen"). */
  skip?: string[];
}

interface Placement {
  matrix: THREE.Matrix4;
  tint: THREE.Color | null;
  skip: string[];
}

/** Collects placements and builds one InstancedMesh per (asset, part). */
export class InstancedPlacer {
  private placements = new Map<string, Placement[]>();

  add(name: string, x: number, y: number, z: number, opts: PlaceOptions = {}) {
    const s = opts.scale ?? 1;
    const scale = typeof s === "number" ? new THREE.Vector3(s, s, s) : s;
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), opts.rotY ?? 0),
      scale,
    );
    const list = this.placements.get(name) ?? [];
    list.push({ matrix, tint: opts.tint !== undefined ? new THREE.Color(opts.tint) : null, skip: opts.skip ?? [] });
    this.placements.set(name, list);
  }

  /** Adds an already-composed matrix (for items placed relative to a parent transform). */
  addMatrix(name: string, matrix: THREE.Matrix4, opts: Omit<PlaceOptions, "rotY" | "scale"> = {}) {
    const list = this.placements.get(name) ?? [];
    list.push({ matrix: matrix.clone(), tint: opts.tint !== undefined ? new THREE.Color(opts.tint) : null, skip: opts.skip ?? [] });
    this.placements.set(name, list);
  }

  build(lib: AssetLibrary, parent: THREE.Object3D, shadows = true) {
    let drawCalls = 0;
    for (const [name, list] of this.placements) {
      const asset = lib.get(name);
      if (!asset) continue;
      for (const part of asset.parts) {
        const used = list.filter((p) => !p.skip.some((s) => part.role.startsWith(s)));
        if (!used.length) continue;
        const fabric = part.role.startsWith("fabric") && used.some((p) => p.tint);
        let material = part.material;
        if (fabric) {
          material = (part.material as THREE.MeshToonMaterial).clone();
          (material as THREE.MeshToonMaterial).color.set("#ffffff");
        }
        const inst = new THREE.InstancedMesh(part.geometry, material, used.length);
        inst.userData.role = part.role; // the ray tracer picks finishes (chrome, oak, fabric...) by role
        const base = (part.material as THREE.MeshToonMaterial).color ?? new THREE.Color("#ffffff");
        used.forEach((p, i) => {
          inst.setMatrixAt(i, p.matrix);
          if (fabric) inst.setColorAt(i, p.tint ?? base);
        });
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.castShadow = shadows && !part.role.startsWith("glass");
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        parent.add(inst);
        drawCalls++;
      }
    }
    return drawCalls;
  }
}

/** Scale an asset to fit a target footprint (w along x, d along z), rotating 90° if that fits better. */
export function fitFootprint(asset: Asset, w: number, d: number, keepHeight = true) {
  const size = asset.box.getSize(new THREE.Vector3());
  const straight = Math.abs(Math.log((size.x / size.z) / (w / d)));
  const turned = Math.abs(Math.log((size.z / size.x) / (w / d)));
  const rotate = turned < straight - 0.2;
  const ax = rotate ? size.z : size.x;
  const az = rotate ? size.x : size.z;
  const sx = w / ax;
  const sz = d / az;
  const sy = keepHeight ? 1 : (sx + sz) / 2;
  // Scale applies in the asset's own frame (before rotation).
  const scale = rotate ? new THREE.Vector3(sz, sy, sx) : new THREE.Vector3(sx, sy, sz);
  return { rotate, scale };
}
