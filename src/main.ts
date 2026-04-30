import * as THREE from 'three';
import './style.css';
import { createIslandScene, rebuildTerrain, tickIslandScene, updateIslandRollingWorld } from './scene/createIslandScene';
import { updatePlayerSurfaceDecals } from './scene/playerSurfaceDecals';
import { rollingConfig, invalidateRollingCache } from './scene/rollingWorld';
import {
  getPlayerStandingHeight,
  pushPlayerOutOfRiver,
} from './scene/heightmap';
import { Surface, Tier, getTerrainGrid } from './scene/terrain/TerrainGrid';
import type { BuiltStructure } from './scene/terrain/builtStructure';
import { BuildMode } from './buildMode/buildMode';
import { mountBuildModeUI } from './buildMode/buildModeUI';
import {
  ALL_ANIMATIONS,
  loadPlayerCharacter,
  type AnimationName,
  type PlayerCharacter,
} from './scene/playerCharacter';
import { FootstepAudio } from './player/footstepAudio';
import {
  PLAYER_COLLISION_RADIUS,
  PLAYER_RUN_SPEED,
  PLAYER_WALK_SPEED,
  clampPlayerToGround,
  computeMovementIntent,
  resolveCircleObstacles,
  type MovementInput,
} from './player/movement';

declare global {
  interface Window {
    __BELLBOUND_DEBUG__?: {
      getCameraState: () => {
        distance: number;
        focus: [number, number, number];
        position: [number, number, number];
      };
      getPlayerPosition: () => [number, number, number];
      getSceneObjectNames: () => string[];
      setAutoCycle: (enabled: boolean) => void;
      setPlayerPosition: (x: number, z: number) => void;
      setTimeOfDay: (timeOfDay: number) => void;
      getRollingCurvature: () => number;
      getCursorState: () => null | { visible: boolean; position: [number, number, number] };
    };
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene');

if (!canvas) {
  throw new Error('Canvas #scene introuvable.');
}

const sceneCanvas = canvas;

const renderer = new THREE.WebGLRenderer({
  canvas: sceneCanvas,
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true,
});

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const island = createIslandScene();

const params = {
  waveHeight: 0.18,
  sunlight: 2.25,
  cameraLag: 2.9,
  cameraVerticalLag: 5,
  cameraDeadZone: 3.4,
  playerVerticalLag: 12,
  cameraFrameAhead: 4,
  cameraPitch: 0.42,
  cameraDistance: 18,
  cameraFOV: 35,
  turnLag: 18,
  walkSpeed: PLAYER_WALK_SPEED,
  runSpeed: PLAYER_RUN_SPEED,
  timeOfDay: 0.5,
  autoCycle: true,
  dayLength: 600,
};

if (import.meta.env.DEV) {
  void import('lil-gui').then(({ default: GUI }) => {
    const gui = new GUI({ title: 'Bellbound A0' });
    gui.add(params, 'walkSpeed', 1.5, 4.5, 0.05).name('Marche');
    gui.add(params, 'runSpeed', 3, 7, 0.05).name('Course');
    const cam = gui.addFolder('Caméra (ACNH-feel)');
    cam.add(params, 'cameraPitch', 0.2, 0.8, 0.01).name('Pitch (rad)');
    cam.add(params, 'cameraDistance', 12, 26, 0.5).name('Distance');
    cam.add(params, 'cameraFOV', 25, 50, 1).name('FOV').onChange((value: number) => {
      island.camera.fov = value;
      island.camera.updateProjectionMatrix();
    });
    cam.add(params, 'cameraLag', 1.5, 8, 0.1).name('Lag');
    cam.add(params, 'cameraVerticalLag', 2, 20, 0.5).name('Lag vertical');
    cam.add(params, 'playerVerticalLag', 4, 30, 0.5).name('Player Y lag');
    cam.add(params, 'cameraDeadZone', 0, 6, 0.05).name('Dead zone');
    cam.add(params, 'cameraFrameAhead', 0, 8, 0.1).name('Frame ahead');
    cam.open();
    const animFolder = gui.addFolder('Animation (debug)');
    debugAnimSelector = { animation: 'auto' };
    animFolder
      .add(debugAnimSelector, 'animation', ['auto', ...ALL_ANIMATIONS])
      .name('Preview clip');
    animFolder.open();
    const roll = gui.addFolder('Rolling world (curvature)');
    roll
      .add(rollingConfig, 'curvature', 0, 0.01, 0.0005)
      .name('Curvature')
      .onChange(() => invalidateRollingCache());
    roll
      .add(rollingConfig, 'applyXAxis')
      .name('Spherical (X+Z)')
      .onChange(() => invalidateRollingCache());
    roll.open();
    gui.add(params, 'turnLag', 4, 28, 0.5).name('Virage');
    gui.add(params, 'waveHeight', 0, 0.5, 0.01).name('Vagues');
    const cycle = gui.addFolder('Cycle jour/nuit');
    cycle.add(params, 'timeOfDay', 0, 1, 0.001).name('Heure (0=minuit)').listen();
    cycle.add(params, 'autoCycle').name('Cycle auto');
    cycle.add(params, 'dayLength', 60, 1800, 30).name('Jour (s)');
    cycle.open();
  });
}

const pressedKeys = new Set<string>();
const movementKeyCodes = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'KeyA',
  'KeyD',
  'KeyS',
  'KeyW',
  'ShiftLeft',
  'ShiftRight',
]);
const velocity = new THREE.Vector3();
const target = new THREE.Vector3();
const cameraFocus = new THREE.Vector3();
const desiredCameraPosition = new THREE.Vector3();
const desiredFocus = new THREE.Vector3();
const footstepAudio = new FootstepAudio();

