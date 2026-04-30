import * as THREE from 'three';
import {
  BEACH_WIDTH,
  ISLAND_TERRAIN_DEPTH,
  ISLAND_TERRAIN_WIDTH,
  type CircleObstacle,
} from '../player/movement';
import { BRIDGE, HEIGHTMAP, STAIRCASE, getIslandHeight } from './heightmap';
import {
  applyRollingShaderTo,
  createRollingObject,
  disableFrustumCullingForRolling,
  disableFrustumCullingRecursive,
  updateRollingObject,
  updateRollingShaderUniforms,
  type RollingObject,
} from './rollingWorld';
import { classifySurfaceAt } from './surfaceClassification';
import { createSurfaceMaps, type SurfaceMaps } from './surfaceMaps';
import type { SurfaceTextureSet } from './proceduralTextures';
import { loadSurfaceTextures } from './surfaceTextureLoader';
import { createTerrainSplatMaterial, updateTerrainSplatMaterial } from './terrainSplatMaterial';
import { applyAcnhLighting, applyAcnhLightingRecursive } from './acnhLighting';
import { createCliffSideMesh } from './cliffSideMesh';
import { createRiverBankLip } from './riverBankLip';
import { createBeachWaveSystem, updateBeachWaveSystem, type BeachWaveSystem } from './beachWaveSystem';
import { createShoreWashSystem, updateShoreWashSystem, type ShoreWashSystem } from './shoreWashSystem';
import { createWaterStylizedMaterial, updateWaterStylizedMaterial } from './waterStylizedMaterial';
import { createPlayerSurfaceDecals, type PlayerSurfaceDecalState } from './playerSurfaceDecals';
import { createSkySystem, updateSkySystem, type SkySystem } from './skySystem';
import { computeTimeOfDay } from './dayNightCycle';
import { createFruitTreeGroup } from './treeAsset';
import { updateTreeShake, updateTreeSwayUniforms } from './treeSway';

export interface IslandScene {
  ambient: THREE.HemisphereLight;
  beachWaves: BeachWaveSystem;
  camera: THREE.PerspectiveCamera;
  cliffSideWalls: THREE.Group;
  fog: THREE.Fog;
  ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  house: THREE.Group;
  obstacles: CircleObstacle[];
  player: THREE.Group;
  playerBody: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  rollingObjects: RollingObject[];
  scene: THREE.Scene;
  shopCounter: THREE.Group;
  shoreWash: ShoreWashSystem;
  sky: SkySystem;
  sun: THREE.DirectionalLight;
  surfaceDecals: PlayerSurfaceDecalState;
  surfaceMaps: SurfaceMaps;
  surfaceTextures: SurfaceTextureSet;
  trees: THREE.Group[];
  water: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
}

export interface IslandTickParams {
  playerSpeed: number;
  waveHeight: number;
  /** Day/night cycle position in [0, 1). 0 = midnight, 0.5 = noon. */
  timeOfDay: number;
}

const PLAYER_BODY_BASE_Y = 0.76;
const VISUAL_TERRAIN_WIDTH = ISLAND_TERRAIN_WIDTH + 36;
const VISUAL_TERRAIN_DEPTH = ISLAND_TERRAIN_DEPTH + 36;
const VISUAL_TERRAIN_SEGMENTS_X = 320;
const VISUAL_TERRAIN_SEGMENTS_Z = 276;

/**
 * Offset of the sun light (and shadow camera) from its target. The target is updated
 * each frame to the player's XZ position, so the shadow frustum follows the player.
 * Keeping this offset constant preserves the direction of the light (same shadows).
 */
const SUN_LIGHT_OFFSET = new THREE.Vector3(8, 11, 6);

/** Replace a flat (x, 0, z) tuple with the actual heightmap altitude at that XZ. */
function placeOnHeightmap(pos: [number, number, number]): [number, number, number] {
  return [pos[0], getIslandHeight(pos[0], pos[2]), pos[2]];
}

