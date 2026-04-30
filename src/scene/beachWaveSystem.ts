import * as THREE from 'three';
import { getIslandHeight } from './heightmap';
import { sampleShoreAnchors, type ShoreAnchor } from './islandShape';
import { rollingConfig, sharedRollingUniforms } from './rollingWorld';

/**
 * Moving shoreline wave events. Each instance is a small analytical crescent that
 * respawns at a new SDF shore anchor after fading out, so the coast reads as living
 * surf instead of fixed transparent decals.
 */

const ACTIVE_WAVE_COUNT = 24;
const SHORE_ANCHOR_COUNT = 720;
const MIN_DURATION_SECONDS = 3.4;
const MAX_DURATION_SECONDS = 7.2;
const OFFSHORE_START_METERS = 0.95;
const INLAND_END_METERS = -0.42;
const WAVE_Y_OFFSET = 0.135;

interface WaveEvent {
  anchorIndex: number;
  curve: number;
  depth: number;
  duration: number;
  opacity: number;
  seed: number;
  spawnTime: number;
  width: number;
}

export interface BeachWaveSystem {
  anchors: ShoreAnchor[];
  curveAttribute: THREE.InstancedBufferAttribute;
  lifeAttribute: THREE.InstancedBufferAttribute;
  material: THREE.ShaderMaterial;
  matrix: THREE.Matrix4;
  mesh: THREE.InstancedMesh;
  opacityAttribute: THREE.InstancedBufferAttribute;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  random: () => number;
  scale: THREE.Vector3;
  seedAttribute: THREE.InstancedBufferAttribute;
  waves: WaveEvent[];
}

export function createBeachWaveSystem(): BeachWaveSystem {
  const random = mulberry32(0xb5acaff);
  const anchors = sampleShoreAnchors(SHORE_ANCHOR_COUNT);

  const geometry = new THREE.PlaneGeometry(1, 1, 12, 6);
  geometry.rotateX(-Math.PI / 2);

  const lifeData = new Float32Array(ACTIVE_WAVE_COUNT);
  const seedData = new Float32Array(ACTIVE_WAVE_COUNT);
  const curveData = new Float32Array(ACTIVE_WAVE_COUNT);
  const opacityData = new Float32Array(ACTIVE_WAVE_COUNT);

  const lifeAttribute = new THREE.InstancedBufferAttribute(lifeData, 1);
  const seedAttribute = new THREE.InstancedBufferAttribute(seedData, 1);
  const curveAttribute = new THREE.InstancedBufferAttribute(curveData, 1);
  const opacityAttribute = new THREE.InstancedBufferAttribute(opacityData, 1);
  lifeAttribute.setUsage(THREE.DynamicDrawUsage);
  seedAttribute.setUsage(THREE.DynamicDrawUsage);
  curveAttribute.setUsage(THREE.DynamicDrawUsage);
  opacityAttribute.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute('iLife', lifeAttribute);
  geometry.setAttribute('iSeed', seedAttribute);
  geometry.setAttribute('iCurve', curveAttribute);
  geometry.setAttribute('iOpacity', opacityAttribute);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uOriginX: sharedRollingUniforms.uOriginX,
      uOriginZ: sharedRollingUniforms.uOriginZ,
      uCurvature: sharedRollingUniforms.uCurvature,
      uApplyXAxis: sharedRollingUniforms.uApplyXAxis,
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  material.name = 'beach-wave-material';
  material.customProgramCacheKey = () => 'beach-wave:v6';

  const mesh = new THREE.InstancedMesh(geometry, material, ACTIVE_WAVE_COUNT);
  mesh.name = 'beach-waves';
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.renderOrder = 4;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const system: BeachWaveSystem = {
    anchors,
    curveAttribute,
    lifeAttribute,
    material,
    matrix: new THREE.Matrix4(),
    mesh,
    opacityAttribute,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    random,
    scale: new THREE.Vector3(),
    seedAttribute,
    waves: [],
  };

  for (let i = 0; i < ACTIVE_WAVE_COUNT; i += 1) {
    const wave = createWaveEvent(random, anchors.length, 0);
    wave.spawnTime = -random() * wave.duration;
    system.waves.push(wave);
    writeStaticAttributes(system, i, wave);
  }

  updateBeachWaveSystem(system, 0);
  return system;
}

export function updateBeachWaveSystem(system: BeachWaveSystem, elapsed: number): void {
  system.material.uniforms.uCurvature.value = rollingConfig.curvature;
  system.material.uniforms.uApplyXAxis.value = rollingConfig.applyXAxis ? 1 : 0;

  for (let i = 0; i < system.waves.length; i += 1) {
    let wave = system.waves[i];
    let age = elapsed - wave.spawnTime;

    if (age >= wave.duration) {
      wave = createWaveEvent(system.random, system.anchors.length, elapsed);
      system.waves[i] = wave;
      writeStaticAttributes(system, i, wave);
      age = 0;
    }

    const t = THREE.MathUtils.clamp(age / wave.duration, 0, 1);
    system.lifeAttribute.setX(i, t);
    updateWaveMatrix(system, i, wave, t);
  }

  system.lifeAttribute.needsUpdate = true;
  system.seedAttribute.needsUpdate = true;
  system.curveAttribute.needsUpdate = true;
  system.opacityAttribute.needsUpdate = true;
  system.mesh.instanceMatrix.needsUpdate = true;
}

