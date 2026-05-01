import * as THREE from 'three';
import {
  CELL,
  TERRAIN_ORIGIN,
} from './terrain/TerrainGrid';
import {
  forwardOf,
  type BuiltStructure,
} from './terrain/builtStructure';

/**
 * Step 9.2 / 9.4 — built-structure mesh syncer.
 *
 * One Group child per placed structure, rebuilt on every sync (the structure
 * set changes infrequently — placement / removal — so a full rebuild is
 * cheaper than diffing). Per-kind builders:
 *
 *   - `bridge`           → flat plank flush with the LAND tier top, spanning
 *                          length cells (water cells visible underneath).
 *   - `staircase` /      → simple gray (staircase) / tan (incline) block
 *     `incline`            spanning the two-cell footprint from the lower
 *                          tier to the upper tier. v1 minimum: differentiated
 *                          by colour only. Stepped silhouette / sloped wedge
 *                          land in a polish pass once layout is locked.
 *
 * Y-override for the player walking on a structure lives in main.ts: bridges
 * use the deck top, tiered structures rely on the underlying LAND tier of
 * each cell (no override needed because the cells are already LAND at their
 * respective tiers on the grid).
 */

const DECK_THICKNESS = 0.06;
const BRIDGE_DECK_COLOR = 0x9b6e3f;
const STAIRCASE_COLOR = 0x9a9a9a;
const INCLINE_COLOR = 0xb88a55;

let _deckGeometryCache: THREE.BoxGeometry | null = null;

/** Lazily-built unit-cube geometry shared by every box mesh. */
function unitDeckGeometry(): THREE.BoxGeometry {
  if (!_deckGeometryCache) {
    _deckGeometryCache = new THREE.BoxGeometry(1, 1, 1);
  }
  return _deckGeometryCache;
}

/**
 * Build a single bridge deck mesh. Same-tier endpoints mean a single deck
 * height — no slope.
 */
function buildBridgeMesh(
  s: BuiltStructure,
  gridSampleTierTop: (cx: number, cz: number) => number,
): THREE.Mesh {
  const [fx, fz] = forwardOf(s.rotation);
  const [originCx, originCz] = s.originCell;

  const midI = (s.length - 1) / 2;
  const centerCx = originCx + fx * midI;
  const centerCz = originCz + fz * midI;
  const wx = TERRAIN_ORIGIN.x + (centerCx + 0.5) * CELL;
  const wz = TERRAIN_ORIGIN.z + (centerCz + 0.5) * CELL;

  const length = s.length * CELL;
  const width = s.width * CELL;
  const mesh = new THREE.Mesh(
    unitDeckGeometry(),
    new THREE.MeshStandardMaterial({
      color: BRIDGE_DECK_COLOR,
      roughness: 0.85,
      metalness: 0,
    }),
  );
  mesh.name = `bridge-deck-${s.id}`;
  mesh.rotation.y = -((s.rotation * Math.PI) / 180);
  mesh.scale.set(length, DECK_THICKNESS, width);
  // Endpoints share a tier — top of deck flush with the LAND tier top.
  const tierTop = gridSampleTierTop(originCx, originCz);
  mesh.position.set(wx, tierTop - DECK_THICKNESS * 0.5, wz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Build a tiered (staircase / incline) mesh. v1 minimum: a single solid box
 * spanning the two-cell footprint from the lower tier to the upper tier.
 * Top face is flush with the upper tier so it visually fills the cliff face
 * the player would otherwise face. Stepped vs sloped geometry differentiation
 * lands in a polish pass — for v1 they share the box and differ only by
 * colour (staircase = gray, incline = tan).
 */
function buildTieredMesh(
  s: BuiltStructure,
  gridSampleTierTop: (cx: number, cz: number) => number,
): THREE.Mesh {
  const [fx, fz] = forwardOf(s.rotation);
  const [originCx, originCz] = s.originCell;
  const upperCx = originCx + fx;
  const upperCz = originCz + fz;

  const oWx = TERRAIN_ORIGIN.x + (originCx + 0.5) * CELL;
  const oWz = TERRAIN_ORIGIN.z + (originCz + 0.5) * CELL;
  const uWx = TERRAIN_ORIGIN.x + (upperCx + 0.5) * CELL;
  const uWz = TERRAIN_ORIGIN.z + (upperCz + 0.5) * CELL;
  const centerWx = (oWx + uWx) * 0.5;
  const centerWz = (oWz + uWz) * 0.5;

  const tierLower = gridSampleTierTop(originCx, originCz);
  const tierUpper = gridSampleTierTop(upperCx, upperCz);
  // Placement enforces tierUpper - tierLower == 1, but be defensive against
  // grid edits adjacent to the structure (which the gate prevents anyway,
  // but a structure loaded from a save could in theory carry a stale tier).
  const height = Math.max(0.05, tierUpper - tierLower);

  const length = 2 * CELL;
  const width = s.width * CELL;
  const color = s.kind === 'staircase' ? STAIRCASE_COLOR : INCLINE_COLOR;

  const mesh = new THREE.Mesh(
    unitDeckGeometry(),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.9,
      metalness: 0,
    }),
  );
  mesh.name = `${s.kind}-block-${s.id}`;
  mesh.rotation.y = -((s.rotation * Math.PI) / 180);
  mesh.scale.set(length, height, width);
  // Bottom face at lower tier, top face at upper tier.
  mesh.position.set(centerWx, tierLower + height * 0.5, centerWz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Replace the contents of `group` with one mesh per structure, dispatching
 * to the right per-kind builder. `gridSampleTierTop` resolves cell heights
 * from the live grid so meshes follow terraform edits.
 */
export function syncStructureMeshes(
  group: THREE.Group,
  structures: readonly BuiltStructure[],
  gridSampleTierTop: (cx: number, cz: number) => number,
): void {
  for (const child of group.children) {
    if ((child as THREE.Mesh).material) {
      const m = (child as THREE.Mesh).material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m.dispose();
    }
  }
  group.clear();

  for (const s of structures) {
    let mesh: THREE.Mesh;
    if (s.kind === 'bridge') {
      mesh = buildBridgeMesh(s, gridSampleTierTop);
    } else if (s.kind === 'staircase' || s.kind === 'incline') {
      mesh = buildTieredMesh(s, gridSampleTierTop);
    } else {
      continue;
    }
    group.add(mesh);
  }
}
