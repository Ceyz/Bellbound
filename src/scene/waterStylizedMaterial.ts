import * as THREE from 'three';
import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';
import { ISLAND_SHAPE } from './islandShape';
import { MAX_SHORE_DISTANCE_METERS, type SurfaceMaps } from './surfaceMaps';

export interface WaterStylizedOptions {
  surfaceMaps: SurfaceMaps;
}

interface WaterUniforms {
  uRiverMask: THREE.IUniform<THREE.DataTexture>;
  uShoreDistanceMap: THREE.IUniform<THREE.DataTexture>;
  uMaxShoreDistance: THREE.IUniform<number>;
  uTerrainExtents: THREE.IUniform<THREE.Vector2>;
  uTime: THREE.IUniform<number>;
  uWaveStrength: THREE.IUniform<number>;
}

export function createWaterStylizedMaterial(options: WaterStylizedOptions): THREE.MeshStandardMaterial {
  const waterUniforms: WaterUniforms = {
    uRiverMask: { value: options.surfaceMaps.riverMask },
    uShoreDistanceMap: { value: options.surfaceMaps.shoreDistanceMap },
    uMaxShoreDistance: { value: MAX_SHORE_DISTANCE_METERS },
    uTerrainExtents: {
      value: new THREE.Vector2(ISLAND_TERRAIN_WIDTH, ISLAND_TERRAIN_DEPTH),
    },
    uTime: { value: 0 },
    uWaveStrength: { value: 0.18 },
  };

  // Material setup: color=BLACK and emissive=WHITE so the diffuse pipeline
  // contributes nothing (color × any light = 0) and the emissive uniform is
  // (1,1,1) before our shader patch below routes the computed water color
  // through `totalEmissiveRadiance`. Net effect: the water is lit-INDEPENDENT.
  // Reason: with a normal MeshStandardMaterial diffuse path, our saturated
  // tropical cyan got multiplied by warm sunset light (pink ambient + low
  // sun) and read as muddy gray. ACNH-style stylized water needs to keep its
  // painted colors regardless of the day/night palette — diffuse lighting on
  // water doesn't add the realism people expect, just darkens/desaturates it.
  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    depthWrite: false,
    emissive: 0xffffff,
    metalness: 0,
    opacity: 0.92,
    roughness: 1.0,
    side: THREE.DoubleSide,
    transparent: true,
  });
  material.name = 'water-stylized';
  material.userData.waterUniforms = waterUniforms;

  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, waterUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${VERTEX_HEADER}\n${ISLAND_SDF_GLSL}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${VERTEX_BODY}`,
      );

    // FRAGMENT_WATER_BODY (replacing map_fragment) computes a local `vec3
    // baseColor` carrying our final water color. That variable is still in
    // scope at the emissivemap_fragment chunk further down in main(), so we
    // can route it directly into totalEmissiveRadiance there. After this
    // patch, the standard shader's outgoingLight = totalEmissiveRadiance =
    // our baseColor, fully lit-independent.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${FRAGMENT_HEADER}\n${ISLAND_SDF_GLSL}`,
      )
      .replace('#include <map_fragment>', FRAGMENT_WATER_BODY)
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance = baseColor;',
      );
  };

  material.customProgramCacheKey = () => 'water-stylized:v65';
  material.needsUpdate = true;

  return material;
}

export function updateWaterStylizedMaterial(
  material: THREE.MeshStandardMaterial,
  elapsed: number,
  waveStrength: number,
) {
  const uniforms = material.userData.waterUniforms as WaterUniforms | undefined;
  if (!uniforms) return;

  uniforms.uTime.value = elapsed;
  uniforms.uWaveStrength.value = waveStrength;
}

