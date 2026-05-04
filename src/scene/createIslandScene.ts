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
import { GRID_W, getTerrainGrid } from './terrain/TerrainGrid';
import { buildGroundMesh } from './terrain/groundMeshBuilder';
import { buildFreshwaterMesh } from './terrain/freshwaterMeshBuilder';
import {
  createFreshwaterStylizedMaterial,
  updateFreshwaterStylizedMaterial,
} from './terrain/freshwaterStylizedMaterial';
import {
  buildWaterfallMesh,
  buildWaterfallSplashMesh,
  buildWaterfallMistMesh,
} from './terrain/waterfallMeshBuilder';
import {
  createWaterfallStylizedMaterial,
  updateWaterfallStylizedMaterial,
} from './terrain/waterfallStylizedMaterial';
import {
  createWaterfallSplashMaterial,
  updateWaterfallSplashMaterial,
} from './terrain/waterfallSplashMaterial';
import {
  createWaterfallMistMaterial,
  updateWaterfallMistMaterial,
} from './terrain/waterfallMistMaterial';
import type { SurfaceTextureSet } from './proceduralTextures';
import { loadSurfaceTextures } from './surfaceTextureLoader';
import { createTerrainSplatMaterial, updateTerrainSplatMaterial } from './terrainSplatMaterial';
import { applyAcnhLighting, applyAcnhLightingRecursive } from './acnhLighting';
import { buildCliffSideMesh } from './terrain/cliffSideMeshBuilder';
import { createWaterStylizedMaterial, updateWaterStylizedMaterial } from './waterStylizedMaterial';
import { createPlayerSurfaceDecals, type PlayerSurfaceDecalState } from './playerSurfaceDecals';
import { createSkySystem, updateSkySystem, type SkySystem } from './skySystem';
import { computeTimeOfDay } from './dayNightCycle';

export interface IslandScene {
  ambient: THREE.HemisphereLight;
  camera: THREE.PerspectiveCamera;
  cliffSideWalls: THREE.Group;
  fog: THREE.Fog;
  ground: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  obstacles: CircleObstacle[];
  player: THREE.Group;
  playerBody: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  rollingObjects: RollingObject[];
  freshwater: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  waterfalls: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  waterfallSplashes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  waterfallMist: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  scene: THREE.Scene;
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
  // Lowered from -0.20 to -0.40 so the deeper beach drop (BEACH_LOWER_OFFSET_METERS = 0.30)
  // keeps dry sand above water surface — sand top sits at Y=-0.30, water at -0.40, 10cm clearance.
  water.position.y = -0.40;
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

  // Waterfalls — auto-generated vertical sheets at every grid edge where a
  // FRESHWATER cell drops to a lower neighbor. Dedicated shader: vertical
  // white streaks animated downward, crest foam at the top, pool mist at the
  // bottom. Reusing the calm freshwater material here read as a flat blue
  // curtain since calm water has none of those.
  const waterfallMaterial = createWaterfallStylizedMaterial();
  const waterfalls = buildWaterfallMesh(getTerrainGrid(), waterfallMaterial);
  waterfalls.receiveShadow = false;
  scene.add(waterfalls);

  // Horizontal splash discs at every cascade-into-pond foot. Animated
  // radial ripples + bright impact centre on the receiving water plane,
  // so the cascade reads as a real impact not a static stripe.
  const waterfallSplashMaterial = createWaterfallSplashMaterial();
  const waterfallSplashes = buildWaterfallSplashMesh(getTerrainGrid(), waterfallSplashMaterial);
  waterfallSplashes.receiveShadow = false;
  scene.add(waterfallSplashes);

  // Vertical mist plumes at each cascade foot — soft white haze rising
  // ~55 cm above the water surface, fading to transparent at the top.
  // Sells the splash's vertical energy (water blasted upward) — without
  // it the cascade impact reads as a flat puddle.
  const waterfallMistMaterial = createWaterfallMistMaterial();
  const waterfallMist = buildWaterfallMistMesh(getTerrainGrid(), waterfallMistMaterial);
  waterfallMist.receiveShadow = false;
  scene.add(waterfallMist);

  const cliffSideWalls = buildCliffSideMesh(getTerrainGrid(), surfaceTextures);
  scene.add(cliffSideWalls);

  // River bank lip mesh (the green grass strips along the river edges) was
  // removed at user request — same rationale as the cliff lips: the static
  // mesh did not move with player-edited water cells and read as glitchy
  // green bars floating along the banks. The module is kept for a future
  // grid-aware re-implementation. See memory/structure_gotchas.md.

