import { expect, type Page, test } from '@playwright/test';

function collectPageErrors(page: Page) {
  const errors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  return errors;
}

async function sampleCanvasPixels(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#scene');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');

    if (!canvas || !gl) {
      return [];
    }

    gl.flush();

    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const points = [
      [0.2, 0.2],
      [0.5, 0.5],
      [0.8, 0.2],
      [0.35, 0.68],
      [0.65, 0.68],
    ];

    return points.map(([xRatio, yRatio]) => {
      const pixel = new Uint8Array(4);
      const x = Math.max(0, Math.min(width - 1, Math.floor(width * xRatio)));
      const y = Math.max(0, Math.min(height - 1, Math.floor(height * yRatio)));
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return Array.from(pixel);
    });
  });
}

test('renders the prototype canvas', async ({ page }, testInfo) => {
  const pageErrors = collectPageErrors(page);

  await page.goto('/');
  await page.waitForTimeout(500);

  const canvas = page.locator('#scene');
  await expect(canvas).toBeVisible();
  await expect(page.locator('.hud')).toContainText('Bellbound A0');

  const sceneObjectNames = await page.evaluate(() => window.__BELLBOUND_DEBUG__?.getSceneObjectNames());
  expect(sceneObjectNames).toEqual(
    expect.arrayContaining([
      'greybox-ground',
      'greybox-player',
      'placeholder-house',
      'placeholder-shop-counter',
      'fruit-tree-1',
      'fruit-tree-2',
      'fruit-tree-3',
    ]),
  );

  await page.waitForFunction(() => {
    const scene = document.querySelector<HTMLCanvasElement>('#scene');
    return Boolean(scene && scene.width > 0 && scene.height > 0);
  });

  const viewport = page.viewportSize();
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas bounding box is unavailable.');
  }

  expect(Math.round(box.width)).toBe(viewport?.width);
  expect(Math.round(box.height)).toBe(viewport?.height);

  const samples = await sampleCanvasPixels(page);
  const distinctSamples = new Set(samples.map((pixel) => pixel.join(',')));
  expect(samples.some((pixel) => pixel[3] > 0)).toBe(true);
  expect(distinctSamples.size).toBeGreaterThan(1);

  const canvasClip = {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  };
  const firstFrame = await page.screenshot({ clip: canvasClip });
  await page.waitForTimeout(700);
  const secondFrame = await page.screenshot({
    clip: canvasClip,
    path: testInfo.outputPath('bellbound-scene.png'),
  });

  expect(firstFrame.equals(secondFrame)).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('moves the A0 greybox player with keyboard input', async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto('/');
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => window.__BELLBOUND_DEBUG__?.getPlayerPosition());
  expect(before).toBeDefined();
  const startZ = before?.[2] ?? 0;

  await page.locator('#scene').click({ position: { x: 10, y: 10 } });
  await page.keyboard.down('KeyW');
  try {
    await page.waitForFunction(
      (z) => {
        const position = window.__BELLBOUND_DEBUG__?.getPlayerPosition();
        return Boolean(position && position[2] < z - 0.2);
      },
      startZ,
      { timeout: 5_000 },
    );
  } finally {
    await page.keyboard.up('KeyW');
  }

  const after = await page.evaluate(() => window.__BELLBOUND_DEBUG__?.getPlayerPosition());
  expect(after).toBeDefined();
  expect(after?.[2]).toBeLessThan(startZ - 0.2);
  expect(pageErrors).toEqual([]);
});
