import {
  CELL,
  GRID_D,
  GRID_W,
  TERRAIN_ORIGIN,
  TIER_HEIGHT_METERS,
  TerrainGrid,
  gunzipBytes,
  replaceTerrainGrid,
} from './TerrainGrid';

/**
 * Step 8 — `island_save.state.terrain` wire format and `island_mint.initial_state`
 * terrain metadata helpers.
 *
 * Two related shapes per GAME_SPEC.md §2.3 / §2.4 and TERRAFORMING_REFACTO_PLAN.md §3.5:
 *
 *   1. `state.terrain` (per save) — `{ version, data_b64 }`. Just the player's edited
 *      grid, gzip'd and base64'd. The geometric context lives in the mint, not here.
 *
 *   2. `island_mint.initial_state.terrain_*` (per island, immutable) — `grid_w`,
 *      `grid_d`, `cell_size`, `origin_x`, `origin_z`, `tier_height`, `terrain_seed`,
 *      `terrain_base_shape_version`, `terrain_base_grid_hash`. These bound and
 *      validate every subsequent save.
 *
 * The `(terrain_base_shape_version, terrain_base_grid_hash)` pair is the silent-
 * drift detector: the integer says which generator to use, the hash verifies that
 * we got byte-identical output. If the hash mismatches a known seed, the save is
 * rejected (spec §3.5 hard check).
 */

/** On-disk shape of `island_save.state.terrain`. */
export interface TerrainSavePayload {
  version: number;
  data_b64: string;
}

/** Immutable terrain metadata in `island_mint.initial_state`. */
export interface IslandMintTerrainFields {
  terrain_seed: string;
  terrain_base_shape_version: number;
  terrain_base_grid_hash: string;
  grid_w: number;
  grid_d: number;
  cell_size: number;
  origin_x: number;
  origin_z: number;
  tier_height: number;
}

/** Currently `1`. Bumps when the wire format changes. */
export const TERRAIN_SAVE_VERSION = 1;

/**
 * The current base-shape generator version. Bumps every time the bake function
 * (`bakeFromAnalytical` or its successor) changes its byte output for the same
 * seed — old saves anchored against an old hash become rejectable on load.
 */
export const TERRAIN_BASE_SHAPE_VERSION = 1;

/**
 * Default seed used by the v1 bake. The current `bakeFromAnalytical` is
 * parameter-free, so the seed is a deterministic constant. Once Phase A.5
 * introduces procedural per-island generation this becomes a per-mint value
 * derived from the mint block hash; until then every island shares the same
 * base shape — that's the spec'd MVP behaviour (one fixed island).
 */
export const DEFAULT_TERRAIN_SEED = `0x${'0'.repeat(64)}`;

/** Result of `deserializeTerrain`. `errors` is empty iff `grid` is non-null. */
export interface TerrainLoadResult {
  grid: TerrainGrid | null;
  errors: string[];
}

// ─── Serialization ─────────────────────────────────────────────────────

/** Pack a grid into the save payload (`{ version, data_b64 }`). */
export async function serializeTerrain(grid: TerrainGrid): Promise<TerrainSavePayload> {
  const compressed = await grid.serializeCompressed();
  return {
    version: TERRAIN_SAVE_VERSION,
    data_b64: bytesToBase64(compressed),
  };
}

/**
 * Decode and validate a save payload. Validation per spec §3.5:
 *   - `version` matches the current wire format
 *   - `data_b64` is base64-decodable
 *   - decoded bytes are gzip-decompressible
 *   - decompressed length is exactly `GRID_W * GRID_D`
 *
 * Per-byte bit-range validation (`surface ∈ [0,3]`, `tier ∈ [0,3]`,
 * `path ∈ [0,15]`) is automatic: 2+2+4 = 8 bits, every representable byte
 * sits inside the spec'd ranges by construction. There is no per-byte garbage
 * check needed at this level.
 */
export async function deserializeTerrain(
  payload: unknown,
): Promise<TerrainLoadResult> {
  const errors: string[] = [];

  if (!payload || typeof payload !== 'object') {
    return { grid: null, errors: ['payload is not an object'] };
  }

  const obj = payload as Partial<TerrainSavePayload>;

  if (obj.version !== TERRAIN_SAVE_VERSION) {
    errors.push(
      `unsupported terrain version: ${obj.version} (expected ${TERRAIN_SAVE_VERSION})`,
    );
    return { grid: null, errors };
  }
  if (typeof obj.data_b64 !== 'string') {
    errors.push('data_b64 missing or not a string');
    return { grid: null, errors };
  }

  let compressed: Uint8Array;
  try {
    compressed = base64ToBytes(obj.data_b64);
  } catch (e) {
    errors.push(`base64 decode failed: ${(e as Error).message}`);
    return { grid: null, errors };
  }

  let raw: Uint8Array;
  try {
    raw = await gunzipBytes(compressed);
  } catch (e) {
    errors.push(`gzip decode failed: ${(e as Error).message}`);
    return { grid: null, errors };
  }

  if (raw.length !== GRID_W * GRID_D) {
    errors.push(`expected ${GRID_W * GRID_D} bytes after decompress, got ${raw.length}`);
    return { grid: null, errors };
  }

  return { grid: TerrainGrid.deserialize(raw), errors: [] };
}

/**
 * Deserialize and install the save's terrain grid as the active singleton.
 * This is the boot-time entry point: callers (main.ts boot) should try this
 * with `island_save.state.terrain` first; if the result has errors, they fall
 * back to the analytical bake (which `getTerrainGrid()` produces lazily).
 *
 * Returns the same `TerrainLoadResult` as `deserializeTerrain` so callers can
 * surface errors. The singleton is only mutated on success.
 */
export async function applyTerrainSave(
  payload: unknown,
): Promise<TerrainLoadResult> {
  const result = await deserializeTerrain(payload);
  if (result.grid) {
    replaceTerrainGrid(result.grid);
  }
  return result;
}

// ─── Mint metadata ─────────────────────────────────────────────────────

/**
 * Build the `terrain_*` block for `island_mint.initial_state` from a base
 * grid (typically `TerrainGrid.bakeFromAnalytical()`). The grid is hashed
 * here so the mint flow has a single call site for the metadata.
 */
export async function buildIslandMintTerrainFields(
  baseGrid: TerrainGrid,
): Promise<IslandMintTerrainFields> {
  const terrain_base_grid_hash = await baseGrid.computeBaseGridHash();
  return {
    terrain_seed: DEFAULT_TERRAIN_SEED,
    terrain_base_shape_version: TERRAIN_BASE_SHAPE_VERSION,
    terrain_base_grid_hash,
    grid_w: GRID_W,
    grid_d: GRID_D,
    cell_size: CELL,
    origin_x: TERRAIN_ORIGIN.x,
    origin_z: TERRAIN_ORIGIN.z,
    tier_height: TIER_HEIGHT_METERS,
  };
}

// ─── base64 helpers ────────────────────────────────────────────────────
// btoa / atob are available in browsers and in modern Node (≥16) on globalThis.
// The gzip payload for a 94×78 grid is well under 30 KB, so a simple linear
// encode is fine — no chunking needed for the spec'd save size cap.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
