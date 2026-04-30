import * as THREE from 'three';

/**
 * Sky dome with a procedural gradient + sun disc + sunset glow.
 *
 * A large inverted sphere rendered with `BackSide` and `depthWrite=false` at a very
 * low `renderOrder` so it draws as the scene background — replacing the previous
 * flat `scene.background = vec3(plat)` color. The shader takes a sun direction
 * (set externally each frame from the day/night cycle) and three palette uniforms
 * (zenith, horizon, sunset) that are also driven by the cycle. The horizon glow
 * peaks toward the sun, so dawn/dusk show a directional warm bleed where the sun
 * actually is rather than a uniform horizon color.
 *
 * Why a sphere shader and not `THREE.Sky` (Preetham scattering): Bellbound's
 * stylized cozy direction calls for hand-tuned color keyframes, not physically
 * accurate Rayleigh/Mie scattering. A 4-uniform shader is simpler, cheaper, and
 * matches the direction in `STYLE_GUIDE.md`.
 */

export interface SkySystem {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

export function createSkySystem(): SkySystem {
  // Radius 100 m — INSIDE the camera's 130 m far plane (see main.ts). The dome
  // is also re-positioned on the camera every frame in `tickIslandScene` so the
  // sphere surface stays a constant radius from the viewer regardless of where
  // the player walks. A previous version used radius 180 (bigger than far
  // plane) which clipped the entire dome and exposed `scene.background` — so
  // the cloud shader simply never rendered, and the user saw only the bg color.
  const geometry = new THREE.SphereGeometry(100, 32, 16);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xfff0cf) },
      uZenithColor: { value: new THREE.Color(0x7ab8e8) },
      uHorizonColor: { value: new THREE.Color(0xb8e0f5) },
      uSunsetColor: { value: new THREE.Color(0xff9a72) },
      uSunsetMix: { value: 0.0 },
      uSunDiscIntensity: { value: 1.0 },
      uCloudColor: { value: new THREE.Color(0xf6f4ee) },
      uCloudOpacity: { value: 0.85 },
      uTime: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  material.name = 'sky-dome-material';
  material.customProgramCacheKey = () => 'sky-dome:v3';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky-dome';
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;

  return { mesh, material };
}

export function updateSkySystem(
  system: SkySystem,
  params: {
    sunDirection: THREE.Vector3;
    sunColor: THREE.Color;
    zenithColor: THREE.Color;
    horizonColor: THREE.Color;
    sunsetColor: THREE.Color;
    sunsetMix: number;
    sunDiscIntensity: number;
    cloudColor: THREE.Color;
    cloudOpacity: number;
    elapsed: number;
  },
): void {
  const u = system.material.uniforms;
  u.uSunDirection.value.copy(params.sunDirection);
  u.uSunColor.value.copy(params.sunColor);
  u.uZenithColor.value.copy(params.zenithColor);
  u.uHorizonColor.value.copy(params.horizonColor);
  u.uSunsetColor.value.copy(params.sunsetColor);
  u.uSunsetMix.value = params.sunsetMix;
  u.uSunDiscIntensity.value = params.sunDiscIntensity;
  u.uCloudColor.value.copy(params.cloudColor);
  u.uCloudOpacity.value = params.cloudOpacity;
  u.uTime.value = params.elapsed;
}

const VERTEX_SHADER = `
varying vec3 vWorldDir;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldDir = normalize(worldPos.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = `
varying vec3 vWorldDir;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunsetColor;
uniform float uSunsetMix;
uniform float uSunDiscIntensity;
uniform vec3 uCloudColor;
uniform float uCloudOpacity;
uniform float uTime;

float skyHash3(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float skyNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);

  float n000 = skyHash3(i + vec3(0.0, 0.0, 0.0));
  float n100 = skyHash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = skyHash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = skyHash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = skyHash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = skyHash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = skyHash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = skyHash3(i + vec3(1.0, 1.0, 1.0));

  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  float y0 = mix(x00, x10, u.y);
  float y1 = mix(x01, x11, u.y);
  return mix(y0, y1, u.z);
}

// 4-octave fbm normalized to roughly [0, 1]. More octaves than the previous
// 3-tap version so cloud silhouettes carry small wispy detail in addition to
// the broad shape — the "puff" reads as filaments, not as a single blob.
float skyFbm3(vec3 p) {
  float a = skyNoise3(p);
  float b = skyNoise3(p * 2.07 + vec3(7.1, 3.7, 5.3));
  float c = skyNoise3(p * 4.11 + vec3(13.2, 8.4, 2.1));
  float d = skyNoise3(p * 8.13 + vec3(21.5, 11.7, 6.4));
  return a * 0.50 + b * 0.27 + c * 0.15 + d * 0.08;
}

