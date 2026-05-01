import { describe, expect, it } from 'vitest';
import {
  Surface,
  TerrainGrid,
  Tier,
} from '../src/scene/terrain/TerrainGrid';
import {
  TIERED_LENGTH,
  canPlaceTiered,
  findTieredPlacement,
} from '../src/scene/terrain/tieredPlacement';
import {
  deriveStructureGeometry,
  type BuiltStructure,
} from '../src/scene/terrain/builtStructure';

function gridWith(setters: Array<{ cx: number; cz: number; surface: Surface; tier: Tier }>): TerrainGrid {
  const grid = new TerrainGrid();
  for (const { cx, cz, surface, tier } of setters) {
    grid.setRawByte(cx, cz, (surface << 6) | (tier << 4));
  }
  return grid;
}

const T0_T1_PLUS_X = [
  { cx: 10, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
  { cx: 11, cz: 5, surface: Surface.LAND, tier: Tier.T1 },
];

describe('tieredPlacement — canPlaceTiered happy paths', () => {
  it('accepts LAND T0 → LAND T1 along +X for staircase', () => {
    const grid = gridWith(T0_T1_PLUS_X);
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors).toEqual([]);
  });

  it('accepts LAND T0 → LAND T1 along +X for incline', () => {
    const grid = gridWith(T0_T1_PLUS_X);
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'incline').errors).toEqual([]);
  });

  it('reports tierDelta=1 on success', () => {
    const grid = gridWith(T0_T1_PLUS_X);
    const result = canPlaceTiered(grid, [], 10, 5, 0, 'staircase');
    expect(result.tierDelta).toBe(1);
  });
});

describe('tieredPlacement — canPlaceTiered rejections', () => {
  it('rejects when origin is the higher-tier end (delta=-1)', () => {
    const grid = gridWith(T0_T1_PLUS_X);
    // Origin (11, 5) is T1, forward +X would point off the constructed cells.
    // Use the reverse: anchor at the higher-tier cell, look back at the lower.
    // Forward = -X (rotation 180), so end = (10, 5) at T0. Origin tier - end tier = 1, not -1.
    const result = canPlaceTiered(grid, [], 11, 5, 180, 'staircase');
    expect(result.errors[0]).toMatch(/origin tier \+ 1 == end tier/);
  });

  it('rejects when delta is 0 (same tier)', () => {
    const grid = gridWith([
      { cx: 10, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 11, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
    ]);
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors[0]).toMatch(/origin tier \+ 1 == end tier/);
  });

  it('rejects when |delta| > 1', () => {
    const grid = gridWith([
      { cx: 10, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 11, cz: 5, surface: Surface.LAND, tier: Tier.T2 },
    ]);
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors[0]).toMatch(/origin tier \+ 1 == end tier/);
  });

  it('rejects when start is not LAND', () => {
    const grid = gridWith([
      { cx: 10, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 11, cz: 5, surface: Surface.LAND, tier: Tier.T1 },
    ]);
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors[0]).toMatch(/start cell is not LAND/);
  });

  it('rejects when end is not LAND', () => {
    const grid = gridWith([
      { cx: 10, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 11, cz: 5, surface: Surface.OCEAN, tier: Tier.T0 },
    ]);
    expect(canPlaceTiered(grid, [], 10, 5, 0, 'staircase').errors[0]).toMatch(/end cell is not LAND/);
  });

  it('rejects out of bounds end', () => {
    const grid = new TerrainGrid();
    expect(canPlaceTiered(grid, [], 93, 5, 0, 'staircase').errors[0]).toMatch(/out of bounds/);
  });

  it('rejects overlap with an existing structure', () => {
    const grid = gridWith(T0_T1_PLUS_X);
    const existing: BuiltStructure = deriveStructureGeometry({
      id: 'existing',
      kind: 'bridge',
      originCell: [11, 5],
      rotation: 90,
      length: 3,
      width: 1,
      style: 0,
    });
    // Bridge from (11,5) along +Z covers (11,5), (11,6), (11,7). The staircase
    // would overlap (11, 5).
    expect(canPlaceTiered(grid, [existing], 10, 5, 0, 'staircase').errors[0])
      .toMatch(/overlaps existing structure/);
  });
});

describe('tieredPlacement — findTieredPlacement', () => {
  it('picks the rotation pointing uphill (+X here)', () => {
    const grid = gridWith(T0_T1_PLUS_X);
    const placement = findTieredPlacement(grid, [], 10, 5, 'staircase');
    expect(placement).not.toBeNull();
    expect(placement!.rotation).toBe(0);
    expect(placement!.length).toBe(TIERED_LENGTH);
    expect(placement!.serialized.kind).toBe('staircase');
  });

  it('returns null when the cursor cell is the higher-tier end (no valid rotation)', () => {
    // From (11, 5) at T1, no neighbour is at T2.
    const grid = gridWith(T0_T1_PLUS_X);
    expect(findTieredPlacement(grid, [], 11, 5, 'staircase')).toBeNull();
  });

  it('picks rotation 90 when uphill is along +Z', () => {
    const grid = gridWith([
      { cx: 5, cz: 10, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 5, cz: 11, surface: Surface.LAND, tier: Tier.T1 },
    ]);
    const placement = findTieredPlacement(grid, [], 5, 10, 'incline');
    expect(placement).not.toBeNull();
    expect(placement!.rotation).toBe(90);
    expect(placement!.serialized.kind).toBe('incline');
  });

  it('returns null when no neighbour is one tier higher', () => {
    const grid = gridWith([
      { cx: 10, cz: 10, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 11, cz: 10, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 9, cz: 10, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 10, cz: 11, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 10, cz: 9, surface: Surface.LAND, tier: Tier.T0 },
    ]);
    expect(findTieredPlacement(grid, [], 10, 10, 'staircase')).toBeNull();
  });
});