function createWaveEvent(
  random: () => number,
  anchorCount: number,
  spawnTime: number,
): WaveEvent {
  return {
    anchorIndex: Math.floor(random() * anchorCount),
    curve: 0.16 + random() * 0.36,
    depth: 0.65 + random() * 0.85,
    duration: MIN_DURATION_SECONDS + random() * (MAX_DURATION_SECONDS - MIN_DURATION_SECONDS),
    opacity: 0.26 + random() * 0.24,
    seed: random() * 1000,
    spawnTime,
    width: 0.95 + random() * 2.35,
  };
}

function writeStaticAttributes(system: BeachWaveSystem, index: number, wave: WaveEvent) {
  system.seedAttribute.setX(index, wave.seed);
  system.curveAttribute.setX(index, wave.curve);
  system.opacityAttribute.setX(index, wave.opacity);
}

function updateWaveMatrix(
  system: BeachWaveSystem,
  index: number,
  wave: WaveEvent,
  t: number,
) {
  const anchor = system.anchors[wave.anchorIndex];
  const travel = smootherstep(t);
  const normalOffset = THREE.MathUtils.lerp(OFFSHORE_START_METERS, INLAND_END_METERS, travel);
  const x = anchor.x + anchor.normalX * normalOffset;
  const z = anchor.z + anchor.normalZ * normalOffset;

  system.position.set(x, getIslandHeight(x, z) + WAVE_Y_OFFSET, z);
  system.quaternion.setFromAxisAngle(
    Y_AXIS,
    Math.atan2(anchor.normalX, anchor.normalZ),
  );

  const swell = 0.86 + Math.sin(Math.PI * t) * 0.18;
  system.scale.set(wave.width * swell, 1, wave.depth * (0.82 + travel * 0.28));
  system.matrix.compose(system.position, system.quaternion, system.scale);
  system.mesh.setMatrixAt(index, system.matrix);
}

function smootherstep(value: number) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

const VERTEX_SHADER = `
attribute float iLife;
attribute float iSeed;
attribute float iCurve;
attribute float iOpacity;

uniform float uOriginX;
uniform float uOriginZ;
uniform float uCurvature;
uniform float uApplyXAxis;

varying vec2 vUv;
varying float vLife;
varying float vSeed;
varying float vCurve;
varying float vOpacity;

void main() {
  vUv = uv;
  vLife = iLife;
  vSeed = iSeed;
  vCurve = iCurve;
  vOpacity = iOpacity;

  vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);

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

varying vec2 vUv;
varying float vLife;
varying float vSeed;
varying float vCurve;
varying float vOpacity;

float waveHash(vec2 p) {
  return fract(sin(dot(p, vec2(41.7, 289.3))) * 23857.5453);
}

float waveNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = waveHash(i);
  float b = waveHash(i + vec2(1.0, 0.0));
  float c = waveHash(i + vec2(0.0, 1.0));
  float d = waveHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  float u = vUv.x;
  float v = vUv.y;
  float x = u * 2.0 - 1.0;
  float y = v * 2.0 - 1.0;

  float frontJitter = (waveNoise(vec2(u * 7.0 + vSeed, v * 5.0 - vSeed)) - 0.5) * 0.055;
  float crestCenter = 0.05 - vCurve * x * x + frontJitter;
  float distanceToCrest = abs(y - crestCenter);
  float aa = max(1.6 * fwidth(distanceToCrest), 0.003);

  // These instances are only local broken foam accents. The continuous shoreWash
  // ribbon carries the actual water volume, so keep this subtle and fragmented.
  float crestWidth = 0.048 + waveHash(vec2(vSeed, 2.1)) * 0.024;
  float crest = 1.0 - smoothstep(crestWidth - aa, crestWidth + aa, distanceToCrest);

  float seaward = y - crestCenter;
  // Keep the per-instance mesh to foam/spray only. A blue body wash on these
  // rectangular carrier planes can reveal straight edges over the sand.
  float washBand = smoothstep(0.01, 0.10, seaward)
    * (1.0 - smoothstep(0.20, 0.92, seaward));
  float washNoise = waveNoise(vec2(u * 13.0 + vSeed * 0.3, v * 9.0 - vSeed));
  float wash = washBand * (0.010 + 0.035 * washNoise);

  // Anticipation blob ahead of the crest (negative seaward = inland side): a soft
  // foam-colored splash that fades just before the crest, making the wave look like
  // it's pushing forward rather than abruptly appearing.
  float anticipation = (1.0 - smoothstep(0.0, 0.10, abs(seaward + 0.02)))
    * smoothstep(0.0, 0.4, vLife) * (1.0 - smoothstep(0.6, 1.0, vLife));
  float spray = anticipation * (0.035 + 0.090 * waveNoise(vec2(u * 21.0, v * 17.0 + vSeed)));

  float endFade = 1.0 - smoothstep(0.42, 0.96, abs(x));
  float lobeFade = 1.0 - smoothstep(0.58, 0.98, length(vec2(x * 1.05, (y - crestCenter) * 1.75)));
  float life = smoothstep(0.00, 0.24, vLife) * (1.0 - smoothstep(0.58, 1.0, vLife));
  float breakup = smoothstep(0.44, 0.92, washNoise + waveNoise(vec2(u * 31.0 + vSeed, vLife * 4.0)) * 0.35);

  crest *= mix(0.18, 1.0, breakup);

  float alpha = (crest * 0.58 + wash * breakup + spray * 0.24) * endFade * lobeFade * life * vOpacity;
  if (alpha < 0.008) discard;
  alpha = clamp(alpha, 0.0, 1.0);

  vec3 foam = vec3(1.00, 1.00, 0.97);
  vec3 paleFoam = vec3(0.82, 0.98, 0.98);
  vec3 color = mix(paleFoam, foam, clamp(crest * 1.2 + spray * 0.6, 0.0, 1.0));

  gl_FragColor = vec4(color, alpha);
}
`;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
