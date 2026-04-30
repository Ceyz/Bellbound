import type * as THREE from 'three';
import { sampleIslandShape } from './islandShape';

/**
 * Greybox heightmap for A0.9 island relief. ACNH-inspired :
 *  - Flat sea level (y=0) over most of the island
 *  - One **cliff plateau** at +1 m in the northwest (worldX < -10, worldZ < -8)
 *  - One **S-shaped river** carving the middle of the island down to -0.5 m
 *  - One **wooden bridge** at world (0, 0.05, 5) spanning the river, walkable
 *
 * Greybox-only, sharp transitions (single-vertex step), no smooth blending. The
 * curvature shader stacks on top — `worldY_final = heightmap(x,z) + parabolic_warp`.
 *
 * `getIslandHeight` is for terrain mesh generation (does NOT account for the bridge —
 * the bridge is a separate mesh on top of the carved river bed).
 * `getPlayerStandingHeight` is for player physics (bridge overrides river).
 * `pushPlayerOutOfRiver` is the river collision: prevents traversal except via bridge.
 */

const CLIFF_TIER_HEIGHT = 1.0;
const RIVER_DEPTH = -0.5;
const RIVER_HALF_WIDTH = 1.8;
/**
 * Altitude drop on the outer beach. Combined with a concentrated transition (see
 * `computeBeachSlope` below) this creates a visible ACNH-style "step-down" from the
 * grass plateau to the sand: the drop happens in a ~1.1 m horizontal band rather
 * than spread across the 6 m beach transition zone.
 *
 * 18 cm drop produces a visible 16% slope across the transition band — clearly
 * readable at the cozy camera distance without going below the water plane (kept
 * at -0.20 m). The previous 30 cm drop required lowering the water plane to -0.35,
 * which made bridges and staircase structures look like they were floating because
 * of the resulting 40 cm gap to the water surface.
 */
const BEACH_DIP = 0.18;

// Cliff plateau bounds (north-west of the island). Outer bounds (X_MIN, Z_MIN) keep
// the rectangular cliff zone inside the SDF island silhouette so the plateau stops
// short of the corner where the SDF curves it back into ocean. Without these the
// plateau visually "breaks" at the NW corner because half its area is discarded.
const CLIFF_X_MIN = -27;
const CLIFF_X_MAX = -10;
const CLIFF_Z_MIN = -21;
const CLIFF_Z_MAX = -8;

// River S-shape extents — the river only carves within the inner grass area, leaving
// the beach perimeter intact so the island silhouette stays clean.
const RIVER_X_MIN = -28;
const RIVER_X_MAX = 28;
const RIVER_Z_MIN = -22;
const RIVER_Z_MAX = 22;

// Bridge spanning the river at the island's vertical centerline (X=0). The bridge's
// half-length (3 m) is wider than the river's half-width (1.8 m) so the deck overhangs
// both banks even where the river S-curve drifts slightly along the bridge's width.
const BRIDGE_X = 0;
const BRIDGE_HALF_WIDTH = 1.5;
const BRIDGE_HALF_LENGTH = 3.0;
const BRIDGE_SURFACE_Y = 0.05;
const BRIDGE_THICKNESS = 0.18;

// Staircase down from the cliff plateau to sea level. Anchored on the eastern edge of
// the cliff (X=-10) and extending into the sea-level zone. ACNH inclines are 2×4 tiles.
// The ramp's Y is linearly interpolated from CLIFF_TIER_HEIGHT at STAIRCASE_X_TOP
// down to 0 at STAIRCASE_X_BOTTOM, giving a smooth transition.
const STAIRCASE_X_TOP = -10;
const STAIRCASE_X_BOTTOM = -6;
const STAIRCASE_Z_CENTER = -14;
const STAIRCASE_HALF_WIDTH = 1;

/**
 * Returns the world Y altitude of the **terrain** at (worldX, worldZ).
 * NOTE: this does NOT account for the bridge — the bridge is a separate mesh layered
 * on top of the carved riverbed. Use `getPlayerStandingHeight` for player physics.
 */
export function getIslandHeight(worldX: number, worldZ: number): number {
  if (isInRiver(worldX, worldZ)) return RIVER_DEPTH;
  if (isOnCliff(worldX, worldZ)) return CLIFF_TIER_HEIGHT;
  return -BEACH_DIP * computeBeachSlope(worldX, worldZ);
}

/**
 * Returns 0 (no dip — flat grass plateau) deep inland and 1 (full BEACH_DIP) close
 * to the shore, with a CONCENTRATED smoothstep transition over the beachT range
 * [0.42, 0.60] — that maps to a ~1.1 m horizontal band where the visible step-down
 * from grass to sand happens. Outside this band the surface is flat (grass plateau
 * inland, deep sand near the shore). The previous linear `beachT` ramp spread the
 * 15 cm drop over the full 6 m beach transition for a 2.5 % slope that read as
 * essentially flat; this concentrated version produces a clearly visible 30 cm
 * pente over ~1.1 m for a 27 % slope.
 */