export function createIslandScene(): IslandScene {
  const scene = new THREE.Scene();
  scene.name = 'bellbound-scene';
  // Background color is now driven each frame by the day/night cycle (the sky
  // dome handles the visible sky, but `scene.background` still applies on
  // pixels not covered by the dome — e.g. when the camera is briefly outside
  // the dome radius). Initial color matches the noon horizon so boot frame
  // doesn't flash a bad value before the first tick.
  scene.background = new THREE.Color(0xb0d8f0);
  const fog = new THREE.Fog(0xb0d8f0, 42, 82);
  scene.fog = fog;
  const surfaceMaps = createSurfaceMaps();
  const surfaceTextures = loadSurfaceTextures();

  // FOV 35° (narrower than the previous 40°) — ACNH-style perspective.
  // Pitch 0.42 rad (24°) and distance 18 m hypotenuse, computed in main.ts updateCamera.
  // This initial position is overridden on first frame by updateCamera() — kept close to
  // the steady-state value (height ≈ sin(0.42) × 18 ≈ 7.3 + focus offset 0.86 ≈ 8.2;
  // depth ≈ cos(0.42) × 18 ≈ 16.4) to avoid a visible camera snap on boot.
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 130);
  camera.name = 'main-camera';
  camera.position.set(0, 8.2, 16.4);

  // Hemisphere light tuned for ACNH-style tinted shadows: a more saturated lavender-
  // blue sky color fills the shadowed side of every object so the shadows read as
  // tinted instead of pure black/grey. Intensity bumped slightly so the fill is
  // perceptible against the directional sun. Ground bounce kept warm-green for the
  // lush cozy ambience.
  const ambient = new THREE.HemisphereLight(0xb8c8f5, 0x9ad08a, 1.65);
  ambient.name = 'ambient-sky';
  scene.add(ambient);

  // Secondary cool fill: a dim wide hemisphere of cool blue, tints the shadow side
  // of objects further. Kept low intensity — the directional sun stays the primary
  // illuminant, this just lifts pitch-black shadows to a soft blue-violet.
  const shadowFill = new THREE.HemisphereLight(0x9bb0e0, 0x9bb0e0, 0.22);
  shadowFill.name = 'shadow-fill-tint';
  scene.add(shadowFill);

  // Sun + shadow setup. The shadow camera is intentionally SMALL (24×24 m frustum) and
  // **follows the player** every frame via `updateSunFollowsPlayer`. A tight frustum
  // gives much better shadow resolution per pixel than a static large one. The light
  // direction is preserved because we move BOTH `sun.position` and `sun.target` by the
  // same offset (= the player's XZ position).
  // Slightly reduced sun intensity so the brighter ambient doesn't blow out the lit side.
  const sun = new THREE.DirectionalLight(0xfff0cf, 1.95);
  sun.name = 'main-sun';
  sun.position.copy(SUN_LIGHT_OFFSET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Wider shadow frustum (40×40 instead of 24×24) so the bridge, staircase, and farther
  // landmarks keep casting shadows when the player walks across the island. Per-pixel
  // resolution drops accordingly (40 m / 2048 px ≈ 2 cm/px) but stays sharp enough for
  // the cozy camera distance.
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0005; // anti shadow-acne on the (mostly flat) ground
  sun.shadow.normalBias = 0.04;

  // Three.js DirectionalLight requires the target Object3D to be in the scene graph for
  // its world matrix to update. Without scene.add(sun.target), shadow direction is wrong.
  sun.target.name = 'sun-target';
  scene.add(sun);
  scene.add(sun.target);

  // Sky dome — a procedural gradient + sun disc overlay rendered as the scene
  // background. Updated each frame from the day/night cycle (sun direction +
  // palette colors) so dawn/dusk/night look natural.
  const sky = createSkySystem();
  scene.add(sky.mesh);

  const waterGeometry = new THREE.PlaneGeometry(
    ISLAND_TERRAIN_WIDTH + 36,
    ISLAND_TERRAIN_DEPTH + 36,
    256,
    220,
  );
  waterGeometry.rotateX(-Math.PI / 2);

  const water = new THREE.Mesh(
    waterGeometry,
    createWaterStylizedMaterial({ surfaceMaps }),
  );
  water.name = 'water-ring';
  // Sits at -0.20 m, just below the deepest sand altitude (BEACH_DIP = 0.18 m gives
  // a min sand altitude of -0.18 m). This keeps the visible water-sand boundary at
  // the SDF=0 line without submerging any beach area, AND keeps decor structures
  // like the bridge (surface at +0.05) and staircase at a natural visual gap above
  // the water (~25 cm) so they don't read as floating when seen at distance.
  water.position.y = -0.20;
  water.receiveShadow = true;
  scene.add(water);

  const groundMaterial = createTerrainSplatMaterial({ surfaceMaps, surfaceTextures });
  const ground = createTerrain(groundMaterial);
  ground.name = 'greybox-ground';
  ground.receiveShadow = true;
  scene.add(ground);

  // No external shore plane: the SDF terrain now discards fragments outside the island
  // silhouette, and the water mesh extends well past the terrain bounds (116 × 100 m),
  // so the void around the island reads as ocean directly. The previous rectangular
  // sand-boundary plane was leaking as a dark band at the horizon now that the island
  // is no longer rectangular itself.

  // Static placements use the heightmap baseline so cliff-tier objects sit on the cliff
  // and ground-tier objects sit at sea level. The cliff plateau (NW) lifts the house +1m;
  // see `heightmap.ts` for bounds.
  const housePos: [number, number, number] = [-22.5, 0, -16.2];
  housePos[1] = getIslandHeight(housePos[0], housePos[2]);
  const house = createHouse();
  house.name = 'placeholder-house';
  house.position.set(...housePos);
  scene.add(house);

  const shopPos: [number, number, number] = [22.8, 0, -12.8];
  shopPos[1] = getIslandHeight(shopPos[0], shopPos[2]);
  const shopCounter = createShopCounter();
  shopCounter.name = 'placeholder-shop-counter';
  shopCounter.position.set(...shopPos);
  shopCounter.rotation.y = -0.18;
  scene.add(shopCounter);

  // fruit-tree-3 moved from (25.8, 0, 9.1) → (25.8, 0, 3.4): the original Z=9.1 lands
  // inside the new river S-curve and would have spawned the tree underwater.
  const trees = [
    createFruitTree('fruit-tree-1', placeOnHeightmap([-25.5, 0, 9.8])),
    createFruitTree('fruit-tree-2', placeOnHeightmap([0.8, 0, 18.4])),
    createFruitTree('fruit-tree-3', placeOnHeightmap([25.8, 0, 3.4])),
  ];

  const bridge = createBridge();
  scene.add(bridge);

  const staircase = createStaircase();
  scene.add(staircase);

  const cliffSideWalls = createCliffSideMesh(surfaceTextures);
  scene.add(cliffSideWalls);

  const riverBankLips = createRiverBankLip(surfaceTextures);
  scene.add(riverBankLips);

  const beachWaves = createBeachWaveSystem();
  beachWaves.mesh.visible = false;
  scene.add(beachWaves.mesh);

  // Re-enabled: shoreWashSystem owns the "wandering blue light" effect via
  // vLocalRunup — multiple pulses at different speeds/directions traversing the
  // shore ring, max-combined so two pulses meeting visually fuse into a
  // brighter patch. Tinted toward clearThinWater/shallowWater (see
  // shoreWashSystem.ts:364-366).
  const shoreWash = createShoreWashSystem();
  shoreWash.mesh.visible = true;
  scene.add(shoreWash.mesh);

  for (const tree of trees) {
    scene.add(tree);
  }

  const obstacles: CircleObstacle[] = [
    { name: 'house', x: house.position.x, z: house.position.z, radius: 1.75 },
    { name: 'shop-counter', x: shopCounter.position.x, z: shopCounter.position.z, radius: 1.1 },
    ...trees.map((tree) => ({
      name: tree.name,
      x: tree.position.x,
      z: tree.position.z,
      radius: 0.78,
    })),
  ];

  // CPU-rolled rigid objects: house, shop, trees. Their geometry is treated as a
  // single point (the group origin) and translated by the parabolic warp at that
  // point. Bridge + staircase are NOT in this list — they're long enough that a
  // single-point translation diverges from the per-vertex GPU warp on the terrain
  // beneath them, so they would partially clip into the curved ground at distance.
  // Instead we apply `applyRollingShaderTo` to their materials below for true
  // per-vertex GPU warp (same formula as the terrain shader).
  const rollingObjects = [
    createRollingObject(house),
    createRollingObject(shopCounter),
    ...trees.map((tree) => createRollingObject(tree)),
  ];

  // GPU-side curvature warp: applied directly to the surface materials' vertex shader.
  // Replaces the previous CPU-side `prepareRollingSurface`/`updateRollingSurface` pair,
  // saving ~28K vertex updates per frame on the CPU. The shader uses shared uniforms
  // synced once per frame in `updateIslandRollingWorld`.
  applyRollingShaderTo(ground.material);
  applyRollingShaderTo(water.material);
  disableFrustumCullingForRolling(ground);
  disableFrustumCullingForRolling(water);

  // Cliff side walls and grass lips each have their own MeshStandardMaterial. Both
  // need the rolling shader so their geometry follows the curved world — without it,
  // the lip stays at flat Y while the plateau warps down at distance and reads as a
  // floating green ribbon hanging in mid-air.
  const cliffMaterials = new Set<THREE.MeshStandardMaterial>();
  cliffSideWalls.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
      cliffMaterials.add(child.material);
    }
  });
  for (const material of cliffMaterials) {
    applyRollingShaderTo(material);
  }
  disableFrustumCullingRecursive(cliffSideWalls);

  // Bridge + staircase: per-vertex GPU rolling. Each Mesh inside these groups gets
  // its own MeshStandardMaterial patched, so the deck, rails, and ramp geometry
  // curve along with the terrain instead of staying rigidly flat.
  applyRollingToAllMeshMaterials(bridge);
  applyRollingToAllMeshMaterials(staircase);

  // GPU-warped meshes cannot cast shadows correctly: Three.js's shadow pass uses an
  // unpatched MeshDepthMaterial that ignores our rolling-warp vertex shader, so the
  // depth map is generated from the FLAT geometry while the visible mesh is warped.
  // The result is a "ghost shadow" that lands on the terrain at the wrong place. We
  // disable shadow casting on every GPU-warped descendant — the player still casts a
  // shadow (CPU-positioned), and CPU-rolled props (house, shop, trees) keep theirs
  // because their depth pass picks up the same group transform as the visible pass.
  disableCastShadowRecursive(bridge);
  disableCastShadowRecursive(staircase);
  disableCastShadowRecursive(cliffSideWalls);
  disableCastShadowRecursive(riverBankLips);

  // Composite groups (bridge with deck+rails, staircase prism, house cube+roof+door,
  // shop counter, fruit trees with trunk+foliage+fruits) all participate in the rolling
  // world via their `flatPosition` offset. Three.js culls per-mesh, so disabling the
  // group root is not enough — every descendant Mesh must be flagged or it disappears
  // from view at moderate distance under the parabolic warp.
  disableFrustumCullingRecursive(bridge);
  disableFrustumCullingRecursive(staircase);
  disableFrustumCullingRecursive(house);
  disableFrustumCullingRecursive(shopCounter);
  for (const tree of trees) {
    disableFrustumCullingRecursive(tree);
  }

  // ACNH-style stylized lighting: rim highlight at silhouettes + cool blue-violet
  // shadow tint. Applied to all decor groups (house, shop, trees, bridge, staircase,
  // cliff walls, river bank lips, player capsule) so the scene reads as a collection
  // of "small figurines" popping from the background. NOT applied to the terrain
  // ground itself — terrain has its own complex splat shader and rim/shadow accents
  // would muddy the surface gradient. The water and shore-wash also stay untouched
  // (they manage their own stylization).
  applyAcnhLightingRecursive(house);
  applyAcnhLightingRecursive(shopCounter);
  applyAcnhLightingRecursive(bridge);
  applyAcnhLightingRecursive(staircase);
  applyAcnhLightingRecursive(cliffSideWalls);
  applyAcnhLightingRecursive(riverBankLips);
  for (const tree of trees) {
    applyAcnhLightingRecursive(tree);
  }

  // River bank lips share a single material — patch it once, then disable culling on
  // every box segment. Geometry-warped by the rolling shader so the strip follows the
  // curved sea horizon at distance.
  const riverBankMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
  riverBankLips.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
      riverBankMeshes.push(child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>);
    }
  });
  if (riverBankMeshes.length > 0) {
    applyRollingShaderTo(riverBankMeshes[0].material);
  }
  disableFrustumCullingRecursive(riverBankLips);

  const player = new THREE.Group();
  player.name = 'greybox-player';
  player.position.set(0, 0, 6.2);
  scene.add(player);

  const playerBody = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.34, 0.84, 8, 18),
    new THREE.MeshStandardMaterial({ color: 0xe8a860, roughness: 0.78 }),
  );
  playerBody.name = 'player-capsule';
  playerBody.position.y = PLAYER_BODY_BASE_Y;
  playerBody.castShadow = true;
  playerBody.receiveShadow = true;
  player.add(playerBody);

  const faceMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.105, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xfff8f0, roughness: 0.7 }),
  );
  faceMarker.name = 'player-facing-marker';
  faceMarker.position.set(0, PLAYER_BODY_BASE_Y + 0.18, 0.31);
  faceMarker.castShadow = true;
  player.add(faceMarker);

  // Stylized rim + shadow tint on the greybox player capsule (visible until the
  // VRM character finishes loading). The VRM material pipeline is separate
  // (MToon) and untouched here.
  applyAcnhLighting(playerBody.material);
  applyAcnhLighting(faceMarker.material);

  const groundShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.42, 24),
    new THREE.MeshBasicMaterial({
      color: 0x6b4f3e,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  );
  groundShadow.name = 'player-soft-shadow';
  groundShadow.rotation.x = -Math.PI / 2;
  groundShadow.position.y = 0.012;
  player.add(groundShadow);

  const surfaceDecals = createPlayerSurfaceDecals(scene, player.position);

  return {
    ambient,
    beachWaves,
    camera,
    cliffSideWalls,
    fog,
    ground,
    house,
    obstacles,
    player,
    playerBody,
    rollingObjects,
    scene,
    shopCounter,
    shoreWash,
    sky,
    sun,
    surfaceDecals,
    surfaceMaps,
    surfaceTextures,
    trees,
    water,
  };
}

