// GLSL for the hybrid ray tracer. Primary visibility is rasterized into a G-buffer; everything
// after that (shadows, reflections, one bounce of diffuse light) is traced against a BVH of the
// office plus analytic spheres for the Bloops.

import { BVHShaderGLSL } from "three-mesh-bvh";
import { CHAIR_STASH } from "./bake.ts";

export const MAX_BLOOPS = 64;
export const MAX_MOVING_CHAIRS = 8;
export const LIGHTS_PER_CELL = 24;

export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Shared tracing code: scene intersection, light sampling, BRDF helpers. */
export const RT_COMMON = /* glsl */ `
#define PI 3.14159265359
#define MAX_BLOOPS ${MAX_BLOOPS}
#define MAX_MOVING ${MAX_MOVING_CHAIRS}
#define LIGHTS_PER_CELL ${LIGHTS_PER_CELL}

${BVHShaderGLSL.common_functions}
${BVHShaderGLSL.bvh_struct_definitions}
${BVHShaderGLSL.bvh_ray_functions}

uniform BVH bvh;
uniform sampler2D attrNormal;
uniform sampler2D attrColor;   // rgb albedo, a emissive strength
uniform sampler2D attrMat;     // rough, metal, group, light-listed

uniform int uBloopCount;
uniform vec4 uBloopBody[MAX_BLOOPS];    // center, radius
uniform vec4 uBloopColor[MAX_BLOOPS];   // albedo, roughness
uniform vec4 uBloopBulb[MAX_BLOOPS];    // center, radius (0 = off)
uniform vec4 uBloopBulbColor[MAX_BLOOPS];

// Swivel chairs are baked facing their desks (rtMat.w = 2 + id). While one is turned, its baked
// copy is skipped and rays near it are moved into the frame of one chair stashed below the office.
uniform int uChairMoving;              // bit per chair id that is away from its baked pose
uniform int uMovCount;
uniform vec4 uMovA[MAX_MOVING];        // swivel axis now (xyz), chair id
uniform vec4 uMovB[MAX_MOVING];        // cos, sin of the chair's yaw
uniform vec4 uMovS[MAX_MOVING];        // bounding sphere now
#define CHAIR_STASH vec3(${CHAIR_STASH.x.toFixed(1)}, ${CHAIR_STASH.y.toFixed(1)}, ${CHAIR_STASH.z.toFixed(1)})

uniform float uGroupScale[8];
uniform samplerCube uEnv;
uniform float uEnvScale;
uniform float uEnvMaxLod;
uniform vec3 uAmbient;          // stand-in for bounces past the first

uniform sampler2D uLights;      // 4 texels per light (rows)
uniform sampler2D uLightGrid;   // LIGHTS_PER_CELL texels per cell (rows): light index or -1
uniform vec4 uGrid;             // minX, minZ, cell size, cells along x
uniform vec2 uGridSize;         // cells x, cells z
uniform vec3 uSunDir;
uniform vec3 uSunColor;         // already divided by PI
uniform float uSunCone;         // cos of the sun's angular radius, widened for soft shadows

struct Hit {
  float t;
  vec3 n;
  vec3 albedo;
  float emissive;
  float rough;
  float metal;
  float group;
  float lightFlag;
};

// ---------------------------------------------------------------- random
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rnd(inout uint s) {
  s = pcg(s);
  return float(s) * (1.0 / 4294967296.0);
}
vec2 rnd2(inout uint s) { return vec2(rnd(s), rnd(s)); }

float rtLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void basis(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float bb = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * bb, -s * n.x);
  b = vec3(bb, s + n.y * n.y * a, -n.y);
}

vec3 cosineSample(vec3 n, vec2 u) {
  vec3 t, b;
  basis(n, t, b);
  float r = sqrt(u.x);
  float phi = 2.0 * PI * u.y;
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u.x)));
}

// Heitz 2018, sampling the distribution of visible GGX normals.
vec3 sampleGGXVNDF(vec3 Ve, float alpha, vec2 u) {
  vec3 Vh = normalize(vec3(alpha * Ve.x, alpha * Ve.y, Ve.z));
  float lensq = Vh.x * Vh.x + Vh.y * Vh.y;
  vec3 T1 = lensq > 0.0 ? vec3(-Vh.y, Vh.x, 0.0) * inversesqrt(lensq) : vec3(1.0, 0.0, 0.0);
  vec3 T2 = cross(Vh, T1);
  float r = sqrt(u.x);
  float phi = 2.0 * PI * u.y;
  float t1 = r * cos(phi);
  float t2 = r * sin(phi);
  float s = 0.5 * (1.0 + Vh.z);
  t2 = (1.0 - s) * sqrt(max(0.0, 1.0 - t1 * t1)) + s * t2;
  vec3 Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
  return normalize(vec3(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
}

vec3 reflectGGX(vec3 N, vec3 V, float rough, vec2 u) {
  float alpha = max(rough * rough, 0.0015);
  vec3 t, b;
  basis(N, t, b);
  vec3 Ve = vec3(dot(V, t), dot(V, b), dot(V, N));
  vec3 H = sampleGGXVNDF(Ve, alpha, u);
  vec3 Hw = normalize(t * H.x + b * H.y + N * H.z);
  return reflect(-V, Hw);
}

vec3 envBRDFApprox(vec3 F0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return F0 * AB.x + AB.y;
}

vec3 envColor(vec3 dir, float rough) {
  return textureLod(uEnv, dir, rough * uEnvMaxLod).rgb * uEnvScale;
}

// ---------------------------------------------------------------- intersection
float sphereHit(vec3 ro, vec3 rd, vec4 s) {
  vec3 oc = ro - s.xyz;
  float c = dot(oc, oc) - s.w * s.w;
  if (c < 0.0) return -1.0; // starting inside: ignore (a surface point on the body itself)
  float b = dot(oc, rd);
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  return -b - sqrt(h);
}

vec3 rotY(vec3 v, float c, float s) { return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }

// Where a ray crosses a sphere (t0 clamped to 0).
bool sphereSpan(vec3 ro, vec3 rd, vec4 s, out float t0, out float t1) {
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  float h = b * b - (dot(oc, oc) - s.w * s.w);
  t0 = 0.0;
  t1 = -1.0;
  if (h < 0.0) return false;
  h = sqrt(h);
  t0 = max(-b - h, 0.0);
  t1 = -b + h;
  return t1 > 0.0;
}

// A ray near turned chair k, moved onto the stashed chair (same t along it).
void toChair(int k, vec3 ro, vec3 rd, out vec3 lo, out vec3 ld) {
  lo = rotY(ro - uMovA[k].xyz, uMovB[k].x, -uMovB[k].y) + CHAIR_STASH;
  ld = rotY(rd, uMovB[k].x, -uMovB[k].y);
}

// rtMat.w: 0 plain, 1 light-listed emitter, 2 + id a swivel chair (id 31: the stashed one).
// stash false: the office, minus chairs that are turned right now. stash true: only the stashed chair.
bool skipTri(float w, bool stash) {
  if (w < 1.5) return stash;
  int id = int(w - 2.0 + 0.5);
  if (id >= 31) return !stash;
  return stash || ((uChairMoving >> id) & 1) == 1;
}

// Nearest triangle closer than tMax (three-mesh-bvh's traversal, filtered by skipTri).
bool bvhFirst(bool stash, vec3 ro, vec3 rd, float tMax, out uvec4 fi, out vec3 fn, out vec3 bc, out float dist) {
  int ptr = 0;
  uint stack[BVH_STACK_DEPTH];
  stack[0] = 0u;
  dist = tMax;
  bool found = false;
  while (ptr > -1 && ptr < BVH_STACK_DEPTH) {
    uint node = stack[ptr];
    ptr--;
    float boundsDist;
    if (!intersectsBVHNodeBounds(ro, rd, bvh.bvhBounds, node, boundsDist) || boundsDist > dist) continue;
    uvec2 info = uTexelFetch1D(bvh.bvhContents, node).xy;
    if (bool(info.x & 0xffff0000u)) {
      uint count = info.x & 0x0000ffffu;
      uint offset = info.y;
      for (uint i = offset, l = offset + count; i < l; i++) {
        uvec3 idx = uTexelFetch1D(bvh.index, i).xyz;
        vec3 a = texelFetch1D(bvh.position, idx.x).rgb;
        vec3 b = texelFetch1D(bvh.position, idx.y).rgb;
        vec3 c = texelFetch1D(bvh.position, idx.z).rgb;
        vec3 bary, nrm;
        float d, s;
        if (intersectsTriangle(ro, rd, a, b, c, bary, nrm, d, s) && d < dist
            && !skipTri(texelFetch1D(attrMat, idx.x).w, stash)) {
          found = true;
          dist = d;
          fi = uvec4(idx, i);
          fn = nrm;
          bc = bary;
        }
      }
    } else {
      uint left = node + 1u;
      uint right = info.y;
      bool leftToRight = rd[info.x & 0x0000ffffu] >= 0.0;
      ptr++;
      stack[ptr] = leftToRight ? right : left;
      ptr++;
      stack[ptr] = leftToRight ? left : right;
    }
  }
  return found;
}

// Any blocker closer than tMax. Light-listed emitters don't block their own light.
bool bvhAny(bool stash, vec3 ro, vec3 rd, float tMax) {
  int ptr = 0;
  uint stack[BVH_STACK_DEPTH];
  stack[0] = 0u;
  while (ptr > -1 && ptr < BVH_STACK_DEPTH) {
    uint node = stack[ptr];
    ptr--;
    float boundsDist;
    if (!intersectsBVHNodeBounds(ro, rd, bvh.bvhBounds, node, boundsDist) || boundsDist > tMax) continue;
    uvec2 info = uTexelFetch1D(bvh.bvhContents, node).xy;
    if (bool(info.x & 0xffff0000u)) {
      uint count = info.x & 0x0000ffffu;
      uint offset = info.y;
      for (uint i = offset, l = offset + count; i < l; i++) {
        uvec3 idx = uTexelFetch1D(bvh.index, i).xyz;
        vec3 a = texelFetch1D(bvh.position, idx.x).rgb;
        vec3 b = texelFetch1D(bvh.position, idx.y).rgb;
        vec3 c = texelFetch1D(bvh.position, idx.z).rgb;
        vec3 bary, nrm;
        float d, s;
        if (intersectsTriangle(ro, rd, a, b, c, bary, nrm, d, s) && d > 1e-4 && d < tMax) {
          float w = texelFetch1D(attrMat, idx.x).w;
          if ((w < 0.5 || w > 1.5) && !skipTri(w, stash)) return true;
        }
      }
    } else {
      uint left = node + 1u;
      uint right = info.y;
      ptr++;
      stack[ptr] = right;
      ptr++;
      stack[ptr] = left;
    }
  }
  return false;
}

bool traceScene(vec3 ro, vec3 rd, out Hit h) {
  h.t = 1e20;
  h.n = vec3(0.0, 1.0, 0.0);
  h.albedo = vec3(0.0);
  h.emissive = 0.0;
  h.rough = 1.0;
  h.metal = 0.0;
  h.group = 0.0;
  h.lightFlag = 0.0;
  bool found = false;
  uvec4 fi;
  vec3 fn, bc;
  float dist;
  int mov = -1;
  found = bvhFirst(false, ro, rd, 1e20, fi, fn, bc, dist);
  for (int k = 0; k < MAX_MOVING; k++) {
    if (k >= uMovCount) break;
    float t0, t1;
    if (!sphereSpan(ro, rd, uMovS[k], t0, t1) || (found && t0 > dist)) continue;
    vec3 lo, ld;
    toChair(k, ro, rd, lo, ld);
    uvec4 fi2;
    vec3 fn2, bc2;
    float d2;
    if (bvhFirst(true, lo, ld, found ? min(dist, t1) : t1, fi2, fn2, bc2, d2)) {
      found = true;
      fi = fi2; fn = fn2; bc = bc2; dist = d2;
      mov = k;
    }
  }
  if (found) {
    h.t = dist;
    vec3 sn = textureSampleBarycoord(attrNormal, bc, fi.xyz).xyz;
    sn = dot(sn, sn) > 1e-8 ? normalize(sn) : fn;
    if (mov >= 0) sn = rotY(sn, uMovB[mov].x, uMovB[mov].y);
    vec4 c = texelFetch1D(attrColor, fi.x);
    vec4 m = texelFetch1D(attrMat, fi.x);
    if (dot(sn, rd) > 0.0) sn = -sn;
    h.n = sn;
    h.albedo = c.rgb;
    h.emissive = c.a;
    h.rough = m.x;
    h.metal = m.y;
    h.group = m.z;
    h.lightFlag = m.w > 1.5 ? 0.0 : m.w;
  }
  for (int i = 0; i < MAX_BLOOPS; i++) {
    if (i >= uBloopCount) break;
    float t = sphereHit(ro, rd, uBloopBody[i]);
    if (t > 0.0 && t < h.t) {
      found = true;
      h.t = t;
      h.n = normalize(ro + rd * t - uBloopBody[i].xyz);
      h.albedo = uBloopColor[i].rgb;
      h.rough = uBloopColor[i].a;
      h.emissive = 0.0;
      h.metal = 0.0;
      h.group = 0.0;
      h.lightFlag = 0.0;
    }
    if (uBloopBulb[i].w > 0.0) {
      t = sphereHit(ro, rd, uBloopBulb[i]);
      if (t > 0.0 && t < h.t) {
        found = true;
        h.t = t;
        h.n = normalize(ro + rd * t - uBloopBulb[i].xyz);
        h.albedo = uBloopBulbColor[i].rgb;
        h.emissive = 1.0;
        h.rough = 0.3;
        h.metal = 0.0;
        h.group = 5.0;
        h.lightFlag = 1.0;
      }
    }
  }
  return found;
}

// Any-hit test for shadow rays: Bloops, the office, and chairs that are turned right now.
bool occluded(vec3 ro, vec3 rd, float tMax) {
  for (int i = 0; i < MAX_BLOOPS; i++) {
    if (i >= uBloopCount) break;
    float t = sphereHit(ro, rd, uBloopBody[i]);
    if (t > 0.0 && t < tMax) return true;
  }
  if (bvhAny(false, ro, rd, tMax)) return true;
  for (int k = 0; k < MAX_MOVING; k++) {
    if (k >= uMovCount) break;
    float t0, t1;
    if (!sphereSpan(ro, rd, uMovS[k], t0, t1) || t0 > tMax) continue;
    vec3 lo, ld;
    toChair(k, ro, rd, lo, ld);
    if (bvhAny(true, lo, ld, min(tMax, t1))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- lights
// Unshadowed light sample, as reflected radiance per unit albedo (Lambert, /PI folded in).
vec3 lightSample(int li, vec3 P, vec3 N, vec2 u, out vec3 L, out float dist) {
  vec4 t0 = texelFetch(uLights, ivec2(0, li), 0);
  vec4 t1 = texelFetch(uLights, ivec2(1, li), 0);
  vec4 t2 = texelFetch(uLights, ivec2(2, li), 0);
  vec4 t3 = texelFetch(uLights, ivec2(3, li), 0);
  vec3 rad = t1.rgb * uGroupScale[int(t1.a)];
  if (t0.w < 0.5) {
    vec3 pos = t0.xyz + t2.xyz * (2.0 * u.x - 1.0) + t3.xyz * (2.0 * u.y - 1.0);
    vec3 d = pos - P;
    float d2 = max(dot(d, d), 1e-4);
    dist = sqrt(d2);
    L = d / dist;
    vec3 ln = cross(t2.xyz, t3.xyz);
    float area = 4.0 * length(ln);
    ln = normalize(ln);
    float cosL = -dot(ln, L);
    if (t3.w > 0.5) cosL = abs(cosL);
    float cosS = dot(N, L);
    if (cosL <= 0.0 || cosS <= 0.0) return vec3(0.0);
    return rad * (cosS * cosL * area / (max(d2, area * 0.25) * PI));
  }
  float r = t2.x;
  vec3 w = t0.xyz - P;
  float dc2 = dot(w, w);
  w = normalize(w);
  vec3 tt, bb;
  basis(w, tt, bb);
  float rr = r * sqrt(u.x);
  float phi = 2.0 * PI * u.y;
  vec3 pos = t0.xyz + (tt * cos(phi) + bb * sin(phi)) * rr;
  vec3 d = pos - P;
  float d2 = max(dot(d, d), 1e-4);
  dist = sqrt(d2);
  L = d / dist;
  float cosS = dot(N, L);
  if (cosS <= 0.0) return vec3(0.0);
  return rad * (cosS * r * r / max(dc2, r * r * 4.0));
}

int cellIndex(vec3 P) {
  vec2 c = floor((P.xz - uGrid.xy) / uGrid.z);
  c = clamp(c, vec2(0.0), uGridSize - 1.0);
  return int(c.y * uGridSize.x + c.x);
}

// Picks one light from this cell's list in proportion to its unshadowed contribution
// (resampled importance sampling), then traces a shadow ray to it.
vec3 sampleLights(vec3 P, vec3 N, int candidates, inout uint seed) {
  int cell = cellIndex(P);
  float wSum = 0.0;
  vec3 chosen = vec3(0.0);
  float chosenW = 0.0;
  vec3 chosenL = vec3(0.0);
  float chosenDist = 0.0;
  int m = 0;
  for (int k = 0; k < LIGHTS_PER_CELL; k++) {
    if (k >= candidates) break;
    int slot = candidates >= LIGHTS_PER_CELL ? k : int(rnd(seed) * float(LIGHTS_PER_CELL));
    float idx = texelFetch(uLightGrid, ivec2(slot, cell), 0).r;
    m++;
    if (idx < 0.0) continue;
    vec3 L;
    float dist;
    vec3 c = lightSample(int(idx), P, N, rnd2(seed), L, dist);
    float target = rtLum(c);
    float w = target * float(LIGHTS_PER_CELL); // target / source pdf (uniform over the cell's list)
    if (w <= 0.0) continue;
    wSum += w;
    if (rnd(seed) * wSum < w) {
      chosen = c;
      chosenW = target;
      chosenL = L;
      chosenDist = dist;
    }
  }
  if (chosenW <= 0.0) return vec3(0.0);
  vec3 o = P + N * 0.002;
  if (occluded(o, chosenL, chosenDist * 0.995 - 0.004)) return vec3(0.0);
  return chosen * (wSum / float(max(m, 1))) / chosenW;
}

vec3 sampleSun(vec3 P, vec3 N, inout uint seed) {
  if (uSunColor.r + uSunColor.g + uSunColor.b <= 0.0) return vec3(0.0);
  vec3 t, b;
  basis(uSunDir, t, b);
  vec2 u = rnd2(seed);
  float cosT = mix(1.0, uSunCone, u.x);
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  float phi = 2.0 * PI * u.y;
  vec3 L = normalize(t * (sinT * cos(phi)) + b * (sinT * sin(phi)) + uSunDir * cosT);
  float c = dot(N, L);
  if (c <= 0.0) return vec3(0.0);
  if (occluded(P + N * 0.002, L, 1e4)) return vec3(0.0);
  return uSunColor * c;
}

// Radiance leaving a secondary hit toward the ray's origin.
vec3 shadeHit(Hit h, vec3 P, vec3 rd, bool countLights, int candidates, inout uint seed) {
  vec3 L = vec3(0.0);
  if (h.emissive > 0.0 && (countLights || h.lightFlag < 0.5)) L += h.albedo * h.emissive * uGroupScale[int(h.group)];
  vec3 diff = h.albedo * (1.0 - h.metal);
  vec3 E = vec3(0.0);
  if (dot(diff, diff) > 1e-6 || h.metal > 0.5) E = sampleLights(P, h.n, candidates, seed) + sampleSun(P, h.n, seed) + uAmbient;
  L += diff * E;
  if (h.metal > 0.0 || h.rough < 0.3) {
    vec3 F0 = mix(vec3(0.04), h.albedo, h.metal);
    vec3 R = reflect(rd, h.n);
    // One bounce can't follow metal-to-metal paths. The outdoor environment alone is far too dark
    // indoors (black at night), which left steel and chrome speckled: add what the metal's
    // surroundings would reflect, from the light arriving here.
    vec3 seen = h.metal > 0.5 ? envColor(R, h.rough) + E * 0.45 : uAmbient * 2.0;
    L += envBRDFApprox(F0, h.rough, max(dot(h.n, -rd), 0.0)) * seen;
  }
  return L;
}

// Cheap, noise-free shading for single-sample reflections (glass).
vec3 shadeHitFlat(Hit h, vec3 rd) {
  vec3 L = vec3(0.0);
  if (h.emissive > 0.0) L += h.albedo * h.emissive * uGroupScale[int(h.group)];
  float facing = 0.55 + 0.45 * max(dot(h.n, vec3(0.0, 1.0, 0.0)), 0.0);
  L += h.albedo * (1.0 - h.metal) * (uAmbient * 6.0 * facing);
  if (h.metal > 0.5) L += h.albedo * envColor(reflect(rd, h.n), h.rough);
  return L;
}
`;

