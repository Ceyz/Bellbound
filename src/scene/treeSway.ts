import * as THREE from 'three';

/**
 * Globally-shared sway uniforms — one timestamp drives every patched tree material so
 * trees swing on a single wind clock. Per-tree variation is derived in the shader from
 * `modelMatrix[3].xz`, so each instance phases differently without requiring its own
 * material instance or uniform.
 *
 * Wind direction is a 2D vector in world XZ; magnitude is independent (uWindStrength).
 * Defaults are tuned for the cozy ACNH-feel: a slow easterly breeze with a moderate
 * canopy amplitude.
 */
export const sharedTreeSwayUniforms = {
  uTime: { value: 0 },
  uWindStrength: { value: 1.0 },
  uWindDirection: { value: new THREE.Vector2(1, 0).normalize() },
};

const TREE_SWAY_VERTEX_HEADER = `
uniform float uTime;
uniform float uWindStrength;
uniform vec2 uWindDirection;
`;

/**
 * Replaces `<begin_vertex>` with the standard initialiser PLUS a cantilever bend rotation
 * of `transformed`. The whole canopy pivots around the trunk base (y=0 in mesh-local space)
 * via a Rodrigues rotation around a horizontal axis perpendicular to the wind direction.
 * Bend angle is gated by `position.y` so the trunk stays rigid and the tip moves most —
 * the rotation preserves per-slice geometry (no axis-aligned stretching), which is what
 * makes the result read as wind rather than as a vertex deformation artifact.
 *
 * **Mask:** `pow(smoothstep(0.4, 2.5, position.y), 2)` — squared so the tip swings noticeably
 * more than the mid-canopy, matching real tree mechanics. Thresholds assume the loader bakes
 * geometry such that the mesh sits with base at y≈0 and top near y≈3 m (see `treeAsset.ts`).
 *
 * **Per-tree phase:** the model matrix's translation column is each tree's world origin;
 * combining X * 0.31 + Z * 0.27 yields a unique offset per tree that's invariant across
 * frames (modulo the tiny CPU-rolling translation, which is not visually objectionable).
 *
 * **Leaf flutter:** a tiny per-vertex high-frequency offset added on top of the bend, gated
 * by the same canopy mask. Pure visual sweetener so the bent canopy doesn't read as a single
 * rigid disc — physically meaningless but the eye expects to see leaves twitch.
 */
const TREE_SWAY_VERTEX_PATCH = `
vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
  vPosition = vec3( position );
#endif

{
  vec3 _treeWorldOrigin = vec3(modelMatrix[3].x, 0.0, modelMatrix[3].z);
  float _swayPhase = _treeWorldOrigin.x * 0.31 + _treeWorldOrigin.z * 0.27;

  // Narrow mask transition: trunk stays rigid up to y=1.0, then mask climbs to full
  // by y=1.3. Above y=1.3, every canopy vertex receives the SAME bend angle, so the
  // entire canopy rotates as a single rigid body around the trunk pivot — no per-slice
  // geometry distortion. The narrow band between 1.0 and 1.3 is the only part that
  // deforms; for typical Meshy foliage that band is just the top of the trunk where
  // branches start, so the visible artifact is hidden inside the canopy silhouette.
  float _bendMask = smoothstep(1.0, 1.3, position.y);

  // Single-frequency oscillation for a calm, predictable sway. The two-frequency mix
  // looked livelier but produced visible non-uniform stretching when the harmonics
  // beat against each other through the masked rotation.
  float _bendAngle = uWindStrength * 0.05 * _bendMask
                   * sin(uTime * 1.2 + _swayPhase);

  vec3 _bendAxis = normalize(vec3(-uWindDirection.y, 0.0, -uWindDirection.x));

  float _c = cos(_bendAngle);
  float _s = sin(_bendAngle);
  vec3 _v = transformed;
  transformed = _v * _c
              + cross(_bendAxis, _v) * _s
              + _bendAxis * dot(_bendAxis, _v) * (1.0 - _c);
}
`;