/**
 * Walks the tree under `root` and turns off `castShadow` on every Mesh. Used for
 * objects whose vertex positions are warped at draw time by the rolling shader; the
 * Three.js shadow pass would otherwise project a shadow from their un-warped flat
 * geometry, producing a ghost that lands away from the visible mesh.
 */
function disableCastShadowRecursive(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = false;
    }
  });
}

/**
 * Patches every unique `MeshStandardMaterial` reachable from `root` with the
 * rolling-world vertex warp. Iterates by material instance (de-duplicated via a Set)
 * so a material shared across multiple Mesh children gets patched exactly once.
 */
function applyRollingToAllMeshMaterials(root: THREE.Object3D): void {
  const materials = new Set<THREE.MeshStandardMaterial>();
  root.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
      materials.add(child.material);
    }
  });
  for (const material of materials) {
    applyRollingShaderTo(material);
  }
}

export function updateIslandRollingWorld(island: IslandScene) {
  const originX = island.player.position.x;
  const originZ = island.player.position.z;

  // GPU surfaces: a single uniform sync (cheap O(1)).
  updateRollingShaderUniforms(originX, originZ);

  // CPU-side warp for the few discrete objects (house, shop, trees) — keeps them aligned
  // with the warped ground without warping their geometry.
  for (const rollingObject of island.rollingObjects) {
    updateRollingObject(rollingObject, originX, originZ);
  }

  // Sun shadow target tracks the player so the small shadow frustum (40 × 40 m)
  // always covers the visible area. The sun POSITION is driven each frame by
  // `tickIslandScene` (day/night cycle), which rotates around the world based
  // on time-of-day rather than staying at a constant offset.
  island.sun.target.position.set(originX, 0, originZ);
  island.sun.target.updateMatrixWorld();
}

