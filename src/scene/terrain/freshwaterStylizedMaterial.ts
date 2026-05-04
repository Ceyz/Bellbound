import * as THREE from 'three';

/**
 * Freshwater (river / pond) shader — calmer, coherent global flow.
 *
 * v2/v3 used per-cell flow directions (cascade-exit cells flowed toward
 * the cascade) which read as chaotic motion across a multi-cell pond,
 * and hash-grid sun glints which read as PIXELATED WHITE SQUARES not
 * real reflections.
 *
 * v4 simplifies to a SINGLE GLOBAL CURRENT DIRECTION advecting all
 * noise samples uniformly. Everything in the surface drifts with the
 * same coherent flow, so the eye reads ONE current — not a swirl of
 * conflicting directions. Specular highlights are smooth-noise bands
 * ELONGATED along the flow axis (sky/sun reflection look) — no
 * floor()-aligned hash squares.
 *
 *   1. **3-stop teal palette** mottled by 3-octave FBM, all advecting
 *      along the global flow.
 *   2. **Specular reflection bands** stretched along the flow axis.
 *      Smooth-noise based, with a SOFT smoothstep threshold so they
 *      read as elongated highlights, not square cells.
 *   3. **Voronoi caustics** for dappled depth (same algo as the ocean
 *      shader, dialed gentler).
 *   4. **Subtle micro-ripples** at high frequency, masked by noise so
 *      they aren't perfectly straight.
 *   5. **Breathing brightness** — gentle 0.4 Hz undulation.
 */

interface FreshwaterUniforms {
  uTime: THREE.IUniform<number>;
  uSunIntensity: THREE.IUniform<number>;
}

export function createFreshwaterStylizedMaterial(): THREE.MeshStandardMaterial {
  const uniforms: FreshwaterUniforms = {
    uTime: { value: 0 },
    uSunIntensity: { value: 1.0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    depthWrite: true,
    emissive: 0xffffff,
    metalness: 0,
    opacity: 1.0,
    roughness: 1.0,
    side: THREE.DoubleSide,
    transparent: false,
  });
  material.name = 'freshwater-stylized';
  material.userData.freshwaterUniforms = uniforms;

  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${VERTEX_HEADER}`,
    ).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${VERTEX_BODY}`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${FRAGMENT_HEADER}`,
    ).replace(
      '#include <map_fragment>',
      FRAGMENT_BODY,
    ).replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance = freshwaterColor;',
    );
  };

  material.customProgramCacheKey = () => 'freshwater-stylized:v9-fewer-stars';
  material.needsUpdate = true;

  return material;
}

export function updateFreshwaterStylizedMaterial(
  material: THREE.MeshStandardMaterial,
  elapsed: number,
  sunIntensity = 1.0,
) {
  const uniforms = material.userData.freshwaterUniforms as FreshwaterUniforms | undefined;
  if (!uniforms) return;
  uniforms.uTime.value = elapsed;
  uniforms.uSunIntensity.value = sunIntensity;
}

const VERTEX_HEADER = `
varying vec2 vFreshwaterWorldXZ;
`;

const VERTEX_BODY = `
vec3 _fwWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFreshwaterWorldXZ = _fwWorldPos.xz;
`;

const FRAGMENT_HEADER = `
varying vec2 vFreshwaterWorldXZ;
uniform float uTime;
uniform float uSunIntensity;

float fwHash(vec2 p) {
  return fract(sin(dot(p, vec2(41.7, 289.3))) * 23857.5453);
}

float fwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fwHash(i);
  float b = fwHash(i + vec2(1.0, 0.0));
  float c = fwHash(i + vec2(0.0, 1.0));
  float d = fwHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Voronoi distance — same 3x3 scan as the ocean shader (cell interiors
// bright, boundaries dark). Used for the dappled caustic pattern.
float fwVoronoi(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float minDist = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 off = vec2(float(x), float(y));
      vec2 cellPt = off + vec2(fwHash(ip + off), fwHash(ip + off + vec2(1.7, 5.3)));
      float d = length(cellPt - fp);
      minDist = min(minDist, d);
    }
  }
  return minDist;
}

