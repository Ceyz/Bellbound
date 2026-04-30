import * as THREE from 'three';
import { createFruitTree, createRock, type IslandScene } from '../scene/createIslandScene';
import { getPlayerStandingHeight, isInRiver, isOnBridge } from '../scene/heightmap';
import { createRollingObject, rollingConfig } from '../scene/rollingWorld';

export type BuildKind = 'tree' | 'rock';

export interface BuildItemInfo {
  kind: BuildKind;
  label: string;
  stock: number;
}

interface GhostBundle {
  group: THREE.Group;
  meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
}

type ChangeListener = (state: BuildModeState) => void;

export interface BuildModeState {
  active: boolean;
  kind: BuildKind | null;
  inventory: Record<BuildKind, number>;
}

const INITIAL_INVENTORY: Record<BuildKind, number> = {
  tree: 8,
  rock: 5,
};

const ITEM_LABELS: Record<BuildKind, string> = {
  tree: 'Arbre',
  rock: 'Rocher',
};

const TILE_SIZE = 1; // 1 m grid (matches ACNH convention)
const VALID_COLOR = 0x78c878;
const INVALID_COLOR = 0xe87860;

const TREE_COLLISION_RADIUS = 0.78;
const ROCK_COLLISION_RADIUS = 0.6;
const PLACEMENT_PADDING = 0.3; // extra clearance between placed objects

/**
 * Greybox build/decorate mode for A0:
 * - User picks "tree" or "rock" via the UI overlay (`buildModeUI.ts`).
 * - A semi-transparent ghost mesh follows the mouse cursor on a 1m-snapped grid.
 * - Ghost is green when the position is valid, red when it overlaps an obstacle or
 *   leaves the island bounds. Click on the canvas places the object.
 * - Stays in the placement mode after each placement so the user can chain placements.
 *   "Annuler" button or Escape exits the mode.
 *
 * Persistence is intentionally NOT included at this stage — placed objects reset on
 * reload. Persistence lands in A0.7 (localStorage save) and ultimately on-chain at 2.1.
 */
export class BuildMode {
  private scene: THREE.Scene;
  private island: IslandScene;
  private kind: BuildKind | null = null;
  private ghost: GhostBundle | null = null;
  private ghostFlatPos = new THREE.Vector3();
  private valid = false;
  private listeners = new Set<ChangeListener>();
  private inventory: Record<BuildKind, number> = { ...INITIAL_INVENTORY };

  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private pointer = new THREE.Vector2();
  private pointerSet = false;

  private treeCount = 0;
  private rockCount = 0;

  constructor(island: IslandScene) {
    this.scene = island.scene;
    this.island = island;
  }

  enter(kind: BuildKind) {
    if (this.inventory[kind] <= 0) return; // can't enter mode with no stock
    if (this.kind === kind) return;
    if (this.kind) this.disposeGhost();
    this.kind = kind;
    this.ghost = this.createGhost(kind);
    this.scene.add(this.ghost.group);
    this.notify();
  }

  exit() {
    if (!this.kind) return;
    this.disposeGhost();
    this.kind = null;
    this.notify();
  }

  isActive(): boolean {
    return this.kind !== null;
  }

  getKind(): BuildKind | null {
    return this.kind;
  }

  /** Read-only snapshot of the current inventory. */
  getInventory(): Record<BuildKind, number> {
    return { ...this.inventory };
  }

  /** Returns the static label + current stock for each build kind, in display order. */
  listItems(): BuildItemInfo[] {
    const order: BuildKind[] = ['tree', 'rock'];
    return order.map((kind) => ({
      kind,
      label: ITEM_LABELS[kind],
      stock: this.inventory[kind],
    }));
  }

  /** Refill stock — used for debug / future shop integration. */
  addStock(kind: BuildKind, amount: number) {
    this.inventory[kind] = Math.max(0, this.inventory[kind] + amount);
    this.notify();
  }

  /** Update normalized device coordinates from a pointer event. */
  setPointer(clientX: number, clientY: number, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerSet = true;
  }

