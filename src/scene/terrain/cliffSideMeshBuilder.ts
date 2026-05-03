import * as THREE from 'three';
import type { SurfaceTextureSet } from '../proceduralTextures';
import {
  Surface,
  Tier,
  type TerrainGrid,
} from './TerrainGrid';

/**
 * Builds vertical / sloped wall meshes at every grid tier discontinuity. Inputs
 * come from `grid.forEachTierDiscontinuity()`, which yields every cell-to-cell
 * edge where the two cells have different `cellHeight()`. This covers:
 *   - LAND tier-N → LAND tier-(N-1) cliff drops
 *   - LAND tier-N → FRESHWATER river / pond banks (the bed sits below tier top)
 *   - LAND-T0 (regular)  → LAND-T0 (beach, lowered) — sandy beach bank
 *   - LAND-T0 (beach)    → OCEAN edges are SKIPPED (the open sea already meets
 *     the lowered sand cell visually; an extra wall would clip into the water)
 *
 * Three output meshes (named `cliff-walls`, `river-bank-walls`, `beach-walls`):
 *   - `cliff-walls`      stratified rock face, steep slope (`SLOPE_OFFSET_CLIFF`).
 *   - `river-bank-walls` packed brown earth, medium slope.
 *   - `beach-walls`      sandy step between grass and lowered beach cells.
 *
 * Slope geometry: the wall's TOP edge sits at the cell boundary (Y=upperY); its
 * BOTTOM edge is pushed horizontally INTO the lower cell by `slopeOffset`. This
 * keeps the slope visible above the lower cell's flat ground mesh (which sits
 * at lowerY across its whole footprint) without ever clipping above the upper
 * cell's grass top. Vertex normals are recomputed to point outward+up so the
 * lighting reads as a tilted face, not a vertical wall.
 */

const HORIZONTAL_TILE_METERS = 1;
const VERTICAL_TILES = 1;
const VERTICAL_TILE_METERS = 1.4;
const TILE_SIZE_METERS = 4;  // matches DEFAULT_TILE_SIZE_METERS in terrainSplatMaterial.ts
const FRINGE_SEGMENTS_PER_EDGE = 6;

/**
 * Horizontal extent of the slope foot inside the LOWER cell. Cliffs stay
 * VERTICAL (offset = 0) — flaring them outward makes raised plateaus read as
 * "Mayan pyramids" with the bottom wider than the top, which is jarring at
 * close range. River banks and beach edges keep the gentle slope so they
 * read as ACNH dirt/sand banks rather than vertical cliffs.
 *
 * Each value must stay < 0.5 m (half a cell) so two perpendicular slopes at a
 * concave corner do not overlap past the cell center.
 */
const SLOPE_OFFSET_CLIFF = 0;
// River banks vertical too: a non-zero offset pushes the bottom edge INTO
// the FW cell, which raises the visible cascade-pool meeting point and
// reads as a triangular "hole" at the base of the cascade ("l'arrête est
// levée comme pour faire une pente"). With offset=0 the bank is a clean
// vertical wall and the cascade meets the lower water plane edge-to-edge.
const SLOPE_OFFSET_RIVER_BANK = 0;

const CLIFF_VERTEX_VARYINGS = /* glsl */`
varying vec3 vCliffWorldPos;
varying vec3 vCliffWorldNormal;
`;

const CLIFF_VERTEX_BODY = /* glsl */`
vCliffWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vCliffWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const CLIFF_FRAGMENT_HEADER = /* glsl */`
varying vec3 vCliffWorldPos;
varying vec3 vCliffWorldNormal;
uniform sampler2D uCliffGrassTex;
uniform float uCliffGrassTileSize;

float cliffHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float cliffNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = cliffHash(i);
  float b = cliffHash(i + vec2(1.0, 0.0));
  float c = cliffHash(i + vec2(0.0, 1.0));
  float d = cliffHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

