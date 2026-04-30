/**
 * Built structures placed on top of the terrain grid (Step 4 minimal shape).
 *
 * A `BuiltStructure` represents a player-placed bridge, staircase, or incline
 * that lets the player traverse between cells the grid would otherwise block:
 *
 *  - `staircase` / `incline`: connects a LAND cell at tier T to an adjacent
 *    LAND cell at tier T±1.
 *  - `bridge`: connects a same-tier LAND cell to another LAND cell across one
 *    or more FRESHWATER cells in between (the bridge spans the water).
 *
 * Step 4 only needs `kind` and `cells` for the movement resolver to ask
 * "do these two cells share a structure that lets me cross?". Step 9 expands
 * the interface with `id`, `originCell`, `rotation`, `length`, `width`, `style`
 * (serializable) plus derived `occupiedCells` / `blockedCells` / `connectorEdges`,
 * matching plan §3.4. Until then, no structures are ever placed — the array
 * is always empty in Step 4 — but the API surface is in place so Step 5
 * placement tools and Step 9 serialization slot in cleanly.
 */

export type BuiltStructureKind = 'staircase' | 'incline' | 'bridge';

export interface BuiltStructure {
  /** Stable id (UUID v4 in Step 9). Optional in Step 4. */
  id?: string;
  kind: BuiltStructureKind;
  /** Cells the structure occupies. For a 1×2 staircase: [[lower], [upper]]. */
  cells: [number, number][];
}

/** Returns true if the two cells are both part of the same structure of the given kinds. */
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
    for (const [cx, cz] of s.cells) {
      if (cx === fromCx && cz === fromCz) hasFrom = true;
      if (cx === toCx && cz === toCz) hasTo = true;
      if (hasFrom && hasTo) return true;
    }
  }
  return false;
}
