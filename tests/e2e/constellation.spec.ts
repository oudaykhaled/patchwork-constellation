import { expect, test, type Page } from '@playwright/test';

async function openDemo(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('graph-viewport')).toBeVisible();
  await expect(page.getByTestId('changed-count')).toContainText('68');
  // The initial data can arrive before ResizeObserver fits and paints the canvas.
  // Wait for actual file-circle pixels before reading or changing the camera.
  await expect.poll(() => page.getByTestId('graph-canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let files = 0;
    for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 1] > 90 && pixels[i + 1] > pixels[i] * 1.35 && pixels[i + 2] < 150) files++;
    return files;
  })).toBeGreaterThan(100);
}

test('selecting PRs changes the footprint and keeps the graph mounted', async ({ page }) => {
  await page.addInitScript(() => {
    // Observe the actual circles painted by the renderer, including its cached
    // scene canvas. Camera and island labels alone cannot prove files stayed put.
    const centers = new WeakMap<object, Set<string>>();
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function(...args) {
      centers.set(this.canvas, new Set());
      return clear.apply(this, args);
    };
    const circle = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function(...args) {
      let current = centers.get(this.canvas);
      if (!current) { current = new Set(); centers.set(this.canvas, current); }
      current.add(JSON.stringify(args.slice(0, 2)));
      Object.assign(window, { drawnFileCenters: current });
      return circle.apply(this, args);
    };
  });
  await openDemo(page);
  const canvas = page.getByTestId('graph-canvas');
  const fileCenters = () => page.evaluate(() => [...((window as unknown as { drawnFileCenters?: Set<string> }).drawnFileCenters ?? [])].sort());
  await expect.poll(async () => (await fileCenters()).length).toBe(212);
  const initialFileCenters = await fileCenters();
  const initialSceneBuilds = Number(await canvas.getAttribute('data-scene-cache-builds'));
  const initialScale = await canvas.getAttribute('data-camera-scale');
  const initialX = await canvas.getAttribute('data-camera-x');
  const initialY = await canvas.getAttribute('data-camera-y');
  const islandPositions = await page.locator('.island-label').evaluateAll(elements => elements.map(element => ({
    label: element.querySelector('.island-title')?.textContent,
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  })));
  await expect(page.getByTestId('overlap-count')).toContainText('14');
  await page.getByTestId('source-selector').click();
  await page.getByTestId('source-pr-256').click();
  await expect(page.getByTestId('changed-count')).toContainText('57');
  await expect(page.getByTestId('overlap-count')).toContainText('2');
  await expect.poll(async () => Number(await canvas.getAttribute('data-scene-cache-builds'))).toBeGreaterThan(initialSceneBuilds);
  await expect.poll(fileCenters).toEqual(initialFileCenters);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('graph-viewport')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-camera-scale', initialScale!);
  await expect(canvas).toHaveAttribute('data-camera-x', initialX!);
  await expect(canvas).toHaveAttribute('data-camera-y', initialY!);
  expect(await page.locator('.island-label').evaluateAll(elements => elements.map(element => ({
    label: element.querySelector('.island-title')?.textContent,
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  })))).toEqual(islandPositions);
});

test('zoom and keyboard pan update the actual graph camera', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDemo(page);
  const canvas = page.getByTestId('graph-canvas');
  const initialScale = Number(await canvas.getAttribute('data-camera-scale'));
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-camera-scale'))).toBeGreaterThan(initialScale);
  const zoomedX = Number(await canvas.getAttribute('data-camera-x'));
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await canvas.getAttribute('data-camera-x'))).toBeGreaterThan(zoomedX);
  await page.getByRole('button', { name: 'Fit all islands', exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-camera-scale'))).toBeCloseTo(initialScale, 4);
});

test('commit mode shows the two-commit footprint independently of PRs', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('source-selector').click();
  await page.getByTestId('source-mode-commit').click();
  await expect(page.getByTestId('changed-count')).toContainText('24');
  await expect(page.getByTestId('overlap-count')).toContainText('4');
});

test('search opens the matching file inspector with honest demo provenance', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('file-search').fill('refresh.ts');
  await page.getByRole('option', { name: /refresh\.ts/ }).first().click();
  const inspector = page.getByTestId('file-inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('src/auth/session/refresh.ts');
  await expect(inspector).toContainText(/synthetic|sample|demo/i);
  await page.keyboard.press('Escape');
  await expect(inspector).toBeHidden();
});

