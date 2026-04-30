import * as THREE from 'three';
import type { IslandScene } from '../scene/createIslandScene';

/**
 * Generic placement-mode shell.
 *
 * The original A0 build mode shipped with two hardcoded item kinds (tree, rock)
 * that placed via `createFruitTree` / `createRock`. Those callers were removed
 * during the Step 0 cleanup of the terraforming refactor (see plan §0 / §2.3).
 *
 * Step 5 of the plan plugs `TerraformTool` (cliff_raise / cliff_lower /
 * water_dig / water_fill / path_paint / path_erase) into this shell as
 * registered tools. Until then the shell is empty: it tracks an active
 * "kind" and notifies UI listeners, but `tryPlace()` is a no-op because no
 * tool is registered yet. The UI module renders an empty toolbar.
 *
 * Keeping the shell here (instead of deleting it as v1 did) preserves the
 * keyboard listeners, pointer raycaster, ghost mesh lifecycle, and
 * UI-subscription pattern that Step 5 will reuse without rebuilding.
 */
export type BuildKind = string;

export interface BuildItemInfo {
  kind: BuildKind;
  label: string;
  stock: number;
}

export interface BuildModeState {
  active: boolean;
  kind: BuildKind | null;
}

type ChangeListener = (state: BuildModeState) => void;

export class BuildMode {
  private scene: THREE.Scene;
  private island: IslandScene;
  private kind: BuildKind | null = null;
  private listeners = new Set<ChangeListener>();
  private pointer = new THREE.Vector2();
  private pointerSet = false;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(island: IslandScene) {
    this.scene = island.scene;
    this.island = island;
  }

  enter(kind: BuildKind) {
    if (this.kind === kind) return;
    this.kind = kind;
    this.notify();
  }

  exit() {
    if (!this.kind) return;
    this.kind = null;
    this.pointerSet = false;
    this.notify();
  }

  isActive(): boolean {
    return this.kind !== null;
  }

  getKind(): BuildKind | null {
    return this.kind;
  }

  /** Future Step 5 will list registered terraforming tools here. Empty for now. */
  listItems(): BuildItemInfo[] {
    return [];
  }

  /**
   * Display label for an active kind (used by the UI status bar). Step 5 will
   * register tools (`cliff_raise` → "Élever falaise", etc.) and override this.
   * For now we just titlecase the kind so the UI shell is functional even
   * without registered tools.
   */
  getLabel(kind: BuildKind): string {
    if (!kind) return '';
    return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');
  }

  /** Update normalized device coordinates from a pointer event. */
  setPointer(clientX: number, clientY: number, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerSet = true;
  }

  /** No-op until Step 5 registers terraforming tools. Hooks pointer state for them. */
  update(_camera: THREE.Camera) {
    if (!this.kind || !this.pointerSet) return;
    // Step 5: raycast → grid cell → cursor mesh + canEdit() preview.
  }

  /** No-op until a tool is registered. Returns false (placement rejected). */
  tryPlace(): boolean {
    return false;
  }

  /** Subscribe to mode changes. Returns unsub. */
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
    };
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
