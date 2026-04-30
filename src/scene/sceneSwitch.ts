/**
 * Tiny helper for the outdoor ↔ indoor scene transitions used in A0.4.
 *
 * Pattern (per `GAME_SPEC.md` housing system, AC-style):
 *   click door → swing door → fade to black → swap → fade in
 *
 * The scene swap itself is whatever closure the caller passes — we don't know about
 * Three.js scenes here, just the timing + the visual fade.
 */
export type ActiveScene = 'outdoor' | 'indoor';

export interface SceneSwitchState {
  current: ActiveScene;
  transitioning: boolean;
}

const FADE_MS = 200;

export function createSceneSwitchState(): SceneSwitchState {
  return { current: 'outdoor', transitioning: false };
}

/** Lazily-created full-viewport black overlay used by the fade. */
function getFadeOverlay(): HTMLElement {
  let el = document.querySelector<HTMLElement>('.scene-fade-overlay');
  if (el) return el;

  injectFadeStyles();

  el = document.createElement('div');
  el.className = 'scene-fade-overlay';
  document.body.appendChild(el);
  return el;
}

function injectFadeStyles() {
  if (document.querySelector('style[data-scene-fade-styles]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-scene-fade-styles', '');
  style.textContent = `
    .scene-fade-overlay {
      position: fixed;
      inset: 0;
      background: #000;
      opacity: 0;
      pointer-events: none;
      transition: opacity ${FADE_MS}ms ease;
      z-index: 90;
    }
    .scene-fade-overlay.scene-fade-active {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Run a scene transition: fade-to-black → swap → fade-back-in.
 * Returns a Promise that resolves once the transition is fully done.
 */
export async function performTransition(
  state: SceneSwitchState,
  target: ActiveScene,
  swap: () => void,
): Promise<void> {
  if (state.transitioning) return;
  if (state.current === target) return;
  state.transitioning = true;

  const overlay = getFadeOverlay();

  // 1. Fade to black.
  overlay.classList.add('scene-fade-active');
  await wait(FADE_MS);

  // 2. Hot-swap the scene state.
  swap();
  state.current = target;

  // 3. Fade back in.
  overlay.classList.remove('scene-fade-active');
  await wait(FADE_MS);

  state.transitioning = false;
}

/**
 * Procedural easing tween for a single rotation value. Used for the door swing —
 * keeps us off `@tweenjs/tween.js` (sub-dep, not Locked per `TECH_STACK.md`).
 */
export function animateRotationY(
  object: { rotation: { y: number } },
  toAngle: number,
  durationMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const fromAngle = object.rotation.y;
    const start = performance.now();
    function tick() {
      const elapsed = performance.now() - start;
      const t = Math.min(elapsed / durationMs, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      object.rotation.y = fromAngle + (toAngle - fromAngle) * eased;
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    }
    tick();
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
