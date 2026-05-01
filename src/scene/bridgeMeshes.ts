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
 * Step 9.2 — minimal bridge deck visualisation.
 *
 * One Group child per bridge structure, rebuilt on every sync (the bridge set
 * changes infrequently — placement / removal — so a full rebuild is cheaper
 * than diffing). The mesh is a flat plank centred on the bridge footprint:
 *   - length × cellSize along forward
 *   - 1 × cellSize along right (width=1)
 *   - 0.06 m thick, painted wood-brown
 *   - Y = endpoint LAND tier top + a thin ceiling above the water surface so
 *     the deck reads as floating just above the river rather than under it.
 *
 * Style variants (oak / dark wood / stone) and railings land in 9.2 polish or
 * the cosmetic system. Y-override for the player walking on the deck lands in
 * Step 9.3; for now this is purely decorative.
 */

const DECK_THICKNESS = 0.06;
const DECK_COLOR = 0x9b6e3f;

let _deckGeometryCache: THREE.BoxGeometry | null = null;

/** Lazily-built unit-cube geometry shared by every deck mesh. */
function unitDeckGeometry(): THREE.BoxGeometry {
  if (!_deckGeometryCache) {
    _deckGeometryCache = new THREE.BoxGeometry(1, 1, 1);
  }
  return _deckGeometryCache;
}

/**
 * Build a single bridge deck mesh from the structure's serialized geometry.
 * The mesh sits at the right Y for the bridge's endpoints (same-tier LAND
 * means a single deck height — no slope).
 */
function buildBridgeMesh(s: BuiltStructure): THREE.Mesh {
  const [fx, fz] = forwardOf(s.rotation);
  const [originCx, originCz] = s.originCell;

  // Deck centre = midpoint of the footprint along forward.
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
      color: DECK_COLOR,
      roughness: 0.85,
      metalness: 0,
    }),
  );
  mesh.name = `bridge-deck-${s.id}`;

  // Rotate to align the unit cube's +X with the bridge's forward axis. For
  // rotation 0 this is identity; for 90/180/270 we rotate around +Y.
  mesh.rotation.y = -((s.rotation * Math.PI) / 180);
  // Scale: the cube's +X axis becomes the bridge's "length" extent.
  mesh.scale.set(length, DECK_THICKNESS, width);
  mesh.position.set(wx, 0, wz); // Y filled in by the syncer (needs grid)
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Replace the contents of `group` with one deck mesh per `bridge` structure.
 * `gridSampleY(cx, cz)` resolves the deck height — pass a closure that reads
 * the live grid (LAND tier top), so the deck floats correctly when the
 * endpoint cells are at T0/T1/etc.
 *
 * Non-bridge kinds are skipped here; staircase / incline meshes land in 9.4
 * with their own syncer.
 */
export function syncBridgeMeshes(
  group: THREE.Group,
  structures: readonly BuiltStructure[],
  gridSampleTierTop: (cx: number, cz: number) => number,
): void {
  // Dispose previous meshes' materials so we don't leak GPU resources on
  // repeated placements/removals during a long session. The shared geometry
  // is cached in `_deckGeometryCache` and stays alive.
  for (const child of group.children) {
    if ((child as THREE.Mesh).material) {
      const m = (child as THREE.Mesh).material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m.dispose();
    }
  }
  group.clear();

  for (const s of structures) {
    if (s.kind !== 'bridge') continue;
    const mesh = buildBridgeMesh(s);
    // Endpoints are LAND at the same tier (placement enforced this). Place
    // the deck's top surface flush with the LAND tier top so the player
    // reads LAND → bridge → LAND as one continuous walkable surface. With
    // box thickness 0.06 m, the deck centre sits half-thickness below.
    const tierTop = gridSampleTierTop(s.originCell[0], s.originCell[1]);
    mesh.position.y = tierTop - DECK_THICKNESS * 0.5;
    group.add(mesh);
  }
}