const VERTEX_HEADER = `
varying vec2 vWaterWorldXZ;
varying float vWaveCrest;
varying float vWashAmp;
varying float vRunupPhase;
varying float vFrontSDF;
uniform float uTime;
uniform float uWaveStrength;

float wvHash(vec2 p) {
  return fract(sin(dot(p, vec2(41.7, 289.3))) * 23857.5453);
}

float wvNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = wvHash(i);
  float b = wvHash(i + vec2(1.0, 0.0));
  float c = wvHash(i + vec2(0.0, 1.0));
  float d = wvHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Shared swash noise — IDENTICAL implementation in terrainSplatMaterial.ts
// so the swashSignal computed in both shaders agrees on a per-position
// phase noise. Both shaders MUST use the same hash constants here.
float swashHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float swashNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = swashHash(i);
  float b = swashHash(i + vec2(1.0, 0.0));
  float c = swashHash(i + vec2(0.0, 1.0));
  float d = swashHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Gerstner-wave-1 phase signal at world position p, time t. The visible
// dominant ocean wave (g1 in the body below) uses the SAME phase formula,
// so swashCycle = sin(phase1) maps directly to that wave's vertical
// oscillation. The LAND splat shader replicates this function bit-for-bit
// so its dynamic shore boundary moves WITH the visible water wave instead
// of running on an independent timer.
float swashSignal(vec2 p, float t) {
  vec2 dir = length(p) > 0.01 ? -normalize(p) : vec2(0.0, -1.0);
  float w = 6.28318530718 / 12.0;
  float speed = 2.4;
  float phaseNoise = swashNoise(p * 0.07) * 6.28318;
  float phase = w * (dir.x * p.x + dir.y * p.y) - w * speed * t + phaseNoise;
  return sin(phase);
}

// Gerstner wave (Fournier & Reeves 1986, popularised by GPU Gems 1 ch.1).
// Each vertex orbits in a circle in the wave-direction plane: it moves UP at
// the crest, DOWN in the trough, AND moves IN THE WAVE DIRECTION at the
// crest (giving "choppy" peaks) and BACKWARD in the trough.
//
//   phase = w · (D · P_xz) - w · speed · t        with w = 2π / wavelength
//   dx    = Q · A · D.x · cos(phase)
//   dy    =     A         · sin(phase)
//   dz    = Q · A · D.z · cos(phase)
//
// Sign convention: phase uses MINUS speed*t (NOT plus speed*t) so the wave
// crest moves in the +D direction over time. With plus speed*t the wave
// would propagate in -D, which is non-intuitive — passing dir=inward and
// expecting waves to travel outward is exactly the bug 2026-05-02 first
// shipped with.
//
// Q controls steepness; sum of Q across all waves must be ≤ 1 to avoid the
// crests folding back on themselves (visible "wave loops"). With 3 waves and
// Q = 0.30 each, total Q = 0.90 — choppy but stable.
vec3 gerstnerWave(vec2 worldXZ, vec2 dir, float wavelength, float amplitude, float speed, float Q, float t, float phaseOffset) {
  float w = 6.28318530718 / wavelength;
  float phase = w * (dir.x * worldXZ.x + dir.y * worldXZ.y) - w * speed * t + phaseOffset;
  float c = cos(phase);
  float s = sin(phase);
  return vec3(
    Q * amplitude * dir.x * c,
    amplitude * s,
    Q * amplitude * dir.y * c
  );
}
`;

