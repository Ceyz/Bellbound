import { sampleIslandSDF } from '../islandShape';
import { type BuiltStructure, structureConnects } from './builtStructure';

/**
 * Editable AC:NH-style terrain grid backed by 1 byte per cell. The grid is the
 * single source of truth for the playable surface during the terraforming
 * refactor (replaces the analytical heightmap + island SDF).
 *
 * On-disk byte layout (locked spec, see TERRAFORMING_REFACTO_PLAN.md §3.1):
 *   bit 7..6  surface (2 bits, 0..3)  — VOID, OCEAN, LAND, FRESHWATER
 *   bit 5..4  tier    (2 bits, 0..3)  — T0..T3 (T3 visual-only, see plan §1)
 *   bit 3..0  path    (4 bits, 0..15) — 0 = no path, 1..15 = path style
 */

export const TERRAIN_ORIGIN = { x: -47, z: -39 };
export const GRID_W = 94;
export const GRID_D = 78;
export const CELL = 1.0;

/** Spec-locked tier height in meters. Re-evaluate before first public save if too flat. */
export const TIER_HEIGHT_METERS = 1.0;

/**
 * Where the river bed sits relative to its tier top (Y = tier - this).
 * 0.5 m matches the pre-refactor analytical `RIVER_DEPTH`, so Step 2 façade swap
 * keeps the same player-standing height inside freshwater cells. The bed is what
 * `cellHeight()` returns for FRESHWATER cells.
 */
export const FRESHWATER_BED_OFFSET_METERS = 0.5;

/**
 * Where the visible water surface sits relative to its tier top (Y = tier - this).
 * 0.30 m is the v4 D12 spec lock (canyon riverbed look). Used by the freshwater
 * surface mesh builder (Step 6); not used by the grid's `cellHeight()` which
 * reports the bed for player physics.
 */
export const FRESHWATER_SURFACE_OFFSET_METERS = 0.30;

export const Surface = {
  VOID: 0,
  OCEAN: 1,
  LAND: 2,
  FRESHWATER: 3,
} as const;
export type Surface = typeof Surface[keyof typeof Surface];

export const Tier = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
} as const;
export type Tier = typeof Tier[keyof typeof Tier];

export type PathKind = number; // 0..15

export interface TerrainCell {
  surface: Surface;
  tier: Tier;
  path: PathKind;
}

export interface BoundingRect {
  cxMin: number;
  czMin: number;
  cxMax: number; // inclusive
  czMax: number; // inclusive
}

const SURFACE_MASK = 0b11000000;
const TIER_MASK    = 0b00110000;
const PATH_MASK    = 0b00001111;

function packCell(cell: TerrainCell): number {
  return ((cell.surface & 0b11) << 6) | ((cell.tier & 0b11) << 4) | (cell.path & 0b1111);
}

function unpackCell(byte: number): TerrainCell {
  return {
    surface: ((byte & SURFACE_MASK) >>> 6) as Surface,
    tier: ((byte & TIER_MASK) >>> 4) as Tier,
    path: (byte & PATH_MASK) as PathKind,
  };
}

export function tierHeight(t: Tier): number {
  return t * TIER_HEIGHT_METERS;
}

export class TerrainGrid {
  readonly width = GRID_W;
  readonly depth = GRID_D;
  readonly cellSize = CELL;
  readonly originX = TERRAIN_ORIGIN.x;
  readonly originZ = TERRAIN_ORIGIN.z;

  private data: Uint8Array;
  private dirtyRegions: BoundingRect[] = [];

  constructor(data?: Uint8Array) {
    const expected = GRID_W * GRID_D;
    if (data) {
      if (data.length !== expected) {
        throw new Error(`TerrainGrid expects ${expected} bytes, got ${data.length}`);
      }
      this.data = new Uint8Array(data);
    } else {
      this.data = new Uint8Array(expected);
    }
  }

  // ─── Coordinate conversion ─────────────────────────────────────────────

  worldToCell(wx: number, wz: number): [number, number] {
    return [
      Math.floor((wx - this.originX) / this.cellSize),
      Math.floor((wz - this.originZ) / this.cellSize),
    ];
  }

  cellCenterWorld(cx: number, cz: number): [number, number] {
    return [
      this.originX + (cx + 0.5) * this.cellSize,
      this.originZ + (cz + 0.5) * this.cellSize,
    ];
  }

  cellInBounds(cx: number, cz: number): boolean {
    return cx >= 0 && cx < this.width && cz >= 0 && cz < this.depth;
  }

  // ─── Read API ──────────────────────────────────────────────────────────

