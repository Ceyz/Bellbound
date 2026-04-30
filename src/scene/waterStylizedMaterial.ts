import * as THREE from 'three';
import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';
import { ISLAND_SHAPE } from './islandShape';
import type { SurfaceMaps } from './surfaceMaps';

export interface WaterStylizedOptions {
  surfaceMaps: SurfaceMaps;
}

interface WaterUniforms {
  uRiverMask: THREE.IUniform<THREE.DataTexture>;
  uTerrainExtents: THREE.IUniform<THREE.Vector2>;
  uTime: THREE.IUniform<number>;
  uWaveStrength: THREE.IUniform<number>;
}

export function createWaterStylizedMaterial(options: WaterStylizedOptions): THREE.MeshStandardMaterial {
  const waterUniforms: WaterUniforms = {
    uRiverMask: { value: options.surfaceMaps.riverMask },
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

  material.customProgramCacheKey = () => 'water-stylized:v51';
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
uniform float uTime;
uniform float uWaveStrength;

// Hash + value-noise replicated from the fragment header so we can break the
// regularity of the summed-sin wave train. Pure sins read as a periodic motif at
// distance ("swimming pool" feel); a noise-modulated extra octave gives chaotic
// crest spacing that scans as natural surface motion.
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

float waterWaveSum(vec2 wxz, float t) {
  // Three coherent sin trains carry the dominant wave motion (kept so crests still
  // travel along recognizable directions, which reads as ocean rather than puddle)…
  float w1 = sin(wxz.x * 0.21 + t * 0.95);
  float w2 = sin(wxz.y * 0.27 - t * 0.78 + 1.4);
  float w3 = sin((wxz.x + wxz.y) * 0.39 + t * 1.30);
  // …and an irregular noise octave replaces the previous fourth sin so two crests
  // never repeat the same spacing twice. Centered around 0 by the *2 - 1 remap.
  vec2 nUv = wxz * 0.34 + vec2(t * 0.11, -t * 0.08);
  float w4 = wvNoise(nUv) * 2.0 - 1.0;
  return w1 * 0.50 + w2 * 0.42 + w3 * 0.30 + w4 * 0.32;
}
`;

// Vertex Y displacement on the water plane. Two stacked terms:
//
//  1. OPEN-WATER WAVES — `waveSum * baseAmp * shoreAmp`, the regular ocean
//     surface oscillation. shoreAmp tapers wave amp to 0 at the SDF=0 line so
//     no displacement happens right at the coast (otherwise the mesh would
//     punch through the sand and read as flickering rims).
//
//  2. NEAR-SHORE SWELL — a tiny offshore lift that keeps the sea moving before
//     it reaches the beach. It intentionally does not push inland over the sand:
//     raising the water carrier mesh above terrain exposed the plane tessellation
//     as triangular wash shapes.
// Stacks with the rolling shader's later <project_vertex> parabolic warp.
const VERTEX_BODY = `
vec3 _waterWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vec2 wxz = _waterWorldPos.xz;
float waveSum = waterWaveSum(wxz, uTime);

// 1. Open-water waves — amplitude tapered to 0 at SDF=0 so wave peaks never
// punch through the sand at the shoreline.
float distFromShoreVtx = max(islandSDF(wxz), 0.0);
float shoreAmp = smoothstep(0.5, 14.0, distFromShoreVtx);
float baseAmp = 0.045 + 0.18 * uWaveStrength;
transformed.y += waveSum * baseAmp * shoreAmp;

// 2. Shore wash — v24 strict (matches the 02:54 local screenshot the user
// remembers as good). Two oscillators overlapped, peak 12 cm, proximity 4 m.
float signedShoreVtx = islandSDF(wxz);
float washProximity = smoothstep(4.0, 0.0, abs(signedShoreVtx));
float washPhase1 = wvNoise(wxz * 0.085) * 6.28318;
float washPhase2 = wvNoise(wxz * 0.13 + vec2(7.0, 11.0)) * 6.28318;
float washCycle1 = sin(uTime * 0.85 + washPhase1) * 0.5 + 0.5;
float washCycle2 = sin(uTime * 0.55 + washPhase2 + 1.7) * 0.5 + 0.5;
float washCycle = max(washCycle1 * washCycle1, washCycle2 * washCycle2 * 0.85);
float washAmp = washCycle * 0.12;  // 12 cm peak (v24)
float washY = washAmp * washProximity;
transformed.y += washY;

vWaterWorldXZ = wxz;
vWaveCrest = waveSum;
vWashAmp = washY;
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
uniform sampler2D uRiverMask;
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

// Analytical signed distance to the island shore, in meters. Positive offshore.
float distFromShoreM = max(islandSDF(vWaterWorldXZ), 0.0);

float riverWater = texture2D(uRiverMask, clamp(terrainUv, vec2(0.0), vec2(1.0))).r * insideTerrain;
float oceanFlag = 1.0 - riverWater;

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

// --- Caustics: visible dappled sun pattern, strongest in the shallow band -------
// 2-layer cellular ridge → bright filaments. Tinted very-light cyan-white (NOT
// dark/yellow) so they read as sun-on-sand patches.
float caustic = waterCaustic(vWaterWorldXZ, uTime);
float causticDepthFade = mix(1.0, 0.15, smoothstep(0.5, 8.0, distFromShoreM));
float causticShoreFade = smoothstep(0.45, 1.35, distFromShoreM);
baseColor += vec3(0.18, 0.22, 0.22) * caustic * causticDepthFade
  * causticShoreFade * (0.60 + 0.40 * uWaveStrength);

// --- Drifting light streaks: subtle elongated highlights from two stretched
// noise patterns at different scales drifting slowly. Gives organic elongated
// highlights that don't tile or repeat.
vec2 streakUv1 = vWaterWorldXZ * vec2(0.55, 0.18) + vec2(uTime * 0.09, -uTime * 0.05);
vec2 streakUv2 = vWaterWorldXZ * vec2(0.18, 0.55) + vec2(uTime * 0.07, uTime * 0.04);
float streak = smoothstep(0.66, 0.92, max(waterNoise(streakUv1) * 0.92, waterNoise(streakUv2)));
baseColor += vec3(0.10, 0.14, 0.16) * streak * 0.40;

// Subtle broad shimmer accent.
baseColor += vec3(0.14, 0.18, 0.18) * shimmer * 0.22;

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

// --- Shore foam: v22 — band1 + band2 + voronoi white blobs ----------------------
float coastPhase = waterNoise(vWaterWorldXZ * 0.085) * 6.28318;
float foamT1 = uTime * 0.85 + coastPhase;
float foamT2 = uTime * 0.55 + 1.7 + coastPhase * 0.7;
float band1Center = 0.18 + 0.10 * sin(foamT1);  // range 0.08-0.28 m
float band2Center = 1.85 + 0.45 * sin(foamT2);
float band1HalfWidth = 0.55;
float band2HalfWidth = 0.55;
float foamAa = max(fwidth(distFromShoreM), 0.02);
float band1 = (1.0 - smoothstep(band1HalfWidth - foamAa, band1HalfWidth + foamAa,
                                 abs(distFromShoreM - band1Center)));
float band2 = (1.0 - smoothstep(band2HalfWidth - foamAa, band2HalfWidth + foamAa,
                                 abs(distFromShoreM - band2Center))) * 0.55;
// Inner band always-on, outer band gated by drifting noise (rarer second laps).
float coverageNoise = waterNoise(vWaterWorldXZ * 0.16 + vec2(uTime * 0.15, -uTime * 0.10));
float foamCoverage = smoothstep(0.52, 0.74, coverageNoise);
float foamMask = max(band1, band2 * foamCoverage) * oceanFlag;
// Round voronoi blobs (the white dots).
vec2 foamBlobUv = vWaterWorldXZ * 3.2 + vec2(uTime * 0.07, -uTime * 0.05);
float foamCellDist = waterVoronoi(foamBlobUv);
float foamBlobs = 1.0 - smoothstep(0.05, 0.22, foamCellDist);
foamMask *= foamBlobs;
baseColor = mix(baseColor, vec3(0.97, 0.99, 0.99), foamMask * 0.62);

// --- Scattered offshore whitecaps -----------------------------------------------
// Small, sparse, drifting foam patches in the deeper water (NOT tied to the SDF
// distance — they just wander). Without these, the offshore band reads as one
// uniform pool color; with them, the eye picks up little flecks of broken surf
// scattered across the whole ocean for a lived-in feel.
//
// Three-noise gate so patches are RARE: two coarse drifts pick the rough cluster
// locations, a fine noise picks the speckle shape inside each cluster. The
// product collapses to tiny bright spots only where all three line up.
// Whitecaps now scarce: tighter cluster gate (0.22, 0.34) and tighter speckle
// gate (0.65, 0.82) so only rare bright flecks appear, not a continuous "gray
// patches everywhere" feel that read as dirty water rather than tropical clear.
vec2 capUvA = vWaterWorldXZ * 0.13 + vec2(uTime * 0.045, -uTime * 0.030);
vec2 capUvB = vWaterWorldXZ * 0.085 + vec2(-uTime * 0.022, uTime * 0.038);
vec2 capUvC = vWaterWorldXZ * 1.85 + vec2(uTime * 0.13, uTime * 0.09);
float capCluster = waterNoise(capUvA) * waterNoise(capUvB);
float capSpeckle = waterNoise(capUvC);
float whitecaps = smoothstep(0.22, 0.34, capCluster) * smoothstep(0.65, 0.82, capSpeckle);
float capDepthMask = smoothstep(3.0, 7.0, distFromShoreM)
  * (1.0 - smoothstep(28.0, 38.0, distFromShoreM))
  * oceanFlag;
float whitecapMask = whitecaps * capDepthMask;
baseColor = mix(baseColor, vec3(0.94, 0.97, 0.99), whitecapMask * 0.32);

// --- Wash visibility: v24 strict — pale cyan, mix 0.65 -------------------------
// The "lumière bleue qui se balade" effect is NOT a saturated wash patch — it's
// the foam patterns drifting and revealing the natural pale-cyan water beneath.
// So the wash itself stays subtle, and the foam (dense voronoi blobs) does the
// visual work via its drift-induced reveals.
float washVisibility = smoothstep(0.005, 0.12, vWashAmp);
vec3 washWater = vec3(0.55, 0.90, 0.96);
baseColor = mix(baseColor, washWater, washVisibility * 0.65);

// Foam crest at the leading edge of the wash, voronoi blob breakup.
float washFoam = smoothstep(0.15, 0.21, vWashAmp);
vec2 washCellUv = vWaterWorldXZ * 3.2 + vec2(uTime * 0.4, -uTime * 0.3);
float washCellDist = waterVoronoi(washCellUv);
washFoam *= 1.0 - smoothstep(0.05, 0.22, washCellDist);
baseColor = mix(baseColor, vec3(0.97, 0.99, 1.00), washFoam * 0.85);

// (Wandering blue blobs removed — that effect is owned by shoreWashSystem's
// vLocalRunup which traverses the shore ring with multiple pulses at different
// speeds/directions, max-combined for fusion. See shoreWashSystem.ts:182-195.)

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
