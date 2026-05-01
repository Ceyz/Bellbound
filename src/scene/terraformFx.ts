import * as THREE from 'three';

/**
 * AC:NH-flavoured terraforming feedback. Each successful edit spawns a
 * burst of soft sparkle sprites that pop outward from the cell, rotate,
 * arc up under gravity, and fade. Replaces the earlier "ring + earth
 * motes" version which read flat and muddy at the cozy-game lighting.
 *
 * Three flavours:
 *  - **dustPuff (cliff)** — warm cream/gold sparkles, slightly heavier.
 *  - **splash (water)**   — cool cyan sparkles + brighter pop, no gravity.
 *  - **pathPop (path)**   — short fast sparkle in the path's tint color.
 *
 * All particles share one pre-baked CanvasTexture (a 4-pointed star with
 * a soft radial glow), tinted per spawn via the Sprite material color so
 * we don't pay the upload cost of N textures.
 */

interface ActiveSprite {
  sprite: THREE.Sprite;
  born: number;
  duration: number;
  vx: number;
  vy: number;
  vz: number;
  /** World-space gravity applied to vy each second. 0 = floats. */
  gravity: number;
  rotSpeed: number;
  startSize: number;
  endSize: number;
  baseOpacity: number;
}

const active: ActiveSprite[] = [];
let scene: THREE.Scene | null = null;
let clock = 0;
let sparkleTexture: THREE.Texture | null = null;

export function initTerraformFx(targetScene: THREE.Scene): void {
  scene = targetScene;
  if (!sparkleTexture) sparkleTexture = createSparkleTexture();
}

export function updateTerraformFx(elapsed: number): void {
  const dt = clock === 0 ? 0 : Math.min(0.05, elapsed - clock);
  clock = elapsed;
  for (let i = active.length - 1; i >= 0; i--) {
    const fx = active[i];
    const t = (clock - fx.born) / fx.duration;
    if (t >= 1) {
      if (scene) scene.remove(fx.sprite);
      (fx.sprite.material as THREE.SpriteMaterial).dispose();
      active.splice(i, 1);
      continue;
    }
    // Position update: integrate velocity, apply gravity, advance rotation.
    fx.sprite.position.x += fx.vx * dt;
    fx.sprite.position.y += fx.vy * dt;
    fx.sprite.position.z += fx.vz * dt;
    fx.vy -= fx.gravity * dt;
    fx.sprite.material.rotation += fx.rotSpeed * dt;
    // Cubic ease-out on size + opacity so the sparkle pops fast and
    // lingers gently before fading — the AC "twinkle" curve.
    const eased = 1 - Math.pow(1 - t, 3);
    const size = fx.startSize + (fx.endSize - fx.startSize) * eased;
    fx.sprite.scale.set(size, size, size);
    (fx.sprite.material as THREE.SpriteMaterial).opacity =
      fx.baseOpacity * Math.max(0, 1 - eased);
  }
}

interface SpawnParams {
  count: number;
  burstRadius: number;
  speed: { min: number; max: number };
  yLift: { min: number; max: number };
  duration: { min: number; max: number };
  colors: number[];
  size: { start: number; end: number };
  gravity: number;
  baseOpacity: number;
}

