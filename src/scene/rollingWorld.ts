import * as THREE from 'three';

export interface RollingObject {
  flatPosition: THREE.Vector3;
  object: THREE.Object3D;
}

/**
 * Live-tunable parabolic curvature config (exposed in lil-gui for A0 calibration).
 *
 * **Why parabolic instead of cylindrical:** the previous cylindrical formula
 * `y = (R - cos(z/R)*R)` wraps around when `z > R*π/2`, producing a folded surface
 * (the ground disappeared past ~25 m at radius 30). The parabolic formula
 * `y = -k * z²` never wraps, scales linearly with a single intuitive `curvature`
 * parameter, and is the standard approach in NotSlot / Alastair Aitchison /
 * Skylar Beaty AC-shader tutorials.
 *
 * - `curvature`: scalar steepness (range 0 → 0.01).
 *     - 0.001 → very subtle (NotSlot subtle default)
 *     - 0.003 → noticeable AC-feel
 *     - 0.005 → strong "rolling earth"
 *     - 0      → flat (off)
 * - `applyXAxis`: when true, also curve along X (left-right). Combines with Z to give
 *   a spherical roll (full ACNH ball). When false, only Z (cylindrical "log roll").
 *
 * Defaults set 2026-04-28 to a noticeable but stable AC-feel on the 80×64 m island.
 */
export const rollingConfig = {
  curvature: 0.0035,
  applyXAxis: true,
  version: 0,
};

/**
 * Single shared uniforms object referenced by every patched material.
 * Mutating these `.value` fields immediately propagates to all rolling surfaces this frame.
 */
export const sharedRollingUniforms: Record<string, THREE.IUniform<number>> = {
  uOriginX: { value: 0 },
  uOriginZ: { value: 0 },
  uCurvature: { value: rollingConfig.curvature },
  uApplyXAxis: { value: rollingConfig.applyXAxis ? 1 : 0 },
};

/** API-compat: still exported for any existing caller; bumps a version counter. */
export function invalidateRollingCache() {
  rollingConfig.version += 1;
}

const ROLLING_VERTEX_GLSL_HEADER = `
uniform float uOriginX;
uniform float uOriginZ;
uniform float uCurvature;
uniform float uApplyXAxis;
`;

/**
 * Replaces the standard <project_vertex> chunk with a parabolic vertex displacement.
 *
 * Math: `worldY -= curvature * (deltaZ² + (applyX ? deltaX² : 0))`.
 *   - No trig, no wrap-around even at large distances.
 *   - Only the Y coordinate is modified — X and Z are preserved, so XY/XZ alignment with
 *     CPU-side rolling objects (trees, house) stays exact.
 *   - Lighting still uses the un-warped `transformed`/`objectNormal`, which is acceptable
 *     and visually preferable for an AC-style cozy game (ground stays evenly lit even
 *     where the curvature would otherwise rotate it under the camera).
 *
 * **Variable naming:** the local is `_rollPos`, NOT `worldPosition`. Three.js's
 * `<worldpos_vertex>` chunk (executed AFTER our replacement, used by shadows/lighting)
 * conditionally declares its own `vec4 worldPosition` — same-name redeclaration is a
 * GLSL compile error and silently breaks the material (the surface vanishes, exposing
 * scene.background through it). Hit this 2026-04-28; do not regress.
 */
const ROLLING_VERTEX_GLSL_PROJECT = `
vec4 _rollPos = modelMatrix * vec4(transformed, 1.0);

float _rollDeltaZ = _rollPos.z - uOriginZ;
_rollPos.y -= _rollDeltaZ * _rollDeltaZ * uCurvature;

if (uApplyXAxis > 0.5) {
  float _rollDeltaX = _rollPos.x - uOriginX;
  _rollPos.y -= _rollDeltaX * _rollDeltaX * uCurvature;
}

vec4 mvPosition = viewMatrix * _rollPos;
gl_Position = projectionMatrix * mvPosition;
`;

/**
 * Additional patch injected AFTER `<worldpos_vertex>`: re-applies the same parabolic warp
 * to the `worldPosition` varying that Three.js builds for shadow / envmap / transmission
 * lookups. Without this, shadows are projected onto the FLAT y=0 plane while the visible
 * ground is warped, so shadows from distant objects appear to "float" detached from the
 * actual ground. The condition matches Three.js's own guard in `<worldpos_vertex>` so the
 * `worldPosition` variable is guaranteed to be declared.
 */