  // Shore-wave systems (beachWaveSystem + shoreWashSystem) removed at user
  // request 2026-05-02. Their analytical SDF anchors were ~0.5 m off the
  // grid-quantized visible coastline, and grid-aligned anchors produced
  // visible polygonal artefacts (perpendicular normals at corner cells made
  // the wash strip read as cyan triangles tracing the stair-step).
  // Re-introduction needs a polygon-walk anchor builder with smoothed corner
  // normals — deferred until the visible LAND mesh itself is smoothed.
  // The source files src/scene/{beachWaveSystem,shoreWashSystem}.ts are
  // kept for reference but no longer instantiated.

  const obstacles: CircleObstacle[] = [];
  const rollingObjects: RollingObject[] = [];

  applyRollingShaderTo(ground.material);
  applyRollingShaderTo(water.material);
  applyRollingShaderTo(freshwater.material);
  applyRollingShaderTo(waterfalls.material);
  applyRollingShaderTo(waterfallSplashes.material);
  applyRollingShaderTo(waterfallMist.material);
  disableFrustumCullingForRolling(ground);
  disableFrustumCullingForRolling(water);
  disableFrustumCullingForRolling(freshwater);
  disableFrustumCullingForRolling(waterfalls);
  disableFrustumCullingForRolling(waterfallSplashes);
  disableFrustumCullingForRolling(waterfallMist);

  const cliffMaterials = new Set<THREE.Material>();
  cliffSideWalls.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) {
      cliffMaterials.add(child.material);
    }
  });
  for (const material of cliffMaterials) {
    applyRollingShaderTo(material);
  }
  disableFrustumCullingRecursive(cliffSideWalls);

  disableCastShadowRecursive(cliffSideWalls);

  applyAcnhLightingRecursive(cliffSideWalls);

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
    camera,
    cliffSideWalls,
    fog,
    freshwater,
    ground,
    obstacles,
    waterfalls,
    waterfallSplashes,
    waterfallMist,
    player,
    playerBody,
    rollingObjects,
    scene,
    sky,
    sun,
    surfaceDecals,
    surfaceMaps,
    surfaceTextures,
    water,
  };
}

/**
 * Rebuilds every grid-driven terrain artifact (ground mesh, cliff side mesh,
 * freshwater mesh, surface maps) from the current `getTerrainGrid()`. Called
 * after a TerraformTool edits the grid (Step 5+).
 *
 * Strategy: full rebuild MVP per plan §3.2. Geometries are disposed and
 * replaced; surface maps are rebaked at full 512² resolution and the
 * existing materials' uniform values are repointed to the new textures so
 * the shader programs don't recompile. Step 6+ optimizes via dirty-rect
 * partial rebuilds when the per-edit cost (~50ms estimated for 5k cells +
 * 262k surface-map texels) becomes a UX issue.
 */