const cameraYaw = 0;
let footstepTimer = 0;

window.__BELLBOUND_DEBUG__ = {
  getCameraState: () => ({
    distance: params.cameraDistance,
    focus: cameraFocus.toArray() as [number, number, number],
    position: island.camera.position.toArray() as [number, number, number],
  }),
  getPlayerPosition: () => island.player.position.toArray() as [number, number, number],
  getSceneObjectNames: () => island.scene.children.map((object) => object.name).filter(Boolean),
  setAutoCycle: (enabled: boolean) => {
    params.autoCycle = enabled;
  },
  setPlayerPosition: (x: number, z: number) => {
    island.player.position.set(x, getPlayerStandingHeight(x, z), z);
    velocity.set(0, 0, 0);
    cameraFocus.copy(island.player.position).add(new THREE.Vector3(0, 0.82, 0));
  },
  setTimeOfDay: (timeOfDay: number) => {
    params.timeOfDay = THREE.MathUtils.euclideanModulo(timeOfDay, 1);
    params.autoCycle = false;
  },
  getRollingCurvature: () => rollingConfig.curvature,
  getCursorState: () => {
    const cursor = island.scene.getObjectByName('build-cursor');
    if (!cursor) return null;
    return {
      visible: cursor.visible,
      position: cursor.position.toArray() as [number, number, number],
    };
  },
};
cameraFocus.copy(island.player.position).add(new THREE.Vector3(0, 0.82, 0));

let playerCharacter: PlayerCharacter | null = null;
type DebugAnimChoice = 'auto' | AnimationName;
let debugAnimSelector: { animation: DebugAnimChoice } | null = null;
void loadPlayerCharacter().then((char) => {
  playerCharacter = char;
  island.playerBody.visible = false;
  const faceMarker = island.player.getObjectByName('player-facing-marker');
  if (faceMarker) faceMarker.visible = false;
  island.player.add(char.root);
  char.root.position.set(0, 0, 0);
}).catch((err) => {
  console.error('Failed to load player character:', err);
});

// BuildMode shell + Step 5 terraforming tools (cliff_raise / cliff_lower).
// Each tool calls into the TerrainGrid edit API and triggers a full mesh +
// surface-map rebuild via `rebuildTerrain(island)`. canApply mirrors the AC
// rules without mutating the grid (used for the cursor green/red preview).
const buildMode = new BuildMode(island);
mountBuildModeUI(buildMode);

const terraformGrid = getTerrainGrid();

// AC-style terraforming view: while a tool is active, flatten the world (kill
// the parabolic rolling warp) AND switch the camera to a steep top-down
// perspective. Without the camera switch, raised plateaus visually occlude
// the cells BEHIND them, so the user can never aim at those — the raycast
// hits the plateau top first. Steep top-down minimizes the occluded area
// because most cells are seen from nearly straight above.
let _savedRollingCurvature: number | null = null;
let _savedCameraPitch: number | null = null;
let _savedCameraDistance: number | null = null;
const BUILD_MODE_CAMERA_PITCH = 1.20;     // ≈ 69° down — close to top-down without losing depth cues
const BUILD_MODE_CAMERA_DISTANCE = 22;    // a bit farther so a wider area is visible
buildMode.onChange((state) => {
  if (state.active && _savedRollingCurvature === null) {
    _savedRollingCurvature = rollingConfig.curvature;
    rollingConfig.curvature = 0;
    invalidateRollingCache();
    _savedCameraPitch = params.cameraPitch;
    _savedCameraDistance = params.cameraDistance;
    params.cameraPitch = BUILD_MODE_CAMERA_PITCH;
    params.cameraDistance = BUILD_MODE_CAMERA_DISTANCE;
  } else if (!state.active && _savedRollingCurvature !== null) {
    rollingConfig.curvature = _savedRollingCurvature;
    _savedRollingCurvature = null;
    invalidateRollingCache();
    if (_savedCameraPitch !== null) params.cameraPitch = _savedCameraPitch;
    if (_savedCameraDistance !== null) params.cameraDistance = _savedCameraDistance;
    _savedCameraPitch = null;
    _savedCameraDistance = null;
  }
});

