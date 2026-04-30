import * as THREE from 'three';
import {
  ISLAND_TERRAIN_DEPTH,
  ISLAND_TERRAIN_WIDTH,
  type CircleObstacle,
} from '../player/movement';
import {
  applyRollingShaderTo,
  disableFrustumCullingForRolling,
  disableFrustumCullingRecursive,
  updateRollingShaderUniforms,
  type RollingObject,
} from './rollingWorld';
import { createSurfaceMaps, type SurfaceMaps } from './surfaceMaps';
import { getTerrainGrid } from './terrain/TerrainGrid';
import { buildGroundMesh } from './terrain/groundMeshBuilder';
import { buildFreshwaterMesh } from './terrain/freshwaterMeshBuilder';
import {
  createFreshwaterStylizedMaterial,
  updateFreshwaterStylizedMaterial,
} from './terrain/freshwaterStylizedMaterial';
import type { SurfaceTextureSet } from './proceduralTextures';
import { loadSurfaceTextures } from './surfaceTextureLoader';
import { createTerrainSplatMaterial, updateTerrainSplatMaterial } from './terrainSplatMaterial';
import { applyAcnhLighting, applyAcnhLightingRecursive } from './acnhLighting';
import { createRiverBankLip } from './riverBankLip';
import { buildCliffSideMesh } from './terrain/cliffSideMeshBuilder';
import { createBeachWaveSystem, updateBeachWaveSystem, type BeachWaveSystem } from './beachWaveSystem';
import { createShoreWashSystem, updateShoreWashSystem, type ShoreWashSystem } from './shoreWashSystem';
import { createWaterStylizedMaterial, updateWaterStylizedMaterial } from './waterStylizedMaterial';
import { createPlayerSurfaceDecals, type PlayerSurfaceDecalState } from './playerSurfaceDecals';
import { createSkySystem, updateSkySystem, type SkySystem } from './skySystem';
import { computeTimeOfDay } from './dayNightCycle';

export interface IslandScene {
  ambient: THREE.HemisphereLight;
  beachWaves: BeachWaveSystem;
  camera: THREE.PerspectiveCamera;
  cliffSideWalls: THREE.Group;
  fog: THREE.Fog;
  ground: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  obstacles: CircleObstacle[];
  player: THREE.Group;
  playerBody: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  rollingObjects: RollingObject[];
  freshwater: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  scene: THREE.Scene;
  shoreWash: ShoreWashSystem;
  sky: SkySystem;
  sun: THREE.DirectionalLight;
  surfaceDecals: PlayerSurfaceDecalState;
  surfaceMaps: SurfaceMaps;
  surfaceTextures: SurfaceTextureSet;
  water: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
}

export interface IslandTickParams {
  playerSpeed: number;
  waveHeight: number;
  /** Day/night cycle position in [0, 1). 0 = midnight, 0.5 = noon. */
  timeOfDay: number;
}

const PLAYER_BODY_BASE_Y = 0.76;

const SUN_LIGHT_OFFSET = new THREE.Vector3(8, 11, 6);

