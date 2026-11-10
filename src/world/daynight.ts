// Day/night cycle that follows the player's real local time.
//
// The sun's real position is computed from the clock and an approximate location (guessed from
// the browser's time zone, or ?lat=&lon= in the URL). Its elevation drives a set of keyframes
// for the sky, the city's tint, window lights, street lamps and car headlights, and the office's
// own lights, which shift from cool daylight to warm lamplight after dark.
//
// Overrides, handy for testing:
//   ?time=21:30            pin the clock to a time of day (today's date)
//   ?timescale=600         run the clock 600x faster (a day in about 2.4 minutes)
//   dayNight.setTime("6:45") / setTime(null) from the browser console
//   dayNight.nightSky.spawn() launches a shooting star (spawn(true): a fireball)

import * as THREE from "three";
import type { City, CityEnv } from "./city.ts";
import { galacticToCity } from "./nightsky.ts";

export interface OfficeLights {
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
}

const RAD = Math.PI / 180;

// ------------------------------------------------------------------ location

/** Rough coordinates for common time zones; anything else falls back to the UTC offset. */
const ZONES: Record<string, [number, number]> = {
  "America/Los_Angeles": [34.05, -118.24],
  "America/Vancouver": [49.28, -123.12],
  "America/Tijuana": [32.51, -117.04],
  "America/Phoenix": [33.45, -112.07],
  "America/Denver": [39.74, -104.99],
  "America/Edmonton": [53.55, -113.49],
  "America/Chicago": [41.88, -87.63],
  "America/Mexico_City": [19.43, -99.13],
  "America/Winnipeg": [49.9, -97.14],
  "America/New_York": [40.71, -74.01],
  "America/Toronto": [43.65, -79.38],
  "America/Detroit": [42.33, -83.05],
  "America/Halifax": [44.65, -63.57],
  "America/St_Johns": [47.56, -52.71],
  "America/Anchorage": [61.22, -149.9],
  "Pacific/Honolulu": [21.31, -157.86],
  "America/Bogota": [4.71, -74.07],
  "America/Lima": [-12.05, -77.04],
  "America/Santiago": [-33.45, -70.67],
  "America/Sao_Paulo": [-23.55, -46.63],
  "America/Argentina/Buenos_Aires": [-34.6, -58.38],
  "Europe/London": [51.51, -0.13],
  "Europe/Dublin": [53.35, -6.26],
  "Europe/Lisbon": [38.72, -9.14],
  "Europe/Madrid": [40.42, -3.7],
  "Europe/Paris": [48.86, 2.35],
  "Europe/Brussels": [50.85, 4.35],
  "Europe/Amsterdam": [52.37, 4.9],
  "Europe/Berlin": [52.52, 13.4],
  "Europe/Zurich": [47.38, 8.54],
  "Europe/Rome": [41.9, 12.5],
  "Europe/Vienna": [48.21, 16.37],
  "Europe/Prague": [50.08, 14.44],
  "Europe/Warsaw": [52.23, 21.01],
  "Europe/Stockholm": [59.33, 18.07],
  "Europe/Oslo": [59.91, 10.75],
  "Europe/Copenhagen": [55.68, 12.57],
  "Europe/Helsinki": [60.17, 24.94],
  "Europe/Athens": [37.98, 23.73],
  "Europe/Istanbul": [41.01, 28.98],
  "Europe/Kyiv": [50.45, 30.52],
  "Europe/Moscow": [55.76, 37.62],
  "Africa/Cairo": [30.04, 31.24],
  "Africa/Lagos": [6.52, 3.38],
  "Africa/Nairobi": [-1.29, 36.82],
  "Africa/Johannesburg": [-26.2, 28.05],
  "Asia/Dubai": [25.2, 55.27],
  "Asia/Tehran": [35.69, 51.39],
  "Asia/Karachi": [24.86, 67.0],
  "Asia/Kolkata": [19.08, 72.88],
  "Asia/Calcutta": [19.08, 72.88],
  "Asia/Dhaka": [23.81, 90.41],
  "Asia/Bangkok": [13.76, 100.5],
  "Asia/Jakarta": [-6.21, 106.85],
  "Asia/Singapore": [1.35, 103.82],
  "Asia/Kuala_Lumpur": [3.14, 101.69],
  "Asia/Ho_Chi_Minh": [10.82, 106.63],
  "Asia/Manila": [14.6, 120.98],
  "Asia/Hong_Kong": [22.32, 114.17],
  "Asia/Shanghai": [31.23, 121.47],
  "Asia/Taipei": [25.03, 121.57],
  "Asia/Seoul": [37.57, 126.98],
  "Asia/Tokyo": [35.68, 139.69],
  "Australia/Perth": [-31.95, 115.86],
  "Australia/Adelaide": [-34.93, 138.6],
  "Australia/Brisbane": [-27.47, 153.03],
  "Australia/Sydney": [-33.87, 151.21],
  "Australia/Melbourne": [-37.81, 144.96],
  "Pacific/Auckland": [-36.85, 174.76],
};

