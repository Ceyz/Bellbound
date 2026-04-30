import * as THREE from 'three';
import { applyAcnhLighting } from './acnhLighting';
import { applyTreeSwayShaderTo } from './treeSway';

interface Apple {
  mesh: THREE.Mesh;
  state: 'attached' | 'falling' | 'ground';
  velocity: THREE.Vector3;
  /** World-space Y the apple should rest at after gravity finishes — captured at detach time. */
  groundY: number;
  /** Tree-local offset baked into the attached geometry. Needed at detach to reconstruct the
   *  apple's rendered world position (mesh.position is (0,0,0) while attached). */
  localOffset: THREE.Vector3;
}

const APPLE_RADIUS = 0.12;
const APPLE_GRAVITY = 9.8;
const APPLE_PICKUP_DIST = 0.55;

/**
 * Three apple positions in tree-local mesh space. The Y values are all above the sway
 * mask threshold (1.3, see `treeSway.ts`) so the apples receive the full canopy bend
 * angle and visibly travel with the foliage.
 */
const APPLE_LOCAL_POSITIONS: Array<[number, number, number]> = [
  [-0.55, 1.65, 0.35],
  [0.6, 1.78, -0.32],
  [0.05, 1.95, 0.5],
];

/**
 * One geometry per apple slot, with the slot's local offset BAKED into the vertex
 * positions. This makes `position.y` in the vertex shader match the canopy's local Y
 * (≈1.65–1.95), so the same shader patch that rotates the canopy block also rotates
 * the apple — without baking, the sphere geometry would be centered on origin and the
 * Y mask would read ±0.12, snapping the mask to zero (no sway).
 *
 * All trees share these three geometries. The tradeoff: when an apple detaches, we
 * swap to the centered fall geometry below so its world position is independent of the
 * tree's transform.
 */
let attachedGeometries: THREE.SphereGeometry[] | null = null;
let fallGeometry: THREE.SphereGeometry | null = null;
let attachedMaterial: THREE.MeshStandardMaterial | null = null;
let fallMaterial: THREE.MeshStandardMaterial | null = null;

function getAssets() {
  if (!attachedGeometries) {
    attachedGeometries = APPLE_LOCAL_POSITIONS.map(([x, y, z]) => {
      const geom = new THREE.SphereGeometry(APPLE_RADIUS, 14, 10);
      geom.translate(x, y, z);
      geom.computeBoundingBox();
      geom.computeBoundingSphere();
      return geom;
    });
  }
  if (!fallGeometry) {
    fallGeometry = new THREE.SphereGeometry(APPLE_RADIUS, 14, 10);
  }
  if (!attachedMaterial) {
    attachedMaterial = new THREE.MeshStandardMaterial({
      color: 0xd83a2e,
      roughness: 0.62,
      metalness: 0,
    });
    applyTreeSwayShaderTo(attachedMaterial);
    applyAcnhLighting(attachedMaterial);
  }
  if (!fallMaterial) {
    fallMaterial = new THREE.MeshStandardMaterial({
      color: 0xd83a2e,
      roughness: 0.62,
      metalness: 0,
    });
    applyAcnhLighting(fallMaterial);
  }
  return {
    attachedGeometries,
    fallGeometry,
    attachedMaterial,
    fallMaterial,
  };
}

/**
 * Attach three apple meshes to the tree group. Idempotent: if `tree.userData.apples`
 * already exists, this is a no-op so callers can call freely after async loads.
 */
