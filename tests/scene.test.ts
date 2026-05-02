import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createIslandScene, tickIslandScene } from '../src/scene/createIslandScene';
import {
  GROUND_HALF_DEPTH,
  GROUND_HALF_WIDTH,
  ISLAND_TERRAIN_DEPTH,
  ISLAND_TERRAIN_WIDTH,
  clampPlayerToGround,
  computeMovementIntent,
  resolveCircleObstacles,
} from '../src/player/movement';
import { classifySurfaceAt, isOnSand, surfaceWeightAt } from '../src/scene/surfaceClassification';
import { createSurfaceMaps, worldToSurfaceMapUv } from '../src/scene/surfaceMaps';
import { createSurfaceTextureSet, SURFACE_TEXTURE_SIZE } from '../src/scene/proceduralTextures';
import { createTerrainSplatMaterial } from '../src/scene/terrainSplatMaterial';
import {
  createWaterStylizedMaterial,
  updateWaterStylizedMaterial,
} from '../src/scene/waterStylizedMaterial';
import { createDecalSystem, spawnDecal, tickDecalSystem } from '../src/scene/decalSystem';
import { createFootprintTexture, createRippleTexture } from '../src/scene/decalTextures';
import { updatePlayerSurfaceDecals } from '../src/scene/playerSurfaceDecals';

describe('createIslandScene', () => {
  it('builds the expected A0 greybox objects', () => {
    const island = createIslandScene();

    expect(island.scene.name).toBe('bellbound-scene');
    expect(island.scene.getObjectByName('greybox-ground')).toBeDefined();
    expect(island.scene.getObjectByName('greybox-player')).toBeDefined();
    expect(island.scene.getObjectByName('player-capsule')).toBeDefined();
    expect(island.scene.getObjectByName('water-ring')).toBeDefined();
    expect(island.scene.getObjectByName('shore-wash-ring')).toBeDefined();
    expect(island.shoreWash.material.name).toBe('shore-wash-material');
    expect(island.shoreWash.material.customProgramCacheKey()).toBe('shore-wash:v27');
    // Disabled in Step 3 round 2 — the SDF-anchored ribbon currently bleeds
    // onto the flat-tier ground mesh. Will be re-enabled with grid anchors.
    expect(island.shoreWash.mesh.visible).toBe(false);
    expect(island.beachWaves.mesh.visible).toBe(false);
    expect(island.scene.getObjectByName('main-sun')).toBeDefined();
    // Hardcoded placeholder house / shop counter / bridge / staircase / fruit trees
    // were removed during the terraforming refactor scene cleanup (Step 0). They
    // come back as player-placed structures + props in Step 9.
    expect(island.scene.getObjectByName('placeholder-house')).toBeUndefined();
    expect(island.scene.getObjectByName('placeholder-shop-counter')).toBeUndefined();
    expect(island.scene.getObjectByName('placeholder-bridge')).toBeUndefined();
    expect(island.scene.getObjectByName('placeholder-staircase')).toBeUndefined();
    expect(island.obstacles).toHaveLength(0);
    expect(island.rollingObjects).toHaveLength(0);
    expect(island.surfaceMaps.splatMap.name).toBe('surface-splat-map');
    expect(island.surfaceMaps.aoMap.name).toBe('surface-ao-map');
    expect(island.surfaceMaps.cliffEdgeMap.name).toBe('surface-cliff-edge-map');
    expect(island.surfaceMaps.shoreMask.name).toBe('surface-shore-mask');
    expect(island.surfaceTextures.grass.name).toBe('surface-grass');
    expect(island.ground.material.name).toBe('terrain-splat');
    expect(island.ground.material.vertexColors).toBe(false);
    expect(island.water.material.name).toBe('water-stylized');
    expect(island.water.material.transparent).toBe(true);
    expect(island.water.material.depthWrite).toBe(false);
    expect(island.sky.material.customProgramCacheKey()).toBe('sky-dome:v3');
    // Step 3 ground mesh is built from the TerrainGrid: one quad (4 vertices, 6
    // indices) per LAND or FRESHWATER cell. The bake produces ~4996 solid cells
    // (4788 land + 208 freshwater) so the geometry should have ~19984 vertices
    // and ~29976 indices. Bounds are loose because future bake tweaks may shift
    // by a percent or two.
    const positionAttr = island.ground.geometry.getAttribute('position');
    expect(positionAttr.count).toBeGreaterThan(15000);
    expect(positionAttr.count).toBeLessThan(25000);
    expect(positionAttr.count % 4).toBe(0);
    expect(island.camera.name).toBe('main-camera');
  });

  it('updates scene animation values deterministically', () => {
    const island = createIslandScene();

    tickIslandScene(island, 2, { playerSpeed: 2, waveHeight: 0.2, timeOfDay: 0.5 });

    expect(island.playerBody.position.y).not.toBeCloseTo(0.76);
    expect(island.water.position.y).not.toBe(-0.14);
  });
});