  getCell(cx: number, cz: number): TerrainCell {
    if (!this.cellInBounds(cx, cz)) {
      return { surface: Surface.VOID, tier: Tier.T0, path: 0 };
    }
    return unpackCell(this.data[cz * this.width + cx]);
  }

  getSurface(cx: number, cz: number): Surface {
    if (!this.cellInBounds(cx, cz)) return Surface.VOID;
    return ((this.data[cz * this.width + cx] & SURFACE_MASK) >>> 6) as Surface;
  }

  getTier(cx: number, cz: number): Tier {
    if (!this.cellInBounds(cx, cz)) return Tier.T0;
    return ((this.data[cz * this.width + cx] & TIER_MASK) >>> 4) as Tier;
  }

  getPath(cx: number, cz: number): PathKind {
    if (!this.cellInBounds(cx, cz)) return 0;
    return this.data[cz * this.width + cx] & PATH_MASK;
  }

  /**
   * Y of the cell's solid surface (LAND) or water surface (OCEAN/FRESHWATER).
   * Returns NaN for VOID.
   */
  cellHeight(cx: number, cz: number): number {
    const cell = this.getCell(cx, cz);
    switch (cell.surface) {
      case Surface.VOID:
        return NaN;
      case Surface.OCEAN:
        return 0;
      case Surface.LAND:
        return tierHeight(cell.tier);
      case Surface.FRESHWATER:
        return tierHeight(cell.tier) - FRESHWATER_BED_OFFSET_METERS;
    }
  }

  /**
   * Y at world (wx, wz). For Step 1 the implementation is a flat lookup of the
   * containing cell. Continuous interpolation across cliff faces lands in Step 3
   * when the mesh builder also wires sloped faces; until then this returns the
   * top of the cell, which is correct for player physics (you stand on the cell
   * top, not on the cliff face).
   */
  sampleHeight(wx: number, wz: number): number {
    const [cx, cz] = this.worldToCell(wx, wz);
    if (!this.cellInBounds(cx, cz)) return 0;
    return this.cellHeight(cx, cz);
  }

  // ─── Edit API ──────────────────────────────────────────────────────────
  // Step 5+ implements the AC rule predicates. Step 1 only ships the data
  // structure, so the editors are stubs that throw — exercising them at this
  // stage is a programmer error.

  raiseCell(_cx: number, _cz: number): EditError | null {
    throw new Error('TerrainGrid.raiseCell: editor not yet implemented (Step 5)');
  }
  lowerCell(_cx: number, _cz: number): EditError | null {
    throw new Error('TerrainGrid.lowerCell: editor not yet implemented (Step 5)');
  }
  digFreshwater(_cx: number, _cz: number): EditError | null {
    throw new Error('TerrainGrid.digFreshwater: editor not yet implemented (Step 6)');
  }
  fillFreshwater(_cx: number, _cz: number): EditError | null {
    throw new Error('TerrainGrid.fillFreshwater: editor not yet implemented (Step 6)');
  }
  paintPath(_cx: number, _cz: number, _kind: PathKind): EditError | null {
    throw new Error('TerrainGrid.paintPath: editor not yet implemented (Step 7)');
  }
  erasePath(_cx: number, _cz: number): EditError | null {
    throw new Error('TerrainGrid.erasePath: editor not yet implemented (Step 7)');
  }

  // ─── Iteration helpers (consumed by Step 3+ mesh builders) ─────────────

  forEachCell(cb: (cx: number, cz: number, cell: TerrainCell) => void): void {
    for (let cz = 0; cz < this.depth; cz += 1) {
      for (let cx = 0; cx < this.width; cx += 1) {
        cb(cx, cz, unpackCell(this.data[cz * this.width + cx]));
      }
    }
  }

  /**
   * Iterates LAND and FRESHWATER cells (the "solid" ground that the player can
   * stand on or that gets carved into a riverbed). Skips OCEAN and VOID.
   * Used by the ground mesh builder in Step 3.
   */
  forEachSolidCell(cb: (cx: number, cz: number, cell: TerrainCell, topY: number) => void): void {
    for (let cz = 0; cz < this.depth; cz += 1) {
      for (let cx = 0; cx < this.width; cx += 1) {
        const cell = unpackCell(this.data[cz * this.width + cx]);
        if (cell.surface === Surface.OCEAN || cell.surface === Surface.VOID) continue;
        cb(cx, cz, cell, this.cellHeight(cx, cz));
      }
    }
  }

