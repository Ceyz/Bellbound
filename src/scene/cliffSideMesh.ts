import * as THREE from 'three';
import { HEIGHTMAP, STAIRCASE } from './heightmap';
import type { SurfaceTextureSet } from './proceduralTextures';

/**
 * Vertical rock walls along the exposed edges of the NW cliff plateau. Without these,
 * the +1 m altitude step looks like a floating slab when seen from the side. ACNH
 * cliff sides are stratified rock — `surfaceTextures.cliffSide` carries the painted
 * stratification, here we just build the geometry and place it.
 *
 * Coverage:
 *  - South wall: a single quad spanning the southern cliff edge (worldZ = CLIFF_Z_MAX),
 *    facing +Z towards the rest of the island.
 *  - East walls: TWO quads on worldX = CLIFF_X_MAX, split around the staircase opening
 *    so the ramp is not occluded by rock. North segment runs from the terrain edge to
 *    the upper stair lip; south segment from the lower stair lip to the southern corner.
 *
 * UV strategy: we set Map repeat per quad so the painted strata read at a consistent
 * physical scale (≈ 4 m horizontal × 1 vertical tile). The base texture stays shared.
 */

const HORIZONTAL_TILE_SIZE_METERS = 4;
const VERTICAL_TILES = 1;
/**
 * Extra length / depth pushed beyond the geometric edge so the wall geometry overlaps
 * the terrain by a few centimeters. Hides splatmap-vs-mesh sub-texel mismatches that
 * would otherwise show as a thin gap at the cliff base.
 */
const EDGE_OVERLAP_METERS = 0.06;
/**
 * Thickness of the green grass "lip" that drapes over the top of every cliff face —
 * the most signature ACNH visual marker. Implemented as a thin horizontal strip of
 * the cliff_top texture, lowered slightly below the plateau surface and pushed out
 * past the cliff edge so it overhangs the rock face.
 */
const LIP_THICKNESS_METERS = 0.07;
const LIP_OVERHANG_METERS = 0.08;

export function createCliffSideMesh(surfaceTextures: SurfaceTextureSet): THREE.Group {
  const group = new THREE.Group();
  group.name = 'cliff-side-walls';

  const cliffHeight = HEIGHTMAP.CLIFF_TIER_HEIGHT;
  const xMax = HEIGHTMAP.CLIFF_X_MAX;
  const zMax = HEIGHTMAP.CLIFF_Z_MAX;
  // Inner bounds of the cliff plateau (NW corner). These match the SDF-friendly
  // cliff zone in heightmap.ts so the side walls only span the actual plateau and
  // do not float over discarded ocean tiles at the terrain corner.
  const xMin = HEIGHTMAP.CLIFF_X_MIN;
  const zMin = HEIGHTMAP.CLIFF_Z_MIN;

  const stairZMin = STAIRCASE.zCenter - STAIRCASE.halfWidth;
  const stairZMax = STAIRCASE.zCenter + STAIRCASE.halfWidth;

  const wallMaterial = new THREE.MeshStandardMaterial({
    map: surfaceTextures.cliffSide,
    roughness: 0.94,
  });
  wallMaterial.name = 'cliff-side-material';

  const lipMaterial = new THREE.MeshStandardMaterial({
    map: surfaceTextures.cliffTop,
    roughness: 0.9,
  });
  lipMaterial.name = 'cliff-side-lip-material';

  // South-facing edge: at z = zMax, spans from xMin to xMax. Extended by epsilon
  // on both ends to overlap the splat seam.
  const southLength = xMax - xMin + EDGE_OVERLAP_METERS * 2;
  const southCenterX = (xMin + xMax) / 2;
  const southWall = buildWallQuad(southLength, cliffHeight, wallMaterial, 'cliff-side-south', 'south');
  southWall.position.set(southCenterX, cliffHeight / 2, zMax);
  group.add(southWall);
  group.add(buildSouthLip(southLength, southCenterX, zMax, cliffHeight, lipMaterial));

  // East-facing edge at x = xMax, split around the staircase opening.
  // North segment runs from zMin to stairZMin.
  const eastNorthLength = stairZMin - zMin + EDGE_OVERLAP_METERS;
  if (eastNorthLength > 0.05) {
    const centerZ = (zMin - EDGE_OVERLAP_METERS + stairZMin) / 2;
    const eastNorth = buildWallQuad(eastNorthLength, cliffHeight, wallMaterial, 'cliff-side-east-north', 'east');
    eastNorth.position.set(xMax, cliffHeight / 2, centerZ);
    group.add(eastNorth);
    group.add(buildEastLip(eastNorthLength, centerZ, xMax, cliffHeight, lipMaterial, 'cliff-side-east-north-lip'));
  }

  // South segment runs from stairZMax to zMax.
  const eastSouthLength = zMax - stairZMax + EDGE_OVERLAP_METERS;
  if (eastSouthLength > 0.05) {
    const centerZ = (stairZMax + zMax + EDGE_OVERLAP_METERS) / 2;
    const eastSouth = buildWallQuad(eastSouthLength, cliffHeight, wallMaterial, 'cliff-side-east-south', 'east');
    eastSouth.position.set(xMax, cliffHeight / 2, centerZ);
    group.add(eastSouth);
    group.add(buildEastLip(eastSouthLength, centerZ, xMax, cliffHeight, lipMaterial, 'cliff-side-east-south-lip'));
  }

  // West-facing edge at x = xMin: new with the trimmed cliff zone. Without this
  // segment the plateau would have an open side facing the rest of the island.
  const westLength = zMax - zMin + EDGE_OVERLAP_METERS * 2;
  const westCenterZ = (zMin + zMax) / 2;
  const westWall = buildWallQuad(westLength, cliffHeight, wallMaterial, 'cliff-side-west', 'west');
  westWall.position.set(xMin, cliffHeight / 2, westCenterZ);
  group.add(westWall);
  group.add(buildWestLip(westLength, westCenterZ, xMin, cliffHeight, lipMaterial));

  // North-facing edge at z = zMin: same reasoning as the west edge.
  const northLength = xMax - xMin + EDGE_OVERLAP_METERS * 2;
  const northCenterX = (xMin + xMax) / 2;
  const northWall = buildWallQuad(northLength, cliffHeight, wallMaterial, 'cliff-side-north', 'north');
  northWall.position.set(northCenterX, cliffHeight / 2, zMin);
  group.add(northWall);
  group.add(buildNorthLip(northLength, northCenterX, zMin, cliffHeight, lipMaterial));

  return group;
}