export function rebuildTerrain(island: IslandScene): void {
  const grid = getTerrainGrid();

  // 1. Re-bake surface maps from the current grid.
  const newMaps = createSurfaceMaps();

  // 2. Repoint material uniforms to new textures.
  const groundUniforms = island.ground.material.userData.terrainUniforms as
    | Record<string, THREE.IUniform> | undefined;
  if (groundUniforms) {
    groundUniforms.uSplatMap.value = newMaps.splatMap;
    groundUniforms.uAoMap.value = newMaps.aoMap;
    groundUniforms.uCliffEdgeMap.value = newMaps.cliffEdgeMap;
    groundUniforms.uShoreMask.value = newMaps.shoreMask;
    groundUniforms.uShoreDistanceMap.value = newMaps.shoreDistanceMap;
    groundUniforms.uPathMask.value = newMaps.pathMask;
  }
  const waterUniforms = island.water.material.userData.waterUniforms as
    | Record<string, THREE.IUniform> | undefined;
  if (waterUniforms) {
    waterUniforms.uRiverMask.value = newMaps.riverMask;
    waterUniforms.uShoreDistanceMap.value = newMaps.shoreDistanceMap;
  }

  // 3. Dispose old surface map textures.
  const oldMaps = island.surfaceMaps;
  oldMaps.splatMap.dispose();
  oldMaps.aoMap.dispose();
  oldMaps.cliffEdgeMap.dispose();
  oldMaps.shoreMask.dispose();
  oldMaps.shoreDistanceMap.dispose();
  oldMaps.riverMask.dispose();
  oldMaps.oceanShoreMask.dispose();
  oldMaps.pathMask.dispose();
  island.surfaceMaps = newMaps;

  // 4. Rebuild ground + freshwater geometries in place (keep mesh refs and
  //    materials, just swap geometry).
  const oldGroundGeo = island.ground.geometry;
  const tmpGround = buildGroundMesh(grid, island.ground.material);
  island.ground.geometry = tmpGround.geometry;
  oldGroundGeo.dispose();

  const oldFwGeo = island.freshwater.geometry;
  const tmpFw = buildFreshwaterMesh(grid, island.freshwater.material);
  island.freshwater.geometry = tmpFw.geometry;
  oldFwGeo.dispose();

  // Waterfalls regenerate from the same forEachTierDiscontinuity iteration.
  const oldWfGeo = island.waterfalls.geometry;
  const tmpWf = buildWaterfallMesh(grid, island.waterfalls.material);
  island.waterfalls.geometry = tmpWf.geometry;
  oldWfGeo.dispose();

  // Splash discs follow the same iteration — one per cascade-into-pond foot.
  const oldSplashGeo = island.waterfallSplashes.geometry;
  const tmpSplash = buildWaterfallSplashMesh(grid, island.waterfallSplashes.material);
  island.waterfallSplashes.geometry = tmpSplash.geometry;
  oldSplashGeo.dispose();

  // Mist plumes follow the same iteration too.
  const oldMistGeo = island.waterfallMist.geometry;
  const tmpMist = buildWaterfallMistMesh(grid, island.waterfallMist.material);
  island.waterfallMist.geometry = tmpMist.geometry;
  oldMistGeo.dispose();

  // 5. Cliff side mesh: dispose all children + materials, then rebuild.
  for (const child of [...island.cliffSideWalls.children]) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (child.material instanceof THREE.Material) child.material.dispose();
    }
    island.cliffSideWalls.remove(child);
  }
  const newCliff = buildCliffSideMesh(grid, island.surfaceTextures);
  for (const child of [...newCliff.children]) {
    island.cliffSideWalls.add(child);
  }

  // 6. Re-apply rolling shader + ACNH lighting + shadow flags to the new cliff
  //    materials (the freshly created cliff side mesh has un-patched materials).
  const cliffMaterials = new Set<THREE.Material>();
  island.cliffSideWalls.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) {
      cliffMaterials.add(child.material);
    }
  });
  for (const material of cliffMaterials) {
    applyRollingShaderTo(material);
  }
  applyAcnhLightingRecursive(island.cliffSideWalls);
  island.cliffSideWalls.traverse((child) => {
    if (child instanceof THREE.Mesh) child.castShadow = false;
  });
  disableFrustumCullingRecursive(island.cliffSideWalls);

  // 7. Drain dirty rects from the grid so the next edit starts clean.
  grid.consumeDirtyRegions();
}

/**
 * Cheap partial update for path edits: rewrites one byte of the path-mask
 * texture and re-uploads. Avoids re-baking the 512² surface maps and
 * rebuilding ground/freshwater/waterfall/cliff geometry — none of which
 * change when only a path tile is painted or erased.
 *
 * Drag-paint strokes call this per cell instead of `rebuildTerrain`; what
 * was a multi-tens-of-ms hitch per tile becomes a single texSubImage upload.
 */
export function updatePathMaskCell(island: IslandScene, cx: number, cz: number): void {
  const grid = getTerrainGrid();
  if (!grid.cellInBounds(cx, cz)) return;
  const tex = island.surfaceMaps.pathMask;
  const data = tex.image.data as Uint8Array;
  data[cz * GRID_W + cx] = grid.getCell(cx, cz).path & 0x0F;
  tex.needsUpdate = true;
  // Drain only the path entry from the dirty rect tracker so a subsequent
  // geometry-changing edit doesn't see this cell as still pending.
  grid.consumeDirtyRegions();
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
  island.water.position.y = -0.40 + Math.sin(elapsed * 1.8) * params.waveHeight * 0.08;
  updateWaterStylizedMaterial(island.water.material, elapsed, params.waveHeight);
  // Compute lighting first so the freshwater shader can gate its
  // specular reflection blobs on uSunIntensity (no sun = no reflections,
  // matches real-world physics + the user's "qui apparaît pas la nuit"
  // note).
  const lighting = computeTimeOfDay(params.timeOfDay);
  updateFreshwaterStylizedMaterial(island.freshwater.material, elapsed, lighting.sunIntensity);
  updateWaterfallStylizedMaterial(island.waterfalls.material, elapsed);
  updateWaterfallSplashMaterial(island.waterfallSplashes.material, elapsed);
  updateWaterfallMistMaterial(island.waterfallMist.material, elapsed);
  updateTerrainSplatMaterial(island.ground.material, elapsed);

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

