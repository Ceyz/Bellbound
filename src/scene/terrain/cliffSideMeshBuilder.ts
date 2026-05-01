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

  const wallMaterial = new THREE.MeshStandardMaterial({
    map: textures.cliffSide,
    roughness: 0.94,
    // polygonOffset biases the wall's depth aggressively toward the camera so
    // it wins sub-pixel ties at the LAND/FRESHWATER seam (the line where the
    // wall meets both the water plane below and the LAND quad above). The
    // initial -1/-1 wasn't enough on certain oblique camera angles — bumped to
    // -4/-4 to be robust. See memory/structure_gotchas.md.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  wallMaterial.name = 'cliff-side-material';

  const lipMaterial = new THREE.MeshStandardMaterial({
    map: textures.cliffTop,
    roughness: 0.9,
  });
  lipMaterial.name = 'cliff-side-lip-material';

  const wallGeometries: THREE.BufferGeometry[] = [];
  const lipGeometries: THREE.BufferGeometry[] = [];

  grid.forEachTierDiscontinuity((lowerCx, lowerCz, upperCx, upperCz, dx, dz, drop) => {
    // Skip discontinuities involving FRESHWATER on the LOWER side: the water
    // surface mesh + splat already paints the bank in Step 6/7. We still emit
    // walls for LAND-LAND drops (cliffs) and for LAND-FRESHWATER where LAND is
    // higher (river bank rock). The bank texture is the same painted cliff
    // side stratification; the lip is suppressed for water boundaries.
    const lowerCell = grid.getCell(lowerCx, lowerCz);
    const isWaterBank = lowerCell.surface === 3 /* FRESHWATER */;

    const wallGeometry = buildWallQuadGeometry(grid, lowerCx, lowerCz, dx, dz, drop);
    wallGeometries.push(wallGeometry);

    if (!isWaterBank) {
      const lipGeometry = buildLipQuadGeometry(grid, upperCx, upperCz, dx, dz);
      lipGeometries.push(lipGeometry);
    }
  });

  if (wallGeometries.length > 0) {
    const merged = mergeBufferGeometries(wallGeometries);
    const mesh = new THREE.Mesh(merged, wallMaterial);
    mesh.name = 'cliff-walls';
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
): THREE.BufferGeometry {
  // Vertical bleed at top + bottom: pokes the wall a few mm above the LAND
  // tier top and below the FRESHWATER bed. Fills the sub-pixel hairline at
  // the LAND/wall corner that lets the water plane below show through as
  // blue slivers along the bank — top is the only place the user can
  // actually see this artefact (LAND quad ends at y=upperY exactly, wall
  // top at y=upperY exactly → tied at the line). The brown poke above LAND
  // is a much smaller artefact than the blue sliver and reads as part of
  // the bank.
  const VERTICAL_BLEED = 0.006;
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

  // Inflate the wall's perpendicular extent by `EDGE_BLEED` so adjacent walls
  // overlap by sub-pixel at corners. Without it, two walls meeting at a 90°
  // corner can leave a hair-line gap that reads as a thin blue/water sliver
  // on certain camera angles. The bleed is in the direction perpendicular to
  // the wall's edge axis, never along (dx, dz) itself.
  const EDGE_BLEED = 0.005;

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