// ---------------------------------------------------------------- G-buffer
export const GBUFFER_VERT = /* glsl */ `
out vec3 vN;
out vec2 vUv;
out vec3 vCol;
uniform mat3 uvTransform;
void main() {
  mat4 m = modelMatrix;
#ifdef USE_INSTANCING
  m = m * instanceMatrix;
#endif
  vN = normalize(transpose(inverse(mat3(m))) * normal);
  vCol = vec3(1.0);
#ifdef USE_INSTANCING_COLOR
  vCol *= instanceColor;
#endif
#ifdef USE_COLOR
  vCol *= color.rgb;
#endif
  vUv = (uvTransform * vec3(uv, 1.0)).xy;
  gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
}
`;

export const GBUFFER_FRAG = /* glsl */ `
layout(location = 0) out vec4 gAlbedo;
layout(location = 1) out vec4 gNormal;
layout(location = 2) out vec4 gMat;
in vec3 vN;
in vec2 vUv;
in vec3 vCol;
uniform vec3 uColor;
uniform float uEmissive;
uniform float uRough;
uniform float uMetal;
uniform float uGroup;
uniform float uF0;
uniform float uDynamic;
#ifdef HAS_MAP
uniform sampler2D uMap;
#endif
void main() {
  vec3 alb = uColor * vCol;
#ifdef HAS_MAP
  vec4 t = texture(uMap, vUv);
  if (t.a < 0.5) discard;
  alb *= t.rgb;
#endif
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  gAlbedo = vec4(alb, uEmissive);
  gNormal = vec4(n, uRough);
  gMat = vec4(uMetal, uGroup, uF0, uDynamic);
}
`;