const ROLLING_VERTEX_GLSL_WORLDPOS_PATCH = `
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  float _rollWpDeltaZ = worldPosition.z - uOriginZ;
  worldPosition.y -= _rollWpDeltaZ * _rollWpDeltaZ * uCurvature;
  if (uApplyXAxis > 0.5) {
    float _rollWpDeltaX = worldPosition.x - uOriginX;
    worldPosition.y -= _rollWpDeltaX * _rollWpDeltaX * uCurvature;
  }
#endif
`;

/**
 * Patches a material's vertex shader so its rendered geometry is warped on the GPU
 * around the player position. Call this ONCE per material, ideally right after creation,
 * before the first render. Multiple materials share the same uniform objects, so a single
 * `updateRollingShaderUniforms` call per frame syncs them all.
 */
export function applyRollingShaderTo(material: THREE.Material) {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);

    Object.assign(shader.uniforms, sharedRollingUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROLLING_VERTEX_GLSL_HEADER}`)
      .replace('#include <project_vertex>', ROLLING_VERTEX_GLSL_PROJECT)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\n${ROLLING_VERTEX_GLSL_WORLDPOS_PATCH}`,
      );
  };

  // Append a marker to the program cache key so Three.js does NOT mistake a
  // rolling-warped material for a non-warped one when their other properties
  // match. Without this, two materials sharing the same `customProgramCacheKey`
  // (e.g. both ran through `applyAcnhLighting` and so both report 'acnh:v1')
  // would resolve to the same compiled program — and whichever variant got
  // compiled first would be reused for the other, leaving GPU-warped meshes
  // (bridge, staircase, cliff walls, river bank lips) with a non-warped shader
  // that doesn't follow the parabolic curvature, producing the visible
  // "floating platform / altitude moves with the player" bug.
  const previousKey = material.customProgramCacheKey
    ? material.customProgramCacheKey.bind(material)
    : null;
  material.customProgramCacheKey = () => {
    const prev = previousKey ? previousKey() : '';
    return prev ? `${prev}|rolling` : 'rolling';
  };

  // Force re-compile in case the material had already been used by the renderer.
  material.needsUpdate = true;
}

/**
 * Disable frustum culling on the mesh — the warp can push vertices far enough off-axis
 * that Three.js's bounding-box culling would erroneously hide the surface. Call once
 * after assigning the material, on each rolling surface mesh.
 */
export function disableFrustumCullingForRolling(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>,
) {
  mesh.frustumCulled = false;
}

/**
 * Same intent as `disableFrustumCullingForRolling` but applied to every Mesh descendant
 * of a Group. Three.js culls per-mesh, so a Group containing several meshes (bridge with
 * deck + rails, staircase, etc.) needs each child individually flagged. Use this for any
 * composite object that participates in the rolling world.
 */
export function disableFrustumCullingRecursive(root: THREE.Object3D) {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.frustumCulled = false;
    }
  });
}

/** Sync the GPU uniforms with rollingConfig + the player's current world position. Cheap O(1). */
export function updateRollingShaderUniforms(originX: number, originZ: number) {
  sharedRollingUniforms.uOriginX.value = originX;
  sharedRollingUniforms.uOriginZ.value = originZ;
  sharedRollingUniforms.uCurvature.value = rollingConfig.curvature;
  sharedRollingUniforms.uApplyXAxis.value = rollingConfig.applyXAxis ? 1 : 0;
}

export function createRollingObject(object: THREE.Object3D): RollingObject {
  return {
    flatPosition: object.position.clone(),
    object,
  };
}

/**
 * CPU-side warp for a discrete object (house, tree, shopkeeper). Math is identical to the
 * GLSL in `ROLLING_VERTEX_GLSL_PROJECT` to keep objects perfectly aligned with the warped ground.
 *
 * This stays on the CPU because the object count is tiny (~5–10) and the geometry of each
 * object is NOT warped (only its position) — that matches ACNH where buildings stay rigid
 * but sit on the curved surface.
 */
export function updateRollingObject(
  rollingObject: RollingObject,
  originX: number,
  originZ: number,
) {
  const { curvature, applyXAxis } = rollingConfig;
  const { flatPosition } = rollingObject;

  const deltaZ = flatPosition.z - originZ;
  let yOffset = -deltaZ * deltaZ * curvature;

  if (applyXAxis) {
    const deltaX = flatPosition.x - originX;
    yOffset -= deltaX * deltaX * curvature;
  }

  rollingObject.object.position.set(
    flatPosition.x,
    flatPosition.y + yOffset,
    flatPosition.z,
  );
}
