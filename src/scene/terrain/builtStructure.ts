/**
 * Step 9 — `BuiltStructure` data model + derivation + module registry.
 *
 * A `BuiltStructure` is a player-placed bridge / staircase / incline overlaid
 * on the terrain grid. The serializable shape (id, kind, originCell, rotation,
 * length, width, style) round-trips through `island_save.state.built_structures`
 * per GAME_SPEC.md §2.4 + TERRAFORMING_REFACTO_PLAN.md §3.4. The derived shape
 * (occupiedCells, blockedCells, connectorEdges) is rebuilt at load time from
 * the serialized fields and never persisted — this keeps the save compact and
 * lets the geometry generator evolve without a save migration.
 *
 * Geometry conventions
 * --------------------
 *
 *  - `originCell` is one corner of the footprint. For staircase / incline,
 *    it is the **lower-tier end** so the resolver can derive the tier delta
 *    direction from a single field.
 *  - `rotation` is one of `0|90|180|270` degrees, applied around the origin.
 *    Rotation 0 means "forward" = +X (cells extend toward higher cx).
 *    Rotation 90° (CCW around +Y) means forward = +Z.
 *  - `length` cells extend along the forward axis, `width` along the right
 *    axis (90° CW from forward, i.e. the perpendicular that keeps the
 *    footprint on a single side of the origin instead of straddling it).
 *
 * Kind constraints
 * ----------------
 *
 *  - `staircase`: length=2, width=1. Single connector edge between origin and
 *    origin + forward, bridging a tier delta of ±1.
 *  - `incline`:   length∈[2..3], width=1. Same connector pattern; visually a
 *    ramp instead of stairs (Phase A.5 polish — both behave identically for
 *    the movement resolver).
 *  - `bridge`:    length∈[2..8], width=1. One connector edge per interior
 *    cell pair along the forward axis (a 4-cell bridge has 3 connectors).
 *    Endpoints sit on same-tier LAND; the interior cells span FRESHWATER.
 *
 * `blockedCells` currently equals `occupiedCells` for every kind: while a
 * structure exists, no terrain edit is allowed on any cell of its footprint.
 * Future kinds (e.g. overhangs) may decouple these — keep the field separate
 * so callers don't have to be rewritten when we do.
 */

export type BuiltStructureKind = 'staircase' | 'incline' | 'bridge';

export type Rotation = 0 | 90 | 180 | 270;

export interface Edge {
  /** Lower lexicographic endpoint, by `(cx, cz)`. Ordering is canonical. */
  a: [number, number];
  /** Higher lexicographic endpoint. */
  b: [number, number];
}

/**
 * Serializable on-disk shape per `state.built_structures[i]`. Every field is
 * persisted; nothing else is. Derivation runs at load time via
 * `deriveStructureGeometry()`.
 */
export interface BuiltStructureSerialized {
  /** Stable UUID v4 across saves. Generated client-side at placement time. */
  id: string;
  kind: BuiltStructureKind;
  /** Anchor cell — for staircase / incline, the lower-tier end. */
  originCell: [number, number];
  rotation: Rotation;
  length: number;
  width: number;
  /** Visual variant (wood / stone / brick / …). Validation only checks ≥0. */
  style: number;
}

/** Full in-memory shape: serialized fields + derived geometry caches. */
export interface BuiltStructure extends BuiltStructureSerialized {
  /** Every cell of the footprint, including endpoints. */
  occupiedCells: [number, number][];
  /** Cells where terrain edits (raise/lower/dig/path) are refused. */
  blockedCells: [number, number][];
  /**
   * Adjacent-cell pairs the structure makes traversable beyond what the bare
   * grid allows: tier-delta crossings (staircase / incline) or LAND-LAND over
   * FRESHWATER (bridge). Endpoints are canonical (a < b lexicographically).
   */
  connectorEdges: Edge[];
}

// ─── Rotation helpers ──────────────────────────────────────────────────

/**
 * Forward direction unit step in cell coords for a given rotation.
 *   0°   → +X
 *   90°  → +Z   (rotation is CCW around the world +Y axis)
 *   180° → -X
 *   270° → -Z
 */
export function forwardOf(rotation: Rotation): [number, number] {
  switch (rotation) {
    case 0: return [1, 0];
    case 90: return [0, 1];
    case 180: return [-1, 0];
    case 270: return [0, -1];
  }
}