function computeBeachSlope(worldX: number, worldZ: number): number {
  const beachT = sampleIslandShape(worldX, worldZ).beachT;
  const t = Math.max(0, Math.min(1, (beachT - 0.42) / 0.18));
  return t * t * (3 - 2 * t);
}

/**
 * Where the player stands at (worldX, worldZ).
 * Priority: bridge > staircase ramp > cliff plateau > river / sea level.
 */
export function getPlayerStandingHeight(worldX: number, worldZ: number): number {
  if (isOnBridge(worldX, worldZ)) return BRIDGE_SURFACE_Y;
  if (isOnStaircase(worldX, worldZ)) {
    // Linear ramp from CLIFF_TIER_HEIGHT at the top (X=-10) down to 0 at the bottom (X=-6).
    const t = (worldX - STAIRCASE_X_TOP) / (STAIRCASE_X_BOTTOM - STAIRCASE_X_TOP);
    const clamped = Math.max(0, Math.min(1, t));
    return CLIFF_TIER_HEIGHT * (1 - clamped);
  }
  return getIslandHeight(worldX, worldZ);
}

/** True if (x, z) is on the staircase down from the cliff. */
export function isOnStaircase(worldX: number, worldZ: number): boolean {
  return (
    worldX >= STAIRCASE_X_TOP &&
    worldX <= STAIRCASE_X_BOTTOM &&
    Math.abs(worldZ - STAIRCASE_Z_CENTER) <= STAIRCASE_HALF_WIDTH
  );
}

/** True if (x, z) is on the bridge deck. */
export function isOnBridge(worldX: number, worldZ: number): boolean {
  return (
    Math.abs(worldX - BRIDGE_X) <= BRIDGE_HALF_WIDTH &&
    Math.abs(worldZ - BRIDGE.z) <= BRIDGE_HALF_LENGTH
  );
}

/**
 * River collision: if the player has stepped into the river without being on the bridge,
 * push him back to the closest bank with a small margin. Acts as a one-axis snap each
 * frame — fine for greybox, replace with a smoother resolver if it feels jittery later.
 */
export function pushPlayerOutOfRiver(position: THREE.Vector3) {
  if (isOnBridge(position.x, position.z)) return;
  if (!isInRiver(position.x, position.z)) return;
  const center = riverCenterZ(position.x);
  const direction = position.z >= center ? 1 : -1;
  position.z = center + direction * (RIVER_HALF_WIDTH + 0.1);
}

/** True if (worldX, worldZ) is inside the carved river band. */
export function isInRiver(worldX: number, worldZ: number): boolean {
  if (worldX < RIVER_X_MIN || worldX > RIVER_X_MAX) return false;
  if (worldZ < RIVER_Z_MIN || worldZ > RIVER_Z_MAX) return false;
  const riverbedZ = riverCenterZ(worldX);
  return Math.abs(worldZ - riverbedZ) < RIVER_HALF_WIDTH;
}

/** True if (worldX, worldZ) is on the elevated cliff plateau. */
export function isOnCliff(worldX: number, worldZ: number): boolean {
  return (
    worldX >= CLIFF_X_MIN
    && worldX < CLIFF_X_MAX
    && worldZ >= CLIFF_Z_MIN
    && worldZ < CLIFF_Z_MAX
  );
}

/**
 * Z coordinate of the river centerline at a given X. The river snakes across the
 * island in a gentle S-shape, parameterized by sin(x * frequency).
 */
export function riverCenterZ(worldX: number): number {
  return 5 + 6 * Math.sin(worldX * 0.08);
}

export const HEIGHTMAP = {
  CLIFF_TIER_HEIGHT,
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

export const BRIDGE = {
  x: BRIDGE_X,
  z: 5 + 6 * Math.sin(BRIDGE_X * 0.08), // = riverCenterZ(BRIDGE_X), inlined to allow `as const`
  halfWidth: BRIDGE_HALF_WIDTH,
  halfLength: BRIDGE_HALF_LENGTH,
  width: BRIDGE_HALF_WIDTH * 2,
  length: BRIDGE_HALF_LENGTH * 2,
  surfaceY: BRIDGE_SURFACE_Y,
  thickness: BRIDGE_THICKNESS,
} as const;

export const STAIRCASE = {
  xTop: STAIRCASE_X_TOP,
  xBottom: STAIRCASE_X_BOTTOM,
  zCenter: STAIRCASE_Z_CENTER,
  halfWidth: STAIRCASE_HALF_WIDTH,
  width: STAIRCASE_HALF_WIDTH * 2,
  length: STAIRCASE_X_BOTTOM - STAIRCASE_X_TOP,
} as const;