function guessLocation(): { lat: number; lon: number; label: string } {
  const q = new URLSearchParams(location.search);
  if (q.has("lat") && q.has("lon")) return { lat: Number(q.get("lat")), lon: Number(q.get("lon")), label: "url" };
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    // Older engines: fall through to the offset guess.
  }
  const known = ZONES[tz];
  if (known) return { lat: known[0], lon: known[1], label: tz };
  // Standard (non-DST) offset: the larger of January's and July's, in minutes east of UTC.
  const y = new Date().getFullYear();
  const std = -Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
  const south = /^(Australia|Antarctica)\/|^Pacific\/(Auckland|Fiji|Chatham)|^America\/(Sao_Paulo|Argentina|Santiago|Montevideo|Asuncion|La_Paz|Lima)|^Africa\/(Johannesburg|Maputo|Harare|Windhoek)/.test(tz);
  return { lat: south ? -30 : 40, lon: (std / 60) * 15, label: tz || "utc-offset" };
}

// ------------------------------------------------------------------ astronomy

/**
 * Sun direction in city space (x east, y up, -z north) for a moment and place.
 * Low-precision formulas (about 0.01 degree), plenty for lighting.
 */
function sunDirection(date: Date, lat: number, lon: number, out: THREE.Vector3) {
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const H = (gmst * 15 + lon) * RAD - ra;
  enu(H, dec, lat * RAD, out);
  return { H, dec, lst: (gmst * 15 + lon) * RAD };
}

/** East/up/north unit vector for an hour angle and declination, mapped to city axes. */
function enu(H: number, dec: number, phi: number, out: THREE.Vector3) {
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.cos(H) * Math.sin(phi);
  const up = Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(H) * Math.cos(phi);
  return out.set(east, up, -north).normalize();
}

/** 0 = new moon, 0.5 = full. */
function moonPhase(date: Date) {
  const SYNODIC = 29.530588853;
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  return (((days / SYNODIC) % 1) + 1) % 1;
}

// ------------------------------------------------------------------ keyframes

interface Key {
  el: number; // sun elevation, degrees
  top: string;
  mid: string;
  horizon: string;
  glow: string;
  glowAmt: number;
  tint: string; // multiplies the city's lit materials
  hills: string;
  clouds: string;
}

