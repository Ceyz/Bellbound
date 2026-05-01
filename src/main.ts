import * as THREE from 'three';
import './style.css';
import { createIslandScene, rebuildTerrain, tickIslandScene, updateIslandRollingWorld, updatePathMaskCell } from './scene/createIslandScene';
import { updatePlayerSurfaceDecals } from './scene/playerSurfaceDecals';
import { rollingConfig, invalidateRollingCache } from './scene/rollingWorld';
import {
  getPlayerStandingHeight,
} from './scene/heightmap';
import { GRID_D, GRID_W, Surface, TERRAIN_ORIGIN, Tier, getTerrainGrid } from './scene/terrain/TerrainGrid';
import { bootTerrain, type IslandMintTerrainFields } from './scene/terrain/terrainSave';
import { addBuiltStructure, bootBuiltStructures, getBuiltStructures, type BuiltStructure } from './scene/terrain/builtStructure';
import { findBridgePlacement } from './scene/terrain/bridgePlacement';
import { syncBridgeMeshes } from './scene/bridgeMeshes';
import { sampleIslandShape } from './scene/islandShape';
import {
  initTerraformFx,
  spawnDustPuff,
  spawnPathPop,
  spawnSplash,
  updateTerraformFx,
} from './scene/terraformFx';
import { BuildMode, type TerraformTool } from './buildMode/buildMode';
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
    /**
     * Dev hook: pre-mounted `island_save.state` payload to load at boot.
     * Set by tooling / E2E tests / dev console; read by `bootTerrain` and
     * `bootBuiltStructures` before the scene mounts. Production reads the
     * same shape from the inscription fetch path (Phase A). Never set in
     * production builds.
     */
    __BELLBOUND_SAVE__?: { state?: { terrain?: unknown; built_structures?: unknown } };
    /**
     * Dev hook: pre-mounted `island_mint.initial_state` terrain block. When
     * present, `bootTerrain` validates `terrain_base_grid_hash` and refuses
     * the save on silent-drift mismatch (spec §3.5).
     */
    __BELLBOUND_MINT__?: { initial_state?: IslandMintTerrainFields };
    /**
     * Dev-only hook: force a bridge mesh resync. Useful when an E2E test
     * (or the dev console) installed a structure via the registry directly,
     * bypassing the BuildMode tool's apply hook. Production code never calls
     * this — the tool's `apply` already triggers a rebuild on placement.
     */
    __BELLBOUND_DEBUG_REBUILD_BRIDGES__?: () => void;
    /**
     * Dev-only hook: programmatically place a bridge anchored at (cx, cz),
     * bypassing the BuildMode pointer flow. Returns the placed structure id
     * or null on failure. Critical for E2E because `import()` from the
     * playwright/eval context gets a different module instance than the
     * bundle (Vite HMR appends `?t=...` to the bundle's import URL), so a
     * structure added via eval lives in a different registry than the loop
     * reads. Going through this hook hits the same `addBuiltStructure` the
     * tool uses.
     */
    __BELLBOUND_DEBUG_PLACE_BRIDGE__?: (cx: number, cz: number) => string | null;
  }
}

