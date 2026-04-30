import * as THREE from 'three';

/**
 * Stylized lighting accent for cozy ACNH-feel objects: rim lighting at silhouettes
 * + cool blue-violet tint on shadowed pixels. Patches a `MeshStandardMaterial` so
 * the standard physical lighting still runs, then layers two extra terms on top of
 * `outgoingLight` before the final tonemap/colorspace conversion.
 *
 * Two concerns combined into one patch (vs two onBeforeCompile chains):
 *  1. **Rim**: fresnel-style highlight at glancing angles — `pow(1 - N·V, k)`.
 *     Reads as a thin warm halo at the silhouette and "pops" props from the
 *     background like ACNH small figurines.
 *  2. **Shadow tint**: heuristic that lifts dark pixels (low luma) toward a cool
 *     blue-violet, mimicking how ambient sky bleeds into shadows in real life and
 *     also ACNH's stylized cool shadows. We use luma rather than direct shadow
 *     attenuation so the term works on objects without shadow casting and keeps
 *     the patch self-contained (no light-uniform plumbing required).
 *
 * Composes correctly with `applyRollingShaderTo` (different chunks: vertex
 * `<project_vertex>` / `<worldpos_vertex>` vs fragment `<output_fragment>`).
 * The `onBeforeCompile` chain saves the previous binding before overwriting, so
 * patches stack in either order.
 */

export interface AcnhLightingOptions {
  /** Strength of the rim highlight in the [0, 1] range. Default 0.45. */
  rimStrength?: number;
  /** Color of the rim highlight (warm cream by default). */
  rimColor?: THREE.ColorRepresentation;
  /** Power applied to the fresnel term. Higher = thinner rim. Default 2.0. */
  rimPower?: number;
  /** Strength of the cool shadow recolor (mix factor 0..1). Default 0.45. */
  shadowTintStrength?: number;
  /** Color of the shadow tint (cool lavender by default). */
  shadowTintColor?: THREE.ColorRepresentation;
}

const DEFAULT_RIM_COLOR = 0xfff0c8;          // warm cream highlight
const DEFAULT_SHADOW_TINT_COLOR = 0xa0a8e0;  // pastel lavender (lighter than before:
//                                              the previous deep blue 0x4a558e was so
//                                              dark in linear space that the additive
//                                              mix barely shifted shadow hue at all)

interface AcnhLightingUniforms {
  uAcnhRimColor: THREE.IUniform<THREE.Color>;
  uAcnhRimStrength: THREE.IUniform<number>;
  uAcnhRimPower: THREE.IUniform<number>;
  uAcnhShadowTintColor: THREE.IUniform<THREE.Color>;
  uAcnhShadowTintStrength: THREE.IUniform<number>;
}

export function applyAcnhLighting(
  material: THREE.MeshStandardMaterial,
  options: AcnhLightingOptions = {},
): void {
  const uniforms: AcnhLightingUniforms = {
    uAcnhRimColor: { value: new THREE.Color(options.rimColor ?? DEFAULT_RIM_COLOR) },
    uAcnhRimStrength: { value: options.rimStrength ?? 0.45 },
    uAcnhRimPower: { value: options.rimPower ?? 2.0 },
    uAcnhShadowTintColor: {
      value: new THREE.Color(options.shadowTintColor ?? DEFAULT_SHADOW_TINT_COLOR),
    },
    uAcnhShadowTintStrength: { value: options.shadowTintStrength ?? 0.45 },
  };
  material.userData.acnhLightingUniforms = uniforms;

  const previousCompile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <output_fragment>',
      ACNH_FRAGMENT_PATCH,
    );
  };

  const previousKey = material.customProgramCacheKey
    ? material.customProgramCacheKey.bind(material)
    : null;
  material.customProgramCacheKey = () => {
    const prev = previousKey ? previousKey() : '';
    return prev ? `${prev}|acnh:v2` : 'acnh:v2';
  };
  material.needsUpdate = true;
}

/**
 * Walks `root` and applies `applyAcnhLighting` to every unique
 * `MeshStandardMaterial` reachable from it (de-duplicated via a Set so a material
 * shared between meshes is patched exactly once).
 */
export function applyAcnhLightingRecursive(
  root: THREE.Object3D,
  options: AcnhLightingOptions = {},
): void {
  const materials = new Set<THREE.MeshStandardMaterial>();
  root.traverse((child) => {
    if (
      child instanceof THREE.Mesh
      && child.material instanceof THREE.MeshStandardMaterial
    ) {
      materials.add(child.material);
    }
  });
  for (const material of materials) {
    applyAcnhLighting(material, options);
  }
}

const ACNH_FRAGMENT_PATCH = `
{
  // Rim highlight (additive): warm cream halo at glancing angles.
  vec3 _acnhViewDir = normalize(vViewPosition);
  vec3 _acnhNormal = normalize(vNormal);
  float _acnhFresnel = pow(
    1.0 - max(dot(_acnhNormal, _acnhViewDir), 0.0),
    uAcnhRimPower
  );
  outgoingLight += uAcnhRimColor * _acnhFresnel * uAcnhRimStrength;

  // Shadow recolor (mix, NOT additive): blends dark pixels toward the cool tint
  // color so shadows clearly read as blue-violet instead of grey/black. The
  // previous additive version was so subtle that the tint was invisible — we now
  // shift hue by mixing 45 % toward lavender on the darkest pixels (luma < 0.20),
  // tapering to 0 % at mid-luma (0.55).
  float _acnhLuma = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
  float _acnhShadowness = 1.0 - smoothstep(0.20, 0.55, _acnhLuma);
  vec3 _acnhTintedShadow = mix(outgoingLight, uAcnhShadowTintColor * 0.55, 0.55);
  outgoingLight = mix(
    outgoingLight,
    _acnhTintedShadow,
    _acnhShadowness * uAcnhShadowTintStrength
  );
}
#include <output_fragment>
`;