export function attachApplesToTree(tree: THREE.Object3D): void {
  if (tree.userData.apples) return;

  const assets = getAssets();
  const apples: Apple[] = [];
  for (let i = 0; i < APPLE_LOCAL_POSITIONS.length; i += 1) {
    const mesh = new THREE.Mesh(assets.attachedGeometries[i], assets.attachedMaterial);
    mesh.name = `${tree.name}-apple-${i + 1}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    tree.add(mesh);
    apples.push({
      mesh,
      state: 'attached',
      velocity: new THREE.Vector3(),
      groundY: 0,
      localOffset: new THREE.Vector3(...APPLE_LOCAL_POSITIONS[i]),
    });
  }
  tree.userData.apples = apples;
}

/**
 * Convert every still-attached apple on `tree` into a falling physics object reparented
 * under `scene`. Apples receive an outward velocity biased by the impact direction so
 * the player sees them shoot away from the side they bumped.
 *
 * Returns the number of apples detached (0 if the tree was already harvested).
 */
export function detachAttachedApples(
  tree: THREE.Object3D,
  scene: THREE.Object3D,
  impactDirX: number,
  impactDirZ: number,
): number {
  const apples: Apple[] | undefined = tree.userData.apples;
  if (!apples) return 0;
  const assets = getAssets();
  let detached = 0;

  for (const apple of apples) {
    if (apple.state !== 'attached') continue;

    // The attached geometry has the slot's offset baked into its vertex positions and
    // `mesh.position` is (0,0,0). To compute the apple's rendered world position we
    // transform the baked local offset through the tree's world matrix directly.
    tree.updateMatrixWorld(true);
    const worldPos = apple.localOffset.clone().applyMatrix4(tree.matrixWorld);

    tree.remove(apple.mesh);
    scene.add(apple.mesh);
    apple.mesh.geometry = assets.fallGeometry;
    apple.mesh.material = assets.fallMaterial;
    apple.mesh.position.copy(worldPos);

    const radialDx = worldPos.x - tree.position.x;
    const radialDz = worldPos.z - tree.position.z;
    const radialDist = Math.hypot(radialDx, radialDz) || 1;
    const radialNormX = radialDx / radialDist;
    const radialNormZ = radialDz / radialDist;

    const initialSpeedXZ = 1.6;
    const initialSpeedY = 1.9;
    apple.velocity.set(
      (radialNormX * 0.4 + impactDirX * 0.8) * initialSpeedXZ,
      initialSpeedY,
      (radialNormZ * 0.4 + impactDirZ * 0.8) * initialSpeedXZ,
    );
    apple.state = 'falling';
    // Snapshot the tree's current scene Y as the landing altitude. Apples don't roll
    // with the world, so they may visually drift from the tree's rolled altitude when
    // the player walks far away — acceptable for the harvest greybox phase since the
    // pickup proximity (0.55 m) keeps the player adjacent to the apple.
    apple.groundY = tree.position.y;
    detached += 1;
  }

  return detached;
}

interface AppleTickContext {
  scene: THREE.Object3D;
  playerPos: THREE.Vector3;
  trees: THREE.Object3D[];
  onPickup: () => void;
}

/**
 * Per-frame physics + pickup pass. Falling apples integrate gravity + air-free linear
 * motion until they hit `groundY`; grounded apples are removed from the scene the moment
 * the player walks within `APPLE_PICKUP_DIST`, calling `onPickup` once per pickup.
 */
export function tickApples(delta: number, ctx: AppleTickContext): void {
  for (const tree of ctx.trees) {
    const apples: Apple[] | undefined = tree.userData.apples;
    if (!apples) continue;

    for (let i = apples.length - 1; i >= 0; i -= 1) {
      const apple = apples[i];

      if (apple.state === 'falling') {
        apple.velocity.y -= APPLE_GRAVITY * delta;
        apple.mesh.position.x += apple.velocity.x * delta;
        apple.mesh.position.y += apple.velocity.y * delta;
        apple.mesh.position.z += apple.velocity.z * delta;

        const restY = apple.groundY + APPLE_RADIUS;
        if (apple.mesh.position.y <= restY) {
          apple.mesh.position.y = restY;
          apple.velocity.set(0, 0, 0);
          apple.state = 'ground';
        }
      }

      if (apple.state === 'ground') {
        const dx = ctx.playerPos.x - apple.mesh.position.x;
        const dz = ctx.playerPos.z - apple.mesh.position.z;
        if (Math.hypot(dx, dz) < APPLE_PICKUP_DIST) {
          ctx.scene.remove(apple.mesh);
          apples.splice(i, 1);
          ctx.onPickup();
        }
      }
    }
  }
}