  /**
   * Iterates FRESHWATER cells with their water surface Y (= tier top - 0.30 m).
   * Used by the freshwater mesh builder. Ocean cells are emphatically NOT
   * included — the global ocean plane handles them.
   */
  forEachFreshwaterCell(cb: (cx: number, cz: number, cell: TerrainCell, surfaceY: number) => void): void {
    for (let cz = 0; cz < this.depth; cz += 1) {
      for (let cx = 0; cx < this.width; cx += 1) {
        const cell = unpackCell(this.data[cz * this.width + cx]);
        if (cell.surface !== Surface.FRESHWATER) continue;
        const surfaceY = tierHeight(cell.tier) - FRESHWATER_SURFACE_OFFSET_METERS;
        cb(cx, cz, cell, surfaceY);
      }
    }
  }

  /**
   * Iterates every interior grid edge where one side is LAND/FRESHWATER and
   * the other is OCEAN. Yielded values include both the inland cell and the
   * ocean cell so callers can derive midpoints and outward normals.
   *
   * Step 5+ uses this to anchor shore wave / beach wash systems on grid edges
   * (the analytical `sampleShoreAnchors()` was the pre-refactor equivalent;
   * keeping it on a continuous SDF after the visible coastline switched to a
   * 1m grid makes the foam ribbon drift away from the visible shoreline).
   *
   * Edge orientation: dx, dz point FROM inland cell TOWARD the ocean cell
   * (so dx=1, dz=0 means the ocean cell is east of the inland cell).
   */
  forEachLandOceanEdge(cb: (
    inlandCx: number,
    inlandCz: number,
    oceanCx: number,
    oceanCz: number,
    dx: number,
    dz: number,
  ) => void): void {
    for (let cz = 0; cz < this.depth; cz += 1) {
      for (let cx = 0; cx < this.width; cx += 1) {
        const surface = this.getSurface(cx, cz);
        if (surface === Surface.OCEAN || surface === Surface.VOID) continue;

        // East
        if (cx + 1 < this.width && this.getSurface(cx + 1, cz) === Surface.OCEAN) {
          cb(cx, cz, cx + 1, cz, 1, 0);
        }
        // West
        if (cx - 1 >= 0 && this.getSurface(cx - 1, cz) === Surface.OCEAN) {
          cb(cx, cz, cx - 1, cz, -1, 0);
        }
        // North
        if (cz + 1 < this.depth && this.getSurface(cx, cz + 1) === Surface.OCEAN) {
          cb(cx, cz, cx, cz + 1, 0, 1);
        }
        // South
        if (cz - 1 >= 0 && this.getSurface(cx, cz - 1) === Surface.OCEAN) {
          cb(cx, cz, cx, cz - 1, 0, -1);
        }
      }
    }
  }

  /**
   * Iterates every grid edge where the two cells have different `cellHeight()`,
   * yielding a vertical face. Used by the cliff side mesh builder.
   *
   * The callback receives the LOWER cell, the UPPER cell, the world-space edge
   * direction (`dx`, `dz` are 0/±1 from lower toward upper, oriented so the wall
   * face is perpendicular to it), and the height difference (always > 0).
   */
  forEachTierDiscontinuity(cb: (
    lowerCx: number, lowerCz: number,
    upperCx: number, upperCz: number,
    dx: number, dz: number,
    drop: number,
  ) => void): void {
    // 4-neighbor iteration: each interior edge is visited once via the LOWER cell.
    for (let cz = 0; cz < this.depth; cz += 1) {
      for (let cx = 0; cx < this.width; cx += 1) {
        const myH = this.cellHeight(cx, cz);
        if (Number.isNaN(myH)) continue; // VOID cells have no edge

        // East neighbor
        if (cx + 1 < this.width) {
          const nH = this.cellHeight(cx + 1, cz);
          if (!Number.isNaN(nH)) {
            if (myH < nH) cb(cx, cz, cx + 1, cz, 1, 0, nH - myH);
            else if (nH < myH) cb(cx + 1, cz, cx, cz, -1, 0, myH - nH);
          }
        }

        // North neighbor
        if (cz + 1 < this.depth) {
          const nH = this.cellHeight(cx, cz + 1);
          if (!Number.isNaN(nH)) {
            if (myH < nH) cb(cx, cz, cx, cz + 1, 0, 1, nH - myH);
            else if (nH < myH) cb(cx, cz + 1, cx, cz, 0, -1, myH - nH);
          }
        }
      }
    }
  }

  // ─── Movement traversal predicate (Step 4) ─────────────────────────────

