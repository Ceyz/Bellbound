import { afterEach, describe, expect, it } from 'vitest';
import {
  addBuiltStructure,
  bootBuiltStructures,
  canEditCellUnderStructures,
  deriveStructureGeometry,
  forwardOf,
  getBuiltStructures,
  materializeStructures,
  newStructureId,
  removeBuiltStructureById,
  replaceBuiltStructures,
  rightOf,
  serializeBuiltStructure,
  setBuiltStructuresForTesting,
  structureConnects,
  validateStructure,
  type BuiltStructureSerialized,
} from '../src/scene/terrain/builtStructure';
import { GRID_D, GRID_W } from '../src/scene/terrain/TerrainGrid';

afterEach(() => {
  setBuiltStructuresForTesting([]);
});

const W = GRID_W;
const D = GRID_D;

function ser(
  partial: Partial<BuiltStructureSerialized> & Pick<BuiltStructureSerialized, 'kind' | 'originCell'>,
): BuiltStructureSerialized {
  return {
    id: partial.id ?? `test-${partial.kind}-${partial.originCell[0]}-${partial.originCell[1]}`,
    kind: partial.kind,
    originCell: partial.originCell,
    rotation: partial.rotation ?? 0,
    length: partial.length ?? 2,
    width: partial.width ?? 1,
    style: partial.style ?? 0,
  };
}

// ─── Rotation helpers ──────────────────────────────────────────────────

describe('builtStructure — forwardOf / rightOf', () => {
  it('forwardOf points along +X / +Z / -X / -Z for the 4 rotations', () => {
    expect(forwardOf(0)).toEqual([1, 0]);
    expect(forwardOf(90)).toEqual([0, 1]);
    expect(forwardOf(180)).toEqual([-1, 0]);
    expect(forwardOf(270)).toEqual([0, -1]);
  });

  it('rightOf is forward rotated 90° CW (forward × right is +Y in three.js cell coords)', () => {
    // Right is forward × -Y (cz axis in cell space is the world +Z axis flipped
    // when rotating CCW). Spec: rightOf(0) = -Z so the footprint extends toward
    // smaller cz with width>1, keeping the origin at "lower-left pre-rotation".
    expect(rightOf(0)).toEqual([0, -1]);
    expect(rightOf(90)).toEqual([1, 0]);
    expect(rightOf(180)).toEqual([0, 1]);
    expect(rightOf(270)).toEqual([-1, 0]);
  });
});

// ─── deriveStructureGeometry ───────────────────────────────────────────

describe('builtStructure — deriveStructureGeometry', () => {
  it('1×2 staircase rotation 0 occupies origin and origin+(1,0)', () => {
    const s = deriveStructureGeometry(ser({ kind: 'staircase', originCell: [10, 20] }));
    expect(s.occupiedCells).toEqual([[10, 20], [11, 20]]);
    expect(s.connectorEdges).toHaveLength(1);
    expect(s.connectorEdges[0]).toEqual({ a: [10, 20], b: [11, 20] });
  });

  it('1×2 staircase rotation 90 occupies origin and origin+(0,1)', () => {
    const s = deriveStructureGeometry(ser({ kind: 'staircase', originCell: [10, 20], rotation: 90 }));
    expect(s.occupiedCells).toEqual([[10, 20], [10, 21]]);
    expect(s.connectorEdges[0]).toEqual({ a: [10, 20], b: [10, 21] });
  });

  it('1×2 staircase rotation 180 occupies origin and origin-(1,0)', () => {
    const s = deriveStructureGeometry(ser({ kind: 'staircase', originCell: [10, 20], rotation: 180 }));
    expect(s.occupiedCells).toEqual([[10, 20], [9, 20]]);
  });

  it('1×2 staircase rotation 270 occupies origin and origin-(0,1)', () => {
    const s = deriveStructureGeometry(ser({ kind: 'staircase', originCell: [10, 20], rotation: 270 }));
    expect(s.occupiedCells).toEqual([[10, 20], [10, 19]]);
  });

  it('1×4 bridge rotation 0 occupies 4 cells with 3 connector edges', () => {
    const s = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [5, 5], length: 4 }));
    expect(s.occupiedCells).toEqual([[5, 5], [6, 5], [7, 5], [8, 5]]);
    expect(s.connectorEdges).toHaveLength(3);
    expect(s.connectorEdges[0]).toEqual({ a: [5, 5], b: [6, 5] });
    expect(s.connectorEdges[2]).toEqual({ a: [7, 5], b: [8, 5] });
  });

  it('blockedCells equals occupiedCells but is a distinct array (callers may mutate)', () => {
    const s = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [5, 5], length: 3 }));
    expect(s.blockedCells).toEqual(s.occupiedCells);
    expect(s.blockedCells).not.toBe(s.occupiedCells);
  });

  it('throws on invalid kind', () => {
    expect(() =>
      deriveStructureGeometry({ ...ser({ kind: 'staircase', originCell: [0, 0] }), kind: 'foo' as 'staircase' }),
    ).toThrow(/unknown kind/);
  });

  it('throws on length out of range for kind', () => {
    expect(() =>
      deriveStructureGeometry(ser({ kind: 'staircase', originCell: [0, 0], length: 3 })),
    ).toThrow(/length out of range/);
  });
});