/**
 * Thin grass strip horizontally clamped to the south cliff edge. The lip overhangs
 * the wall by `LIP_OVERHANG_METERS` to give the ACNH "grass curling over the rock"
 * silhouette. Sits just below the plateau surface so depth-buffer co-planarity with
 * the ground mesh is not an issue.
 */
function buildSouthLip(
  length: number,
  centerX: number,
  zMax: number,
  cliffHeight: number,
  material: THREE.MeshStandardMaterial,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(length, LIP_THICKNESS_METERS, LIP_OVERHANG_METERS * 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'cliff-side-south-lip';
  mesh.position.set(centerX, cliffHeight - LIP_THICKNESS_METERS * 0.5, zMax + LIP_OVERHANG_METERS * 0.5);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return mesh;
}

function buildEastLip(
  length: number,
  centerZ: number,
  xMax: number,
  cliffHeight: number,
  material: THREE.MeshStandardMaterial,
  name: string,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(LIP_OVERHANG_METERS * 2, LIP_THICKNESS_METERS, length);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(xMax + LIP_OVERHANG_METERS * 0.5, cliffHeight - LIP_THICKNESS_METERS * 0.5, centerZ);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return mesh;
}

function buildWestLip(
  length: number,
  centerZ: number,
  xMin: number,
  cliffHeight: number,
  material: THREE.MeshStandardMaterial,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(LIP_OVERHANG_METERS * 2, LIP_THICKNESS_METERS, length);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'cliff-side-west-lip';
  mesh.position.set(xMin - LIP_OVERHANG_METERS * 0.5, cliffHeight - LIP_THICKNESS_METERS * 0.5, centerZ);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return mesh;
}

function buildNorthLip(
  length: number,
  centerX: number,
  zMin: number,
  cliffHeight: number,
  material: THREE.MeshStandardMaterial,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(length, LIP_THICKNESS_METERS, LIP_OVERHANG_METERS * 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'cliff-side-north-lip';
  mesh.position.set(centerX, cliffHeight - LIP_THICKNESS_METERS * 0.5, zMin - LIP_OVERHANG_METERS * 0.5);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return mesh;
}

type WallFacing = 'south' | 'east' | 'west' | 'north';

/**
 * Builds a single vertical PlaneGeometry quad with UVs scaled to repeat the painted
 * cliff strata at a fixed physical density, regardless of the wall's length.
 *
 * Plane defaults: width along X, height along Y, normal +Z. We rotate the geometry
 * so the normal points in the desired direction. UVs are scaled before any rotation
 * so that `u` maps to physical horizontal extent and `v` maps to physical height.
 */
function buildWallQuad(
  length: number,
  height: number,
  material: THREE.MeshStandardMaterial,
  name: string,
  facing: WallFacing,
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(length, height);

  const repeatU = Math.max(1, length / HORIZONTAL_TILE_SIZE_METERS);
  scaleUv(geometry, repeatU, VERTICAL_TILES);

  if (facing === 'east') {
    // Rotate the plane so its normal points along +X. After rotateY(+π/2), the original
    // X axis becomes -Z, so the wall extends along Z by `length` (centered on the mesh
    // position), and the normal is +X as desired.
    geometry.rotateY(Math.PI / 2);
  } else if (facing === 'west') {
    // Normal along -X (face the rest of the island). The wall extends along Z.
    geometry.rotateY(-Math.PI / 2);
  } else if (facing === 'north') {
    // Normal along -Z. The wall extends along X.
    geometry.rotateY(Math.PI);
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return mesh;
}

function scaleUv(geometry: THREE.PlaneGeometry, repeatU: number, repeatV: number) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, uv.getX(i) * repeatU, uv.getY(i) * repeatV);
  }
  uv.needsUpdate = true;
}
