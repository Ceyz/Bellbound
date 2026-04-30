import type * as THREE from 'three';
import { sampleIslandShape } from './islandShape';
import {
  FRESHWATER_BED_OFFSET_METERS,
  Surface,
  Tier,
  getTerrainGrid,
  tierHeight,
} from './terrain/TerrainGrid';

/**
 * Façade over the editable `TerrainGrid` (Step 2 of the terraforming refactor,
 * generalized in Step 3 round 2 fix to support any tier in [T0..T3]).
 *
 *  - `getIslandHeight` reads the cell at (worldX, worldZ) from the grid:
 *      • LAND tier T → `tierHeight(T)`. T0 LAND additionally gets the analytical
 *        beach slope so the visible 18 cm dip near the analytical shoreline
 *        survives until the per-cell shore lip mesh ships in Step 3 round 3.
 *      • FRESHWATER tier T → `tierHeight(T) - FRESHWATER_BED_OFFSET_METERS`.
 *        Player physics standing in water sits at the bed.
 *      • OCEAN / VOID → analytical beach slope (the offshore "shelf" altitude).
 *  - `isOnCliff` is true for any LAND cell at tier > T0, not just the original
 *    hardcoded NW T1 plateau. T2/T3 added by player edits will report correctly.
 *  - `isInRiver` is FRESHWATER cell lookup.
 *  - `pushPlayerOutOfRiver` keeps the analytical riverCenterZ as a Step-2 stop-
 *    gap; the proper grid-aware movement resolver lands in Step 4 of the plan.
 */

const RIVER_HALF_WIDTH = 1.8;
const BEACH_DIP = 0.18;

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

  if (!grid.cellInBounds(cx, cz)) {
    return -BEACH_DIP * computeBeachSlope(worldX, worldZ);
  }

  const cell = grid.getCell(cx, cz);

  if (cell.surface === Surface.OCEAN || cell.surface === Surface.VOID) {
    return -BEACH_DIP * computeBeachSlope(worldX, worldZ);
  }

  if (cell.surface === Surface.FRESHWATER) {
    return tierHeight(cell.tier) - FRESHWATER_BED_OFFSET_METERS;
  }

  // LAND. Beach dip applies on T0 only; raised tiers (T1+) read as flat plateaus.
  if (cell.tier === Tier.T0) {
    return tierHeight(Tier.T0) - BEACH_DIP * computeBeachSlope(worldX, worldZ);
  }
  return tierHeight(cell.tier);
}

function computeBeachSlope(worldX: number, worldZ: number): number {
  const beachT = sampleIslandShape(worldX, worldZ).beachT;
  const t = Math.max(0, Math.min(1, (beachT - 0.42) / 0.18));
  return t * t * (3 - 2 * t);
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
 * Z coordinate of the river centerline at a given X. Kept analytical because
 * the river-bank lip mesh and `pushPlayerOutOfRiver` still derive geometry
 * along this curve. Step 4 (grid-aware movement) replaces both consumers and
 * this helper goes away.
 */
export function riverCenterZ(worldX: number): number {
  return 5 + 6 * Math.sin(worldX * 0.08);
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
