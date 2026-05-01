import { describe, expect, it } from 'vitest';
import {
  Surface,
  TerrainGrid,
  Tier,
} from '../src/scene/terrain/TerrainGrid';
import {
  BRIDGE_MAX_LENGTH,
  BRIDGE_MIN_LENGTH,
  canPlaceBridge,
  findBridgePlacement,
} from '../src/scene/terrain/bridgePlacement';
import {
  deriveStructureGeometry,
  type BuiltStructure,
} from '../src/scene/terrain/builtStructure';

/**
 * Helper: build an empty grid then set specific cells along a row to a
 * specific (surface, tier) so we can construct LAND-FRESHWATER-LAND patterns
 * without depending on the analytical bake.
 */
function gridWith(setters: Array<{ cx: number; cz: number; surface: Surface; tier: Tier }>): TerrainGrid {
  const grid = new TerrainGrid();
  for (const { cx, cz, surface, tier } of setters) {
    grid.setRawByte(cx, cz, (surface << 6) | (tier << 4));
  }
  return grid;
}

const FORWARD_X_LAND_WATER_LAND = [
  { cx: 10, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
  { cx: 11, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
  { cx: 12, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
];

describe('bridgePlacement — canPlaceBridge happy path', () => {
  it('LAND - FRESHWATER - LAND in a row at the same tier validates', () => {
    const grid = gridWith(FORWARD_X_LAND_WATER_LAND);
    expect(canPlaceBridge(grid, [], 10, 5, 0, BRIDGE_MIN_LENGTH).errors).toEqual([]);
  });
});

describe('bridgePlacement — canPlaceBridge rejection cases', () => {
  it('rejects when the end cell is out of bounds', () => {
    const grid = new TerrainGrid();
    // Anchor near the +X edge so origin + 2*forward escapes the grid.
    const result = canPlaceBridge(grid, [], 92, 5, 0, BRIDGE_MIN_LENGTH);
    expect(result.errors[0]).toMatch(/out of bounds/);
  });

  it('rejects when the start cell is not LAND', () => {
    // start = FRESHWATER, rest LAND-LAND-FRESHWATER (not that we get past start)
    const grid = gridWith([
      { cx: 10, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 11, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 12, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
    ]);
    expect(canPlaceBridge(grid, [], 10, 5, 0, BRIDGE_MIN_LENGTH).errors[0]).toMatch(/start cell is not LAND/);
  });

  it('rejects when the end cell is not LAND', () => {
    const grid = gridWith([
      { cx: 10, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 11, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 12, cz: 5, surface: Surface.OCEAN, tier: Tier.T0 },
    ]);
    expect(canPlaceBridge(grid, [], 10, 5, 0, BRIDGE_MIN_LENGTH).errors[0]).toMatch(/end cell is not LAND/);
  });

  it('rejects when endpoints are at different tiers', () => {
    const grid = gridWith([
      { cx: 10, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 11, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 12, cz: 5, surface: Surface.LAND, tier: Tier.T1 },
    ]);
    expect(canPlaceBridge(grid, [], 10, 5, 0, BRIDGE_MIN_LENGTH).errors[0]).toMatch(/same tier/);
  });

  it('rejects when interior cell is LAND (no water to span)', () => {
    const grid = gridWith([
      { cx: 10, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 11, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 12, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
    ]);
    expect(canPlaceBridge(grid, [], 10, 5, 0, BRIDGE_MIN_LENGTH).errors[0]).toMatch(/not FRESHWATER/);
  });

  it('rejects when an existing structure already occupies a target cell', () => {
    const grid = gridWith(FORWARD_X_LAND_WATER_LAND);
    const existing: BuiltStructure = deriveStructureGeometry({
      id: 'existing',
      kind: 'staircase',
      originCell: [11, 5],
      rotation: 0,
      length: 2,
      width: 1,
      style: 0,
    });
    const result = canPlaceBridge(grid, [existing], 10, 5, 0, BRIDGE_MIN_LENGTH);
    expect(result.errors[0]).toMatch(/overlaps existing structure/);
  });
});

describe('bridgePlacement — findBridgePlacement', () => {
  it('picks rotation 0 when the bridge runs along +X', () => {
    const grid = gridWith(FORWARD_X_LAND_WATER_LAND);
    const placement = findBridgePlacement(grid, [], 10, 5);
    expect(placement).not.toBeNull();
    expect(placement!.rotation).toBe(0);
    expect(placement!.length).toBe(BRIDGE_MIN_LENGTH);
    expect(placement!.serialized.kind).toBe('bridge');
    expect(placement!.serialized.originCell).toEqual([10, 5]);
  });

  it('picks rotation 90 when the bridge runs along +Z', () => {
    const grid = gridWith([
      { cx: 5, cz: 10, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 5, cz: 11, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 5, cz: 12, surface: Surface.LAND, tier: Tier.T0 },
    ]);
    const placement = findBridgePlacement(grid, [], 5, 10);
    expect(placement).not.toBeNull();
    expect(placement!.rotation).toBe(90);
  });

  it('returns null when no rotation produces a valid placement', () => {
    // Anchor cell is LAND but every neighbour is also LAND — no water span.
    const grid = gridWith([
      { cx: 10, cz: 10, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 11, cz: 10, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 9, cz: 10, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 10, cz: 11, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 10, cz: 9, surface: Surface.LAND, tier: Tier.T0 },
    ]);
    expect(findBridgePlacement(grid, [], 10, 10)).toBeNull();
  });

  it('produces a serialized payload with a fresh UUID per call', () => {
    const grid = gridWith(FORWARD_X_LAND_WATER_LAND);
    const a = findBridgePlacement(grid, [], 10, 5);
    const b = findBridgePlacement(grid, [], 10, 5);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.serialized.id).not.toBe(b!.serialized.id);
    expect(a!.serialized.id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('picks the shortest valid length when the river is wider than the minimum', () => {
    // 4-cell-wide river: LAND + 4 FRESHWATER + LAND. Length=3..5 fail because
    // the end cell lands inside the water; length=6 is the first valid span.
    const cells: Array<{ cx: number; cz: number; surface: Surface; tier: Tier }> = [
      { cx: 0, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
      { cx: 1, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 2, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 3, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 4, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 },
      { cx: 5, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
    ];
    const grid = gridWith(cells);
    const placement = findBridgePlacement(grid, [], 0, 5);
    expect(placement).not.toBeNull();
    expect(placement!.length).toBe(6);
    expect(placement!.rotation).toBe(0);
  });

  it('returns null when the only valid bridge would exceed BRIDGE_MAX_LENGTH', () => {
    // 8-cell river → would need length=10 to span. Beyond the cap → null.
    const cells: Array<{ cx: number; cz: number; surface: Surface; tier: Tier }> = [
      { cx: 0, cz: 5, surface: Surface.LAND, tier: Tier.T0 },
    ];
    for (let i = 1; i <= 8; i += 1) {
      cells.push({ cx: i, cz: 5, surface: Surface.FRESHWATER, tier: Tier.T0 });
    }
    cells.push({ cx: 9, cz: 5, surface: Surface.LAND, tier: Tier.T0 });
    const grid = gridWith(cells);
    expect(BRIDGE_MAX_LENGTH).toBeLessThan(10);
    expect(findBridgePlacement(grid, [], 0, 5)).toBeNull();
  });
});
