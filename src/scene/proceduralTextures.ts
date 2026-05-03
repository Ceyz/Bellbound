import * as THREE from 'three';

/**
 * Procedural ACNH-style surface textures generated at boot. Each texture is a 512² square,
 * RGBA, fully tileable (RepeatWrapping). They are intentionally proxies — not final art —
 * meant to validate the splat shader pipeline before swapping in image-gen sources.
 *
 * Generation strategy: solid base color + N brush stamps (soft ellipses with smoothstep
 * falloff, applied with wrap-around so seams disappear) + low-amplitude grain. Stamp
 * positions come from a deterministic Mulberry32 PRNG so textures are reproducible.
 */

export interface SurfaceTextureSet {
  cliffSide: THREE.Texture;
  cliffTop: THREE.Texture;
  dirtPath: THREE.Texture;
  grass: THREE.Texture;
  riverbed: THREE.Texture;
  sand: THREE.Texture;
}

export type SurfaceTextureKey = keyof SurfaceTextureSet;

/**
 * Proxy textures only need to read well under tiled-sampling at typical camera distance.
 * 256² keeps boot time under ~50 ms total for the 6-texture set, which is critical to
 * keep the e2e movement test inside its 500 ms wait window. Final art coming from
 * imagegen will likely sit at 1024² or 2048².
 */
const TEXTURE_SIZE = 256;

interface BrushStamp {
  alpha: number;
  color: [number, number, number];
  count: number;
  radius: number;
  /** When < 1, flattens the stamp horizontally — useful for cliff strata. Default 1. */
  stretchY?: number;
}

interface TextureRecipe {
  base: [number, number, number];
  grainIntensity: number;
  grainTint: [number, number, number];
  seed: number;
  stamps: BrushStamp[];
}

const RECIPES: Record<SurfaceTextureKey, TextureRecipe> = {
  grass: {
    base: [168, 213, 162],
    grainIntensity: 0.06,
    grainTint: [110, 80, 60],
    seed: 1337,
    stamps: [
      { color: [200, 230, 176], alpha: 0.45, radius: 32, count: 18 },
      { color: [126, 200, 126], alpha: 0.55, radius: 28, count: 22 },
      { color: [148, 188, 148], alpha: 0.35, radius: 14, count: 60 },
      { color: [220, 240, 196], alpha: 0.25, radius: 6, count: 90 },
    ],
  },
  sand: {
    base: [245, 230, 200],
    grainIntensity: 0.05,
    grainTint: [180, 150, 100],
    seed: 4711,
    stamps: [
      { color: [232, 213, 168], alpha: 0.5, radius: 30, count: 18 },
      { color: [200, 180, 140], alpha: 0.3, radius: 18, count: 28 },
      { color: [196, 149, 106], alpha: 0.2, radius: 8, count: 40 },
      { color: [120, 84, 60], alpha: 0.35, radius: 3, count: 60 },
    ],
  },
  dirtPath: {
    base: [196, 149, 106],
    grainIntensity: 0.05,
    grainTint: [80, 50, 30],
    seed: 9173,
    stamps: [
      { color: [232, 213, 168], alpha: 0.35, radius: 22, count: 16 },
      { color: [148, 110, 78], alpha: 0.5, radius: 20, count: 14 },
      { color: [120, 84, 60], alpha: 0.35, radius: 8, count: 50 },
      { color: [86, 60, 42], alpha: 0.45, radius: 4, count: 70 },
    ],
  },
  riverbed: {
    base: [148, 130, 92],
    grainIntensity: 0.06,
    grainTint: [40, 30, 20],
    seed: 12289,
    stamps: [
      { color: [110, 142, 110], alpha: 0.35, radius: 20, count: 14 },
      { color: [104, 80, 56], alpha: 0.55, radius: 14, count: 28 },
      { color: [186, 174, 140], alpha: 0.2, radius: 10, count: 30 },
      { color: [76, 60, 40], alpha: 0.4, radius: 4, count: 50 },
    ],
  },
  cliffTop: {
    base: [126, 200, 126],
    grainIntensity: 0.07,
    grainTint: [70, 50, 30],
    seed: 16487,
    stamps: [
      { color: [148, 188, 148], alpha: 0.5, radius: 26, count: 20 },
      { color: [88, 156, 88], alpha: 0.5, radius: 22, count: 18 },
      { color: [180, 200, 140], alpha: 0.3, radius: 10, count: 60 },
      { color: [60, 110, 60], alpha: 0.35, radius: 4, count: 80 },
    ],
  },
  cliffSide: {
    base: [156, 122, 92],
    grainIntensity: 0.08,
    grainTint: [40, 30, 20],
    seed: 20479,
    stamps: [
      { color: [186, 154, 122], alpha: 0.45, radius: 64, count: 10, stretchY: 0.3 },
      { color: [108, 86, 64], alpha: 0.6, radius: 56, count: 12, stretchY: 0.3 },
      { color: [80, 60, 44], alpha: 0.45, radius: 36, count: 14, stretchY: 0.25 },
      { color: [60, 44, 32], alpha: 0.5, radius: 6, count: 60 },
    ],
  },
};

export function createSurfaceTextureSet(): SurfaceTextureSet {
  const set = {} as SurfaceTextureSet;
  for (const key of Object.keys(RECIPES) as SurfaceTextureKey[]) {
    set[key] = key === 'cliffSide'
      ? paintAcnhCliffSideTexture(key)
      : paintTextureFromRecipe(key, RECIPES[key]);
  }

  return set;
}

