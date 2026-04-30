import * as THREE from 'three';
import { Surface, type TerrainGrid } from './TerrainGrid';

/**
 * Builds the ground mesh from a TerrainGrid (Step 3 of the terraforming refactor).
 *
 * Each LAND or FRESHWATER cell is rendered as a flat 1m × 1m quad at its top Y
 * (`grid.cellHeight()` — tier height for LAND, tier - bed offset for FRESHWATER).
 * OCEAN and VOID cells are skipped entirely; they are owned by the water plane
 * and the splat shader's offshore-discard.
 *
 * Vertices are NOT shared across cells. Two neighboring cells with different Y
 * values would otherwise have an ambiguous shared corner; duplicating means each
 * cell quad is independent and tier transitions stay sharp. Cliff side faces are
 * a separate mesh produced by `cliffSideMeshBuilder`.
 *
 * The position attribute encodes world XZ, which the splat material shader reads
 * directly via `(modelMatrix * vec4(position, 1.0)).xz` to sample the splat /
 * shoreDistance / cliffEdge maps. Normals are flat (0, 1, 0) per cell — vertical
 * faces are owned by the cliff mesh, not this one.
 */
export function buildGroundMesh(
  grid: TerrainGrid,
  material: THREE.MeshStandardMaterial,
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  let vertexCount = 0;

  grid.forEachSolidCell((cx, cz, _cell, topY) => {
    const x0 = grid.originX + cx * grid.cellSize;
    const x1 = x0 + grid.cellSize;
    const z0 = grid.originZ + cz * grid.cellSize;
    const z1 = z0 + grid.cellSize;

    // 4 corners CCW from SW: SW, SE, NE, NW
    positions.push(
      x0, topY, z0,
      x1, topY, z0,
      x1, topY, z1,
      x0, topY, z1,
    );
    for (let i = 0; i < 4; i += 1) normals.push(0, 1, 0);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);

    const v = vertexCount;
    // Two triangles, CCW order WHEN VIEWED FROM ABOVE so the cross-product
    // normal points +Y (up). Three.js default `FrontSide` culls back-facing
    // triangles, so getting the winding wrong here makes the entire ground
    // mesh invisible from a top-down camera (the bug that initially broke
    // Step 3: the user saw the water plane bleeding through transparent ground).
    indices.push(v, v + 2, v + 1);
    indices.push(v, v + 3, v + 2);
    vertexCount += 4;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'greybox-ground';
  return mesh;
}

/**
 * Diagnostic helper for tests: returns the number of LAND/FRESHWATER cells in
 * the grid (= the number of quads in the ground mesh).
 */
export function countSolidCells(grid: TerrainGrid): number {
  let n = 0;
  grid.forEachSolidCell(() => {
    n += 1;
  });
  return n;
}

/** Number of vertices = 4 × solid cell count. */
export function expectedGroundVertexCount(grid: TerrainGrid): number {
  return countSolidCells(grid) * 4;
}

/** Number of triangle indices = 6 × solid cell count. */
export function expectedGroundIndexCount(grid: TerrainGrid): number {
  return countSolidCells(grid) * 6;
}

/** Re-export for convenience. */
export { Surface };