// Vertex displacement: 3-wave Gerstner ocean surface + near-shore wash swell.
// The Gerstner sum gives REAL choppy waves (XYZ displacement, not just Y), so
// crests look like ridge tops instead of smooth bumps. Wave amplitudes taper
// to 0 at the analytical shore (SDF=0) so peaks can't punch through the sand.
const VERTEX_BODY = `
vec3 _waterWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vec2 wxz = _waterWorldPos.xz;

float distFromShoreVtx = max(islandSDF(wxz), 0.0);
// Tight taper: waves ramp from 0 at the shore (SDF=0.5) to full by 3 m
// offshore. Previous 14 m taper kept waves invisible in the camera's near-
// coast frame; with the cozy ACNH camera the visible water is mostly within
// 5-10 m of the shore, so a shorter taper is required for the waves to read.
float shoreAmp = smoothstep(0.5, 3.0, distFromShoreVtx);
float waveScale = (0.85 + 0.30 * uWaveStrength) * shoreAmp;

// Wave direction = INWARD (pointing toward island center) so every coast sees
// waves washing UP onto its shore, not parallel-traveling past it. Without
// this, fixed world-direction Gerstner waves crashed the south coast but
// receded from the north coast (and any visual angle between the two read
// as "going the wrong way"). Inward = -normalize(worldXZ), with a fallback
// when the vertex is exactly on the island center axis.
vec2 inward = length(wxz) > 0.01 ? -normalize(wxz) : vec2(0.0, -1.0);
// Rotate by ±30° for waves 2 and 3 so the three wave trains spread into a
// fan instead of stacking colinearly (which read as one unified swell).
//   cos 30° = 0.866, sin 30° = 0.5
vec2 inwardRot1 = vec2(0.866 * inward.x - 0.5 * inward.y,
                        0.5   * inward.x + 0.866 * inward.y);

// Two Gerstner waves with PER-POSITION phase noise. Cozy ACNH-style:
// amplitudes kept tiny so the water reads as nearly flat — heavy Y bumps
// at the cozy camera angle look like rolling hills, not water. The visible
// motion comes from the foam and the dynamic shore boundary, not from
// vertex displacement.
//
// Per-wave Q = 0.40 (sum 0.80, ≤1 for stability).
//   Wave 1: long dominant swell, period ~5 s, A=4cm.
//   Wave 2: medium swell rotated +30°, period ~4 s, A=3cm.
//
// Wave 1 uses swashNoise (NOT wvNoise) for its phase noise so it matches
// what swashSignal() computes — the LAND/OCEAN boundary moves WITH this
// wave's crest instead of on an independent timer.
float pn1 = swashNoise(wxz * 0.07) * 6.28318;
float pn2 = wvNoise(wxz * 0.09 + vec2(3.7, 5.1)) * 6.28318;
vec3 g1 = gerstnerWave(wxz, inward,     12.0, 0.04, 2.4,  0.40, uTime, pn1);
vec3 g2 = gerstnerWave(wxz, inwardRot1,  8.5, 0.03, 2.13, 0.40, uTime, pn2);
vec3 gerstnerDisp = (g1 + g2) * waveScale;
transformed.x += gerstnerDisp.x;
transformed.y += gerstnerDisp.y;
transformed.z += gerstnerDisp.z;

// Wave swash cycle: derived DIRECTLY from the dominant Gerstner wave's
// phase via swashSignal(). The LAND splat shader computes swashSignal
// identically so both sides of the boundary move together.
//
// Cozy ACNH tuning:
//   - swashHeight (0-1): the wave height proxy at this position
//   - boundary motion = 30 cm only (mix(-0.55, -0.85)) — the coast breathes
//     gently rather than pulses dramatically
//   - foam visibility thresholded at swashHeight > 0.55 — foam appears
//     only at strong crests, scattered along the coast as wave 1 propagates
float signedShoreVtx = islandSDF(wxz);
float swashRaw = swashSignal(wxz, uTime);
float swashHeight = swashRaw * 0.5 + 0.5;
float swashCycle = swashHeight;
float swashThreshold = mix(-0.55, -0.85, swashCycle);
float foamVisibility = smoothstep(0.55, 0.95, swashHeight);

vWaterWorldXZ = wxz;
// Normalize Gerstner Y sum to roughly [-1, +1] for the fragment crest tint.
// Total max amplitude = 0.04 + 0.03 = 0.07.
vWaveCrest = (g1.y + g2.y) / 0.07;
vWashAmp = foamVisibility;  // repurposed: foam intensity for fragment shader
vRunupPhase = swashCycle;
vFrontSDF = swashThreshold;
`;

const ISLAND_SDF_GLSL = `
// Analytical island SDF — must stay byte-equivalent to sampleIslandSDF in islandShape.ts.
// Returns negative inland, positive offshore, in meters. Used in place of the previously
// texture-sampled shoreDistanceMap so the water shader has correct distance values past
// the terrain rectangle (the texture only covered the inner 80×64 m, so the water plane's
// outer ~36 m fell back to a constant and rendered as visible straight lines).
float islandSDF(vec2 wxz) {
  float angle = atan(wxz.y, wxz.x);
  float perturbation = 1.0
    + 0.06 * sin(angle * 3.0 + 0.4)
    + 0.04 * sin(angle * 6.0 + 1.7)
    + 0.025 * sin(angle * 11.0 + 2.9);
  vec2 r = vec2(${ISLAND_SHAPE.RADIUS_X.toFixed(1)} * perturbation, ${ISLAND_SHAPE.RADIUS_Z.toFixed(1)} * perturbation);
  vec2 n = wxz / r;
  float innerDist = length(n) - 1.0;
  return innerDist * min(r.x, r.y);
}
`;

