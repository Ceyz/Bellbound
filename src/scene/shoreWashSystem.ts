import * as THREE from 'three';
import { getIslandHeight } from './heightmap';
import { sampleShoreAnchors } from './islandShape';
import { rollingConfig, sharedRollingUniforms } from './rollingWorld';

/**
 * Shore-wash ribbon: a single closed-ring mesh hugging the SDF shoreline with a
 * width that overlaps both wet sand and shallow ocean. It masks the terrain/water
 * join and carries the visible swash: a translucent water sheet whose front moves
 * inland and offshore, with a foam crest riding on that moving waterline.
 *
 * Geometry layout:
 *   - For each of N anchors sampled along the shoreline, two vertices are placed:
 *     `inner` at -INLAND_OFFSET along the outward normal (i.e. pushed into the island),
 *     and `outer` at +OFFSHORE_OFFSET. Indexing weaves a closed triangle strip.
 *   - The `aWashUv` attribute carries (u, v) where u ∈ [0, 1] runs around the ring
 *     and v ∈ [0, 1] runs across the band (0 = inland edge, 1 = offshore edge).
 *
 * Why a separate mesh and not the water shader: the water plane is 116×100 m and
 * has neither the geometric resolution nor the world-positioning to render a 3 m-wide
 * foam ribbon following an organic SDF without precision issues at distance, and
 * pushing more shader work onto every water fragment would waste fillrate where the
 * coast isn't visible. A 144-anchor ring is ~288 verts / 288 tris — negligible cost.
 */

/** Number of anchors sampled along the shoreline for the ring mesh. Bumped to 720
 *  to keep each segment roughly 30-40 cm long, reducing the polygonal
 *  "flat sides" visible on the wash ribbon at the cozy camera distance. */
const SHORE_ANCHOR_COUNT = 1440;
/** Cross-shore subdivisions: enough vertices for visible water-surface deformation. */
const SHORE_CROSS_SECTION_COUNT = 12;
/** Meters the ribbon extends inland from the SDF=0 line (wave run-up on sand). */
const INLAND_OFFSET_METERS = 2.35;
/** Meters the ribbon extends offshore from the SDF=0 line (blends into ocean). */
const OFFSHORE_OFFSET_METERS = 3.10;
const SHORELINE_V = INLAND_OFFSET_METERS / (INLAND_OFFSET_METERS + OFFSHORE_OFFSET_METERS);
/**
 * Y altitudes for the wash mesh edges. Now that the water plane sits at -0.35 m
 * (lowered to keep the deeper BEACH_DIP=0.30 m sand strictly above water), the
 * outer and inland edges follow the local terrain altitude + 5.5 cm. MIN_WASH_Y caps the
 * ribbon so it never sinks below the shallow-water overlay height, in case the
 * heightmap is sampled in a deep dip. This keeps the transparent wash above the
 * terrain depth buffer at the exact SDF border.
 */
const WASH_SURFACE_Y_OFFSET = 0.070;
const MIN_WASH_Y = -0.245;