// ---------------------------------------------------------------- trace
const GBUFFER_READ = /* glsl */ `
in vec2 vUv;
uniform sampler2D gAlbedo;
uniform sampler2D gNormal;
uniform sampler2D gMat;
uniform sampler2D gDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uNear;
uniform float uFar;

vec3 worldPos(vec2 uv, float depth) {
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  v /= v.w;
  return (uCamWorld * v).xyz;
}
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
`;

export const TRACE_FRAG = /* glsl */ `
layout(location = 0) out vec4 oDiffuse;
layout(location = 1) out vec4 oSpec;
${RT_COMMON}
${GBUFFER_READ}
uniform uint uFrame;
uniform vec2 uRes;
uniform int uSpecular;
uniform int uGI;
uniform sampler2D prevColor;   // last frame's lit, denoised office (HDR)
uniform sampler2D prevDepth;
uniform sampler2D prevNormal;
uniform mat4 uPrevViewProj;
uniform int uReuse;

// If a ray's hit point was on screen last frame, reuse that pixel's finished colour:
// noise-free, textured, and it already contains its own reflections (extra bounces for free).
bool screenReuse(vec3 Hp, vec3 hn, out vec3 c) {
  if (uReuse == 0) return false;
  vec4 pc = uPrevViewProj * vec4(Hp, 1.0);
  if (pc.w <= 0.0) return false;
  vec2 uv = pc.xy / pc.w * 0.5 + 0.5;
  if (any(lessThan(uv, vec2(0.002))) || any(greaterThan(uv, vec2(0.998)))) return false;
  float d = textureLod(prevDepth, uv, 0.0).r;
  if (d >= 1.0) return false;
  float expect = linearDepth(pc.z / pc.w * 0.5 + 0.5);
  if (abs(linearDepth(d) - expect) > 0.015 * expect + 0.02) return false;
  if (abs(dot(textureLod(prevNormal, uv, 0.0).xyz, hn)) < 0.7) return false;
  c = textureLod(prevColor, uv, 0.0).rgb;
  return true;
}

void main() {
  float depth = texture(gDepth, vUv).r;
  if (depth >= 1.0) {
    oDiffuse = vec4(0.0);
    oSpec = vec4(0.0);
    return;
  }
  uvec2 px = uvec2(gl_FragCoord.xy);
  uint seed = pcg(px.x + pcg(px.y + pcg(uFrame)));
  vec4 nr = texture(gNormal, vUv);
  vec4 mat = texture(gMat, vUv);
  vec3 alb = texture(gAlbedo, vUv).rgb;
  vec3 N = normalize(nr.xyz);
  float rough = nr.w;
  float metal = mat.x;
  vec3 P = worldPos(vUv, depth);
  vec3 V = normalize(uCamPos - P);
  if (dot(N, V) < 0.0) N = -N;
  vec3 O = P + N * (0.0015 + 0.0006 * length(uCamPos - P));

  // Direct light: every light that matters here, resampled down to one shadow ray, plus the sun.
  vec3 diffuse = sampleLights(O, N, LIGHTS_PER_CELL, seed) + sampleSun(O, N, seed);

  // One bounce of indirect light (clamped so a lucky ray into a lamp doesn't leave a firefly).
  if (uGI == 1) {
    vec3 dir = cosineSample(N, rnd2(seed));
    Hit h;
    vec3 gi;
    if (traceScene(O, dir, h)) {
      vec3 Hp = O + dir * h.t;
      // Light-listed emitters are already counted by direct lighting: don't reuse their glow.
      if (h.lightFlag > 0.5 || !screenReuse(Hp, h.n, gi)) gi = shadeHit(h, Hp, dir, false, 4, seed);
    } else gi = envColor(dir, 0.6);
    float l = rtLum(gi);
    diffuse += l > 3.0 ? gi * (3.0 / l) : gi;
  } else {
    diffuse += uAmbient * 3.0;
  }

  // Reflection. Alpha carries the hit distance so the temporal pass can reproject the
  // reflected image (not the surface) for mirror-like floors.
  vec3 spec;
  float hitDist = 0.0;
  if (uSpecular == 1 && rough < 0.8) {
    vec3 R = reflectGGX(N, V, rough, rnd2(seed));
    if (dot(R, N) <= 0.0) R = reflect(-V, N);
    Hit h;
    if (traceScene(O, R, h)) {
      vec3 Hp = O + R * h.t;
      if (!screenReuse(Hp, h.n, spec)) spec = shadeHit(h, Hp, R, true, 16, seed);
      hitDist = h.t;
    } else {
      spec = envColor(R, rough);
      hitDist = 200.0;
    }
    float l = rtLum(spec);
    spec = l > 24.0 ? spec * (24.0 / l) : spec;
  } else {
    spec = diffuse;
  }
  oDiffuse = vec4(diffuse, 1.0);
  oSpec = vec4(spec, hitDist);
}
`;