// ACNH-style cliff fragment, randomised:
//   - color varies via 3 octaves of FBM noise with isotropic (square)
//     X/Y frequencies so tall narrow walls do not stretch the noise into
//     wood-grain stripes (the user's "ça devient du bois" complaint when
//     a deep pit exposes a tall cliff face)
//   - cracks are SEGMENTS, not full-height streaks: each crack picks a
//     vertical band of the wall and only darkens within it, then fades
//     out — no single crack reaches from grass top to cliff foot
//   - grass crest top edge jittered by noise so the lip silhouette is wavy
//   - strong AO foot shadow in the bottom 55% kept for grounding
//
// Everything keys off `along` (world-X or world-Z depending on wall normal)
// and `vCliffWorldPos.y` so neighbouring wall segments meet seamlessly with
// no visible cell boundary.
const CLIFF_FRAGMENT_BODY = /* glsl */`
#ifdef USE_MAP
  {
    vec3 n = normalize(vCliffWorldNormal);
    float along = abs(n.x) > abs(n.z) ? vCliffWorldPos.z : vCliffWorldPos.x;
    float worldY = vCliffWorldPos.y;
    float height01 = clamp(vMapUv.y, 0.0, 1.0);

    // 3-octave FBM color variation, X-biased so the noise reads as
    // HORIZONTAL stratification rather than vertical streaks. X freqs are
    // 3-5x the Y freqs, which on a 1 m × 1.4 m+ cliff produces wider
    // horizontal blobs and short vertical extents — opposite of the
    // wood-plank look the user reported. A matched X/Y pair (1.1, 1.1)
    // still read as wood because tall walls have a larger Y range than
    // the 1 m cell width and the noise stretched that way.
    float n1 = cliffNoise(vec2(along * 3.5, worldY * 0.9));
    float n2 = cliffNoise(vec2(along * 6.5 + 17.3, worldY * 1.7 - 4.2));
    float n3 = cliffNoise(vec2(along * 11.0 - 9.1, worldY * 3.0 + 2.8));
    float colorVar = clamp(n1 * 0.55 + n2 * 0.30 + n3 * 0.15, 0.0, 1.0);

    // Subtle horizontal stratum lines: thin darker bands every ~30 cm
    // vertically with noise-jittered Y position. Reads as sedimentary
    // rock layers, breaks any residual vertical look.
    float stratumY = worldY + cliffNoise(vec2(along * 0.7, worldY * 0.3)) * 0.12;
    float stratum = abs(fract(stratumY * 3.3) - 0.5);
    float stratumDark = smoothstep(0.45, 0.50, stratum) * 0.18;

    // Vertical cracks (matching ACNH reference) but explicitly IMPERFECT:
    //   1. each crack picks a random X position deterministic per cell-X,
    //   2. picks a vertical EXTENT [yLow, yHigh] of varied length (25-90 cm)
    //      so the crack does not run from cliff foot to crest,
    //   3. wobbles its X position by noise of worldY (~6 cm peak) so the
    //      crack curves along its length instead of running ruler-straight,
    //   4. carries a per-fragment thickness that breathes (1-4 cm) along Y.
    // Result: short curved dark slits at varying X positions, of varied
    // length and thickness — "des traits imparfaits qui font pas toute la
    // ligne, plus ou moins gros, pas droits", per the user's spec.
    float fissure = 0.0;
    for (int k = 0; k < 4; k++) {
      float fk = float(k);
      float seedX = cliffNoise(vec2(fk * 13.7, fk * 21.3));
      float fx    = floor(along * 0.85 + seedX * 7.0) / 0.85;
      float xOff  = (cliffNoise(vec2(floor(along * 0.85 + seedX * 7.0), fk * 5.3)) - 0.5) * 0.45;
      float xCenter = fx + xOff;

      // Curve the crack: xCenter wobbles by noise of worldY, ~6 cm peak.
      float crackJitter = (cliffNoise(vec2(worldY * 0.9 + fk * 11.0, fx * 0.4)) - 0.5) * 0.06;
      float xEffective = xCenter + crackJitter;

      // Random vertical extent for this crack.
      float ySeed   = cliffNoise(vec2(floor(along * 0.85 + seedX * 7.0) + 7.0, fk * 9.1));
      float yCenter = ySeed * 4.0 - 1.5 + worldY - mod(worldY, 1.4);
      float yHalf   = 0.13 + ySeed * 0.32;

      // Thickness varies along the length.
      float thickSeed = cliffNoise(vec2(worldY * 1.3 + fk * 4.0, xCenter * 0.6));
      float halfThickness = 0.010 + thickSeed * 0.030;

      float dX = abs(along - xEffective);
      float dY = abs(worldY - yCenter);
      float coreX = smoothstep(halfThickness, halfThickness * 0.4, dX);
      float coreY = smoothstep(yHalf, yHalf * 0.6, dY);
      float core  = coreX * coreY;
      float topFade = 1.0 - smoothstep(0.86, 1.0, height01);
      fissure = max(fissure, core * topFade * (0.30 + thickSeed * 0.30));
    }

    float bottomShadow = 1.0 - smoothstep(0.08, 0.55, height01);
    float topLight     = smoothstep(0.62, 1.0, height01);

    vec3 darkEarth = vec3(0.34, 0.19, 0.11);
    vec3 warmEarth = vec3(0.74, 0.46, 0.30);
    vec3 cliffColor = mix(darkEarth, warmEarth, 0.42 + colorVar * 0.46);
    cliffColor *= max(0.0, 1.0 - bottomShadow * 0.42 - fissure - stratumDark);
    cliffColor += vec3(0.060, 0.040, 0.022) * topLight;

    // Grass crest blend with a noisy top boundary so the lip silhouette is
    // not a perfectly straight line.
    vec2 grassUv    = vCliffWorldPos.xz / uCliffGrassTileSize;
    vec3 grassColor = texture2D(uCliffGrassTex, grassUv).rgb;
    float crestJitter = (cliffNoise(vec2(along * 1.7, 0.0)) - 0.5) * 0.04;
    float crest       = smoothstep(0.91 + crestJitter, 1.0 + crestJitter, height01);
    cliffColor = mix(cliffColor, grassColor * 0.88, crest);

    diffuseColor.rgb *= cliffColor;
  }
#endif
`;

