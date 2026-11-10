// Lighting moods for the ray-traced office. Each one scales the emissive light groups
// (materials.ts GROUP) and sets the fill light that stands in for bounces past the first.

import * as THREE from "three";

export interface Mood {
  name: string;
  /** Scale per light group: generic, panels, monitors, neon, lamps, bulbs, signs, sun. */
  groups: number[];
  ambient: THREE.Color;
  env: number;
  sun: number;
  exposure: number;
}

export const MOODS: Mood[] = [
  { name: "Live", groups: [1, 1, 1, 0.6, 1, 1.2, 1, 1], ambient: new THREE.Color(0.02, 0.019, 0.018), env: 1, sun: 1, exposure: 1.0 },
  { name: "Neon noir", groups: [1, 0.035, 1.3, 2.2, 0.5, 2.4, 1.2, 0.25], ambient: new THREE.Color(0.002, 0.002, 0.004), env: 0.7, sun: 0.25, exposure: 1.35 },
  { name: "Lights out", groups: [1, 0, 1.5, 0, 0.12, 4, 1.4, 0.1], ambient: new THREE.Color(0.0008, 0.0008, 0.0012), env: 0.55, sun: 0.1, exposure: 1.7 },
];

/** "Live" follows the time of day: dimmer, warmer panels and brighter neon after dark. */
export function liveGroups(night: number): number[] {
  const m = THREE.MathUtils.lerp;
  return [1, m(1, 0.7, night), 1, m(0.35, 1.1, night), m(0.6, 1, night), 1.3, 1, 1];
}