export function tickIslandScene(
  island: IslandScene,
  elapsed: number,
  params: IslandTickParams,
) {
  const moving = params.playerSpeed > 0.1;
  const bobSpeed = moving ? 9.5 : 2.2;
  const bobHeight = moving ? 0.035 : 0.012;

  island.playerBody.position.y = PLAYER_BODY_BASE_Y + Math.sin(elapsed * bobSpeed) * bobHeight;
  island.water.position.y = -0.20 + Math.sin(elapsed * 1.8) * params.waveHeight * 0.08;
  updateWaterStylizedMaterial(island.water.material, elapsed, params.waveHeight);
  updateTerrainSplatMaterial(island.ground.material, elapsed);
  updateBeachWaveSystem(island.beachWaves, elapsed);
  updateShoreWashSystem(island.shoreWash, elapsed);

  // Tree wind sway (cheap O(1) uniform sync) + per-tree shake decay (only the trees
  // actively wobbling have a non-empty `userData.shakeState`; the rest early-return).
  updateTreeSwayUniforms(elapsed);
  for (const tree of island.trees) {
    updateTreeShake(tree, elapsed);
  }

  // Day/night cycle: drive sun direction/color/intensity, sky gradient, fog,
  // and ambient hemisphere light from a single time-of-day scalar.
  const lighting = computeTimeOfDay(params.timeOfDay);

  // Sun position drives the DirectionalLight shadow direction. The Y component
  // is clamped to a minimum elevation (= sin(28°) ≈ 0.47) so shadows stay
  // bounded — without the clamp, near sunrise/sunset the shadow direction
  // becomes nearly horizontal, projecting shadows far past the 40 m shadow
  // frustum (the "ombre gigantesque" symptom). The sky shader still uses the
  // un-clamped direction so the sun disc and sunset glow sit at the visually
  // correct angle.
  const sunDistance = 40;
  const minSunY = 0.47;
  const shadowDirY = Math.max(lighting.sunDirection.y, minSunY);
  island.sun.position.set(
    island.player.position.x + lighting.sunDirection.x * sunDistance,
    shadowDirY * sunDistance,
    island.player.position.z + lighting.sunDirection.z * sunDistance,
  );
  island.sun.color.copy(lighting.sunColor);
  island.sun.intensity = lighting.sunIntensity;

  island.ambient.color.copy(lighting.ambientSkyColor);
  island.ambient.groundColor.copy(lighting.ambientGroundColor);
  island.ambient.intensity = lighting.ambientIntensity;

  island.fog.color.copy(lighting.fogColor);
  island.fog.near = lighting.fogNear;
  island.fog.far = lighting.fogFar;
  if (island.scene.background instanceof THREE.Color) {
    island.scene.background.copy(lighting.fogColor);
  }

  // Sky dome follows the camera so its 100 m radius surface stays the same
  // distance away regardless of where the player walks. Without this, walking
  // past sphere-center-relative ~30 m would push the far half of the dome past
  // the 130 m camera far plane and clip the cloud shader away.
  island.sky.mesh.position.copy(island.camera.position);

  updateSkySystem(island.sky, {
    sunDirection: lighting.sunDirection,
    sunColor: lighting.sunColor,
    zenithColor: lighting.skyZenithColor,
    horizonColor: lighting.skyHorizonColor,
    sunsetColor: lighting.sunsetColor,
    sunsetMix: lighting.sunsetMix,
    sunDiscIntensity: lighting.sunDiscIntensity,
    cloudColor: lighting.cloudColor,
    cloudOpacity: lighting.cloudOpacity,
    elapsed,
  });
}

