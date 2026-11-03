import { expect, test, type Page } from '@playwright/test';

async function openGraph(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await expect.poll(async () => Number(await page.getByTestId('graph-canvas').getAttribute('data-visible-file-count'))).toBe(212);
}
async function camera(page: Page) {
  const canvas = page.getByTestId('graph-canvas');
  return { x: Number(await canvas.getAttribute('data-camera-x')), y: Number(await canvas.getAttribute('data-camera-y')), zoom: Number(await canvas.getAttribute('data-camera-scale')) };
}

test('wheel zoom preserves its world anchor and modified wheel remains browser-owned', async ({ page }) => {
  await openGraph(page);
  const canvas = page.getByTestId('graph-canvas'), rect = (await canvas.boundingBox())!;
  const before = await camera(page), anchor = { x: Math.round(rect.width * .35), y: Math.round(rect.height * .55) };
  const world = { x: (anchor.x - rect.width / 2) / before.zoom + before.x, y: (anchor.y - rect.height / 2) / before.zoom + before.y };
  await page.mouse.move(rect.x + anchor.x, rect.y + anchor.y);
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(before.zoom);
  const after = await camera(page);
  expect((world.x - after.x) * after.zoom + rect.width / 2).toBeCloseTo(anchor.x, 4);
  expect((world.y - after.y) * after.zoom + rect.height / 2).toBeCloseTo(anchor.y, 4);
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(before.zoom, 4);
  const browserOwned = await canvas.evaluate(element => {
    const event = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event); return !event.defaultPrevented;
  });
  expect(browserOwned).toBe(true);
  expect(await canvas.evaluate(element => {
    const event = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event); return !event.defaultPrevented;
  })).toBe(true);
  expect((await camera(page)).zoom).toBeCloseTo(before.zoom, 4);
});

test('minimap inner corners map precisely and keyboard controls reposition without losing focus', async ({ page }) => {
  await openGraph(page);
  const minimap = page.getByRole('button', { name: /^Repository minimap/ });
  const svg = (await minimap.locator('svg').boundingBox())!;
  await page.mouse.click(svg.x + svg.width * .25, svg.y + svg.height * .75);
  expect((await camera(page)).x).toBeCloseTo(400, 0);
  expect((await camera(page)).y).toBeCloseTo(702, 0);
  const before = await camera(page);
  await minimap.focus(); await page.keyboard.press('ArrowRight');
  expect((await camera(page)).x).toBeCloseTo(before.x + 100 / before.zoom, 4);
  await expect(minimap).toBeFocused();
  await page.keyboard.press('Home');
  await expect.poll(async () => Number(await page.getByTestId('graph-canvas').getAttribute('data-visible-file-count'))).toBe(212);
});

test('fit and navigation stay clear of the open desktop inspector', async ({ page }) => {
  await openGraph(page);
  await page.getByTestId('file-search').fill('refresh.ts');
  await page.getByRole('option', { name: /refresh\.ts/ }).first().click();
  const inspector = page.getByTestId('file-inspector');
  await expect(inspector).toBeVisible();
  const fit = page.getByRole('button', { name: 'Fit all islands', exact: true });
  const inspectorBox = (await inspector.boundingBox())!, fitBox = (await fit.boundingBox())!;
  expect(fitBox.x + fitBox.width).toBeLessThan(inspectorBox.x);
  await fit.click();
  const c = await camera(page), canvasBox = (await page.getByTestId('graph-canvas').boundingBox())!;
  const rightBound = (1600 - c.x) * c.zoom + canvasBox.width / 2;
  expect(rightBound).toBeLessThan(inspectorBox.x - canvasBox.x);
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection-cue', 'corner-brackets');
  await page.getByRole('button', { name: 'Fit selected island', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect((await camera(page)).zoom).toBeGreaterThan(c.zoom);
  await expect(page.getByRole('button', { name: 'Fit selected island', exact: true })).toBeFocused();
});

test('drag changes the camera and source changes retain that exact location', async ({ page }) => {
  await openGraph(page);
  const canvas = page.getByTestId('graph-canvas'), rect = (await canvas.boundingBox())!;
  const before = await camera(page);
  const start = { x: Math.round(rect.x + rect.width * .57), y: Math.round(rect.y + rect.height * .35) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down(); await page.mouse.move(start.x + 100, start.y + 40, { steps: 4 }); await page.mouse.up();
  const after = await camera(page);
  expect(after.x).toBeCloseTo(before.x - 100 / before.zoom, 4);
  expect(after.y).toBeCloseTo(before.y - 40 / before.zoom, 4);
  await page.getByTestId('source-selector').click(); await page.getByTestId('source-pr-256').click(); await page.keyboard.press('Escape');
  await expect(page.getByTestId('changed-count')).toHaveText('57');
  expect(await camera(page)).toEqual(after);
  await expect(page.getByLabel('Graph detail', { exact: true })).toContainText('/ 212 files in view');
});

test('real two-touch pinch supports translation and releases cleanly', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real multitouch injection uses Chromium CDP; pure anchor math is engine-independent.');
  await openGraph(page);
  const canvas = page.getByTestId('graph-canvas'), rect = (await canvas.boundingBox())!;
  const before = await camera(page), cdp = await page.context().newCDPSession(page);
  const x = Math.round(rect.x + rect.width * .5), y = Math.round(rect.y + rect.height * .35);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 50, y }, { id: 2, x: x + 50, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x - 70, y: y + 30 }, { id: 2, x: x + 130, y: y + 30 }] });
  await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(before.zoom * 2, 3);
  const after = await camera(page);
  const oldAnchor = { x: (x - rect.x - rect.width / 2) / before.zoom + before.x, y: (y - rect.y - rect.height / 2) / before.zoom + before.y };
  expect((oldAnchor.x - after.x) * after.zoom + rect.width / 2).toBeCloseTo(x - rect.x + 30, 1);
  expect((oldAnchor.y - after.y) * after.zoom + rect.height / 2).toBeCloseTo(y - rect.y + 30, 1);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByTestId('graph-surface')).not.toHaveClass(/is-dragging/);
  await expect(page.getByTestId('file-inspector')).toBeHidden();
  await cdp.detach();
});

test('input interrupts camera animation and resize leaves navigation reachable', async ({ page }) => {
  await openGraph(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const before = await camera(page);
  await page.getByRole('button', { name: /^Explore Authentication island/ }).click();
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(before.zoom);
  await page.getByRole('button', { name: 'Pan right', exact: true }).click();
  const interrupted = await camera(page);
  // Wait beyond the documented 320 ms transition to detect a surviving RAF.
  await page.waitForTimeout(360);
  expect(await camera(page)).toEqual(interrupted);
  await page.setViewportSize({ width: 800, height: 600 });
  const fit = page.getByRole('button', { name: 'Fit all islands', exact: true });
  const box = (await fit.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(800);
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(600);
  await fit.focus(); await page.keyboard.press('Enter'); await expect(fit).toBeFocused();
});
