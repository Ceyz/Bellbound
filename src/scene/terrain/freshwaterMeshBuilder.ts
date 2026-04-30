import * as THREE from 'three';
import type { TerrainGrid } from './TerrainGrid';

/**
 * Builds the freshwater surface mesh from a TerrainGrid (Step 3 round 2 of the
 * terraforming refactor — the river / pond water that lives ON the island,
 * separate from the global ocean plane).
 *
 * Each FRESHWATER cell becomes a flat 1m × 1m quad at its water surface Y
 * (= tier top - FRESHWATER_SURFACE_OFFSET_METERS, see D12 v4 lock = 0.30 m).
 * Tiers are mixed in a single fused geometry: a freshwater cell on T0 sits at
 * Y = -0.30, one on T1 sits at Y = +0.70. The shader is the same regardless of
 * tier — what differs is just the vertex Y, baked at build time.
 *
 * No vertex sharing: same reasoning as the ground mesh — neighboring cells of
 * different tier need different Y. Connected components could be split into
 * separate meshes for per-pond effects, but for MVP a single fused mesh is
 * cheaper and the shader behaves identically per cell.
 */
export function buildFreshwaterMesh(
  grid: TerrainGrid,
  material: THREE.MeshStandardMaterial,
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  let vertexCount = 0;

  grid.forEachFreshwaterCell((cx, cz, _cell, surfaceY) => {
    const x0 = grid.originX + cx * grid.cellSize;
    const x1 = x0 + grid.cellSize;
    const z0 = grid.originZ + cz * grid.cellSize;
    const z1 = z0 + grid.cellSize;

    positions.push(
      x0, surfaceY, z0,
      x1, surfaceY, z0,
      x1, surfaceY, z1,
      x0, surfaceY, z1,
    );
    for (let i = 0; i < 4; i += 1) normals.push(0, 1, 0);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);

    const v = vertexCount;
    // CCW from above (front-facing up) — same fix as groundMeshBuilder.
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
  mesh.name = 'freshwater-surface';
  return mesh;
}

/** Diagnostic: number of FRESHWATER cells in the grid (= quad count of the mesh). */
export function countFreshwaterCells(grid: TerrainGrid): number {
  let n = 0;
  grid.forEachFreshwaterCell(() => {
    n += 1;
  });
  return n;
}
