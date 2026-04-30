import * as THREE from 'three';
import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';
import { ISLAND_SHAPE } from './islandShape';
import type { SurfaceTextureSet } from './proceduralTextures';
import { MAX_SHORE_DISTANCE_METERS, type SurfaceMaps } from './surfaceMaps';

/**
 * Terrain ground material: splat-textured with anti-tiling.
 *
 * Composition strategy:
 *  - Patches `<begin_vertex>` to publish a `vTerrainWorldXZ` varying (the FLAT world XZ
 *    of every fragment — used to sample the splatmap and the surface textures). We do
 *    NOT touch `<project_vertex>` because `applyRollingShaderTo` rewrites that chunk
 *    entirely, and a `String.replace` mismatch would silently no-op our patch.
 *  - Patches `<map_fragment>` to compose 4 surface textures by splatmap weights, with
 *    AO and cliff-edge tinting. The chunk is empty when no `map` uniform is set, so
 *    overwriting it does not collide with the standard pipeline.
 *  - `customProgramCacheKey` is stable so Three.js caches the compiled program properly.
 *  - The previous `onBeforeCompile` is invoked first, which keeps this composable with
 *    further patches stacked on top (notably `applyRollingShaderTo`).
 *
 * Anti-tiling: each surface is sampled at TWO UV scales (one fine, one coarser and
 * rotated 90°), blended by a low-frequency value-noise of the world XZ. Without this,
 * a 4 m tile would produce visible 16×16 grid repetition on a 64 m terrain.
 */

export interface TerrainSplatOptions {
  surfaceMaps: SurfaceMaps;
  surfaceTextures: SurfaceTextureSet;
  /** World-space size in meters of one full texture tile. Default 4 m (ACNH-feel). */
  tileSizeMeters?: number;
}

const DEFAULT_TILE_SIZE_METERS = 4;

