// The night sky: a starfield, the Milky Way and shooting stars, for the city's sky dome.
//
// Everything lives on a celestial sphere in galactic coordinates (x toward the galactic centre,
// z toward the north galactic pole). daynight.ts supplies the rotation from that sphere to the
// city's axes for the real time and place, so the Milky Way sits where it really is tonight and
// turns with the sky through the night.
//
//  - Stars: ~21k points with a realistic spread of brightness (many faint, a few bright),
//    star colours from blue-white to orange, crowded toward the galactic plane, twinkling more
//    near the horizon. Drawn as THREE.Points right behind the sky dome, so clouds, hills and
//    buildings cover them and the ray tracer's environment capture picks them up for free.
//  - Milky Way: evaluated in the sky dome's fragment shader (NIGHT_SKY_GLSL): a soft band with
//    a warm bulge toward the centre, clumpy star clouds with pin-point sparkle, dark dust lanes
//    and a whisper of pink emission nebulae. Tuned for a near-black zenith (the night keyframe
//    in daynight.ts) so OLED/HDR screens get deep darks and bright cores. Night only.
//  - Shooting stars: a few at a time, analytic great-circle streaks in the same shader with a
//    fading trail; now and then a slower, brighter fireball. Mostly launched where the camera
//    is looking, so you actually see them through the windows. Left out of the ray tracer's
//    cube capture (a frozen streak in a reflection would look wrong).
//
// Cost: the points are one draw call; the shader work is a uniform-guarded branch that is
// skipped by day, and the noise is skipped away from the band. Measured at 1920x1080 on an
// RTX 5090: +0.18 ms per frame with ray tracing off, within noise with it on.

import * as THREE from "three";

const R = 900; // star sphere radius (inside the 1000 m sky dome; depth is pinned to the far plane anyway)
const MAX_METEORS = 4;

// Equatorial (J2000) -> galactic rotation. Rows are the galactic axes in equatorial coordinates.
export const EQ_TO_GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
] as const;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ stars

/** Star colours by spectral class, roughly as they look to the eye (a touch saturated). */
const STAR_COLORS: [number, THREE.Color][] = [
  [0.12, new THREE.Color(0.66, 0.78, 1.0)], // O/B blue-white
  [0.32, new THREE.Color(0.84, 0.9, 1.0)], // A white
  [0.62, new THREE.Color(1.0, 0.98, 0.95)], // F
  [0.82, new THREE.Color(1.0, 0.91, 0.76)], // G yellow
  [0.95, new THREE.Color(1.0, 0.78, 0.55)], // K orange
  [1.0, new THREE.Color(1.0, 0.64, 0.45)], // M red-orange
];

function starGeometry() {
  const rnd = mulberry32(20261109);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const pos: number[] = [], bright: number[] = [], color: number[] = [], seed: number[] = [];
  const v = new THREE.Vector3();

  const push = (mag: number, plane: boolean) => {
    if (plane) {
      // Crowded toward the galactic plane, more so toward the centre.
      const l = rnd() < 0.55 ? gauss() * 1.1 : (rnd() * 2 - 1) * Math.PI;
      const b = gauss() * (0.06 + 0.1 * Math.exp(-l * l));
      v.set(Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b));
    } else {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      v.set(s * Math.cos(a), s * Math.sin(a), z);
    }
    pos.push(v.x * R, v.y * R, v.z * R);
    // Perceived brightness: flux compressed so faint stars still read on screen.
    bright.push(Math.pow(10, -0.4 * mag * 0.5));
    const r = rnd();
    const c = STAR_COLORS.find(([p]) => r <= p)![1];
    // Faint stars look whiter (the eye loses colour at low light).
    const sat = THREE.MathUtils.clamp(1.15 - mag * 0.12, 0.25, 1);
    color.push(1 + (c.r - 1) * sat, 1 + (c.g - 1) * sat, 1 + (c.b - 1) * sat);
    seed.push(rnd());
  };

  // Naked-eye sky: N(<m) grows ~2.8x per magnitude, down to about 6.5.
  for (let i = 0; i < 7000; i++) push(Math.max(-1.4, 6.5 + Math.log10(rnd() + 1e-9) / 0.45), rnd() < 0.3);
  // The Milky Way's unresolved haze, resolved a little: faint stars hugging the plane.
  for (let i = 0; i < 14000; i++) push(5.9 + rnd() * 1.8, true);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aBright", new THREE.Float32BufferAttribute(bright, 1));
  g.setAttribute("aColor", new THREE.Float32BufferAttribute(color, 3));
  g.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.01);
  return g;
}

function starMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uStars: { value: 0 },
      uScale: { value: 1 },
      uGain: { value: 1 },
      uTime: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoon: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uStars; uniform float uScale; uniform float uTime; uniform float uGain;
      uniform vec3 uMoonDir; uniform float uMoon;
      attribute float aBright; attribute vec3 aColor; attribute float aSeed;
      varying vec3 vColor; varying float vHalo;
      void main() {
        vec3 w = normalize(mat3(modelMatrix) * position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // on the far plane, like the sky dome
        float h = w.y;
        // Haze and city glow swallow stars near the horizon; they also twinkle harder there.
        float horizon = smoothstep(0.015, 0.32, h);
        float amp = mix(0.55, 0.14, horizon) * (0.4 + 0.6 * smoothstep(0.0, 0.5, aBright));
        float tw = 1.0 + amp * sin(uTime * (2.3 + aSeed * 6.0) + aSeed * 91.0) * sin(uTime * (0.9 + aSeed * 1.7) + aSeed * 17.0);
        // Hidden behind the moon's disc, dimmed in its glare.
        float md = dot(w, uMoonDir);
        float moonCut = uMoon > 0.001 ? 1.0 - step(0.99975, md) : 1.0;
        float glare = 1.0 - 0.7 * uMoon * smoothstep(0.95, 0.9995, md);
        float b = 4.5 * uGain * aBright * tw * uStars * horizon * moonCut * glare;
        // Size in pixels at 1080p, scaled to the target; sub-pixel stars keep a 1.6 px footprint
        // and dim by area instead, so they don't shimmer (and stay right in small cube maps).
        float size = (1.3 + 3.0 * pow(aBright, 0.8)) * uScale;
        float s = max(size, 1.6);
        b *= (size * size) / (s * s);
        vHalo = smoothstep(0.35, 1.2, aBright);
        gl_PointSize = s * (1.0 + 1.6 * vHalo); // bright stars get room for a soft halo
        vColor = aColor * b;
        if (b < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // cull: off screen
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor; varying float vHalo;
      void main() {
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(q, q);
        if (r2 > 1.0) discard;
        float k = 1.0 + 1.6 * vHalo; // the core is 1/k of the sprite
        float core = exp(-r2 * k * k * 2.2);
        float halo = vHalo * 0.22 * exp(-r2 * 5.0) * (1.0 - r2);
        gl_FragColor = vec4(vColor * (core + halo), 1.0);
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: false,
    fog: false,
  });
}

// ------------------------------------------------------------------ sky dome GLSL

/** Uniforms the sky dome needs for the Milky Way and meteors (merge into its ShaderMaterial). */
export function nightSkyUniforms() {
  return {
    uGal: { value: new THREE.Matrix3() }, // city direction -> galactic
    uGalaxy: { value: 0 },
    uPix: { value: 0.001 }, // radians per pixel of the current view
    uMetA: { value: Array.from({ length: MAX_METEORS }, () => new THREE.Vector4()) }, // tail dir, brightness
    uMetB: { value: Array.from({ length: MAX_METEORS }, () => new THREE.Vector4()) }, // head dir, width
    uMetC: { value: Array.from({ length: MAX_METEORS }, () => new THREE.Vector3()) }, // colour
  };
}
export type NightSkyUniforms = ReturnType<typeof nightSkyUniforms>;

/** Declarations and functions for the sky dome's fragment shader. */
export const NIGHT_SKY_GLSL = /* glsl */ `
  #define MAX_METEORS ${MAX_METEORS}
  uniform mat3 uGal; uniform float uGalaxy; uniform float uPix;
  uniform vec4 uMetA[MAX_METEORS]; uniform vec4 uMetB[MAX_METEORS]; uniform vec3 uMetC[MAX_METEORS];

  float nsHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float nsNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(nsHash(i), nsHash(i + vec3(1, 0, 0)), f.x), mix(nsHash(i + vec3(0, 1, 0)), nsHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(nsHash(i + vec3(0, 0, 1)), nsHash(i + vec3(1, 0, 1)), f.x), mix(nsHash(i + vec3(0, 1, 1)), nsHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float nsFbm(vec3 p, int oct) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) {
      if (i >= oct) break;
      s += a * nsNoise(p);
      p = p * 2.07 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return s;
  }

  // The Milky Way seen along direction d (city axes), linear RGB before the uGalaxy fade.
  vec3 milkyWay(vec3 d) {
    vec3 g = uGal * d;
    float b = g.z;                                  // sin(galactic latitude)
    if (abs(b) > 0.5) return vec3(0.0);
    float toward = g.x / max(length(g.xy), 1e-4);   // cos(galactic longitude)
    float core = pow(max(0.0, toward * 0.5 + 0.5), 3.0); // 1 at the centre, 0 at the anticentre
    float width = mix(0.12, 0.19, core);
    float glow = exp(-b * b / 0.05) * (0.1 + 0.15 * core) * smoothstep(0.5, 0.4, abs(b)); // faint wide glow
    float bulge = exp(-(b * b + (1.0 - toward) * 2.0) / 0.035);  // the galactic centre's bulge
    // Away from the band (warp moves it by at most 0.053) only the soft glow is left: skip the noise.
    if (abs(b) - 0.053 > 2.6 * width) return vec3(0.5, 0.64, 1.0) * pow(glow + bulge * 0.45, 1.5) * 0.8;
    // Features are stretched along the plane (filaments and lanes, not blobs).
    vec3 gs = vec3(g.xy, g.z * 1.9);
    // A gently warped plane so the band isn't a ruler-straight stripe.
    float warp = nsFbm(g * 2.6 + vec3(4.0), 3) - 0.5;
    float bb = b + warp * 0.07 * (0.5 + core);
    float band = exp(-bb * bb / (width * width));
    float clouds = nsFbm(gs * 6.5 + warp * 1.5, 5);             // star clouds
    float grain = nsFbm(g * 75.0, 2);                           // their grainy texture
    float lum = band * (0.16 + 1.45 * smoothstep(0.36, 0.8, clouds)) * (0.55 + 0.9 * grain) * (0.7 + 0.4 * core)
              + glow + bulge * 0.45;
    // Dust: a broken dark rift just off the plane (strongest toward the centre), and finer lanes.
    float dn = nsFbm(gs * 8.0 + vec3(3.0), 5);
    float rift = exp(-pow((bb - 0.015) / (width * 0.36), 2.0)) * smoothstep(0.36, 0.58, dn) * (0.55 + 0.45 * core);
    float lanes = smoothstep(0.56, 0.7, nsFbm(gs * 19.0 + vec3(11.0), 4)) * band;
    lum *= 1.0 - clamp(rift * 0.97 + lanes * 0.6, 0.0, 0.98);
    // Contrast for dark (OLED) skies: dim floors stay dim, bright star clouds and the core punch up.
    lum = pow(lum, 1.5) * 0.8;
    // Unresolved stars: pin-point sparkle that follows the bright star clouds (only where a
    // cell is about a pixel, so not in the ray tracer's small environment cube).
    if (uPix < 0.004) {
      vec3 sp = g * 640.0;
      vec3 cell = floor(sp);
      float r = nsHash(cell);
      if (r > 0.8) {
        vec3 o = cell + 0.5 + 0.35 * (vec3(nsHash(cell + 1.7), nsHash(cell + 3.1), nsHash(cell + 5.3)) - 0.5);
        float k = smoothstep(0.55, 0.0, length(sp - o)) * (r - 0.8) * 5.0;
        lum += k * band * smoothstep(0.3, 0.75, clouds) * (1.0 - rift) * 1.6 * smoothstep(0.004, 0.002, uPix);
      }
    }
    // Colour: cool blue-white arms, creamy bright clouds, a warm core, a whisper of pink emission.
    vec3 col = mix(vec3(0.5, 0.64, 1.0), vec3(1.0, 0.87, 0.7), smoothstep(0.45, 0.8, clouds));
    col = mix(col, vec3(1.0, 0.82, 0.6), clamp(core * 0.9, 0.0, 1.0));
    float neb = smoothstep(0.6, 0.76, nsFbm(gs * 14.0 + vec3(7.0), 4)) * band * (1.0 - rift);
    col = mix(col, vec3(1.0, 0.35, 0.55), neb * 0.6);
    return col * lum;
  }

  // Shooting stars: great-circle streaks from tail (A.xyz) to head (B.xyz).
  vec3 meteors(vec3 d) {
    vec3 c = vec3(0.0);
    for (int i = 0; i < MAX_METEORS; i++) {
      vec4 A = uMetA[i];
      if (A.w <= 0.0) continue;
      vec4 B = uMetB[i];
      vec3 n = cross(A.xyz, B.xyz);
      float nl = length(n);
      if (nl < 1e-6) continue;
      n /= nl;
      float off = dot(d, n);                                    // ~angle off the path
      float w = uPix * B.w;                                     // half-width, radians
      if (abs(off) > w * 6.0 + uPix * 5.0) continue;
      float L = atan(nl, dot(A.xyz, B.xyz));                    // trail length
      float s = atan(dot(d, cross(n, A.xyz)), dot(d, A.xyz));   // angle along the path from the tail
      float u = s / max(L, 1e-5);                               // 0 tail .. 1 head
      if (u < -0.02 || u > 1.0 + 6.0 * uPix / max(L, 1e-5)) continue;
      float t = clamp(u, 0.0, 1.0);
      float fade = t * t * sqrt(t);                             // bright at the head, fading to the tail
      float ww = w * (0.55 + 0.45 * t);
      float trail = exp(-off * off / (ww * ww)) * fade * smoothstep(-0.02, 0.06, u);
      float dh = distance(d, B.xyz);
      float head = exp(-dh * dh / (w * w * 2.6));
      c += uMetC[i] * A.w * (trail * 0.75 + head * 1.6 + 0.12 * exp(-dh * dh / (w * w * 40.0)));
    }
    return c;
  }
`;

// ------------------------------------------------------------------ meteors

interface Meteor {
  p0: THREE.Vector3; // start of the path
  p1: THREE.Vector3; // end of the path (where it burns out)
  t: number; // seconds since start
  dur: number; // seconds to cross the path
  trail: number; // trail length as a fraction of the path
  peak: number; // brightness
  width: number; // head half-width in pixels
  color: THREE.Color;
  fireball: boolean;
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

function slerpDir(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) {
  const om = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
  if (om < 1e-5) return out.copy(a);
  const s = Math.sin(om);
  return out.copy(a).multiplyScalar(Math.sin((1 - t) * om) / s).addScaledVector(b, Math.sin(t * om) / s);
}

// ------------------------------------------------------------------ controller

export class NightSky {
  /** Star points; add as a child of the sky dome (it follows the dome's position). */
  readonly stars: THREE.Points;
  readonly uniforms: NightSkyUniforms;
  /** Shooting stars on/off (on by default). */
  meteorsEnabled = true;

  private starMat = starMaterial();
  private starLevel = 0;
  private meteors: Meteor[] = [];
  private nextMeteor = 4;
  private rnd = Math.random;
  private viewDir = new THREE.Vector3(0, 0.2, -1).normalize();
  private g2w = new THREE.Matrix4();

  constructor(uniforms: NightSkyUniforms) {
    this.uniforms = uniforms;
    this.stars = new THREE.Points(starGeometry(), this.starMat);
    this.stars.name = "stars";
    this.stars.frustumCulled = false;
    this.stars.matrixAutoUpdate = false;
    this.stars.renderOrder = -999; // right after the sky dome, before everything else
    this.stars.visible = false;
    this.stars.onBeforeRender = (renderer) => {
      const u = this.starMat.uniforms;
      u.uScale.value = targetHeight(renderer) / 1080;
      // In the ray tracer's small environment cube a star is a single bright texel, and glossy
      // reflections that sample it come out as sparkly fireflies: keep them faint there.
      u.uGain.value = isCubeTarget(renderer) ? 0.3 : 1;
    };
  }

  /** Call from the sky dome's onBeforeRender: per-view uniforms, and where the viewer looks. */
  beforeSkyRender(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    const cube = isCubeTarget(renderer);
    const proj = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5] || 1;
    this.uniforms.uPix.value = 2 / (proj * targetHeight(renderer));
    // Meteors only for the real view, not the ray tracer's cube capture.
    for (let i = 0; i < MAX_METEORS; i++) if (cube) this.uniforms.uMetA.value[i].w = 0;
    if (!cube) {
      camera.getWorldDirection(this.viewDir);
      this.writeMeteors();
    }
  }

  /**
   * Night level (0..1 from the day/night cycle), the galactic -> city rotation, and the moon,
   * which hides the stars behind it and washes out the Milky Way a little.
   */
  setSky(stars: number, galToCity: THREE.Matrix4, moonDir: THREE.Vector3, moon: number) {
    this.starLevel = stars;
    this.g2w.copy(galToCity);
    this.stars.matrix.copy(galToCity);
    this.stars.matrixWorldNeedsUpdate = true;
    this.uniforms.uGal.value.setFromMatrix4(galToCity).transpose();
    const moonUp = THREE.MathUtils.smoothstep(moonDir.y, -0.05, 0.2);
    this.uniforms.uGalaxy.value = stars * stars * (1 - 0.5 * moon * moonUp);
    const su = this.starMat.uniforms;
    su.uStars.value = stars;
    su.uMoonDir.value.copy(moonDir);
    su.uMoon.value = moon * moonUp;
    this.stars.visible = stars > 0.002;
  }

  update(dt: number, time: number) {
    this.starMat.uniforms.uTime.value = time;
    const step = Math.min(dt, 0.1);
    for (const m of this.meteors) m.t += step;
    this.meteors = this.meteors.filter((m) => m.t < m.dur * (1 + m.trail) + (m.fireball ? 0.6 : 0.15));
    if (this.starLevel < 0.35 || !this.meteorsEnabled) return;
    this.nextMeteor -= step;
    if (this.nextMeteor <= 0) {
      this.spawn();
      // Every 3-11 s (a bit of a meteor shower, it's a showpiece), sometimes two close together.
      this.nextMeteor = this.rnd() < 0.15 ? 0.4 + this.rnd() * 0.8 : 3 + this.rnd() * 8;
    }
  }

  /** Launch a shooting star now (console: dayNight.nightSky.spawn(); spawn(true) for a fireball). */
  spawn(fireball = this.rnd() < 0.07) {
    if (this.meteors.length >= MAX_METEORS) return;
    const r = this.rnd;
    // Mostly where the viewer is looking (a little above the line of sight), sometimes anywhere.
    const yaw0 = Math.atan2(this.viewDir.x, -this.viewDir.z);
    const pitch0 = Math.asin(THREE.MathUtils.clamp(this.viewDir.y, -1, 1));
    const ahead = r() < 0.8;
    const az = ahead ? yaw0 + (r() * 2 - 1) * 0.55 : r() * Math.PI * 2;
    const el = ahead ? THREE.MathUtils.clamp(pitch0 + 0.12 + r() * 0.35, 0.16, 1.25) : 0.3 + r() * 0.9;
    const p0 = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    // Head off downward at a slant, left or right.
    const east = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const up = new THREE.Vector3().crossVectors(east, p0).normalize();
    const slant = (0.35 + r() * 0.9) * (r() < 0.5 ? -1 : 1);
    const dir = up.multiplyScalar(-Math.cos(slant)).addScaledVector(east, Math.sin(slant)).normalize();
    const len = THREE.MathUtils.degToRad(fireball ? 22 + r() * 16 : 7 + r() * 15);
    const p1 = p0.clone().multiplyScalar(Math.cos(len)).addScaledVector(dir, Math.sin(len)).normalize();
    const color = fireball
      ? new THREE.Color().setRGB(0.75 + r() * 0.25, 1.0, 0.7 + r() * 0.2) // green-tinged fireball
      : new THREE.Color().setRGB(0.85 + r() * 0.15, 0.92 + r() * 0.08, 1.0);
    this.meteors.push({
      p0,
      p1,
      t: 0,
      dur: fireball ? 1.6 + r() * 0.8 : 0.45 + r() * 0.5,
      trail: fireball ? 0.45 : 0.3 + r() * 0.15,
      peak: fireball ? 2.6 : 0.9 + r() * 0.9,
      width: fireball ? 1.6 : 0.85,
      color,
      fireball,
    });
  }

  private writeMeteors() {
    const { uMetA, uMetB, uMetC } = this.uniforms;
    for (let i = 0; i < MAX_METEORS; i++) {
      const m = this.meteors[i];
      if (!m) {
        uMetA.value[i].w = 0;
        continue;
      }
      const x = m.t / m.dur;
      const head = Math.min(1, x);
      const tail = THREE.MathUtils.clamp(x - m.trail, 0, 1);
      // Brightens quickly, burns, fades out as the head stops and the trail catches up.
      let env = THREE.MathUtils.smoothstep(x, 0, 0.12) * (1 - THREE.MathUtils.smoothstep(x, 0.75, 1 + m.trail));
      if (m.fireball) env *= 1 + 1.8 * Math.exp(-((x - 0.8) ** 2) / 0.004); // a flare near the end
      if (head - tail < 1e-4 || env <= 0) {
        uMetA.value[i].w = 0;
        continue;
      }
      slerpDir(m.p0, m.p1, tail, tmpA);
      slerpDir(m.p0, m.p1, head, tmpB);
      uMetA.value[i].set(tmpA.x, tmpA.y, tmpA.z, m.peak * env * this.starLevel);
      uMetB.value[i].set(tmpB.x, tmpB.y, tmpB.z, m.width * (m.fireball ? 0.8 + 0.6 * env : 1));
      uMetC.value[i].set(m.color.r, m.color.g, m.color.b);
    }
  }
}

function isCubeTarget(renderer: THREE.WebGLRenderer) {
  return !!(renderer.getRenderTarget() as { isWebGLCubeRenderTarget?: boolean } | null)?.isWebGLCubeRenderTarget;
}

function targetHeight(renderer: THREE.WebGLRenderer) {
  const t = renderer.getRenderTarget();
  if (t) return t.height;
  return renderer.getContext().drawingBufferHeight;
}

// ------------------------------------------------------------------ orientation

/**
 * Galactic -> city rotation for a moment and place. City axes: x east, y up, -z north.
 * `lst` is the local sidereal time in radians, `lat` the latitude in radians.
 */
export function galacticToCity(lst: number, lat: number, out: THREE.Matrix4) {
  // An equatorial direction (RA a, Dec d) has hour angle H = lst - a; map it to east/up/north.
  const toCity = (x: number, y: number, z: number, v: THREE.Vector3) => {
    const ra = Math.atan2(y, x), dec = Math.asin(THREE.MathUtils.clamp(z, -1, 1));
    const H = lst - ra;
    const east = -Math.cos(dec) * Math.sin(H);
    const north = Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.cos(H) * Math.sin(lat);
    const up = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(H) * Math.cos(lat);
    return v.set(east, up, -north);
  };
  const gx = toCity(...EQ_TO_GAL[0], new THREE.Vector3());
  const gy = toCity(...EQ_TO_GAL[1], new THREE.Vector3());
  const gz = toCity(...EQ_TO_GAL[2], new THREE.Vector3());
  return out.makeBasis(gx, gy, gz);
}