// Ordered by elevation. Day matches the original look of the city exactly.
const KEYS: Key[] = [
  { el: -18, top: "#010106", mid: "#030714", horizon: "#16203c", glow: "#16203c", glowAmt: 0, tint: "#2a3150", hills: "#1a2236", clouds: "#1f2640" },
  { el: -10, top: "#0b1534", mid: "#1d2a58", horizon: "#3c3e6a", glow: "#8d5a7e", glowAmt: 0.35, tint: "#3a4068", hills: "#2c3350", clouds: "#4a4a70" },
  { el: -4, top: "#22407c", mid: "#5a6aa6", horizon: "#e99a7a", glow: "#ff8250", glowAmt: 0.75, tint: "#7c7290", hills: "#6a6688", clouds: "#d09aa8" },
  { el: 1, top: "#4a7fc2", mid: "#93acd6", horizon: "#ffc08a", glow: "#ff9a52", glowAmt: 0.8, tint: "#d8b6a0", hills: "#c2aca8", clouds: "#ffd0b8" },
  { el: 8, top: "#65a0dd", mid: "#a5c5ea", horizon: "#f3dcc6", glow: "#ffc58c", glowAmt: 0.6, tint: "#f6e6d6", hills: "#eee4dc", clouds: "#fff0e2" },
  { el: 20, top: "#6faae6", mid: "#a9cdf0", horizon: "#dde9f2", glow: "#fbe9d8", glowAmt: 0.45, tint: "#ffffff", hills: "#ffffff", clouds: "#ffffff" },
];
const KEY_COLORS = KEYS.map((k) => ({
  top: new THREE.Color(k.top),
  mid: new THREE.Color(k.mid),
  horizon: new THREE.Color(k.horizon),
  glow: new THREE.Color(k.glow),
  tint: new THREE.Color(k.tint),
  hills: new THREE.Color(k.hills),
  clouds: new THREE.Color(k.clouds),
}));

const smooth = (e0: number, e1: number, x: number) => THREE.MathUtils.smoothstep(x, e0, e1);

// Office lighting: cool daylight vs. warm lamplight.
const DAY_HEMI = new THREE.Color("#ffffff"), NIGHT_HEMI = new THREE.Color("#ffe6c4");
const DAY_GROUND = new THREE.Color("#d8ccb4"), NIGHT_GROUND = new THREE.Color("#c9b08e");
const DAY_KEY = new THREE.Color("#fff6e6"), NIGHT_KEY = new THREE.Color("#ffd9a8");
const DAY_AMB = new THREE.Color("#fff6e8"), NIGHT_AMB = new THREE.Color("#ffe2bc");

// ------------------------------------------------------------------ controller

export class DayNight {
  readonly env: CityEnv = {
    top: new THREE.Color(),
    mid: new THREE.Color(),
    horizon: new THREE.Color(),
    glow: new THREE.Color(),
    glowAmt: 0,
    sunDir: new THREE.Vector3(0, 1, 0),
    moonDir: new THREE.Vector3(0, -1, 0),
    moon: 0,
    stars: 0,
    celestial: new THREE.Matrix4(),
    tint: new THREE.Color(),
    hills: new THREE.Color(),
    clouds: new THREE.Color(),
    night: 0,
    windows: 0,
  };
  readonly location = guessLocation();
  /** Sun elevation in degrees, refreshed by update(). */
  sunElevation = 90;
  /** 0 at full night, 1 in full daylight. */
  daylight = 1;

  private pinned: Date | null = null;
  private timescale = 1;
  private simStart = Date.now();
  private realStart = performance.now();
  private accum = Infinity;

  private city: Pick<City, "applyEnv"> & Partial<Pick<City, "nightSky">>;
  private lights: OfficeLights;

  constructor(city: Pick<City, "applyEnv"> & Partial<Pick<City, "nightSky">>, lights: OfficeLights) {
    this.city = city;
    this.lights = lights;
    const q = new URLSearchParams(location.search);
    if (q.has("time")) this.setTime(q.get("time"));
    if (q.has("timescale")) this.timescale = Math.max(0, Number(q.get("timescale")) || 1);
    this.update(0);
  }

  /** Stars, Milky Way and shooting stars, e.g. dayNight.nightSky.spawn(true) for a fireball. */
  get nightSky() {
    return this.city.nightSky;
  }

  /** Pin the clock to "HH:MM" (today), a Date, or hours as a number. null returns to live time. */
  setTime(t: string | number | Date | null) {
    this.simStart = Date.now();
    this.realStart = performance.now();
    if (t === null || t === "") this.pinned = null;
    else if (t instanceof Date) this.pinned = t;
    else {
      const hours = typeof t === "number" ? t : (() => {
        const [h, m = "0"] = String(t).split(":");
        return Number(h) + Number(m) / 60;
      })();
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      this.pinned = new Date(d.getTime() + hours * 3600000);
    }
    this.accum = Infinity; // apply on the next update
  }

