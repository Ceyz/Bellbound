import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

export type AnimationName =
  | 'breathing_idle'
  | 'walking'
  | 'running'
  | 'fishing_cast'
  | 'fishing_idle'
  | 'digging'
  | 'picking_up'
  | 'talking'
  | 'waving';

export const ALL_ANIMATIONS: AnimationName[] = [
  'breathing_idle',
  'walking',
  'running',
  'fishing_cast',
  'fishing_idle',
  'digging',
  'picking_up',
  'talking',
  'waving',
];

export interface PlayerCharacter {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  setAnimation(name: AnimationName, fadeMs?: number, timeScale?: number): void;
  getCurrentAnimation(): AnimationName | null;
  update(delta: number): void;
}

const CHARACTER_URL = '/glb/characters/chibi_v4_base.glb';
const ANIM_BASE_URL = '/anims';

/**
 * Loads the player character mesh + skeleton, plus all gameplay animation clips.
 * Animations were exported by the Blender Mixamo pipeline (see `assets/anims/`); the
 * GLB clips contain only the bone keyframes, not the mesh, so they're tiny (~30–120 KB).
 *
 * The Mixamo skeleton bone names (`mixamorig:*`) match between the character and the
 * clips, so `AnimationMixer` can apply any clip onto the character without retarget.
 *
 * `VRMLoaderPlugin` is registered for the GLTFLoader: if the asset is a real VRM file
 * the plugin activates VRM features (spring bones, look-at). For our current `.glb`
 * export it falls back to a plain GLTF skinned mesh — animations still work either way.
 */
export async function loadPlayerCharacter(): Promise<PlayerCharacter> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(CHARACTER_URL);
  const root = gltf.scene;
  root.name = 'chibi-player-character';

  // Shadows on every skinned mesh; disable frustum culling because the bounding box
  // computed at rest pose is wrong once the skeleton starts moving.
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.frustumCulled = false;
    }
  });

  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<AnimationName, THREE.AnimationAction>();

  await Promise.all(
    ALL_ANIMATIONS.map(async (name) => {
      try {
        const animGltf = await loader.loadAsync(`${ANIM_BASE_URL}/${name}.glb`);
        const clip = animGltf.animations[0];
        if (!clip) {
          console.warn(`[playerCharacter] no animation in ${name}.glb`);
          return;
        }
        const action = mixer.clipAction(clip);
        actions.set(name, action);
      } catch (e) {
        console.warn(`[playerCharacter] failed to load ${name}.glb:`, e);
      }
    }),
  );

  let currentAction: THREE.AnimationAction | null = null;
  let currentName: AnimationName | null = null;

  function setAnimation(name: AnimationName, fadeMs: number = 200, timeScale: number = 1) {
    if (currentName === name) {
      // Same clip, but allow live tweaking of playback speed (e.g. faster picking_up).
      const action = actions.get(name);
      if (action) action.setEffectiveTimeScale(timeScale);
      return;
    }
    const newAction = actions.get(name);
    if (!newAction) return;

    const fadeS = fadeMs / 1000;
    if (currentAction) {
      currentAction.fadeOut(fadeS);
    }
    newAction.reset().setEffectiveTimeScale(timeScale).fadeIn(fadeS).play();
    currentAction = newAction;
    currentName = name;
  }

  // Initial pose: breathing idle (loop). Falls back to first available if missing.
  if (actions.has('breathing_idle')) {
    setAnimation('breathing_idle', 0);
  } else {
    const first = actions.keys().next().value;
    if (first) setAnimation(first as AnimationName, 0);
  }

  return {
    root,
    mixer,
    setAnimation,
    getCurrentAnimation: () => currentName,
    update: (delta) => mixer.update(delta),
  };
}