function createTerrain(material: THREE.MeshStandardMaterial) {
  const geometry = new THREE.PlaneGeometry(
    VISUAL_TERRAIN_WIDTH,
    VISUAL_TERRAIN_DEPTH,
    VISUAL_TERRAIN_SEGMENTS_X,
    VISUAL_TERRAIN_SEGMENTS_Z,
  );
  const position = geometry.attributes.position;

  // PlaneGeometry vertices live in the XY plane (Z=0) BEFORE the rotateX(-π/2).
  // After rotation: world X = pre X, world Y = pre Z, world Z = -pre Y.
  // To set altitude (world Y), we modify pre-rotation Z.
  // To compute world Z for the heightmap lookup, we use -preY.
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const preY = position.getY(index);
    const worldZ = -preY;

    const surface = classifySurfaceAt(x, worldZ);
    position.setZ(index, getVisualTerrainHeight(surface));
  }

  geometry.computeVertexNormals();
  geometry.rotateX(-Math.PI / 2);

  return new THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>(geometry, material);
}

function getVisualTerrainHeight(surface: ReturnType<typeof classifySurfaceAt>) {
  if (surface.isInIsland) {
    return surface.altitude;
  }

  // Offshore vertices held at the shoreline altitude (= the deepest beach altitude
  // -BEACH_DIP = -0.18 m). Reason: the splat shader discards every fragment past
  // SDF=0, so offshore fragments are invisible — but triangles that STRADDLE the
  // shore still interpolate vertex altitudes across their interior. If offshore
  // vertices sat below shoreline altitude (the previous -0.365 → -0.80 m shelf),
  // the visible inland portion of each straddling triangle dipped toward that
  // deeper offshore vertex along its interior edge, producing a visible sawtooth
  // at the mesh tessellation pitch (~0.36 m / segment) right at the shoreline.
  // Holding offshore at the shoreline altitude keeps every straddling triangle
  // flat so the discard cuts a clean silhouette without dipped interior edges.
  return -0.18;
}

