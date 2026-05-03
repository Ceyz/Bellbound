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
    // Fully opaque so the river bed (the LAND quad at y = tier - 0.5 with
    // splat shader painting wet-sand / dirt) doesn't bleed through the water
    // surface at oblique angles. The 8% transparency the previous version
    // shipped read as a glitchy brown strip at the bank edge from any 3D
    // camera angle (visible through the thinner-looking water at the edge),
    // even though the spec'd canyon look (D17) intended to expose that
    // material at a single pixel-line edge. Going fully opaque reads as a
    // cleaner blue surface; the bed is still rendered for player physics
    // (cellHeight returns the bed Y for FW cells) but never seen.
    depthWrite: true,
    emissive: 0xffffff,
    metalness: 0,
    opacity: 1.0,
    roughness: 1.0,
    side: THREE.DoubleSide,
    transparent: false,
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

// Composition: 2-stop palette + 2 noise scales for ACNH-painted variation
// + very subtle directional streaks. The 2026-04-29 ship was flat because
// previous streaks at high freq read as glitchy beige bands; this version
// drops the streak frequency to ~0.7/m and intensity to 6%, which reads as
// soft current rather than bright stripes. Edge darkening near banks is
// deferred — requires the riverMask uniform which the freshwater material
// doesn't yet receive (that lives on the splat material).
const FRAGMENT_BODY = `
vec2 wxz = vFreshwaterWorldXZ;
float broadWave = fwNoise(wxz * 0.13 + vec2(0.055, -0.025) * uTime);
float fineWave  = fwNoise(wxz * 0.55 + vec2(-0.018, 0.030) * uTime);

vec3 riverGreen = vec3(0.16, 0.66, 0.82);
vec3 riverLight = vec3(0.42, 0.90, 0.95);
vec3 freshwaterColor = mix(riverGreen, riverLight, broadWave * 0.45 + fineWave * 0.15);

// Soft directional streaks — the streak field rolls slowly along +X over
// time. Mix in a tiny brightening (6% max) so the surface has movement
// without the previously-glitchy beige bands. Streaks scale at 0.7/m so on
// a 1m cell a player sees less than one streak; that prevents the chunky
// swirl read.
float streak = sin((wxz.x + wxz.y * 0.4) * 0.7 + uTime * 0.6);
streak = streak * 0.5 + 0.5;
freshwaterColor += vec3(0.04, 0.06, 0.06) * smoothstep(0.65, 1.0, streak);
`;