export interface ShoreWashSystem {
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

export function createShoreWashSystem(): ShoreWashSystem {
  const anchors = sampleShoreAnchors(SHORE_ANCHOR_COUNT);
  const columnCount = anchors.length + 1;
  const vertexCount = columnCount * SHORE_CROSS_SECTION_COUNT;

  const positions = new Float32Array(vertexCount * 3);
  const washUvs = new Float32Array(vertexCount * 2);

  for (let i = 0; i < columnCount; i += 1) {
    const anchor = anchors[i % anchors.length];
    const u = i / anchors.length;
    for (let row = 0; row < SHORE_CROSS_SECTION_COUNT; row += 1) {
      const v = row / (SHORE_CROSS_SECTION_COUNT - 1);
      const offset = -INLAND_OFFSET_METERS + v * (INLAND_OFFSET_METERS + OFFSHORE_OFFSET_METERS);
      const x = anchor.x + anchor.normalX * offset;
      const z = anchor.z + anchor.normalZ * offset;
      const y = Math.max(getIslandHeight(x, z) + WASH_SURFACE_Y_OFFSET, MIN_WASH_Y);
      const index = i * SHORE_CROSS_SECTION_COUNT + row;

      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
      washUvs[index * 2] = u;
      washUvs[index * 2 + 1] = v;
    }
  }

  // Closed triangle strip indexing — the last quad bridges anchor (N-1) and anchor 0
  // so the ribbon wraps cleanly around the entire island silhouette.
  const indices = new Uint16Array(anchors.length * (SHORE_CROSS_SECTION_COUNT - 1) * 6);
  for (let i = 0; i < anchors.length; i += 1) {
    const next = i + 1;
    for (let row = 0; row < SHORE_CROSS_SECTION_COUNT - 1; row += 1) {
      const a = i * SHORE_CROSS_SECTION_COUNT + row;
      const b = i * SHORE_CROSS_SECTION_COUNT + row + 1;
      const c = next * SHORE_CROSS_SECTION_COUNT + row;
      const d = next * SHORE_CROSS_SECTION_COUNT + row + 1;
      const base = (i * (SHORE_CROSS_SECTION_COUNT - 1) + row) * 6;
      indices[base] = a;
      indices[base + 1] = b;
      indices[base + 2] = c;
      indices[base + 3] = b;
      indices[base + 4] = d;
      indices[base + 5] = c;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aWashUv', new THREE.BufferAttribute(washUvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uOriginX: sharedRollingUniforms.uOriginX,
      uOriginZ: sharedRollingUniforms.uOriginZ,
      uCurvature: sharedRollingUniforms.uCurvature,
      uApplyXAxis: sharedRollingUniforms.uApplyXAxis,
      uTime: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
  });
  material.name = 'shore-wash-material';
  material.customProgramCacheKey = () => 'shore-wash:v27';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'shore-wash-ring';
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  // Render after the water (renderOrder default 0) and the beachWaveSystem (2) so
  // the wash sits visually on top, where it belongs.
  mesh.renderOrder = 3;

  return { material, mesh };
}

export function updateShoreWashSystem(system: ShoreWashSystem, elapsed: number): void {
  system.material.uniforms.uTime.value = elapsed;
  system.material.uniforms.uCurvature.value = rollingConfig.curvature;
  system.material.uniforms.uApplyXAxis.value = rollingConfig.applyXAxis ? 1 : 0;
}

const VERTEX_SHADER = `
attribute vec2 aWashUv;

uniform float uOriginX;
uniform float uOriginZ;
uniform float uCurvature;
uniform float uApplyXAxis;
uniform float uTime;

varying vec2 vWashUv;
varying vec2 vWorldXZ;
varying float vFrontDistance;
varying float vRunup;
varying float vSurfaceLift;
varying float vRidge;

float vHash(float n) {
  return fract(sin(n * 127.1) * 43758.5453);
}

float vNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = vHash(i.x + i.y * 57.0);
  float b = vHash(i.x + 1.0 + i.y * 57.0);
  float c = vHash(i.x + (i.y + 1.0) * 57.0);
  float d = vHash(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float vWaveCycle(float phase) {
  float p = fract(phase);
  float push = smoothstep(0.04, 0.30, p);
  float release = 1.0 - smoothstep(0.50, 1.0, p);
  return pow(clamp(push * release, 0.0, 1.0), 0.82);
}

float vLocalPulse(float u, float t, float cells, float speed, float phase, float width) {
  float p = fract(u * cells + t * speed + phase);
  float d = min(p, 1.0 - p);
  float pulse = exp(-pow(d / width, 2.0));
  float envelope = 0.72 + 0.28 * sin((u * 6.0 + phase) * 6.28318530718 + t * 0.21);
  return pulse * envelope;
}

float vLocalRunup(float u, float t) {
  float a = vLocalPulse(u, t, 5.0, 0.034, 0.13, 0.115);
  float b = vLocalPulse(u, t, 8.0, -0.026, 0.47, 0.090) * 0.66;
  float c = vLocalPulse(u, t, 13.0, 0.047, 0.71, 0.060) * 0.30;
  return clamp(max(max(a, b), c), 0.0, 1.0);
}

void main() {
  vWashUv = aWashUv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldXZ = worldPos.xz;
  float u = aWashUv.x;
  float v = aWashUv.y;
  float shoreV = ${SHORELINE_V.toFixed(4)};
  float runup = vLocalRunup(u, uTime);
  float frontNoise =
    (vNoise(vWorldXZ * 0.42 + vec2(uTime * 0.035, -uTime * 0.030)) - 0.5) * 0.060
    + sin(u * 150.796447372 + uTime * 0.70) * 0.018;
  float frontV = clamp(mix(shoreV + 0.26, shoreV - 0.20, runup) + frontNoise, 0.060, 0.84);
  float fromFront = v - frontV;
  float ridge = exp(-pow(fromFront / 0.085, 2.0)) * smoothstep(0.16, 0.78, runup);
  float chop = (vNoise(vWorldXZ * 2.2 + vec2(uTime * 0.16, -uTime * 0.12)) - 0.5)
    * smoothstep(-0.08, 0.35, fromFront)
    * (1.0 - smoothstep(0.45, 0.90, v));
  float surfaceLift = ridge * 0.105 + chop * 0.032;
  worldPos.y += surfaceLift;
  vFrontDistance = fromFront;
  vRunup = runup;
  vSurfaceLift = surfaceLift;
  vRidge = ridge;

  float deltaZ = worldPos.z - uOriginZ;
  worldPos.y -= deltaZ * deltaZ * uCurvature;
  if (uApplyXAxis > 0.5) {
    float deltaX = worldPos.x - uOriginX;
    worldPos.y -= deltaX * deltaX * uCurvature;
  }

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = `
precision highp float;

varying vec2 vWashUv;
varying vec2 vWorldXZ;
varying float vFrontDistance;
varying float vRunup;
varying float vSurfaceLift;
varying float vRidge;

uniform float uTime;

float washHash(vec2 p) {
  return fract(sin(dot(p, vec2(41.7, 289.3))) * 23857.5453);
}

float washNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  float a = washHash(i);
  float b = washHash(i + vec2(1.0, 0.0));
  float c = washHash(i + vec2(0.0, 1.0));
  float d = washHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

float washNoise2(vec2 p) {
  return washNoise(p) * 0.62 + washNoise(p * 2.31 + vec2(7.1, 3.7)) * 0.38;
}

// Voronoi distance — nearest cell-point distance from p, scanning a 3x3 window.
// Returns a value in [0, ~1.4]. Used for the dappled-cell caustic pattern that
// reads as bright sand patches catching sun light through ripples (more ACNH-feel
// than smooth value-noise blobs because the cell boundaries are crisp).
float washVoronoi(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float minDist = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 off = vec2(float(x), float(y));
      vec2 cellPt = off + vec2(washHash(ip + off), washHash(ip + off + vec2(1.7, 5.3)));
      float d = length(cellPt - fp);
      minDist = min(minDist, d);
    }
  }
  return minDist;
}