void main() {
  vec3 dir = normalize(vWorldDir);

  // Smooth gradient horizon → zenith. pow(0.55) biases toward horizon so the
  // band of bright sky just above the ground is wider than the deep zenith —
  // reads softer for a cozy game vs a hard linear ramp.
  float upness = clamp(dir.y, 0.0, 1.0);
  vec3 sky = mix(uHorizonColor, uZenithColor, pow(upness, 0.55));

  // Subtle haze band a few degrees above the horizon: brightens and slightly
  // desaturates the sky there, which reads as atmospheric thickness without
  // requiring a separate scattering pass. Peaks around dir.y ≈ 0.10.
  float hazeBand = smoothstep(0.0, 0.10, dir.y) * (1.0 - smoothstep(0.10, 0.55, dir.y));
  vec3 hazeTint = mix(uHorizonColor, vec3(0.96, 0.96, 0.97), 0.35);
  sky = mix(sky, hazeTint, hazeBand * 0.14);

  // Sunset bleed: warm the sky color toward the sun, then paint clouds on top
  // so the puffs stay readable instead of being recolored into the same hue as
  // the sky.
  float sunDot = dot(dir, normalize(uSunDirection));
  float sunsetGlow = pow(max(sunDot, 0.0), 2.4);
  sky = mix(sky, uSunsetColor, sunsetGlow * uSunsetMix * 0.30);

  // Clouds: domain-warped 4-octave fbm + sun-direction self-shadow sample.
  // Domain warp = perturb the sample position by a low-frequency noise → twists
  // the otherwise-roundish fbm blobs into wispy, organic cloud shapes. Self-
  // shadow = compare density at a point shifted toward the sun: if the cloud
  // is denser there, the current point is occluded → render it darker. This
  // gives clouds visible volume (lit top, shadowed underside) instead of the
  // previous flat white silhouettes.
  if (dir.y > -0.18) {
    vec3 worldOffset = vec3(cameraPosition.x * 0.010, 0.0, cameraPosition.z * 0.010);
    vec3 windA = vec3(uTime * 0.010, uTime * 0.002, -uTime * 0.006);
    vec3 cloudP = dir * 3.0 + worldOffset;

    // Cheap 2-axis domain warp — single noise eval per axis is enough at this
    // amplitude; xz only because warping y on a sphere reads as visual jitter.
    float wx = skyNoise3(cloudP * 0.55 + windA);
    float wz = skyNoise3(cloudP * 0.55 + vec3(13.2, 5.1, 7.7));
    vec3 warpedP = cloudP + vec3(wx - 0.5, 0.0, wz - 0.5) * 1.7;

    float density = skyFbm3(warpedP + windA);

    // Self-shadow: density toward the sun. clamp to [0.55, 1.15] so even fully
    // shadowed clouds keep enough luminance to read against the sky, and so
    // edges nearest the sun pop with a slight overbright (silver lining).
    vec3 sunOffset = normalize(uSunDirection) * 0.42;
    float sunDensity = skyFbm3(warpedP + sunOffset + windA);
    float lit = clamp(1.0 - (sunDensity - density) * 2.4, 0.55, 1.15);

    // Mask: smoothstep edges; core = deeper interior (subtly darker for volume).
    float cloudMask = smoothstep(0.46, 0.62, density);
    float core = smoothstep(0.56, 0.78, density);

    float horizonFade = smoothstep(-0.16, -0.03, dir.y);
    float zenithFade = 1.0 - smoothstep(0.82, 1.0, dir.y);
    cloudMask *= horizonFade * zenithFade;

    vec3 cloudShade = uCloudColor * lit;
    cloudShade = mix(cloudShade, cloudShade * 0.78, core * 0.55);

    // Warm rim toward the sun at sunrise/sunset — paints the sun-facing side
    // of clouds with the sunset tint so dawn/dusk reads as golden-edged.
    cloudShade = mix(cloudShade, uSunsetColor, sunsetGlow * uSunsetMix * 0.40);

    sky = mix(sky, cloudShade, cloudMask * uCloudOpacity);
  }

  // Sun disc: a tiny bright spot when looking AT the sun.
  float sunDisc = smoothstep(0.9985, 0.9995, sunDot);
  sky = mix(sky, uSunColor * 1.45, sunDisc * uSunDiscIntensity);

  // Anti-banding dither — without it, smooth gradients band visibly on 8-bit
  // displays and the sky reads as flat, posterized stripes. Sub-LSB amplitude
  // so it's invisible as noise but breaks the contour banding.
  float dither = (skyHash3(vec3(gl_FragCoord.xy, uTime * 0.5)) - 0.5) * 0.006;
  sky += dither;

  gl_FragColor = vec4(sky, 1.0);
}
`;