// ---------------------------------------------------------------- temporal accumulation
export const TEMPORAL_FRAG = /* glsl */ `
layout(location = 0) out vec4 oDiffuse;
layout(location = 1) out vec4 oSpec;
${GBUFFER_READ}
uniform sampler2D tDiffuse;
uniform sampler2D tSpec;
uniform sampler2D hDiffuse;
uniform sampler2D hSpec;
uniform sampler2D pNormal;
uniform sampler2D pDepth;
uniform mat4 uPrevViewProj;
uniform float uMaxHistory;
uniform vec2 uTexel;

void main() {
  float depth = texture(gDepth, vUv).r;
  vec3 cd = texture(tDiffuse, vUv).rgb;
  vec3 cs = texture(tSpec, vUv).rgb;
  if (depth >= 1.0) {
    oDiffuse = vec4(0.0);
    oSpec = vec4(0.0);
    return;
  }
  vec4 nr = texture(gNormal, vUv);
  vec4 mat = texture(gMat, vUv);

  // Firefly (and dark speck) rejection: pull this frame's samples into the range of their
  // 8 neighbours (mean ± 2σ), so one lucky or unlucky ray can't survive the edge-aware filter.
  vec3 m1d = vec3(0.0), m2d = vec3(0.0), m1s = vec3(0.0), m2s = vec3(0.0);
  vec3 lo = vec3(1e9), hi = vec3(-1e9);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      vec2 o = vUv + vec2(x, y) * uTexel;
      vec3 d = texture(tDiffuse, o).rgb;
      vec3 s = texture(tSpec, o).rgb;
      m1d += d; m2d += d * d;
      m1s += s; m2s += s * s;
      lo = min(lo, s); hi = max(hi, s);
    }
  m1d /= 8.0; m2d /= 8.0; m1s /= 8.0; m2s /= 8.0;
  vec3 sdD = sqrt(max(m2d - m1d * m1d, 0.0)) * 2.0 + m1d * 0.1 + 0.004;
  vec3 sdS = sqrt(max(m2s - m1s * m1s, 0.0)) * 2.0 + m1s * 0.1 + 0.004;
  cd = clamp(cd, m1d - sdD, m1d + sdD);
  cs = clamp(cs, m1s - sdS, m1s + sdS);
  lo = min(lo, cs);
  hi = max(hi, cs);

  vec3 P = worldPos(vUv, depth);
  vec4 pc = uPrevViewProj * vec4(P, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float expect = linearDepth(pc.z / pc.w * 0.5 + 0.5);
  bool valid = all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)));
  if (valid) {
    float pd = linearDepth(texture(pDepth, puv).r);
    vec3 pn = texture(pNormal, puv).xyz;
    valid = abs(pd - expect) < 0.03 * expect + 0.02 && dot(pn, nr.xyz) > 0.85;
  }
  vec4 hd = valid ? texture(hDiffuse, puv) : vec4(0.0);
  float dynamicPx = mat.w > 0.5 ? 1.0 : 0.0;
  float maxD = mix(uMaxHistory, 4.0, dynamicPx);
  float lenD = min(hd.a + 1.0, maxD);

  // Sharp reflections move with the eye, not the surface. Reproject them through the
  // reflected point's virtual image (behind the mirror) instead of the surface point.
  float rough = nr.w;
  float hitDist = texture(tSpec, vUv).a;
  vec2 suv = puv;
  bool sValid = valid;
  if (rough < 0.3 && hitDist > 0.0) {
    vec3 Pv = P + normalize(P - uCamPos) * hitDist;
    vec4 vc = uPrevViewProj * vec4(Pv, 1.0);
    suv = vc.xy / vc.w * 0.5 + 0.5;
    sValid = vc.w > 0.0 && all(greaterThanEqual(suv, vec2(0.0))) && all(lessThanEqual(suv, vec2(1.0)));
    if (sValid) sValid = dot(texture(pNormal, suv).xyz, nr.xyz) > 0.95;
  }
  vec4 hs = sValid ? texture(hSpec, suv) : vec4(0.0);
  float maxS = mix(20.0, uMaxHistory, smoothstep(0.1, 0.45, rough));
  maxS = mix(maxS, 3.0, dynamicPx);
  if (uMaxHistory <= 1.0) maxS = 1.0;
  float lenS = min(hs.a + 1.0, maxS);
  vec3 hsC = hs.rgb;
  if (rough < 0.35) {
    vec3 pad = (hi - lo) * 0.25 + 0.02;
    hsC = clamp(hsC, lo - pad, hi + pad);
  }
  oDiffuse = vec4(mix(hd.rgb, cd, 1.0 / lenD), lenD);
  oSpec = vec4(mix(hsC, cs, 1.0 / lenS), lenS);
}
`;

