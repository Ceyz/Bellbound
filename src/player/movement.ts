import * as THREE from 'three';

export interface MovementInput {
  forward: number;
  right: number;
  run: boolean;
}

export interface CircleObstacle {
  name: string;
  radius: number;
  x: number;
  z: number;
}

export const ISLAND_TERRAIN_WIDTH = 94;
export const ISLAND_TERRAIN_DEPTH = 78;
export const BEACH_WIDTH = 3;
export const GROUND_HALF_WIDTH = ISLAND_TERRAIN_WIDTH / 2 - 1.2;
export const GROUND_HALF_DEPTH = ISLAND_TERRAIN_DEPTH / 2 - 1.2;
export const PLAYER_COLLISION_RADIUS = 0.38;
export const PLAYER_RUN_SPEED = 4.8;
export const PLAYER_WALK_SPEED = 2.8;

export function computeMovementIntent(input: MovementInput, cameraYaw: number) {
  const forwardAmount = clampAxis(input.forward);
  const rightAmount = clampAxis(input.right);
  const move = new THREE.Vector3();

  if (forwardAmount === 0 && rightAmount === 0) {
    return move;
  }

  const forward = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
  const right = new THREE.Vector3(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));

  move.addScaledVector(forward, forwardAmount);
  move.addScaledVector(right, rightAmount);

  if (move.lengthSq() > 1) {
    move.normalize();
  }

  return move;
}

export function clampPlayerToGround(position: THREE.Vector3) {
  position.x = THREE.MathUtils.clamp(position.x, -GROUND_HALF_WIDTH, GROUND_HALF_WIDTH);
  position.z = THREE.MathUtils.clamp(position.z, -GROUND_HALF_DEPTH, GROUND_HALF_DEPTH);
}

export function resolveCircleObstacles(
  position: THREE.Vector3,
  obstacles: CircleObstacle[],
  playerRadius = PLAYER_COLLISION_RADIUS,
) {
  for (const obstacle of obstacles) {
    const dx = position.x - obstacle.x;
    const dz = position.z - obstacle.z;
    const minDistance = obstacle.radius + playerRadius;
    const distanceSq = dx * dx + dz * dz;

    if (distanceSq >= minDistance * minDistance) {
      continue;
    }

    if (distanceSq < 0.0001) {
      position.x = obstacle.x + minDistance;
      continue;
    }

    const distance = Math.sqrt(distanceSq);
    const push = minDistance - distance;
    position.x += (dx / distance) * push;
    position.z += (dz / distance) * push;
  }
}

function clampAxis(value: number) {
  return THREE.MathUtils.clamp(value, -1, 1);
}
