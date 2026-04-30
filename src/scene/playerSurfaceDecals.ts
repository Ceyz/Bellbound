import * as THREE from 'three';
import { isOnSand } from './surfaceClassification';
import { isInRiver, isOnBridge } from './heightmap';
import {
  createDecalSystem,
  spawnDecal,
  tickDecalSystem,
  type DecalDefinition,
  type DecalSystem,
} from './decalSystem';
import { createFootprintTexture, createRippleTexture } from './decalTextures';

/**
 * Player-driven surface decals: footprints when walking on sand, ripples when bumping
 * into the riverbank.
 *
 * Footstep cadence is distance-based (one print every `STEP_INTERVAL_METERS`) rather
 * than animation-event-based: simpler, framerate-independent, and matches Mixamo clips
 * whose foot-down events we don't expose. Lateral offset alternates between left and
 * right foot for natural readability.
 *
 * Ripples are throttled by `RIPPLE_MIN_INTERVAL` so a player rubbing the bank does not
 * spam a wall of overlapping rings.
 */

const STEP_INTERVAL_METERS = 0.55;
const FOOT_LATERAL_OFFSET_METERS = 0.13;
const FOOTPRINT_SIZE_METERS = 0.32;
const FOOTPRINT_LIFESPAN_SECONDS = 7;
const FOOTPRINT_PEAK_OPACITY = 0.55;

const RIPPLE_SIZE_METERS = 0.85;
const RIPPLE_LIFESPAN_SECONDS = 1.6;
const RIPPLE_PEAK_OPACITY = 0.85;
const RIPPLE_MIN_INTERVAL_SECONDS = 0.35;

const FOOTPRINT_POOL_CAPACITY = 24;
const RIPPLE_POOL_CAPACITY = 8;

export interface PlayerSurfaceDecalState {
  footprintDefinition: DecalDefinition;
  footprints: DecalSystem;
  rippleDefinition: DecalDefinition;
  ripples: DecalSystem;

  distanceSinceLastStep: number;
  lastPlayerPosition: THREE.Vector3;
  lastRippleAt: number;
  nextFootIsRight: boolean;
}

export function createPlayerSurfaceDecals(
  scene: THREE.Scene,
  initialPosition: THREE.Vector3,
): PlayerSurfaceDecalState {
  const footprints = createDecalSystem('player-footprints', FOOTPRINT_POOL_CAPACITY);
  const ripples = createDecalSystem('player-ripples', RIPPLE_POOL_CAPACITY);
  scene.add(footprints.group);
  scene.add(ripples.group);

  return {
    footprintDefinition: {
      lifespan: FOOTPRINT_LIFESPAN_SECONDS,
      peakOpacity: FOOTPRINT_PEAK_OPACITY,
      size: FOOTPRINT_SIZE_METERS,
      texture: createFootprintTexture(),
    },
    footprints,
    rippleDefinition: {
      color: 0xeaf6ff,
      lifespan: RIPPLE_LIFESPAN_SECONDS,
      peakOpacity: RIPPLE_PEAK_OPACITY,
      size: RIPPLE_SIZE_METERS,
      texture: createRippleTexture(),
    },
    ripples,

    distanceSinceLastStep: 0,
    lastPlayerPosition: initialPosition.clone(),
    lastRippleAt: -Infinity,
    nextFootIsRight: false,
  };
}

export interface UpdatePlayerSurfaceDecalsOptions {
  elapsed: number;
  player: THREE.Object3D;
  /** Player position BEFORE the river-push resolver ran, so we can detect bank contact. */
  preResolvePosition: THREE.Vector3;
}

export function updatePlayerSurfaceDecals(
  state: PlayerSurfaceDecalState,
  options: UpdatePlayerSurfaceDecalsOptions,
): void {
  const { elapsed, player, preResolvePosition } = options;

  trackFootsteps(state, player, elapsed);
  trackRiverContact(state, preResolvePosition, player.position, elapsed);

  tickDecalSystem(state.footprints, elapsed, player.position.x, player.position.z);
  tickDecalSystem(state.ripples, elapsed, player.position.x, player.position.z);
}

function trackFootsteps(
  state: PlayerSurfaceDecalState,
  player: THREE.Object3D,
  elapsed: number,
): void {
  const dx = player.position.x - state.lastPlayerPosition.x;
  const dz = player.position.z - state.lastPlayerPosition.z;
  const stepDistance = Math.sqrt(dx * dx + dz * dz);
  state.lastPlayerPosition.copy(player.position);
  state.distanceSinceLastStep += stepDistance;

  if (state.distanceSinceLastStep < STEP_INTERVAL_METERS) return;
  state.distanceSinceLastStep = 0;

  const yaw = player.rotation.y;
  const lateralSign = state.nextFootIsRight ? 1 : -1;
  state.nextFootIsRight = !state.nextFootIsRight;

  // Right vector matches movement.ts convention: right = (cos(yaw), 0, -sin(yaw)).
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const printX = player.position.x + rightX * lateralSign * FOOT_LATERAL_OFFSET_METERS;
  const printZ = player.position.z + rightZ * lateralSign * FOOT_LATERAL_OFFSET_METERS;

  if (!isOnSand(printX, printZ)) return;

  spawnDecal(
    state.footprints,
    state.footprintDefinition,
    printX,
    printZ,
    player.position.y,
    elapsed,
    { rotationY: yaw },
  );
}

function trackRiverContact(
  state: PlayerSurfaceDecalState,
  preResolvePosition: THREE.Vector3,
  postResolvePosition: THREE.Vector3,
  elapsed: number,
): void {
  if (elapsed - state.lastRippleAt < RIPPLE_MIN_INTERVAL_SECONDS) return;

  // Trigger when the *unresolved* position would have entered the river off-bridge —
  // i.e., the player tried to wade in and got pushed back by `pushPlayerOutOfRiver`.
  const tried = isInRiver(preResolvePosition.x, preResolvePosition.z);
  const onBridge = isOnBridge(preResolvePosition.x, preResolvePosition.z);
  if (!tried || onBridge) return;

  state.lastRippleAt = elapsed;

  spawnDecal(
    state.ripples,
    state.rippleDefinition,
    postResolvePosition.x,
    postResolvePosition.z,
    postResolvePosition.y,
    elapsed,
  );
}
