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
  const drops: number[] = [];
  const indices: number[] = [];
  let vertexCount = 0;

  grid.forEachTierDiscontinuity((lowerCx, lowerCz, upperCx, upperCz, dx, dz, _drop) => {
    const upperCell = grid.getCell(upperCx, upperCz);
    if (upperCell.surface !== Surface.FRESHWATER) return;

    // Top of the cascade sits at GRASS LEVEL. The upper FW cell's water
    // surface is raised to match (handled in freshwaterMeshBuilder for
    // cells flagged as cascade-exit), so the cascade meets the pond
    // surface edge-to-edge with no visible creux. Lowering the cascade
    // top to the recessed pond level would expose 30 cm of cliff above
    // the cascade — reads as a dark band ("creux") to the user.
    const topY = tierHeight(upperCell.tier);

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
    // UVs in METERS so the waterfall shader gets stable world-space scale
    // for streaks (≈ 8/m) and crest/pool bands (top 12 cm, bottom 10 cm) no
    // matter how tall or wide the drop is. u = along the edge (0..edgeLen),
    // v = up the drop (0 at pool, drop_meters at crest).
    //
    // `aDropMeters` is a per-vertex constant equal to the cascade's full
    // drop height — needed so the shader can place crest foam at the top
    // (drop - 0.12 .. drop) and pool mist at the bottom (0 .. 0.10) when
    // multiple cascades of different heights coexist in one merged mesh.
    const edgeLen = grid.cellSize;
    const drop = topY - bottomY;
    uvs.push(
      0, 0,
      edgeLen, 0,
      edgeLen, drop,
      0, drop,
    );
    drops.push(drop, drop, drop, drop);

    const v = vertexCount;
    indices.push(v, v + 1, v + 2);
    indices.push(v, v + 2, v + 3);
    vertexCount += 4;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aDropMeters', new THREE.Float32BufferAttribute(drops, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'waterfalls';
  return mesh;
}

/**
 * Builds a horizontal splash disc mesh at the foot of every cascade that
 * lands in a FRESHWATER pond. The disc sits a hair above the lower water
 * surface (polygonOffset wins the depth test against the freshwater plane)
 * and uses `waterfallSplashMaterial` to render animated radial ripples +
 * a bright impact centre + flickering foam droplets.
 *
 * Skipped when the cascade lands on LAND or OCEAN — the visual idea is
 * "water hits water and splashes outward". For LAND landings the cascade's
 * own pool-froth band already reads as wet rock; for OCEAN the ocean's
 * own foam handling takes over.
 *
 * UVs encode WORLD METERS RELATIVE TO THE SPLASH CENTRE (cascade foot).
 * That is, a vertex 35 cm to the +X of the impact point gets uv=(0.35, 0).
 * The splash shader interprets length(uv) as distance-from-impact in
 * metres, so the ripple cadence reads identically regardless of the
 * cascade's world position.
 */
const SPLASH_HALF_WIDTH = 0.70;
const SPLASH_LIFT_METERS = 0.005;
const MIST_HEIGHT_METERS = 0.55;
const MIST_HALF_WIDTH = 0.55;

export function buildWaterfallSplashMesh(
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

    const lowerCell = grid.getCell(lowerCx, lowerCz);
    if (lowerCell.surface !== Surface.FRESHWATER) return; // splash only on water-into-water

    const lowerSurfaceY =
      tierHeight(lowerCell.tier) - FRESHWATER_SURFACE_OFFSET_METERS + SPLASH_LIFT_METERS;

    // Cascade foot centre — middle of the cell-edge where the cascade
    // sheet meets the lower pond. Edge midpoint formula matches the
    // cascade builder's vertex layout.
    const x0 = grid.originX + lowerCx * grid.cellSize;
    const z0 = grid.originZ + lowerCz * grid.cellSize;
    const x1 = x0 + grid.cellSize;
    const z1 = z0 + grid.cellSize;

    let footX: number, footZ: number;
    if (dx === 1) {
      footX = x1; footZ = (z0 + z1) * 0.5;
    } else if (dx === -1) {
      footX = x0; footZ = (z0 + z1) * 0.5;
    } else if (dz === 1) {
      footX = (x0 + x1) * 0.5; footZ = z1;
    } else {
      footX = (x0 + x1) * 0.5; footZ = z0;
    }

    // Disc lives ON THE LOWER POND, biased AWAY from the cascade foot
    // (toward the lower-cell interior) so the bright centre sits ~5 cm
    // off the cliff base — visually the spray plumes outward into the
    // pond, not back under the cascade quad. Half-extents:
    // SPLASH_HALF_WIDTH along the cascade edge, slightly more in the
    // outward direction so the disc ovals into the pond.
    const outX = -dx; // unit vector away from upper cell
    const outZ = -dz;
    const offsetX = outX * 0.10;
    const offsetZ = outZ * 0.10;

    // Tangent along the cascade edge.
    const tanX = (dx === 0) ? 1 : 0;
    const tanZ = (dz === 0) ? 1 : 0;

    const cx = footX + offsetX;
    const cz = footZ + offsetZ;

    const halfTan = SPLASH_HALF_WIDTH;
    const halfOut = SPLASH_HALF_WIDTH * 1.1;

    const corners: [number, number, number, number][] = [
      // [worldX, worldZ, uvX (m from centre), uvZ (m from centre)]
      [cx - tanX * halfTan - outX * halfOut, cz - tanZ * halfTan - outZ * halfOut,
       -halfTan, -halfOut],
      [cx + tanX * halfTan - outX * halfOut, cz + tanZ * halfTan - outZ * halfOut,
        halfTan, -halfOut],
      [cx + tanX * halfTan + outX * halfOut, cz + tanZ * halfTan + outZ * halfOut,
        halfTan,  halfOut],
      [cx - tanX * halfTan + outX * halfOut, cz - tanZ * halfTan + outZ * halfOut,
       -halfTan,  halfOut],
    ];

    for (const [wx, wz, uvU, uvV] of corners) {
      positions.push(wx, lowerSurfaceY, wz);
      normals.push(0, 1, 0);
      uvs.push(uvU, uvV);
    }

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
  mesh.name = 'waterfall-splashes';
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * Builds vertical MIST PLUMES standing at every cascade-into-pond foot.
 * Each plume is a vertical quad facing the cascade-fall direction (so it
 * faces the camera when the player looks AT the cascade). The mist
 * material renders an animated white haze rising from the water surface,
 * giving the splash 3D verticality the flat horizontal disc can't.
 *
 * Quad geometry:
 *   - Tangent: along the cascade edge (perpendicular to the fall)
 *   - Up:      world +Y
 *   - Normal:  -(dx, dz) — points OUT of the upper cell, i.e. toward
 *              the camera on the cascade-front side
 *
 * Quad sits ON the lower water surface (lift +0.005 m) and rises
 * MIST_HEIGHT_METERS upward. UV: u along tangent (0..1), v vertical
 * (0 at base, 1 at top).
 */
export function buildWaterfallMistMesh(
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

    const lowerCell = grid.getCell(lowerCx, lowerCz);
    if (lowerCell.surface !== Surface.FRESHWATER) return; // mist only on water-into-water

    const lowerSurfaceY =
      tierHeight(lowerCell.tier) - FRESHWATER_SURFACE_OFFSET_METERS + SPLASH_LIFT_METERS;

    const x0 = grid.originX + lowerCx * grid.cellSize;
    const z0 = grid.originZ + lowerCz * grid.cellSize;
    const x1 = x0 + grid.cellSize;
    const z1 = z0 + grid.cellSize;

    let footX: number, footZ: number;
    if (dx === 1) {
      footX = x1; footZ = (z0 + z1) * 0.5;
    } else if (dx === -1) {
      footX = x0; footZ = (z0 + z1) * 0.5;
    } else if (dz === 1) {
      footX = (x0 + x1) * 0.5; footZ = z1;
    } else {
      footX = (x0 + x1) * 0.5; footZ = z0;
    }

    // Tangent along cascade edge, OUT vector away from upper cell.
    const tanX = (dx === 0) ? 1 : 0;
    const tanZ = (dz === 0) ? 1 : 0;
    const outX = -dx;
    const outZ = -dz;

    // Quad sits a hair OUTWARD from the cascade foot so it doesn't
    // z-fight the cascade quad. 7 cm clear of the cliff base.
    const cx = footX + outX * 0.07;
    const cz = footZ + outZ * 0.07;

    const halfTan = MIST_HALF_WIDTH;
    const yBase = lowerSurfaceY;
    const yTop  = yBase + MIST_HEIGHT_METERS;

    // Verts CCW from the +normal side (front = -dx,-dz):
    //   left-base, right-base, right-top, left-top
    const leftX  = cx - tanX * halfTan;
    const leftZ  = cz - tanZ * halfTan;
    const rightX = cx + tanX * halfTan;
    const rightZ = cz + tanZ * halfTan;

    positions.push(
      leftX,  yBase, leftZ,
      rightX, yBase, rightZ,
      rightX, yTop,  rightZ,
      leftX,  yTop,  leftZ,
    );
    for (let i = 0; i < 4; i += 1) normals.push(outX, 0, outZ);
    uvs.push(
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    );

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
  mesh.name = 'waterfall-mist';
  mesh.renderOrder = 3;
  return mesh;
}
