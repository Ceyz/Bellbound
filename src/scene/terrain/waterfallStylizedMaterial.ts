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
    // PolygonOffset stronger than the cliff wall (-4, -4) so the cascade
    // wins the depth test against its rock backing — without this the
    // cliff wall behind the cascade re-emerges (we removed the FW-upper
    // skip in cliffSideMeshBuilder so the rock backing exists, otherwise
    // the user sees nothing behind the cascade).
    polygonOffset: true,
    polygonOffsetFactor: -10,
    polygonOffsetUnits: -10,
    roughness: 1.0,
    // FrontSide so the cascade only renders on its outward-facing face.
    side: THREE.FrontSide,
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
//   - 5 streak layers at staggered frequencies + speeds, each with a slow
//     horizontal wobble keyed to dropV so streaks curve like real falling
//     water instead of running ruler-straight
//   - foam droplets: small bright spots scattered through the cascade body
//     for a "spray" feel
//   - crest foam: bright band in the top ~14 cm where the water enters
//   - pool froth: bright band in the bottom ~16 cm where the water lands,
//     replacing the previous "darken" approach which read as a shadow
const FRAGMENT_BODY = `
float dropV = vWaterfallUv.y;          // meters from pool (0) to crest
float spanU = vWaterfallUv.x;          // meters along the cascade width
float fallTime = uTime * 1.6;          // ~1.6 m/s downward

// Slow horizontal wobble (~5 cm peak) so streaks meander instead of
// running dead straight. The wobble keys off dropV with a wide period so
// adjacent streaks lean the same way locally.
float wobble = sin(dropV * 1.7 + uTime * 0.6) * 0.05;
float spanW = spanU + wobble;

// Base palette: top is the pale freshwater color; the pool reads slightly
// deeper. Both stay unsaturated so the cascade does not punch through the
// scene as a neon stripe.
vec3 crestColor = vec3(0.66, 0.88, 0.96);
vec3 poolColor  = vec3(0.32, 0.64, 0.79);
vec3 baseColor  = mix(poolColor, crestColor, smoothstep(0.0, 0.6, dropV));

// 5 streak layers — wider range of frequencies + softer per-layer
// intensities so the result reads as "many fine threads of water" rather
// than 3 thick painted bands.
float l1 = wfBand(spanW * 7.0);
float l2 = wfBand(spanW * 4.5 + 13.7);
float l3 = wfBand(spanW * 11.5 + 4.1);
float l4 = wfBand(spanW * 17.0 + 21.3);
float l5 = wfBand(spanW * 2.7 + 8.9);

float ph1 = fract(l1 + dropV * 1.6 + fallTime);
float ph2 = fract(l2 + dropV * 2.3 + fallTime * 1.18);
float ph3 = fract(l3 + dropV * 3.4 + fallTime * 0.84);
float ph4 = fract(l4 + dropV * 5.1 + fallTime * 1.42);
float ph5 = fract(l5 + dropV * 0.9 + fallTime * 0.62);

float band1 = smoothstep(0.28, 0.0, ph1) * 0.42;
float band2 = smoothstep(0.20, 0.0, ph2) * 0.36;
float band3 = smoothstep(0.16, 0.0, ph3) * 0.30;
float band4 = smoothstep(0.10, 0.0, ph4) * 0.22;
float band5 = smoothstep(0.34, 0.0, ph5) * 0.28;
float streakAmount = clamp(band1 + band2 + band3 + band4 + band5, 0.0, 1.0);

// Foam droplets: cell-noise-based bright spots that flicker briefly. They
// are sparse (high threshold) so the cascade does not look polka-dotted.
vec2 dropletCoord = vec2(spanW * 12.0, dropV * 18.0 - fallTime * 7.0);
float droplet = wfHash(floor(dropletCoord));
droplet = smoothstep(0.94, 1.0, droplet) * 0.6;

// Crest foam — top 14 cm fades to bright white at the lip.
float topDistance = vDropMeters - dropV;
float crestFoam = smoothstep(0.14, 0.0, topDistance);

// Pool froth — bottom 50 cm: bright animated splash where the cascade
// hits the pool. Three layers stacked:
//   - foamPulse: cell-noise bubbles that pop on/off at different freqs
//   - horizPulse: horizontal "ripple bands" that scroll outward from the
//     base, simulating the radial spray spreading across the pool. Faster
//     pulse rate so the eye reads it as a constant churn even on stills.
//   - the envelope is now a SOFTER fade so the splash extends visibly
//     upward 50 cm into the cascade body.
float poolFroth = smoothstep(0.50, 0.0, dropV);
vec2 froth1 = vec2(spanW * 6.0, dropV * 8.0 + uTime * 2.4);
vec2 froth2 = vec2(spanW * 14.0 - 3.7, dropV * 3.0 - uTime * 3.1);
float foamPulse1 = wfHash(floor(froth1));
float foamPulse2 = wfHash(floor(froth2));
float foamPulse = max(
  smoothstep(0.55, 1.0, foamPulse1),
  smoothstep(0.62, 1.0, foamPulse2)
);
float horizPulse = sin(spanW * 22.0 + dropV * 5.0 - uTime * 6.0) * 0.5 + 0.5;
horizPulse *= sin(dropV * 18.0 + uTime * 4.0) * 0.5 + 0.5;
float splash = poolFroth * (0.55 + foamPulse * 0.45 + horizPulse * 0.35);

vec3 streakColor = vec3(0.97, 0.99, 1.00);
vec3 waterfallColor = mix(baseColor, streakColor, streakAmount);
waterfallColor = mix(waterfallColor, streakColor, droplet);
waterfallColor = mix(waterfallColor, vec3(1.0), crestFoam * 0.58);
waterfallColor = mix(waterfallColor, vec3(1.0), clamp(splash, 0.0, 1.0) * 0.92);
`;