function spawnBurst(wx: number, y: number, wz: number, p: SpawnParams): void {
  if (!scene || !sparkleTexture) return;
  for (let i = 0; i < p.count; i++) {
    const angle = (i / p.count) * Math.PI * 2 + Math.random() * 0.5;
    const r = Math.random() * p.burstRadius;
    const speed = p.speed.min + Math.random() * (p.speed.max - p.speed.min);
    const yLift = p.yLift.min + Math.random() * (p.yLift.max - p.yLift.min);
    const duration = p.duration.min + Math.random() * (p.duration.max - p.duration.min);
    const color = p.colors[Math.floor(Math.random() * p.colors.length)];
    const startSize = p.size.start * (0.85 + Math.random() * 0.3);
    const endSize = p.size.end * (0.85 + Math.random() * 0.3);

    const material = new THREE.SpriteMaterial({
      map: sparkleTexture,
      color,
      transparent: true,
      opacity: p.baseOpacity,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      rotation: Math.random() * Math.PI * 2,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(
      wx + Math.cos(angle) * r,
      y + 0.05 + Math.random() * 0.1,
      wz + Math.sin(angle) * r,
    );
    sprite.scale.set(startSize, startSize, startSize);
    sprite.renderOrder = 95;
    scene.add(sprite);

    active.push({
      sprite,
      born: clock,
      duration,
      vx: Math.cos(angle) * speed,
      vy: yLift,
      vz: Math.sin(angle) * speed,
      gravity: p.gravity,
      rotSpeed: (Math.random() - 0.5) * 6,
      startSize,
      endSize,
      baseOpacity: p.baseOpacity,
    });
  }
}

/** Cliff raise/lower — cream-gold star burst with light upward arc. */
export function spawnDustPuff(wx: number, y: number, wz: number): void {
  spawnBurst(wx, y, wz, {
    count: 7,
    burstRadius: 0.18,
    speed: { min: 1.0, max: 1.7 },
    yLift: { min: 1.2, max: 1.9 },
    duration: { min: 0.55, max: 0.8 },
    // Warm cream + soft gold + a touch of pink so the burst reads cozy.
    colors: [0xfff3d5, 0xffe2a8, 0xffcd80, 0xffd6c2],
    size: { start: 0.55, end: 0.18 },
    gravity: 3.2,
    baseOpacity: 0.95,
  });
}

/** Water dig/fill — cool cyan splash, no gravity (sparkles drift outward). */
export function spawnSplash(wx: number, y: number, wz: number): void {
  spawnBurst(wx, y, wz, {
    count: 9,
    burstRadius: 0.15,
    speed: { min: 1.2, max: 2.1 },
    yLift: { min: 0.8, max: 1.6 },
    duration: { min: 0.5, max: 0.75 },
    colors: [0xeaf6ff, 0xb8e3f0, 0x88cce0, 0xffffff],
    size: { start: 0.55, end: 0.12 },
    gravity: 1.4,
    baseOpacity: 1,
  });
}

/** Path paint — fast brief sparkle in the path tint, light upward drift. */
export function spawnPathPop(wx: number, y: number, wz: number, tint = 0xffe2a8): void {
  spawnBurst(wx, y, wz, {
    count: 4,
    burstRadius: 0.22,
    speed: { min: 0.5, max: 0.9 },
    yLift: { min: 0.6, max: 1.0 },
    duration: { min: 0.32, max: 0.5 },
    colors: [tint, 0xfff5dc, 0xffffff],
    size: { start: 0.42, end: 0.10 },
    gravity: 0.8,
    baseOpacity: 0.95,
  });
}

/**
 * Pre-baked 64×64 RGBA texture: a 4-pointed star with a soft radial glow
 * around it. Multiplied by the Sprite material color at spawn time.
 *
 * Drawing strategy: radial gradient core (the diffuse glow) + four
 * thin gradient "rays" along ±X and ±Y to give the classic AC twinkle.
 */
function createSparkleTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;

  // Soft radial glow base.
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c);
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  glow.addColorStop(0.25, 'rgba(255, 255, 255, 0.55)');
  glow.addColorStop(0.55, 'rgba(255, 255, 255, 0.18)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Four rays — long thin gradients along the cardinal axes. Drawn with
  // additive lighter-blend so they peak at the center and fade outward.
  ctx.globalCompositeOperation = 'lighter';
  drawRay(ctx, c, c, size * 0.48, 0);              // east
  drawRay(ctx, c, c, size * 0.48, Math.PI / 2);    // south
  drawRay(ctx, c, c, size * 0.48, Math.PI);        // west
  drawRay(ctx, c, c, size * 0.48, 3 * Math.PI / 2); // north
  ctx.globalCompositeOperation = 'source-over';

  // Bright pinpoint center.
  const pin = ctx.createRadialGradient(c, c, 0, c, c, 5);
  pin.addColorStop(0, 'rgba(255, 255, 255, 1)');
  pin.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = pin;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function drawRay(ctx: CanvasRenderingContext2D, cx: number, cy: number, length: number, angle: number) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const ex = cx + dx * length;
  const ey = cy + dy * length;
  const grad = ctx.createLinearGradient(cx, cy, ex, ey);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  grad.addColorStop(0.4, 'rgba(255, 255, 255, 0.35)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = grad;
  // Render the ray as a thin diamond strip along +X.
  ctx.beginPath();
  ctx.moveTo(0, -1.5);
  ctx.lineTo(length, 0);
  ctx.lineTo(0, 1.5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.fill();
  ctx.restore();
}
