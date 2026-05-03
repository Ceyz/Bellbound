import { ISLAND_TERRAIN_DEPTH, ISLAND_TERRAIN_WIDTH } from '../player/movement';
import { getIslandHeight, isInRiver, isOnCliff } from './heightmap';
import { sampleIslandShape } from './islandShape';
import { Surface, Tier, getTerrainGrid } from './terrain/TerrainGrid';
import { isSmoothBeachSand } from './terrain/beachGeometry';

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
 *
 * Analytical-vs-grid status of each input (carried-over debt, Step 10 polish):
 *  - `cliffEdge`, `riverBank`  → grid-driven (4-neighbor lookups). ✓
 *  - `inRiver`, `onCliff`      → grid-driven via `heightmap.ts` façade. ✓
 *  - `isPath`                  → grid-driven via the path mask. ✓
 *  - `isInIsland`, `shoreDistance`, `beachBlend` → still **analytical**
 *    (`sampleIslandShape`). Acceptable for V1 because:
 *      a) ocean editing is forbidden (D14), so the ocean shore never moves.
 *      b) the coastal sand band is now protected from terraforming, so the
 *         beach silhouette can't drift relative to the visible mesh.
 *    Migrating to a fully grid-derived `shoreDistanceMap` is a Step 10 polish
 *    item; until then, inland ponds intentionally don't get an ocean-style
 *    foam/sand ring (they have their own `riverBank` band).
 */
export function classifySurfaceAt(worldX: number, worldZ: number): SurfaceClassification {
  const shape = sampleIslandShape(worldX, worldZ);
  const shoreDistance = shape.shoreDistance;

  // beachBlend kept as a continuous SDF-driven signal for wet-sand effects.
  // The grass↔sand boundary itself is grid-driven so it cannot drift across
  // OCEAN cells and reveal blue holes under a visual-only overlay.
  const beachBlend = shape.beachT;

  const grid = getTerrainGrid();
  const [cx, cz] = grid.worldToCell(worldX, worldZ);
  const gridSurface = grid.cellInBounds(cx, cz) ? grid.getSurface(cx, cz) : Surface.VOID;

  // `isInIsland` now reads from the GRID, not the analytical SDF. With the
  // earlier SDF-based check, texels inside a grid LAND cell that fell outside
  // the perturbed-ellipse silhouette were classified as `void` and rendered
  // as splat=0 → discarded by the shader. The sand cells at the eastern
  // coast (LAND cells whose centers are inside the SDF but whose offshore
  // half is outside) lost most of their sand area to that discard. Reading
  // from the grid keeps the per-texel classification consistent with what
  // the ground mesh actually renders.
  const isInIsland = gridSurface === Surface.LAND || gridSurface === Surface.FRESHWATER;

  const inRiver = isInIsland && isInRiver(worldX, worldZ);
  const onCliff = isInIsland && !inRiver && isOnCliff(worldX, worldZ);
  // Hardcoded paths to the (now-removed) house and shop were dropped during the
  // terraforming refactor scene cleanup; players will paint paths via the path
  // tool once Step 7 ships.
  const isPath = false;
  const isBeach =
    gridSurface === Surface.LAND
    && grid.getTier(cx, cz) === Tier.T0
    && isSmoothBeachSand(worldX, worldZ);
  const isFullySand = isBeach;

  const kind: SurfaceKind = !isInIsland
    ? 'void'
    : getSurfaceKind({ isBeachCell: isBeach, inRiver, isPath, onCliff });
  const splat = getSplatWeights(kind);

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
  isBeachCell: boolean;
  inRiver: boolean;
  isPath: boolean;
  onCliff: boolean;
}): Exclude<SurfaceKind, 'void'> {
  if (surface.inRiver) return 'riverbed';
  if (surface.isBeachCell) return 'sand';
  if (surface.isPath) return 'dirt';
  // Raised tier TOPs are grass (same texture as low ground), not the rocky
  // `cliffTop` texture. The cliff FACE is owned by the cliff-side mesh; the
  // ground mesh's top of a raised cell is still grass. The `cliffEdge` tint
  // (separate map) still darkens the immediate edge as a soft earth ring.
  // `surface.onCliff` is preserved on the classification result for physics
  // consumers; only the visual `kind` is normalized to 'grass'.
  return 'grass';
}

/**
 * Splat weights are now binary per cell (no smoothstep). The grass↔sand
 * boundary is the cell edge between a regular LAND-T0 and a beach LAND-T0
 * (the latter detected by `grid.isBeachCell`); the visible slope between them
 * is geometry, not a splat gradient — see `cliffSideMeshBuilder` beach walls.
 */
function getSplatWeights(kind: SurfaceKind): SurfaceSplatWeights {
  if (kind === 'void') return { grass: 0, sand: 0, dirt: 0, cliff: 0 };
  if (kind === 'cliff') return { grass: 0, sand: 0, dirt: 0, cliff: 1 };
  if (kind === 'dirt' || kind === 'riverbed') return { grass: 0, sand: 0, dirt: 1, cliff: 0 };
  if (kind === 'sand') return { grass: 0, sand: 1, dirt: 0, cliff: 0 };
  return { grass: 1, sand: 0, dirt: 0, cliff: 0 };
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
const CLIFF_EDGE_FADE_M = 0.30;
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
