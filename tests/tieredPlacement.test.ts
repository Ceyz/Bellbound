import { describe, expect, it } from 'vitest';
import {
  Surface,
  TerrainGrid,
  Tier,
} from '../src/scene/terrain/TerrainGrid';
import {
  TIERED_LENGTH,
  TIERED_WIDTH,
  canPlaceTiered,
  findTieredPlacement,
} from '../src/scene/terrain/tieredPlacement';
import {
  deriveStructureGeometry,
  forwardOf,
  rightOf,
  type BuiltStructure,
  type Rotation,
} from '../src/scene/terrain/builtStructure';

/**
 * Build a TerrainGrid containing a valid 5×2 tiered scenario anchored at
 * `(originCx, originCz)` for `rotation`. Slope cells [0..3] × [0..1] sit at
 * `slopeTier` (default T0); the landing cell [4] × [0..1] sits at
 * `landingTier` (default T1). Override either tier to set up failure cases.
 */
function buildTieredScenario(
  originCx: number,
  originCz: number,
  options: {
    rotation?: Rotation;
    slopeTier?: Tier;
    landingTier?: Tier;
    landingSurface?: Surface;
    originSurface?: Surface;
  } = {},
): TerrainGrid {
  const rotation = options.rotation ?? 0;
  const slopeTier = options.slopeTier ?? Tier.T0;
  const landingTier = options.landingTier ?? Tier.T1;
  const grid = new TerrainGrid();
  const [fx, fz] = forwardOf(rotation);
  const [rx, rz] = rightOf(rotation);
  for (let i = 0; i < TIERED_LENGTH; i += 1) {
    for (let j = 0; j < TIERED_WIDTH; j += 1) {
      const cx = originCx + fx * i + rx * j;
      const cz = originCz + fz * i + rz * j;
      const isLanding = i === TIERED_LENGTH - 1;
      const isOrigin = i === 0 && j === 0;
      const surface = isLanding && options.landingSurface !== undefined
        ? options.landingSurface
        : isOrigin && options.originSurface !== undefined
          ? options.originSurface
          : Surface.LAND;
      const tier = isLanding ? landingTier : slopeTier;
      grid.setRawByte(cx, cz, (surface << 6) | (tier << 4));
    }
  }
  return grid;
}

describe('tieredPlacement — canPlaceTiered happy paths', () => {
  it('accepts LAND T0 slope → LAND T1 landing along +X for staircase', () => {
    const grid = buildTieredScenario(10, 5);
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors).toEqual([]);
  });

  it('accepts LAND T0 slope → LAND T1 landing along +X for incline', () => {
    const grid = buildTieredScenario(10, 5);
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'incline').errors).toEqual([]);
  });

  it('reports tierDelta=1 on success', () => {
    const grid = buildTieredScenario(10, 5);
    const result = canPlaceTiered(grid, [], 10, 5, 0, 'staircase');
    expect(result.tierDelta).toBe(1);
  });
});