// Wrapped in `async function main()` so the `await bootTerrain(...)` below is a
// regular await, not a top-level await. Vite's default esbuild build target
// (es2020 / chrome87 / safari14) does not support TLA — production build fails
// otherwise. Body kept at column 0 to minimise the diff against the previous
// module-level layout; semantically the whole imperative entrypoint just runs
// inside one async function now.
async function main(): Promise<void> {

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

// Boot the terrain singleton BEFORE the scene reads it. Dev hooks supply a
// pre-mounted save / mint pair; production wires the same fields from the
// inscription fetch (Phase A). With neither hook set, `bootTerrain` ends up
// at the analytical-bake fallback path — same outcome as the previous lazy
// `getTerrainGrid()` first read, just with deterministic boot timing.
const __saveState = window.__BELLBOUND_SAVE__?.state;
const __mintFields = window.__BELLBOUND_MINT__?.initial_state;
const __bootResult = await bootTerrain({ save: __saveState?.terrain, mint: __mintFields });
if (__bootResult.fatalMintErrors.length > 0) {
  console.error('[bellbound] island mint terrain metadata invalid:', __bootResult.fatalMintErrors);
}
if (__bootResult.errors.length > 0) {
  console.warn('[bellbound] terrain save load errors:', __bootResult.errors);
}

// Step 9.1: load player-placed structures (bridges, staircases, inclines).
// Empty list when there's no save — registry is then in its post-init state
// and `getBuiltStructures()` returns []. Errors here are non-fatal: validated
// structures install, the rest are skipped with a warning.
const __structResult = bootBuiltStructures(__saveState?.built_structures, GRID_W, GRID_D);
if (__structResult.errors.length > 0) {
  console.warn('[bellbound] built_structures load errors:', __structResult.errors);
}

const island = createIslandScene();
initTerraformFx(island.scene);

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

// Step 9.2: bridge deck meshes. One Group child per placed bridge, rebuilt
// on every placement / removal. Initial sync covers any structures the boot
// path loaded from `island_save.state.built_structures`.
const bridgeMeshGroup = new THREE.Group();
bridgeMeshGroup.name = 'bridge-meshes';
island.scene.add(bridgeMeshGroup);
function rebuildBridgeMeshes(): void {
  syncBridgeMeshes(bridgeMeshGroup, getBuiltStructures(), (cx, cz) => {
    return terraformGrid.cellHeight(cx, cz);
  });
}
rebuildBridgeMeshes();
if (import.meta.env.DEV) {
  window.__BELLBOUND_DEBUG_REBUILD_BRIDGES__ = rebuildBridgeMeshes;
  window.__BELLBOUND_DEBUG_PLACE_BRIDGE__ = (cx: number, cz: number) => {
    const placement = findBridgePlacement(terraformGrid, getBuiltStructures(), cx, cz);
    if (!placement) return null;
    const result = addBuiltStructure(placement.serialized, GRID_W, GRID_D);
    if (!result.structure) return null;
    rebuildBridgeMeshes();
    return result.structure.id;
  };
}

// AC-style terraforming view: while a tool is active, flatten the world (kill
// the parabolic rolling warp) AND switch the camera to a steep top-down
// perspective. Without the camera switch, raised plateaus visually occlude
// the cells BEHIND them, so the user can never aim at those — the raycast
// hits the plateau top first. Steep top-down minimizes the occluded area
// because most cells are seen from nearly straight above.
let _savedRollingCurvature: number | null = null;
let _savedCameraPitch: number | null = null;
let _savedCameraDistance: number | null = null;
const BUILD_MODE_CAMERA_PITCH = 1.50;     // ≈ 86° down — almost vertical so 1-cell gaps and holes between plateaus stay aimable
const BUILD_MODE_CAMERA_DISTANCE = 26;    // farther so a wider area is visible at this steep angle
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

// Undo ring buffer (D15). Each terraforming stroke (one click, or a full
// drag from pointerdown to pointerup) is captured as a list of `{cx, cz,
// byteBefore}` snapshots. Ctrl+Z pops the most recent stroke, restores all
// bytes verbatim, and rebuilds. Capped at 30 strokes so a long session
// can't grow unbounded.
const UNDO_CAPACITY = 30;
type EditEntry = { cx: number; cz: number; byteBefore: number };
type EditStroke = EditEntry[];
const editHistory: EditStroke[] = [];
let currentStroke: EditStroke | null = null;
/**
 * Wrap a TerraformTool so successful applies record a "before" snapshot into
 * the active stroke. The snapshot is taken BEFORE delegating to the original
 * apply so the byte read reflects the un-mutated state. Failed applies (tool
 * returned an error) record nothing — undo only sees real edits.
 */
function trackUndo(tool: TerraformTool): TerraformTool {
  const original = tool.apply;
  return {
    ...tool,
    apply(cx, cz) {
      const byteBefore = terraformGrid.getRawByte(cx, cz);
      const err = original.call(tool, cx, cz);
      if (err === null && currentStroke
          && !currentStroke.some((e) => e.cx === cx && e.cz === cz)) {
        currentStroke.push({ cx, cz, byteBefore });
      }
      return err;
    },
  };
}
function commitStroke(): void {
  if (!currentStroke) return;
  if (currentStroke.length > 0) {
    editHistory.push(currentStroke);
    if (editHistory.length > UNDO_CAPACITY) editHistory.shift();
  }
  currentStroke = null;
}
function undoLastStroke(): void {
  const stroke = editHistory.pop();
  if (!stroke || stroke.length === 0) return;
  // Restore in reverse order so the LIFO read on the dirty queue still picks
  // the most recently touched cells last.
  for (let i = stroke.length - 1; i >= 0; i--) {
    terraformGrid.setRawByte(stroke[i].cx, stroke[i].cz, stroke[i].byteBefore);
  }
  rebuildTerrain(island);
}

// AC-style restriction: sand (the coastal beach band) cannot be terraformed —
// no cliffs raised on it, no water dug into it. Threshold 0.4 mirrors the
// `surfaceClassification.ts` "fully sand" cutoff so the visible sand zone and
// the gameplay restriction agree. Once a cell is at T1+ it's a cliff plateau,
// no longer "sandy" semantically, so further raises stay legal.
const BEACH_TERRAFORM_THRESHOLD = 0.4;
function isBeachCell(cx: number, cz: number): boolean {
  const wx = TERRAIN_ORIGIN.x + (cx + 0.5);
  const wz = TERRAIN_ORIGIN.z + (cz + 0.5);
  return sampleIslandShape(wx, wz).beachT >= BEACH_TERRAFORM_THRESHOLD;
}
/**
 * True if the player's collision circle would overlap the cell's 1×1
 * footprint. Used to refuse cliff edits on cells the player stands on
 * AND on cells *adjacent* to the player — the freshly-built cliff wall
 * otherwise passes through the player's body when they're standing right
 * against the edge.
 *
 * Computed as the squared distance from the player's center to the closest
 * point on the cell's AABB; if it's ≤ collision radius squared, the wall
 * would clip into the player and we refuse the edit.
 */
const PLAYER_CLIFF_MARGIN = 0.05; // small extra slack so flush against the wall is still refused
function playerOverlapsCell(cx: number, cz: number): boolean {
  const p = island.player.position;
  const minX = TERRAIN_ORIGIN.x + cx;
  const maxX = minX + 1;
  const minZ = TERRAIN_ORIGIN.z + cz;
  const maxZ = minZ + 1;
  const closestX = Math.max(minX, Math.min(p.x, maxX));
  const closestZ = Math.max(minZ, Math.min(p.z, maxZ));
  const dx = p.x - closestX;
  const dz = p.z - closestZ;
  const r = PLAYER_COLLISION_RADIUS + PLAYER_CLIFF_MARGIN;
  return dx * dx + dz * dz < r * r;
}

buildMode.registerTool(trackUndo({
  kind: 'cliff_raise',
  label: 'Élever falaise',
  canApply: (cx, cz) => {
    if (!terraformGrid.cellInBounds(cx, cz)) return false;
    if (terraformGrid.getSurface(cx, cz) !== Surface.LAND) return false;
    if (terraformGrid.getTier(cx, cz) >= Tier.T3) return false;
    // Stricter than just the player's cell: any cell whose footprint
    // overlaps the player's collision circle is refused, so a cliff wall
    // raised flush against them never clips into their body.
    if (playerOverlapsCell(cx, cz)) return false;
    if (terraformGrid.getTier(cx, cz) === Tier.T0 && isBeachCell(cx, cz)) return false;
    return true;
  },
  apply: (cx, cz) => {
    const err = terraformGrid.raiseCell(cx, cz);
    if (err) return err.reason;
    rebuildTerrain(island);
    spawnFxAtCell(cx, cz, 'cliff');
    return null;
  },
}));

buildMode.registerTool(trackUndo({
  kind: 'cliff_lower',
  label: 'Abaisser falaise',
  canApply: (cx, cz) => {
    if (!terraformGrid.cellInBounds(cx, cz)) return false;
    if (terraformGrid.getSurface(cx, cz) !== Surface.LAND) return false;
    if (terraformGrid.getTier(cx, cz) <= Tier.T0) return false;
    // Same overlap rule as cliff_raise — lowering a cell adjacent to the
    // player drops the wall they're leaning against and re-snaps their
    // standing height a frame later, easy to mis-read as a teleport.
    if (playerOverlapsCell(cx, cz)) return false;
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
    spawnFxAtCell(cx, cz, 'cliff');
    return null;
  },
}));

buildMode.registerTool(trackUndo({
  kind: 'water_dig',
  label: 'Creuser eau',
  canApply: (cx, cz) => {
    if (!terraformGrid.cellInBounds(cx, cz)) return false;
    // Permissive: LAND will dig, FRESHWATER is a silent no-op (already water).
    // This keeps the cursor green during a drag stroke even after each cell
    // turns FRESHWATER — the natural read for "the brush passes over the
    // tile it just affected" is "still valid", not "now refused".
    const s = terraformGrid.getSurface(cx, cz);
    if (s !== Surface.LAND && s !== Surface.FRESHWATER) return false;
    // No water on the coastal sand band (would erode the silhouette).
    if (s === Surface.LAND && isBeachCell(cx, cz)) return false;
    return true;
  },
  apply: (cx, cz) => {
    if (terraformGrid.getSurface(cx, cz) === Surface.FRESHWATER) return null; // no-op, cursor stays green
    const err = terraformGrid.digFreshwater(cx, cz);
    if (err) return err.reason;
    rebuildTerrain(island);
    spawnFxAtCell(cx, cz, 'water');
    return null;
  },
}));

buildMode.registerTool(trackUndo({
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
    spawnFxAtCell(cx, cz, 'water');
    return null;
  },
}));

