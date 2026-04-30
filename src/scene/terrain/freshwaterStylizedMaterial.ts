import * as THREE from 'three';

/**
 * Freshwater (river / pond) shader.
 *
 * Distinct from `waterStylizedMaterial` (ocean) in three ways:
 *
 *  1. **Palette**: green-blue, two-stop with directional flow streaks. No deep
 *     tropical cyan, no pale shallow band, no warm sand peeking through —
 *     freshwater on a 1m bed reads as inland water, not an ocean.
 *  2. **No foam / whitecaps / shore wash**: those are ocean-only effects (foam
 *     bands at SDF=0, whitecaps offshore, beach wave system). Rivers are calm.
 *  3. **Flat surface**: the geometry is per-cell quads at a tier-locked Y. We
 *     don't displace vertices for waves — rivers don't roll.
 *
 * Lighting: same lit-independent emissive trick as the ocean shader — the
 * freshwater color is routed through `totalEmissiveRadiance` so the day/night
 * cycle's lighting tints the painted color as a tinted overlay rather than
 * completely darkening it during sunset/night.
 */

interface FreshwaterUniforms {
  uTime: THREE.IUniform<number>;
}

export function createFreshwaterStylizedMaterial(): THREE.MeshStandardMaterial {
  const uniforms: FreshwaterUniforms = {
    uTime: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    depthWrite: false,
    emissive: 0xffffff,
    metalness: 0,
    opacity: 0.92,
    roughness: 1.0,
    side: THREE.DoubleSide,
    transparent: true,
  });
  material.name = 'freshwater-stylized';
  material.userData.freshwaterUniforms = uniforms;

  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${VERTEX_HEADER}`,
    ).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${VERTEX_BODY}`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${FRAGMENT_HEADER}`,
    ).replace(
      '#include <map_fragment>',
      FRAGMENT_BODY,
    ).replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance = freshwaterColor;',
    );
  };

  material.customProgramCacheKey = () => 'freshwater-stylized:v1';
  material.needsUpdate = true;

  return material;
}

export function updateFreshwaterStylizedMaterial(
  material: THREE.MeshStandardMaterial,
  elapsed: number,
) {
  const uniforms = material.userData.freshwaterUniforms as FreshwaterUniforms | undefined;
  if (!uniforms) return;
  uniforms.uTime.value = elapsed;
}

const VERTEX_HEADER = `
varying vec2 vFreshwaterWorldXZ;
`;

const VERTEX_BODY = `
vec3 _fwWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFreshwaterWorldXZ = _fwWorldPos.xz;
`;

const FRAGMENT_HEADER = `
varying vec2 vFreshwaterWorldXZ;
uniform float uTime;

float fwHash(vec2 p) {
  return fract(sin(dot(p, vec2(41.7, 289.3))) * 23857.5453);
}

float fwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fwHash(i);
  float b = fwHash(i + vec2(1.0, 0.0));
  float c = fwHash(i + vec2(0.0, 1.0));
  float d = fwHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

// Composition: 2-stop green palette + 2 layers of directional flow streaks
// scrolling downstream. No foam, no waves, no shore effects.
const FRAGMENT_BODY = `
vec2 wxz = vFreshwaterWorldXZ;

// Broad slow noise drives the base color blend (lighter on crests of slow swells).
float broadWave = fwNoise(wxz * 0.13 + vec2(0.055, -0.025) * uTime);

// Two-stop palette. Green-blue base, lighter highlight where broadWave is high.
vec3 riverGreen = vec3(0.16, 0.66, 0.82);
vec3 riverLight = vec3(0.42, 0.90, 0.95);
vec3 freshwaterColor = mix(riverGreen, riverLight, broadWave);

// Primary flow streak — fast, oriented along world X (rivers in the
// current heightmap snake east-west; future grid edits can rotate the flow
// per-component but this is fine for MVP).
vec2 flowUv1 = wxz * vec2(0.55, 1.40) + vec2(uTime * 0.55, 0.0);
float streak1 = smoothstep(0.55, 0.88, fwNoise(flowUv1));
freshwaterColor = mix(freshwaterColor, freshwaterColor * 1.18 + vec3(0.05, 0.06, 0.06), streak1 * 0.55);

// Secondary slower streak adds depth so the flow doesn't tile.
vec2 flowUv2 = wxz * vec2(0.32, 0.85) + vec2(uTime * 0.32 + 1.7, 0.0);
float streak2 = smoothstep(0.62, 0.92, fwNoise(flowUv2));
freshwaterColor = mix(freshwaterColor, freshwaterColor * 0.86, streak2 * 0.30);
`;