float fwCaustic(vec2 wxz, float t) {
  vec2 a = wxz * 1.05 + vec2(t * 0.10, -t * 0.07);
  vec2 b = wxz * 0.78 + vec2(-t * 0.06, t * 0.09);
  float va = fwVoronoi(a);
  float vb = fwVoronoi(b);
  return smoothstep(0.18, 0.55, va) * smoothstep(0.16, 0.50, vb);
}
`;

// ACNH-inspired calm water with REAL specular reflections — discrete
// bright BLOBS scattered across the surface (not continuous stripes
// or hash squares), each shaped as a horizontally elongated ellipse
// with smooth Gaussian falloff. Mimics how sun catches rippled water:
// a few small bright spots, sparse, stretched along the horizontal
// because the camera-to-sun line is mostly horizontal in our stylised
// view.
//
// Composition:
//   1. **Dark navy base** — closer to ACNH still water, no bright cyan
//   2. **Slow coherent drift** in a single global direction (4 cm/s)
//   3. **Specular blobs** — 3×3 cell scan finds the nearest blob
//      centre, anisotropic distance (x compressed → blob looks long
//      horizontally), Gaussian intensity, sparse threshold so only
//      ~25 % of cells host a visible blob
//   4. **Subtle Voronoi caustics** for sub-surface dappling
const FRAGMENT_BODY = `
vec2 wxz = vFreshwaterWorldXZ;

// Slow coherent drift — calm pond / lazy river feel. ~4 cm/s in
// world space. All noise samples and the blob field advect along this.
vec2 drift = vec2(1.0, 0.4) * uTime * 0.04;

// Multi-octave color base — dark navy with subtle variation.
float n0 = fwNoise(wxz * 0.11 + drift * 1.0);
float n1 = fwNoise(wxz * 0.28 + drift * 0.7);
float n2 = fwNoise(wxz * 0.62 + drift * 0.4);
float colorBlend = clamp(n0 * 0.60 + n1 * 0.28 + n2 * 0.12, 0.0, 1.0);

// Dark-navy palette — closer to ACNH still water than the previous
// bright cyan. The surface stays mostly dark, with subtle midtone
// variation; brightness comes from the blobs, not the base color.
vec3 deepWater = vec3(0.04, 0.18, 0.36);
vec3 midWater  = vec3(0.10, 0.36, 0.58);
vec3 highWater = vec3(0.30, 0.62, 0.80);
vec3 freshwaterColor = mix(deepWater, midWater, smoothstep(0.0, 0.70, colorBlend));
freshwaterColor = mix(freshwaterColor, highWater, smoothstep(0.65, 0.95, colorBlend) * 0.32);

// Subtle Voronoi caustics — gentle dappled shimmer beneath the surface.
// Drifts independently of the global flow so the dappling feels
// distinct from the specular blobs above it.
float caustic = fwCaustic(wxz * 0.7 + drift * 0.3, uTime);
freshwaterColor += vec3(0.04, 0.08, 0.10) * caustic * 0.45;