// Path tools (Step 7). 4-style MVP: dirt / stone / brick / planks. Each tool
// is a thin wrapper around `paintPath` with a different style index — the
// `terrainSplatMaterial` fragment shader looks up the style from the path
// byte and re-tints the dirt sample accordingly (no per-style texture).
//
// Path edits go through `updatePathMaskCell` instead of `rebuildTerrain`:
// only the 94×78 R8 path mask changes — geometry, surface maps, waterfalls,
// cliff sides are all unaffected. Drag-paint stays smooth (one texSubImage
// upload per cell vs. a full surface-map bake + multi-mesh rebuild).
const PATH_STYLES = [
  { kind: 'path_paint_dirt',   label: 'Chemin terre',  style: 1, tint: 0xa87a4f },
  { kind: 'path_paint_stone',  label: 'Chemin pierre', style: 2, tint: 0x9e9e9e },
  { kind: 'path_paint_brick',  label: 'Chemin brique', style: 3, tint: 0xc64d3a },
  { kind: 'path_paint_planks', label: 'Chemin bois',   style: 4, tint: 0xc89150 },
] as const;
for (const { kind, label, style, tint } of PATH_STYLES) {
  buildMode.registerTool(trackUndo({
    kind,
    label,
    canApply: (cx, cz) => {
      if (!terraformGrid.cellInBounds(cx, cz)) return false;
      if (terraformGrid.getSurface(cx, cz) !== Surface.LAND) return false;
      // Skip cells already painted with this exact style — keeps the cursor
      // green during drag (the apply is a no-op) but prevents a useless
      // re-write churning the path mask.
      return terraformGrid.getCell(cx, cz).path !== style;
    },
    apply: (cx, cz) => {
      const err = terraformGrid.paintPath(cx, cz, style);
      if (err) return err.reason;
      updatePathMaskCell(island, cx, cz);
      spawnFxAtCell(cx, cz, 'path', tint);
      return null;
    },
  }));
}