function createHouse() {
  const house = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.8, 1.9, 2.35),
    new THREE.MeshStandardMaterial({ color: 0xf5ead8, roughness: 0.82 }),
  );
  body.name = 'house-cube';
  body.position.y = 0.95;
  body.castShadow = true;
  body.receiveShadow = true;
  house.add(body);

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(2.15, 0.95, 4),
    new THREE.MeshStandardMaterial({ color: 0xd4794a, roughness: 0.78 }),
  );
  roof.name = 'house-roof-marker';
  roof.position.y = 2.38;
  roof.rotation.y = Math.PI * 0.25;
  roof.castShadow = true;
  house.add(roof);

  // Door wrapped in a pivot Group so a `rotation.y` tween swings the door around its
  // hinge (left side) instead of its center. The door mesh itself is offset to the right
  // of the pivot by half its width.
  const doorWidth = 0.58;
  const doorPivot = new THREE.Group();
  doorPivot.name = 'house-door-pivot';
  doorPivot.position.set(-doorWidth / 2, 0, 1.205);
  house.add(doorPivot);

  const door = new THREE.Mesh(
    new THREE.BoxGeometry(doorWidth, 0.9, 0.06),
    new THREE.MeshStandardMaterial({ color: 0xa07850, roughness: 0.82 }),
  );
  door.name = 'house-door-marker';
  door.position.set(doorWidth / 2, 0.48, 0);
  door.castShadow = true;
  doorPivot.add(door);

  return house;
}