// REAL SPECULAR REFLECTIONS — sun glints as 4-POINT STARS (bright
// centre + horizontal & vertical streaks), like the lens-flare-shape
// you get when sunlight catches a tiny ripple on real water. Each
// star has independent randomised behaviour:
//
//   - LIFETIME 1.5-3.5 s, sin-arch envelope (fade in, peak, fade out)
//   - PER-CYCLE POSITION reseeded by floor(uTime/lifetime) → when a
//     star expires it does NOT respawn at the same spot; a fresh
//     cycle picks a new in-cell position from a new hash branch
//   - PER-CYCLE EXISTENCE — different subset of cells host a star
//     each cycle (so even cells that produced a star last time often
//     stay dark next time)
//   - PER-CYCLE VELOCITY — every star drifts a few cm during its
//     life in a unique random direction (motion isn't the global
//     flow, it's per-glint)
//   - PER-CYCLE SIZE — varies the falloff exponent so stars look
//     unique each spawn
//   - SUN GATE — uSunIntensity → no stars at night
//
// Cell scale 0.30/m (cells ~3.3 m apart, was 2.4 m). Existence
// threshold @ 0.78 → only ~22 % of cells host a star per cycle (was
// 45 %). Combined with the sin lifetime envelope (only ~50 % of the
// cycle is in the bright phase), typical view shows 1-2 active
// stars at any moment — discreet ACNH-feel, not a swarm.
vec2 blobGrid = wxz * 0.30 + drift * 1.5;
vec2 ip = floor(blobGrid);
vec2 fp = fract(blobGrid);
float blobBright = 0.0;
for (int dy = -1; dy <= 1; dy++) {
  for (int dx = -1; dx <= 1; dx++) {
    vec2 cellOff = vec2(float(dx), float(dy));
    vec2 ic = ip + cellOff;

    // Lifetime parameters — these are STABLE per cell (so the cell's
    // tempo is consistent, just the star's position/existence/size
    // changes each cycle).
    float lifetimeSeed = fwHash(ic + vec2(19.7, 23.1));
    float lifetime = 1.5 + lifetimeSeed * 2.0;
    float phaseOffset = fwHash(ic + vec2(29.3, 31.7));
    float spawnRaw = uTime / lifetime + phaseOffset;
    float cycleIdx = floor(spawnRaw);
    float spawnPhase = fract(spawnRaw);

    // PER-CYCLE position — hashed with cycleIdx so each new lifetime
    // cycle picks a fresh in-cell position. No instant respawn at the
    // same spot.
    vec2 blobLocal = vec2(
      fwHash(ic + vec2(1.7, 5.3) + cycleIdx * 13.0),
      fwHash(ic + vec2(3.1, 7.9) + cycleIdx * 17.0)
    );

    // Per-cycle existence — the cell may host a star this cycle or
    // not (re-roll each cycle). Threshold raised to 0.78 → roughly
    // 22 % of cells host a star per cycle (was 45 %); combined with
    // the lifetime envelope this brings the visible count down to
    // 1-2 stars at any moment.
    float existSeed = fwHash(ic + vec2(7.7, 11.3) + cycleIdx * 11.0);
    float exists = step(0.78, existSeed);

    // Per-cycle velocity — small drift during the star's life so it
    // moves a few cm before disappearing (motion is unique per cycle,
    // not the global flow).
    vec2 blobVel = (vec2(
      fwHash(ic + vec2(41.0, 43.7) + cycleIdx * 19.0),
      fwHash(ic + vec2(47.1, 53.3) + cycleIdx * 23.0)
    ) - 0.5) * 0.30;
    vec2 blobPos = cellOff + blobLocal + blobVel * spawnPhase;

    vec2 toCenter = fp - blobPos;
    float d2 = dot(toCenter, toCenter);

    // Sin envelope — 0 at start/end, 1 at peak.
    float lifeFade = max(sin(spawnPhase * 3.14159), 0.0);

    // Per-cycle size — falloffK in [600, 1000]. Higher K = smaller
    // star. 3× size variation across spawns.
    float sizeSeed = fwHash(ic + vec2(13.1, 17.9) + cycleIdx * 7.0);
    float falloffK = 600.0 + sizeSeed * 400.0;

    // STAR SHAPE: bright tight CORE + horizontal SPIKE + vertical
    // SPIKE. Each spike is a Gaussian elongated in one direction
    // (slow falloff along its axis, fast falloff perpendicular).
    // Combined with max() so the result reads as a 4-point star.
    float core = exp(-d2 * (falloffK * 1.6));
    float kLong   = falloffK * 0.22; // slow falloff = long extent
    float kNarrow = falloffK * 5.0;  // fast falloff = narrow line
    float horizSpike = exp(-toCenter.x * toCenter.x * kLong  - toCenter.y * toCenter.y * kNarrow);
    float vertSpike  = exp(-toCenter.x * toCenter.x * kNarrow - toCenter.y * toCenter.y * kLong);
    float starShape = max(core, max(horizSpike, vertSpike));

    blobBright = max(blobBright, starShape * exists * lifeFade);
  }
}

// SUN GATE — stars only visible when the sun is up. uSunIntensity
// runs from 0 (night) through ~2 (noon). smoothstep(0.05, 0.5)
// fades the stars in/out across dawn/dusk; at night they're off.
float sunVisibility = smoothstep(0.05, 0.5, uSunIntensity);
freshwaterColor = mix(freshwaterColor, vec3(1.0), blobBright * sunVisibility * 0.95);
`;
