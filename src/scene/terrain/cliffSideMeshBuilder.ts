import * as THREE from 'three';
import type { SurfaceTextureSet } from '../proceduralTextures';
import type { TerrainGrid } from './TerrainGrid';

/**
 * Builds vertical wall meshes at every grid tier discontinuity (Step 3 of the
 * terraforming refactor). Replaces the hardcoded `cliffSideMesh.ts` builder
 * which only knew about the rectangular NW cliff plateau.
 *
 * Inputs come from `grid.forEachTierDiscontinuity()`, which yields every
 * cell-to-cell edge where the two cells have different `cellHeight()`. This
 * covers:
 *   - LAND tier-N → LAND tier-(N-1) cliff drops
 *   - LAND tier-N → FRESHWATER river / pond banks (the bed sits below tier top)
 *   - LAND tier-N → OCEAN edges are skipped (OCEAN is owned by the water plane
 *     and the splat shader's offshore-discard, not by a vertical wall)
 *
 * Two meshes are produced and grouped:
 *   - `cliff-wall-faces` : the painted vertical rock face (uses cliff side texture)
 *   - `cliff-grass-lips` : a thin slab draped over the top edge for the ACNH
 *                          "grass curl over rock" silhouette (uses cliff top texture)
 *
 * The lip is omitted on FRESHWATER edges (river banks have a wet-sand color
 * derived from the splat dirt channel; no grass overhang reads correctly there).
 */

const LIP_THICKNESS_METERS = 0.07;
const LIP_OVERHANG_METERS = 0.08;
const HORIZONTAL_TILE_METERS = 4;
const VERTICAL_TILES = 1;

