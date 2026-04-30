import * as THREE from 'three';
import './style.css';
import { createIslandScene, tickIslandScene, updateIslandRollingWorld } from './scene/createIslandScene';
import { updatePlayerSurfaceDecals } from './scene/playerSurfaceDecals';
import { rollingConfig, invalidateRollingCache } from './scene/rollingWorld';
import {
  getIslandHeight,
  getPlayerStandingHeight,
  isInRiver,
  isOnBridge,
  pushPlayerOutOfRiver,
} from './scene/heightmap';
import {
  clampPlayerToInterior,
  createHouseInterior,
  playerOnExitTrigger,
  type HouseInterior,
} from './scene/houseInterior';
import {
  animateRotationY,
  createSceneSwitchState,
  performTransition,
} from './scene/sceneSwitch';
import { BuildMode } from './buildMode/buildMode';
import { mountBuildModeUI } from './buildMode/buildModeUI';
import { BRIDGE } from './scene/heightmap';
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
import { triggerTreeShake } from './scene/treeSway';
import { detachAttachedApples, tickApples } from './scene/appleSystem';

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
  cameraVerticalLag: 5, // Faster than horizontal so descents (stairs, cliffs) don't drop the player off-frame
  cameraDeadZone: 3.4,
  playerVerticalLag: 12, // Smooths heightmap Y discontinuities (cliff edges, staircase sides) into a quick step-down
  cameraFrameAhead: 4, // Reduced from 7.4 — ACNH camera doesn't aggressively show what's ahead
  cameraPitch: 0.42, // 24° down from horizontal — ACNH-feel (was 0.62 = 35.5°, too top-down)
  cameraDistance: 18, // 18 m hypotenuse (was 21.5)
  cameraFOV: 35, // narrower than the 40° default for ACNH-style perspective
  turnLag: 18,
  walkSpeed: PLAYER_WALK_SPEED,
  runSpeed: PLAYER_RUN_SPEED,
  /** Day/night cycle position in [0, 1). 0.5 = noon. Driven each frame when
   *  `autoCycle=true`, otherwise scrubbable manually via the lil-gui slider. */
  timeOfDay: 0.5,
  /** Auto-advance time-of-day at `1 / dayLength` per second. */
  autoCycle: true,
  /** Real-time seconds for one full day cycle. 600 s = 10 min/day. */
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
};
cameraFocus.copy(island.player.position).add(new THREE.Vector3(0, 0.82, 0));

// Async-load the rigged character + animations and attach to the player Group once ready.
// While loading, the greybox capsule remains visible. On load, capsule is hidden and the
// VRM character takes its place (same parent, so all the existing player physics still work).
let playerCharacter: PlayerCharacter | null = null;
type DebugAnimChoice = 'auto' | AnimationName;
let debugAnimSelector: { animation: DebugAnimChoice } | null = null;
void loadPlayerCharacter().then((char) => {
  playerCharacter = char;
  // Hide the greybox capsule + face marker; keep groundShadow visible.
  island.playerBody.visible = false;
  const faceMarker = island.player.getObjectByName('player-facing-marker');
  if (faceMarker) faceMarker.visible = false;
  island.player.add(char.root);
  // Mixamo characters are typically ~1.65 m tall; chibi proportions are smaller so leave
  // scale at 1. Y position 0 = feet on the floor (player Group origin is at the ground).
  char.root.position.set(0, 0, 0);
  // Mixamo characters face -Z by default in Blender → matches Three.js forward, so no rotation.
}).catch((err) => {
  console.error('Failed to load player character:', err);
});

const buildMode = new BuildMode(island);
const buildUIRoot = mountBuildModeUI(buildMode);

const inventory = { apples: 0 };
const appleHud = document.createElement('div');
appleHud.className = 'apple-hud';
appleHud.textContent = `Pommes : ${inventory.apples}`;
document.body.appendChild(appleHud);
function refreshAppleHud() {
  appleHud.textContent = `Pommes : ${inventory.apples}`;
}

// Indoor scene + scene-switch state for A0.4 enter/exit.
const interior: HouseInterior = createHouseInterior();
const sceneState = createSceneSwitchState();
const doorPivot = island.house.getObjectByName('house-door-pivot') as THREE.Group | null;

// Camera presets per scene — narrower distance + steeper pitch indoors so the small room
// fits in frame.
const OUTDOOR_CAM_DISTANCE = params.cameraDistance;
const OUTDOOR_CAM_PITCH = params.cameraPitch;
const INDOOR_CAM_DISTANCE = 5;
const INDOOR_CAM_PITCH = 0.7;

const interiorRaycastTargets: THREE.Object3D[] = [island.house];
const houseRaycaster = new THREE.Raycaster();
const housePointer = new THREE.Vector2();