const FRAGMENT_HEADER = `
varying vec2 vWaterWorldXZ;
varying float vWaveCrest;
varying float vWashAmp;
varying float vRunupPhase;
varying float vFrontSDF;
uniform sampler2D uRiverMask;
uniform sampler2D uShoreDistanceMap;
uniform float uMaxShoreDistance;
uniform vec2 uTerrainExtents;
uniform float uTime;
uniform float uWaveStrength;

float waterHash(vec2 p) {
  return fract(sin(dot(p, vec2(41.7, 289.3))) * 23857.5453);
}

float waterNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = waterHash(i);
  float b = waterHash(i + vec2(1.0, 0.0));
  float c = waterHash(i + vec2(0.0, 1.0));
  float d = waterHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float waterInsideTerrain(vec2 uv) {
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return inside.x * inside.y;
}

// Voronoi distance — nearest cell-point distance, 3x3 scan. Cell interiors are
// bright (far from any cell point), boundaries are dark. Used for the dappled
// caustic pattern that reads as crisp ACNH-feel cells rather than smooth blobs.
float waterVoronoi(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float minDist = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 off = vec2(float(x), float(y));
      vec2 cellPt = off + vec2(waterHash(ip + off), waterHash(ip + off + vec2(1.7, 5.3)));
      float d = length(cellPt - fp);
      minDist = min(minDist, d);
    }
  }
  return minDist;
}

// Two animated voronoi layers (counter-drifting) produce a non-tiling cellular
// pattern with crisp filaments at cell intersections — the dappled-sun-on-sand
// look you get in clear shallow ACNH water.
float waterCaustic(vec2 wxz, float t) {
  vec2 a = wxz * 0.85 + vec2(t * 0.13, -t * 0.10);
  vec2 b = wxz * 0.62 + vec2(-t * 0.08, t * 0.11);
  float va = waterVoronoi(a);
  float vb = waterVoronoi(b);
  return smoothstep(0.20, 0.55, va) * smoothstep(0.18, 0.50, vb);
}

`;

