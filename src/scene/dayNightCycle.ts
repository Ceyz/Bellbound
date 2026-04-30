import * as THREE from 'three';

/**
 * Day/night lighting cycle for Bellbound.
 *
 * `timeOfDay` is a single normalized scalar in [0, 1):
 *   0.00 = midnight     (deep navy sky, near-zero sun, blue moonlight ambient)
 *   0.22 = pre-dawn     (low warm horizon, sun about to rise)
 *   0.30 = sunrise      (peak orange glow, sun ramping up)
 *   0.50 = noon         (cyan sky, full warm-white sun)
 *   0.70 = late-day     (sun sloping toward horizon)
 *   0.78 = sunset       (peak orange/pink glow, sun about to set)
 *   1.00 = midnight     (wraps to 0)
 *
 * `computeTimeOfDay(t)` interpolates between hand-tuned phase keyframes and
 * returns every parameter the scene needs: sun direction, sun color/intensity,
 * sky gradient stops, sunset bleed mix, sun disc visibility, fog color, and
 * hemisphere ambient settings. The caller (createIslandScene tick loop) feeds
 * each value into the relevant Three.js objects every frame.
 *
 * Sun direction is computed analytically from t — the sun arcs east → overhead
 * → west on a great circle slightly tilted to the north so the noon shadow
 * still has a perceptible direction.
 */

interface PhaseKey {
  t: number;
  sunIntensity: number;
  sunDiscIntensity: number;
  sunColor: number;
  skyZenith: number;
  skyHorizon: number;
  sunsetColor: number;
  sunsetMix: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  cloudColor: number;
  cloudOpacity: number;
}

// Cloud color stays white-cream at all phases on purpose: keeping it neutral
// guarantees visible contrast against the sky gradient (whose horizon color
// shifts to match the time of day). The sky shader tints it warm via sunsetMix
// at dawn/dusk and dims it via sunDiscIntensity at night, so the visual cycle
// still reads correctly without manually matching cloud hue to sky hue (which
// caused them to disappear at sunset by blending into the orange horizon).
const CLOUD_DAY = 0xfaf8f0;

const PHASES: PhaseKey[] = [
  // Midnight — deep navy, dim moonlight ambient
  {
    t: 0.00, sunIntensity: 0.0, sunDiscIntensity: 0.0, sunColor: 0x4a5878,
    skyZenith: 0x0a0e1c, skyHorizon: 0x1a1830,
    sunsetColor: 0x000000, sunsetMix: 0.0,
    fog: 0x1a2030, fogNear: 38, fogFar: 78,
    ambientSky: 0x4856a0, ambientGround: 0x2a2848, ambientIntensity: 0.55,
    cloudColor: CLOUD_DAY, cloudOpacity: 0.65,
  },
  // Pre-dawn — first warm hint at horizon, sky still purplish
  {
    t: 0.20, sunIntensity: 0.15, sunDiscIntensity: 0.4, sunColor: 0xff8055,
    skyZenith: 0x647aa6, skyHorizon: 0xe4b5a0,
    sunsetColor: 0xffb08a, sunsetMix: 0.32,
    fog: 0xa08070, fogNear: 40, fogFar: 80,
    ambientSky: 0x8a90b8, ambientGround: 0x90786a, ambientIntensity: 0.95,
    cloudColor: CLOUD_DAY, cloudOpacity: 0.85,
  },
  // Sunrise — peak orange glow, sun visible on horizon
  {
    t: 0.30, sunIntensity: 1.40, sunDiscIntensity: 1.0, sunColor: 0xffd098,
    skyZenith: 0x82acd8, skyHorizon: 0xffd6b6,
    sunsetColor: 0xffb586, sunsetMix: 0.24,
    fog: 0xc8c0c8, fogNear: 42, fogFar: 82,
    ambientSky: 0xb0c0e0, ambientGround: 0x9ad08a, ambientIntensity: 1.40,
    cloudColor: CLOUD_DAY, cloudOpacity: 0.92,
  },
  // Noon — bright cyan sky, full white-warm sun, fluffy white clouds
  {
    t: 0.50, sunIntensity: 1.95, sunDiscIntensity: 0.85, sunColor: 0xfff0cf,
    skyZenith: 0x7ab8e8, skyHorizon: 0xb8e0f5,
    sunsetColor: 0xff7a3a, sunsetMix: 0.0,
    fog: 0xb0d8f0, fogNear: 42, fogFar: 82,
    ambientSky: 0xb8c8f5, ambientGround: 0x9ad08a, ambientIntensity: 1.65,
    cloudColor: CLOUD_DAY, cloudOpacity: 0.95,
  },
  // Late-day — sun sloping, sky still cyan
  {
    t: 0.70, sunIntensity: 1.40, sunDiscIntensity: 1.0, sunColor: 0xffb878,
    skyZenith: 0x82afd8, skyHorizon: 0xeec8aa,
    sunsetColor: 0xffb58c, sunsetMix: 0.12,
    fog: 0xbfb6b2, fogNear: 42, fogFar: 82,
    ambientSky: 0xa8a8d8, ambientGround: 0x90c08a, ambientIntensity: 1.35,
    cloudColor: CLOUD_DAY, cloudOpacity: 0.92,
  },
  // Sunset — peak warm glow, sun about to disappear
  {
    t: 0.78, sunIntensity: 0.20, sunDiscIntensity: 1.0, sunColor: 0xff5a30,
    skyZenith: 0x7690c0, skyHorizon: 0xf0c4a6,
    sunsetColor: 0xffb08a, sunsetMix: 0.32,
    fog: 0xa994a6, fogNear: 40, fogFar: 80,
    ambientSky: 0x9a78a0, ambientGround: 0x705078, ambientIntensity: 0.90,
    cloudColor: CLOUD_DAY, cloudOpacity: 0.92,
  },
  // Late dusk — sky going purple-navy
  {
    t: 0.85, sunIntensity: 0.05, sunDiscIntensity: 0.35, sunColor: 0x705890,
    skyZenith: 0x1a1a48, skyHorizon: 0x4a3870,
    sunsetColor: 0x602848, sunsetMix: 0.45,
    fog: 0x40345a, fogNear: 38, fogFar: 78,
    ambientSky: 0x5a4a80, ambientGround: 0x402c50, ambientIntensity: 0.65,
    cloudColor: CLOUD_DAY, cloudOpacity: 0.78,
  },
  // Wrap to midnight (same values as t=0.00)
  {
    t: 1.00, sunIntensity: 0.0, sunDiscIntensity: 0.0, sunColor: 0x4a5878,
    skyZenith: 0x0a0e1c, skyHorizon: 0x1a1830,
    sunsetColor: 0x000000, sunsetMix: 0.0,
    fog: 0x1a2030, fogNear: 38, fogFar: 78,
    ambientSky: 0x4856a0, ambientGround: 0x2a2848, ambientIntensity: 0.55,
    cloudColor: CLOUD_DAY, cloudOpacity: 0.65,
  },
];