describe('tieredPlacement — canPlaceTiered rejections', () => {
  it('rejects when origin is the higher-tier end (inverted placement)', () => {
    // Build a 20×20 LAND grid: cells with cx<14 at T1, cx>=14 at T0. The cliff
    // sits between (13, *) and (14, *), running uphill toward -X. Placing from
    // origin (10, 5) with rotation 0 (forward = +X) puts the upper end (T1)
    // as the origin and slopes "into" the lower-tier territory: slope cells
    // expected T1, landing expected T2; landing (14, 5) is T0 → mismatch.
    const grid = new TerrainGrid();
    for (let cx = 0; cx < 20; cx += 1) {
      for (let cz = 0; cz < 20; cz += 1) {
        const tier = cx < 14 ? Tier.T1 : Tier.T0;
        grid.setRawByte(cx, cz, (Surface.LAND << 6) | (tier << 4));
      }
    }
    const result = canPlaceTiered(grid, [], 10, 5, 0, 'staircase');
    expect(result.errors[0]).toMatch(/tier 0 != expected 2/);
  });

  it('rejects when slope and landing are at the same tier (no cliff)', () => {
    // Set landing tier to T0 too — landing cell expected T1, actual T0.
    const grid = buildTieredScenario(10, 5, { landingTier: Tier.T0 });
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors[0])
      .toMatch(/tier 0 != expected 1/);
  });

  it('rejects when |delta| > 1', () => {
    const grid = buildTieredScenario(10, 5, { landingTier: Tier.T2 });
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors[0])
      .toMatch(/tier 2 != expected 1/);
  });

  it('rejects when origin is not LAND', () => {
    const grid = buildTieredScenario(10, 5, { originSurface: Surface.FRESHWATER });
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors[0])
      .toMatch(/origin cell is not LAND/);
  });

  it('rejects when the landing cell is not LAND', () => {
    const grid = buildTieredScenario(10, 5, { landingSurface: Surface.OCEAN });
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors[0])
      .toMatch(/cell \[4,0\] is not LAND/);
  });

  it('rejects when the footprint extends out of bounds', () => {
    // Set both lanes of the origin column as LAND so the bounds error fires
    // on the forward sweep rather than the per-cell surface check first.
    const grid = new TerrainGrid();
    grid.setRawByte(93, 5, (Surface.LAND << 6) | (Tier.T0 << 4));
    grid.setRawByte(93, 4, (Surface.LAND << 6) | (Tier.T0 << 4));
    // GRID_W=94 so cell (94, 5) at i=1, j=0 is out of bounds.
    expect(canPlaceTiered(grid, [], 93, 5, 0, 'staircase').errors[0])
      .toMatch(/out of bounds/);
  });

  it('rejects overlap with an existing structure', () => {
    const grid = buildTieredScenario(10, 5);
    // Bridge from (12, 5) along +Z covers (12, 5), (12, 6), (12, 7). The
    // staircase footprint includes (12, 5) as a slope cell — overlap.
    const existing: BuiltStructure = deriveStructureGeometry({
      id: 'existing',
      kind: 'bridge',
      originCell: [12, 5],
      rotation: 90,
      length: 3,
      width: 1,
      style: 0,
    });
    expect(canPlaceTiered(grid, [existing], 10, 5, 0, 'staircase').errors[0])
      .toMatch(/overlaps existing structure/);
  });
});

describe('tieredPlacement — findTieredPlacement', () => {
  it('picks the rotation pointing uphill (+X here)', () => {
    const grid = buildTieredScenario(10, 5);
    const placement = findTieredPlacement(grid, [], 10, 5, 'staircase');
    expect(placement).not.toBeNull();
    expect(placement!.rotation).toBe(0);
    expect(placement!.length).toBe(TIERED_LENGTH);
    expect(placement!.serialized.width).toBe(TIERED_WIDTH);
    expect(placement!.serialized.kind).toBe('staircase');
  });

  it('returns null when the cursor cell is the upper landing (no rotation works)', () => {
    // Origin (14, 5) is the landing of the constructed scenario. Sweeping
    // rotations from there: forward=+X exits the scenario; -X has slope cells
    // at (13..10, 5) which are T0 but originTier is T1 → tier mismatch.
    const grid = buildTieredScenario(10, 5);
    expect(findTieredPlacement(grid, [], 14, 5, 'staircase')).toBeNull();
  });

  it('picks rotation 90 when uphill is along +Z', () => {
    const grid = buildTieredScenario(5, 10, { rotation: 90 });
    const placement = findTieredPlacement(grid, [], 5, 10, 'incline');
    expect(placement).not.toBeNull();
    expect(placement!.rotation).toBe(90);
    expect(placement!.serialized.kind).toBe('incline');
  });

  it('returns null when no rotation has a valid 5×2 neighbour layout', () => {
    // Single isolated LAND-T0 cell with VOID neighbours: no rotation works.
    const grid = new TerrainGrid();
    grid.setRawByte(10, 10, (Surface.LAND << 6) | (Tier.T0 << 4));
    expect(findTieredPlacement(grid, [], 10, 10, 'staircase')).toBeNull();
  });
});