// ---------------------------------------------------------------- edge-aware a-trous filter
export const ATROUS_FRAG = /* glsl */ `
layout(location = 0) out vec4 oDiffuse;
layout(location = 1) out vec4 oSpec;
${GBUFFER_READ}
uniform sampler2D tDiffuse;
uniform sampler2D tSpec;
uniform vec2 uTexel;
uniform float uStep;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  float depth = texture(gDepth, vUv).r;
  vec4 d0 = texture(tDiffuse, vUv);
  vec4 s0 = texture(tSpec, vUv);
  if (depth >= 1.0) {
    oDiffuse = d0;
    oSpec = s0;
    return;
  }
  vec4 nr = texture(gNormal, vUv);
  vec3 n = nr.xyz;
  float rough = nr.w;
  float z = linearDepth(depth);
  float hist = max(d0.a, 1.0);
  float lD = lum(d0.rgb);
  float lS = lum(s0.rgb);
  float sigL = 0.25 + 4.0 / hist;
  float specBlur = smoothstep(0.06, 0.3, rough);
  const float k[3] = float[3](3.0 / 8.0, 1.0 / 4.0, 1.0 / 16.0);
  vec3 accD = vec3(0.0), accS = vec3(0.0);
  float wD = 0.0, wS = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 uv = vUv + vec2(x, y) * uTexel * uStep;
      float dq = textureLod(gDepth, uv, 0.0).r;
      if (dq >= 1.0) continue;
      vec4 nq = textureLod(gNormal, uv, 0.0);
      float zq = linearDepth(dq);
      float w = k[abs(x)] * k[abs(y)];
      w *= pow(max(dot(n, nq.xyz), 0.0), 48.0);
      w *= exp(-abs(zq - z) / (0.015 * z * uStep + 0.01));
      vec3 cd = textureLod(tDiffuse, uv, 0.0).rgb;
      vec3 cs = textureLod(tSpec, uv, 0.0).rgb;
      float wd = w * exp(-abs(lum(cd) - lD) / (sigL * (lD + 0.05)));
      // Rough reflections should look smooth, so their brightness test is looser: otherwise a
      // mix of bright and dark one-sample rays survives as speckle.
      float ws = w * specBlur * exp(-abs(nq.w - rough) * 12.0) * exp(-abs(lum(cs) - lS) / ((sigL + 2.0 * specBlur) * (lS + 0.05)));
      if (x == 0 && y == 0) ws = w;
      accD += cd * wd;
      wD += wd;
      accS += cs * ws;
      wS += ws;
    }
  }
  oDiffuse = vec4(accD / max(wD, 1e-6), d0.a);
  oSpec = vec4(accS / max(wS, 1e-6), s0.a);
}
`;