export interface TimeOfDayLighting {
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  sunDiscIntensity: number;
  skyZenithColor: THREE.Color;
  skyHorizonColor: THREE.Color;
  sunsetColor: THREE.Color;
  sunsetMix: number;
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
  ambientSkyColor: THREE.Color;
  ambientGroundColor: THREE.Color;
  ambientIntensity: number;
  cloudColor: THREE.Color;
  cloudOpacity: number;
}

const _tmpA = new THREE.Color();
const _tmpB = new THREE.Color();

/**
 * Interpolates between hand-tuned phase keyframes. `t` is wrapped to [0, 1) so
 * the cycle loops cleanly across the midnight boundary.
 */
export function computeTimeOfDay(t: number): TimeOfDayLighting {
  const wrapped = ((t % 1) + 1) % 1;

  let lo = PHASES[0];
  let hi = PHASES[PHASES.length - 1];
  for (let i = 0; i < PHASES.length - 1; i += 1) {
    if (wrapped >= PHASES[i].t && wrapped <= PHASES[i + 1].t) {
      lo = PHASES[i];
      hi = PHASES[i + 1];
      break;
    }
  }

  const span = Math.max(hi.t - lo.t, 1e-6);
  const local = (wrapped - lo.t) / span;

  return {
    sunDirection: computeSunDirection(wrapped),
    sunColor: lerpHex(lo.sunColor, hi.sunColor, local),
    sunIntensity: THREE.MathUtils.lerp(lo.sunIntensity, hi.sunIntensity, local),
    sunDiscIntensity: THREE.MathUtils.lerp(lo.sunDiscIntensity, hi.sunDiscIntensity, local),
    skyZenithColor: lerpHex(lo.skyZenith, hi.skyZenith, local),
    skyHorizonColor: lerpHex(lo.skyHorizon, hi.skyHorizon, local),
    sunsetColor: lerpHex(lo.sunsetColor, hi.sunsetColor, local),
    sunsetMix: THREE.MathUtils.lerp(lo.sunsetMix, hi.sunsetMix, local),
    fogColor: lerpHex(lo.fog, hi.fog, local),
    fogNear: THREE.MathUtils.lerp(lo.fogNear, hi.fogNear, local),
    fogFar: THREE.MathUtils.lerp(lo.fogFar, hi.fogFar, local),
    ambientSkyColor: lerpHex(lo.ambientSky, hi.ambientSky, local),
    ambientGroundColor: lerpHex(lo.ambientGround, hi.ambientGround, local),
    ambientIntensity: THREE.MathUtils.lerp(lo.ambientIntensity, hi.ambientIntensity, local),
    cloudColor: lerpHex(lo.cloudColor, hi.cloudColor, local),
    cloudOpacity: THREE.MathUtils.lerp(lo.cloudOpacity, hi.cloudOpacity, local),
  };
}

/**
 * Sun direction as a unit vector. Arcs from east horizon at sunrise (t=0.25)
 * → straight up at noon (t=0.50) → west horizon at sunset (t=0.75) → below
 * horizon at midnight. Slight constant Z bias so the noon shadow has a
 * direction (otherwise straight-down sun gives no shadow projection).
 */
function computeSunDirection(t: number): THREE.Vector3 {
  const angle = (t - 0.25) * Math.PI * 2;
  const dir = new THREE.Vector3(
    Math.cos(angle) * 0.85,
    Math.sin(angle),
    -0.30,
  );
  return dir.normalize();
}

function lerpHex(a: number, b: number, t: number): THREE.Color {
  _tmpA.setHex(a);
  _tmpB.setHex(b);
  return new THREE.Color().lerpColors(_tmpA, _tmpB, t);
}
