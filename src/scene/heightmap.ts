import type * as THREE from 'three';
import {
  FRESHWATER_BED_OFFSET_METERS,
  Surface,
  Tier,
  getTerrainGrid,
  tierHeight,
} from './terrain/TerrainGrid';

/**
 * Façade over the editable `TerrainGrid` (Step 2 of the terraforming refactor,
 * generalized in Step 3 round 2 to support any tier in [T0..T3], with the
 * analytical beach dip removed in Step 4 to keep player physics aligned with
 * the new flat-tier ground mesh).
 *
 *  - `getIslandHeight` reads the cell at (worldX, worldZ) from the grid:
 *      • LAND tier T → `tierHeight(T)` (flat per cell, matches ground mesh).
 *      • FRESHWATER tier T → `tierHeight(T) - FRESHWATER_BED_OFFSET_METERS`.
 *        Player physics standing in water sits at the bed.
 *      • OCEAN / VOID → 0 (sea level — there's no terrain mesh here).
 *  - `isOnCliff` is true for any LAND cell at tier > T0, not just the original
 *    hardcoded NW T1 plateau. T2/T3 added by player edits will report correctly.
 *  - `isInRiver` is FRESHWATER cell lookup.
 *  - `pushPlayerOutOfRiver` keeps the analytical riverCenterZ as a Step-2 stop-
 *    gap; superseded by the Step 4 movement resolver which now blocks river
 *    entry at the cell boundary directly.
 */

const RIVER_HALF_WIDTH = 1.8;

// Legacy constants kept for compatibility with consumers that still reference
// the analytical bounds (cliff + river bake helpers). These are NOT used for
// runtime classification — the grid is the source of truth — and will be
// removed once `surfaceClassification.ts` is rebaked from the grid.
const CLIFF_X_MIN = -27;
const CLIFF_X_MAX = -10;
const CLIFF_Z_MIN = -21;
const CLIFF_Z_MAX = -8;
const RIVER_X_MIN = -28;
const RIVER_X_MAX = 28;
const RIVER_Z_MIN = -22;
const RIVER_Z_MAX = 22;
const RIVER_DEPTH = -FRESHWATER_BED_OFFSET_METERS;

export function getIslandHeight(worldX: number, worldZ: number): number {
  const grid = getTerrainGrid();
  const [cx, cz] = grid.worldToCell(worldX, worldZ);

  if (!grid.cellInBounds(cx, cz)) return 0;

  const cell = grid.getCell(cx, cz);

  if (cell.surface === Surface.OCEAN || cell.surface === Surface.VOID) return 0;

  if (cell.surface === Surface.FRESHWATER) {
    return tierHeight(cell.tier) - FRESHWATER_BED_OFFSET_METERS;
  }

  // LAND — flat at the cell's tier. The visible grass↔sand step (D16 shore
  // lip) lands as a separate mini cliff-side mesh in Step 3 round 3; the
  // analytical 18 cm beach dip that previously lived here was removed in
  // Step 4 because it caused the player's feet to sink below the (flat) ground
  // mesh by exactly that amount.
  return tierHeight(cell.tier);
}

export function getPlayerStandingHeight(worldX: number, worldZ: number): number {
  return getIslandHeight(worldX, worldZ);
}

export function pushPlayerOutOfRiver(position: THREE.Vector3) {
  if (!isInRiver(position.x, position.z)) return;
  const center = riverCenterZ(position.x);
  const direction = position.z >= center ? 1 : -1;
  position.z = center + direction * (RIVER_HALF_WIDTH + 0.1);
}

export function isInRiver(worldX: number, worldZ: number): boolean {
  const grid = getTerrainGrid();
  const [cx, cz] = grid.worldToCell(worldX, worldZ);
  return grid.getSurface(cx, cz) === Surface.FRESHWATER;
}

/**
 * True for any LAND cell at tier > T0. Generalized from the original "NW T1
 * plateau" check so future T2 / T3 edits report correctly. Fragmenters and
 * physics consumers use this to detect "player is up on a raised plateau".
 */
export function isOnCliff(worldX: number, worldZ: number): boolean {
  const grid = getTerrainGrid();
  const [cx, cz] = grid.worldToCell(worldX, worldZ);
  return grid.getSurface(cx, cz) === Surface.LAND && grid.getTier(cx, cz) > Tier.T0;
}

/**
 * Z coordinate of the river centerline at a given X. Straight (z=5) since v1
 * cleanup — see `seedRiverCenterZ` in TerrainGrid.ts for the rationale (the
 * previous sin meander rasterised to chaotic 1m zigzag at every inflection
 * point). This helper still exists for the legacy `isInRiver` predicate
 * consumers (`trackRiverContact` for the bank ripple decal); replace with a
 * grid lookup when those go away.
 */
export function riverCenterZ(_worldX: number): number {
  return 5;
}

export const HEIGHTMAP = {
  CLIFF_TIER_HEIGHT: tierHeight(Tier.T1),
  RIVER_DEPTH,
  RIVER_HALF_WIDTH,
  CLIFF_X_MIN,
  CLIFF_X_MAX,
  CLIFF_Z_MIN,
  CLIFF_Z_MAX,
  RIVER_X_MIN,
  RIVER_X_MAX,
  RIVER_Z_MIN,
  RIVER_Z_MAX,
};

// Re-export `Tier` so consumers that imported `Tier` indirectly through
// heightmap can continue to do so after the cleanup.
export { Tier };
