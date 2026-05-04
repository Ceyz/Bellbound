import * as THREE from 'three';

/**
 * Vertical MIST plume rising from the cascade foot. Sits on a small
 * vertical quad facing the cascade-fall direction (so it billboards
 * roughly toward the player when they look at the cascade). Renders a
 * soft animated white haze that fades from bright at the base (water
 * level) to transparent at the top, with low-freq turbulent noise giving
 * it body. Without this the splash reads as a flat horizontal puddle —
 * the mist sells the impact's vertical energy (water blasted upward).
 *
 * UV convention required by the builder:
 *   u in [0, 1] across the cascade-edge tangent
 *   v in [0, 1] from base (0) to top (1) of the mist column
 *
 * Lighting: same lit-independent emissive routing as the cascade and
 * splash materials. Alpha-blended so the haze fades into the sky/cliff
 * behind it.
 */

interface WaterfallMistUniforms {
  uTime: THREE.IUniform<number>;
}

export function createWaterfallMistMaterial(): THREE.MeshStandardMaterial {
  const uniforms: WaterfallMistUniforms = {
    uTime: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    depthWrite: false,
    emissive: 0xffffff,
    metalness: 0,
    opacity: 1.0,
    polygonOffset: true,
    polygonOffsetFactor: -12,
    polygonOffsetUnits: -12,
    roughness: 1.0,
    side: THREE.DoubleSide,
    transparent: true,
  });
  material.name = 'waterfall-mist';
  material.userData.waterfallMistUniforms = uniforms;

  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${VERTEX_HEADER}`,
    ).replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>\n${VERTEX_BODY}`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${FRAGMENT_HEADER}`,
    ).replace(
      '#include <map_fragment>',
      FRAGMENT_BODY,
    ).replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance = mistColor;\ndiffuseColor.a *= mistAlpha;',
    );
  };

  material.customProgramCacheKey = () => 'waterfall-mist:v1';
  material.needsUpdate = true;

  return material;
}

export function updateWaterfallMistMaterial(
  material: THREE.MeshStandardMaterial,
  elapsed: number,
) {
  const uniforms = material.userData.waterfallMistUniforms as WaterfallMistUniforms | undefined;
  if (!uniforms) return;
  uniforms.uTime.value = elapsed;
}

const VERTEX_HEADER = `
varying vec2 vMistUv;
`;

const VERTEX_BODY = `
vMistUv = uv;
`;

const FRAGMENT_HEADER = `
varying vec2 vMistUv;
uniform float uTime;

float mistHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float mistNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = mistHash(i);
  float b = mistHash(i + vec2(1.0, 0.0));
  float c = mistHash(i + vec2(0.0, 1.0));
  float d = mistHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

// Composition:
//   - 2-octave FBM scrolling slowly upward → "haze drifting up"
//   - Vertical alpha gradient: opaque at base, fully transparent at top
//   - Horizontal gradient: opaque centre, fades at the left/right edges
//   - HOT BAND at the very base where the mist meets the water — extra
//     bright, simulates the foam crown rising from the impact
//   - Tiny droplet pinpoints throughout the haze for "spray" feel
const FRAGMENT_BODY = `
vec2 uv = vMistUv;
float u = uv.x;          // along cascade edge (0..1)
float v = uv.y;          // height (0 = base, 1 = top)

// Vertical haze: 2-octave FBM scrolling upward at different rates.
float n1 = mistNoise(vec2(u * 4.0, v * 3.0 - uTime * 0.55));
float n2 = mistNoise(vec2(u * 9.0 + 7.3, v * 6.5 - uTime * 0.85));
float haze = n1 * 0.65 + n2 * 0.35;

// Verticality gradient: bright at base, fades upward. ACNH mist plumes
// are densest right above the impact, thinning toward the top.
float vFalloff = 1.0 - smoothstep(0.05, 1.0, v);
vFalloff = pow(vFalloff, 1.4);

// Horizontal soft edge: fade at left/right of the mist quad so the
// silhouette is feathered, not a hard rectangle.
float uFalloff = 1.0 - smoothstep(0.30, 0.50, abs(u - 0.5));

// Hot foam crown at the base — extra bright in the bottom 20 % so the
// mist visually emerges from the splash pad below.
float crown = smoothstep(0.20, 0.0, v) * 0.85;

// Spray droplets — tiny bright cells floating through the haze.
vec2 dropCoord = vec2(u * 14.0 + uTime * 0.4, v * 22.0 - uTime * 1.6);
float dropHash = mistHash(floor(dropCoord));
float drops = smoothstep(0.78, 1.0, dropHash) * 0.7;

// Composition — pure white emissive, alpha drives the haze visibility.
vec3 mistColor = vec3(1.0);

float density = clamp(
  haze * vFalloff + crown + drops * vFalloff,
  0.0, 1.0
);
float mistAlpha = clamp(density * uFalloff * 0.85, 0.0, 0.92);
`;