describe('surface classification', () => {
  it('classifies the current island terrain from one shared source of truth', () => {
    expect(classifySurfaceAt(0, 0).kind).toBe('grass');
    expect(classifySurfaceAt(43, 0).kind).toBe('sand');
    // (-10.4, 10) used to fall on the hardcoded path-to-house dirt strip; that
    // path was removed during the terraforming refactor cleanup, so the cell now
    // classifies as plain inland grass.
    expect(classifySurfaceAt(-10.4, 10).kind).toBe('grass');
    expect(classifySurfaceAt(0, 5).kind).toBe('riverbed');
    expect(classifySurfaceAt(-20, -15).kind).toBe('cliff');

    expect(isOnSand(43, 0)).toBe(true);
    expect(isOnSand(0, 0)).toBe(false);
    expect(surfaceWeightAt(-20, -15, 'cliff')).toBe(1);
  });

  it('creates boot-time surface maps with the right filters', () => {
    const maps = createSurfaceMaps(32);
    const splat = sampleSplat(maps.splatMap, 0, 0);

    expect(maps.resolution).toBe(32);
    // Splat + shore* maps are linear-filtered so the terrain shader gets sub-texel
    // smoothing at the coast; ao/cliffEdge stay nearest because they are categorical.
    expect(maps.splatMap.magFilter).toBe(THREE.LinearFilter);
    expect(maps.splatMap.minFilter).toBe(THREE.LinearFilter);
    expect(maps.shoreDistanceMap.magFilter).toBe(THREE.LinearFilter);
    expect(maps.aoMap.format).toBe(THREE.RedFormat);
    expect(maps.cliffEdgeMap.format).toBe(THREE.RedFormat);
    expect(maps.riverMask.format).toBe(THREE.RedFormat);
    expect(maps.shoreMask.format).toBe(THREE.RedFormat);
    expect(splat).toEqual([255, 0, 0, 0]);
  });
});

describe('procedural surface textures', () => {
  it('builds six tileable RepeatWrapping textures at 512²', () => {
    const set = createSurfaceTextureSet();
    const keys = ['grass', 'sand', 'dirtPath', 'riverbed', 'cliffTop', 'cliffSide'] as const;

    for (const key of keys) {
      const texture = set[key] as THREE.DataTexture;

      expect(texture.name).toBe(`surface-${key}`);
      expect(texture.image.width).toBe(SURFACE_TEXTURE_SIZE);
      expect(texture.image.height).toBe(SURFACE_TEXTURE_SIZE);
      expect(texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture.wrapT).toBe(THREE.RepeatWrapping);
      expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    }
  });

  it('produces deterministic pixel data across runs', () => {
    const a = createSurfaceTextureSet();
    const b = createSurfaceTextureSet();

    const aFirstPixel = ((a.grass as THREE.DataTexture).image.data as Uint8Array).slice(0, 4);
    const bFirstPixel = ((b.grass as THREE.DataTexture).image.data as Uint8Array).slice(0, 4);

    expect(Array.from(aFirstPixel)).toEqual(Array.from(bFirstPixel));
  });
});

