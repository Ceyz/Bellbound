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
  validateTierMass,
  wouldEditMaintainTierMass,
} from '../src/scene/terrain/TerrainGrid';
import {
  deriveStructureGeometry,
  type BuiltStructure,
  type BuiltStructureKind,
  type Rotation,
} from '../src/scene/terrain/builtStructure';

function testStruct(
  kind: BuiltStructureKind,
  originCell: [number, number],
  rotation: Rotation,
  length?: number,
): BuiltStructure {
  const isTiered = kind === 'staircase' || kind === 'incline';
  return deriveStructureGeometry({
    id: `test-${kind}-${originCell[0]}-${originCell[1]}-${rotation}`,
    kind,
    originCell,
    rotation,
    length: length ?? (isTiered ? 5 : 2),
    width: isTiered ? 2 : 1,
    style: 0,
  });
}

describe('TerrainGrid — geometry constants', () => {
  it('exposes the spec-locked grid dimensions', () => {
    expect(GRID_W).toBe(94);
    expect(GRID_D).toBe(78);
    expect(CELL).toBe(1.0);
    expect(TIER_HEIGHT_METERS).toBe(1.4);
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

describe('TerrainGrid — isTraversable', () => {
  const grid = TerrainGrid.bakeFromAnalytical();

  // Convenience: convert world coords to a cell tuple.
  const cell = (wx: number, wz: number): [number, number] => grid.worldToCell(wx, wz);

  it('same-cell move is always traversable', () => {
    const [cx, cz] = cell(0, 10);
    expect(grid.isTraversable(cx, cz, cx, cz)).toBe(true);
  });

  it('same-tier LAND ↔ LAND is traversable', () => {
    // (0, 10) and (1, 10) are both deep-inland LAND tier 0.
    const [fromCx, fromCz] = cell(0, 10);
    const [toCx, toCz] = cell(1, 10);
    expect(grid.isTraversable(fromCx, fromCz, toCx, toCz)).toBe(true);
  });

  it('LAND tier 0 → tier 1 (cliff edge) is BLOCKED without a staircase', () => {
    // Cliff X bounds: world [-27, -10] map to cells [20, 36]. cell (36, 24) is
    // T1 (just inside cliff bound), cell (37, 24) is T0 (just outside) — adjacent.
    const fromCx = 36;
    const fromCz = 24;
    const toCx = 37;
    const toCz = 24;
    expect(grid.getTier(fromCx, fromCz)).toBe(Tier.T1);
    expect(grid.getTier(toCx, toCz)).toBe(Tier.T0);
    expect(grid.isTraversable(fromCx, fromCz, toCx, toCz)).toBe(false);
  });

  it('LAND tier 0 → tier 1 with a staircase spanning both cells is traversable', () => {
    const fromCx = 36, fromCz = 24;
    const toCx = 37, toCz = 24;
    // (36,24) -> (37,24): forward=+X, so rotation=0, origin=lower-tier cell.
    const staircase = testStruct('staircase', [fromCx, fromCz], 0);
    expect(grid.isTraversable(fromCx, fromCz, toCx, toCz, [staircase])).toBe(true);
  });

  it('LAND → FRESHWATER (river) is BLOCKED without a bridge', () => {
    // River runs at z=5±1.8 along x=0. cell (47, 46) is world (0.5, 7.5) LAND,
    // cell (47, 45) is world (0.5, 6.5) FRESHWATER (z=6.5 within river halfwidth).
    const fromCx = 47, fromCz = 46;
    const toCx = 47, toCz = 45;
    expect(grid.getSurface(fromCx, fromCz)).toBe(Surface.LAND);
    expect(grid.getSurface(toCx, toCz)).toBe(Surface.FRESHWATER);
    expect(grid.isTraversable(fromCx, fromCz, toCx, toCz)).toBe(false);
  });

  it('LAND → FRESHWATER with a bridge structure spanning both cells is traversable', () => {
    const fromCx = 47, fromCz = 46;
    const toCx = 47, toCz = 45;
    // (47,46) -> (47,45): forward=-Z, so rotation=270, origin=land endpoint.
    const bridge = testStruct('bridge', [fromCx, fromCz], 270);
    expect(grid.isTraversable(fromCx, fromCz, toCx, toCz, [bridge])).toBe(true);
  });

  it('FRESHWATER → LAND is traversable (player escaping water)', () => {
    const fromCx = 47, fromCz = 45;
    const toCx = 47, toCz = 46;
    expect(grid.getSurface(fromCx, fromCz)).toBe(Surface.FRESHWATER);
    expect(grid.getSurface(toCx, toCz)).toBe(Surface.LAND);
    expect(grid.isTraversable(fromCx, fromCz, toCx, toCz)).toBe(true);
  });

  it('non-adjacent cells are BLOCKED (multi-cell hop rejected)', () => {
    // Same surface kind, both LAND tier 0, but two cells apart along x → blocked.
    expect(grid.isTraversable(47, 49, 49, 49)).toBe(false);
    // And along z.
    expect(grid.isTraversable(47, 49, 47, 51)).toBe(false);
  });

  it('diagonal adjacency (|Δx|=|Δz|=1) is allowed when both cells are same-tier LAND', () => {
    // Diagonal between two adjacent same-tier LAND cells is traversable. The
    // body probes use diagonal sample points, so this case must work.
    expect(grid.isTraversable(47, 49, 48, 50)).toBe(true);
  });

  it('LAND → OCEAN (adjacent shore step) is BLOCKED (no swimming in MVP)', () => {
    // Find an adjacent LAND/OCEAN pair somewhere along the perturbed shoreline.
    let landCx = -1, landCz = -1, oceanCx = -1, oceanCz = -1;
    outer:
    for (let cz = 0; cz < GRID_D; cz += 1) {
      for (let cx = 0; cx < GRID_W; cx += 1) {
        if (grid.getSurface(cx, cz) !== Surface.LAND) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx, nz = cz + dz;
          if (!grid.cellInBounds(nx, nz)) continue;
          if (grid.getSurface(nx, nz) === Surface.OCEAN) {
            landCx = cx; landCz = cz; oceanCx = nx; oceanCz = nz;
            break outer;
          }
        }
      }
    }
    expect(landCx).toBeGreaterThanOrEqual(0);
    expect(grid.isTraversable(landCx, landCz, oceanCx, oceanCz)).toBe(false);
  });

  it('out-of-bounds destination is BLOCKED', () => {
    const [fromCx, fromCz] = cell(0, 10);
    expect(grid.isTraversable(fromCx, fromCz, GRID_W, fromCz)).toBe(false);
    expect(grid.isTraversable(fromCx, fromCz, fromCx, GRID_D)).toBe(false);
    expect(grid.isTraversable(fromCx, fromCz, -1, fromCz)).toBe(false);
  });

  it('out-of-bounds source is BLOCKED', () => {
    const [toCx, toCz] = cell(0, 10);
    expect(grid.isTraversable(-1, toCz, toCx, toCz)).toBe(false);
  });

  it('a staircase structure does NOT also count as a bridge across water', () => {
    // Adjacent LAND/FRESHWATER pair (47, 46)/(47, 45) per earlier tests.
    const fromCx = 47, fromCz = 46;
    const toCx = 47, toCz = 45;
    const fakeStaircase = testStruct('staircase', [fromCx, fromCz], 270);
    expect(grid.isTraversable(fromCx, fromCz, toCx, toCz, [fakeStaircase])).toBe(false);
  });
});

describe('TerrainGrid — raiseCell / lowerCell (Step 5)', () => {
  // Each test gets a fresh grid because edits mutate state.
  function freshGrid(): TerrainGrid {
    return TerrainGrid.bakeFromAnalytical();
  }

  it('raiseCell promotes a LAND T0 cell to T1', () => {
    const grid = freshGrid();
    // Center of island, deep grass, T0.
    const cx = 47, cz = 39;
    expect(grid.getTier(cx, cz)).toBe(Tier.T0);
    expect(grid.raiseCell(cx, cz)).toBeNull();
    expect(grid.getTier(cx, cz)).toBe(Tier.T1);
  });

  it('raiseCell stacks up to T3 then refuses', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    expect(grid.raiseCell(cx, cz)).toBeNull(); // T0 → T1
    expect(grid.raiseCell(cx, cz)).toBeNull(); // T1 → T2
    expect(grid.raiseCell(cx, cz)).toBeNull(); // T2 → T3
    expect(grid.getTier(cx, cz)).toBe(Tier.T3);
    const result = grid.raiseCell(cx, cz);
    expect(result?.reason).toBe('max_tier');
    expect(grid.getTier(cx, cz)).toBe(Tier.T3);
  });

  it('raiseCell refuses OCEAN and FRESHWATER cells', () => {
    const grid = freshGrid();
    // River center
    const [riverCx, riverCz] = grid.worldToCell(0, 5);
    expect(grid.getSurface(riverCx, riverCz)).toBe(Surface.FRESHWATER);
    expect(grid.raiseCell(riverCx, riverCz)?.reason).toBe('not_land');
    // Out of bounds
    expect(grid.raiseCell(-1, 0)?.reason).toBe('out_of_bounds');
    expect(grid.raiseCell(0, GRID_D)?.reason).toBe('out_of_bounds');
  });

  it('lowerCell drops a LAND T1 cell to T0', () => {
    const grid = freshGrid();
    // Northwest cliff plateau cell, baked at T1.
    const [cx, cz] = grid.worldToCell(-20, -15);
    expect(grid.getTier(cx, cz)).toBe(Tier.T1);
    expect(grid.lowerCell(cx, cz)).toBeNull();
    expect(grid.getTier(cx, cz)).toBe(Tier.T0);
  });

  it('lowerCell refuses T0 (already at minimum)', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    expect(grid.getTier(cx, cz)).toBe(Tier.T0);
    expect(grid.lowerCell(cx, cz)?.reason).toBe('min_tier');
  });

  it('lowerCell refuses when a 4-neighbor is at strictly higher tier (cantilever)', () => {
    const grid = freshGrid();
    // Make a small column: raise a deep-inland cell to T2, then try to lower
    // one of its 4-neighbors that is at T1. The neighbor at T1 has the column
    // (T2) sitting on top of it on one side, so dropping the neighbor would
    // leave the T2 cell cantilevered.
    const cx = 47, cz = 39;
    grid.raiseCell(cx, cz);          // T0 → T1
    grid.raiseCell(cx, cz);          // T1 → T2
    grid.raiseCell(cx + 1, cz);      // neighbor T0 → T1
    // Now (cx+1, cz) is T1, with (cx, cz) at T2. Try to lower (cx+1, cz):
    // its neighbor (cx, cz) is at T2 (strictly higher) → cantilever.
    const result = grid.lowerCell(cx + 1, cz);
    expect(result?.reason).toBe('cantilever');
    expect(grid.getTier(cx + 1, cz)).toBe(Tier.T1); // unchanged
  });

  it('lowerCell refuses OCEAN / FRESHWATER and out-of-bounds', () => {
    const grid = freshGrid();
    const [riverCx, riverCz] = grid.worldToCell(0, 5);
    expect(grid.lowerCell(riverCx, riverCz)?.reason).toBe('not_land');
    expect(grid.lowerCell(-1, 0)?.reason).toBe('out_of_bounds');
  });

  it('every edit pushes a single-cell dirty rect that consumeDirtyRegions returns', () => {
    const grid = freshGrid();
    grid.consumeDirtyRegions(); // drain bake-time accidents
    const cx = 47, cz = 39;
    grid.raiseCell(cx, cz);
    const regions = grid.consumeDirtyRegions();
    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({ cxMin: cx, czMin: cz, cxMax: cx, czMax: cz });
    // Drained.
    expect(grid.consumeDirtyRegions()).toHaveLength(0);
  });
});

describe('TerrainGrid — digFreshwater / fillFreshwater (Step 6)', () => {
  function freshGrid(): TerrainGrid {
    return TerrainGrid.bakeFromAnalytical();
  }

  it('digFreshwater turns a LAND T0 cell into FRESHWATER T0', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    expect(grid.getSurface(cx, cz)).toBe(Surface.LAND);
    expect(grid.digFreshwater(cx, cz)).toBeNull();
    const after = grid.getCell(cx, cz);
    expect(after.surface).toBe(Surface.FRESHWATER);
    expect(after.tier).toBe(Tier.T0);
  });

  it('digFreshwater preserves the tier (T1 LAND → T1 FRESHWATER)', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    grid.raiseCell(cx, cz); // T0 → T1
    expect(grid.digFreshwater(cx, cz)).toBeNull();
    expect(grid.getCell(cx, cz)).toEqual({ surface: Surface.FRESHWATER, tier: Tier.T1, path: 0 });
  });

  it('digFreshwater is allowed at the foot of a cliff (waterfall setup)', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    grid.raiseCell(cx, cz); // T0 → T1
    // Digging at (cx + 1, cz) puts water adjacent to the T1 cell, which is
    // exactly the AC pattern for triggering an auto-generated waterfall.
    expect(grid.digFreshwater(cx + 1, cz)).toBeNull();
    expect(grid.getSurface(cx + 1, cz)).toBe(Surface.FRESHWATER);
  });

  it('digFreshwater refuses non-LAND cells (FRESHWATER, OCEAN, out-of-bounds)', () => {
    const grid = freshGrid();
    const [riverCx, riverCz] = grid.worldToCell(0, 5);
    expect(grid.digFreshwater(riverCx, riverCz)?.reason).toBe('not_land');
    expect(grid.digFreshwater(-1, 0)?.reason).toBe('out_of_bounds');
  });

  it('digFreshwater clears the path field (paths are illegal on water)', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    grid.paintPath(cx, cz, 5); // arbitrary path style
    expect(grid.getCell(cx, cz).path).toBe(5);
    grid.digFreshwater(cx, cz);
    const after = grid.getCell(cx, cz);
    expect(after.surface).toBe(Surface.FRESHWATER);
    expect(after.path).toBe(0);
    // Filling back to LAND must NOT resurrect the old path byte.
    grid.fillFreshwater(cx, cz);
    expect(grid.getCell(cx, cz).path).toBe(0);
  });

  it('fillFreshwater reverts FRESHWATER to LAND at the same tier', () => {
    const grid = freshGrid();
    const [cx, cz] = grid.worldToCell(0, 5); // existing river center, T0 freshwater
    expect(grid.getSurface(cx, cz)).toBe(Surface.FRESHWATER);
    expect(grid.fillFreshwater(cx, cz)).toBeNull();
    const after = grid.getCell(cx, cz);
    expect(after.surface).toBe(Surface.LAND);
    expect(after.tier).toBe(Tier.T0);
  });

  it('fillFreshwater allows fully filling a pond (no source-preservation check)', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    grid.digFreshwater(cx, cz); // 1×1 isolated pond
    expect(grid.fillFreshwater(cx, cz)).toBeNull();
    expect(grid.getSurface(cx, cz)).toBe(Surface.LAND);
  });

  it('fillFreshwater refuses non-FRESHWATER cells', () => {
    const grid = freshGrid();
    expect(grid.fillFreshwater(47, 39)?.reason).toBe('not_freshwater');
    expect(grid.fillFreshwater(-1, 0)?.reason).toBe('out_of_bounds');
  });
});