  /**
   * Decides whether a player can move from `fromCell` to `toCell` in one step.
   *
   *   - same cell                                  → OK
   *   - non-adjacent cells (|Δx| > 1 or |Δz| > 1)  → blocked (per-step contract)
   *   - either side out of bounds                  → blocked
   *   - target is VOID or OCEAN                    → blocked
   *   - target is FRESHWATER                       → blocked unless a bridge
   *                                                  structure connects both cells
   *   - source is FRESHWATER (player escaping water) → OK
   *   - same-tier LAND → LAND                      → OK
   *   - different-tier LAND → LAND                 → blocked unless a staircase
   *                                                  or incline structure
   *                                                  connects both cells
   *
   * **Contract**: callers must pass 8-adjacent cells (4-cardinal + 4-diagonal)
   * or the same cell. Hops > 1 in either axis are rejected so the resolver
   * can't be tricked into approving a path that skips across an intervening
   * blocked cell. The 8-adjacency relaxation (vs strict 4-cardinal) is needed
   * so the player's body probes — which sample cardinal AND diagonal points at
   * `PLAYER_COLLISION_RADIUS` — can ask about diagonal cells when the player
   * is near a cell corner. Pathfinding callers should still walk one cell at
   * a time and treat each diagonal as two cardinal steps if they need to
   * verify the L-corner is not blocked.
   *
   * Step 4 ships with `structures` always empty (the player can't yet place
   * bridges or staircases — those land in Step 9), so this resolver effectively
   * locks the player to their starting tier and bans water entry. That matches
   * the post-Step-0 scene cleanup: the original bridge + staircase meshes were
   * removed, so cliff and river are intentionally inaccessible until Step 9
   * brings the placement tools online.
   */
  isTraversable(
    fromCx: number,
    fromCz: number,
    toCx: number,
    toCz: number,
    structures: readonly BuiltStructure[] = [],
  ): boolean {
    if (fromCx === toCx && fromCz === toCz) return true;

    // Adjacency guard — see the contract note above. 8-adjacency: |Δx| ≤ 1
    // AND |Δz| ≤ 1. Multi-cell hops are rejected so a single call can't approve
    // a path that skips across a blocked cell.
    const dx = Math.abs(toCx - fromCx);
    const dz = Math.abs(toCz - fromCz);
    if (dx > 1 || dz > 1) return false;

    if (!this.cellInBounds(fromCx, fromCz)) return false;
    if (!this.cellInBounds(toCx, toCz)) return false;

    const toSurface = this.getSurface(toCx, toCz);
    if (toSurface === Surface.VOID || toSurface === Surface.OCEAN) return false;

    const fromSurface = this.getSurface(fromCx, fromCz);

    if (toSurface === Surface.FRESHWATER) {
      return structureConnects(structures, fromCx, fromCz, toCx, toCz, ['bridge']);
    }

    // Target is LAND from here on.
    if (fromSurface === Surface.FRESHWATER) return true;

    const fromTier = this.getTier(fromCx, fromCz);
    const toTier = this.getTier(toCx, toCz);
    if (fromTier === toTier) return true;

    return structureConnects(structures, fromCx, fromCz, toCx, toCz, ['staircase', 'incline']);
  }

  // ─── Dirty rect tracking (used by Step 3+ for partial mesh/texture rebuild) ─

  markDirty(rect: BoundingRect): void {
    this.dirtyRegions.push(rect);
  }

