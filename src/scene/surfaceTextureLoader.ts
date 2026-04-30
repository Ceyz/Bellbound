import * as THREE from 'three';
import type { SurfaceTextureSet } from './proceduralTextures';

/**
 * Loads the painted surface texture set from `/public/textures/surface/*.png`.
 *
 * Returned `THREE.Texture` objects are usable immediately — Three.js samples a
 * placeholder until each PNG decodes, then refreshes seamlessly. There is no
 * boot blocking and no async waterfall to manage. If a file is missing, the
 * loader logs a console error but the rest of the set still works.
 *
 * The shape (`SurfaceTextureSet`) and per-texture configuration mirror
 * `createSurfaceTextureSet` from `proceduralTextures.ts` so the splat material
 * accepts either source interchangeably.
 */

const PUBLIC_PATH = '/textures/surface';

const FILE_NAMES: Record<keyof SurfaceTextureSet, string> = {
  cliffSide: 'cliff_side.png',
  cliffTop: 'cliff_top.png',
  dirtPath: 'dirt_path.png',
  grass: 'grass.png',
  riverbed: 'riverbed.png',
  sand: 'sand.png',
};

export function loadSurfaceTextures(): SurfaceTextureSet {
  // `THREE.TextureLoader` instantiates an HTMLImageElement under the hood, which fails
  // in Node-only environments (vitest). Fall back to bare empty `Texture` objects there
  // — the tests inspect settings, not pixel data, so this keeps unit tests green while
  // still loading the painted PNGs in the browser.
  const loader = typeof document !== 'undefined' ? new THREE.TextureLoader() : null;
  const set = {} as SurfaceTextureSet;

  for (const key of Object.keys(FILE_NAMES) as (keyof SurfaceTextureSet)[]) {
    set[key] = createTexture(loader, key, FILE_NAMES[key]);
  }

  return set;
}

function createTexture(
  loader: THREE.TextureLoader | null,
  key: keyof SurfaceTextureSet,
  fileName: string,
): THREE.Texture {
  const url = `${PUBLIC_PATH}/${fileName}`;
  const texture = loader
    ? loader.load(
        url,
        undefined,
        undefined,
        (error) => console.error(`[surfaceTextureLoader] failed to load ${url}`, error),
      )
    : new THREE.Texture();

  texture.name = `surface-${key}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;

  return texture;
}