function paintAcnhCliffSideTexture(name: SurfaceTextureKey): THREE.DataTexture {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const random = mulberry32(RECIPES.cliffSide.seed);
  const twoPi = Math.PI * 2;

  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    const v = y / (TEXTURE_SIZE - 1);
    const bottomShadow = 1 - smoothstep(v, 0.02, 0.34);
    const topWarmth = 1 - smoothstep(v, 0.74, 1.0);

    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const idx = (y * TEXTURE_SIZE + x) * 4;
      const wobble =
        Math.sin(v * twoPi * 1.6 + Math.sin(u * twoPi * 3.0) * 0.35) * 0.045
        + Math.sin(v * twoPi * 4.3 + 1.2) * 0.018;
      const broadPanel = Math.sin((u * 5.0 + wobble) * twoPi) * 0.5 + 0.5;
      const panelShade = (broadPanel - 0.5) * 0.22;
      const verticalSeam = Math.pow(1 - Math.abs(broadPanel * 2 - 1), 6);
      const hairline = Math.pow(
        Math.max(0, Math.cos((u * 18.0 + wobble * 2.5) * twoPi)),
        18,
      );
      const grain = (random() - 0.5) * 0.055;
      const shade =
        1
        + panelShade
        + topWarmth * 0.055
        - bottomShadow * 0.42
        - verticalSeam * 0.32
        - hairline * 0.24
        + grain;

      data[idx] = clamp255(170 * shade + 8 * broadPanel);
      data[idx + 1] = clamp255(108 * shade + 6 * broadPanel);
      data[idx + 2] = clamp255(76 * shade + 4 * broadPanel);
      data[idx + 3] = 255;
    }
  }

  return makeRepeatingTexture(data, `surface-${name}`);
}

function paintTextureFromRecipe(name: SurfaceTextureKey, recipe: TextureRecipe): THREE.DataTexture {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const random = mulberry32(recipe.seed);

  fillBaseColor(data, recipe.base);

  for (const stamp of recipe.stamps) {
    const stretchY = stamp.stretchY ?? 1;
    for (let i = 0; i < stamp.count; i += 1) {
      const cx = Math.floor(random() * TEXTURE_SIZE);
      const cy = Math.floor(random() * TEXTURE_SIZE);
      paintBlurredEllipse(data, cx, cy, stamp.radius, stamp.radius * stretchY, stamp.color, stamp.alpha);
    }
  }

  if (recipe.grainIntensity > 0) {
    applyGrain(data, recipe.grainIntensity, recipe.grainTint, random);
  }

  return makeRepeatingTexture(data, `surface-${name}`);
}

function fillBaseColor(data: Uint8Array, color: [number, number, number]) {
  // Pack RGBA into a single u32 and fill once — ~10× faster than per-byte writes.
  // Layout is little-endian (Three.js Uint8Array on canvas data is RGBA byte-order),
  // so the u32 is `0xAABBGGRR`.
  const packed =
    ((255 << 24) >>> 0) |
    ((color[2] & 0xff) << 16) |
    ((color[1] & 0xff) << 8) |
    (color[0] & 0xff);
  new Uint32Array(data.buffer).fill(packed);
}

function paintBlurredEllipse(
  data: Uint8Array,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  color: [number, number, number],
  alpha: number,
) {
  const rxCeil = Math.ceil(radiusX);
  const ryCeil = Math.ceil(radiusY);

  for (let py = -ryCeil; py <= ryCeil; py += 1) {
    for (let px = -rxCeil; px <= rxCeil; px += 1) {
      const nx = px / radiusX;
      const ny = py / radiusY;
      const distance = Math.sqrt(nx * nx + ny * ny);
      if (distance > 1) continue;

      const falloff = 1 - distance * distance * (3 - 2 * distance);
      const a = alpha * falloff;
      const x = wrap(cx + px, TEXTURE_SIZE);
      const y = wrap(cy + py, TEXTURE_SIZE);
      const idx = (y * TEXTURE_SIZE + x) * 4;

      data[idx] = data[idx] * (1 - a) + color[0] * a;
      data[idx + 1] = data[idx + 1] * (1 - a) + color[1] * a;
      data[idx + 2] = data[idx + 2] * (1 - a) + color[2] * a;
    }
  }
}

function applyGrain(
  data: Uint8Array,
  intensity: number,
  tint: [number, number, number],
  random: () => number,
) {
  const pixels = TEXTURE_SIZE * TEXTURE_SIZE;
  for (let i = 0; i < pixels; i += 1) {
    const t = (random() - 0.5) * intensity * 2;
    const idx = i * 4;
    data[idx] = clamp255(data[idx] + tint[0] * t);
    data[idx + 1] = clamp255(data[idx + 1] + tint[1] * t);
    data[idx + 2] = clamp255(data[idx + 2] + tint[2] * t);
  }
}

function makeRepeatingTexture(data: Uint8Array, name: string): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    data,
    TEXTURE_SIZE,
    TEXTURE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.name = name;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return texture;
}

function wrap(value: number, size: number) {
  return ((value % size) + size) % size;
}

function clamp255(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function smoothstep(value: number, min: number, max: number) {
  if (value <= min) return 0;
  if (value >= max) return 1;
  const t = (value - min) / (max - min);
  return t * t * (3 - 2 * t);
}

/**
 * Mulberry32 PRNG — deterministic, fast, no allocation per call. Identical seeds across
 * runs produce identical textures, which keeps tests stable and lets art reviews compare.
 */
function mulberry32(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SURFACE_TEXTURE_SIZE = TEXTURE_SIZE;
