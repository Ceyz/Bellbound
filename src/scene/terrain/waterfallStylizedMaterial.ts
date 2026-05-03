import * as THREE from 'three';

/**
 * Waterfall shader. Distinct from `freshwaterStylizedMaterial` (calm river
 * surface) and `waterStylizedMaterial` (ocean) because falling water reads
 * very differently from a flat plane: vertical white streaks, foam at the
 * crest, soft mist at the base.
 *
 * UV encoding required by the builder: `vMapUv.y` MUST be in METERS along
 * the drop (0 at the pool, drop_meters at the crest). `vMapUv.x` MUST be
 * in METERS along the cell edge. The shader uses world-metric UVs so the
 * streaks keep a fixed visual width (≈ 12 cm) and a fixed fall speed
 * (≈ 1.6 m/s) regardless of how tall or wide the cascade is.
 *
 * Lighting: same lit-independent emissive routing as the freshwater material.
 * Without this, vertical sheets receive almost no overhead light and render
 * pitch-dark at noon.
 */

interface WaterfallUniforms {
  uTime: THREE.IUniform<number>;
}

export function createWaterfallStylizedMaterial(): THREE.MeshStandardMaterial {
  const uniforms: WaterfallUniforms = {
    uTime: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    depthWrite: true,
    emissive: 0xffffff,
    metalness: 0,
    opacity: 1.0,
    roughness: 1.0,
    side: THREE.DoubleSide,
    transparent: false,
  });
  material.name = 'waterfall-stylized';
  material.userData.waterfallUniforms = uniforms;

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
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance = waterfallColor;',
    );
  };

  material.customProgramCacheKey = () => 'waterfall-stylized:v1';
  material.needsUpdate = true;

  return material;
}

export function updateWaterfallStylizedMaterial(
  material: THREE.MeshStandardMaterial,
  elapsed: number,
) {
  const uniforms = material.userData.waterfallUniforms as WaterfallUniforms | undefined;
  if (!uniforms) return;
  uniforms.uTime.value = elapsed;
}

const VERTEX_HEADER = `
attribute float aDropMeters;
varying vec2 vWaterfallUv;
varying float vDropMeters;
`;

const VERTEX_BODY = `
vWaterfallUv = uv;
vDropMeters = aDropMeters;
`;

const FRAGMENT_HEADER = `
varying vec2 vWaterfallUv;
varying float vDropMeters;
uniform float uTime;

float wfHash(vec2 p) {
  return fract(sin(dot(p, vec2(53.7, 197.3))) * 17345.5453);
}

// 1D smoothed noise along an axis — used to give the streaks soft edges
// without triggering the GLSL noise() availability difference between WebGL
// 1 and 2.
float wfBand(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(wfHash(vec2(i, 0.0)), wfHash(vec2(i + 1.0, 0.0)), u);
}
`;

// Composition (bottom = pool, top = crest, both in world meters):
//   - base gradient: pale top, slightly deeper at the pool
//   - 3 streak layers at different frequencies + speeds → cohesive falling
//     feel without looking like one repeating texture
//   - crest foam: bright band in the top ~12 cm, brightest at the very lip
//   - pool mist: desaturated darker band in the bottom ~10 cm, suggests
//     churning into the receiving water without a particle system
const FRAGMENT_BODY = `
float dropV = vWaterfallUv.y;          // meters from pool (0) to crest
float spanU = vWaterfallUv.x;          // meters along the cascade width
float fallTime = uTime * 1.6;          // ~1.6 m/s downward

// Base palette: top is the pale freshwater color; the pool reads slightly
// deeper. Both stay unsaturated so the cascade does not punch through the
// scene as a neon stripe.
vec3 crestColor = vec3(0.62, 0.86, 0.95);
vec3 poolColor  = vec3(0.30, 0.62, 0.78);
vec3 baseColor  = mix(poolColor, crestColor, smoothstep(0.0, 0.6, dropV));

// 3 streak layers: 8 streaks/m, 5 streaks/m, 13 streaks/m at slightly
// different speeds. Each layer is a smoothstep around the band center so
// streaks have soft edges. uStr is the streak's own world-X coordinate
// (constant for a given streak), so streaks do not wobble sideways.
float l1 = wfBand(spanU * 8.0);
float l2 = wfBand(spanU * 5.0 + 13.7);
float l3 = wfBand(spanU * 13.0 + 4.1);

// Vertical phase per streak: random 0..1 offset so streaks of the same
// frequency are not in lockstep. Each layer gets its own falling speed.
float ph1 = fract(l1 + dropV * 1.6 + fallTime);
float ph2 = fract(l2 + dropV * 2.3 + fallTime * 1.18);
float ph3 = fract(l3 + dropV * 3.4 + fallTime * 0.84);

// Streak intensity from each phase: a soft pulse around 0 (since fract
// wraps) gives a falling band. Width tuned so the brightest band is ~6 cm
// equivalent and the soft edge fades over ~12 cm.
float band1 = smoothstep(0.30, 0.0, ph1) * 0.55;
float band2 = smoothstep(0.22, 0.0, ph2) * 0.40;
float band3 = smoothstep(0.18, 0.0, ph3) * 0.30;
float streakAmount = clamp(band1 + band2 + band3, 0.0, 1.0);

// Crest foam — top 12 cm fades to bright white. The cascade meets the
// horizontal freshwater quad above; this band hides the seam. dropV runs
// 0 (pool) to vDropMeters (crest), so the crest band is the top 12 cm of
// the actual cascade height regardless of how tall it is.
float topDistance = vDropMeters - dropV;
float crestFoam = smoothstep(0.12, 0.0, topDistance);

// Pool mist — bottom 10 cm desaturates and darkens slightly. This sells
// the "falling into a pool" idea without a particle system. dropV near 0
// is the pool surface.
float poolMist = smoothstep(0.10, 0.0, dropV);

vec3 streakColor = vec3(0.94, 0.97, 1.00);
vec3 waterfallColor = mix(baseColor, streakColor, streakAmount);
waterfallColor = mix(waterfallColor, vec3(1.0), crestFoam * 0.55);
waterfallColor = mix(waterfallColor, vec3(0.36, 0.55, 0.66), poolMist * 0.45);
`;