buildMode.registerTool({
  kind: 'cliff_raise',
  label: 'Élever falaise',
  canApply: (cx, cz) => {
    if (!terraformGrid.cellInBounds(cx, cz)) return false;
    if (terraformGrid.getSurface(cx, cz) !== Surface.LAND) return false;
    return terraformGrid.getTier(cx, cz) < Tier.T3;
  },
  apply: (cx, cz) => {
    const err = terraformGrid.raiseCell(cx, cz);
    if (err) return err.reason;
    rebuildTerrain(island);
    return null;
  },
});

buildMode.registerTool({
  kind: 'cliff_lower',
  label: 'Abaisser falaise',
  canApply: (cx, cz) => {
    if (!terraformGrid.cellInBounds(cx, cz)) return false;
    if (terraformGrid.getSurface(cx, cz) !== Surface.LAND) return false;
    if (terraformGrid.getTier(cx, cz) <= Tier.T0) return false;
    // No 4-neighbor at strictly higher tier (cantilever rule).
    const t = terraformGrid.getTier(cx, cz);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (terraformGrid.cellInBounds(cx + dx, cz + dz)
        && terraformGrid.getTier(cx + dx, cz + dz) > t) return false;
    }
    return true;
  },
  apply: (cx, cz) => {
    const err = terraformGrid.lowerCell(cx, cz);
    if (err) return err.reason;
    rebuildTerrain(island);
    return null;
  },
});

buildMode.registerTool({
  kind: 'water_dig',
  label: 'Creuser eau',
  canApply: (cx, cz) => {
    if (!terraformGrid.cellInBounds(cx, cz)) return false;
    if (terraformGrid.getSurface(cx, cz) !== Surface.LAND) return false;
    // No 4-neighbor at strictly higher tier (cliff foot rule).
    const t = terraformGrid.getTier(cx, cz);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (!terraformGrid.cellInBounds(cx + dx, cz + dz)) continue;
      if (terraformGrid.getSurface(cx + dx, cz + dz) === Surface.LAND
        && terraformGrid.getTier(cx + dx, cz + dz) > t) return false;
    }
    return true;
  },
  apply: (cx, cz) => {
    const err = terraformGrid.digFreshwater(cx, cz);
    if (err) return err.reason;
    rebuildTerrain(island);
    return null;
  },
});

buildMode.registerTool({
  kind: 'water_fill',
  label: 'Boucher eau',
  canApply: (cx, cz) => {
    if (!terraformGrid.cellInBounds(cx, cz)) return false;
    return terraformGrid.getSurface(cx, cz) === Surface.FRESHWATER;
  },
  apply: (cx, cz) => {
    const err = terraformGrid.fillFreshwater(cx, cz);
    if (err) return err.reason;
    rebuildTerrain(island);
    return null;
  },
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && buildMode.isActive()) {
    buildMode.exit();
    event.preventDefault();
    return;
  }

  if (!movementKeyCodes.has(event.code)) {
    return;
  }

  pressedKeys.add(event.code);
  footstepAudio.unlock();
  event.preventDefault();
});

window.addEventListener('keyup', (event) => {
  if (!movementKeyCodes.has(event.code)) {
    return;
  }

  pressedKeys.delete(event.code);
  event.preventDefault();
});

sceneCanvas.addEventListener('pointerdown', () => {
  footstepAudio.unlock();
});

// Track pointer unconditionally so the cursor mesh is positioned the moment
// the user enters a tool, even if they haven't moved the mouse since the
// page loaded (otherwise tryPlace would silently no-op on the first click).
sceneCanvas.addEventListener('pointermove', (event) => {
  buildMode.setPointer(event.clientX, event.clientY, sceneCanvas);
});
sceneCanvas.addEventListener('click', (event) => {
  if (!buildMode.isActive()) return;
  // The click event also carries a position. Snap the cursor to it before
  // applying so the user can click anywhere on the canvas without first
  // dragging the mouse to wake up pointermove.
  buildMode.setPointer(event.clientX, event.clientY, sceneCanvas);
  buildMode.update(island.camera);
  buildMode.tryPlace();
  event.preventDefault();
});