test('accessible file list exposes file-level review without canvas hit testing', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('accessible-list-toggle').click();
  await page.getByLabel('Filter file list').fill('refresh.ts');
  await expect(page.getByRole('button', { name: /refresh\.ts/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /refresh\.ts/ }).first().click();
  await expect(page.getByTestId('file-inspector')).toContainText('refresh.ts');
});

test('repository failures preserve the current map and show a recoverable error', async ({ page }) => {
  await page.route('**/api/analyze', route => route.fulfill({ status: 202, json: { jobId: 'fixture-denied' } }));
  await page.route('**/api/jobs/fixture-denied', route => route.fulfill({ json: { status: 'failed', error: 'Repository access has been revoked.' } }));
  await openDemo(page);
  await page.getByRole('button', { name: 'Choose repository', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Repository', { exact: true }).fill('example/denied');
  await dialog.getByRole('button', { name: 'Map repository', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Repository access has been revoked.');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('graph-viewport')).toBeVisible();
});

test('a grouping response from an older repository context cannot reappear', async ({ page }) => {
  let release!: () => void;
  let routeCompleted!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { routeCompleted = resolve; });
  await page.route('**/api/grouping', async route => {
    await delayed;
    try { await route.fulfill({ json: {
      id: 'stale-proposal', snapshotId: 'demo', status: 'baseline', origin: 'rules',
      message: 'STALE_RESPONSE_MUST_NOT_REAPPEAR', groups: [], membership: {}, decisions: [],
      dataPolicy: { fieldsSent: [], excludedFiles: 0, analyzedFiles: 0 },
    } }); } catch { /* Cancelling the old context may already have aborted its request. */ }
    finally { routeCompleted(); }
  });
  try {
    await openDemo(page);
    await page.getByTestId('grouping-controls').click();
    const pending = page.waitForRequest('**/api/grouping');
    await page.getByRole('button', { name: 'Review with AI + Jev', exact: true }).click();
    await pending;
    await page.getByRole('button', { name: 'Close Make sense of the islands', exact: true }).click();
    await page.getByRole('button', { name: 'Choose repository', exact: true }).click();
    await page.getByRole('button', { name: /212 files.*6 islands.*sample PRs and commits/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    release();
    await completed;
    await page.getByTestId('grouping-controls').click();
    await expect(page.getByRole('dialog')).not.toContainText('STALE_RESPONSE_MUST_NOT_REAPPEAR');
    await expect(page.getByRole('button', { name: 'Review with AI + Jev', exact: true })).toBeEnabled();
    await expect(page.getByTestId('changed-count')).toHaveText('68');
  } finally { release(); }
});

test('manual island renaming is reversible and unavailable AI retains the baseline', async ({ page }, testInfo) => {
  // Exercise the real local revision API once; independent browser projects share one local service.
  test.skip(testInfo.project.name !== 'chromium', 'The shared single-user revision API is exercised in Chromium.');
  await page.route('**/api/grouping', route => route.fulfill({ json: {
    id: 'fixture-baseline', snapshotId: 'demo', status: 'baseline', origin: 'rules',
    message: 'AI providers are disabled. Deterministic grouping is retained.', groups: [],
    membership: {}, decisions: [], dataPolicy: { fieldsSent: [], excludedFiles: 0, analyzedFiles: 0 },
  } }));
  await openDemo(page);
  await page.getByTestId('grouping-controls').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Review with AI + Jev', exact: true }).click();
  await expect(dialog).toContainText('BASELINE PRESERVED');
  await expect(dialog).toContainText('AI providers are disabled.');
  const originalName = await dialog.locator('.grouping-list strong').first().innerText();
  const reviewName = `Identity review ${Date.now()}`;
  await dialog.getByRole('button', { name: 'Rename', exact: true }).first().click();
  await dialog.getByLabel('Island name', { exact: true }).fill(reviewName);
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog.getByText(reviewName, { exact: true }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Undo grouping', exact: true }).click();
  await expect(dialog.getByText(originalName, { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText(reviewName, { exact: true })).toBeHidden();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1600, height: 1000 }]) {
  test(`graph occupies at least 80% at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openDemo(page);
    const box = await page.getByTestId('graph-viewport').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width * box!.height / (viewport.width * viewport.height)).toBeGreaterThanOrEqual(0.8);
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(overflow.width).toBeLessThanOrEqual(overflow.viewport + 1);
    await testInfo.attach(`constellation-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

test('core controls remain usable with reduced motion and a narrow viewport', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await page.getByTestId('source-selector').click();
  await expect(page.getByTestId('source-pr-248')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('accessible-list-toggle').click();
  await page.getByLabel('Filter file list').fill('refresh.ts');
  await expect(page.getByRole('button', { name: /refresh\.ts/ }).first()).toBeVisible();
});
