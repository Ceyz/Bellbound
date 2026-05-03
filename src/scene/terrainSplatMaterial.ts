import * as THREE from 'three';
import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';
import { ISLAND_SHAPE } from './islandShape';
import type { SurfaceTextureSet } from './proceduralTextures';
import { MAX_SHORE_DISTANCE_METERS, type SurfaceMaps } from './surfaceMaps';
import { GRID_D, GRID_W, TERRAIN_ORIGIN } from './terrain/TerrainGrid';
import {
  SMOOTH_BEACH_BOTTOM_INSET_METERS,
  SMOOTH_BEACH_TOP_INSET_METERS,
} from './terrain/beachGeometry';

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
  // Use static SDF coverage only at the island outline. The terrain edge stays
  // smooth, but it no longer breathes with the water and reveals blue slivers.
  material.alphaToCoverage = true;

  const splatUniforms: Record<string, THREE.IUniform> = {
    uSplatMap: { value: options.surfaceMaps.splatMap },
    uAoMap: { value: options.surfaceMaps.aoMap },
    uCliffEdgeMap: { value: options.surfaceMaps.cliffEdgeMap },
    uShoreMask: { value: options.surfaceMaps.shoreMask },
    uShoreDistanceMap: { value: options.surfaceMaps.shoreDistanceMap },
    uPathMask: { value: options.surfaceMaps.pathMask },
    uPathOrigin: { value: new THREE.Vector2(TERRAIN_ORIGIN.x, TERRAIN_ORIGIN.z) },
    uPathGridSize: { value: new THREE.Vector2(GRID_W, GRID_D) },
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

  material.customProgramCacheKey = () => `terrain-splat:v33:${tileSizeMeters}`;
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
uniform sampler2D uPathMask;
uniform vec2 uPathOrigin;
uniform vec2 uPathGridSize;
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

// Gerstner-wave-1 phase signal — IDENTICAL to swashSignal() in
// waterStylizedMaterial.ts (terrainHash here uses the same constants
// as swashHash there, so terrainNoise IS swashNoise). Returning sin(phase1)
// in both shaders means the dynamic shore boundary follows the visible
// dominant ocean wave's crest exactly.
float swashSignal(vec2 p, float t) {
  vec2 dir = length(p) > 0.01 ? -normalize(p) : vec2(0.0, -1.0);
  float w = 6.28318530718 / 12.0;
  float speed = 2.4;
  float phaseNoise = terrainNoise(p * 0.07) * 6.28318;
  float phase = w * (dir.x * p.x + dir.y * p.y) - w * speed * t + phaseNoise;
  return sin(phase);
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

// Reverted to analytical SDF after Step 3 round 2 texture-sample swap exposed
// a visible regression on the inland grass area (the R8 quantization at 8-bit
// resolution × 8m range = 6cm steps interacted with shoreCoverage's smoothstep
// in a way that washed grass to near-white). Will swap to the texture again
// once the bake uses higher precision (R16 or signed-distance JFA) and the
// shader's shoreCoverage is recomputed against grid-cell granularity.
float signedShoreMeters = terrainIslandSDF(vTerrainWorldXZ);
float inlandShoreMeters = -signedShoreMeters;
float beachTopInset = ${SMOOTH_BEACH_TOP_INSET_METERS.toFixed(3)};
float beachBottomInset = ${SMOOTH_BEACH_BOTTOM_INSET_METERS.toFixed(3)};
float beachEdgeAa = max(fwidth(inlandShoreMeters) * 1.5, 0.035);
float sdfSandMask = 1.0 - smoothstep(
  beachTopInset - beachEdgeAa,
  beachTopInset + beachEdgeAa,
  inlandShoreMeters
);

// --- Dynamic shore boundary (wave wash on the visible coast) --------------
// swashCycle derived from swashSignal — the Gerstner wave 1 phase at THIS
// fragment's world position. Both this shader AND the water shader compute
// swashSignal identically (same wavelength 12 m, speed 2.4 m/s, inward
// direction, phase noise) so the boundary motion follows the visible ocean
// wave exactly, on every fragment independently.
//
// Cozy ACNH tuning: motion range trimmed to 30 cm only (mix(-0.55, -0.85)),
// matching the water shader. The coast breathes gently with each passing
// wave instead of pulsing dramatically.
float swashHeight = swashSignal(vTerrainWorldXZ, uTime) * 0.5 + 0.5;
float swashCycle = swashHeight;
float swashThreshold = mix(-0.55, -0.85, swashCycle);
float foamVisibility = smoothstep(0.55, 0.95, swashHeight);

vec4 splat = texture2D(uSplatMap, splatUv);
// Discard purely based on the splat being void (i.e. the JS classifier
// returned kind='void' because the grid cell is OCEAN/VOID). Previous
// behaviour discarded based on the analytical SDF, which killed texels
// inside grid LAND cells whose centers fell just inside the SDF but whose
// offshore portion extended past it — sand cells at the eastern coast lost
// most of their visible area to that. The new check trusts the grid as the
// source of truth for what's a renderable surface.
float splatTotal = splat.r + splat.g + splat.b + splat.a;
float shoreAa = clamp(fwidth(signedShoreMeters) * 1.5, 0.02, 0.15);
float shoreCoverage = 1.0 - smoothstep(-shoreAa, shoreAa, signedShoreMeters);
float virtualShoreLand = (1.0 - step(0.1, splatTotal)) * shoreCoverage;
if (splatTotal < 0.1 && virtualShoreLand < 0.01) discard;
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

// The beach boundary follows the analytical shore SDF directly. Do not run the
// old noise-jittered argmax here: it creates toothy green triangles along the
// grass/sand line.
float topLandWeight = max(clamp(splat.r + splat.g, 0.0, 1.0), virtualShoreLand);
float gW = topLandWeight * (1.0 - sdfSandMask);
float sW = topLandWeight * sdfSandMask;
float dW = splat.b;
float cW = splat.a;

float pickGrass = gW;
float pickSand = sW;
float pickDirt = dW;
float pickCliff = cW;
float pickSum = max(pickGrass + pickSand + pickDirt + pickCliff, 0.0001);
pickGrass /= pickSum;
pickSand /= pickSum;
pickDirt /= pickSum;
pickCliff /= pickSum;

vec3 surfaceColor = grassColor * pickGrass
  + sandColor * pickSand
  + dirtColor * pickDirt
  + cliffColor * pickCliff;

float beachSlopeMask =
  smoothstep(beachBottomInset - 0.08, beachBottomInset + 0.08, inlandShoreMeters)
  * (1.0 - smoothstep(beachTopInset - 0.08, beachTopInset + 0.08, inlandShoreMeters))
  * pickSand;
vec3 beachBankColor = mix(sandColor, dirtColor * vec3(1.18, 1.06, 0.84), 0.34);
surfaceColor = mix(surfaceColor, beachBankColor, beachSlopeMask * 0.72);

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
  float triMask = (1.0 - smoothstep(0.0, 0.025, triSdf))
    * motifPresent
    * smoothstep(0.82, 0.98, pickGrass);

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
float gsBoundaryDist = abs(sdfSandMask - 0.5);
float gsBandPx = max(fwidth(sdfSandMask) * 2.5, 0.045);
float gsRim = 1.0 - smoothstep(0.0, gsBandPx, gsBoundaryDist);
float sandSideShadow = gsRim * pickSand;
float grassSideHilight = gsRim * pickGrass;
surfaceColor *= mix(1.0, 0.72, sandSideShadow);
surfaceColor *= mix(1.0, 1.12, grassSideHilight);

// --- Path overlay (Step 7) ------------------------------------------------------
// Player-painted paths come from a grid-native 94×78 R8 NearestFilter texture
// (one texel per cell). When a fragment falls in a cell with path > 0, swap
// the base surfaceColor for the dirt texture re-tinted per path style. The
// dirt sample provides the noisy organic pattern; the per-style tint shifts
// hue/saturation so the four MVP styles read as distinctly as possible
// without paying the cost of four separate albedo textures:
//   1 = dirt    (warm brown,  unchanged)
//   2 = stone   (cool grey,   slightly desaturated)
//   3 = brick   (terracotta,  saturated red)
//   4 = planks  (warm tan,    yellow-shifted)
vec2 pathUv = (vTerrainWorldXZ - uPathOrigin) / uPathGridSize;
if (pathUv.x >= 0.0 && pathUv.x <= 1.0 && pathUv.y >= 0.0 && pathUv.y <= 1.0) {
  float pathByte = texture2D(uPathMask, pathUv).r;
  float pathKind = floor(pathByte * 255.0 + 0.5);
  if (pathKind > 0.5) {
    vec3 pathBase = sampleAntiTiled(uTexDirt, vTerrainWorldXZ, antiTileBlend);
    // Average dirt-sample luminance — used to reproject the texture into a
    // luma-matched tint so the per-style color reads its hue while the
    // pattern keeps the same value range as bare dirt.
    float luma = dot(pathBase, vec3(0.299, 0.587, 0.114));
    vec3 tint;
    if (pathKind < 1.5) {
      tint = pathBase;                              // 1 — dirt
    } else if (pathKind < 2.5) {
      tint = vec3(0.62, 0.62, 0.62) * (luma * 1.55); // 2 — stone (cool grey)
    } else if (pathKind < 3.5) {
      tint = vec3(0.78, 0.30, 0.22) * (luma * 1.55); // 3 — brick (terracotta)
    } else {
      tint = vec3(0.78, 0.58, 0.32) * (luma * 1.55); // 4 — planks (warm tan)
    }
    surfaceColor = tint;
  }
}

surfaceColor *= 1.0 - ao * 0.4;
// cliffEdge brown-rim tint disabled: with raised tiers using the same grass
// texture as low ground, ANY rim tint dirtied the cliff top relative to the
// surrounding bright ground and broke color continuity. The cliff TOP now
// reads as identical grass to the ground; the cliff FACE owns its own
// rocky look in the cliff-side mesh. cliffEdge value is sampled but unused
// here — kept for the AO contribution baked elsewhere.
// surfaceColor = mix(surfaceColor, surfaceColor * vec3(...), cliffEdge * 0.0);

// --- Wet sand near the (animated) shore boundary --------------------------------
// Subtle wet-sand tint within ~60 cm INLAND of the current dynamic boundary —
// freshly-uncovered sand reads as wet (cooler, slightly darker) for a moment
// before drying back. Gated by foamVisibility so it only appears where the
// crest is currently strong, not as a permanent wet ring.
float landSand = pickSand;
float distFromBoundaryInland = max(0.0, swashThreshold - signedShoreMeters);
float wetMask = (1.0 - smoothstep(0.0, 0.60, distFromBoundaryInland))
  * landSand * (0.40 + 0.60 * foamVisibility);
surfaceColor *= mix(1.0, 0.78, wetMask);
surfaceColor = mix(surfaceColor, surfaceColor * vec3(0.88, 0.93, 1.00), wetMask * 0.45);

// Soft general damp zone independent of the breathing wave (always-wet line right
// where land meets sea).
float wetBroad = smoothstep(0.10, 0.85, shoreShadow) * landSand;
surfaceColor *= mix(1.0, 0.92, wetBroad * 0.30);

diffuseColor.rgb *= surfaceColor;
diffuseColor.a *= shoreCoverage;
`;