sceneCanvas.addEventListener('contextmenu', (event) => event.preventDefault());
sceneCanvas.addEventListener(
  'wheel',
  (event) => {
    params.cameraDistance = THREE.MathUtils.clamp(params.cameraDistance + event.deltaY * 0.01, 12, 26);
    event.preventDefault();
  },
  { passive: false },
);

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);

  island.camera.aspect = width / height;
  island.camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
const preResolvePosition = new THREE.Vector3();

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.getElapsedTime();
  const input = readMovementInput();
  const speed = input.run ? params.runSpeed : params.walkSpeed;
  const movementIntent = computeMovementIntent(input, cameraYaw);
  const targetVelocity = movementIntent.multiplyScalar(speed);
  const velocityBlend = 1 - Math.exp(-14 * delta);

  velocity.lerp(targetVelocity, velocityBlend);

  const prevX = island.player.position.x;
  const prevZ = island.player.position.z;
  const prevHeight = getPlayerStandingHeight(prevX, prevZ);

  const desiredX = prevX + velocity.x * delta;
  const desiredZ = prevZ + velocity.z * delta;
  preResolvePosition.set(desiredX, prevHeight, desiredZ);

  // Step 4 movement resolver. The previous trio
  //   isInRiver(qx, qz) || height-delta > 0.5
  // is replaced by `terrainGrid.isTraversable(fromCell, toCell, structures)`.
  // The grid knows about all surface kinds (LAND tier 0-3, FRESHWATER, OCEAN,
  // VOID), so cliff-edge blocking generalizes from "cliff = ±1 m" to any tier
  // discontinuity automatically. Same body-probe pattern (cardinal +
  // diagonals at PLAYER_COLLISION_RADIUS) so the player never pokes past a
  // boundary before being stopped.
  //
  // `structures` is currently empty (Step 9 brings player-placed bridges and
  // staircases). With no structures, the resolver locks the player to their
  // starting tier and bans water entry — which matches the post-Step-0 scene
  // (no built bridges, no staircases).
  const builtStructures: readonly BuiltStructure[] = [];
  const terrainGrid = getTerrainGrid();
  const r = PLAYER_COLLISION_RADIUS;
  const d = r * 0.7071;
  const bodyProbes: Array<[number, number]> = [
    [0, 0],
    [r, 0],
    [-r, 0],
    [0, r],
    [0, -r],
    [d, d],
    [d, -d],
    [-d, d],
    [-d, -d],
  ];
  const [prevCx, prevCz] = terrainGrid.worldToCell(prevX, prevZ);
  const isBlockedAt = (x: number, z: number): boolean => {
    for (const [dx, dz] of bodyProbes) {
      const [probeCx, probeCz] = terrainGrid.worldToCell(x + dx, z + dz);
      if (!terrainGrid.isTraversable(prevCx, prevCz, probeCx, probeCz, builtStructures)) {
        return true;
      }
    }
    return false;
  };

  const xBlocked = isBlockedAt(desiredX, prevZ);
  const zBlocked = isBlockedAt(prevX, desiredZ);

  island.player.position.x = xBlocked ? prevX : desiredX;
  island.player.position.z = zBlocked ? prevZ : desiredZ;
  if (xBlocked) velocity.x = 0;
  if (zBlocked) velocity.z = 0;

  resolveCircleObstacles(island.player.position, island.obstacles);
  clampPlayerToGround(island.player.position);

  pushPlayerOutOfRiver(island.player.position);

  const targetY = getPlayerStandingHeight(
    island.player.position.x,
    island.player.position.z,
  );
  const yBlend = 1 - Math.exp(-params.playerVerticalLag * delta);
  island.player.position.y = THREE.MathUtils.lerp(island.player.position.y, targetY, yBlend);

  const currentSpeed = velocity.length();

  // Rotation uses input INTENT, not the post-resolver velocity. With the grid
  // movement resolver, walking against a cliff or river zeros the velocity
  // along blocked axes; using velocity here would freeze the player's facing
  // while pinned. Intent stays at the pressed direction so the player keeps
  // turning even when boxed in by a wall.
  const intentMagnitude = Math.hypot(movementIntent.x, movementIntent.z);
  if (intentMagnitude > 0.08) {
    const targetRotation = Math.atan2(movementIntent.x, movementIntent.z);
    island.player.rotation.y = dampAngle(
      island.player.rotation.y,
      targetRotation,
      params.turnLag,
      delta,
    );
  }

  updateFootsteps(currentSpeed, input.run, delta);
  updateCamera(delta);
  if (params.autoCycle) {
    params.timeOfDay = (params.timeOfDay + delta / Math.max(params.dayLength, 1)) % 1;
  }
  tickIslandScene(island, elapsed, {
    playerSpeed: currentSpeed,
    waveHeight: params.waveHeight,
    timeOfDay: params.timeOfDay,
  });

  updatePlayerSurfaceDecals(island.surfaceDecals, {
    elapsed,
    player: island.player,
    preResolvePosition,
  });

  if (playerCharacter) {
    playerCharacter.update(delta);

    let targetAnim: AnimationName;
    if (debugAnimSelector && debugAnimSelector.animation !== 'auto') {
      targetAnim = debugAnimSelector.animation;
    } else if (currentSpeed < 0.1) {
      targetAnim = 'breathing_idle';
    } else if (input.run) {
      targetAnim = 'running';
    } else {
      targetAnim = 'walking';
    }
    playerCharacter.setAnimation(targetAnim, undefined, 1);
  }

  updateIslandRollingWorld(island);
  buildMode.update(island.camera);
  renderer.render(island.scene, island.camera);
});