// ─── validateStructure ─────────────────────────────────────────────────

describe('builtStructure — validateStructure', () => {
  it('returns no errors for a valid in-bounds structure', () => {
    expect(validateStructure(ser({ kind: 'staircase', originCell: [10, 20] }), W, D)).toEqual([]);
  });

  it('reports out-of-bounds occupied cells', () => {
    const s = ser({ kind: 'bridge', originCell: [W - 1, 5], length: 4 });
    const errors = validateStructure(s, W, D);
    expect(errors[0]).toMatch(/out of bounds/);
  });

  it('reports invalid rotation', () => {
    const s = { ...ser({ kind: 'staircase', originCell: [0, 0] }), rotation: 45 as 0 };
    const errors = validateStructure(s, W, D);
    expect(errors[0]).toMatch(/invalid rotation/);
  });

  it('reports missing id', () => {
    const s = { ...ser({ kind: 'staircase', originCell: [0, 0] }), id: '' };
    expect(validateStructure(s, W, D)[0]).toMatch(/id/);
  });

  it('reports invalid bridge length (incline limits do not apply to bridges)', () => {
    const s = ser({ kind: 'bridge', originCell: [5, 5], length: 9 });
    expect(validateStructure(s, W, D)[0]).toMatch(/length out of range/);
  });

  it('reports invalid incline length (max 3)', () => {
    expect(validateStructure(ser({ kind: 'incline', originCell: [5, 5], length: 4 }), W, D)[0])
      .toMatch(/length out of range/);
    expect(validateStructure(ser({ kind: 'incline', originCell: [5, 5], length: 3 }), W, D))
      .toEqual([]);
  });
});

// ─── materializeStructures ─────────────────────────────────────────────

describe('builtStructure — materializeStructures', () => {
  it('materialises all valid structures', () => {
    const list = [
      ser({ kind: 'staircase', originCell: [10, 20] }),
      ser({ kind: 'bridge', originCell: [30, 40], length: 4 }),
    ];
    const result = materializeStructures(list, W, D);
    expect(result.errors).toEqual([]);
    expect(result.structures).toHaveLength(2);
  });

  it('rejects overlapping structures but keeps the first; errors mention the loser', () => {
    const list = [
      ser({ kind: 'staircase', originCell: [10, 20], id: 'a' }),
      ser({ kind: 'staircase', originCell: [10, 20], id: 'b' }), // exact same cells
    ];
    const result = materializeStructures(list, W, D);
    expect(result.structures).toHaveLength(1);
    expect(result.structures[0].id).toBe('a');
    expect(result.errors[0]).toMatch(/id=b.*overlaps structure id=a/);
  });

  it('rejects duplicate ids', () => {
    const list = [
      ser({ kind: 'staircase', originCell: [10, 20], id: 'shared' }),
      ser({ kind: 'staircase', originCell: [40, 50], id: 'shared' }),
    ];
    const result = materializeStructures(list, W, D);
    expect(result.structures).toHaveLength(1);
    expect(result.errors[0]).toMatch(/duplicate id/);
  });

  it('partial-save tolerance: invalid item skipped, valid items installed', () => {
    const list = [
      ser({ kind: 'staircase', originCell: [10, 20], id: 'a' }),
      { ...ser({ kind: 'bridge', originCell: [5, 5] }), length: 99 }, // invalid
      ser({ kind: 'bridge', originCell: [40, 50], length: 3, id: 'c' }),
    ];
    const result = materializeStructures(list, W, D);
    expect(result.structures.map((s) => s.id)).toEqual(['a', 'c']);
    expect(result.errors[0]).toMatch(/length out of range/);
  });
});

// ─── structureConnects ─────────────────────────────────────────────────

describe('builtStructure — structureConnects', () => {
  it('returns true for two cells of the same matching-kind structure', () => {
    const bridge = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [10, 5], length: 3 }));
    expect(structureConnects([bridge], 10, 5, 11, 5, ['bridge'])).toBe(true);
    expect(structureConnects([bridge], 10, 5, 12, 5, ['bridge'])).toBe(true);
  });

  it('returns false when kind filter excludes the only matching structure', () => {
    const bridge = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [10, 5], length: 2 }));
    expect(structureConnects([bridge], 10, 5, 11, 5, ['staircase', 'incline'])).toBe(false);
  });

  it('returns false when one of the cells is outside the structure', () => {
    const bridge = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [10, 5], length: 2 }));
    expect(structureConnects([bridge], 10, 5, 11, 6, ['bridge'])).toBe(false);
  });
});

// ─── canEditCellUnderStructures ────────────────────────────────────────

