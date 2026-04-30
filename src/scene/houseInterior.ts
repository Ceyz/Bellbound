import * as THREE from 'three';

/**
 * Procedural greybox interior for the player's house. Built once at boot and reused
 * across enter/exit transitions. Geometry matches the ACNH "Player Home" footprint
 * (5×4 m) per the asset brief in `STYLE_GUIDE.md` §3.
 */
export interface HouseInterior {
  scene: THREE.Scene;
  spawnPosition: THREE.Vector3;
  exitTriggerCenter: THREE.Vector3;
  exitTriggerRadius: number;
  // Bounds for player clamping (axis-aligned room rectangle).
  halfWidth: number;
  halfDepth: number;
  playerMargin: number;
  sun: THREE.DirectionalLight;
}

const ROOM_WIDTH = 6; // X extent
const ROOM_DEPTH = 4.5; // Z extent
const ROOM_HEIGHT = 2.6;
const WALL_THICKNESS = 0.18;
const DOOR_OPENING_WIDTH = 1.2;
const PLAYER_MARGIN = 0.4; // distance from wall the player can get to

export function createHouseInterior(): HouseInterior {
  const scene = new THREE.Scene();
  scene.name = 'house-interior';
  scene.background = new THREE.Color(0xfff5e6);
  // Slight cozy fog so the room edges don't feel sharp.
  scene.fog = new THREE.Fog(0xfff5e6, 8, 14);

  // Floor — wood-tone procedural plane.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_WIDTH, ROOM_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0xc4956a, roughness: 0.86 }),
  );
  floor.name = 'interior-floor';
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling — hidden in the A0 cutaway view (camera is above the room looking down).
  // Kept in the scene tree in case a future LOD/orbit camera wants to show it.
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_WIDTH, ROOM_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0xf5ead8, roughness: 0.92 }),
  );
  ceiling.name = 'interior-ceiling';
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;
  ceiling.visible = false;
  scene.add(ceiling);

  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf5ead8, roughness: 0.86 });

  // Back wall (-Z).
  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM_WIDTH, ROOM_HEIGHT, WALL_THICKNESS),
    wallMaterial,
  );
  backWall.name = 'interior-wall-back';
  backWall.position.set(0, ROOM_HEIGHT / 2, -ROOM_DEPTH / 2);
  backWall.receiveShadow = true;
  scene.add(backWall);

  // Front wall (+Z) split around a doorway. Hidden by default — the camera in A0
  // sits above and behind the player (looking down into the room from +Z), so the
  // front wall would otherwise occlude everything. The exit ring marker remains
  // visible in this opening.
  const sideSegmentWidth = (ROOM_WIDTH - DOOR_OPENING_WIDTH) / 2;
  const frontLeft = new THREE.Mesh(
    new THREE.BoxGeometry(sideSegmentWidth, ROOM_HEIGHT, WALL_THICKNESS),
    wallMaterial,
  );
  frontLeft.name = 'interior-wall-front-left';
  frontLeft.position.set(
    -ROOM_WIDTH / 2 + sideSegmentWidth / 2,
    ROOM_HEIGHT / 2,
    ROOM_DEPTH / 2,
  );
  frontLeft.receiveShadow = true;
  frontLeft.visible = false;
  scene.add(frontLeft);

  const frontRight = new THREE.Mesh(
    new THREE.BoxGeometry(sideSegmentWidth, ROOM_HEIGHT, WALL_THICKNESS),
    wallMaterial,
  );
  frontRight.name = 'interior-wall-front-right';
  frontRight.position.set(
    ROOM_WIDTH / 2 - sideSegmentWidth / 2,
    ROOM_HEIGHT / 2,
    ROOM_DEPTH / 2,
  );
  frontRight.receiveShadow = true;
  frontRight.visible = false;
  scene.add(frontRight);

  // Door header (lintel above the doorway) — hidden, same reasoning as front walls.
  const lintel = new THREE.Mesh(
    new THREE.BoxGeometry(DOOR_OPENING_WIDTH, 0.5, WALL_THICKNESS),
    wallMaterial,
  );
  lintel.name = 'interior-wall-front-lintel';
  lintel.position.set(0, ROOM_HEIGHT - 0.25, ROOM_DEPTH / 2);
  lintel.visible = false;
  scene.add(lintel);

  // Side walls (-X / +X).
  const leftWall = new THREE.Mesh(
    new THREE.BoxGeometry(WALL_THICKNESS, ROOM_HEIGHT, ROOM_DEPTH),
    wallMaterial,
  );
  leftWall.name = 'interior-wall-left';
  leftWall.position.set(-ROOM_WIDTH / 2, ROOM_HEIGHT / 2, 0);
  leftWall.receiveShadow = true;
  scene.add(leftWall);

  const rightWall = new THREE.Mesh(
    new THREE.BoxGeometry(WALL_THICKNESS, ROOM_HEIGHT, ROOM_DEPTH),
    wallMaterial,
  );
  rightWall.name = 'interior-wall-right';
  rightWall.position.set(ROOM_WIDTH / 2, ROOM_HEIGHT / 2, 0);
  rightWall.receiveShadow = true;
  scene.add(rightWall);

  // Lighting — cozy warm ambient + soft directional from a faux window.
  const ambient = new THREE.HemisphereLight(0xffe4c0, 0xa07850, 1.6);
  ambient.name = 'interior-ambient';
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff0d8, 1.4);
  sun.name = 'interior-key-light';
  sun.position.set(2.2, 3.1, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -ROOM_WIDTH / 2;
  sun.shadow.camera.right = ROOM_WIDTH / 2;
  sun.shadow.camera.top = ROOM_DEPTH / 2;
  sun.shadow.camera.bottom = -ROOM_DEPTH / 2;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 12;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target); // target stays at world origin (room center)

  // Exit trigger — visible amber ring on the floor right under the doorway.
  const exitTriggerCenter = new THREE.Vector3(0, 0, ROOM_DEPTH / 2 - 0.55);
  const exitTriggerRadius = 0.6;

  const exitMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.6, 24),
    new THREE.MeshBasicMaterial({
      color: 0xe89850,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  exitMarker.name = 'interior-exit-marker';
  exitMarker.rotation.x = -Math.PI / 2;
  exitMarker.position.copy(exitTriggerCenter);
  exitMarker.position.y = 0.015;
  scene.add(exitMarker);

  // Player spawns just inside the door, facing into the room.
  const spawnPosition = new THREE.Vector3(0, 0, ROOM_DEPTH / 2 - 1.3);

  return {
    scene,
    spawnPosition,
    exitTriggerCenter,
    exitTriggerRadius,
    halfWidth: ROOM_WIDTH / 2,
    halfDepth: ROOM_DEPTH / 2,
    playerMargin: PLAYER_MARGIN,
    sun,
  };
}

/** Clamp the player to the interior rectangle. Axis-aligned, no per-wall raycasts needed. */
export function clampPlayerToInterior(position: THREE.Vector3, interior: HouseInterior) {
  const halfX = interior.halfWidth - interior.playerMargin;
  const halfZ = interior.halfDepth - interior.playerMargin;
  if (position.x < -halfX) position.x = -halfX;
  else if (position.x > halfX) position.x = halfX;
  if (position.z < -halfZ) position.z = -halfZ;
  else if (position.z > halfZ) position.z = halfZ;
  position.y = 0;
}

/** True when the player has stepped onto the exit ring. */
export function playerOnExitTrigger(position: THREE.Vector3, interior: HouseInterior): boolean {
  const dx = position.x - interior.exitTriggerCenter.x;
  const dz = position.z - interior.exitTriggerCenter.z;
  return Math.hypot(dx, dz) <= interior.exitTriggerRadius;
}
