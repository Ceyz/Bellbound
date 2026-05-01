import * as THREE from 'three';
import {
  CELL,
  TERRAIN_ORIGIN,
} from './terrain/TerrainGrid';
import {
  forwardOf,
  type BuiltStructure,
} from './terrain/builtStructure';
import {
  applyRollingShaderTo,
  disableFrustumCullingForRolling,
} from './rollingWorld';

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
  // GPU-warp the mesh with the rolling-world parabola so the deck follows the
  // ground around the player. Without this the deck stays at flat world Y while
  // everything else rolls — visible as the bridge "lifting" when the player
  // descends a hill, exactly the bug the rollingWorld.ts header warns about.
  applyRollingShaderTo(mesh.material as THREE.Material);
  disableFrustumCullingForRolling(mesh);
  return mesh;
}

/**
 * Build a staircase: two stacked boxes filling the cliff face on the lower
 * cell. The lower step covers the front half (toward the lower-tier ground)
 * at half the tier delta; the upper step covers the back half (toward the
 * cliff plateau) at the full tier delta. Together they read as a 2-step
 * silhouette the player ascends. Origin at the lower-tier cell; placement
 * guarantees `tierUpper - tierLower == 1`.
 */
function buildStaircaseGroup(
  s: BuiltStructure,
  gridSampleTierTop: (cx: number, cz: number) => number,
): THREE.Group {
  const [fx, fz] = forwardOf(s.rotation);
  const [originCx, originCz] = s.originCell;

  const tierLower = gridSampleTierTop(originCx, originCz);
  const tierUpper = gridSampleTierTop(originCx + fx, originCz + fz);
  const height = Math.max(0.05, tierUpper - tierLower);
  const halfHeight = height * 0.5;

  // Cell-local center of the lower cell in world coords.
  const lowerWx = TERRAIN_ORIGIN.x + (originCx + 0.5) * CELL;
  const lowerWz = TERRAIN_ORIGIN.z + (originCz + 0.5) * CELL;

  const group = new THREE.Group();
  group.name = `staircase-${s.id}`;

  // Two box geometries — keep distinct so each step gets its own scale.
  const material = new THREE.MeshStandardMaterial({
    color: STAIRCASE_COLOR,
    roughness: 0.9,
    metalness: 0,
  });

  const stepLength = CELL * 0.5;
  const stepWidth = s.width * CELL;

  // Step 1 (front, toward lower tier): half-height, front half of the lower cell.
  const step1 = new THREE.Mesh(unitDeckGeometry(), material);
  step1.scale.set(stepLength, halfHeight, stepWidth);
  step1.position.set(
    lowerWx - fx * (CELL * 0.25),
    tierLower + halfHeight * 0.5,
    lowerWz - fz * (CELL * 0.25),
  );
  step1.castShadow = true;
  step1.receiveShadow = true;
  step1.rotation.y = -((s.rotation * Math.PI) / 180);
  group.add(step1);

  // Step 2 (back, toward cliff): full-height, back half of the lower cell.
  const step2 = new THREE.Mesh(unitDeckGeometry(), material);
  step2.scale.set(stepLength, height, stepWidth);
  step2.position.set(
    lowerWx + fx * (CELL * 0.25),
    tierLower + height * 0.5,
    lowerWz + fz * (CELL * 0.25),
  );
  step2.castShadow = true;
  step2.receiveShadow = true;
  step2.rotation.y = -((s.rotation * Math.PI) / 180);
  group.add(step2);

  applyRollingShaderTo(material);
  disableFrustumCullingForRolling(step1);
  disableFrustumCullingForRolling(step2);
  return group;
}

let _wedgeGeometryCache: THREE.BufferGeometry | null = null;

/**
 * Unit wedge geometry: an axis-aligned right-triangular prism from -X bottom
 * to +X top, used as the incline base shape. Six unique vertices, five faces
 * (front/back triangles, bottom/back rectangles, sloped top). Cached once
 * and shared across every incline mesh.
 *
 * The slope rises from y=0 at the -X side to y=1 at the +X side, so when the
 * mesh is positioned with its origin at the lower-tier cell center and
 * scaled by `(length, height, width)` it spans LAND tier T → LAND tier T+1
 * smoothly along the forward axis.
 */
