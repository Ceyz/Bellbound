import * as THREE from 'three';
import { HEIGHTMAP, riverCenterZ } from './heightmap';
import type { SurfaceTextureSet } from './proceduralTextures';

/**
 * Thin grass "lip" along both banks of the river S-curve. ACNH carves rivers with a
 * small earth/rock cliff face on each side and grass that overhangs the lip a few
 * centimeters — the same visual signature we already use for the cliff plateau, just
 * applied to a curved waterway.
 *
 * Implementation: split the river length into N short straight box segments, each
 * rotated to match the local tangent of `riverCenterZ(x) = 5 + 6 sin(0.08 x)`. A
 * single shared MeshStandardMaterial with the painted grass texture covers all 2 × N
 * boxes, so the only per-frame cost is `disableFrustumCullingRecursive` + the rolling
 * shader running on the shared material.
 */

const SEGMENTS = 24;
const LIP_THICKNESS_METERS = 0.07;
const LIP_OVERHANG_METERS = 0.13;
/** Slight lift above ground level to avoid z-fighting with the terrain at the bank. */
const LIP_TOP_Y = 0.006;

export function createRiverBankLip(surfaceTextures: SurfaceTextureSet): THREE.Group {
  const group = new THREE.Group();
  group.name = 'river-bank-lips';

  const material = new THREE.MeshStandardMaterial({
    map: surfaceTextures.grass,
    roughness: 0.92,
  });
  material.name = 'river-bank-lip-material';

  const xMin = HEIGHTMAP.RIVER_X_MIN;
  const xMax = HEIGHTMAP.RIVER_X_MAX;
  const segmentLength = (xMax - xMin) / SEGMENTS;

  for (let i = 0; i < SEGMENTS; i += 1) {
    const t = (i + 0.5) / SEGMENTS;
    const xCenter = xMin + (xMax - xMin) * t;
    const centerZ = riverCenterZ(xCenter);

    // Local tangent of the river centerline: dz/dx = 6 × 0.08 × cos(0.08 x).
    // Rotation is around Y so the box's long axis stays aligned with the bank curve.
    const dz = 6 * 0.08 * Math.cos(xCenter * 0.08);
    const segmentRotationY = -Math.atan2(dz, 1);

    for (const side of [-1, 1] as const) {
      const bankZ = centerZ + side * HEIGHTMAP.RIVER_HALF_WIDTH;
      const sideName = side > 0 ? 'south' : 'north';
      const lip = new THREE.Mesh(
        new THREE.BoxGeometry(segmentLength * 1.04, LIP_THICKNESS_METERS, LIP_OVERHANG_METERS),
        material,
      );
      lip.name = `river-bank-lip-${sideName}-${i}`;
      lip.position.set(
        xCenter,
        LIP_TOP_Y - LIP_THICKNESS_METERS * 0.5,
        bankZ - side * LIP_OVERHANG_METERS * 0.5,
      );
      lip.rotation.y = segmentRotationY;
      lip.castShadow = true;
      lip.receiveShadow = true;
      group.add(lip);
    }
  }

  return group;
}
