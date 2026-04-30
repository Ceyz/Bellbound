import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';
import { getIslandHeight, isInRiver, isOnCliff } from './heightmap';
import { sampleIslandShape } from './islandShape';
import { Surface, getTerrainGrid } from './terrain/TerrainGrid';

export type SurfaceKind = 'grass' | 'sand' | 'dirt' | 'riverbed' | 'cliff' | 'void';

export type SurfaceSplatChannel = 'grass' | 'sand' | 'dirt' | 'cliff';

export interface SurfaceSplatWeights {
  grass: number;
  sand: number;
  dirt: number;
  cliff: number;
}

export interface SurfaceClassification {
  altitude: number;
  beachBlend: number;
  cliffEdge: number;
  inRiver: boolean;
  /**
   * Distance (m) from this point to the nearest shoreline, derived from the SDF.
   * Always non-negative. Use `isInIsland` to know which side of the shore we're on.
   */
  shoreDistance: number;
  islandShore: number;
  isBeach: boolean;
  isFullySand: boolean;
  /** True when (x, z) sits inside the SDF island silhouette. */
  isInIsland: boolean;
  isPath: boolean;
  kind: SurfaceKind;
  onCliff: boolean;
  shore: number;
  splat: SurfaceSplatWeights;
  riverBank: number;
  worldX: number;
  worldZ: number;
}

export const SURFACE_SPLAT_CHANNELS: Record<SurfaceSplatChannel, 'r' | 'g' | 'b' | 'a'> = {
  grass: 'r',
  sand: 'g',
  dirt: 'b',
  cliff: 'a',
};

const TERRAIN_HALF_WIDTH = ISLAND_TERRAIN_WIDTH / 2;
const TERRAIN_HALF_DEPTH = ISLAND_TERRAIN_DEPTH / 2;

/**
 * Single source of truth for the island's visual surface classification.
 *
 * The RGBA splat packing intentionally keeps only four channels:
 * R grass, G sand, B dirt/riverbed, A cliff top. Riverbed remains a distinct
 * semantic `kind`, but currently shares the dirt splat channel until a second
 * splat texture is worth the extra shader cost.
 */
export function classifySurfaceAt(worldX: number, worldZ: number): SurfaceClassification {
  const shape = sampleIslandShape(worldX, worldZ);
  const isInIsland = shape.isLand;
  const shoreDistance = shape.shoreDistance;

  // beachBlend is now a continuous SDF-driven function: 0 deep inland, 1 at and
  // beyond the shore. The transition zone is `BEACH_TRANSITION_METERS` wide.
  const beachBlend = shape.beachT;

  const inRiver = isInIsland && isInRiver(worldX, worldZ);
  const onCliff = isInIsland && !inRiver && isOnCliff(worldX, worldZ);
  // Hardcoded paths to the (now-removed) house and shop were dropped during the
  // terraforming refactor scene cleanup; players will paint paths via the path
  // tool once Step 7 ships.
  const isPath = false;
  const isBeach = isInIsland && !inRiver && beachBlend >= 0.5;
  // Match `getSurfaceKind`'s sand threshold so anywhere the surface kind reads
  // "sand" the gameplay also considers it sand for footprint spawning.
  const isFullySand = isInIsland && !inRiver && beachBlend >= 0.4;

  const kind: SurfaceKind = !isInIsland
    ? 'void'
    : getSurfaceKind({ beachBlend, inRiver, isPath, onCliff });
  const splat = getSplatWeights(kind, beachBlend);

  const cliffEdge = isInIsland ? getCliffEdgeStrength(worldX, worldZ) : 0;
  const riverBank = isInIsland ? getRiverBankStrength(worldX, worldZ) : 0;
  const islandShore = getIslandShoreStrength(shoreDistance, isInIsland);
  const shore = Math.max(riverBank, islandShore);

  return {
    altitude: getIslandHeight(worldX, worldZ),
    beachBlend,
    cliffEdge,
    inRiver,
    shoreDistance,
    islandShore,
    isBeach,
    isFullySand,
    isInIsland,
    isPath,
    kind,
    onCliff,
    shore,
    splat,
    riverBank,
    worldX,
    worldZ,
  };
}

export function isOnSand(worldX: number, worldZ: number): boolean {
  return classifySurfaceAt(worldX, worldZ).isFullySand;
}

export function surfaceWeightAt(
  worldX: number,
  worldZ: number,
  channel: SurfaceSplatChannel,
): number {
  return classifySurfaceAt(worldX, worldZ).splat[channel];
}

function getSurfaceKind(surface: {
  beachBlend: number;
  inRiver: boolean;
  isPath: boolean;
  onCliff: boolean;
}): Exclude<SurfaceKind, 'void'> {
  if (surface.inRiver) return 'riverbed';
  // Sand kind threshold tuned for the wider BEACH_TRANSITION_METERS = 6 zone:
  // 0.4 corresponds to ~3.6 m of shoreDistance, matching the visible sand band.
  if (surface.beachBlend >= 0.4) return 'sand';
  if (surface.isPath) return 'dirt';
  if (surface.onCliff) return 'cliff';
  return 'grass';
}

/**
 * Splat weights are continuous in the beach transition zone so the grass↔sand
 * boundary follows the curved shoreline instead of a hard binary edge. Outside the
 * transition (deep inland, fully on sand, on path/cliff/river) the split stays
 * categorical so cliffs and paths read as crisply as before.
 *
 * The grass↔sand curve uses a tightened smoothstep [0.30, 0.55] rather than the raw
 * `beachBlend`. Effect on a 3 m beach band:
 *  - shoreDistance > 2.1 m  ⇒ pure grass
 *  - shoreDistance ≈ 1.4 m  ⇒ 50/50 transition
 *  - shoreDistance < 1.35 m ⇒ pure sand (≈ 1.5 m wide visible band, the ACNH look)
 */