/**
 * Right direction (90° CW from forward, in cell coords). Width extends along
 * this axis so the footprint sits on one side of the origin without straddling.
 */
export function rightOf(rotation: Rotation): [number, number] {
  switch (rotation) {
    case 0: return [0, -1];
    case 90: return [1, 0];
    case 180: return [0, 1];
    case 270: return [-1, 0];
  }
}

// ─── Kind constraints ──────────────────────────────────────────────────

interface KindConstraints {
  minLength: number;
  maxLength: number;
  minWidth: number;
  maxWidth: number;
}

const KIND_CONSTRAINTS: Record<BuiltStructureKind, KindConstraints> = {
  staircase: { minLength: 2, maxLength: 2, minWidth: 1, maxWidth: 1 },
  incline:   { minLength: 2, maxLength: 3, minWidth: 1, maxWidth: 1 },
  bridge:    { minLength: 2, maxLength: 8, minWidth: 1, maxWidth: 1 },
};

const VALID_ROTATIONS: ReadonlySet<number> = new Set([0, 90, 180, 270]);

// ─── Geometry derivation ───────────────────────────────────────────────

/**
 * Compute `occupiedCells`, `blockedCells`, `connectorEdges` from the
 * serialized fields. Throws on invalid kind/length/width — callers that want
 * non-throwing validation should call `validateStructure()` first.
 */
export function deriveStructureGeometry(
  s: BuiltStructureSerialized,
): BuiltStructure {
  const errs = validateStructureShape(s);
  if (errs.length > 0) {
    throw new Error(`deriveStructureGeometry: invalid structure (${errs.join('; ')})`);
  }

  const [fx, fz] = forwardOf(s.rotation);
  const [rx, rz] = rightOf(s.rotation);
  const [ox, oz] = s.originCell;

  const occupiedCells: [number, number][] = [];
  for (let i = 0; i < s.length; i += 1) {
    for (let j = 0; j < s.width; j += 1) {
      occupiedCells.push([ox + fx * i + rx * j, oz + fz * i + rz * j]);
    }
  }

  const connectorEdges: Edge[] = [];
  // Connector edges run along the forward axis between consecutive footprint
  // cells. For width>1 each row has its own series; v1 only ships width=1 so
  // the inner loop is a no-op for the second axis.
  for (let j = 0; j < s.width; j += 1) {
    for (let i = 0; i < s.length - 1; i += 1) {
      const a: [number, number] = [ox + fx * i + rx * j, oz + fz * i + rz * j];
      const b: [number, number] = [ox + fx * (i + 1) + rx * j, oz + fz * (i + 1) + rz * j];
      connectorEdges.push(canonicalizeEdge(a, b));
    }
  }

  return {
    ...s,
    occupiedCells,
    // `blockedCells` is identical to `occupiedCells` for v1 kinds — see file
    // header. Sliced so callers can mutate one without affecting the other
    // if a future kind needs to decouple them.
    blockedCells: occupiedCells.slice(),
    connectorEdges,
  };
}

function canonicalizeEdge(a: [number, number], b: [number, number]): Edge {
  if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) return { a, b };
  return { a: b, b: a };
}

// ─── Validation ────────────────────────────────────────────────────────

/**
 * Shape-only validation: kind/rotation in enum, length/width in kind range,
 * style ≥ 0, originCell coords are integers. Bounds and overlap checks are
 * separate (they need grid dims and the full structure list).
 */