// Fragment composition for the offshore ocean look. Shore foam is now drawn here in
// the water shader directly via two SDF-driven smoothstep bands (see end of body),
// replacing the disabled shoreWashSystem ribbon mesh whose triangulation leaked as a
// sawtooth edge against the sand. This shader handles: deep / mid / shallow color
// gradient, caustics, shimmer, crest highlight, AND the lapping foam fronts. Distance-
// to-shore is computed analytically via islandSDF() — the previous texture-sampled
// shoreDistanceMap had no data past the 80×64 m terrain rectangle and rendered
// straight horizontal/vertical seams in the outer water plane.
const FRAGMENT_WATER_BODY = `
vec2 terrainUv = (vWaterWorldXZ + uTerrainExtents * 0.5) / uTerrainExtents;
float insideTerrain = waterInsideTerrain(terrainUv);

// Reverted to inline analytical SDF after Step 3 round 2 texture sample exposed
// a visible regression on the inland LAND area (foamy white pattern instead of
// proper grass / sand). Will swap once the bake precision is bumped (Step 3
// round 3 — signed-distance JFA + R16 storage).
float distFromShoreM = max(islandSDF(vWaterWorldXZ), 0.0);

// Step 3 round 2: this plane is now the OCEAN ONLY. Freshwater (river / pond)
// fragments are owned by freshwaterStylizedMaterial on a separate per-tier
// mesh. Discard freshwater fragments here so the freshwater mesh underneath
// (or above, depending on tier) renders cleanly without the ocean foam,
// whitecaps, or shore wash leaking into the river palette.
float riverWater = texture2D(uRiverMask, clamp(terrainUv, vec2(0.0), vec2(1.0))).r * insideTerrain;
if (riverWater > 0.5) discard;
float oceanFlag = 1.0;

vec2 flowA = vec2(0.055, -0.025) * uTime;
vec2 flowB = vec2(-0.028, 0.044) * uTime;
float broadWave = waterNoise(vWaterWorldXZ * 0.13 + flowA);
float tightWave = waterNoise(vec2(-vWaterWorldXZ.y, vWaterWorldXZ.x) * 0.36 + flowB);
float lineWave =
  sin((vWaterWorldXZ.x * 0.85 + vWaterWorldXZ.y * 0.22) + uTime * 1.35) * 0.5 + 0.5;
float shimmer = smoothstep(0.58, 0.92, tightWave * 0.72 + lineWave * 0.28);

// --- Procedural sand floor — synthesized in the shader so the shallow band
// reads as actual sand grains seen through clear water rather than a flat
// painted cyan tint. Without an underwater mesh, the eye still gets variegated
// underwater texture this way, and we avoid the triangulation artifacts that
// the previous mesh-based sand shelf produced.
//
// Wide contrast range (sandWarm bright, sandShade quite dark) so the pattern
// stays VISIBLE after alpha-blending against the sky background. A muted range
// gets washed out in the final compositing — pushing the dynamic range up here
// is the only way to keep the grain readable through any non-1.0 alpha.
float sandGrainCoarse = waterNoise(vWaterWorldXZ * 1.4);
float sandGrainFine = waterNoise(vWaterWorldXZ * 5.4 + vec2(7.3, 11.1));
float sandRipple = sin(vWaterWorldXZ.x * 0.72 + vWaterWorldXZ.y * 0.41 + uTime * 0.12) * 0.5 + 0.5;
float sandPattern = sandGrainCoarse * 0.55 + sandGrainFine * 0.30 + sandRipple * 0.15;
vec3 sandWarm = vec3(0.98, 0.88, 0.62);   // bright sun-warmed sand
vec3 sandShade = vec3(0.55, 0.42, 0.26);  // dark wet sand under crests
vec3 sandFloor = mix(sandShade, sandWarm, sandPattern);
// No multiplicative wet tint — that desaturates everything to muddy gray-blue.
// The depth-based color shift toward cyan happens via the oceanColor mix below
// (toShallow weight goes from 1 at the shoreline to 0 at 4.5 m offshore), which
// keeps the warm sand HUE intact and just dilutes the *amount* of sand visible.
vec3 sandyShallow = sandFloor;

// 4-stop ocean palette: deep saturated turquoise far offshore → bright cyan mid
// → ALMOST WHITE pale shallow band (Caribbean clear-water look) → warm sand
// pattern visible only in the very last 1.5 m at the immediate shore. The pale
// shallow stop was missing in the previous palette — without it the water went
// from saturated cyan straight to sandy-tan, skipping the bright "clear water
// over very shallow bottom" zone that gives tropical beaches their luminous read.
vec3 midOcean   = vec3(0.22, 0.74, 0.94);
vec3 deepOcean  = vec3(0.04, 0.40, 0.78);
vec3 paleShallow = vec3(0.32, 0.78, 0.84);  // clear cyan, not a white shoreline stripe

// Bring the deep saturated blue closer to shore (was 14 m → now 8 m to reach
// full deep). At the ACNH camera angle, 14 m is essentially off-frame, so the
// previous ramp left every visible pixel of water in the mid-cyan band, no
// depth read. New ramp: mid (1.5 m) → deep saturation by 8 m offshore.
float toMid = smoothstep(8.0, 1.5, distFromShoreM);
vec3 oceanColor = mix(deepOcean, midOcean, toMid);
// Pale clear band: brightens water from 4 m offshore inward, dominant by ~1 m.
float toPale = smoothstep(4.0, 0.8, distFromShoreM);
oceanColor = mix(oceanColor, paleShallow, toPale * 0.32);
// Sand floor texture only shows in the last 1 m, blended with the pale layer
// (not replacing it) so the eye still reads clear water, just with a hint of
// the sandy bottom variegation underneath.
float toShallow = smoothstep(1.4, 0.0, distFromShoreM);
oceanColor = mix(oceanColor, sandyShallow, toShallow * 0.72);
oceanColor *= mix(0.96, 1.04, broadWave);

// River: 2-stop greenish palette + a directional flow effect (scrolling streaks
// along the river east-west axis — riverCenterZ(x) = 5 + 6 sin(x*0.08), so it
// flows primarily along world X). Directional UV scrolling on a stretched noise
// gives the visual sense of water moving downstream.
vec3 riverLight = vec3(0.42, 0.90, 0.95);
vec3 riverGreen = vec3(0.16, 0.66, 0.82);
vec3 riverColor = mix(riverGreen, riverLight, broadWave);
vec2 riverFlowUv = vWaterWorldXZ * vec2(0.55, 1.40) + vec2(uTime * 0.55, 0.0);
float riverStreak = smoothstep(0.55, 0.88, waterNoise(riverFlowUv));
riverColor = mix(riverColor, riverColor * 1.18 + vec3(0.05, 0.06, 0.06), riverStreak * 0.55);
// A second slower streak adds depth so the flow doesn't read as a single tile pattern.
vec2 riverFlowUv2 = vWaterWorldXZ * vec2(0.32, 0.85) + vec2(uTime * 0.32 + 1.7, 0.0);
float riverStreak2 = smoothstep(0.62, 0.92, waterNoise(riverFlowUv2));
riverColor = mix(riverColor, riverColor * 0.86, riverStreak2 * 0.30);

vec3 baseColor = mix(oceanColor, riverColor, riverWater);

// --- Caustics: dappled sun pattern, restricted to the shallow band only.
// Reduced 2026-05-02: previous full-strength caustics + drifting streaks
// combined into "cloud reflection" patches across the open ocean. Now the
// caustics fade out completely past 4m offshore (was 8m) so they only show
// in the wet-sand band right at the shore, where they look like sun caustics
// through clear water rather than scattered haze offshore.
float caustic = waterCaustic(vWaterWorldXZ, uTime);
float causticDepthFade = mix(1.0, 0.0, smoothstep(0.5, 4.0, distFromShoreM));
float causticShoreFade = smoothstep(0.45, 1.35, distFromShoreM);
baseColor += vec3(0.18, 0.22, 0.22) * caustic * causticDepthFade
  * causticShoreFade * (0.60 + 0.40 * uWaveStrength);

// Drifting light streaks removed 2026-05-02 — they read as cloud reflections
// drifting across the open ocean.

// Broad shimmer accent — boosted for cozy ACNH style: with the Gerstner
// vertex displacement now tiny (4 cm), the visible motion is mostly painted
// by light/color variation, so this shimmer carries more of the visual
// "moving water" signal.
baseColor += vec3(0.14, 0.18, 0.18) * shimmer * 0.42;

// Crest highlight: ridges of the displaced surface read brighter, troughs
// darker. Re-widened (was 0.94/1.08 ±7%, now 0.88/1.18 ±15%) so the wave shape
// reads as actual relief rather than a flat plane with subtle shading.
float crestLift = clamp(vWaveCrest * 0.5 + 0.5, 0.0, 1.0);
baseColor = mix(baseColor * 0.88, baseColor * 1.18, crestLift);

// (Sky/cloud reflection on wave crests removed — the bright sky-tint highlights
// on the open ocean read as cloud reflections, but the procedural sky clouds
// drift along their own world axis and don't actually align with where the
// reflections appeared. The mismatch was distracting; the sun glow + crest
// brightness below already give the wave faces enough specular pop.)

// --- Warm sun glow on wave crests + drifting wave fronts -----------------------
// Two effects to give the open ocean visible motion (instead of reading as a
// flat colored plane that only animates at the shore):
//
//  A. SUN GLOW — warm pink-orange tint on wave peaks at grazing view angles.
//     Loosened threshold (was so narrow it barely showed): pow exponent 2.5→1.4,
//     crest threshold 0.55→0.30, intensity 0.34→0.55. Now visibly tints the
//     ocean at distance with the magic-hour warmth.
//
//  B. WAVE FRONTS — long parallel sin stripes drifting across the open ocean.
//     Without these the deep water reads as one flat color since the vertex
//     displacement isn't really visible from the shallow ACNH camera angle.
//     Stripes are noise-perturbed so they don't tile, and faded out at the
//     shore so they don't fight the foam/sand band.
//
// TODO: route the sun tint through a uSunWarmth uniform driven by the
// day/night cycle for proper time-of-day matching.
vec3 viewDir = normalize(-vViewPosition);
float fresnelGraze = 1.0 - abs(viewDir.y);
fresnelGraze = pow(clamp(fresnelGraze, 0.0, 1.0), 1.4);
float crestUp = clamp(vWaveCrest * 0.5 + 0.5, 0.0, 1.0);
float sunGlow = fresnelGraze
  * smoothstep(0.30, 0.85, crestUp)
  * smoothstep(1.5, 8.0, distFromShoreM);
vec3 sunTint = vec3(1.00, 0.62, 0.38);
baseColor += sunTint * sunGlow * 0.55;

// Drifting wave fronts: long stripes oriented mostly along world X, slowly
// scrolling north-east, perturbed by a low-freq noise so the lines bend
// organically. Visible in the deep band only.
vec2 frontUv = vWaterWorldXZ * vec2(0.18, 0.36) + vec2(uTime * 0.18, uTime * 0.06);
float frontWobble = waterNoise(frontUv * 0.45) * 1.6;
float frontPattern = sin(frontUv.x * 1.4 + frontWobble) * 0.5 + 0.5;
float frontMask = smoothstep(0.55, 0.85, frontPattern)
  * smoothstep(3.5, 9.0, distFromShoreM)
  * (1.0 - smoothstep(28.0, 38.0, distFromShoreM))
  * oceanFlag;
baseColor += vec3(0.10, 0.16, 0.20) * frontMask * 0.42;

// White foam crest at the dynamic boundary REMOVED at user request — the
// boundary motion + wet sand on the LAND side already convey the wave
// washing in/out, no painted white line needed. Pale-cyan trail kept (very
// subtle) for a hint of water reflection just offshore of the boundary.
float signedShoreFrag = islandSDF(vWaterWorldXZ);
float distOutside = max(0.0, signedShoreFrag - vFrontSDF);
float trailMask = (1.0 - smoothstep(0.10, 1.2, distOutside))
  * vWashAmp * oceanFlag;
float foamCrest = 0.0;  // legacy — kept zero so the alpha calc below stays valid
float foamMask = 0.0;
baseColor = mix(baseColor, vec3(0.55, 0.88, 0.96), trailMask * 0.25);

// Offshore whitecaps removed at user request 2026-05-02 — the white speckles
// scattered across the deep ocean read as cloud reflections / dirty water
// instead of foam. Pure cyan ocean reads cleaner. The shore foam bands above
// (band1/band2) still provide the visible breaking-wave look at the coast.
float whitecapMask = 0.0;

// Legacy stand-ins (alpha calc below still references these names).
float washVisibility = trailMask;
float washFoam = foamCrest;

// --- Alpha shaping --------------------------------------------------------------
// Shallow alpha pushed to 0.86 so the procedural sand floor (in the base color
// above) actually reads as visible warm sand instead of being washed out by the
// 0xb0d8f0 sky background bleeding through any non-opaque pixel. The previous
// 0.32 / 0.62 values let too much of the bg color dominate, turning warm sand
// into pale neutral cyan in the final composite. Deep water still goes near-
// opaque (0.95) so the ocean reads as a solid dark blue past the sand band.
float shallowness = clamp(1.0 - smoothstep(0.0, 5.0, distFromShoreM), 0.0, 1.0) * oceanFlag;
float baseAlpha = mix(0.95, 0.86, shallowness);
// Wash pixels stay present but no longer turn into an opaque white border.
baseAlpha = max(baseAlpha, washVisibility * 0.72);
baseAlpha = max(baseAlpha, washFoam * 0.88);
// Foam pixels stay opaque against the otherwise transparent shallow band so the
// white crest reads cleanly instead of bleeding the underwater sand color through.
baseAlpha = max(baseAlpha, foamMask * 0.86);
baseAlpha = max(baseAlpha, whitecapMask * 0.78);

diffuseColor.rgb *= baseColor;
diffuseColor.a *= mix(baseAlpha, 0.97, riverWater);
`;