describe('builtStructure — canEditCellUnderStructures', () => {
  it('true on a cell not covered by any structure', () => {
    const s = deriveStructureGeometry(ser({ kind: 'staircase', originCell: [10, 20] }));
    expect(canEditCellUnderStructures(50, 50, [s])).toBe(true);
  });

  it('false on a cell covered by a structure', () => {
    const s = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [10, 5], length: 4 }));
    expect(canEditCellUnderStructures(10, 5, [s])).toBe(false);
    expect(canEditCellUnderStructures(13, 5, [s])).toBe(false);
  });

  it('true on cell adjacent to but outside a structure', () => {
    const s = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [10, 5], length: 2 }));
    expect(canEditCellUnderStructures(10, 6, [s])).toBe(true);
    expect(canEditCellUnderStructures(12, 5, [s])).toBe(true);
  });
});

// ─── Registry ──────────────────────────────────────────────────────────

describe('builtStructure — registry', () => {
  it('starts with an empty list per the test reset hook', () => {
    expect(getBuiltStructures()).toEqual([]);
  });

  it('replaceBuiltStructures swaps content and reports errors', () => {
    const result = replaceBuiltStructures(
      [ser({ kind: 'staircase', originCell: [10, 20] })],
      W, D,
    );
    expect(result.errors).toEqual([]);
    expect(getBuiltStructures()).toHaveLength(1);
  });

  it('addBuiltStructure rejects overlap, leaving registry unchanged', () => {
    replaceBuiltStructures([ser({ kind: 'staircase', originCell: [10, 20], id: 'a' })], W, D);
    const before = getBuiltStructures().slice();
    const result = addBuiltStructure(
      ser({ kind: 'staircase', originCell: [10, 20], id: 'b' }),
      W, D,
    );
    expect(result.structure).toBeNull();
    expect(result.errors[0]).toMatch(/overlaps/);
    expect(getBuiltStructures()).toEqual(before);
  });

  it('addBuiltStructure installs a valid non-overlapping structure', () => {
    const result = addBuiltStructure(
      ser({ kind: 'staircase', originCell: [10, 20], id: 'a' }),
      W, D,
    );
    expect(result.structure).not.toBeNull();
    expect(result.errors).toEqual([]);
    expect(getBuiltStructures()).toHaveLength(1);
  });

  it('removeBuiltStructureById removes by id and returns true; false on miss', () => {
    addBuiltStructure(ser({ kind: 'staircase', originCell: [10, 20], id: 'target' }), W, D);
    addBuiltStructure(ser({ kind: 'bridge', originCell: [40, 30], length: 3, id: 'keep' }), W, D);
    expect(removeBuiltStructureById('target')).toBe(true);
    expect(getBuiltStructures().map((s) => s.id)).toEqual(['keep']);
    expect(removeBuiltStructureById('nonexistent')).toBe(false);
  });

  it('newStructureId produces UUID v4-shaped strings', () => {
    const id = newStructureId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ─── bootBuiltStructures ───────────────────────────────────────────────

describe('builtStructure — bootBuiltStructures', () => {
  it('null / undefined input installs an empty registry without errors', () => {
    addBuiltStructure(ser({ kind: 'staircase', originCell: [10, 20] }), W, D);
    expect(bootBuiltStructures(undefined, W, D).errors).toEqual([]);
    expect(getBuiltStructures()).toEqual([]);
    addBuiltStructure(ser({ kind: 'staircase', originCell: [10, 20] }), W, D);
    expect(bootBuiltStructures(null, W, D).errors).toEqual([]);
    expect(getBuiltStructures()).toEqual([]);
  });

  it('non-array input installs empty registry with a clear error', () => {
    const result = bootBuiltStructures({ not: 'an array' }, W, D);
    expect(result.errors[0]).toMatch(/must be an array/);
    expect(getBuiltStructures()).toEqual([]);
  });

  it('valid array materialises into the registry', () => {
    const result = bootBuiltStructures(
      [ser({ kind: 'staircase', originCell: [10, 20] })],
      W, D,
    );
    expect(result.errors).toEqual([]);
    expect(getBuiltStructures()).toHaveLength(1);
  });
});

// ─── serializeBuiltStructure ───────────────────────────────────────────

describe('builtStructure — serialize round-trip', () => {
  it('strips derived fields on serialize', () => {
    const original = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [5, 5], length: 4 }));
    const stripped = serializeBuiltStructure(original);
    expect(stripped).toEqual({
      id: original.id,
      kind: 'bridge',
      originCell: [5, 5],
      rotation: 0,
      length: 4,
      width: 1,
      style: 0,
    });
    expect((stripped as { occupiedCells?: unknown }).occupiedCells).toBeUndefined();
  });

  it('round-trip via serialize -> materializeStructures yields equivalent geometry', () => {
    const original = deriveStructureGeometry(ser({ kind: 'bridge', originCell: [5, 5], length: 4 }));
    const stripped = serializeBuiltStructure(original);
    const result = materializeStructures([stripped], W, D);
    expect(result.errors).toEqual([]);
    expect(result.structures[0].occupiedCells).toEqual(original.occupiedCells);
    expect(result.structures[0].connectorEdges).toEqual(original.connectorEdges);
  });
});