buildMode.registerTool(trackUndo({
  kind: 'path_erase',
  label: 'Effacer chemin',
  canApply: (cx, cz) => {
    if (!terraformGrid.cellInBounds(cx, cz)) return false;
    if (terraformGrid.getSurface(cx, cz) !== Surface.LAND) return false;
    return terraformGrid.getCell(cx, cz).path !== 0;
  },
  apply: (cx, cz) => {
    const err = terraformGrid.erasePath(cx, cz);
    if (err) return err.reason;
    updatePathMaskCell(island, cx, cz);
    spawnFxAtCell(cx, cz, 'path', 0xd4b08a);
    return null;
  },
}));

// Step 9.2: bridge placement tool. The cursor anchors at the LAND start cell;
// `findBridgePlacement` auto-picks the first cardinal rotation that produces
// a valid LAND-FRESHWATER-LAND span (length=3 fixed v1). Manual rotation
// (R key) lands as a polish pass once we want length>3 bridges.
//
// Bridge edits sit OUTSIDE the byte-level undo ring buffer — they don't
// touch grid bytes, just the structures registry. A separate "remove bridge"
// tool lands in the bridges-polish pass; for v1 placement is one-way.
buildMode.registerTool({
  kind: 'bridge_place',
  label: 'Pont',
  canApply: (cx, cz) => {
    return findBridgePlacement(terraformGrid, getBuiltStructures(), cx, cz) !== null;
  },
  apply: (cx, cz) => {
    const placement = findBridgePlacement(terraformGrid, getBuiltStructures(), cx, cz);
    if (!placement) return 'no_valid_placement';
    const result = addBuiltStructure(placement.serialized, GRID_W, GRID_D);
    if (!result.structure) return result.errors[0] ?? 'add_structure_failed';
    rebuildBridgeMeshes();
    return null;
  },
});