export function buildCliffSideMesh(
  grid: TerrainGrid,
  textures: SurfaceTextureSet,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'cliff-side-walls';

  const cliffWallMaterial = createCliffWallMaterial(textures);

  // River / pond bank — packed brown earth. dirtPath (warm brown) reads as a
  // riverbank in ACNH style; cliffSide rocky strata reads as wrong on a calm
  // pond, and riverbed sand reads as wet sand on top of the bank.
  const riverBankMaterial = new THREE.MeshStandardMaterial({
    map: textures.dirtPath,
    roughness: 0.94,
    side: THREE.DoubleSide,
  });
  riverBankMaterial.name = 'river-bank-material';

  // Drape lip samples the SAME grass texture as the ground splat using the
  // SAME anti-tiling logic (two UV scales blended by world-noise). Without
  // anti-tiling the narrow lip strip shows a single uniform color instead of
  // the visible grass-pattern variation the ground has — the result reads as
  // a "painted green band", not as the same grass continuing.
  const grassFringeMaterial = createGrassFringeMaterial(textures);
  grassFringeMaterial.name = 'grass-fringe-material';

  const cliffGeometries: THREE.BufferGeometry[] = [];
  const riverBankGeometries: THREE.BufferGeometry[] = [];
  const grassFringeGeometries: THREE.BufferGeometry[] = [];

  grid.forEachTierDiscontinuity((lowerCx, lowerCz, upperCx, upperCz, dx, dz, drop) => {
    const lowerCell = grid.getCell(lowerCx, lowerCz);
    const upperCell = grid.getCell(upperCx, upperCz);

    // Skip beach→ocean edges: the lowered sand cell already meets the water
    // plane at its boundary; an extra wall would either dip below water or
    // poke through the ocean foam ribbon.
    if (upperCell.surface === Surface.OCEAN) return;

    // For raised-FRESHWATER edges (cascades) we still emit the cliff wall
    // as a ROCK BACKING behind the cascade. Without it the user reads the
    // cascade as floating in midair — they reported "c'est vide derriere
    // la cascade". The waterfall material has stronger polygonOffset than
    // the cliff so the cascade still wins the depth test on its own
    // pixels, but at the cascade's edges (where streaks are translucent
    // / where the cascade quad ends) the rock behind shows through and
    // gives the falling water a place to fall FROM.
    void Surface.FRESHWATER;

    const isBeachToGrassRamp =
      grid.isBeachCell(lowerCx, lowerCz)
      && !grid.isBeachCell(upperCx, upperCz)
      && upperCell.surface === Surface.LAND
      && upperCell.tier === Tier.T0;
    // Grass-fringe lip removed: every variant tried (drape, blade silhouette,
    // organic strip) read as a floating green band detached from the cliff
    // face. The cliff top + cliff face transition will be reworked via a
    // beveled edge on the ground mesh itself, not a separate overlay mesh.
    void isBeachToGrassRamp;

    if (lowerCell.surface === Surface.FRESHWATER) {
      const main = buildSlopedWallGeometry(
        grid, lowerCx, lowerCz, dx, dz, drop, SLOPE_OFFSET_RIVER_BANK,
      );
      riverBankGeometries.push(main);
      for (const tri of buildWallSideClosureGeometries(
        grid, lowerCx, lowerCz, dx, dz, drop, SLOPE_OFFSET_RIVER_BANK,
      )) {
        riverBankGeometries.push(tri);
      }
      return;
    }

    // Beach edge: the LOWER cell is a beach cell (lowered LAND-T0) and the
    // UPPER cell is a regular non-beach LAND cell (grass at tier T0+).
    if (
      isBeachToGrassRamp
    ) {
      // The ground mesh now owns the smooth beach ramp heightfield directly;
      // adding a second wall here causes z-fighting and blue cracks.
      return;
    }

    // Real cliff: LAND-tier-N → LAND-tier-M with N < M. slope_offset is 0 so
    // the wall is purely vertical — its two perpendicular ends collapse to
    // a line and need no closure triangles.
    const geom = buildSlopedWallGeometry(
      grid, lowerCx, lowerCz, dx, dz, drop, SLOPE_OFFSET_CLIFF,
    );
    cliffGeometries.push(geom);
  });

  if (cliffGeometries.length > 0) {
    const merged = mergeBufferGeometries(cliffGeometries);
    const mesh = new THREE.Mesh(merged, cliffWallMaterial);
    mesh.name = 'cliff-walls';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  if (riverBankGeometries.length > 0) {
    const merged = mergeBufferGeometries(riverBankGeometries);
    const mesh = new THREE.Mesh(merged, riverBankMaterial);
    mesh.name = 'river-bank-walls';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  if (grassFringeGeometries.length > 0) {
    const merged = mergeBufferGeometries(grassFringeGeometries);
    const mesh = new THREE.Mesh(merged, grassFringeMaterial);
    mesh.name = 'grass-fringe';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  return group;
}

const FRINGE_VERTEX_VARYING = /* glsl */`
varying vec2 vFringeWorldXZ;
`;

const FRINGE_VERTEX_PUBLISH = /* glsl */`
vFringeWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
`;

const FRINGE_FRAGMENT_HEADER = /* glsl */`
varying vec2 vFringeWorldXZ;
uniform sampler2D uFringeGrassTex;
uniform float uFringeTileSize;

float fringeHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float fringeNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fringeHash(i);
  float b = fringeHash(i + vec2(1.0, 0.0));
  float c = fringeHash(i + vec2(0.0, 1.0));
  float d = fringeHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec3 fringeAntiTiled(sampler2D tex, vec2 worldXZ, float blend) {
  vec2 uvA = worldXZ / uFringeTileSize;
  vec2 uvB = worldXZ / (uFringeTileSize * 1.6) + vec2(13.0, 7.0);
  uvB = vec2(-uvB.y, uvB.x);
  vec3 colorA = texture2D(tex, uvA).rgb;
  vec3 colorB = texture2D(tex, uvB).rgb;
  return mix(colorA, colorB, blend * 0.3);
}
`;

const FRINGE_FRAGMENT_BODY = /* glsl */`
float fringeBlend = smoothstep(0.35, 0.65, fringeNoise(vFringeWorldXZ * 0.27));
vec3 fringeGrass = fringeAntiTiled(uFringeGrassTex, vFringeWorldXZ, fringeBlend);
diffuseColor.rgb *= fringeGrass;
`;

function createGrassFringeMaterial(textures: SurfaceTextureSet): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.92,
    side: THREE.DoubleSide,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  const fringeUniforms: Record<string, THREE.IUniform> = {
    uFringeGrassTex: { value: textures.grass },
    uFringeTileSize: { value: TILE_SIZE_METERS },
  };
  material.userData.fringeUniforms = fringeUniforms;

  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, fringeUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${FRINGE_VERTEX_VARYING}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${FRINGE_VERTEX_PUBLISH}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${FRINGE_FRAGMENT_HEADER}`,
      )
      .replace('#include <map_fragment>', FRINGE_FRAGMENT_BODY);
  };

  material.customProgramCacheKey = () => 'grass-fringe-anti-tiled:v1';
  material.needsUpdate = true;
  return material;
}

function createCliffWallMaterial(textures: SurfaceTextureSet): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: textures.cliffSide,
    roughness: 0.94,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  material.name = 'cliff-wall-material';

  const cliffUniforms: Record<string, THREE.IUniform> = {
    uCliffGrassTex: { value: textures.grass },
    uCliffGrassTileSize: { value: TILE_SIZE_METERS },
  };
  material.userData.cliffUniforms = cliffUniforms;

  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, cliffUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${CLIFF_VERTEX_VARYINGS}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\n${CLIFF_VERTEX_BODY}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${CLIFF_FRAGMENT_HEADER}`,
      )
      .replace('#include <map_fragment>', CLIFF_FRAGMENT_BODY);
  };

  material.customProgramCacheKey = () => 'cliff-wall:v3-strata-grass-crest';
  material.needsUpdate = true;
  return material;
}