function unitWedgeGeometry(): THREE.BufferGeometry {
  if (_wedgeGeometryCache) return _wedgeGeometryCache;
  const v0 = [-0.5, 0, -0.5];
  const v1 = [+0.5, 0, -0.5];
  const v2 = [+0.5, 1, -0.5];
  const v3 = [-0.5, 0, +0.5];
  const v4 = [+0.5, 0, +0.5];
  const v5 = [+0.5, 1, +0.5];
  const positions = new Float32Array([
    // Front triangle (z = -0.5, normal -Z): v0, v2, v1
    ...v0, ...v2, ...v1,
    // Back triangle (z = +0.5, normal +Z): v3, v4, v5
    ...v3, ...v4, ...v5,
    // Bottom rectangle (y = 0, normal -Y): v0, v1, v4 / v0, v4, v3
    ...v0, ...v1, ...v4,
    ...v0, ...v4, ...v3,
    // Back wall (x = +0.5, normal +X): v1, v4, v5 / v1, v5, v2
    ...v1, ...v4, ...v5,
    ...v1, ...v5, ...v2,
    // Sloped top (normal up-and-toward -X): v0, v5, v2 / v0, v3, v5
    ...v0, ...v5, ...v2,
    ...v0, ...v3, ...v5,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  _wedgeGeometryCache = geometry;
  return geometry;
}

/**
 * Build an incline: a sloped wedge anchored at the lower-tier cell, filling
 * the gap between LAND tier T and LAND tier T+1. The slope's top edge is
 * flush with the upper tier so the player's vertical-lag lerp reads as a
 * smooth ramp rather than a teleport when the Y override snaps them up.
 */
function buildInclineMesh(
  s: BuiltStructure,
  gridSampleTierTop: (cx: number, cz: number) => number,
): THREE.Mesh {
  const [fx, fz] = forwardOf(s.rotation);
  const [originCx, originCz] = s.originCell;

  const tierLower = gridSampleTierTop(originCx, originCz);
  const tierUpper = gridSampleTierTop(originCx + fx, originCz + fz);
  const height = Math.max(0.05, tierUpper - tierLower);

  const lowerWx = TERRAIN_ORIGIN.x + (originCx + 0.5) * CELL;
  const lowerWz = TERRAIN_ORIGIN.z + (originCz + 0.5) * CELL;

  const mesh = new THREE.Mesh(
    unitWedgeGeometry(),
    new THREE.MeshStandardMaterial({
      color: INCLINE_COLOR,
      roughness: 0.9,
      metalness: 0,
    }),
  );
  mesh.name = `incline-${s.id}`;
  // Wedge spans the lower cell only — length=1m along forward.
  mesh.scale.set(CELL, height, s.width * CELL);
  mesh.rotation.y = -((s.rotation * Math.PI) / 180);
  // Wedge centred on the lower cell, with its bottom at lower tier.
  mesh.position.set(lowerWx, tierLower, lowerWz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  applyRollingShaderTo(mesh.material as THREE.Material);
  disableFrustumCullingForRolling(mesh);
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
  // Traverse so nested Groups (staircase = two steps in a Group) get their
  // descendant materials disposed too. Direct-child-only iteration would leak
  // staircase step materials on every rebuild.
  for (const child of group.children) {
    child.traverse((descendant) => {
      if (descendant instanceof THREE.Mesh) {
        const m = descendant.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m?.dispose();
      }
    });
  }
  group.clear();

  for (const s of structures) {
    if (s.kind === 'bridge') {
      group.add(buildBridgeMesh(s, gridSampleTierTop));
    } else if (s.kind === 'staircase') {
      group.add(buildStaircaseGroup(s, gridSampleTierTop));
    } else if (s.kind === 'incline') {
      group.add(buildInclineMesh(s, gridSampleTierTop));
    }
  }
}