/**
 * Spawn the post-edit visual feedback at the cell's current top. Called
 * AFTER the grid has been mutated so the dust/splash sits on top of the new
 * surface (a freshly-raised tier, a freshly-dug pond's water plane, etc.).
 */
function spawnFxAtCell(cx: number, cz: number, kind: 'cliff' | 'water' | 'path', tint?: number): void {
  if (!terraformGrid.cellInBounds(cx, cz)) return;
  const wx = TERRAIN_ORIGIN.x + (cx + 0.5);
  const wz = TERRAIN_ORIGIN.z + (cz + 0.5);
  const y = terraformGrid.cellHeight(cx, cz);
  if (kind === 'cliff') spawnDustPuff(wx, y, wz);
  else if (kind === 'water') spawnSplash(wx, y, wz);
  else spawnPathPop(wx, y, wz, tint);
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && buildMode.isActive()) {
    buildMode.exit();
    event.preventDefault();
    return;
  }

  // Ctrl+Z (Cmd+Z on macOS) — undo last terraforming stroke. Only handled
  // while build mode is active so the shortcut doesn't interfere with
  // browser/system text fields or the dev console.
  if (event.code === 'KeyZ' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
    if (buildMode.isActive()) {
      undoLastStroke();
      event.preventDefault();
    }
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

// Drag-to-paint: pointerdown starts a paint stroke, pointermove applies the
// tool on each NEW cell the cursor crosses (dedupe by cell so we don't run a
// full rebuild on every frame), pointerup ends the stroke. Useful for paths
// and water carving where one-cell-at-a-time clicks were tedious. Cliff
// raise/lower also benefits — drag along a ridge to raise it.
let isPainting = false;
let lastPaintedCell: [number, number] | null = null;

sceneCanvas.addEventListener('pointermove', (event) => {
  buildMode.setPointer(event.clientX, event.clientY, sceneCanvas);
  if (!isPainting || !buildMode.isActive()) return;
  buildMode.update(island.camera);
  const cell = buildMode.getCursorCell();
  if (!cell) return;
  if (lastPaintedCell && cell[0] === lastPaintedCell[0] && cell[1] === lastPaintedCell[1]) return;
  if (buildMode.tryPlace()) {
    lastPaintedCell = [cell[0], cell[1]];
  }
});
sceneCanvas.addEventListener('pointerdown', (event) => {
  if (!buildMode.isActive()) return;
  if (event.button !== 0) return; // left-click only
  isPainting = true;
  lastPaintedCell = null;
  // Open a new undo stroke before any tool runs so trackUndo() captures
  // every successful apply during this pointerdown→pointerup span.
  currentStroke = [];
  buildMode.setPointer(event.clientX, event.clientY, sceneCanvas);
  buildMode.update(island.camera);
  if (buildMode.tryPlace()) {
    const cell = buildMode.getCursorCell();
    if (cell) lastPaintedCell = [cell[0], cell[1]];
  }
  event.preventDefault();
});
sceneCanvas.addEventListener('pointerup', () => {
  isPainting = false;
  lastPaintedCell = null;
  commitStroke();
});
sceneCanvas.addEventListener('pointerleave', () => {
  isPainting = false;
  lastPaintedCell = null;
  commitStroke();
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

  // Step 9.3 movement resolver. The Step 4 wading-relax wrapper is GONE: the
  // player now goes through `terrainGrid.isTraversable(prev, to, structures)`
  // verbatim, which blocks every LAND → FRESHWATER transition unless a bridge
  // structure spans both cells. Bridges placed via the Step 9.2 tool feed
  // `getBuiltStructures()` here so traversal opens up exactly where a deck
  // exists. Same body-probe pattern (cardinal + diagonals at
  // PLAYER_COLLISION_RADIUS) so the player never pokes past a boundary
  // before being stopped.
  const builtStructures: readonly BuiltStructure[] = getBuiltStructures();
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
      if (!terrainGrid.isTraversable(prevCx, prevCz, probeCx, probeCz, builtStructures)) return true;
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

  // pushPlayerOutOfRiver is intentionally NOT called: with strict
  // isTraversable + bridge connectivity (Step 9.3) the player cannot enter a
  // FRESHWATER cell unless the bridge structure spans both cells, so there
  // is nothing to push them out of. Soft-locking by terraforming water under
  // their feet is prevented by the player-overlap check in raise/dig tools.

  let targetY = getPlayerStandingHeight(
    island.player.position.x,
    island.player.position.z,
  );
  // Step 9.3 Y override: when the player's cell sits inside a bridge's
  // occupiedCells, ignore the FRESHWATER bed Y reported by the heightmap and
  // use the bridge deck Y (= LAND tier top of the placement-locked endpoint).
  // Same-tier endpoints are guaranteed by canPlaceBridge, so any cell in
  // occupiedCells shares that tier — sampling originCell is canonical.
  const [pCx, pCz] = terrainGrid.worldToCell(
    island.player.position.x,
    island.player.position.z,
  );
  for (const s of builtStructures) {
    if (s.kind !== 'bridge') continue;
    let onDeck = false;
    for (const [bx, bz] of s.occupiedCells) {
      if (bx === pCx && bz === pCz) { onDeck = true; break; }
    }
    if (onDeck) {
      targetY = terrainGrid.cellHeight(s.originCell[0], s.originCell[1]);
      break;
    }
  }
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
  updateTerraformFx(elapsed);
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

} // end async function main()

void main().catch((err) => {
  console.error('[bellbound] fatal boot error:', err);
});