/**
 * Returns a tree Group at `position`. Backed by the shared Meshy GLB template (loaded
 * once and cloned). The Group is empty on return and populated when the GLB load resolves;
 * collision data and rolling-world wiring depend only on `tree.position`, so they are wired
 * up correctly even before the visual meshes appear.
 *
 * The template's materials carry the wind-sway vertex patch and the ACNH fragment patch
 * baked in, so callers do NOT need to call `applyAcnhLightingRecursive(tree)` afterward —
 * the existing call site is a no-op for the empty group and is safe to leave in place.
 */
export function createFruitTree(name: string, position: [number, number, number]) {
  return createFruitTreeGroup(name, position);
}

export function createRock(name: string, position: [number, number, number]) {
  const rock = new THREE.Group();
  rock.name = name;
  rock.position.set(...position);

  // Two stacked icosahedrons with slight scale jitter for a chunky chibi rock.
  const body = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.62, 0),
    new THREE.MeshStandardMaterial({ color: 0xb8956a, roughness: 0.92 }),
  );
  body.name = `${name}-body`;
  body.position.y = 0.45;
  body.scale.set(1.05, 0.78, 1.0);
  body.rotation.y = 0.4;
  body.castShadow = true;
  body.receiveShadow = true;
  rock.add(body);

  const cap = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.32, 0),
    new THREE.MeshStandardMaterial({ color: 0xc8c0b0, roughness: 0.84 }),
  );
  cap.name = `${name}-cap`;
  cap.position.set(-0.08, 0.86, 0.04);
  cap.scale.set(0.95, 0.6, 0.95);
  cap.rotation.y = -0.3;
  cap.castShadow = true;
  rock.add(cap);

  return rock;
}