  /** The moment being shown (live time unless pinned or sped up). */
  now() {
    const base = this.pinned ? this.pinned.getTime() : this.simStart;
    const elapsed = performance.now() - this.realStart;
    if (this.pinned && this.timescale === 1) return new Date(base);
    if (!this.pinned && this.timescale === 1) return new Date();
    return new Date(base + elapsed * this.timescale);
  }

  update(dt: number) {
    // The sky changes slowly in real time, so recompute about once a second (every frame when sped up).
    this.accum += dt;
    if (this.accum < (this.timescale > 1 ? 0 : 1)) return;
    this.accum = 0;
    this.compute(this.now());
    this.city.applyEnv(this.env);
    this.applyOffice();
  }

  private compute(date: Date) {
    const { lat, lon } = this.location;
    const env = this.env;
    const { H, dec, lst } = sunDirection(date, lat, lon, env.sunDir);
    const el = Math.asin(THREE.MathUtils.clamp(env.sunDir.y, -1, 1)) / RAD;
    this.sunElevation = el;

    // Interpolate the keyframes.
    let i = 0;
    while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = THREE.MathUtils.clamp((el - a.el) / (b.el - a.el), 0, 1);
    const ca = KEY_COLORS[i], cb = KEY_COLORS[i + 1];
    env.top.copy(ca.top).lerp(cb.top, t);
    env.mid.copy(ca.mid).lerp(cb.mid, t);
    env.horizon.copy(ca.horizon).lerp(cb.horizon, t);
    env.glow.copy(ca.glow).lerp(cb.glow, t);
    env.glowAmt = THREE.MathUtils.lerp(a.glowAmt, b.glowAmt, t);
    env.tint.copy(ca.tint).lerp(cb.tint, t);
    env.hills.copy(ca.hills).lerp(cb.hills, t);
    env.clouds.copy(ca.clouds).lerp(cb.clouds, t);

    // Lights come on around sunset and stay on until after sunrise.
    env.night = 1 - smooth(-6, 4, el);
    // Office windows stay dark by day, then come on one by one through dusk until about nautical dusk.
    env.windows = 1 - smooth(-12, 1, el);
    env.stars = 1 - smooth(-14, -3, el);
    // The real night sky for this moment: the Milky Way where it is, turning through the night.
    galacticToCity(lst, lat * RAD, env.celestial);
    this.daylight = smooth(-8, 10, el);

    // A plausible moon: it trails the sun by its phase, so it's full and opposite the sun mid-month.
    const phase = moonPhase(date);
    enu(H - phase * Math.PI * 2, dec * Math.cos(phase * Math.PI * 2), lat * RAD, env.moonDir);
    env.moon = smooth(-0.02, 0.06, env.moonDir.y) * (0.35 + 0.65 * (1 - smooth(-6, 6, el)));
  }

  private applyOffice() {
    const n = 1 - this.daylight;
    const { hemi, ambient, key } = this.lights;
    hemi.color.copy(DAY_HEMI).lerp(NIGHT_HEMI, n);
    hemi.groundColor.copy(DAY_GROUND).lerp(NIGHT_GROUND, n);
    hemi.intensity = THREE.MathUtils.lerp(1.55, 1.3, n);
    ambient.color.copy(DAY_AMB).lerp(NIGHT_AMB, n);
    ambient.intensity = THREE.MathUtils.lerp(0.35, 0.3, n);
    key.color.copy(DAY_KEY).lerp(NIGHT_KEY, n);
    key.intensity = THREE.MathUtils.lerp(1.35, 1.05, n);
  }

  /** One-line summary for debugging. */
  describe() {
    const d = this.now();
    return `${d.toLocaleTimeString()} · sun ${this.sunElevation.toFixed(1)}° · night ${this.env.night.toFixed(2)} · ${this.location.label} (${this.location.lat.toFixed(1)}, ${this.location.lon.toFixed(1)})`;
  }
}