// One advancing/receding wave: returns a packed vec3 (crest, body, spray) where:
//   - crest: thin foam line right at the wave's leading edge
//   - body : translucent water mass trailing offshore from the front (the actual
//            water that the wave is bringing onto the sand)
//   - spray: small foam splatter just inland of the front
// frontPos is in v-space (0=inland edge, 1=offshore edge). The wave advances inland
// (low v) and recedes offshore (high v) cyclically. Body is on the OFFSHORE side of
// the front because that's where the wave came from — the water is being pushed
// inland and extends back out to where it originated.
vec3 oneWave(float v, float frontPos, float bodyDepth, float crestWidth) {
  float dToFront = v - frontPos;  // <0 inland of front, >0 offshore of front

  // Crest: gaussian-ish thin band right at the front
  float crestBand = exp(-pow(dToFront / crestWidth, 2.0));

  // Body: ramps in just offshore of the crest, peaks ~30% in, tapers out at bodyDepth.
  // This is the translucent water mass following the wave inland.
  float bodyRamp = smoothstep(0.000, 0.025, dToFront);
  float bodyTaper = 1.0 - smoothstep(bodyDepth * 0.45, bodyDepth, dToFront);
  float body = bodyRamp * bodyTaper;
  // Body fades as it reaches further offshore so far-edge sees ~0 contribution
  body *= mix(1.0, 0.45, smoothstep(0.0, bodyDepth, dToFront));

  // Spray: a small foam blob just ahead of the crest (inland-side splash)
  float sprayBand = smoothstep(-0.04, -0.012, dToFront)
    * (1.0 - smoothstep(-0.012, 0.004, dToFront));

  return vec3(crestBand, body, sprayBand);
}

float waveCycle(float phase) {
  float p = fract(phase);
  float push = smoothstep(0.05, 0.32, p);
  float release = 1.0 - smoothstep(0.52, 1.0, p);
  return pow(clamp(push * release, 0.0, 1.0), 0.78);
}