describe('TerrainGrid — paintPath / erasePath (Step 7)', () => {
  function freshGrid(): TerrainGrid {
    return TerrainGrid.bakeFromAnalytical();
  }

  it('paintPath sets the path field on a LAND cell', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    expect(grid.getCell(cx, cz).path).toBe(0);
    expect(grid.paintPath(cx, cz, 1)).toBeNull();
    const after = grid.getCell(cx, cz);
    expect(after.path).toBe(1);
    expect(after.surface).toBe(Surface.LAND);
    expect(after.tier).toBe(Tier.T0);
  });

  it('paintPath preserves tier when the cell is on a raised cliff', () => {
    const grid = freshGrid();
    const cx = 47, cz = 39;
    grid.raiseCell(cx, cz); // T0 → T1
    expect(grid.paintPath(cx, cz, 3)).toBeNull();
    const after = grid.getCell(cx, cz);
    expect(after.tier).toBe(Tier.T1);
    expect(after.path).toBe(3);
  });

  it('paintPath is idempotent on the same style', () => {
    const grid = freshGrid();
    grid.paintPath(47, 39, 2);
    grid.consumeDirtyRegions();
    grid.paintPath(47, 39, 2); // same style, should be a no-op
    expect(grid.consumeDirtyRegions()).toHaveLength(0);
  });

  it('paintPath refuses non-LAND cells, out-of-bounds, and bad kinds', () => {
    const grid = freshGrid();
    const [riverCx, riverCz] = grid.worldToCell(0, 5);
    expect(grid.paintPath(riverCx, riverCz, 1)?.reason).toBe('not_land');
    expect(grid.paintPath(-1, 0, 1)?.reason).toBe('out_of_bounds');
    expect(grid.paintPath(47, 39, 16)?.reason).toBe('invalid_path_kind');
    expect(grid.paintPath(47, 39, -1)?.reason).toBe('invalid_path_kind');
  });

  it('erasePath clears the path field', () => {
    const grid = freshGrid();
    grid.paintPath(47, 39, 5);
    expect(grid.erasePath(47, 39)).toBeNull();
    expect(grid.getCell(47, 39).path).toBe(0);
  });

  it('erasePath is a no-op when path is already 0', () => {
    const grid = freshGrid();
    grid.consumeDirtyRegions();
    grid.erasePath(47, 39);
    expect(grid.consumeDirtyRegions()).toHaveLength(0);
  });
});

