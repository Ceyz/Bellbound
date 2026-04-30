import { describe, expect, it } from 'vitest';
import {
  CELL,
  FRESHWATER_BED_OFFSET_METERS,
  GRID_D,
  GRID_W,
  Surface,
  TERRAIN_ORIGIN,
  TIER_HEIGHT_METERS,
  TerrainGrid,
  Tier,
  tierHeight,
} from '../src/scene/terrain/TerrainGrid';

describe('TerrainGrid — geometry constants', () => {
  it('exposes the spec-locked grid dimensions', () => {
    expect(GRID_W).toBe(94);
    expect(GRID_D).toBe(78);
    expect(CELL).toBe(1.0);
    expect(TIER_HEIGHT_METERS).toBe(1.0);
    expect(FRESHWATER_BED_OFFSET_METERS).toBe(0.5);
    expect(TERRAIN_ORIGIN).toEqual({ x: -47, z: -39 });
  });

  it('places cell centers on half-integer world coords', () => {
    const grid = new TerrainGrid();
    expect(grid.cellCenterWorld(0, 0)).toEqual([-46.5, -38.5]);
    expect(grid.cellCenterWorld(47, 39)).toEqual([0.5, 0.5]);
    expect(grid.cellCenterWorld(93, 77)).toEqual([46.5, 38.5]);
  });

  it('round-trips world ↔ cell at half-integer centers', () => {
    const grid = new TerrainGrid();
    for (const cx of [0, 1, 47, 93]) {
      for (const cz of [0, 1, 39, 77]) {
        const [wx, wz] = grid.cellCenterWorld(cx, cz);
        expect(grid.worldToCell(wx, wz)).toEqual([cx, cz]);
      }
    }
  });

  it('classifies bounds correctly', () => {
    const grid = new TerrainGrid();
    expect(grid.cellInBounds(0, 0)).toBe(true);
    expect(grid.cellInBounds(93, 77)).toBe(true);
    expect(grid.cellInBounds(-1, 0)).toBe(false);
    expect(grid.cellInBounds(94, 0)).toBe(false);
    expect(grid.cellInBounds(0, 78)).toBe(false);
  });
});

describe('TerrainGrid — byte packing', () => {
  it('packs and unpacks (surface, tier, path) into one byte', () => {
    const grid = new TerrainGrid();
    const bytes = grid.serialize();
    // Default-constructed grid is all zeros = (VOID, T0, no path).
    expect(bytes.length).toBe(GRID_W * GRID_D);
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(grid.getCell(10, 10)).toEqual({ surface: Surface.VOID, tier: Tier.T0, path: 0 });
  });

  it('packs surface in bits 7..6, tier in bits 5..4, path in bits 3..0', () => {
    // LAND (2) = 0b10, T1 (1) = 0b01, path 7 = 0b0111
    // → 0b10_01_0111 = 0x97 = 151
    const bytes = new Uint8Array(GRID_W * GRID_D);
    bytes[10 * GRID_W + 10] = 0x97;
    const round = TerrainGrid.deserialize(bytes);
    expect(round.getCell(10, 10)).toEqual({
      surface: Surface.LAND,
      tier: Tier.T1,
      path: 7,
    });
  });
});

describe('TerrainGrid — cellHeight semantics', () => {
  it('returns NaN for VOID, 0 for OCEAN, tierHeight for LAND, tierHeight - bed-offset for FRESHWATER', () => {
    const bytes = new Uint8Array(GRID_W * GRID_D);
    // (cx=0, cz=0) → VOID (default 0)
    // (cx=1, cz=0) → OCEAN T0
    bytes[1] = (Surface.OCEAN << 6) | (Tier.T0 << 4);
    // (cx=2, cz=0) → LAND T2
    bytes[2] = (Surface.LAND << 6) | (Tier.T2 << 4);
    // (cx=3, cz=0) → FRESHWATER T1
    bytes[3] = (Surface.FRESHWATER << 6) | (Tier.T1 << 4);
    const grid = TerrainGrid.deserialize(bytes);

    expect(grid.cellHeight(0, 0)).toBeNaN();
    expect(grid.cellHeight(1, 0)).toBe(0);
    expect(grid.cellHeight(2, 0)).toBe(tierHeight(Tier.T2));
    expect(grid.cellHeight(3, 0)).toBeCloseTo(tierHeight(Tier.T1) - FRESHWATER_BED_OFFSET_METERS, 6);
  });
});

