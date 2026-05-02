import { afterEach, describe, expect, it } from 'vitest';
import {
  GRID_D,
  GRID_W,
  Surface,
  TerrainGrid,
  Tier,
  getTerrainGrid,
  gzipBytes,
  setTerrainGridForTesting,
} from '../src/scene/terrain/TerrainGrid';
import {
  DEFAULT_TERRAIN_SEED,
  TERRAIN_BASE_SHAPE_VERSION,
  TERRAIN_SAVE_VERSION,
  applyTerrainSave,
  bootTerrain,
  buildIslandMintTerrainFields,
  deserializeTerrain,
  serializeTerrain,
  validateMintMetadata,
  type IslandMintTerrainFields,
} from '../src/scene/terrain/terrainSave';

afterEach(() => {
  setTerrainGridForTesting(null);
});

describe('terrainSave — round-trip', () => {
  it('serializes a baked grid and deserializes byte-identical', async () => {
    const original = TerrainGrid.bakeFromAnalytical();
    const payload = await serializeTerrain(original);

    expect(payload.version).toBe(TERRAIN_SAVE_VERSION);
    expect(typeof payload.data_b64).toBe('string');
    expect(payload.data_b64.length).toBeGreaterThan(0);
    // Base64 alphabet only (A-Z, a-z, 0-9, +, /, =).
    expect(payload.data_b64).toMatch(/^[A-Za-z0-9+/=]+$/);

    const result = await deserializeTerrain(payload);
    expect(result.errors).toEqual([]);
    expect(result.grid).not.toBeNull();
    expect(result.grid!.serialize()).toEqual(original.serialize());
  });

  it('preserves player edits across save -> reload (the Step 8 critical test)', async () => {
    const grid = TerrainGrid.bakeFromAnalytical();

    // Apply a representative mix of edits: raise, dig water, paint path, lower.
    // The bake places LAND T0 cells almost everywhere on-island, so we pick a
    // few coordinates known to be LAND and exercise each tool.
    const cellsToRaise: [number, number][] = [[40, 35], [41, 35], [42, 35]];
    for (const [cx, cz] of cellsToRaise) {
      // Force LAND at the chosen cell so the test is independent of bake noise.
      grid.setRawByte(cx, cz, (Surface.LAND << 6) | (Tier.T0 << 4));
      const err = grid.raiseCell(cx, cz);
      expect(err).toBeNull();
    }
    grid.setRawByte(50, 30, (Surface.LAND << 6) | (Tier.T0 << 4));
    expect(grid.digFreshwater(50, 30)).toBeNull();

    grid.setRawByte(20, 20, (Surface.LAND << 6) | (Tier.T0 << 4));
    expect(grid.paintPath(20, 20, 3)).toBeNull();

    const expectedBytes = grid.serialize();
    const payload = await serializeTerrain(grid);
    const result = await deserializeTerrain(payload);

    expect(result.errors).toEqual([]);
    expect(result.grid!.serialize()).toEqual(expectedBytes);

    // Spot-check the specific edits round-tripped per cell.
    expect(result.grid!.getCell(40, 35).tier).toBe(Tier.T1);
    expect(result.grid!.getCell(50, 30).surface).toBe(Surface.FRESHWATER);
    expect(result.grid!.getCell(20, 20).path).toBe(3);
  });

  it('keeps payload comfortably under the 30 KB save cap', async () => {
    const grid = TerrainGrid.bakeFromAnalytical();
    const payload = await serializeTerrain(grid);
    // base64 inflates the gzip output by ~33%; the gzip itself is well under
    // 30 KB (the spec'd hard cap on the entire `state` blob, terrain included).
    expect(payload.data_b64.length).toBeLessThan(30 * 1024);
  });
});

describe('terrainSave — validation', () => {
  it('rejects null/non-object payload', async () => {
    expect((await deserializeTerrain(null)).grid).toBeNull();
    expect((await deserializeTerrain(undefined)).grid).toBeNull();
    expect((await deserializeTerrain('a string')).grid).toBeNull();
    expect((await deserializeTerrain(42)).grid).toBeNull();
  });

  it('rejects unsupported version', async () => {
    const baked = await serializeTerrain(TerrainGrid.bakeFromAnalytical());
    const result = await deserializeTerrain({ ...baked, version: 999 });
    expect(result.grid).toBeNull();
    expect(result.errors[0]).toMatch(/unsupported terrain version/);
  });

  it('rejects missing data_b64', async () => {
    const result = await deserializeTerrain({ version: TERRAIN_SAVE_VERSION });
    expect(result.grid).toBeNull();
    expect(result.errors[0]).toMatch(/data_b64 missing/);
  });

  it('rejects non-string data_b64', async () => {
    const result = await deserializeTerrain({
      version: TERRAIN_SAVE_VERSION,
      data_b64: 12345,
    });
    expect(result.grid).toBeNull();
    expect(result.errors[0]).toMatch(/data_b64 missing or not a string/);
  });

  it('rejects malformed base64', async () => {
    const result = await deserializeTerrain({
      version: TERRAIN_SAVE_VERSION,
      data_b64: 'not valid base64!!!',
    });
    expect(result.grid).toBeNull();
    expect(result.errors[0]).toMatch(/base64 decode failed/);
  });

  it('rejects valid base64 that is not gzip', async () => {
    // base64("hello") = "aGVsbG8=" — valid base64, garbage gzip.
    const result = await deserializeTerrain({
      version: TERRAIN_SAVE_VERSION,
      data_b64: 'aGVsbG8=',
    });
    expect(result.grid).toBeNull();
    expect(result.errors[0]).toMatch(/gzip decode failed/);
  });

  it('rejects gzip that decompresses to wrong byte length', async () => {
    // Gzip a 50-byte buffer → decompresses to 50, expected = 7332.
    const tooShort = new Uint8Array(50);
    const compressed = await gzipBytes(tooShort);
    const data_b64 = bytesToBase64(compressed);
    const result = await deserializeTerrain({
      version: TERRAIN_SAVE_VERSION,
      data_b64,
    });
    expect(result.grid).toBeNull();
    expect(result.errors[0]).toMatch(/expected \d+ bytes after decompress, got 50/);
  });
});

