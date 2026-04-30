import * as THREE from 'three';
import type { IslandScene } from '../scene/createIslandScene';
import {
  FRESHWATER_SURFACE_OFFSET_METERS,
  Surface,
  TERRAIN_ORIGIN,
  getTerrainGrid,
  tierHeight,
} from '../scene/terrain/TerrainGrid';

/**
 * Generic placement-mode shell with a tool registry.
 *
 * Step 0 cleanup removed the original tree/rock placement tools. Step 5 adds
 * a registry so callers (main.ts) can register `TerraformTool`s — each tool
 * carries its own `apply(cx, cz)` and `canApply(cx, cz)` predicates so the
 * shell stays agnostic about whether it's editing the grid, placing props,
 * painting paths, etc.
 *
 * The shell handles: input listeners (Escape to exit), pointer raycaster,
 * UI subscriptions, cursor mesh lifecycle, and per-frame `update()` that
 * snaps the cursor cell to the world position under the pointer.
 */

export type BuildKind = string;

export interface BuildItemInfo {
  kind: BuildKind;
  label: string;
  stock: number;
  /** Defaults to true. Set false for tools with unlimited uses (terraforming). */
  showStock?: boolean;
}

export interface BuildModeState {
  active: boolean;
  kind: BuildKind | null;
}

/**
 * A registered terraforming or placement tool. The shell calls `apply(cx, cz)`
 * on click; tools return `null` on success or an error reason string for the
 * status bar to display. `canApply` drives the cursor green/red preview.
 */
export interface TerraformTool {
  kind: BuildKind;
  label: string;
  canApply(cx: number, cz: number): boolean;
  apply(cx: number, cz: number): string | null;
}

type ChangeListener = (state: BuildModeState) => void;

const TILE_SIZE = 1;

/** Cursor mesh tints. */
const CURSOR_VALID_COLOR = 0x78c878;
const CURSOR_INVALID_COLOR = 0xe87860;

export class BuildMode {
  private scene: THREE.Scene;
  private island: IslandScene;
  private kind: BuildKind | null = null;
  private listeners = new Set<ChangeListener>();
  private tools = new Map<BuildKind, TerraformTool>();

  private pointer = new THREE.Vector2();
  private pointerSet = false;
  private raycaster = new THREE.Raycaster();

  private cursor: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private cursorCell: [number, number] = [-1, -1];
  private cursorValid = false;

  constructor(island: IslandScene) {
    this.scene = island.scene;
    this.island = island;
    this.cursor = createCursorMesh();
    this.cursor.visible = false;
    this.scene.add(this.cursor);
  }

  registerTool(tool: TerraformTool): void {
    this.tools.set(tool.kind, tool);
    this.notify();
  }

  enter(kind: BuildKind) {
    if (!this.tools.has(kind)) return; // silently refuse unknown tools
    if (this.kind === kind) return;
    this.kind = kind;
    if (this.cursor) this.cursor.visible = false; // reappears on first pointermove
    this.notify();
  }

  exit() {
    if (!this.kind) return;
    this.kind = null;
    this.pointerSet = false;
    if (this.cursor) this.cursor.visible = false;
    this.notify();
  }

  isActive(): boolean {
    return this.kind !== null;
  }

  getKind(): BuildKind | null {
    return this.kind;
  }

  /** Tools listed for the modal grid + UI. */
  listItems(): BuildItemInfo[] {
    return Array.from(this.tools.values()).map((tool) => ({
      kind: tool.kind,
      label: tool.label,
      stock: 0,
      showStock: false,
    }));
  }