// ---------------------------------------------------------------- composite
export const COMPOSITE_FRAG = /* glsl */ `
${GBUFFER_READ}
uniform sampler2D fDiffuse;
uniform sampler2D fSpec;
uniform float uGroupScale[8];
uniform int uView;
out vec4 oColor;

vec3 envBRDF(vec3 F0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return F0 * AB.x + AB.y;
}

void main() {
  float depth = texture(gDepth, vUv).r;
  if (depth >= 1.0) discard;
  vec4 a = texture(gAlbedo, vUv);
  vec4 nr = texture(gNormal, vUv);
  vec4 mat = texture(gMat, vUv);
  vec3 P = worldPos(vUv, depth);
  vec3 V = normalize(uCamPos - P);
  vec3 N = normalize(nr.xyz);
  float NoV = clamp(abs(dot(N, V)), 0.0, 1.0);
  vec3 diff = texture(fDiffuse, vUv).rgb;
  vec3 spec = texture(fSpec, vUv).rgb;
  vec3 F0 = mix(vec3(mat.z), a.rgb, mat.x);
  vec3 F = envBRDF(F0, nr.w, NoV);
  vec3 emit = a.rgb * a.a * uGroupScale[int(mat.y + 0.5)];
  vec3 col = emit + a.rgb * (1.0 - mat.x) * diff * (1.0 - F * (1.0 - mat.x)) + spec * F;
  if (uView == 1) col = diff;
  else if (uView == 2) col = spec * F + emit;
  else if (uView == 3) col = N * 0.5 + 0.5;
  else if (uView == 4) col = vec3(nr.w, mat.x, mat.z * 5.0);
  oColor = vec4(col, 1.0);
  gl_FragDepth = depth;
}
`;

// ---------------------------------------------------------------- ray-traced glass
export const GLASS_VERT = /* glsl */ `
out vec3 vWorld;
out vec3 vN;
void main() {
  mat4 m = modelMatrix;
#ifdef USE_INSTANCING
  m = m * instanceMatrix;
#endif
  vec4 w = m * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = normalize(transpose(inverse(mat3(m))) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const GLASS_FRAG = /* glsl */ `
${RT_COMMON}
in vec3 vWorld;
in vec3 vN;
uniform vec3 uCamPos;
uniform vec3 uTint;
uniform float uOpacity;
uniform float uTintLevel;
out vec4 oColor;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vWorld);
  if (dot(N, V) < 0.0) N = -N;
  vec3 R = reflect(-V, N);
  Hit h;
  vec3 refl = traceScene(vWorld + N * 0.01, R, h) ? shadeHitFlat(h, R) : envColor(R, 0.0);
  float c = 1.0 - max(dot(N, V), 0.0);
  float F = 0.04 + 0.96 * c * c * c * c * c;
  vec3 tint = uTint * uOpacity * uTintLevel;
  float alpha = F + (1.0 - F) * uOpacity * 0.6;
  oColor = vec4(refl * F + tint * (1.0 - F), alpha);
}
`;