describe('TerrainGrid — forEachLandOceanEdge', () => {
  const grid = TerrainGrid.bakeFromAnalytical();

  it('yields a non-trivial number of shore edges for the baked island', () => {
    let edgeCount = 0;
    grid.forEachLandOceanEdge(() => {
      edgeCount += 1;
    });
    // The baked island has a few hundred shore edges. Loose bounds so small
    // bake tweaks (perturbation, BEACH_TRANSITION) don't break the test.
    expect(edgeCount).toBeGreaterThan(50);
    expect(edgeCount).toBeLessThan(800);
  });

  it('every yielded pair has LAND/FRESHWATER on the inland side and OCEAN on the ocean side', () => {
    let mismatches = 0;
    grid.forEachLandOceanEdge((inlandCx, inlandCz, oceanCx, oceanCz) => {
      const inland = grid.getSurface(inlandCx, inlandCz);
      const ocean = grid.getSurface(oceanCx, oceanCz);
      if (inland === Surface.OCEAN || inland === Surface.VOID) mismatches += 1;
      if (ocean !== Surface.OCEAN) mismatches += 1;
    });
    expect(mismatches).toBe(0);
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

// ─── validateTierMass ───────────────────────────────────────────────────

/**
 * Helper: build a grid where every (cx, cz) in `cells` is set to LAND at
 * the given tier; everything else stays VOID T0. Compact way to spell out
 * the small fixtures the tier-mass tests need.
 */
function landGrid(cells: Array<{ cx: number; cz: number; tier: Tier }>): TerrainGrid {
  const grid = new TerrainGrid();
  for (const { cx, cz, tier } of cells) {
    grid.setRawByte(cx, cz, (Surface.LAND << 6) | (tier << 4));
  }
  return grid;
}

function rect(
  x0: number,
  z0: number,
  w: number,
  d: number,
  tier: Tier,
): Array<{ cx: number; cz: number; tier: Tier }> {
  const cells = [];
  for (let cz = z0; cz < z0 + d; cz += 1) {
    for (let cx = x0; cx < x0 + w; cx += 1) {
      cells.push({ cx, cz, tier });
    }
  }
  return cells;
}

describe('TerrainGrid — validateTierMass', () => {
  it('accepts a 2×2 plateau at T1', () => {
    const grid = landGrid(rect(10, 10, 2, 2, Tier.T1));
    expect(validateTierMass(grid)).toEqual([]);
  });

  it('rejects an isolated single T1 cell', () => {
    const grid = landGrid([{ cx: 10, cz: 10, tier: Tier.T1 }]);
    const errors = validateTierMass(grid);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/tier-1 mass at \(10, 10\) has no 2×2 block/);
  });

  it('rejects a 1×4 horizontal strip at T1', () => {
    const grid = landGrid(rect(10, 10, 4, 1, Tier.T1));
    expect(validateTierMass(grid)[0]).toMatch(/tier-1.*no 2×2 block.*size=4/);
  });

  it('rejects a 4×1 vertical strip at T1', () => {
    const grid = landGrid(rect(10, 10, 1, 4, Tier.T1));
    expect(validateTierMass(grid)[0]).toMatch(/tier-1.*no 2×2 block.*size=4/);
  });

  it('accepts a 4×4 plateau plus a 1-cell spike attached to it (component contains 2×2)', () => {
    const grid = landGrid([
      ...rect(10, 10, 4, 4, Tier.T1),
      { cx: 14, cz: 11, tier: Tier.T1 }, // spike off the east edge
    ]);
    expect(validateTierMass(grid)).toEqual([]);
  });

  it('rejects a 1-wide L-shape (no 2×2 anywhere in the bend)', () => {
    // L-shape: 4 cells along +X, then 3 cells along +Z from the corner.
    const grid = landGrid([
      ...rect(10, 10, 4, 1, Tier.T1),
      { cx: 13, cz: 11, tier: Tier.T1 },
      { cx: 13, cz: 12, tier: Tier.T1 },
      { cx: 13, cz: 13, tier: Tier.T1 },
    ]);
    expect(validateTierMass(grid)[0]).toMatch(/tier-1.*no 2×2 block/);
  });

  it('treats higher tiers as support: a T1 base under a T2 plateau passes the T1 check via the >= mask', () => {
    // 1-wide T1 strip would normally fail at tier 1, but the T2 plateau on
    // top counts as tier ≥ 1 too — the combined mask contains a 2×2.
    const grid = landGrid([
      ...rect(10, 10, 4, 1, Tier.T1),
      ...rect(10, 11, 4, 1, Tier.T2),
      ...rect(10, 12, 4, 1, Tier.T2),
    ]);
    // tier-1 mask = all 12 cells (T1 + T2 contiguously). Contains a 2×2 from
    // (10,10)-(11,10)-(10,11)-(11,11) where the T1 strip meets the T2 strip.
    // tier-2 mask = the 8 T2 cells (rect 4×2). 4×2 contains a 2×2.
    expect(validateTierMass(grid)).toEqual([]);
  });

  it('rejects a T2 plateau with no 2×2 even when the T1 base is solid', () => {
    // 4×4 T1 plateau, with a 1×3 T2 strip on top. T1 mask passes (the 4×4
    // contains 2×2). T2 mask fails (1×3 has no 2×2).
    const grid = landGrid([
      ...rect(10, 10, 4, 4, Tier.T1),
      { cx: 11, cz: 11, tier: Tier.T2 },
      { cx: 12, cz: 11, tier: Tier.T2 },
      { cx: 13, cz: 11, tier: Tier.T2 },
    ]);
    const errors = validateTierMass(grid);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/tier-2.*no 2×2 block/);
  });

  it('flags every offending component independently when multiple fail', () => {
    // Two separate 1-wide T1 strips → two errors.
    const grid = landGrid([
      ...rect(10, 10, 3, 1, Tier.T1),
      ...rect(20, 20, 1, 3, Tier.T1),
    ]);
    expect(validateTierMass(grid)).toHaveLength(2);
  });

  it('the analytical bake (real island) satisfies the rule', () => {
    const grid = TerrainGrid.bakeFromAnalytical();
    expect(validateTierMass(grid)).toEqual([]);
  });
});

describe('TerrainGrid — wouldEditMaintainTierMass', () => {
  it('a raise that would create an isolated T1 cell is refused', () => {
    const grid = new TerrainGrid();
    grid.setRawByte(10, 10, (Surface.LAND << 6) | (Tier.T0 << 4));
    expect(wouldEditMaintainTierMass(grid, 10, 10, Surface.LAND, Tier.T1)).toBe(false);
  });

  it('a raise that would create the 4th cell of a 2×2 plateau is accepted', () => {
    // Pre-existing L-shape: 3 cells of a 2×2 already at T1. Raising the 4th
    // completes the square.
    const grid = landGrid([
      { cx: 10, cz: 10, tier: Tier.T1 },
      { cx: 11, cz: 10, tier: Tier.T1 },
      { cx: 10, cz: 11, tier: Tier.T1 },
      { cx: 11, cz: 11, tier: Tier.T0 }, // about to raise
    ]);
    // Pre-edit grid is invalid (3-cell L has no 2×2). The predicate is about
    // post-edit validity though — and the post-edit state IS valid.
    expect(wouldEditMaintainTierMass(grid, 11, 11, Surface.LAND, Tier.T1)).toBe(true);
  });

  it('a lower that would split a T1 mass into two sub-components, one without a 2×2, is refused', () => {
    // Layout: a 2×2 plateau in the east connected by a 1-wide bridge to a
    // 1×3 strip in the west. Pre-edit the whole thing is one component and
    // contains the east 2×2 — valid. Lowering (17, 20) cuts the bridge:
    //   - West sub-component {(13, 20)..(16, 20)} = 1×4 → no 2×2 ❌
    //   - East sub-component {(18..21, 20), (20..21, 21)} → still has 2×2 ✓
    const grid = landGrid([
      // West 1×3 strip
      { cx: 13, cz: 20, tier: Tier.T1 },
      { cx: 14, cz: 20, tier: Tier.T1 },
      { cx: 15, cz: 20, tier: Tier.T1 },
      // Connector
      { cx: 16, cz: 20, tier: Tier.T1 },
      { cx: 17, cz: 20, tier: Tier.T1 },
      { cx: 18, cz: 20, tier: Tier.T1 },
      { cx: 19, cz: 20, tier: Tier.T1 },
      // East 2×2 plateau
      { cx: 20, cz: 20, tier: Tier.T1 },
      { cx: 21, cz: 20, tier: Tier.T1 },
      { cx: 20, cz: 21, tier: Tier.T1 },
      { cx: 21, cz: 21, tier: Tier.T1 },
    ]);
    // Pre-edit: one big component with the east 2×2 → valid.
    expect(validateTierMass(grid)).toEqual([]);
    // Lower the connector cell that bridges the two halves.
    expect(wouldEditMaintainTierMass(grid, 17, 20, Surface.LAND, Tier.T0)).toBe(false);
  });

  it('a dig that turns a critical T1 cell to FRESHWATER is refused (FW counts as not-LAND)', () => {
    // 2×2 T1 plateau. Digging any cell to FW removes it from the LAND mask
    // → 3 LAND cells left, no 2×2.
    const grid = landGrid(rect(10, 10, 2, 2, Tier.T1));
    expect(wouldEditMaintainTierMass(grid, 10, 10, Surface.FRESHWATER, Tier.T1)).toBe(false);
  });
});
