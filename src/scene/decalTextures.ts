import * as THREE from 'three';

/**
 * Procedural alpha textures for surface decals (footprints, ripples).
 *
 * Kept procedural rather than file assets because they are tiny, mostly transparent,
 * and their shape is parametric — easier to iterate on rate-of-falloff than to
 * regenerate PNGs each tweak. Shipped as `THREE.DataTexture` to stay portable across
 * environments without a `document` (vitest).
 */

const FOOTPRINT_SIZE = 64;
const RIPPLE_SIZE = 64;

export function createFootprintTexture(): THREE.DataTexture {
  const data = new Uint8Array(FOOTPRINT_SIZE * FOOTPRINT_SIZE * 4);

  // Single elongated soft oval — long axis on Y of the texture, which the spawn caller
  // aligns with the player's facing direction via `mesh.rotation.y`.
  const cx = FOOTPRINT_SIZE / 2;
  const cy = FOOTPRINT_SIZE / 2;
  const radiusX = FOOTPRINT_SIZE * 0.18;
  const radiusY = FOOTPRINT_SIZE * 0.4;

  for (let y = 0; y < FOOTPRINT_SIZE; y += 1) {
    for (let x = 0; x < FOOTPRINT_SIZE; x += 1) {
      const nx = (x - cx) / radiusX;
      const ny = (y - cy) / radiusY;
      const distance = Math.sqrt(nx * nx + ny * ny);
      const idx = (y * FOOTPRINT_SIZE + x) * 4;

      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;

      if (distance < 1) {
        const falloff = 1 - distance * distance * (3 - 2 * distance);
        data[idx + 3] = Math.round(falloff * 220);
      } else {
        data[idx + 3] = 0;
      }
    }
  }

  return makeAlphaTexture(data, FOOTPRINT_SIZE, 'decal-footprint');
}

export function createRippleTexture(): THREE.DataTexture {
  const data = new Uint8Array(RIPPLE_SIZE * RIPPLE_SIZE * 4);

  // Soft ring: peak alpha at `ringRadius`, fades over `ringWidth` on both sides.
  const cx = RIPPLE_SIZE / 2;
  const cy = RIPPLE_SIZE / 2;
  const ringRadius = RIPPLE_SIZE * 0.38;
  const ringWidth = RIPPLE_SIZE * 0.07;

  for (let y = 0; y < RIPPLE_SIZE; y += 1) {
    for (let x = 0; x < RIPPLE_SIZE; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const radial = Math.sqrt(dx * dx + dy * dy);
      const distanceToRing = Math.abs(radial - ringRadius);
      const idx = (y * RIPPLE_SIZE + x) * 4;

      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;

      if (distanceToRing < ringWidth) {
        const t = distanceToRing / ringWidth;
        data[idx + 3] = Math.round((1 - t * t) * 200);
      } else {
        data[idx + 3] = 0;
      }
    }
  }

  return makeAlphaTexture(data, RIPPLE_SIZE, 'decal-ripple');
}

function makeAlphaTexture(data: Uint8Array, size: number, name: string): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.name = name;
  // Linear (not sRGB) — alpha-driven decals don't carry meaningful color tone.
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return texture;
}