/**
 * Patches a material's vertex shader so its rendered geometry sways in the wind. Idempotent
 * intent: do not call twice on the same material — the second call would stack the patch.
 *
 * Composes cleanly with `applyAcnhLighting` (fragment-side only) since they touch disjoint
 * shader chunks.
 */
export function applyTreeSwayShaderTo(material: THREE.Material): void {
  const previousCompile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer);
    Object.assign(shader.uniforms, sharedTreeSwayUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TREE_SWAY_VERTEX_HEADER}`)
      .replace('#include <begin_vertex>', TREE_SWAY_VERTEX_PATCH);
  };

  const previousKey = material.customProgramCacheKey
    ? material.customProgramCacheKey.bind(material)
    : null;
  material.customProgramCacheKey = () => {
    const prev = previousKey ? previousKey() : '';
    return prev ? `${prev}|treeSway:v1` : 'treeSway:v1';
  };
  material.needsUpdate = true;
}

export function updateTreeSwayUniforms(elapsed: number): void {
  sharedTreeSwayUniforms.uTime.value = elapsed;
}

interface TreeShakeState {
  startedAt: number;
  duration: number;
  amplitude: number;
  /** Unit XZ direction the canopy initially tilts toward (= away from the impact). */
  dirX: number;
  dirZ: number;
}

const SHAKE_DURATION_S = 0.7;
const SHAKE_AMPLITUDE_RAD = 0.10;

/**
 * Kicks a per-tree wobble. The tree group's rotation is driven each frame by
 * `updateTreeShake` until the dampened oscillation settles. `fromX/fromZ` is the
 * impact origin (typically the player's XZ); the canopy tilts away from it first.
 *
 * Debounced: a fresh trigger within the first 25% of an active wobble is ignored
 * so repeated bumps don't snap the rotation back to the start of the curve.
 */
export function triggerTreeShake(
  tree: THREE.Object3D,
  elapsed: number,
  fromX: number,
  fromZ: number,
): void {
  const dx = tree.position.x - fromX;
  const dz = tree.position.z - fromZ;
  const length = Math.hypot(dx, dz) || 1;

  const previous = tree.userData.shakeState as TreeShakeState | undefined;
  if (previous) {
    const t = (elapsed - previous.startedAt) / previous.duration;
    if (t < 0.25) return;
  }

  tree.userData.shakeState = {
    startedAt: elapsed,
    duration: SHAKE_DURATION_S,
    amplitude: SHAKE_AMPLITUDE_RAD,
    dirX: dx / length,
    dirZ: dz / length,
  } satisfies TreeShakeState;
}

/**
 * Updates one tree's rotation to reflect its shake state, if any. Call from the per-frame
 * tick for every tree in `island.trees`. Cheap when no shake is active.
 *
 * The wobble is a damped sinusoid: `amplitude * exp(-3.5 * t) * sin(2π * f * t)`, with
 * f ≈ 3.25 cycles over the shake duration so the player perceives ~2 visible swings.
 *
 * Mapping to Euler axes:
 *  - Tilt along world +X is achieved with `rotation.z = -angle` (right-hand rule on Z).
 *  - Tilt along world +Z is achieved with `rotation.x = +angle`.
 */
export function updateTreeShake(tree: THREE.Object3D, elapsed: number): void {
  const state = tree.userData.shakeState as TreeShakeState | undefined;
  if (!state) {
    return;
  }

  const t = (elapsed - state.startedAt) / state.duration;
  if (t >= 1) {
    tree.rotation.x = 0;
    tree.rotation.z = 0;
    delete tree.userData.shakeState;
    return;
  }

  const decay = Math.exp(-3.5 * t);
  const wobble = state.amplitude * decay * Math.sin(t * Math.PI * 6.5);
  tree.rotation.z = -state.dirX * wobble;
  tree.rotation.x = state.dirZ * wobble;
}