export function buildCliffSideMesh(
  grid: TerrainGrid,
  textures: SurfaceTextureSet,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'cliff-side-walls';

  // LAND-LAND walls (real cliffs / player-raised plateaus): stratified rock
  // texture, sub-pixel bleed at edges + corners to hide rasteriser ties.
  const cliffWallMaterial = new THREE.MeshStandardMaterial({
    map: textures.cliffSide,
    roughness: 0.94,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  cliffWallMaterial.name = 'cliff-wall-material';

  // LAND-FRESHWATER walls (river / pond banks): wet-sand riverbed texture so
  // the bank reads as natural earth instead of stratified rock. NO geometry
  // bleed — the stair-stepped river outline turns the per-edge bleeds into
  // visible "brown blades" overshooting at corners. Sub-pixel seams are
  // covered by the polygonOffset biasing alone.
  const riverBankMaterial = new THREE.MeshStandardMaterial({
    map: textures.riverbed,
    roughness: 0.92,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  riverBankMaterial.name = 'river-bank-material';

  const lipMaterial = new THREE.MeshStandardMaterial({
    map: textures.cliffTop,
    roughness: 0.9,
  });
  lipMaterial.name = 'cliff-side-lip-material';

  const cliffGeometries: THREE.BufferGeometry[] = [];
  const riverBankGeometries: THREE.BufferGeometry[] = [];
  const lipGeometries: THREE.BufferGeometry[] = [];

  grid.forEachTierDiscontinuity((lowerCx, lowerCz, upperCx, upperCz, dx, dz, drop) => {
    const lowerCell = grid.getCell(lowerCx, lowerCz);
    const isWaterBank = lowerCell.surface === 3 /* FRESHWATER */;

    // Bleeds (both EDGE_BLEED in perpendicular and VERTICAL_BLEED at top +
    // bottom) only on cliffs. River banks ship without bleeds because the
    // stair-stepped LAND-FW outline would otherwise expose the bleed as a
    // small overshooting "brown blade" at every zigzag corner.
    const wallGeometry = buildWallQuadGeometry(grid, lowerCx, lowerCz, dx, dz, drop, !isWaterBank);
    if (isWaterBank) {
      riverBankGeometries.push(wallGeometry);
    } else {
      cliffGeometries.push(wallGeometry);
      lipGeometries.push(buildLipQuadGeometry(grid, upperCx, upperCz, dx, dz));
    }
  });

  if (cliffGeometries.length > 0) {
    const merged = mergeBufferGeometries(cliffGeometries);
    const mesh = new THREE.Mesh(merged, cliffWallMaterial);
    mesh.name = 'cliff-walls';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  if (riverBankGeometries.length > 0) {
    const merged = mergeBufferGeometries(riverBankGeometries);
    const mesh = new THREE.Mesh(merged, riverBankMaterial);
    mesh.name = 'river-bank-walls';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  if (lipGeometries.length > 0) {
    const merged = mergeBufferGeometries(lipGeometries);
    const mesh = new THREE.Mesh(merged, lipMaterial);
    mesh.name = 'cliff-lips';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}

/**
 * One vertical 1m wall quad placed on the edge between (lowerCx, lowerCz) and
 * its neighbor in direction (dx, dz). The wall spans from `lower top Y` to
 * `lower top Y + drop`, which equals the upper cell's top Y.
 */
function buildWallQuadGeometry(
  grid: TerrainGrid,
  lowerCx: number,
  lowerCz: number,
  dx: number,
  dz: number,
  drop: number,
  withBleed: boolean,
): THREE.BufferGeometry {
  // Vertical bleed at top + bottom only when `withBleed` is set — used by
  // LAND-LAND cliffs to fill the sub-pixel hairline at the LAND/wall corner.
  // River banks pass `withBleed: false` because the bleed would protrude
  // visibly at every zigzag corner along the stair-stepped river outline.
  const VERTICAL_BLEED = withBleed ? 0.006 : 0;
  const lowerY = grid.cellHeight(lowerCx, lowerCz) - VERTICAL_BLEED;
  const upperY = grid.cellHeight(lowerCx, lowerCz) + drop + VERTICAL_BLEED;

  // Edge is the shared boundary between lower cell and its neighbor at (dx, dz).
  // Cell (cx, cz) covers world rect [origin + cx, origin + cx + 1] × similar in z.
  // The edge is one of the four cell sides depending on (dx, dz):
  //   dx=+1, dz=0 → east side of lower (x = origin + cx + 1, z varies)
  //   dx=-1, dz=0 → west side of lower (x = origin + cx, z varies)
  //   dx=0,  dz=+1 → north side of lower (z = origin + cz + 1, x varies)
  //   dx=0,  dz=-1 → south side of lower (z = origin + cz, x varies)

  const x0 = grid.originX + lowerCx * grid.cellSize;
  const z0 = grid.originZ + lowerCz * grid.cellSize;
  const x1 = x0 + grid.cellSize;
  const z1 = z0 + grid.cellSize;

  let p0x: number, p0z: number, p1x: number, p1z: number;
  let normal: [number, number, number];

  // EDGE_BLEED only on cliffs (withBleed). River banks must NOT bleed — the
  // stair-stepped LAND/FW outline turns the perpendicular bleed into visible
  // overshooting "brown blades" at zigzag corners.
  const EDGE_BLEED = withBleed ? 0.005 : 0;

  if (dx === 1) {
    // east edge of lower; wall faces +X (toward upper cell). Bleed along z.
    p0x = x1; p0z = z0 - EDGE_BLEED; p1x = x1; p1z = z1 + EDGE_BLEED;
    normal = [1, 0, 0];
  } else if (dx === -1) {
    // west edge of lower; wall faces -X. Bleed along z.
    p0x = x0; p0z = z1 + EDGE_BLEED; p1x = x0; p1z = z0 - EDGE_BLEED;
    normal = [-1, 0, 0];
  } else if (dz === 1) {
    // north edge of lower; wall faces +Z. Bleed along x.
    p0x = x1 + EDGE_BLEED; p0z = z1; p1x = x0 - EDGE_BLEED; p1z = z1;
    normal = [0, 0, 1];
  } else {
    // south edge of lower (dz === -1); wall faces -Z. Bleed along x.
    p0x = x0 - EDGE_BLEED; p0z = z0; p1x = x1 + EDGE_BLEED; p1z = z0;
    normal = [0, 0, -1];
  }

  // 4 vertices: (p0, lower), (p1, lower), (p1, upper), (p0, upper).
  // Triangulation: (0, 1, 2), (0, 2, 3) — front face out, CCW around the outward normal.
  const positions = new Float32Array([
    p0x, lowerY, p0z,
    p1x, lowerY, p1z,
    p1x, upperY, p1z,
    p0x, upperY, p0z,
  ]);
  const normals = new Float32Array([
    ...normal, ...normal, ...normal, ...normal,
  ]);
  // UVs: u maps along the edge (0..1m of physical extent → 1/HORIZONTAL_TILE_METERS),
  //      v maps along the height (0..drop → drop/(VERTICAL_TILES * 1m) in tile units)
  const uMax = grid.cellSize / HORIZONTAL_TILE_METERS;
  const vMax = drop * VERTICAL_TILES;
  const uvs = new Float32Array([
    0, 0,
    uMax, 0,
    uMax, vMax,
    0, vMax,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  return geometry;
}

/**
 * Thin grass slab draped over the upper cell's edge that overhangs the wall.
 * Sits just below the upper cell's top Y so depth-buffer co-planarity with the
 * ground mesh is not an issue.
 */
function buildLipQuadGeometry(
  grid: TerrainGrid,
  upperCx: number,
  upperCz: number,
  dx: number,
  dz: number,
): THREE.BufferGeometry {
  const upperY = grid.cellHeight(upperCx, upperCz);

  const x0 = grid.originX + upperCx * grid.cellSize;
  const z0 = grid.originZ + upperCz * grid.cellSize;
  const x1 = x0 + grid.cellSize;
  const z1 = z0 + grid.cellSize;

  // The lip is a tiny BoxGeometry overhanging the edge of the UPPER cell, on
  // the side facing the lower neighbor (i.e. the side OPPOSITE to (dx, dz)).
  let centerX: number, centerZ: number, sizeX: number, sizeZ: number;
  if (dx === 1) {
    // upper cell is to the east of the wall; lip overhangs its WEST edge
    centerX = x0 - LIP_OVERHANG_METERS * 0.5;
    centerZ = (z0 + z1) * 0.5;
    sizeX = LIP_OVERHANG_METERS * 2;
    sizeZ = grid.cellSize;
  } else if (dx === -1) {
    centerX = x1 + LIP_OVERHANG_METERS * 0.5;
    centerZ = (z0 + z1) * 0.5;
    sizeX = LIP_OVERHANG_METERS * 2;
    sizeZ = grid.cellSize;
  } else if (dz === 1) {
    centerX = (x0 + x1) * 0.5;
    centerZ = z0 - LIP_OVERHANG_METERS * 0.5;
    sizeX = grid.cellSize;
    sizeZ = LIP_OVERHANG_METERS * 2;
  } else {
    centerX = (x0 + x1) * 0.5;
    centerZ = z1 + LIP_OVERHANG_METERS * 0.5;
    sizeX = grid.cellSize;
    sizeZ = LIP_OVERHANG_METERS * 2;
  }

  const box = new THREE.BoxGeometry(sizeX, LIP_THICKNESS_METERS, sizeZ);
  box.translate(centerX, upperY - LIP_THICKNESS_METERS * 0.5, centerZ);
  return box;
}

/**
 * Concatenates BufferGeometry instances by appending their attributes. All
 * inputs must have the same attributes (`position`, `normal`, `uv`) and an
 * index. We avoid the dependency on `BufferGeometryUtils.mergeGeometries`
 * to keep the import surface small.
 */
function mergeBufferGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geometries) {
    totalVerts += g.getAttribute('position').count;
    const idx = g.getIndex();
    totalIndices += idx ? idx.count : g.getAttribute('position').count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = totalVerts < 65536
    ? new Uint16Array(totalIndices)
    : new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;
  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const idx = g.getIndex();

    positions.set(pos.array as Float32Array, vertOffset * 3);
    normals.set(nor.array as Float32Array, vertOffset * 3);
    uvs.set(uv.array as Float32Array, vertOffset * 2);

    if (idx) {
      const arr = idx.array;
      for (let i = 0; i < arr.length; i += 1) {
        indices[idxOffset + i] = arr[i] + vertOffset;
      }
      idxOffset += arr.length;
    } else {
      for (let i = 0; i < pos.count; i += 1) {
        indices[idxOffset + i] = i + vertOffset;
      }
      idxOffset += pos.count;
    }

    vertOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