  consumeDirtyRegions(): BoundingRect[] {
    const regions = this.dirtyRegions;
    this.dirtyRegions = [];
    return regions;
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  /** Raw packed bytes, length = GRID_W * GRID_D = 7332. */
  serialize(): Uint8Array {
    return new Uint8Array(this.data);
  }

  static deserialize(bytes: Uint8Array): TerrainGrid {
    return new TerrainGrid(bytes);
  }

  /** Gzip-compressed bytes via CompressionStream (browser-native). */
  async serializeCompressed(): Promise<Uint8Array> {
    return gzipBytes(this.data);
  }

  static async deserializeCompressed(bytes: Uint8Array): Promise<TerrainGrid> {
    const raw = await gunzipBytes(bytes);
    return new TerrainGrid(raw);
  }

  /**
   * sha256 hex of the raw packed bytes. Used for `terrain_base_grid_hash`
   * in `island_mint` to detect generator drift across versions.
   */
  async computeBaseGridHash(): Promise<string> {
    const fresh = new Uint8Array(this.data).buffer;
    const buf = await crypto.subtle.digest('SHA-256', fresh);
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return hex;
  }

  // ─── Bake from current analytical heightmap ────────────────────────────

  /**
   * Fills the grid from the current analytical heightmap functions
   * (`sampleIslandShape`, `isInRiver`, `isOnCliff`). This is the bridge
   * between Step 1 (data model) and Step 2 (façade swap) — the bake
   * captures the current scene's shape into a deterministic grid that
   * Step 3 will use to drive the mesh.
   *
   * Surface mapping:
   *   off-island                    → OCEAN tier 0
   *   on-island && in river         → FRESHWATER tier 0
   *   on-island && on cliff plateau → LAND tier 1
   *   on-island, otherwise          → LAND tier 0
   * Path is always 0 (the hardcoded paths to house/shop were removed during
   * Step 0 cleanup; players paint paths themselves once Step 7 ships).
   */
  static bakeFromAnalytical(): TerrainGrid {
    const grid = new TerrainGrid();
    for (let cz = 0; cz < GRID_D; cz += 1) {
      for (let cx = 0; cx < GRID_W; cx += 1) {
        const wx = TERRAIN_ORIGIN.x + (cx + 0.5) * CELL;
        const wz = TERRAIN_ORIGIN.z + (cz + 0.5) * CELL;
        const cell = classifyAnalyticalCell(wx, wz);
        grid.data[cz * GRID_W + cx] = packCell(cell);
      }
    }
    return grid;
  }
}

// Analytical river / cliff predicates for the seed bake. These are duplicated
// from the pre-refactor heightmap.ts so the grid bake does not depend on the
// (now-grid-driven) heightmap façade — that would be a circular import. Once
// the grid is fully player-driven (Step 5+) this seed code can be retired or
// kept as a "new island" generator for the `terrain_seed` mint flow.
const SEED_CLIFF_X_MIN = -27;
const SEED_CLIFF_X_MAX = -10;
const SEED_CLIFF_Z_MIN = -21;
const SEED_CLIFF_Z_MAX = -8;
const SEED_RIVER_X_MIN = -28;
const SEED_RIVER_X_MAX = 28;
const SEED_RIVER_Z_MIN = -22;
const SEED_RIVER_Z_MAX = 22;
const SEED_RIVER_HALF_WIDTH = 1.8;

function seedRiverCenterZ(wx: number): number {
  return 5 + 6 * Math.sin(wx * 0.08);
}

function seedIsInRiver(wx: number, wz: number): boolean {
  if (wx < SEED_RIVER_X_MIN || wx > SEED_RIVER_X_MAX) return false;
  if (wz < SEED_RIVER_Z_MIN || wz > SEED_RIVER_Z_MAX) return false;
  return Math.abs(wz - seedRiverCenterZ(wx)) < SEED_RIVER_HALF_WIDTH;
}

function seedIsOnCliff(wx: number, wz: number): boolean {
  return (
    wx >= SEED_CLIFF_X_MIN
    && wx < SEED_CLIFF_X_MAX
    && wz >= SEED_CLIFF_Z_MIN
    && wz < SEED_CLIFF_Z_MAX
  );
}

function classifyAnalyticalCell(wx: number, wz: number): TerrainCell {
  if (sampleIslandSDF(wx, wz) > 0) {
    return { surface: Surface.OCEAN, tier: Tier.T0, path: 0 };
  }
  if (seedIsInRiver(wx, wz)) {
    return { surface: Surface.FRESHWATER, tier: Tier.T0, path: 0 };
  }
  if (seedIsOnCliff(wx, wz)) {
    return { surface: Surface.LAND, tier: Tier.T1, path: 0 };
  }
  return { surface: Surface.LAND, tier: Tier.T0, path: 0 };
}

// ─── Edit error type ─────────────────────────────────────────────────────

export interface EditError {
  reason: string;
}

// ─── CompressionStream helpers ───────────────────────────────────────────
// CompressionStream is browser-native and available in modern Node (≥18).

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const fresh = new Uint8Array(input);
  const stream = new Blob([fresh.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const fresh = new Uint8Array(input);
  const stream = new Blob([fresh.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ─── Singleton ───────────────────────────────────────────────────────────
// Step 2 swap: heightmap.ts and islandShape.ts read from this grid instead of
// the previous analytical predicates. The grid is baked once at module load
// from the analytical functions; future steps will allow runtime mutation
// (terraforming edits) and replace this lazy singleton with a save-driven
// instance loaded from `island_save.state.terrain`.

let _singleton: TerrainGrid | null = null;

export function getTerrainGrid(): TerrainGrid {
  if (!_singleton) {
    _singleton = TerrainGrid.bakeFromAnalytical();
  }
  return _singleton;
}

/** Test-only hook: replace the singleton with a custom grid for fixtures. */
export function setTerrainGridForTesting(grid: TerrainGrid | null): void {
  _singleton = grid;
}
