// Physically based parameters for the ray tracer, derived from the game's toon materials.
// Each object can override them with `userData.rt` (on the mesh or its material).

import * as THREE from "three";

/** Emissive light groups. The lighting moods scale each group (see moods.ts). */
export const GROUP = { generic: 0, panels: 1, monitors: 2, neon: 3, lamps: 4, bulbs: 5, signs: 6, sun: 7 } as const;

export interface RTOverride {
  rough?: number;
  metal?: number;
  /** Dielectric reflectance at normal incidence (0.04 is plastic/paint; polished stone ~0.06). */
  f0?: number;
  /** Emission strength, multiplied with the albedo. */
  emissive?: number;
  group?: number;
  /** Add this emitter to the light list (sampled directly, casts ray-traced shadows). */
  light?: boolean;
  /** Its colour follows a canvas texture (monitor screens). */
  liveMap?: boolean;
  /** Leave out of the ray-traced scene entirely. */
  skip?: boolean;
  /** Override the albedo. */
  color?: THREE.ColorRepresentation;
}

export interface RTInfo {
  kind: "opaque" | "glass" | "forward" | "skip";
  albedo: THREE.Color;
  emissive: number;
  rough: number;
  metal: number;
  f0: number;
  group: number;
  light: boolean;
  liveMap: boolean;
  map: THREE.Texture | null;
  opacity: number;
}

/** Blender material names (asset parts) -> surface finish. */
const ROLE_RULES: [RegExp, RTOverride][] = [
  [/^chrome/, { metal: 1, rough: 0.06 }],
  [/^(stainless|steel)/, { metal: 1, rough: 0.28 }],
  [/^brass/, { metal: 1, rough: 0.22 }],
  [/^marble/, { rough: 0.06, f0: 0.05 }],
  [/^ceramic|^cup|^mug/, { rough: 0.12, f0: 0.05 }],
  [/^(oak|walnut|frame_oak|oak_dark|oak_edge|drawer_front|cabinet)/, { rough: 0.32 }],
  [/^(leaf|stem|bark|soil|rope|rattan)/, { rough: 0.7 }],
  [/^(fabric|accent_fabric|accent_felt|accent_pillow|coat|scarf|hat|rug)/, { rough: 0.95 }],
  [/^(slate|charcoal|stand|frame_charcoal|lamp_body)/, { rough: 0.3 }],
  [/^(white|offwhite|fridge|microwave|vend_body|coffee_body|cooler|printer_grey|bin_body|bin_blue)/, { rough: 0.25 }],
  [/^accent/, { rough: 0.25 }],
  [/^screen/, { rough: 0.04, f0: 0.05, emissive: 0 }],
  [/^emissive_(bulb|led|display)/, { emissive: 5, group: GROUP.lamps, light: true }],
  [/^emissive/, { emissive: 3, group: GROUP.lamps, light: true }],
  [/^(paper|book|cover|canvas|art_|photo_)/, { rough: 0.8 }],
  [/^(terracotta|pot|planter)/, { rough: 0.6 }],
];

const avgCache = new Map<string, { version: number; color: THREE.Color }>();
let probe: CanvasRenderingContext2D | null = null;

/** Average colour of a texture (linear), for surfaces the ray tracer sees without their texture. */
export function textureAverage(tex: THREE.Texture): THREE.Color {
  const hit = avgCache.get(tex.uuid);
  if (hit && hit.version === tex.version) return hit.color;
  const img = tex.image as CanvasImageSource & { width?: number; height?: number };
  const color = new THREE.Color(1, 1, 1);
  if (img && img.width) {
    probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    probe.canvas.width = probe.canvas.height = 4;
    try {
      probe.clearRect(0, 0, 4, 4);
      probe.drawImage(img, 0, 0, 4, 4);
      const d = probe.getImageData(0, 0, 4, 4).data;
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < d.length; i += 4) {
        const w = d[i + 3] / 255;
        r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; a += w;
      }
      if (a > 0) color.setRGB(r / a / 255, g / a / 255, b / a / 255, THREE.SRGBColorSpace);
    } catch {
      /* tainted or not drawable */
    }
  }
  avgCache.set(tex.uuid, { version: tex.version, color });
  return color;
}

function overrides(o: THREE.Object3D, m: THREE.Material): RTOverride {
  return { ...(m.userData.rt as RTOverride | undefined), ...(o.userData.rt as RTOverride | undefined) };
}

export function classify(o: THREE.Object3D, material: THREE.Material): RTInfo {
  const info: RTInfo = {
    kind: "opaque",
    albedo: new THREE.Color(1, 1, 1),
    emissive: 0,
    rough: 0.55,
    metal: 0,
    f0: 0.04,
    group: GROUP.generic,
    light: false,
    liveMap: false,
    map: null,
    opacity: 1,
  };
  if ((o as THREE.Sprite).isSprite) {
    info.kind = "forward";
    return info;
  }
  if (!(o as THREE.Mesh).isMesh) {
    info.kind = "skip";
    return info;
  }
  const m = material as THREE.MeshBasicMaterial;
  if (m.color) info.albedo.copy(m.color);
  info.map = m.map ?? null;
  info.opacity = m.opacity ?? 1;

  const role = String(o.userData.role ?? material.name ?? "").toLowerCase();
  const ov = overrides(o, material);

  if (m.transparent && !m.map && m.opacity < 0.9) info.kind = "glass";
  if (/^glass/.test(role)) {
    info.kind = "glass";
    info.opacity = Math.min(info.opacity, 0.35);
  }
  if ((material as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    // Unlit materials: signs, screens, light panels. Treat them as emitters.
    info.emissive = material.toneMapped === false ? 2.5 : 1;
    info.rough = 0.2;
  }
  for (const [re, rule] of ROLE_RULES) {
    if (re.test(role)) {
      Object.assign(info, rule);
      break;
    }
  }
  if (ov.rough !== undefined) info.rough = ov.rough;
  if (ov.metal !== undefined) info.metal = ov.metal;
  if (ov.f0 !== undefined) info.f0 = ov.f0;
  if (ov.emissive !== undefined) info.emissive = ov.emissive;
  if (ov.group !== undefined) info.group = ov.group;
  if (ov.light !== undefined) info.light = ov.light;
  if (ov.liveMap !== undefined) info.liveMap = ov.liveMap;
  if (ov.color !== undefined) info.albedo.set(ov.color);
  if (ov.skip) info.kind = "skip";
  return info;
}
