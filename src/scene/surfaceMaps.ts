import * as THREE from 'three';
import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';
import { classifySurfaceAt, SURFACE_SPLAT_CHANNELS, type SurfaceClassification } from './surfaceClassification';
import { GRID_D, GRID_W, getTerrainGrid } from './terrain/TerrainGrid';

export interface SurfaceMaps {
  aoMap: THREE.DataTexture;
  cliffEdgeMap: THREE.DataTexture;
  /** Distance-to-ocean only (excludes the river). Drives the shoreWashMesh alpha so
   * the wave ribbon sweeps onto the outer beach without contaminating the river bank. */
  oceanShoreMask: THREE.DataTexture;
  /**
   * Path overlay mask (Step 7). 94 × 78 R8 NearestFilter — grid-native (one
   * texel per cell) so painting a path is a single byte write per cell with
   * no analytical resampling. Byte value = the cell's `path` field (0 = no
   * path, 1..15 = path style index).
   */
  pathMask: THREE.DataTexture;
  resolution: number;
  /** River-only mask. Keeps ocean water from inheriting the inner-river palette. */
  riverMask: THREE.DataTexture;
  /**
   * Pre-baked SIGNED SDF distance to the shoreline, encoded so 0 maps to 128 (mid),
   * negative values (inland) below 128, positive values (offshore) above 128. Linear-
   * filtered so the terrain fragment shader can read sub-pixel-smooth coastline values
   * and discard with no staircase artefact at the island border.
   */
  shoreDistanceMap: THREE.DataTexture;
  /** Combined river-bank + ocean-shore distance (max). Used by the water shader and
   * by the terrain shader for the wet-sand effect. Kept for backward compatibility. */
  shoreMask: THREE.DataTexture;
  splatMap: THREE.DataTexture;
  worldDepth: number;
  worldWidth: number;
}

/** World distance encoded in `shoreDistanceMap` at byte = 255. */
export const MAX_SHORE_DISTANCE_METERS = 8;

/**
 * 512² gives ~16 cm per texel on the 80 m terrain — enough that the splat-driven
 * grass↔sand boundary stops reading as a visible pixel staircase at typical camera
 * distance. 256² (which we used initially) showed ~31 cm steps that lit as obvious
 * jagged "marches" on the curved coast. Memory cost: ~1 MB for the RGBA splatmap +
 * 1 MB total for the four R8 maps = ~2 MB GPU.
 */
export const DEFAULT_SURFACE_MAP_RESOLUTION = 512;