function validateStructureShape(s: BuiltStructureSerialized): string[] {
  const errors: string[] = [];
  if (typeof s !== 'object' || s === null) {
    errors.push('not an object');
    return errors;
  }
  if (!s.id || typeof s.id !== 'string') errors.push('id missing or not a string');
  if (s.kind !== 'staircase' && s.kind !== 'incline' && s.kind !== 'bridge') {
    errors.push(`unknown kind: ${String(s.kind)}`);
    return errors;
  }
  if (!VALID_ROTATIONS.has(s.rotation)) errors.push(`invalid rotation: ${String(s.rotation)}`);
  if (
    !Array.isArray(s.originCell)
    || s.originCell.length !== 2
    || !Number.isInteger(s.originCell[0])
    || !Number.isInteger(s.originCell[1])
  ) {
    errors.push('originCell must be a [int, int] tuple');
  }
  const c = KIND_CONSTRAINTS[s.kind];
  if (!Number.isInteger(s.length) || s.length < c.minLength || s.length > c.maxLength) {
    errors.push(`length out of range for ${s.kind}: ${s.length} not in [${c.minLength}, ${c.maxLength}]`);
  }
  if (!Number.isInteger(s.width) || s.width < c.minWidth || s.width > c.maxWidth) {
    errors.push(`width out of range for ${s.kind}: ${s.width} not in [${c.minWidth}, ${c.maxWidth}]`);
  }
  if (!Number.isInteger(s.style) || s.style < 0) errors.push('style must be a non-negative integer');
  return errors;
}

/**
 * Full validation against grid dims: shape + every occupied cell in bounds.
 * Empty array iff the structure can be safely materialised.
 */
export function validateStructure(
  s: BuiltStructureSerialized,
  gridW: number,
  gridD: number,
): string[] {
  const shapeErrors = validateStructureShape(s);
  if (shapeErrors.length > 0) return shapeErrors;

  const errors: string[] = [];
  // Shape is valid → derivation is safe.
  const derived = deriveStructureGeometry(s);
  for (const [cx, cz] of derived.occupiedCells) {
    if (cx < 0 || cx >= gridW || cz < 0 || cz >= gridD) {
      errors.push(`cell (${cx}, ${cz}) out of bounds`);
      break; // one out-of-bounds cell is enough — no need to enumerate all
    }
  }
  return errors;
}

/**
 * Bulk validate + materialise a list of serialized structures. Detects:
 *   - per-structure shape / bounds errors
 *   - overlapping `occupiedCells` between any two structures
 *   - duplicate `id`s
 *
 * Returns the structures that passed individual validation, even if some
 * other structures failed (so a partial save can still be loaded). The
 * caller decides whether to surface or refuse.
 */
export function materializeStructures(
  list: BuiltStructureSerialized[],
  gridW: number,
  gridD: number,
): { structures: BuiltStructure[]; errors: string[] } {
  const errors: string[] = [];
  const structures: BuiltStructure[] = [];
  const seenIds = new Set<string>();
  // cellOwner: cellKey ("cx,cz") → id of the structure that occupies it. The
  // first structure to claim a cell wins; subsequent overlaps are reported.
  const cellOwner = new Map<string, string>();

  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    const validationErrors = validateStructure(s, gridW, gridD);
    if (validationErrors.length > 0) {
      errors.push(`structure[${i}] (id=${s?.id ?? '?'}): ${validationErrors.join('; ')}`);
      continue;
    }
    if (seenIds.has(s.id)) {
      errors.push(`structure[${i}]: duplicate id ${s.id}`);
      continue;
    }
    const derived = deriveStructureGeometry(s);
    let overlapped = false;
    for (const [cx, cz] of derived.occupiedCells) {
      const key = `${cx},${cz}`;
      const prev = cellOwner.get(key);
      if (prev) {
        errors.push(`structure[${i}] (id=${s.id}): cell (${cx}, ${cz}) overlaps structure id=${prev}`);
        overlapped = true;
        break;
      }
    }
    if (overlapped) continue;
    for (const [cx, cz] of derived.occupiedCells) {
      cellOwner.set(`${cx},${cz}`, s.id);
    }
    seenIds.add(s.id);
    structures.push(derived);
  }
  return { structures, errors };
}

// ─── Movement / edit predicates (consumed by TerrainGrid + main.ts) ────

/**
 * Returns true iff the two cells are both part of the same structure of the
 * given kinds. Adjacency is the caller's contract — `TerrainGrid.isTraversable`
 * already enforces that the two cells are 8-adjacent before asking. With a
 * width=1 / length≤8 fleet of structures, "share the same structure" is
 * equivalent to "the structure provides a connector between these cells".
 */