function readMovementInput(): MovementInput {
  const forward =
    Number(pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp')) -
    Number(pressedKeys.has('KeyS') || pressedKeys.has('ArrowDown'));
  const right =
    Number(pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight')) -
    Number(pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft'));

  return {
    forward,
    right,
    run: pressedKeys.has('ShiftLeft') || pressedKeys.has('ShiftRight'),
  };
}

function updateCamera(delta: number) {
  const horizontalDistance = Math.cos(params.cameraPitch) * params.cameraDistance;
  const cameraHeight = Math.sin(params.cameraPitch) * params.cameraDistance;
  const followBlend = 1 - Math.exp(-params.cameraLag * delta);

  desiredFocus.copy(island.player.position);
  desiredFocus.y += 0.86;
  moveCameraFocusWithinDeadZone(delta);
  target.copy(cameraFocus);
  target.z -= params.cameraFrameAhead;
  target.y += 0.12;

  desiredCameraPosition.set(
    cameraFocus.x + Math.sin(cameraYaw) * horizontalDistance,
    cameraFocus.y + cameraHeight,
    cameraFocus.z + Math.cos(cameraYaw) * horizontalDistance,
  );

  const verticalBlend = 1 - Math.exp(-params.cameraVerticalLag * delta);
  island.camera.position.lerp(desiredCameraPosition, followBlend);
  island.camera.position.y = THREE.MathUtils.lerp(
    island.camera.position.y,
    desiredCameraPosition.y,
    verticalBlend,
  );
  island.camera.lookAt(target);
}

function moveCameraFocusWithinDeadZone(delta: number) {
  const followBlend = 1 - Math.exp(-params.cameraLag * delta);
  const dx = desiredFocus.x - cameraFocus.x;
  const dz = desiredFocus.z - cameraFocus.z;
  const horizontalDistance = Math.hypot(dx, dz);

  const verticalBlend = 1 - Math.exp(-params.cameraVerticalLag * delta);
  cameraFocus.y = THREE.MathUtils.lerp(cameraFocus.y, desiredFocus.y, verticalBlend);

  if (horizontalDistance <= params.cameraDeadZone) {
    return;
  }

  const excess = horizontalDistance - params.cameraDeadZone;
  cameraFocus.x += (dx / horizontalDistance) * excess * followBlend;
  cameraFocus.z += (dz / horizontalDistance) * excess * followBlend;
}

function updateFootsteps(currentSpeed: number, running: boolean, delta: number) {
  if (currentSpeed <= 0.2) {
    footstepTimer = 0.08;
    return;
  }

  footstepTimer -= delta;

  if (footstepTimer > 0) {
    return;
  }

  footstepAudio.play(THREE.MathUtils.clamp(currentSpeed / params.runSpeed, 0, 1));
  footstepTimer = running ? 0.26 : 0.39;
}

function dampAngle(current: number, next: number, lambda: number, delta: number) {
  const diff = Math.atan2(Math.sin(next - current), Math.cos(next - current));
  return current + diff * (1 - Math.exp(-lambda * delta));
}
