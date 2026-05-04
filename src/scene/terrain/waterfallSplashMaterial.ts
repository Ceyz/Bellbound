import * as THREE from 'three';

/**
 * Horizontal splash disc — sits at the foot of every cascade landing in a
 * FRESHWATER pond, rendering animated radial ripples + a bright foam centre
 * + flickering foam pulses. Distinct from the cascade's own pool-froth band
 * (which lives on the vertical waterfall quad's bottom 50 cm and gives the
 * "white blur" the user already sees) — this disc EXTENDS the splash
 * outward onto the receiving water plane so the impact reads as a radial
 * burst rather than a frozen white stripe.
 *
 * UV convention required by the builder: `vSplashUv` is in WORLD METERS
 * relative to the splash CENTRE (cascade foot). length(uv) = distance in
 * metres from the impact point. Independent of quad world position, so the
 * ripple cadence and radius look identical for cascades anywhere on the
 * map.
 *
 * Lighting: same lit-independent emissive routing as the cascade material.
 * Alpha-blended so the disc's edge fades softly into the surrounding pond.
 */

interface WaterfallSplashUniforms {
  uTime: THREE.IUniform<number>;
}

export function createWaterfallSplashMaterial(): THREE.MeshStandardMaterial {
  const uniforms: WaterfallSplashUniforms = {
    uTime: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    // Stronger polygonOffset than the freshwater mesh (which has none),
    // so the splash disc wins the depth test against the pond surface
    // it sits on. Keep depthWrite OFF so subsequent transparent passes
    // (e.g., player shadow) still composite normally over the pond.
    depthWrite: false,
    emissive: 0xffffff,
    metalness: 0,
    opacity: 1.0,
    polygonOffset: true,
    polygonOffsetFactor: -8,
    polygonOffsetUnits: -8,
    roughness: 1.0,
    side: THREE.DoubleSide,
    transparent: true,
  });
  material.name = 'waterfall-splash';
  material.userData.waterfallSplashUniforms = uniforms;

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
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance = splashColor;\ndiffuseColor.a *= splashAlpha;',
    );
  };

  material.customProgramCacheKey = () => 'waterfall-splash:v3-foam-pad';
  material.needsUpdate = true;

  return material;
}

export function updateWaterfallSplashMaterial(
  material: THREE.MeshStandardMaterial,
  elapsed: number,
) {
  const uniforms = material.userData.waterfallSplashUniforms as WaterfallSplashUniforms | undefined;
  if (!uniforms) return;
  uniforms.uTime.value = elapsed;
}

const VERTEX_HEADER = `
varying vec2 vSplashUv;
`;

const VERTEX_BODY = `
vSplashUv = uv;
`;

const FRAGMENT_HEADER = `
varying vec2 vSplashUv;
uniform float uTime;

float spHash(vec2 p) {
  return fract(sin(dot(p, vec2(53.7, 197.3))) * 17345.5453);
}
`;

