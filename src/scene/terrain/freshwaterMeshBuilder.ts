import * as THREE from 'three';
import {
  FRESHWATER_SURFACE_OFFSET_METERS,
  Surface,
  type TerrainGrid,
  tierHeight,
} from './TerrainGrid';

/**
 * Builds the freshwater surface mesh from a TerrainGrid (Step 3 round 2 of the
 * terraforming refactor — the river / pond water that lives ON the island,
 * separate from the global ocean plane).
 *
 * Each FRESHWATER cell becomes a flat 1m × 1m quad at its water surface Y.
 *
 * Surface height rules:
 *   - DEFAULT: tier top - FRESHWATER_SURFACE_OFFSET_METERS (= -30 cm below
 *     grass). Gives the canyon-style "30 cm bank visible above water" look
 *     the user explicitly asked to keep.
 *   - CASCADE-EXIT cells (FW cell with at least one FW neighbour at a LOWER
 *     cellHeight): tier top exactly. Raised to grass level so the cascade
 *     quad meets the upper pond's surface edge-to-edge with NO creux above
 *     the falling water. Without this, the camera sees 30 cm of cliff
 *     between the cascade top edge and the recessed pond — reads as a
 *     dark band that the user calls "le creux au milieu".
 *
 * The 30 cm step at the back of a cascade-exit cell (between this cell at
 * grass level and its non-cascade neighbour at recessed level) sits inside
 * the pond and is largely hidden from low / front camera angles. ACNH-style
 * "spillway lip" — the front of the pond rises to spill into the cascade.
 *
 * No vertex sharing: same reasoning as the ground mesh — neighboring cells of
 * different tier or cascade-state need different Y.
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

  // ──────────────────────────────────────────────────────────────────
  // Flood-fill to detect DRAINED ponds — any FW connected component
  // (same-tier 4-connected) that contains at least one cascade-exit
  // cell (a FW cell with a lower-cellHeight FW neighbour) has all its
  // cells flagged as "drained" and rendered at grass-level Y. Without
  // this, only the cascade-exit cell itself was raised and the rest
  // of the pond stayed recessed → 30 cm step inside the pond, visible
  // as a "trou" behind the cascade when the user dug a back-cell of a
  // wide cascade. With the flood-fill the entire connected pond
  // upstream of a cascade rises to grass level edge-to-edge with the
  // cascade top — water flows continuously off the cliff, ACNH-style.
  // Ponds with no cascade-exit (isolated) keep the canyon-recessed
  // look (–30 cm below grass) the user explicitly asked for.
  // ──────────────────────────────────────────────────────────────────
  void FRESHWATER_SURFACE_OFFSET_METERS;
  const drained = new Set<number>();
  const cellIdx = (cx: number, cz: number) => cz * grid.width + cx;
  const dirs4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const queue: [number, number][] = [];

  // Seed: cascade-exit cells (FW with a lower FW neighbour).
  grid.forEachFreshwaterCell((cx, cz) => {
    const myH = grid.cellHeight(cx, cz);
    for (const [dx, dz] of dirs4) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!grid.cellInBounds(nx, nz)) continue;
      if (grid.getSurface(nx, nz) !== Surface.FRESHWATER) continue;
      const nH = grid.cellHeight(nx, nz);
      if (Number.isNaN(nH)) continue;
      if (nH < myH - 0.01) {
        const idx = cellIdx(cx, cz);
        if (!drained.has(idx)) {
          drained.add(idx);
          queue.push([cx, cz]);
        }
        break;
      }
    }
  });

  // BFS: spread "drained" to connected same-tier FW cells. A pond at
  // a different tier is a SEPARATE component and won't be drained
  // through a cascade boundary (that's what the cascade is for).
  while (queue.length > 0) {
    const [cx, cz] = queue.shift()!;
    const cellTier = grid.getCell(cx, cz).tier;
    for (const [dx, dz] of dirs4) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!grid.cellInBounds(nx, nz)) continue;
      if (grid.getSurface(nx, nz) !== Surface.FRESHWATER) continue;
      if (grid.getCell(nx, nz).tier !== cellTier) continue;
      const nIdx = cellIdx(nx, nz);
      if (drained.has(nIdx)) continue;
      drained.add(nIdx);
      queue.push([nx, nz]);
    }
  }

  grid.forEachFreshwaterCell((cx, cz, cell, surfaceY) => {
    const x0 = grid.originX + cx * grid.cellSize;
    const x1 = x0 + grid.cellSize;
    const z0 = grid.originZ + cz * grid.cellSize;
    const z1 = z0 + grid.cellSize;

    const isDrained = drained.has(cellIdx(cx, cz));
    const effectiveSurfaceY = isDrained
      ? tierHeight(cell.tier)
      : surfaceY;

    positions.push(
      x0, effectiveSurfaceY, z0,
      x1, effectiveSurfaceY, z0,
      x1, effectiveSurfaceY, z1,
      x0, effectiveSurfaceY, z1,
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