  /**
   * Per-frame ghost update: raycast pointer onto the flat ground plane, snap to grid,
   * apply curvature warp so the ghost sits on the visible (warped) ground, validate.
   */
  update(camera: THREE.Camera) {
    if (!this.kind || !this.ghost) return;
    if (!this.pointerSet) {
      this.ghost.group.visible = false;
      return;
    }

    this.raycaster.setFromCamera(this.pointer, camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      this.ghost.group.visible = false;
      this.valid = false;
      return;
    }

    // Snap to integer grid in world space.
    hit.x = Math.round(hit.x / TILE_SIZE) * TILE_SIZE;
    hit.z = Math.round(hit.z / TILE_SIZE) * TILE_SIZE;
    // Y is the player-standing height so placed objects sit on the bridge deck (when
    // applicable), the cliff plateau, or sea level — never on the carved riverbed.
    hit.y = getPlayerStandingHeight(hit.x, hit.z);
    this.ghostFlatPos.copy(hit);

    // Apply the same parabolic curvature as the ground shader so the ghost sits on the
    // visibly-warped ground. Only Y is shifted (the curvature stacks on top of the
    // heightmap altitude).
    const dx = hit.x - this.island.player.position.x;
    const dz = hit.z - this.island.player.position.z;
    let yOffset = -dz * dz * rollingConfig.curvature;
    if (rollingConfig.applyXAxis) yOffset -= dx * dx * rollingConfig.curvature;

    this.ghost.group.position.set(hit.x, hit.y + yOffset, hit.z);
    this.ghost.group.visible = true;

    // Validate: in-bounds, no overlap with existing obstacles, and not in the river
    // (unless the bridge covers that tile).
    const tileHalfX = (this.island.ground.geometry.parameters.width ?? 80) / 2 - 1;
    const tileHalfZ = (this.island.ground.geometry.parameters.height ?? 64) / 2 - 1;
    const inBounds = Math.abs(hit.x) <= tileHalfX && Math.abs(hit.z) <= tileHalfZ;

    const objectRadius = this.kind === 'tree' ? TREE_COLLISION_RADIUS : ROCK_COLLISION_RADIUS;
    const overlap = this.island.obstacles.some((obstacle) => {
      const distance = Math.hypot(obstacle.x - hit.x, obstacle.z - hit.z);
      return distance < obstacle.radius + objectRadius + PLACEMENT_PADDING;
    });

    const inRiver = isInRiver(hit.x, hit.z) && !isOnBridge(hit.x, hit.z);

    this.valid = inBounds && !overlap && !inRiver;
    this.applyGhostTint(this.valid ? VALID_COLOR : INVALID_COLOR);
  }

  /** Place the ghost as a real object. Returns true on success. */
  tryPlace(): boolean {
    if (!this.kind || !this.valid) return false;
    if (this.inventory[this.kind] <= 0) {
      // Out of stock mid-session — exit the mode silently.
      this.exit();
      return false;
    }

    const flatPos = this.ghostFlatPos;

    if (this.kind === 'tree') {
      this.treeCount += 1;
      const name = `placed-tree-${this.treeCount}`;
      // flatPos.y already includes the heightmap altitude (set in update()).
      const tree = createFruitTree(name, [flatPos.x, flatPos.y, flatPos.z]);
      this.scene.add(tree);
      this.island.obstacles.push({
        name,
        x: flatPos.x,
        z: flatPos.z,
        radius: TREE_COLLISION_RADIUS,
      });
      this.island.rollingObjects.push(createRollingObject(tree));
      this.island.trees.push(tree);
    } else {
      this.rockCount += 1;
      const name = `placed-rock-${this.rockCount}`;
      const rock = createRock(name, [flatPos.x, flatPos.y, flatPos.z]);
      this.scene.add(rock);
      this.island.obstacles.push({
        name,
        x: flatPos.x,
        z: flatPos.z,
        radius: ROCK_COLLISION_RADIUS,
      });
      this.island.rollingObjects.push(createRollingObject(rock));
    }

    // Decrement stock and notify listeners (UI updates).
    this.inventory[this.kind] = Math.max(0, this.inventory[this.kind] - 1);

    // If we just used the last item of this kind, automatically exit placement mode
    // (mirrors ACNH: when you run out of an item you fall back to navigation).
    if (this.inventory[this.kind] <= 0) {
      this.exit();
    } else {
      this.notify();
    }

    return true;
  }

  /** Subscribe to mode changes (active/inactive + kind + inventory). Returns unsub. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const state: BuildModeState = {
      active: this.isActive(),
      kind: this.kind,
      inventory: { ...this.inventory },
    };
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private applyGhostTint(color: number) {
    if (!this.ghost) return;
    for (const mesh of this.ghost.meshes) {
      mesh.material.color.setHex(color);
    }
  }

  private disposeGhost() {
    if (!this.ghost) return;
    this.scene.remove(this.ghost.group);
    for (const mesh of this.ghost.meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.ghost = null;
    this.pointerSet = false;
  }

  private createGhost(kind: BuildKind): GhostBundle {
    const meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
    const group = new THREE.Group();
    group.name = `build-ghost-${kind}`;
    group.visible = false; // hidden until first pointermove

    const ghostMaterial = () =>
      new THREE.MeshBasicMaterial({
        color: VALID_COLOR,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });

    if (kind === 'tree') {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.26, 1.15, 12),
        ghostMaterial(),
      );
      trunk.position.y = 0.58;
      group.add(trunk);
      meshes.push(trunk);

      const foliage = new THREE.Mesh(new THREE.SphereGeometry(0.92, 16, 12), ghostMaterial());
      foliage.position.y = 1.55;
      foliage.scale.set(1.08, 0.92, 1.02);
      group.add(foliage);
      meshes.push(foliage);
    } else {
      const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 0), ghostMaterial());
      body.position.y = 0.45;
      body.scale.set(1.05, 0.78, 1.0);
      group.add(body);
      meshes.push(body);

      const cap = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 0), ghostMaterial());
      cap.position.set(-0.08, 0.86, 0.04);
      cap.scale.set(0.95, 0.6, 0.95);
      group.add(cap);
      meshes.push(cap);
    }

    return { group, meshes };
  }
}
