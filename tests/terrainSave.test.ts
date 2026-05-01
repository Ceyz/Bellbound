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
  buildIslandMintTerrainFields,
  deserializeTerrain,
  serializeTerrain,
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
    expect(fields.tier_height).toBe(1.0);
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

// ─── Local test helper (mirror of the encoder in terrainSave.ts) ────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