export function createSurfaceMaps(resolution = DEFAULT_SURFACE_MAP_RESOLUTION): SurfaceMaps {
  const splatData = new Uint8Array(resolution * resolution * 4);
  const aoData = new Uint8Array(resolution * resolution);
  const cliffEdgeData = new Uint8Array(resolution * resolution);
  const shoreData = new Uint8Array(resolution * resolution);
  const oceanShoreData = new Uint8Array(resolution * resolution);
  const riverData = new Uint8Array(resolution * resolution);
  const shoreDistanceData = new Uint8Array(resolution * resolution);

  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const { worldX, worldZ } = surfaceTexelToWorld(column, row, resolution);
      const surface = classifySurfaceAt(worldX, worldZ);
      const index = row * resolution + column;
      const splatIndex = index * 4;

      splatData[splatIndex] = toByte(surface.splat.grass);
      splatData[splatIndex + 1] = toByte(surface.splat.sand);
      splatData[splatIndex + 2] = toByte(surface.splat.dirt);
      splatData[splatIndex + 3] = toByte(surface.splat.cliff);

      aoData[index] = toByte(getTransitionOcclusion(surface));
      cliffEdgeData[index] = toByte(surface.cliffEdge);
      shoreData[index] = toByte(surface.shore);
      oceanShoreData[index] = toByte(surface.islandShore);
      riverData[index] = surface.inRiver ? 255 : 0;
      // Signed SDF: negative inland, positive offshore. Mapped to [0, 1] so 0.5 is
      // exactly on the shore. Used by the terrain shader for sub-pixel-smooth discard.
      const signedDistance = surface.isInIsland ? -surface.shoreDistance : surface.shoreDistance;
      const normalized = clamp01(
        (signedDistance / MAX_SHORE_DISTANCE_METERS) * 0.5 + 0.5,
      );
      shoreDistanceData[index] = toByte(normalized);
    }
  }

  const splatMap = createDataTexture(splatData, resolution, THREE.RGBAFormat, 'surface-splat-map');
  splatMap.userData.channels = SURFACE_SPLAT_CHANNELS;
  // Linear-filtered splat keeps the channel weights coherent with the linear-filtered
  // shoreDistanceMap at the island edge. With NearestFilter on splat and Linear on
  // shoreDistance, sub-texel disagreement at the coast caused fragments where the
  // shader saw `weightSum ≈ 0` but `signedShore < 0.5`, computing `surfaceColor = 0`
  // and rendering as a black stipple along the shore.
  splatMap.magFilter = THREE.LinearFilter;
  splatMap.minFilter = THREE.LinearFilter;

  // Continuous-value masks use LinearFilter so the consumer shaders can sample
  // sub-texel-smooth values without staircase artefacts at thresholded edges.
  // Categorical masks (splat, cliffEdge) stay NearestFilter to preserve crisp
  // boundaries between surface kinds.
  const shoreDistanceMap = makeLinearFilteredMap(
    shoreDistanceData,
    resolution,
    'surface-shore-distance-map',
  );
  const shoreMask = makeLinearFilteredMap(shoreData, resolution, 'surface-shore-mask');
  const oceanShoreMask = makeLinearFilteredMap(
    oceanShoreData,
    resolution,
    'surface-ocean-shore-mask',
  );
  const riverMask = makeLinearFilteredMap(riverData, resolution, 'surface-river-mask');

  // Path mask — grid-native 94 × 78 R8 NearestFilter. One byte per cell stores
  // the cell's `path` field directly. The splat shader maps fragment world XZ
  // → cell index → texel and overlays the path color when path > 0.
  const pathData = new Uint8Array(GRID_W * GRID_D);
  const grid = getTerrainGrid();
  grid.forEachCell((cx, cz, cell) => {
    pathData[cz * GRID_W + cx] = cell.path & 0x0F;
  });
  const pathMask = new THREE.DataTexture(
    pathData, GRID_W, GRID_D, THREE.RedFormat, THREE.UnsignedByteType,
  );
  pathMask.name = 'surface-path-mask';
  pathMask.magFilter = THREE.NearestFilter;
  pathMask.minFilter = THREE.NearestFilter;
  pathMask.wrapS = THREE.ClampToEdgeWrapping;
  pathMask.wrapT = THREE.ClampToEdgeWrapping;
  pathMask.unpackAlignment = 1;
  pathMask.generateMipmaps = false;
  pathMask.needsUpdate = true;

  return {
    aoMap: createDataTexture(aoData, resolution, THREE.RedFormat, 'surface-ao-map'),
    cliffEdgeMap: createDataTexture(cliffEdgeData, resolution, THREE.RedFormat, 'surface-cliff-edge-map'),
    oceanShoreMask,
    pathMask,
    resolution,
    riverMask,
    shoreDistanceMap,
    shoreMask,
    splatMap,
    worldDepth: ISLAND_TERRAIN_DEPTH,
    worldWidth: ISLAND_TERRAIN_WIDTH,
  };
}

function makeLinearFilteredMap(
  data: Uint8Array,
  resolution: number,
  name: string,
): THREE.DataTexture {
  const texture = createDataTexture(data, resolution, THREE.RedFormat, name);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

export function worldToSurfaceMapUv(worldX: number, worldZ: number): [number, number] {
  return [
    (worldX + ISLAND_TERRAIN_WIDTH / 2) / ISLAND_TERRAIN_WIDTH,
    (worldZ + ISLAND_TERRAIN_DEPTH / 2) / ISLAND_TERRAIN_DEPTH,
  ];
}

function surfaceTexelToWorld(column: number, row: number, resolution: number) {
  const u = (column + 0.5) / resolution;
  const v = (row + 0.5) / resolution;

  return {
    worldX: u * ISLAND_TERRAIN_WIDTH - ISLAND_TERRAIN_WIDTH / 2,
    worldZ: v * ISLAND_TERRAIN_DEPTH - ISLAND_TERRAIN_DEPTH / 2,
  };
}

function createDataTexture(
  data: Uint8Array,
  resolution: number,
  format: THREE.PixelFormat,
  name: string,
) {
  const texture = new THREE.DataTexture(data, resolution, resolution, format, THREE.UnsignedByteType);
  texture.name = name;
  texture.generateMipmaps = false;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return texture;
}

function getTransitionOcclusion(surface: SurfaceClassification) {
  const cliffShadow = surface.cliffEdge * 0.72;
  const waterlineShadow = surface.riverBank * 0.18;
  const oceanEdgeShadow = surface.islandShore * 0.12;
  const pathShadow = surface.isPath ? 0.04 : 0;
  const beachTransitionShadow = surface.beachBlend > 0 && surface.beachBlend < 1 ? 0.05 : 0;

  return clamp01(cliffShadow + waterlineShadow + oceanEdgeShadow + pathShadow + beachTransitionShadow);
}

function toByte(value: number) {
  return Math.round(clamp01(value) * 255);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