function createStaircase() {
  const stair = new THREE.Group();
  stair.name = 'placeholder-staircase';

  // Solid wedge: a triangular prism whose top face is the slope from the cliff edge
  // (X=xTop, y=CLIFF_TIER_HEIGHT) down to sea level (X=xBottom, y=0). The bottom face
  // sits flush with the ground (y=0), so visually the ramp is "filled in" instead of
  // floating like a tilted plank.
  const slopeShape = new THREE.Shape();
  slopeShape.moveTo(0, 0);                                // bottom-left (cliff-side, ground level)
  slopeShape.lineTo(STAIRCASE.length, 0);                 // bottom-right (sea-side, ground level)
  slopeShape.lineTo(0, HEIGHTMAP.CLIFF_TIER_HEIGHT);      // top-left (cliff-side, cliff height)
  slopeShape.closePath();

  const geometry = new THREE.ExtrudeGeometry(slopeShape, {
    depth: STAIRCASE.width,
    bevelEnabled: false,
  });
  // Center the extruded prism along Z so position.z = STAIRCASE.zCenter centers the wedge.
  geometry.translate(0, 0, -STAIRCASE.width / 2);

  const ramp = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0xc4956a, roughness: 0.86 }),
  );
  ramp.name = 'staircase-deck';
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  stair.add(ramp);

  // Anchor at the cliff edge corner at ground level. Local (0, 0) → world (xTop, 0, zCenter).
  stair.position.set(STAIRCASE.xTop, 0, STAIRCASE.zCenter);

  return stair;
}

function createBridge() {
  const bridge = new THREE.Group();
  bridge.name = 'placeholder-bridge';
  bridge.position.set(BRIDGE.x, BRIDGE.surfaceY, BRIDGE.z);

  // Wooden plank deck spanning the river along Z (north-south).
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(BRIDGE.width, BRIDGE.thickness, BRIDGE.length),
    new THREE.MeshStandardMaterial({ color: 0xa07850, roughness: 0.78 }),
  );
  deck.name = 'bridge-deck';
  deck.castShadow = true;
  deck.receiveShadow = true;
  bridge.add(deck);

  const railHeight = 0.5;
  const railThickness = 0.08;
  const railMaterial = new THREE.MeshStandardMaterial({ color: 0xc4956a, roughness: 0.82 });

  const railGeometry = new THREE.BoxGeometry(railThickness, railHeight, BRIDGE.length);
  const railLeft = new THREE.Mesh(railGeometry, railMaterial);
  railLeft.name = 'bridge-rail-left';
  railLeft.position.set(
    -BRIDGE.halfWidth + railThickness / 2,
    railHeight / 2 + BRIDGE.thickness / 2,
    0,
  );
  railLeft.castShadow = true;
  bridge.add(railLeft);

  const railRight = new THREE.Mesh(railGeometry, railMaterial);
  railRight.name = 'bridge-rail-right';
  railRight.position.set(
    BRIDGE.halfWidth - railThickness / 2,
    railHeight / 2 + BRIDGE.thickness / 2,
    0,
  );
  railRight.castShadow = true;
  bridge.add(railRight);

  return bridge;
}

function createShopCounter() {
  const counter = new THREE.Group();

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.95, 1),
    new THREE.MeshStandardMaterial({ color: 0xd4a878, roughness: 0.82 }),
  );
  base.name = 'shop-counter-cube';
  base.position.y = 0.48;
  base.castShadow = true;
  base.receiveShadow = true;
  counter.add(base);

  const awning = new THREE.Mesh(
    new THREE.BoxGeometry(2.45, 0.16, 1.18),
    new THREE.MeshStandardMaterial({ color: 0xe89850, roughness: 0.76 }),
  );
  awning.name = 'shop-counter-top';
  awning.position.y = 1.05;
  awning.castShadow = true;
  counter.add(awning);

  return counter;
}