// Composition (ACNH-inspired): the impact reads as a thick white foam
// PAD with constant turbulence inside it, ringed by expanding ripples
// and outer secondary waves. Layered:
//
//   1. CORE FLASH         — bright white impact spot, pulses 1.5 Hz
//   2. FOAM PAD           — dense white plateau out to ~35 cm, mostly
//                            opaque so the cascade reads as REALLY hitting
//                            the water (not a faint puddle)
//   3. CELL-CLUSTER FOAM  — 3 layers of cell-noise "bubble clusters"
//                            scrolling outward at different speeds,
//                            stacked → dense bubbly turbulence on the pad
//   4. EXPANDING RINGS    — 3 fast rings (Gaussian) born at centre,
//                            radial speed ~0.6/0.5/0.4 r/s → always at
//                            least one ring visible expanding
//   5. OUTER CHOP         — sine-based concentric waves outside the pad
//                            for surface ripple
//   6. SPARKLES           — pinpoint hash flickers near the centre
//   7. EDGE WOBBLE        — low-freq noise modulating the disc radius so
//                            the silhouette is organic
const FRAGMENT_BODY = `
vec2 offset = vSplashUv;
float dist = length(offset);
float angle = atan(offset.y, offset.x);

// 7) Edge wobble — angular low-freq noise modulating the radius, so the
//    splash silhouette breaks the "perfect circle" tell.
float edgeNoise = (spHash(floor(vec2(angle * 5.0, 0.0))) - 0.5) * 0.08;
float radius = 0.66 + edgeNoise;
float fade = 1.0 - smoothstep(radius * 0.55, radius, dist);

// 1) Core flash — bright pulse at the impact point.
float pulse = 0.88 + 0.12 * sin(uTime * 9.0);
float core = (1.0 - smoothstep(0.0, 0.15, dist)) * pulse;

// 2) Foam pad — dense white plateau out to 35 cm. Smooth-stepped fade
//    so the inner foam is ~95 % white and the boundary feathers to 0.
float pad = 1.0 - smoothstep(0.20, 0.42, dist);

// 3) Cell-cluster foam — 3 layers of bubble clusters scrolling outward
//    at different rates. Each layer hashes (angle, dist - vt) so the
//    bubbles drift away from the centre over time. Layered with max
//    so the pad has dense turbulence, never a flat color.
vec2 fcoord1 = vec2(angle * 6.0,  dist * 11.0 - uTime * 1.30);
vec2 fcoord2 = vec2(angle * 9.0  + 1.7, dist * 16.0 - uTime * 1.65);
vec2 fcoord3 = vec2(angle * 13.0 + 3.3, dist * 7.0  - uTime * 0.85);
float foam1 = smoothstep(0.50, 1.0, spHash(floor(fcoord1)));
float foam2 = smoothstep(0.58, 1.0, spHash(floor(fcoord2)));
float foam3 = smoothstep(0.55, 1.0, spHash(floor(fcoord3)));
float foamCluster = max(max(foam1, foam2), foam3);

// 4) Expanding rings — 3 Gaussian rings that grow outward from the
//    centre. Three offset cycles so the eye always sees at least one
//    fresh ring expanding. Decay (1 - t) over the cycle so each ring
//    fades as it grows.
float t1 = fract(uTime * 0.78);
float ring1 = exp(-pow((dist - t1 * radius) * 16.0, 2.0)) * (1.0 - t1);
float t2 = fract(uTime * 0.55 + 0.33);
float ring2 = exp(-pow((dist - t2 * radius) * 22.0, 2.0)) * (1.0 - t2);
float t3 = fract(uTime * 0.40 + 0.66);
float ring3 = exp(-pow((dist - t3 * radius) * 28.0, 2.0)) * (1.0 - t3);
float rings = max(max(ring1, ring2), ring3);

// 5) Outer chop — sine waves on the radial axis OUTSIDE the foam pad,
//    giving the surface light surface ripple beyond the impact.
float chopRaw = sin(dist * 18.0 - uTime * 4.2) * 0.5 + 0.5;
float chop = smoothstep(0.65, 1.0, chopRaw)
  * smoothstep(0.34, 0.46, dist)
  * smoothstep(radius * 0.95, radius * 0.62, dist);

// 6) Sparkles — pinpoint flickers concentrated near the impact.
vec2 sparkleCoord = vec2(angle * 26.0 + uTime * 0.4, dist * 34.0 - uTime * 0.9);
float sparkle = spHash(floor(sparkleCoord));
sparkle = smoothstep(0.93, 1.0, sparkle)
  * (1.0 - smoothstep(0.05, 0.50, dist)) * 0.95;

// Composition — additive whites on top of pale baseColor.
vec3 baseColor = vec3(0.58, 0.86, 0.96);
vec3 foamColor = vec3(1.0);

float whiteAmount = clamp(
  core * 1.10
  + pad * 0.90
  + foamCluster * pad * 0.85
  + rings * 0.95
  + chop * 0.55
  + sparkle * 0.95,
  0.0, 1.0
);
vec3 splashColor = mix(baseColor, foamColor, whiteAmount);

// Tiny brightness boost at the very centre so the impact "pops".
splashColor += vec3(core * 0.30);

float intensity =
  core
  + pad * 0.75
  + rings * 0.80
  + foamCluster * pad * 0.45
  + chop * 0.40
  + sparkle * 0.50;
float splashAlpha = clamp(fade * (0.40 + intensity * 0.70), 0.0, 0.97);
`;
