import { Surface, type TerrainGrid } from './TerrainGrid';
import {
  forwardOf,
  newStructureId,
  type BuiltStructure,
  type BuiltStructureSerialized,
  type Rotation,
} from './builtStructure';

/**
 * Step 9.2 — bridge placement validation.
 *
 * A bridge spans `length` cells along the forward axis of its rotation:
 *   - The two endpoint cells (origin and origin + (length-1) * forward) must
 *     be LAND at the same tier.
 *   - The interior cells (between endpoints, exclusive) must be FRESHWATER at
 *     that same tier.
 *   - Every cell in the footprint must be in bounds and not overlap an
 *     existing structure's `occupiedCells`.
 *
 * The placement tool calls `findBridgePlacement(grid, structures, cx, cz)` to
 * auto-pick the first rotation in [0, 90, 180, 270] that produces a valid
 * placement — saves the user from rotating manually for the common case of
 * placing a perpendicular bridge across a river. Manual rotation can be added
 * later as a polish step (R key cycles the orientation).
 */

/**
 * v1 bridge length search range. The placement tool sweeps lengths from
 * `BRIDGE_MIN_LENGTH` (LAND-water-LAND) up to `BRIDGE_MAX_LENGTH` (LAND-water×6
 * -LAND, matching the kind constraint in builtStructure.ts) and picks the
 * shortest valid pair. The min is 3 because length=2 is "two adjacent LAND
 * cells with no water in between" — semantically a no-op for the resolver.
 */
export const BRIDGE_MIN_LENGTH = 3;
export const BRIDGE_MAX_LENGTH = 8;

/** Result of `canPlaceBridge`. `errors` empty iff placement is valid. */
export interface BridgePlacementCheck {
  errors: string[];
}

/**
 * Validate a bridge at `(originCx, originCz)` with the given rotation/length.
 * The grid and the existing structure list determine validity; nothing is
 * mutated. `errors[0]` is the first violated rule (validation short-circuits
 * so the caller can show one tooltip line at a time).
 */
export function canPlaceBridge(
  grid: TerrainGrid,
  structures: readonly BuiltStructure[],
  originCx: number,
  originCz: number,
  rotation: Rotation,
  length: number,
): BridgePlacementCheck {
  if (length < 2) return { errors: ['length < 2'] };

  const [fx, fz] = forwardOf(rotation);

  // Bounds check: every cell in [0, length-1] must be in-grid.
  for (let i = 0; i < length; i += 1) {
    const cx = originCx + fx * i;
    const cz = originCz + fz * i;
    if (!grid.cellInBounds(cx, cz)) {
      return { errors: [`cell ${i} (${cx}, ${cz}) out of bounds`] };
    }
  }

  // Both endpoints LAND.
  const startSurface = grid.getSurface(originCx, originCz);
  if (startSurface !== Surface.LAND) {
    return { errors: ['start cell is not LAND'] };
  }
  const endCx = originCx + fx * (length - 1);
  const endCz = originCz + fz * (length - 1);
  const endSurface = grid.getSurface(endCx, endCz);
  if (endSurface !== Surface.LAND) {
    return { errors: ['end cell is not LAND'] };
  }

  // Endpoints must share the same tier — bridges go between same-tier LAND.
  // Cross-tier connections live in staircase / incline (Step 9.4).
  const tier = grid.getTier(originCx, originCz);
  if (grid.getTier(endCx, endCz) !== tier) {
    return { errors: ['endpoints are not at the same tier'] };
  }

  // Interior cells (length=3 has 1 interior, length=2 has 0). Must be
  // FRESHWATER at the same tier so the deck spans water rather than land.
  for (let i = 1; i < length - 1; i += 1) {
    const cx = originCx + fx * i;
    const cz = originCz + fz * i;
    if (grid.getSurface(cx, cz) !== Surface.FRESHWATER) {
      return { errors: [`interior cell ${i} (${cx}, ${cz}) is not FRESHWATER`] };
    }
    if (grid.getTier(cx, cz) !== tier) {
      return { errors: [`interior cell ${i} tier mismatch`] };
    }
  }

  // Overlap with existing structures: any cell of the prospective footprint
  // that's in another structure's occupiedCells aborts the placement.
  for (let i = 0; i < length; i += 1) {
    const cx = originCx + fx * i;
    const cz = originCz + fz * i;
    for (const s of structures) {
      for (const [sx, sz] of s.occupiedCells) {
        if (sx === cx && sz === cz) {
          return { errors: [`cell (${cx}, ${cz}) overlaps existing structure id=${s.id}`] };
        }
      }
    }
  }

  return { errors: [] };
}

/** A valid bridge placement found by `findBridgePlacement`. */
export interface BridgePlacement {
  rotation: Rotation;
  length: number;
  serialized: BuiltStructureSerialized;
}

/**
 * Search every (rotation, length) pair within range and return the shortest
 * valid placement anchored at `(cx, cz)`. Returns `null` when no orientation
 * /length combo produces a valid bridge — the cursor is then drawn red.
 *
 * Rationale for "shortest valid": once a (rotation, length) is valid, longer
 * lengths in the same rotation may not be (the bridge would over-shoot into
 * water again or off-grid). Picking the shortest across all rotations gives
 * the user the most economical bridge for the cell they clicked, with a
 * stable tie-break on rotation order [0, 90, 180, 270] for symmetric layouts.
 *
 * The serialized structure carries a freshly-minted UUID so the caller can
 * pass it directly to `addBuiltStructure()`.
 */
export function findBridgePlacement(
  grid: TerrainGrid,
  structures: readonly BuiltStructure[],
  cx: number,
  cz: number,
  minLength: number = BRIDGE_MIN_LENGTH,
  maxLength: number = BRIDGE_MAX_LENGTH,
): BridgePlacement | null {
  const ROTATIONS: Rotation[] = [0, 90, 180, 270];
  let bestRotation: Rotation | null = null;
  let bestLength = Infinity;
  for (const rotation of ROTATIONS) {
    for (let length = minLength; length <= maxLength; length += 1) {
      if (canPlaceBridge(grid, structures, cx, cz, rotation, length).errors.length === 0) {
        if (length < bestLength) {
          bestRotation = rotation;
          bestLength = length;
        }
        break; // shorter > longer per rotation; no need to keep extending.
      }
    }
  }
  if (bestRotation === null) return null;
  return {
    rotation: bestRotation,
    length: bestLength,
    serialized: {
      id: newStructureId(),
      kind: 'bridge',
      originCell: [cx, cz],
      rotation: bestRotation,
      length: bestLength,
      width: 1,
      style: 0,
    },
  };
}