describe('terrain splat material', () => {
  it('configures the material for splat shading without vertex colors', () => {
    const surfaceMaps = createSurfaceMaps(32);
    const surfaceTextures = createSurfaceTextureSet();
    const material = createTerrainSplatMaterial({ surfaceMaps, surfaceTextures });

    expect(material.name).toBe('terrain-splat');
    expect(material.vertexColors).toBe(false);
    expect(material.version).toBeGreaterThan(0);
    expect(material.customProgramCacheKey()).toBe('terrain-splat:v21:4');
  });

  it('exposes a stable custom program cache key per tile size', () => {
    const surfaceMaps = createSurfaceMaps(32);
    const surfaceTextures = createSurfaceTextureSet();
    const a = createTerrainSplatMaterial({ surfaceMaps, surfaceTextures, tileSizeMeters: 6 });
    const b = createTerrainSplatMaterial({ surfaceMaps, surfaceTextures, tileSizeMeters: 6 });
    const c = createTerrainSplatMaterial({ surfaceMaps, surfaceTextures, tileSizeMeters: 8 });

    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    expect(a.customProgramCacheKey()).not.toBe(c.customProgramCacheKey());
  });
});

describe('stylized water material', () => {
  it('configures transparent animated water with a stable shader cache key', () => {
    const surfaceMaps = createSurfaceMaps(32);
    const material = createWaterStylizedMaterial({ surfaceMaps });

    expect(material.name).toBe('water-stylized');
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.customProgramCacheKey()).toBe('water-stylized:v54');
  });

  it('updates animation uniforms without recompiling the material', () => {
    const surfaceMaps = createSurfaceMaps(32);
    const material = createWaterStylizedMaterial({ surfaceMaps });

    updateWaterStylizedMaterial(material, 3.5, 0.26);

    const uniforms = material.userData.waterUniforms;
    expect(uniforms.uTime.value).toBe(3.5);
    expect(uniforms.uWaveStrength.value).toBe(0.26);
    expect(material.customProgramCacheKey()).toBe('water-stylized:v54');
  });
});

describe('cliff side mesh', () => {
  it('builds merged cliff wall mesh from grid tier discontinuities', () => {
    const island = createIslandScene();

    expect(island.cliffSideWalls.name).toBe('cliff-side-walls');

    const meshNames = island.cliffSideWalls.children
      .filter((child): child is THREE.Mesh => child instanceof THREE.Mesh)
      .map((mesh) => mesh.name);

    expect(meshNames).toContain('cliff-walls');
    expect(meshNames).not.toContain('cliff-lips');
  });

  it('puts the cliff walls mesh in the scene with shadow-receive on, cast off', () => {
    const island = createIslandScene();
    const walls = island.cliffSideWalls.getObjectByName('cliff-walls') as THREE.Mesh;

    expect(walls).toBeDefined();
    // GPU-warped meshes can't cast shadows correctly (depth pass uses unwarped
    // geometry → ghost shadows on the terrain). createIslandScene disables castShadow
    // on every cliff side mesh after attaching the rolling shader.
    expect(walls.castShadow).toBe(false);
    expect(walls.receiveShadow).toBe(true);
  });
});

describe('decal system', () => {
  it('builds a fixed-size pool of inactive slots', () => {
    const system = createDecalSystem('test-decals', 4);

    expect(system.capacity).toBe(4);
    expect(system.slots).toHaveLength(4);
    expect(system.group.children).toHaveLength(4);
    for (const slot of system.slots) {
      expect(slot.active).toBe(false);
      expect(slot.mesh.visible).toBe(false);
    }
  });

  it('activates a slot on spawn and fades it out by the end of its lifespan', () => {
    const system = createDecalSystem('test-decals', 4);
    const definition = {
      lifespan: 2,
      peakOpacity: 1,
      size: 0.4,
      texture: createFootprintTexture(),
    };

    spawnDecal(system, definition, 0, 0, 0, 0);
    const activated = system.slots.find((slot) => slot.active);
    expect(activated).toBeDefined();
    expect(activated?.mesh.visible).toBe(true);
    expect(activated?.material.map?.name).toBe('decal-footprint');

    tickDecalSystem(system, 1, 0, 0);
    expect(activated?.material.opacity).toBeGreaterThan(0);
    expect(activated?.material.opacity).toBeLessThan(1);

    tickDecalSystem(system, 2.1, 0, 0);
    expect(activated?.active).toBe(false);
    expect(activated?.mesh.visible).toBe(false);
  });

  it('round-robins slot allocation when capacity is exceeded', () => {
    const system = createDecalSystem('test-decals', 2);
    const definition = {
      lifespan: 5,
      size: 0.4,
      texture: createRippleTexture(),
    };

    spawnDecal(system, definition, 0, 0, 0, 0);
    spawnDecal(system, definition, 1, 0, 0, 0);
    spawnDecal(system, definition, 2, 0, 0, 0);

    // Third spawn must have recycled the first slot, not allocated a new one.
    expect(system.slots.filter((slot) => slot.active)).toHaveLength(2);
  });
});