function setBuildUIVisible(visible: boolean) {
  buildUIRoot.style.display = visible ? '' : 'none';
}

async function enterHouse(clientX: number, clientY: number) {
  if (sceneState.current !== 'outdoor' || sceneState.transitioning) return;

  const rect = sceneCanvas.getBoundingClientRect();
  housePointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  housePointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  houseRaycaster.setFromCamera(housePointer, island.camera);
  const hits = houseRaycaster.intersectObjects(interiorRaycastTargets, true);
  if (hits.length === 0) return;

  // For A0 any hit on the house enters; A1+ can refine to door-only by checking name.
  if (buildMode.isActive()) buildMode.exit();
  setBuildUIVisible(false);

  // Door swing in parallel with the fade so total transition stays under 600ms.
  if (doorPivot) {
    void animateRotationY(doorPivot, -Math.PI / 2, 240);
  }

  await performTransition(sceneState, 'indoor', () => {
    interior.scene.add(island.player);
    island.player.position.copy(interior.spawnPosition);
    velocity.set(0, 0, 0);
    cameraFocus.copy(island.player.position).add(new THREE.Vector3(0, 0.82, 0));
    params.cameraDistance = INDOOR_CAM_DISTANCE;
    params.cameraPitch = INDOOR_CAM_PITCH;
  });

  if (doorPivot) doorPivot.rotation.y = 0;
}

async function exitHouse() {
  if (sceneState.current !== 'indoor' || sceneState.transitioning) return;

  await performTransition(sceneState, 'outdoor', () => {
    island.scene.add(island.player);
    // AC pattern: respawn just in front of the exterior door, facing away from the house.
    // Use the heightmap so the spawn point sits on the cliff plateau (the house sits there).
    const housePos = island.house.position;
    const spawnX = housePos.x;
    const spawnZ = housePos.z + 2.2;
    island.player.position.set(spawnX, getIslandHeight(spawnX, spawnZ), spawnZ);
    velocity.set(0, 0, 0);
    cameraFocus.copy(island.player.position).add(new THREE.Vector3(0, 0.82, 0));
    params.cameraDistance = OUTDOOR_CAM_DISTANCE;
    params.cameraPitch = OUTDOOR_CAM_PITCH;
  });

  setBuildUIVisible(true);
}