describe('terrainSave — applyTerrainSave (singleton wiring)', () => {
  it('replaces the active singleton on success', async () => {
    // Build a custom grid distinguishable from the analytical bake.
    const custom = new TerrainGrid();
    custom.setRawByte(10, 10, (Surface.LAND << 6) | (Tier.T2 << 4) | 5);
    const payload = await serializeTerrain(custom);

    const result = await applyTerrainSave(payload);
    expect(result.errors).toEqual([]);
    expect(result.grid).not.toBeNull();

    const live = getTerrainGrid();
    expect(live.getCell(10, 10)).toEqual({
      surface: Surface.LAND,
      tier: Tier.T2,
      path: 5,
    });
  });

  it('does not mutate the singleton on failure', async () => {
    // Seed a known singleton, then attempt a bad load.
    const seed = TerrainGrid.bakeFromAnalytical();
    setTerrainGridForTesting(seed);
    const seedBytes = seed.serialize();

    const result = await applyTerrainSave({ version: 999, data_b64: 'x' });
    expect(result.grid).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);

    // Singleton must still be the seed grid byte-for-byte.
    expect(getTerrainGrid().serialize()).toEqual(seedBytes);
  });
});

describe('terrainSave — buildIslandMintTerrainFields', () => {
  it('returns spec-correct shape with deterministic hash', async () => {
    const grid = TerrainGrid.bakeFromAnalytical();
    const fields = await buildIslandMintTerrainFields(grid);

    expect(fields.grid_w).toBe(GRID_W);
    expect(fields.grid_d).toBe(GRID_D);
    expect(fields.cell_size).toBe(1.0);
    expect(fields.tier_height).toBe(1.4);
    expect(fields.origin_x).toBe(-47);
    expect(fields.origin_z).toBe(-39);
    expect(fields.terrain_seed).toBe(DEFAULT_TERRAIN_SEED);
    expect(fields.terrain_base_shape_version).toBe(TERRAIN_BASE_SHAPE_VERSION);
    expect(fields.terrain_base_grid_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces an identical hash across repeated bakes (silent-drift detector)', async () => {
    const a = await buildIslandMintTerrainFields(TerrainGrid.bakeFromAnalytical());
    const b = await buildIslandMintTerrainFields(TerrainGrid.bakeFromAnalytical());
    expect(a.terrain_base_grid_hash).toBe(b.terrain_base_grid_hash);
  });

  it('hash matches grid.computeBaseGridHash()', async () => {
    const grid = TerrainGrid.bakeFromAnalytical();
    const fields = await buildIslandMintTerrainFields(grid);
    expect(fields.terrain_base_grid_hash).toBe(await grid.computeBaseGridHash());
  });
});

describe('terrainSave — validateMintMetadata', () => {
  it('returns no errors for a fresh self-bake', async () => {
    const fields = await buildIslandMintTerrainFields(TerrainGrid.bakeFromAnalytical());
    expect(await validateMintMetadata(fields)).toEqual([]);
  });

  it('reports geometric mismatches', async () => {
    const fields = await buildIslandMintTerrainFields(TerrainGrid.bakeFromAnalytical());
    expect(await validateMintMetadata({ ...fields, grid_w: 100 }))
      .toEqual([expect.stringMatching(/grid_w mismatch/)]);
    expect(await validateMintMetadata({ ...fields, cell_size: 2 }))
      .toEqual([expect.stringMatching(/cell_size mismatch/)]);
    expect(await validateMintMetadata({ ...fields, tier_height: 3 }))
      .toEqual([expect.stringMatching(/tier_height mismatch/)]);
    expect(await validateMintMetadata({ ...fields, terrain_base_shape_version: 2 }))
      .toEqual([expect.stringMatching(/unsupported terrain_base_shape_version/)]);
  });

  it('detects silent drift via terrain_base_grid_hash mismatch', async () => {
    const fields = await buildIslandMintTerrainFields(TerrainGrid.bakeFromAnalytical());
    const errors = await validateMintMetadata({
      ...fields,
      terrain_base_grid_hash: 'a'.repeat(64),
    });
    expect(errors).toEqual([expect.stringMatching(/terrain_base_grid_hash mismatch/)]);
  });
});

describe('terrainSave — bootTerrain', () => {
  it('with no opts: lazy bake fallback, mutates singleton, no errors', async () => {
    setTerrainGridForTesting(null);
    const result = await bootTerrain();
    expect(result.source).toBe('fallback');
    expect(result.errors).toEqual([]);
    expect(result.fatalMintErrors).toEqual([]);
    expect(result.grid.serialize()).toEqual(getTerrainGrid().serialize());
  });

  it('with valid mint only: rebuilds base from mint, source=mint-base', async () => {
    const baseGrid = TerrainGrid.bakeFromAnalytical();
    const fields = await buildIslandMintTerrainFields(baseGrid);
    setTerrainGridForTesting(null);

    const result = await bootTerrain({ mint: fields });
    expect(result.source).toBe('mint-base');
    expect(result.fatalMintErrors).toEqual([]);
    expect(result.grid.serialize()).toEqual(baseGrid.serialize());
  });

  it('with valid save + valid mint: loads save, source=save', async () => {
    const baseGrid = TerrainGrid.bakeFromAnalytical();
    const fields = await buildIslandMintTerrainFields(baseGrid);

    // Build a custom edited grid distinguishable from the base.
    const edited = new TerrainGrid();
    edited.setRawByte(5, 5, (Surface.LAND << 6) | (Tier.T2 << 4) | 7);
    const save = await serializeTerrain(edited);

    const result = await bootTerrain({ save, mint: fields });
    expect(result.source).toBe('save');
    expect(result.fatalMintErrors).toEqual([]);
    expect(result.grid.getCell(5, 5)).toEqual({
      surface: Surface.LAND,
      tier: Tier.T2,
      path: 7,
    });
  });

  it('with hash drift: rejects save, falls back, fatalMintErrors populated', async () => {
    const baseGrid = TerrainGrid.bakeFromAnalytical();
    const fields = await buildIslandMintTerrainFields(baseGrid);
    const driftedFields: IslandMintTerrainFields = {
      ...fields,
      terrain_base_grid_hash: 'a'.repeat(64),
    };

    // A save that WOULD load successfully if mint check were bypassed.
    const edited = new TerrainGrid();
    edited.setRawByte(0, 0, (Surface.LAND << 6) | (Tier.T1 << 4));
    const save = await serializeTerrain(edited);

    const result = await bootTerrain({ save, mint: driftedFields });
    expect(result.source).toBe('fallback');
    expect(result.fatalMintErrors).toEqual([expect.stringMatching(/terrain_base_grid_hash mismatch/)]);
    // Save was ignored — the grid is the analytical fallback, not the edited save.
    expect(result.grid.serialize()).toEqual(baseGrid.serialize());
  });

  it('with geometric mismatch: rejects save, falls back', async () => {
    const fields = await buildIslandMintTerrainFields(TerrainGrid.bakeFromAnalytical());
    const result = await bootTerrain({
      mint: { ...fields, grid_w: 200 },
    });
    expect(result.source).toBe('fallback');
    expect(result.fatalMintErrors[0]).toMatch(/grid_w mismatch/);
  });

  it('with valid mint + invalid save: falls through to mint-base, save errors reported', async () => {
    const fields = await buildIslandMintTerrainFields(TerrainGrid.bakeFromAnalytical());
    const result = await bootTerrain({
      save: { version: 999, data_b64: 'x' },
      mint: fields,
    });
    expect(result.source).toBe('mint-base');
    expect(result.fatalMintErrors).toEqual([]);
    expect(result.errors[0]).toMatch(/unsupported terrain version/);
  });

  it('with no mint + invalid save: falls through to lazy bake fallback, save errors reported', async () => {
    setTerrainGridForTesting(null);
    const result = await bootTerrain({ save: { version: 42, data_b64: 'q' } });
    expect(result.source).toBe('fallback');
    expect(result.fatalMintErrors).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('always installs a usable grid in the singleton', async () => {
    // Even on the worst-case (bad mint + bad save), the singleton must end
    // up with a valid 94x78 grid so the scene boots.
    setTerrainGridForTesting(null);
    const fields = await buildIslandMintTerrainFields(TerrainGrid.bakeFromAnalytical());
    await bootTerrain({
      save: 'garbage',
      mint: { ...fields, terrain_base_grid_hash: 'b'.repeat(64) },
    });
    const live = getTerrainGrid();
    expect(live.serialize().length).toBe(GRID_W * GRID_D);
  });
});

// ─── Local test helper (mirror of the encoder in terrainSave.ts) ────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