export function createTerrainSplatMaterial(options: TerrainSplatOptions): THREE.MeshStandardMaterial {
  const tileSizeMeters = options.tileSizeMeters ?? DEFAULT_TILE_SIZE_METERS;

  const material = new THREE.MeshStandardMaterial({
    roughness: 0.92,
    vertexColors: false,
  });
  material.name = 'terrain-splat';
  // Combined with WebGLRenderer's antialias=true (MSAA), alphaToCoverage turns
  // sub-1.0 alpha into per-sample coverage masks. Used by the shore fragment
  // body below to feed a screen-space-AA shoreline, killing the staircase
  // pattern the previous hard `discard > 0.5` produced at the sand→water edge.
  material.alphaToCoverage = true;

  const splatUniforms: Record<string, THREE.IUniform> = {
    uSplatMap: { value: options.surfaceMaps.splatMap },
    uAoMap: { value: options.surfaceMaps.aoMap },
    uCliffEdgeMap: { value: options.surfaceMaps.cliffEdgeMap },
    uShoreMask: { value: options.surfaceMaps.shoreMask },
    uShoreDistanceMap: { value: options.surfaceMaps.shoreDistanceMap },
    uTexGrass: { value: options.surfaceTextures.grass },
    uTexSand: { value: options.surfaceTextures.sand },
    uTexDirt: { value: options.surfaceTextures.dirtPath },
    uTexCliff: { value: options.surfaceTextures.cliffTop },
    uTileSize: { value: tileSizeMeters },
    uTerrainExtents: {
      value: new THREE.Vector2(ISLAND_TERRAIN_WIDTH, ISLAND_TERRAIN_DEPTH),
    },
    uMaxShoreDistance: { value: MAX_SHORE_DISTANCE_METERS },
    uTime: { value: 0 },
  };
  material.userData.terrainUniforms = splatUniforms;

  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);

    Object.assign(shader.uniforms, splatUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${VERTEX_VARYING_DECL}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${VERTEX_PUBLISH_WORLD_XZ}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${FRAGMENT_HEADER}\n${ISLAND_SDF_GLSL}`,
      )
      .replace('#include <map_fragment>', FRAGMENT_SPLAT_BODY);
  };

  material.customProgramCacheKey = () => `terrain-splat:v17:${tileSizeMeters}`;
  material.needsUpdate = true;

  return material;
}

export function updateTerrainSplatMaterial(
  material: THREE.MeshStandardMaterial,
  elapsed: number,
): void {
  const uniforms = material.userData.terrainUniforms as
    | Record<string, THREE.IUniform>
    | undefined;
  if (!uniforms) return;
  uniforms.uTime.value = elapsed;
}

const VERTEX_VARYING_DECL = `
varying vec2 vTerrainWorldXZ;
`;

/**
 * Computes flat world XZ from the un-modified `position` attribute. We deliberately use
 * `position` (raw vertex) and NOT `transformed` (which downstream chunks may displace),
 * so that the splatmap sample stays anchored to the static world layout regardless of
 * any vertex-time warp such as the rolling-world parabolic curvature.
 */
const VERTEX_PUBLISH_WORLD_XZ = `
vTerrainWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
`;

const FRAGMENT_HEADER = `
varying vec2 vTerrainWorldXZ;
uniform sampler2D uSplatMap;
uniform sampler2D uAoMap;
uniform sampler2D uCliffEdgeMap;
uniform sampler2D uShoreMask;
uniform sampler2D uShoreDistanceMap;
uniform sampler2D uTexGrass;
uniform sampler2D uTexSand;
uniform sampler2D uTexDirt;
uniform sampler2D uTexCliff;
uniform float uTileSize;
uniform vec2 uTerrainExtents;
uniform float uMaxShoreDistance;
uniform float uTime;

float terrainHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float terrainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = terrainHash(i);
  float b = terrainHash(i + vec2(1.0, 0.0));
  float c = terrainHash(i + vec2(0.0, 1.0));
  float d = terrainHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 sampleAntiTiled(sampler2D tex, vec2 worldXZ, float blend) {
  vec2 uvA = worldXZ / uTileSize;
  vec2 uvB = worldXZ / (uTileSize * 1.6) + vec2(13.0, 7.0);
  uvB = vec2(-uvB.y, uvB.x);

  vec3 colorA = texture2D(tex, uvA).rgb;
  vec3 colorB = texture2D(tex, uvB).rgb;

  // Softer anti-tile: cap the second sample's contribution at 30% so the patches read
  // as gentle variation instead of obvious blotches. The 2.7× → 1.6× scale gap was
  // also reduced so adjacent patches don't differ in density.
  return mix(colorA, colorB, blend * 0.3);
}
`;

const ISLAND_SDF_GLSL = `
float terrainIslandSDF(vec2 wxz) {
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

const FRAGMENT_SPLAT_BODY = `
vec2 splatUv = (vTerrainWorldXZ + uTerrainExtents * 0.5) / uTerrainExtents;

// Analytical signed SDF, shared with the ocean shader. This avoids texel-quantized
// coastline alpha from the baked shoreDistanceMap, which could still read as small
// stairs at grazing camera angles.
float signedShoreMeters = terrainIslandSDF(vTerrainWorldXZ);
// Hard offshore cull: fragments past SDF=0 are discarded so the underwater sand
// shelf cannot leak its triangulation under the transparent water.
if (signedShoreMeters > 0.20) discard;
float shoreAa = clamp(fwidth(signedShoreMeters), 0.02, 0.15);
float shoreCoverage = 1.0 - smoothstep(-shoreAa, shoreAa, signedShoreMeters);

vec4 splat = texture2D(uSplatMap, splatUv);
float ao = texture2D(uAoMap, splatUv).r;
float cliffEdge = texture2D(uCliffEdgeMap, splatUv).r;
float shoreShadow = texture2D(uShoreMask, splatUv).r;

// Higher noise frequency keeps patches small so seams between them do not read as a
// large-scale "stain"; the helper already caps the blend strength internally.
float antiTileBlend = smoothstep(0.35, 0.65, terrainNoise(vTerrainWorldXZ * 0.27));

vec3 grassColor = sampleAntiTiled(uTexGrass, vTerrainWorldXZ, antiTileBlend);
vec3 sandColor = sampleAntiTiled(uTexSand, vTerrainWorldXZ, antiTileBlend);
vec3 dirtColor = sampleAntiTiled(uTexDirt, vTerrainWorldXZ, antiTileBlend);
vec3 cliffColor = sampleAntiTiled(uTexCliff, vTerrainWorldXZ, antiTileBlend);

// --- Crunchy step-noise edges (ACNH-style organic-but-crisp surface boundaries).
// The splatmap's blended weights are perturbed by world-space noise then resolved
// via a noise-jittered argmax. Two different noise patterns keep the grass↔sand
// and grass↔dirt boundaries visually distinct.
float edgeNoiseGS = (terrainNoise(vTerrainWorldXZ * 0.95) - 0.5) * 0.42;
float edgeNoiseGD = (terrainNoise(vTerrainWorldXZ * 1.10 + vec2(11.0, 7.0)) - 0.5) * 0.42;
float gW = clamp(splat.r + edgeNoiseGS + edgeNoiseGD, 0.0, 1.0);
float sW = clamp(splat.g - edgeNoiseGS, 0.0, 1.0);
float dW = clamp(splat.b - edgeNoiseGD, 0.0, 1.0);
float cW = splat.a;

float pickGrass = step(sW, gW) * step(dW, gW) * step(cW, gW);
float pickSand = step(gW, sW) * step(dW, sW) * step(cW, sW);
float pickDirt = step(gW, dW) * step(sW, dW) * step(cW, dW);
float pickCliff = step(gW, cW) * step(sW, cW) * step(dW, cW);
float pickSum = max(pickGrass + pickSand + pickDirt + pickCliff, 0.0001);
pickGrass /= pickSum;
pickSand /= pickSum;
pickDirt /= pickSum;
pickCliff /= pickSum;

vec3 surfaceColor = grassColor * pickGrass
  + sandColor * pickSand
  + dirtColor * pickDirt
  + cliffColor * pickCliff;

// Offshore terrain is discarded above, so the water shader owns the underwater color.

// --- ACNH-style grass motif: triangles on a staggered (hex-like) grid, all
// pointing up, with two color variants (bright yellow-green and darker green)
// alternating per cell. The previous random-rotation random-density approach
// read as "procedural noise" — ACNH actually places its tufts with structure:
// rows are offset by half a cell (brick pattern) and orientations are uniform.
// 55 cm cell, 60 % density, ~25 % of triangles flipped to point down for
// natural variety.
{
  vec2 motifUv = vTerrainWorldXZ * 1.8;
  float rowIdx = floor(motifUv.y);
  // Alternating row offset: every other row shifts by half a cell width.
  float rowOffset = mod(rowIdx, 2.0) * 0.5;
  float colIdx = floor(motifUv.x + rowOffset);
  vec2 motifCell = vec2(colIdx, rowIdx);
  vec2 motifLocal = vec2(
    fract(motifUv.x + rowOffset) - 0.5,
    fract(motifUv.y) - 0.5
  );

  float cellRand = terrainHash(motifCell);
  float motifPresent = step(0.40, cellRand);

  // ~25 % of triangles flip to point down for organic variation.
  float pointDown = step(0.75, cellRand);
  motifLocal.y *= mix(1.0, -1.0, pointDown);

  const float SQRT3 = 1.7320508;
  float triR = 0.22;
  vec2 tp = motifLocal;
  tp.x = abs(tp.x) - triR;
  tp.y = tp.y + triR / SQRT3;
  if (tp.x + SQRT3 * tp.y > 0.0) {
    tp = vec2(tp.x - SQRT3 * tp.y, -SQRT3 * tp.x - tp.y) * 0.5;
  }
  tp.x -= clamp(tp.x, -2.0 * triR, 0.0);
  float triSdf = -length(tp) * sign(tp.y);
  float triMask = (1.0 - smoothstep(0.0, 0.025, triSdf)) * motifPresent * pickGrass;

  // Two color variants alternating per cell: bright yellow-green or darker green.
  float yellowVariant = step(0.50, terrainHash(motifCell + vec2(11.7, 7.3)));
  vec3 triTintBright = vec3(1.20, 1.12, 0.72);  // yellow-green tuft
  vec3 triTintDark = vec3(0.72, 0.82, 0.62);    // darker green tuft
  vec3 triTint = mix(triTintDark, triTintBright, yellowVariant);
  surfaceColor = mix(surfaceColor, surfaceColor * triTint, triMask);
}

// --- Volumetric rim at the grass↔sand boundary: a tight darken on the sand side
// (shadow under the grass step) and a tight highlight on the grass side, giving
// the illusion of a 3 cm ACNH-style grass step over sand.
//
// Uses the SMOOTH splat values (not the noise-jittered argmax weights) so the rim
// follows the actual splatmap boundary instead of every noise crossing — without
// this fix, the noise-jittered weights produced random dark patches scattered
// through the sand. fwidth gives a screen-space-tight band one pixel wide.
float gsBoundaryDist = abs(splat.r - 0.5);
float gsBandPx = max(fwidth(splat.r) * 2.5, 0.045);
float gsRim = 1.0 - smoothstep(0.0, gsBandPx, gsBoundaryDist);
float sandSideShadow = gsRim * pickSand;
float grassSideHilight = gsRim * pickGrass;
surfaceColor *= mix(1.0, 0.72, sandSideShadow);
surfaceColor *= mix(1.0, 1.12, grassSideHilight);

surfaceColor *= 1.0 - ao * 0.4;
surfaceColor = mix(surfaceColor, surfaceColor * vec3(0.55, 0.42, 0.32), cliffEdge * 0.6);

// --- Animated wet-sand wash with leading foam crest -----------------------------
// Replaces the previous globally-phased wash (sin(uTime * 0.95) shared by every
// shore fragment around the island) which read as one synchronized ring lapping
// in and out everywhere at once. Now: per-position phase shift via a low-freq
// noise of world XZ — segments separated by ~12 m run at unrelated phases, so
// the surf reads as discrete waves crashing at scattered points along the coast.
//
// Three layers:
//  1. Wet-sand body — darker, slightly cooler, fades from peak at the shoreline
//     out to wetZoneDepth inland.
//  2. Wet-sand TRAIL — a slower-decaying "memory" of where the wash just was, so
//     the sand keeps a damp echo behind the receding wave instead of snapping
//     dry the moment the crest passes.
//  3. Leading foam crest — a thin white line at distInland ≈ wetZoneDepth, only
//     visible while the wave is in its push-in phase (not on the retreat). This
//     is what gives the visible "wave crashing onto sand" read; without it the
//     SDF discard silhouette reads as a clean white border line.
//
// Same coastPhase formula (and 0.085 spatial scale) as waterStylizedMaterial.ts
// so wash crest on the sand and foam bands offshore line up at any coast point.
float distInland = max(0.0, -signedShoreMeters);
float coastPhase = terrainNoise(vTerrainWorldXZ * 0.085) * 6.28318;
float wetT = uTime * 0.85 + coastPhase;
float wetCycle = sin(wetT) * 0.5 + 0.5;
// Ease-out so wash pushes in fast (small wetCycle change at the start of the
// half-cycle) and pulls back slowly — matches real surf timing.
float wetMotion = wetCycle * wetCycle;
// Bigger swing so peaks read as visible inland intrusion, not a slow gradient.
float wetZoneDepth = mix(0.20, 1.40, wetMotion);
// Offshore fragments are already discarded above, so every fragment reaching this
// line is on land — landSand is just pickSand. Keeping the local name for clarity
// against the wet-mask consumers below.
float landSand = pickSand;
float wetMask = smoothstep(wetZoneDepth, 0.0, distInland) * landSand;
surfaceColor *= mix(1.0, 0.65, wetMask);
surfaceColor = mix(surfaceColor, surfaceColor * vec3(0.86, 0.92, 1.00), wetMask * 0.55);

// (Previous fake "leading foam crest line" removed. The actual wave intrusion
// is drawn by the water shader pushing its vertices ABOVE the sand altitude
// near the shoreline — a painted foam line on the sand was an unnatural shortcut
// that didn't match the water motion.)

// Soft general damp zone independent of the breathing wave (always-wet line right
// where land meets sea).
float wetBroad = smoothstep(0.10, 0.85, shoreShadow) * landSand;
surfaceColor *= mix(1.0, 0.92, wetBroad * 0.30);

diffuseColor.rgb *= surfaceColor;
diffuseColor.a *= shoreCoverage;
`;