describe('player surface decals', () => {
  it('spawns a footprint after walking the step interval on sand', () => {
    const island = createIslandScene();
    const sandX = 43;
    const sandZ = 0;

    island.player.position.set(sandX, 0, sandZ);
    island.surfaceDecals.lastPlayerPosition.set(sandX - 0.6, 0, sandZ);

    updatePlayerSurfaceDecals(island.surfaceDecals, {
      elapsed: 1,
      player: island.player,
      preResolvePosition: island.player.position,
    });

    const printed = island.surfaceDecals.footprints.slots.filter((slot) => slot.active);
    expect(printed.length).toBeGreaterThan(0);
  });

  it('does NOT spawn a footprint when walking on grass', () => {
    const island = createIslandScene();

    island.player.position.set(0, 0, 0);
    island.surfaceDecals.lastPlayerPosition.set(-0.6, 0, 0);

    updatePlayerSurfaceDecals(island.surfaceDecals, {
      elapsed: 1,
      player: island.player,
      preResolvePosition: island.player.position,
    });

    const printed = island.surfaceDecals.footprints.slots.filter((slot) => slot.active);
    expect(printed).toHaveLength(0);
  });

  it('spawns a ripple when the unresolved position would have entered the river off-bridge', () => {
    const island = createIslandScene();
    const riverX = 8;
    const riverZ = 5; // straight river — `riverCenterZ(_)` returns 5
    // Bank-side position (z = 2) sits outside the river footprint (river half
    // width 1.8 around z=5 → river covers z ∈ [3.2, 6.8]); the player tried
    // to step into the river center (z = 5) and the resolver pushed them
    // back to the bank.
    island.player.position.set(riverX, 0, 2);
    const tried = new THREE.Vector3(riverX, 0, riverZ);

    updatePlayerSurfaceDecals(island.surfaceDecals, {
      elapsed: 1,
      player: island.player,
      preResolvePosition: tried,
    });

    const ringing = island.surfaceDecals.ripples.slots.filter((slot) => slot.active);
    expect(ringing).toHaveLength(1);
  });
});

describe('player movement', () => {
  it('maps camera-relative input into a normalized world vector', () => {
    const forward = computeMovementIntent({ forward: 1, right: 0, run: false }, 0);
    const diagonal = computeMovementIntent({ forward: 1, right: 1, run: false }, 0);

    expect(forward.x).toBeCloseTo(0);
    expect(forward.z).toBeCloseTo(-1);
    expect(diagonal.length()).toBeCloseTo(1);
  });

  it('keeps the player inside the A0 ground bounds', () => {
    const island = createIslandScene();

    island.player.position.set(99, 0, -99);
    clampPlayerToGround(island.player.position);

    expect(island.player.position.x).toBe(GROUND_HALF_WIDTH);
    expect(island.player.position.z).toBe(-GROUND_HALF_DEPTH);
  });

  it('pushes the player away from a synthetic obstacle circle', () => {
    const island = createIslandScene();
    const synthetic = { name: 'synthetic-obstacle', x: 4, z: 4, radius: 1.0 };
    island.obstacles.push(synthetic);

    island.player.position.set(synthetic.x, 0, synthetic.z);
    resolveCircleObstacles(island.player.position, island.obstacles);

    const distance = Math.hypot(
      island.player.position.x - synthetic.x,
      island.player.position.z - synthetic.z,
    );

    expect(distance).toBeGreaterThan(1);
  });
});

function sampleSplat(texture: THREE.DataTexture, worldX: number, worldZ: number) {
  const [u, v] = worldToSurfaceMapUv(worldX, worldZ);
  const width = texture.image.width;
  const height = texture.image.height;
  const column = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
  const row = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
  const data = texture.image.data as Uint8Array;
  const index = (row * width + column) * 4;

  return Array.from(data.slice(index, index + 4));
}