void main() {
  float u = vWashUv.x;
  float v = vWashUv.y; // 0 = inland edge, 1 = offshore edge
  float t = uTime;
  float TWO_PI = 6.28318530718;
  float shoreV = ${SHORELINE_V.toFixed(4)};
  float runup = vRunup;
  float fromFront = vFrontDistance;
  // Lower localActive threshold so the blue tint shows even at modest runup
  // (was 0.22-0.76 → now 0.10-0.55), making the wandering blobs constantly
  // visible instead of just flashing briefly at peak.
  float localActive = smoothstep(0.10, 0.55, runup);

  float edgeAa = max(fwidth(v) * 2.4, 0.010);
  float waterSheet = smoothstep(-0.18 - edgeAa, 0.24 + edgeAa, fromFront);
  float outerFade = 1.0 - smoothstep(0.86, 1.0, v);
  float innerFade = smoothstep(0.00, 0.070, v);
  float crossFade = outerFade * innerFade;
  // Higher base alpha (0.20 + 0.80 instead of 0.05 + 0.95) so blue is visible
  // even where runup is mid-range, not only at peaks.
  float activeSheet = waterSheet * crossFade * (0.20 + 0.80 * localActive);

  float sheetDepth = smoothstep(0.00, 0.64, max(fromFront, 0.0));
  float joinDistance = abs(v - shoreV);
  float seamFilm = (1.0 - smoothstep(0.00, 0.68, joinDistance))
    * (0.080 + 0.110 * localActive)
    * (0.74 + 0.26 * (sin(u * TWO_PI * 28.0 + t * 0.69) * 0.5 + 0.5));
  // Boosted tintAlpha cap (0.54 → 0.78) and stronger ramp so the blue ribbon
  // reads as clearly tinted water, not as a barely-visible film.
  float tintAlpha = clamp(activeSheet * mix(0.18, 0.62, sheetDepth) + seamFilm, 0.0, 0.78);

  float crestWidth = 0.040 + 0.035 * washNoise2(vWorldXZ * 0.95 + vec2(2.0, 7.0));
  float crest = 1.0 - smoothstep(crestWidth, crestWidth + 0.120, abs(fromFront));
  float foamBreakup = washNoise2(vWorldXZ * 1.45 + vec2(t * 0.10, -t * 0.08))
    + (sin(u * TWO_PI * 45.0 + t * 1.13) * 0.5 + 0.5) * 0.42
    + sin(u * TWO_PI * 7.0 + t * 0.75) * 0.08;
  crest *= localActive;
  crest *= smoothstep(0.70, 1.08, foamBreakup);
  crest *= innerFade * (1.0 - smoothstep(0.82, 0.98, v));

  float lace = smoothstep(0.030, 0.120, fromFront)
    * (1.0 - smoothstep(0.18, 0.42, fromFront))
    * smoothstep(0.69, 0.95, washNoise2(vWorldXZ * 2.40 + vec2(-t * 0.20, t * 0.14)));
  lace *= localActive * crossFade;

  float rippleLines =
    sin((vWorldXZ.x * 2.0 + vWorldXZ.y * 0.7) + t * 2.0)
    * sin((vWorldXZ.x * -0.6 + vWorldXZ.y * 2.3) - t * 1.4);
  float ripple = smoothstep(0.52, 0.92, rippleLines * 0.35 + washNoise2(vWorldXZ * 2.8 + vec2(t * 0.08, -t * 0.06)));
  ripple *= activeSheet * (0.35 + 0.65 * localActive);

  vec3 wetSand = vec3(0.74, 0.63, 0.48);
  // More saturated turquoise tints so the wandering blue ribbons read as
  // visibly blue, not as washed-out cyan.
  vec3 clearThinWater = vec3(0.40, 0.88, 0.96);
  vec3 shallowWater = vec3(0.20, 0.72, 0.96);
  vec3 tint = mix(wetSand, clearThinWater, smoothstep(shoreV + 0.04, shoreV + 0.34, v));
  tint = mix(tint, shallowWater, smoothstep(shoreV + 0.30, 0.94, v) * 0.80);
  tint += vec3(0.06, 0.11, 0.12) * ripple;
  tint = mix(tint, tint * 1.13, clamp(vSurfaceLift * 5.0 + vRidge * 0.35, 0.0, 1.0));

  vec3 foamColor = vec3(1.0, 1.0, 0.97);
  // Reduced foamAlpha cap (0.58 → 0.36) and reduced contributions so the foam
  // white doesn't dominate over the blue tint. The tint ribbon is the magic;
  // foam is a sparse accent on top of it, not a covering layer.
  float foamAlpha = clamp(crest * 0.32 + lace * 0.10 + vRidge * localActive * 0.07, 0.0, 0.36);

  // Higher final alpha cap (0.68 → 0.88) so the blue tint can render solidly,
  // not as a faint film.
  float finalAlpha = clamp(foamAlpha + tintAlpha * (1.0 - foamAlpha), 0.0, 0.88);
  vec3 finalColor = mix(tint, foamColor, foamAlpha / max(finalAlpha, 0.001));

  if (finalAlpha < 0.005) discard;
  gl_FragColor = vec4(finalColor, finalAlpha);
}
`;