/**
 * Organic grass-overhang lip for ONE cell-edge. The lip is a strip of N quads
 * whose TOP edge sits flush on the cell boundary at upperY (no lift — relies
 * on polygonOffset to win the depth test against the grass top) and whose
 * BOTTOM edge has per-vertex random outward push + drop depth, so the lower
 * silhouette is a wavy organic line — like a patch of grass spreading over
 * the cliff edge — instead of a flat band.
 *
 * Color matching: UVs sample the SAME procedural grass texture as the ground
 * splat, in world-XZ space at the same tile scale (TILE_SIZE_METERS). The lip
 * texels continue the grass-top texels at the cell boundary with no visible
 * color seam — the eye reads it as the same grass mat folding down over the
 * edge.
 *
 * Sizing kept small (overhang ~5cm, drop ~7cm) so the lip reads as a tight
 * rim hugging the edge, not a slab dangling off the cliff. Bigger values made
 * the strip "float" perpendicular to the cliff face.
 */
function buildGridGrassFringeGeometry(
  grid: TerrainGrid,
  lowerCx: number,
  lowerCz: number,
  dx: number,
  dz: number,
  drop: number,
): THREE.BufferGeometry {
  const lowerY = grid.cellHeight(lowerCx, lowerCz);
  const upperY = lowerY + drop;
  const x0 = grid.originX + lowerCx * grid.cellSize;
  const z0 = grid.originZ + lowerCz * grid.cellSize;
  const x1 = x0 + grid.cellSize;
  const z1 = z0 + grid.cellSize;

  // edge0 → edge1 oriented so the lower cell sits on the -(dx,dz) side.
  let edge0x: number, edge0z: number, edge1x: number, edge1z: number;
  if (dx === 1) {
    edge0x = x1; edge0z = z0;
    edge1x = x1; edge1z = z1;
  } else if (dx === -1) {
    edge0x = x0; edge0z = z1;
    edge1x = x0; edge1z = z0;
  } else if (dz === 1) {
    edge0x = x1; edge0z = z1;
    edge1x = x0; edge1z = z1;
  } else {
    edge0x = x0; edge0z = z0;
    edge1x = x1; edge1z = z0;
  }

  const tx = edge1x - edge0x;
  const tz = edge1z - edge0z;
  const tangentX = tx;
  const tangentZ = tz;
  const lowerDirX = -dx;
  const lowerDirZ = -dz;

  const baseOverhang = 0.022;
  const baseDrop = 0.050;
  const lift = 0;

  // Lighting normal: mostly UP (matches the grass top) so the lip catches the
  // same overhead light, with just a hint of outward lean for shape definition.
  // A steeper outward lean made the lip render visibly darker than the grass.
  let nx = lowerDirX * 0.18;
  let ny = 0.98;
  let nz = lowerDirZ * 0.18;
  const nLen = Math.hypot(nx, ny, nz);
  nx /= nLen; ny /= nLen; nz /= nLen;

  // Per-vertex top + bottom rows (SEGMENTS+1 columns). Tops are flush with
  // the cell boundary; bottoms wobble in outward push, sideways sway, and
  // drop depth — all keyed off a deterministic hash of (cell, segment) so
  // neighboring cell edges still meet without seams.
  const cols = FRINGE_SEGMENTS_PER_EDGE + 1;
  const positions = new Float32Array(cols * 2 * 3);
  const normals = new Float32Array(cols * 2 * 3);
  const uvs = new Float32Array(cols * 2 * 2);
  const colors = new Float32Array(cols * 2 * 3);

  for (let i = 0; i < cols; i += 1) {
    const t = i / FRINGE_SEGMENTS_PER_EDGE;
    const topX = edge0x + tx * t;
    const topZ = edge0z + tz * t;
    // Endpoints (i=0 and i=cols-1) keep the BASE outward/drop with NO sway,
    // so adjacent cell-edges meet seamlessly at the corners.
    const isEndpoint = i === 0 || i === cols - 1;

    const seed = hash01(lowerCx * 19.17 + lowerCz * 7.31 + i * 3.11 + dx * 4.7 + dz * 2.3);
    const outFactor = isEndpoint ? 1.0 : 0.55 + seed * 0.95;
    const dropFactor = isEndpoint ? 1.0 : 0.45 + hash01(seed * 17.0) * 1.10;
    const swayFactor = isEndpoint ? 0 : (hash01(seed * 37.0) - 0.5) * 0.55;

    const outward = baseOverhang * outFactor;
    const dropDepth = baseDrop * dropFactor;
    const sway = baseOverhang * swayFactor;

    const botX = topX + lowerDirX * outward + tangentX * sway;
    const botZ = topZ + lowerDirZ * outward + tangentZ * sway;
    const botY = upperY - dropDepth;

    const topIdx = i * 2 * 3;
    const botIdx = (i * 2 + 1) * 3;
    positions[topIdx + 0] = topX;
    positions[topIdx + 1] = upperY + lift;
    positions[topIdx + 2] = topZ;
    positions[botIdx + 0] = botX;
    positions[botIdx + 1] = botY;
    positions[botIdx + 2] = botZ;

    normals[topIdx + 0] = nx; normals[topIdx + 1] = ny; normals[topIdx + 2] = nz;
    normals[botIdx + 0] = nx; normals[botIdx + 1] = ny; normals[botIdx + 2] = nz;

    const topUvIdx = i * 2 * 2;
    const botUvIdx = (i * 2 + 1) * 2;
    uvs[topUvIdx + 0] = topX / TILE_SIZE_METERS;
    uvs[topUvIdx + 1] = topZ / TILE_SIZE_METERS;
    uvs[botUvIdx + 0] = botX / TILE_SIZE_METERS;
    uvs[botUvIdx + 1] = botZ / TILE_SIZE_METERS;

    // Both top and bottom pass the grass texture through almost unmodified;
    // bottom gets a tiny per-segment shade jitter (5% range) so the strip has
    // organic variation but stays the SAME tone as the grass top — no visible
    // dark band under the lip.
    const shade = 0.95 + hash01(seed * 43.0) * 0.05;
    colors[topIdx + 0] = 1.0; colors[topIdx + 1] = 1.0; colors[topIdx + 2] = 1.0;
    colors[botIdx + 0] = shade; colors[botIdx + 1] = shade; colors[botIdx + 2] = shade;
  }

  // Triangulate as a 2×N strip: per segment, two triangles connecting
  // (top_i, top_i+1, bot_i+1) and (top_i, bot_i+1, bot_i).
  const indexCount = FRINGE_SEGMENTS_PER_EDGE * 6;
  const indices = new Uint32Array(indexCount);
  for (let i = 0; i < FRINGE_SEGMENTS_PER_EDGE; i += 1) {
    const top0 = i * 2;
    const bot0 = i * 2 + 1;
    const top1 = (i + 1) * 2;
    const bot1 = (i + 1) * 2 + 1;
    const off = i * 6;
    indices[off + 0] = top0;
    indices[off + 1] = top1;
    indices[off + 2] = bot1;
    indices[off + 3] = top0;
    indices[off + 4] = bot1;
    indices[off + 5] = bot0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  return geometry;
}

function hash01(value: number): number {
  const x = Math.sin(value * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * One sloped wall quad placed at the edge between (lowerCx, lowerCz) and its
 * neighbor in direction (dx, dz). Top edge at the cell boundary (Y=upperY),
 * bottom edge at (Y=lowerY) pushed horizontally INTO the lower cell by
 * `slopeOffset`. Yields a tilted ramp visible above the lower cell's flat
 * ground mesh.
 *
 * Normal is the outward+up perpendicular of the slope plane, so lighting
 * shades the slope as a tilted face (vs flat sidewise on the old vertical
 * walls).
 */
function buildSlopedWallGeometry(
  grid: TerrainGrid,
  lowerCx: number,
  lowerCz: number,
  dx: number,
  dz: number,
  drop: number,
  slopeOffset: number,
): THREE.BufferGeometry {
  const lowerY = grid.cellHeight(lowerCx, lowerCz);
  const upperY = lowerY + drop;

  const x0 = grid.originX + lowerCx * grid.cellSize;
  const z0 = grid.originZ + lowerCz * grid.cellSize;
  const x1 = x0 + grid.cellSize;
  const z1 = z0 + grid.cellSize;

  // Top edge sits at the boundary between lower and upper cells.
  // Bottom edge is pushed `slopeOffset` INTO the lower cell (opposite of (dx, dz)).
  // The 4 vertices are laid out so the triangulation `0,1,2 / 0,2,3` always
  // produces an outward-facing front face when wound CCW around the slope normal.
  let pBot0x: number, pBot0z: number, pBot1x: number, pBot1z: number;
  let pTop0x: number, pTop0z: number, pTop1x: number, pTop1z: number;

  if (dx === 1) {
    // Upper cell is to the east; boundary at x=x1; lower cell extends to -X.
    // Bottom pushed -X by slopeOffset.
    pTop0x = x1; pTop0z = z0;
    pTop1x = x1; pTop1z = z1;
    pBot0x = x1 - slopeOffset; pBot0z = z0;
    pBot1x = x1 - slopeOffset; pBot1z = z1;
  } else if (dx === -1) {
    // Upper west, lower extends to +X. Bottom pushed +X.
    pTop0x = x0; pTop0z = z1;
    pTop1x = x0; pTop1z = z0;
    pBot0x = x0 + slopeOffset; pBot0z = z1;
    pBot1x = x0 + slopeOffset; pBot1z = z0;
  } else if (dz === 1) {
    // Upper north, lower extends to -Z. Bottom pushed -Z.
    pTop0x = x1; pTop0z = z1;
    pTop1x = x0; pTop1z = z1;
    pBot0x = x1; pBot0z = z1 - slopeOffset;
    pBot1x = x0; pBot1z = z1 - slopeOffset;
  } else {
    // dz === -1. Upper south, lower extends to +Z. Bottom pushed +Z.
    pTop0x = x0; pTop0z = z0;
    pTop1x = x1; pTop1z = z0;
    pBot0x = x0; pBot0z = z0 + slopeOffset;
    pBot1x = x1; pBot1z = z0 + slopeOffset;
  }

  // Slope outward+up normal. For a face whose tangent (bottom→top) is
  // (slopeOffset along -(dx,dz), drop along +Y), the outward+up perpendicular
  // points along (-dx, slopeOffset/drop_norm, -dz) — i.e. away from the upper
  // cell horizontally and upward vertically.
  const slopeLen = Math.hypot(slopeOffset, drop);
  const nHoriz = drop / slopeLen;
  const nUp = slopeOffset / slopeLen;
  let nx = -dx * nHoriz;
  let ny = nUp;
  let nz = -dz * nHoriz;
  // Faux-up shading for vertical / near-vertical walls. Pure cliffs have
  // slopeOffset=0 → ny=0 → dot(N, sun_overhead) = 0 → walls render pitch-black
  // at noon. Bias the normal upward so the wall always picks up overhead light.
  // Geometry is unchanged — only the LIGHTING normal is rotated. The user
  // notices vertical walls only lighting at sunset; with this bias they read
  // as lit at every sun angle.
  const MIN_NORMAL_Y = 0.45;
  if (ny < MIN_NORMAL_Y) {
    ny = MIN_NORMAL_Y;
    const len = Math.hypot(nx, ny, nz);
    nx /= len;
    ny /= len;
    nz /= len;
  }

  const positions = new Float32Array([
    pBot0x, lowerY, pBot0z,
    pBot1x, lowerY, pBot1z,
    pTop1x, upperY, pTop1z,
    pTop0x, upperY, pTop0z,
  ]);
  const normals = new Float32Array([
    nx, ny, nz,
    nx, ny, nz,
    nx, ny, nz,
    nx, ny, nz,
  ]);

  // UVs: u along the edge (1m of cell width → cell/HORIZONTAL_TILE), v
  // ALWAYS 0..1 along the slope so the cliff fragment shader's `height01`
  // is correctly normalized regardless of drop height. A previous version
  // scaled v by `slopeLen / VERTICAL_TILE_METERS`, which made multi-tier
  // cliffs (drop > 1.4m) read as v > 1 across the upper half — the shader's
  // `clamp(vMapUv.y, 0, 1)` then locked the entire upper half to the
  // "top crest" branch and tinted it grass-green. The cliff fragment shader
  // is fully procedural (no actual `map` texel sample), so v-tiling is not
  // needed for texture quality.
  const uMax = grid.cellSize / HORIZONTAL_TILE_METERS;
  void VERTICAL_TILE_METERS;
  void VERTICAL_TILES;
  const vMax = 1.0;
  const uvs = new Float32Array([
    0, 0,
    uMax, 0,
    uMax, vMax,
    0, vMax,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  return geometry;
}

/**
 * For a sloped wall with slopeOffset > 0, the wall is a tilted quad whose TOP
 * edge sits on the cell boundary and whose BOTTOM edge is pushed `slopeOffset`
 * INTO the lower cell. The two perpendicular ENDS of this tilted quad are
 * OPEN — there's no geometry closing the side faces. When the wall does not
 * have an adjacent wall continuing it (e.g. at a beach band's perpendicular
 * turn or at an isolated grass patch corner), these open ends read as visible
 * triangular holes through which the camera sees water / next cell.
 *
 * This emits two triangular closure pieces, one per perpendicular end. Each
 * triangle lies in the plane of the cell boundary perpendicular axis and
 * connects the TOP corner (at upperY, on the cell-edge) to the BOTTOM corner
 * AT the cell-edge (at lowerY, on the cell-edge) and the BOTTOM corner
 * INSIDE the cell (at lowerY, at slopeOffset distance). Material is DoubleSide
 * so winding doesn't matter.
 */
function buildWallSideClosureGeometries(
  grid: TerrainGrid,
  lowerCx: number,
  lowerCz: number,
  dx: number,
  dz: number,
  drop: number,
  slopeOffset: number,
): THREE.BufferGeometry[] {
  if (slopeOffset <= 0) return [];
  const x0 = grid.originX + lowerCx * grid.cellSize;
  const x1 = x0 + grid.cellSize;
  const z0 = grid.originZ + lowerCz * grid.cellSize;
  const z1 = z0 + grid.cellSize;
  const lowerY = grid.cellHeight(lowerCx, lowerCz);
  const upperY = lowerY + drop;

  // Skip a closure triangle when the perpendicular neighbour cell has any
  // wall meeting this corner. Two cases:
  //   1. perpendicular cell is FW at the same height → a perpendicular
  //      river bank continues around the corner, its slope fills the gap
  //   2. perpendicular cell is at a different cellHeight → there is a
  //      tier-drop wall (cascade or cliff) at that boundary, which covers
  //      the closure triangle's footprint
  //
  // Without this, the closure triangle at the cascade-side end of a pond
  // bank pokes out as a flat brown facet next to the cascade — visible as
  // the user's "triangle marron en haut a gauche de la riviere" at pond
  // and dug-river corners.
  const lowerSurface = grid.getSurface(lowerCx, lowerCz);
  const isFwBank = lowerSurface === Surface.FRESHWATER;
  const lowerH = grid.cellHeight(lowerCx, lowerCz);
  const perpHandled = (cx: number, cz: number): boolean => {
    if (!grid.cellInBounds(cx, cz)) return false;
    if (grid.getSurface(cx, cz) === Surface.FRESHWATER) return true;
    const h = grid.cellHeight(cx, cz);
    if (Number.isNaN(h)) return false;
    return Math.abs(h - lowerH) > 0.01;
  };

  const tris: THREE.BufferGeometry[] = [];

  if (dx === 1) {
    // East-facing wall: closures at z=z0 (cz-1 perp) and z=z1 (cz+1 perp).
    const skip0 = isFwBank && perpHandled(lowerCx, lowerCz - 1);
    const skip1 = isFwBank && perpHandled(lowerCx, lowerCz + 1);
    if (!skip0) {
      tris.push(buildSideTriangle(
        x1, upperY, z0,
        x1, lowerY, z0,
        x1 - slopeOffset, lowerY, z0,
      ));
    }
    if (!skip1) {
      tris.push(buildSideTriangle(
        x1, upperY, z1,
        x1 - slopeOffset, lowerY, z1,
        x1, lowerY, z1,
      ));
    }
  } else if (dx === -1) {
    // West-facing wall: same perpendicular axis.
    const skip0 = isFwBank && perpHandled(lowerCx, lowerCz - 1);
    const skip1 = isFwBank && perpHandled(lowerCx, lowerCz + 1);
    if (!skip0) {
      tris.push(buildSideTriangle(
        x0, upperY, z0,
        x0 + slopeOffset, lowerY, z0,
        x0, lowerY, z0,
      ));
    }
    if (!skip1) {
      tris.push(buildSideTriangle(
        x0, upperY, z1,
        x0, lowerY, z1,
        x0 + slopeOffset, lowerY, z1,
      ));
    }
  } else if (dz === 1) {
    // North-facing wall: closures at x=x0 (cx-1 perp) and x=x1 (cx+1 perp).
    const skip0 = isFwBank && perpHandled(lowerCx - 1, lowerCz);
    const skip1 = isFwBank && perpHandled(lowerCx + 1, lowerCz);
    if (!skip0) {
      tris.push(buildSideTriangle(
        x0, upperY, z1,
        x0, lowerY, z1,
        x0, lowerY, z1 - slopeOffset,
      ));
    }
    if (!skip1) {
      tris.push(buildSideTriangle(
        x1, upperY, z1,
        x1, lowerY, z1 - slopeOffset,
        x1, lowerY, z1,
      ));
    }
  } else {
    // dz === -1. South-facing wall: same perpendicular axis as dz===1.
    const skip0 = isFwBank && perpHandled(lowerCx - 1, lowerCz);
    const skip1 = isFwBank && perpHandled(lowerCx + 1, lowerCz);
    if (!skip0) {
      tris.push(buildSideTriangle(
        x0, upperY, z0,
        x0, lowerY, z0 + slopeOffset,
        x0, lowerY, z0,
      ));
    }
    if (!skip1) {
      tris.push(buildSideTriangle(
        x1, upperY, z0,
        x1, lowerY, z0,
        x1, lowerY, z0 + slopeOffset,
      ));
    }
  }

  return tris;
}

function buildSideTriangle(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): THREE.BufferGeometry {
  // Up-facing normal is fine for ACNH-style cozy lighting; the side closure is
  // small and DoubleSide renders both faces. UVs are a tight triangle in the
  // bottom-right of the texture so the visible color matches the slope wall.
  const positions = new Float32Array([ax, ay, az, bx, by, bz, cx, cy, cz]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const uvs = new Float32Array([0.5, 1, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  return geom;
}

/**
 * Concatenates BufferGeometry instances by appending their attributes. All
 * inputs must have the same attributes (`position`, `normal`, `uv`) and an
 * index. We avoid the dependency on `BufferGeometryUtils.mergeGeometries`
 * to keep the import surface small.
 */
function mergeBufferGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geometries) {
    totalVerts += g.getAttribute('position').count;
    const idx = g.getIndex();
    totalIndices += idx ? idx.count : g.getAttribute('position').count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const hasColors = geometries.some((g) => g.getAttribute('color') !== undefined);
  const colors = hasColors ? new Float32Array(totalVerts * 3) : undefined;
  const indices = totalVerts < 65536
    ? new Uint16Array(totalIndices)
    : new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;
  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const idx = g.getIndex();

    positions.set(pos.array as Float32Array, vertOffset * 3);
    normals.set(nor.array as Float32Array, vertOffset * 3);
    uvs.set(uv.array as Float32Array, vertOffset * 2);
    if (colors) {
      const color = g.getAttribute('color');
      if (color) {
        colors.set(color.array as Float32Array, vertOffset * 3);
      } else {
        colors.fill(1, vertOffset * 3, (vertOffset + pos.count) * 3);
      }
    }

    if (idx) {
      const arr = idx.array;
      for (let i = 0; i < arr.length; i += 1) {
        indices[idxOffset + i] = arr[i] + vertOffset;
      }
      idxOffset += arr.length;
    } else {
      for (let i = 0; i < pos.count; i += 1) {
        indices[idxOffset + i] = i + vertOffset;
      }
      idxOffset += pos.count;
    }

    vertOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