export function structureConnects(
  structures: readonly BuiltStructure[],
  fromCx: number,
  fromCz: number,
  toCx: number,
  toCz: number,
  kinds: readonly BuiltStructureKind[],
): boolean {
  for (const s of structures) {
    if (!kinds.includes(s.kind)) continue;
    let hasFrom = false;
    let hasTo = false;
    for (const [cx, cz] of s.occupiedCells) {
      if (cx === fromCx && cz === fromCz) hasFrom = true;
      if (cx === toCx && cz === toCz) hasTo = true;
      if (hasFrom && hasTo) return true;
    }
  }
  return false;
}

/**
 * Returns true iff no structure's `blockedCells` covers the given cell. The
 * terraforming tools (raise / lower / dig / path) call this before applying
 * an edit; a true result is necessary but not sufficient (the kind-specific
 * `canApply` predicate also runs).
 */
export function canEditCellUnderStructures(
  cx: number,
  cz: number,
  structures: readonly BuiltStructure[],
): boolean {
  for (const s of structures) {
    for (const [bx, bz] of s.blockedCells) {
      if (bx === cx && bz === cz) return false;
    }
  }
  return true;
}

// ─── Module registry ───────────────────────────────────────────────────

let _structures: BuiltStructure[] = [];

/** Read-only snapshot of the active structures. */
export function getBuiltStructures(): readonly BuiltStructure[] {
  return _structures;
}

/**
 * Replace the active list from a serialized payload (typically
 * `island_save.state.built_structures`). Returns errors collected by
 * `materializeStructures`; structures that passed validation are installed
 * even if others failed (partial-save tolerance).
 */
export function replaceBuiltStructures(
  list: BuiltStructureSerialized[],
  gridW: number,
  gridD: number,
): { errors: string[] } {
  const result = materializeStructures(list, gridW, gridD);
  _structures = result.structures;
  return { errors: result.errors };
}

/**
 * Append a single structure. Validates against grid dims AND against existing
 * structures (no overlap, no duplicate id). Returns the materialised structure
 * on success, or errors on rejection — the registry is unchanged on rejection.
 */
export function addBuiltStructure(
  s: BuiltStructureSerialized,
  gridW: number,
  gridD: number,
): { structure: BuiltStructure | null; errors: string[] } {
  const combined = [..._structures.map(serializeBuiltStructure), s];
  const result = materializeStructures(combined, gridW, gridD);
  if (result.structures.length !== combined.length) {
    return { structure: null, errors: result.errors };
  }
  _structures = result.structures;
  // The newly-added structure is the last one; pull it out for the caller.
  return { structure: _structures[_structures.length - 1], errors: [] };
}

/** Remove a structure by id. Returns true iff a removal happened. */
export function removeBuiltStructureById(id: string): boolean {
  const before = _structures.length;
  _structures = _structures.filter((s) => s.id !== id);
  return _structures.length < before;
}

/** Test-only hook: forcibly reset the registry. */
export function setBuiltStructuresForTesting(structures: BuiltStructure[]): void {
  _structures = structures.slice();
}

/**
 * Boot-time wrapper around `replaceBuiltStructures` that accepts an unknown
 * payload from `island_save.state.built_structures`. Absent / null / non-array
 * input installs an empty registry (the spec'd "absence semantics" from §3.5).
 *
 * The terrain's `bootTerrain` is its own async orchestrator because gzip and
 * SHA-256 force async; structures are JSON inline so this stays sync.
 */
export function bootBuiltStructures(
  raw: unknown,
  gridW: number,
  gridD: number,
): { errors: string[] } {
  if (raw === undefined || raw === null) {
    replaceBuiltStructures([], gridW, gridD);
    return { errors: [] };
  }
  if (!Array.isArray(raw)) {
    replaceBuiltStructures([], gridW, gridD);
    return { errors: ['built_structures must be an array; installed empty registry'] };
  }
  return replaceBuiltStructures(raw as BuiltStructureSerialized[], gridW, gridD);
}

// ─── Serialization ─────────────────────────────────────────────────────

/** Strip derived fields for save inscription. */
export function serializeBuiltStructure(s: BuiltStructure): BuiltStructureSerialized {
  return {
    id: s.id,
    kind: s.kind,
    originCell: [s.originCell[0], s.originCell[1]],
    rotation: s.rotation,
    length: s.length,
    width: s.width,
    style: s.style,
  };
}

/** Generate a fresh UUID v4 for a new structure. Browser + Node ≥14 native. */
export function newStructureId(): string {
  return crypto.randomUUID();
}
