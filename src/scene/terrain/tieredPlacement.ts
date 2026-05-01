import { Surface, type TerrainGrid } from './TerrainGrid';
import {
  forwardOf,
  newStructureId,
  type BuiltStructure,
  type BuiltStructureSerialized,
  type Rotation,
} from './builtStructure';

/**
 * Step 9.4 — staircase / incline placement validation.
 *
 * A tiered structure spans exactly 2 cells along the forward axis, connecting
 * a LAND cell at tier T (the origin, *lower* end) to a LAND cell at tier T+1
 * (the upper end). Both kinds share this footprint and constraint set; they
 * differ only in their visual mesh (staircase = stepped silhouette, incline
 * = sloped ramp). Mechanically the resolver treats them identically as a
 * tier-T to tier-T+1 connector.
 *
 * `findTieredPlacement` sweeps the four cardinal rotations and picks the
 * first valid one. The validator enforces "origin = lower-tier" so the
 * sweep automatically rejects rotations that would point from upper to
 * lower; the next rotation flips the direction. That gives the user a
 * deterministic placement regardless of where they click — the "uphill"
 * direction is inferred from the grid.
 */

export const TIERED_LENGTH = 2;

export interface TieredPlacementCheck {
  errors: string[];
  /** +1 when `endCell.tier - originCell.tier === 1`. Set only on success. */
  tierDelta?: 1;
}

/**
 * Validate a length-2 tiered structure anchored at `(originCx, originCz)`
 * with the given `rotation`. The same predicate covers staircase and
 * incline; pass `kind` only so the error messages name the right thing.
 *
 *   - origin and origin+forward both LAND, both in bounds
 *   - origin tier + 1 = forward tier (origin must be the lower end)
 *   - no overlap with existing structures
 */
export function canPlaceTiered(
  grid: TerrainGrid,
  structures: readonly BuiltStructure[],
  originCx: number,
  originCz: number,
  rotation: Rotation,
  kind: 'staircase' | 'incline',
): TieredPlacementCheck {
  const [fx, fz] = forwardOf(rotation);

  for (let i = 0; i < TIERED_LENGTH; i += 1) {
    const cx = originCx + fx * i;
    const cz = originCz + fz * i;
    if (!grid.cellInBounds(cx, cz)) {
      return { errors: [`cell ${i} (${cx}, ${cz}) out of bounds`] };
    }
  }

  if (grid.getSurface(originCx, originCz) !== Surface.LAND) {
    return { errors: [`${kind} start cell is not LAND`] };
  }
  const endCx = originCx + fx;
  const endCz = originCz + fz;
  if (grid.getSurface(endCx, endCz) !== Surface.LAND) {
    return { errors: [`${kind} end cell is not LAND`] };
  }

  const originTier = grid.getTier(originCx, originCz);
  const endTier = grid.getTier(endCx, endCz);
  const delta = endTier - originTier;
  if (delta !== 1) {
    // Reject delta=0 (same tier — staircase/incline pointless), delta=-1 (origin
    // must be lower; the rotation sweep flips this), and |delta|>1 (the v1
    // structure spans only one tier transition).
    return { errors: [`${kind} requires origin tier + 1 == end tier (got delta ${delta})`] };
  }

  for (let i = 0; i < TIERED_LENGTH; i += 1) {
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

  return { errors: [], tierDelta: 1 };
}

export interface TieredPlacement {
  rotation: Rotation;
  length: number;
  serialized: BuiltStructureSerialized;
}

/**
 * Sweep the four cardinal rotations for a valid tiered placement anchored at
 * `(cx, cz)`. Returns the first valid one (rotation order [0, 90, 180, 270])
 * or `null` when no orientation works — the cursor is then drawn red.
 */
export function findTieredPlacement(
  grid: TerrainGrid,
  structures: readonly BuiltStructure[],
  cx: number,
  cz: number,
  kind: 'staircase' | 'incline',
): TieredPlacement | null {
  const ROTATIONS: Rotation[] = [0, 90, 180, 270];
  for (const rotation of ROTATIONS) {
    if (canPlaceTiered(grid, structures, cx, cz, rotation, kind).errors.length === 0) {
      return {
        rotation,
        length: TIERED_LENGTH,
        serialized: {
          id: newStructureId(),
          kind,
          originCell: [cx, cz],
          rotation,
          length: TIERED_LENGTH,
          width: 1,
          style: 0,
        },
      };
    }
  }
  return null;
}