  /** Display label for an active kind (used by the UI status bar). */
  getLabel(kind: BuildKind): string {
    if (!kind) return '';
    return this.tools.get(kind)?.label
      ?? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' '));
  }

  /** Update normalized device coordinates from a pointer event. */
  setPointer(clientX: number, clientY: number, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerSet = true;
  }

  /**
   * Per-frame update: raycast the pointer against the actual ground mesh
   * (which has tier heights baked into the geometry) and position the cursor
   * at the hit cell's tier top. Hit-testing the geometry (not a flat Y=0
   * plane) means the cursor lands precisely on raised cliffs / sand zones /
   * river beds. The rolling parabolic warp is disabled while BuildMode is
   * active (see main.ts), so the rendered ground equals the un-warped
   * geometry and the raycast matches what the user sees on screen.
   */
  update(camera: THREE.Camera) {
    if (!this.kind || !this.cursor) return;
    if (!this.pointerSet) {
      this.cursor.visible = false;
      return;
    }
    const tool = this.tools.get(this.kind);
    if (!tool) {
      this.cursor.visible = false;
      return;
    }

    this.raycaster.setFromCamera(this.pointer, camera);
    // Hit-test only against the horizontal top surfaces (ground + freshwater).
    // Cliff side walls are intentionally EXCLUDED: the raycaster would hit a
    // vertical wall before the plateau behind it, snapping the cursor to the
    // wrong cell whenever the user tries to click on a raised area.
    const intersections = this.raycaster.intersectObjects(
      [this.island.ground, this.island.freshwater],
      false,
    );
    if (intersections.length === 0) {
      this.cursor.visible = false;
      return;
    }

    const hit = intersections[0].point;
    const cx = Math.floor((hit.x - TERRAIN_ORIGIN.x) / TILE_SIZE);
    const cz = Math.floor((hit.z - TERRAIN_ORIGIN.z) / TILE_SIZE);
    this.cursorCell = [cx, cz];

    const grid = getTerrainGrid();
    if (!grid.cellInBounds(cx, cz)) {
      this.cursor.visible = false;
      return;
    }

    // Position the cursor on the VISIBLE top of the cell:
    //   LAND       → tier top (cellHeight)
    //   FRESHWATER → water surface (tier top - 0.30 m), not the bed,
    //                so the wireframe sits above the water and stays visible.
    const cellSurface = grid.getSurface(cx, cz);
    const cellTier = grid.getTier(cx, cz);
    const cursorY = cellSurface === Surface.FRESHWATER
      ? tierHeight(cellTier) - FRESHWATER_SURFACE_OFFSET_METERS
      : grid.cellHeight(cx, cz);
    const wx = TERRAIN_ORIGIN.x + (cx + 0.5) * TILE_SIZE;
    const wz = TERRAIN_ORIGIN.z + (cz + 0.5) * TILE_SIZE;
    this.cursor.position.set(wx, cursorY + 0.04, wz);
    this.cursor.visible = true;

    this.cursorValid = tool.canApply(cx, cz);
    this.cursor.material.color.setHex(
      this.cursorValid ? CURSOR_VALID_COLOR : CURSOR_INVALID_COLOR,
    );
  }

  /** Apply the active tool at the current cursor cell. */
  tryPlace(): boolean {
    if (!this.kind || !this.cursor || !this.cursor.visible) return false;
    const tool = this.tools.get(this.kind);
    if (!tool) return false;
    const [cx, cz] = this.cursorCell;
    const error = tool.apply(cx, cz);
    return error === null;
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

/**
 * Cell-edge wireframe cursor. 1 m × 1 m on the XZ plane, four edges drawn as
 * line segments (LineSegments + LineBasicMaterial). Centered at origin so
 * `update()` can position it via `mesh.position.set()` to the cell center.
 *
 * Rendered with `depthTest = false` and `renderOrder = 100` so the outline is
 * drawn on top of every terrain mesh — guarantees the cursor stays visible
 * regardless of camera angle or where the cell sits on a tier.
 */
function createCursorMesh(): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  const half = 0.5;
  // Four edges of the 1×1 quad as LINE_PAIR indices.
  const positions = new Float32Array([
    -half, 0, -half,
    half, 0, -half,
    half, 0, half,
    -half, 0, half,
  ]);
  const indices = new Uint16Array([
    0, 1,
    1, 2,
    2, 3,
    3, 0,
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const material = new THREE.LineBasicMaterial({
    color: CURSOR_VALID_COLOR,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'build-cursor';
  lines.renderOrder = 100;
  return lines;
}
