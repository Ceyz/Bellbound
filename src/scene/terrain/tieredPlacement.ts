import { Surface, type TerrainGrid } from './TerrainGrid';
import {
  forwardOf,
  newStructureId,
  rightOf,
  type BuiltStructure,
  type BuiltStructureSerialized,
  type Rotation,
} from './builtStructure';

/**
 * Staircase / incline placement validation.
 *
 * A tiered structure spans a 5×2 footprint:
 *   - cells [0..3] × [0..1] (slope, 8 cells) at LAND tier T (lower)
 *   - cells [4] × [0..1] (landing, 2 cells) at LAND tier T+1 (upper)
 *
 * The 4-cell slope is sized for a ~19° pente at the v1 1.4 m tier height
 * (atan(1.4/4) ≈ 19.3°). Both kinds share this footprint; they differ only
 * in their visual mesh (staircase = stepped silhouette, incline = sloped
 * wedge). The resolver treats them identically as a tier-T → tier-T+1
 * connector spanning the cliff edge between cells [3] and [4].
 *
 * `findTieredPlacement` sweeps the four cardinal rotations and picks the
 * first valid one. The validator enforces "origin = lower-tier corner" so
 * the sweep automatically rejects rotations that point from upper to lower;
 * the next rotation flips the direction. That gives the user a deterministic
 * placement regardless of where they click — the "uphill" direction is
 * inferred from the grid.
 */

export const TIERED_LENGTH = 5;
export const TIERED_WIDTH = 2;

export interface TieredPlacementCheck {
  errors: string[];
  /** +1 when `endCell.tier - originCell.tier === 1`. Set only on success. */
  tierDelta?: 1;
}

/**
 * Validate a 5×2 tiered structure anchored at `(originCx, originCz)` with
 * the given `rotation`. The same predicate covers staircase and incline;
 * pass `kind` only so the error messages name the right thing.
 *
 *   - every footprint cell in bounds, LAND, no overlap with other structures
 *   - cells [0..3] × [0..1] at LAND tier T (origin tier), the slope
 *   - cells [4] × [0..1] at LAND tier T+1, the landing
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
  const [rx, rz] = rightOf(rotation);

  // Origin must be LAND so the rest of the validation can read its tier.
  // Out-of-bounds origin would also break `getSurface`, so check bounds first.
  if (!grid.cellInBounds(originCx, originCz)) {
    return { errors: [`origin (${originCx}, ${originCz}) out of bounds`] };
  }
  if (grid.getSurface(originCx, originCz) !== Surface.LAND) {
    return { errors: [`${kind} origin cell is not LAND`] };
  }
  const originTier = grid.getTier(originCx, originCz);

  for (let i = 0; i < TIERED_LENGTH; i += 1) {
    for (let j = 0; j < TIERED_WIDTH; j += 1) {
      const cx = originCx + fx * i + rx * j;
      const cz = originCz + fz * i + rz * j;
      if (!grid.cellInBounds(cx, cz)) {
        return { errors: [`cell [${i},${j}] (${cx}, ${cz}) out of bounds`] };
      }
      if (grid.getSurface(cx, cz) !== Surface.LAND) {
        return { errors: [`${kind} cell [${i},${j}] is not LAND`] };
      }
      const expectedTier = i === TIERED_LENGTH - 1 ? originTier + 1 : originTier;
      const actualTier = grid.getTier(cx, cz);
      if (actualTier !== expectedTier) {
        // Catches: same-tier setup (slope expects T but landing finds T → no
        // cliff), inverted placement (origin = upper end → landing finds
        // T_origin - 1, fails), |delta|>1 (landing finds T_origin + 2, fails).
        return { errors: [
          `${kind} cell [${i},${j}] tier ${actualTier} != expected ${expectedTier} (slope=T${originTier}, landing=T${originTier + 1})`,
        ] };
      }
      for (const s of structures) {
        for (const [sx, sz] of s.occupiedCells) {
          if (sx === cx && sz === cz) {
            return { errors: [`cell (${cx}, ${cz}) overlaps existing structure id=${s.id}`] };
          }
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
          width: TIERED_WIDTH,
          style: 0,
        },
      };
    }
  }
  return null;
}