window.addEventListener('keydown', (event) => {
  // Escape always exits build mode (regardless of focus state).
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

// Build mode: track pointer for ghost positioning, click on canvas places.
sceneCanvas.addEventListener('pointermove', (event) => {
  if (buildMode.isActive()) {
    buildMode.setPointer(event.clientX, event.clientY, sceneCanvas);
  }
});
sceneCanvas.addEventListener('click', (event) => {
  if (buildMode.isActive()) {
    buildMode.tryPlace();
    event.preventDefault();
    return;
  }

  // Outdoor: clicking the house enters it (A0.4).
  if (sceneState.current === 'outdoor' && !sceneState.transitioning) {
    void enterHouse(event.clientX, event.clientY);
  }
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

  if (sceneState.current === 'outdoor') {
    // Snapshot pre-movement state so we can fall back per-axis if the player would
    // cross an illegal boundary (river off-bridge, or a cliff step without the staircase).
    const prevX = island.player.position.x;
    const prevZ = island.player.position.z;
    const prevHeight = getPlayerStandingHeight(prevX, prevZ);

    const desiredX = prevX + velocity.x * delta;
    const desiredZ = prevZ + velocity.z * delta;
    // Snapshot the pre-resolve target so the decal system can detect "tried to wade
    // into the river" even after the per-axis river block clamps the position back.
    preResolvePosition.set(desiredX, prevHeight, desiredZ);

    // Probe the body extents (8 points: cardinal + diagonal) so the body never pokes
    // past the river bank before being stopped. Diagonal probes are at 0.707 × radius.
    // Height-step is checked at the destination CENTER only — checking it on the side
    // probes too caused corner-pinch freezes (cliff/staircase edges where two perpendicular
    // probes each straddle a > 0.5 m drop, blocking both axes at once).
    const r = PLAYER_COLLISION_RADIUS;
    const d = r * 0.7071;
    const riverProbes: Array<[number, number]> = [
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
    const isBlockedAt = (x: number, z: number): boolean => {
      for (const [dx, dz] of riverProbes) {
        const qx = x + dx;
        const qz = z + dz;
        if (isInRiver(qx, qz) && !isOnBridge(qx, qz)) return true;
      }
      if (Math.abs(getPlayerStandingHeight(x, z) - prevHeight) > 0.5) return true;
      return false;
    };

    // Axis-separated test enables wall-sliding: when only one axis is blocked, the
    // player keeps moving along the other (e.g. pressing "diagonal into cliff" still
    // slides along the cliff edge).
    const xBlocked = isBlockedAt(desiredX, prevZ);
    const zBlocked = isBlockedAt(prevX, desiredZ);

    island.player.position.x = xBlocked ? prevX : desiredX;
    island.player.position.z = zBlocked ? prevZ : desiredZ;
    if (xBlocked) velocity.x = 0;
    if (zBlocked) velocity.z = 0;

    resolveCircleObstacles(island.player.position, island.obstacles);
    clampPlayerToGround(island.player.position);

    // Tree shake: post-resolution, scan trees the player is touching and pushing INTO.
    // The dot of (tree-player) and the input-intent velocity is positive when the player
    // is walking toward the tree even though the obstacle resolver has just clamped them
    // out — i.e. the "pressed against the trunk" state. A small intent threshold avoids
    // shaking idle trees when the player drifts past at a tangent.
    const TREE_TOUCH_EPS = 0.05;
    const TREE_SHAKE_INTENT_THRESHOLD = 0.1;
    for (const tree of island.trees) {
      const dx = tree.position.x - island.player.position.x;
      const dz = tree.position.z - island.player.position.z;
      const dist = Math.hypot(dx, dz);
      const treeObstacle = island.obstacles.find((o) => o.name === tree.name);
      if (!treeObstacle) continue;
      const touchDistance = treeObstacle.radius + PLAYER_COLLISION_RADIUS + TREE_TOUCH_EPS;
      if (dist > touchDistance || dist < 0.001) continue;
      const intentToward = (dx * targetVelocity.x + dz * targetVelocity.z) / dist;
      if (intentToward < TREE_SHAKE_INTENT_THRESHOLD) continue;
      triggerTreeShake(tree, elapsed, island.player.position.x, island.player.position.z);
      // Knock attached apples off in the same direction the player is pushing. Pickup
      // happens automatically when the player walks within range of a grounded apple.
      detachAttachedApples(tree, island.scene, dx / dist, dz / dist);
    }

    // Defensive: if we somehow ended up inside the river (e.g. boot state), push out.
    pushPlayerOutOfRiver(island.player.position);

    // Bridge railings: keep the player away from the deck edges. The rails are a
    // thin barrier on each side of the deck; clamp the player's X to the inner half-width.
    if (isOnBridge(island.player.position.x, island.player.position.z)) {
      const railThickness = 0.08;
      const innerHalfWidth = BRIDGE.halfWidth - railThickness - r;
      island.player.position.x = THREE.MathUtils.clamp(
        island.player.position.x,
        BRIDGE.x - innerHalfWidth,
        BRIDGE.x + innerHalfWidth,
      );
    }

    // Stick the player to the heightmap, but smooth Y over a few frames so abrupt steps
    // (cliff edge, sides of the staircase) read as a quick step-down instead of a teleport.
    const targetY = getPlayerStandingHeight(
      island.player.position.x,
      island.player.position.z,
    );
    const yBlend = 1 - Math.exp(-params.playerVerticalLag * delta);
    island.player.position.y = THREE.MathUtils.lerp(island.player.position.y, targetY, yBlend);
  } else {
    island.player.position.addScaledVector(velocity, delta);
    clampPlayerToInterior(island.player.position, interior);
    if (!sceneState.transitioning && playerOnExitTrigger(island.player.position, interior)) {
      void exitHouse();
    }
  }

  const currentSpeed = velocity.length();

  if (currentSpeed > 0.08) {
    const targetRotation = Math.atan2(velocity.x, velocity.z);
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

  tickApples(delta, {
    scene: island.scene,
    playerPos: island.player.position,
    trees: island.trees,
    onPickup: () => {
      inventory.apples += 1;
      refreshAppleHud();
    },
  });

  if (sceneState.current === 'outdoor') {
    updatePlayerSurfaceDecals(island.surfaceDecals, {
      elapsed,
      player: island.player,
      preResolvePosition,
    });
  }

  // Drive the rigged character: tick the animation mixer and pick a clip from state.
  if (playerCharacter) {
    playerCharacter.update(delta);

    let targetAnim: AnimationName;
    if (debugAnimSelector && debugAnimSelector.animation !== 'auto') {
      // GUI override: preview a specific clip.
      targetAnim = debugAnimSelector.animation;
    } else if (sceneState.current === 'outdoor' || sceneState.current === 'indoor') {
      if (currentSpeed < 0.1) {
        targetAnim = 'breathing_idle';
      } else if (input.run) {
        targetAnim = 'running';
      } else {
        targetAnim = 'walking';
      }
    } else {
      targetAnim = 'breathing_idle';
    }
    playerCharacter.setAnimation(targetAnim);
  }

  if (sceneState.current === 'outdoor') {
    updateIslandRollingWorld(island);
    buildMode.update(island.camera);
    renderer.render(island.scene, island.camera);
  } else {
    renderer.render(interior.scene, island.camera);
  }
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