function getSplatWeights(kind: SurfaceKind, beachBlend: number): SurfaceSplatWeights {
  if (kind === 'void') return { grass: 0, sand: 0, dirt: 0, cliff: 0 };
  if (kind === 'cliff') return { grass: 0, sand: 0, dirt: 0, cliff: 1 };
  if (kind === 'dirt' || kind === 'riverbed') return { grass: 0, sand: 0, dirt: 1, cliff: 0 };

  const sandWeight = smoothstep(beachBlend, 0.3, 0.55);
  return { grass: 1 - sandWeight, sand: sandWeight, dirt: 0, cliff: 0 };
}

/**
 * Cliff-edge darkening band along every cell on a raised tier whose 4-neighbor
 * is at a strictly lower tier. Grid-driven (Step 5+); the previous version
 * used hardcoded `HEIGHTMAP.CLIFF_X_MAX`/`Z_MAX` analytical bounds, which
 * would describe the original NW plateau forever even after player edits.
 *
 * Strength = 1 right next to the drop, fading to 0 within `CLIFF_EDGE_FADE_M`
 * inland. Computed in cell-space via the cell containing the texel and a
 * 4-neighbor lookup.
 */
const CLIFF_EDGE_FADE_M = 1.25;
function getCliffEdgeStrength(worldX: number, worldZ: number) {
  const grid = getTerrainGrid();
  const [cx, cz] = grid.worldToCell(worldX, worldZ);
  if (!grid.cellInBounds(cx, cz)) return 0;
  if (grid.getSurface(cx, cz) !== Surface.LAND) return 0;
  const t = grid.getTier(cx, cz);
  if (t === 0) return 0;

  // Distance to the nearest cell-edge of a 4-neighbor at strictly lower tier.
  // Computed in world coords: 0 right at the cell boundary, 1 m at the cell
  // center on the far side. We look only at the 4-neighbor directions that
  // step DOWN; others contribute infinity.
  const cellCx = grid.originX + (cx + 0.5) * grid.cellSize;
  const cellCz = grid.originZ + (cz + 0.5) * grid.cellSize;
  let bestDist = Infinity;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = cx + dx;
    const nz = cz + dz;
    if (!grid.cellInBounds(nx, nz)) continue;
    if (grid.getTier(nx, nz) >= t) continue;
    // Distance from (worldX, worldZ) to the shared cell edge in this direction.
    const edgeOffset = 0.5 * grid.cellSize;
    let dist: number;
    if (dx === 1) dist = (cellCx + edgeOffset) - worldX;
    else if (dx === -1) dist = worldX - (cellCx - edgeOffset);
    else if (dz === 1) dist = (cellCz + edgeOffset) - worldZ;
    else dist = worldZ - (cellCz - edgeOffset);
    if (dist < bestDist) bestDist = dist;
  }
  if (!Number.isFinite(bestDist)) return 0;
  return 1 - smoothstep(Math.max(0, bestDist), 0.15, CLIFF_EDGE_FADE_M);
}

/**
 * Wet/dirt strip along every LAND cell whose 4-neighbor is FRESHWATER. Grid-
 * driven so player-dug ponds get the same wet-sand band as the original river,
 * and player-filled river tiles stop receiving the band. Strength fades from
 * 1 at the bank to 0 within `RIVER_BANK_FADE_M`.
 */
const RIVER_BANK_FADE_M = 1.25;
function getRiverBankStrength(worldX: number, worldZ: number) {
  const grid = getTerrainGrid();
  const [cx, cz] = grid.worldToCell(worldX, worldZ);
  if (!grid.cellInBounds(cx, cz)) return 0;
  if (grid.getSurface(cx, cz) !== Surface.LAND) return 0;

  const cellCx = grid.originX + (cx + 0.5) * grid.cellSize;
  const cellCz = grid.originZ + (cz + 0.5) * grid.cellSize;
  let bestDist = Infinity;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = cx + dx;
    const nz = cz + dz;
    if (!grid.cellInBounds(nx, nz)) continue;
    if (grid.getSurface(nx, nz) !== Surface.FRESHWATER) continue;
    const edgeOffset = 0.5 * grid.cellSize;
    let dist: number;
    if (dx === 1) dist = (cellCx + edgeOffset) - worldX;
    else if (dx === -1) dist = worldX - (cellCx - edgeOffset);
    else if (dz === 1) dist = (cellCz + edgeOffset) - worldZ;
    else dist = worldZ - (cellCz - edgeOffset);
    if (dist < bestDist) bestDist = dist;
  }
  if (!Number.isFinite(bestDist)) return 0;
  return 1 - smoothstep(Math.max(0, bestDist), 0.05, RIVER_BANK_FADE_M);
}

function getIslandShoreStrength(shoreDistance: number, isInIsland: boolean) {
  if (!isInIsland) return 0;
  // Foam ribbon and wet-sand effects fade in as we approach the shore. Width tuned
  // so the band is visible without bleeding into deep inland zones.
  return 1 - smoothstep(shoreDistance, 0.2, 2.4);
}

function smoothstep(value: number, min: number, max: number) {
  if (value <= min) return 0;
  if (value >= max) return 1;

  const t = (value - min) / (max - min);
  return t * t * (3 - 2 * t);
}