export function createIslandScene(): IslandScene {
  const scene = new THREE.Scene();
  scene.name = 'bellbound-scene';
  scene.background = new THREE.Color(0xb0d8f0);
  const fog = new THREE.Fog(0xb0d8f0, 42, 82);
  scene.fog = fog;
  const surfaceMaps = createSurfaceMaps();
  const surfaceTextures = loadSurfaceTextures();

  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 130);
  camera.name = 'main-camera';
  camera.position.set(0, 8.2, 16.4);

  const ambient = new THREE.HemisphereLight(0xb8c8f5, 0x9ad08a, 1.65);
  ambient.name = 'ambient-sky';
  scene.add(ambient);

  const shadowFill = new THREE.HemisphereLight(0x9bb0e0, 0x9bb0e0, 0.22);
  shadowFill.name = 'shadow-fill-tint';
  scene.add(shadowFill);

  const sun = new THREE.DirectionalLight(0xfff0cf, 1.95);
  sun.name = 'main-sun';
  sun.position.copy(SUN_LIGHT_OFFSET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;

  sun.target.name = 'sun-target';
  scene.add(sun);
  scene.add(sun.target);

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
  water.position.y = -0.20;
  water.receiveShadow = true;
  scene.add(water);

  const groundMaterial = createTerrainSplatMaterial({ surfaceMaps, surfaceTextures });
  const ground = buildGroundMesh(getTerrainGrid(), groundMaterial);
  ground.receiveShadow = true;
  scene.add(ground);

  // Freshwater (river / pond) surface — separate mesh from the ocean plane,
  // one quad per FRESHWATER cell at its tier-specific water surface Y. Uses
  // the calm green palette + flow streaks shader, no foam / whitecaps / waves.
  const freshwaterMaterial = createFreshwaterStylizedMaterial();
  const freshwater = buildFreshwaterMesh(getTerrainGrid(), freshwaterMaterial);
  freshwater.receiveShadow = false;
  scene.add(freshwater);

  const cliffSideWalls = buildCliffSideMesh(getTerrainGrid(), surfaceTextures);
  scene.add(cliffSideWalls);

  const riverBankLips = createRiverBankLip(surfaceTextures);
  scene.add(riverBankLips);

  // Both shore-wave systems hidden during the Step 0→4 refactor. They
  // anchor on `sampleShoreAnchors()` (analytical SDF), so re-enabling either
  // would put the foam ribbon on the OLD curve while the visible coastline
  // is now grid-driven. The result was patches of fake foam appearing inland.
  // Step 6 of TERRAFORMING_REFACTO_PLAN.md re-anchors them on
  // `terrainGrid.forEachLandOceanEdge()` (helper added in Step 4) and re-
  // enables them. Until then the ocean reads as flatter at the coast (a known
  // visual regression that the user has accepted).
  const beachWaves = createBeachWaveSystem();
  beachWaves.mesh.visible = false;
  scene.add(beachWaves.mesh);

  const shoreWash = createShoreWashSystem();
  shoreWash.mesh.visible = false;
  scene.add(shoreWash.mesh);

  const obstacles: CircleObstacle[] = [];
  const rollingObjects: RollingObject[] = [];

  applyRollingShaderTo(ground.material);
  applyRollingShaderTo(water.material);
  applyRollingShaderTo(freshwater.material);
  disableFrustumCullingForRolling(ground);
  disableFrustumCullingForRolling(water);
  disableFrustumCullingForRolling(freshwater);

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

  disableCastShadowRecursive(cliffSideWalls);
  disableCastShadowRecursive(riverBankLips);

  applyAcnhLightingRecursive(cliffSideWalls);
  applyAcnhLightingRecursive(riverBankLips);

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
  // Spawn south of the river. Pre-cleanup the spawn was z=6.2 right on the bridge,
  // but with the hardcoded bridge removed (Step 0 of the terraforming refactor) any
  // z near 5 traps the player inside the river. z=10 sits cleanly south of it.
  player.position.set(0, 0, 10);
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
    freshwater,
    ground,
    obstacles,
    player,
    playerBody,
    rollingObjects,
    scene,
    shoreWash,
    sky,
    sun,
    surfaceDecals,
    surfaceMaps,
    surfaceTextures,
    water,
  };
}

function disableCastShadowRecursive(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = false;
    }
  });
}

export function updateIslandRollingWorld(island: IslandScene) {
  const originX = island.player.position.x;
  const originZ = island.player.position.z;

  updateRollingShaderUniforms(originX, originZ);

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
  updateFreshwaterStylizedMaterial(island.freshwater.material, elapsed);
  updateTerrainSplatMaterial(island.ground.material, elapsed);
  updateBeachWaveSystem(island.beachWaves, elapsed);
  updateShoreWashSystem(island.shoreWash, elapsed);

  const lighting = computeTimeOfDay(params.timeOfDay);

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

