import * as THREE from 'three';
import { createRollingObject, updateRollingObject, type RollingObject } from './rollingWorld';

/**
 * Generic surface decal pool. Each decal is a flat textured quad laid on the ground that
 * fades out over a fixed lifespan. Used for footprints, river ripples, and (future) any
 * other transient ground mark.
 *
 * Why a pool: spawning/destroying meshes per step thrashes Three.js bookkeeping. We keep
 * a fixed-size circular buffer of pre-allocated meshes; spawning reuses the oldest slot.
 *
 * Why a per-decal `RollingObject` instead of patching a shared material: the parabolic
 * curvature is computed against each decal's flat XZ position, which differs per slot.
 * The CPU-side `updateRollingObject` keeps the meshes glued to the warped ground without
 * having to publish per-instance uniforms.
 */

export interface DecalDefinition {
  /** Base color tint applied to the texture (default white = use texture as-is). */
  color?: THREE.ColorRepresentation;
  /** Lifespan in seconds before the slot is recycled. */
  lifespan: number;
  /** Initial opacity at spawn (peak). Fades to 0 over `lifespan`. Default 1. */
  peakOpacity?: number;
  /** World-space size of the decal quad in meters. */
  size: number;
  /** RGBA texture sampled by the decal. Alpha drives the visible footprint. */
  texture: THREE.Texture;
}

interface DecalSlot {
  active: boolean;
  bornAt: number;
  definition: DecalDefinition | null;
  material: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  rolling: RollingObject;
}

export interface DecalSystem {
  capacity: number;
  group: THREE.Group;
  nextSlotIndex: number;
  slots: DecalSlot[];
}

export function createDecalSystem(name: string, capacity: number): DecalSystem {
  const group = new THREE.Group();
  group.name = name;

  const slots: DecalSlot[] = [];
  for (let i = 0; i < capacity; i += 1) {
    slots.push(createSlot(`${name}-slot-${i}`, group));
  }

  return { capacity, group, nextSlotIndex: 0, slots };
}

function createSlot(name: string, parent: THREE.Group): DecalSlot {
  // Each slot has its own geometry: rotation needs to be set per-decal (footprint
  // direction varies). Sharing the geometry would force a single rotation for all.
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthWrite: false,
    opacity: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    transparent: true,
  });

  const mesh = new THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>(geometry, material);
  mesh.name = name;
  mesh.visible = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;

  parent.add(mesh);

  return {
    active: false,
    bornAt: 0,
    definition: null,
    material,
    mesh,
    rolling: createRollingObject(mesh),
  };
}

export interface SpawnDecalOptions {
  /** Y rotation in radians — typically aligned with the player's facing direction. */
  rotationY?: number;
  /** Y position above the surface (small lift to avoid z-fighting). Default 0.005. */
  yLift?: number;
}

export function spawnDecal(
  system: DecalSystem,
  definition: DecalDefinition,
  worldX: number,
  worldZ: number,
  surfaceY: number,
  elapsed: number,
  options: SpawnDecalOptions = {},
): void {
  const slot = pickSlot(system);
  const { material, mesh, rolling } = slot;

  slot.active = true;
  slot.bornAt = elapsed;
  slot.definition = definition;

  material.map = definition.texture;
  material.color.set(definition.color ?? 0xffffff);
  material.opacity = definition.peakOpacity ?? 1;
  material.needsUpdate = true;

  mesh.scale.setScalar(definition.size);
  mesh.rotation.y = options.rotationY ?? 0;
  mesh.visible = true;

  rolling.flatPosition.set(worldX, surfaceY + (options.yLift ?? 0.005), worldZ);
}

/**
 * Round-robin slot picker. We don't search for "least recently used" because the spawn
 * cadence is roughly steady (one footstep every ~0.5 m walked) — the circular buffer
 * naturally gives each decal its full lifespan as long as `capacity > spawnRate * lifespan`.
 */
function pickSlot(system: DecalSystem): DecalSlot {
  const slot = system.slots[system.nextSlotIndex];
  system.nextSlotIndex = (system.nextSlotIndex + 1) % system.capacity;

  return slot;
}

export function tickDecalSystem(
  system: DecalSystem,
  elapsed: number,
  originX: number,
  originZ: number,
): void {
  for (const slot of system.slots) {
    if (!slot.active || !slot.definition) continue;

    const age = elapsed - slot.bornAt;
    const lifespan = slot.definition.lifespan;

    if (age >= lifespan) {
      retireSlot(slot);
      continue;
    }

    const peak = slot.definition.peakOpacity ?? 1;
    const t = age / lifespan;
    // Smoothstep-out fade: hold near peak, then accelerate fade in the last third.
    const fade = 1 - t * t * (3 - 2 * t);
    slot.material.opacity = peak * fade;

    updateRollingObject(slot.rolling, originX, originZ);
  }
}

function retireSlot(slot: DecalSlot): void {
  slot.active = false;
  slot.definition = null;
  slot.material.opacity = 0;
  slot.material.map = null;
  slot.mesh.visible = false;
}