describe('TerrainGrid — serialize round-trip', () => {
  it('byte-exact round-trip via serialize/deserialize', () => {
    const original = TerrainGrid.bakeFromAnalytical();
    const bytes = original.serialize();
    const restored = TerrainGrid.deserialize(bytes);
    expect(restored.serialize()).toEqual(bytes);

    // Spot-check 100 random cells produce identical TerrainCell readouts.
    for (let i = 0; i < 100; i += 1) {
      const cx = Math.floor(Math.random() * GRID_W);
      const cz = Math.floor(Math.random() * GRID_D);
      expect(restored.getCell(cx, cz)).toEqual(original.getCell(cx, cz));
    }
  });

  it('byte-exact round-trip via serializeCompressed/deserializeCompressed (gzip)', async () => {
    const original = TerrainGrid.bakeFromAnalytical();
    const gz = await original.serializeCompressed();
    const restored = await TerrainGrid.deserializeCompressed(gz);
    expect(restored.serialize()).toEqual(original.serialize());
    // The compressed payload must fit comfortably in the 30 KB save cap.
    expect(gz.length).toBeLessThan(30 * 1024);
  });

  it('produces a deterministic base grid hash for the analytical bake', async () => {
    const a = TerrainGrid.bakeFromAnalytical();
    const b = TerrainGrid.bakeFromAnalytical();
    const ha = await a.computeBaseGridHash();
    const hb = await b.computeBaseGridHash();
    expect(ha).toBe(hb);
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('TerrainGrid — bakeFromAnalytical sanity counts', () => {
  // The analytical island (radii 44 × 36, perturbed ellipse, 94 × 78 m terrain)
  // should produce roughly the following cell counts. Bounds are loose because
  // the SDF perturbation introduces a few percent variation by angle.
  const grid = TerrainGrid.bakeFromAnalytical();
  const counts = countSurfaces(grid);

  it('has every cell classified into exactly one surface kind', () => {
    expect(counts.void + counts.ocean + counts.land + counts.freshwater)
      .toBe(GRID_W * GRID_D);
  });

  it('has zero VOID cells (the grid rectangle equals the playable terrain bounds)', () => {
    expect(counts.void).toBe(0);
  });

  it('has both LAND and OCEAN cells, with LAND filling roughly 60–80% of the rectangle', () => {
    expect(counts.land).toBeGreaterThan(0);
    expect(counts.ocean).toBeGreaterThan(0);
    const landRatio = counts.land / (GRID_W * GRID_D);
    expect(landRatio).toBeGreaterThan(0.55);
    expect(landRatio).toBeLessThan(0.85);
  });

  it('has at least 80 FRESHWATER cells (the analytical S-river spans ~40 cells × 3 wide)', () => {
    expect(counts.freshwater).toBeGreaterThan(80);
    // Sanity ceiling so a regression that mistakenly converts large land swathes
    // to freshwater is caught.
    expect(counts.freshwater).toBeLessThan(400);
  });

  it('has cliff plateau cells at tier 1 inside CLIFF_X / CLIFF_Z bounds', () => {
    // Heightmap.ts CLIFF bounds: X ∈ [-27, -10], Z ∈ [-21, -8].
    // A cell at world (-20, -15) should bake as LAND tier 1.
    const [cx, cz] = grid.worldToCell(-20, -15);
    const cell = grid.getCell(cx, cz);
    expect(cell.surface).toBe(Surface.LAND);
    expect(cell.tier).toBe(Tier.T1);
  });

  it('classifies the river center as FRESHWATER', () => {
    // riverCenterZ(0) = 5 + 6*sin(0) = 5
    const [cx, cz] = grid.worldToCell(0, 5);
    expect(grid.getSurface(cx, cz)).toBe(Surface.FRESHWATER);
  });

  it('classifies the spawn cell (0, 10) as LAND tier 0', () => {
    // The current player spawn (post-Step-0) sits south of the river, on grass.
    const [cx, cz] = grid.worldToCell(0, 10);
    const cell = grid.getCell(cx, cz);
    expect(cell.surface).toBe(Surface.LAND);
    expect(cell.tier).toBe(Tier.T0);
  });

  it('classifies world origin (0, 0) as LAND tier 0 (mid-island grass)', () => {
    const [cx, cz] = grid.worldToCell(0, 0);
    const cell = grid.getCell(cx, cz);
    expect(cell.surface).toBe(Surface.LAND);
    expect(cell.tier).toBe(Tier.T0);
  });
});

function countSurfaces(grid: TerrainGrid) {
  let voidC = 0;
  let ocean = 0;
  let land = 0;
  let freshwater = 0;
  grid.forEachCell((_cx, _cz, cell) => {
    switch (cell.surface) {
      case Surface.VOID:
        voidC += 1;
        break;
      case Surface.OCEAN:
        ocean += 1;
        break;
      case Surface.LAND:
        land += 1;
        break;
      case Surface.FRESHWATER:
        freshwater += 1;
        break;
    }
  });
  return { void: voidC, ocean, land, freshwater };
}
