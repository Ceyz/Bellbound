import * as THREE from 'three';
import {
  FRESHWATER_SURFACE_OFFSET_METERS,
  Surface,
  type TerrainGrid,
  tierHeight,
} from './TerrainGrid';

/**
 * Builds vertical waterfall sheets at every grid edge where a FRESHWATER cell
 * is adjacent to a lower-Y cell. Step 6 of the terraforming refactor.
 *
 * For each yielded tier-discontinuity edge, if the UPPER cell is FRESHWATER,
 * we emit a 1m-wide vertical quad spanning from the upper water surface down
 * to either:
 *   - the lower cell's water surface (FRESHWATER → FRESHWATER drop)
 *   - the lower cell's tier top (FRESHWATER → LAND drop)
 *   - sea level (FRESHWATER → OCEAN, rare but legal)
 *
 * Material is the same `freshwaterStylizedMaterial` used for the horizontal
 * water surface so the cascade visually inherits the calm green palette and
 * directional flow streaks (a small visual mismatch with real falling water,
 * but cheap and consistent — proper animated cascades land in a polish step).
 */
export function buildWaterfallMesh(
  grid: TerrainGrid,
  material: THREE.MeshStandardMaterial,
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vertexCount = 0;

  grid.forEachTierDiscontinuity((lowerCx, lowerCz, upperCx, upperCz, dx, dz, _drop) => {
    const upperCell = grid.getCell(upperCx, upperCz);
    if (upperCell.surface !== Surface.FRESHWATER) return;

    const topY = tierHeight(upperCell.tier) - FRESHWATER_SURFACE_OFFSET_METERS;

    const lowerCell = grid.getCell(lowerCx, lowerCz);
    let bottomY: number;
    if (lowerCell.surface === Surface.FRESHWATER) {
      bottomY = tierHeight(lowerCell.tier) - FRESHWATER_SURFACE_OFFSET_METERS;
    } else if (lowerCell.surface === Surface.LAND) {
      bottomY = tierHeight(lowerCell.tier);
    } else {
      bottomY = 0; // OCEAN / VOID
    }

    if (topY <= bottomY) return; // no fall (defensive)

    // Edge endpoints in world coords. Edge sits on the LOWER cell's boundary
    // toward the upper cell (matches cliffSideMeshBuilder's geometry).
    const x0 = grid.originX + lowerCx * grid.cellSize;
    const z0 = grid.originZ + lowerCz * grid.cellSize;
    const x1 = x0 + grid.cellSize;
    const z1 = z0 + grid.cellSize;

    let p0x: number, p0z: number, p1x: number, p1z: number;
    let normal: [number, number, number];
    if (dx === 1) {
      // Upper is east of lower; waterfall sheet at x=x1, faces +X (out of lower toward upper).
      p0x = x1; p0z = z0; p1x = x1; p1z = z1;
      normal = [1, 0, 0];
    } else if (dx === -1) {
      p0x = x0; p0z = z1; p1x = x0; p1z = z0;
      normal = [-1, 0, 0];
    } else if (dz === 1) {
      p0x = x1; p0z = z1; p1x = x0; p1z = z1;
      normal = [0, 0, 1];
    } else {
      p0x = x0; p0z = z0; p1x = x1; p1z = z0;
      normal = [0, 0, -1];
    }

    // 4 verts CCW seen from the +normal side (front face), same pattern as
    // cliffSideMeshBuilder's wall quad.
    positions.push(
      p0x, bottomY, p0z,
      p1x, bottomY, p1z,
      p1x, topY, p1z,
      p0x, topY, p0z,
    );
    for (let i = 0; i < 4; i += 1) normals.push(...normal);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);

    const v = vertexCount;
    indices.push(v, v + 1, v + 2);
    indices.push(v, v + 2, v + 3);
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
  mesh.name = 'waterfalls';
  return mesh;
}
