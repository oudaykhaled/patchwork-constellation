import { expect, test, type Page } from '@playwright/test';
import { createDemoSnapshot, createScaleFixture } from '../../packages/fixtures/src/index';
import { layoutGraph, selectedMembership, worldToScreen } from '../../packages/graph-core/src/index';
import type { GraphSnapshot } from '../../packages/contracts/src/index';

// Islands are quiet rounded rectangles sized by file count, with no names on the
// canvas. Hover or keyboard focus names an island in the one tooltip; chrome stays off the map.
const snapshot = createDemoSnapshot();
const layout = layoutGraph(snapshot);
const membership = selectedMembership(snapshot, ['pr-248', 'pr-251', 'pr-256']);
const changedIn = (label: string) => layout.islands.find(island => island.label === label)!.nodes.filter(node => membership.has(node.id)).length;

async function openGraph(page: Page, graph: object = snapshot) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/demo', route => route.fulfill({ json: graph }));
  await page.goto('/');
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
  await expect(page.getByTestId('changed-count')).not.toHaveText('—');
}
async function camera(page: Page) {
  const canvas = page.getByTestId('graph-canvas');
  return { x: Number(await canvas.getAttribute('data-camera-x')), y: Number(await canvas.getAttribute('data-camera-y')), zoom: Number(await canvas.getAttribute('data-camera-scale')) };
}
/** Routed synthetic graphs are unknown to the server; its error banner must not sit over pointer targets. */
async function dismissError(page: Page) {
  if (await page.locator('.error-banner').count()) await page.getByRole('button', { name: 'Dismiss error' }).click();
}
/** A page point on the island's left padding band: inside the rectangle, out of reach of any file. */
async function islandPoint(page: Page, label: string) {
  const island = layout.islands.find(group => group.label === label)!;
  const box = (await page.getByTestId('graph-canvas').boundingBox())!, current = await camera(page);
  const point = worldToScreen({ x: island.x - island.rx, y: island.y }, current, box.width, box.height);
  return { x: box.x + point.x + 6, y: box.y + point.y };
}

test('islands are unnamed rectangles until hovered, and hover names one island at a time', async ({ page }) => {
  await openGraph(page);
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  // One focusable, named control per island, but no island name painted on the map.
  await expect(page.locator('.island-label')).toHaveCount(6);
  for (const size of await page.locator('.island-title').evaluateAll(elements => elements.map(element => element.getBoundingClientRect()).map(rect => Math.max(rect.width, rect.height)))) expect(size).toBeLessThanOrEqual(1);
  expect(await page.locator('.island-label').evaluateAll(elements => elements.every(element => getComputedStyle(element).pointerEvents === 'none'))).toBe(true);
  await expect(page.locator('.organization-hint')).toHaveCount(0);

  const auth = await islandPoint(page, 'Authentication');
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), auth)).toBe('graph-canvas');
  await page.mouse.move(auth.x, auth.y);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveAttribute('data-kind', 'island');
  await expect(tooltip).toContainText('Authentication');
  await expect(tooltip).toContainText(`${changedIn('Authentication')} changed · 42 files`);
  await expect(tooltip).toContainText('Click or Enter to focus island');
  // The second line says how the island was grouped, in words.
  await expect(tooltip.locator('.tooltip-path')).toHaveText('Package manifest');
  await expect(page.locator('.island-ring[data-state="hover"]')).toBeVisible();
  // Warm state: the next island switches at once, still exactly one tooltip.
  const billing = await islandPoint(page, 'Billing');
  await page.mouse.move(billing.x, billing.y);
  await expect(tooltip).toContainText('Billing');
  await expect(tooltip).toContainText(`${changedIn('Billing')} changed · 36 files`);
  // Escape dismisses without moving focus; empty canvas closes after the bridge.
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  const canvasBox = (await page.getByTestId('graph-canvas').boundingBox())!;
  await page.mouse.move(canvasBox.x + 12, canvasBox.y + canvasBox.height / 2);
  await expect(page.locator('.island-ring')).toHaveCount(0);
  // A click on the island background focuses it: breadcrumb plus an island fit.
  const before = await camera(page);
  await page.mouse.click(billing.x, billing.y);
  await expect(page.locator('.focus-breadcrumb strong')).toHaveText('Billing');
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(before.zoom);
  await expect(page.locator('.island-ring[data-state="focus"]')).toBeVisible();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
});

test('the island group is one Tab stop with a roving focus that shows the same tooltip', async ({ page }) => {
  await openGraph(page);
  await page.getByTestId('graph-canvas').focus();
  await page.keyboard.press('Tab');
  const focused = page.locator('.island-label:focus');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute('tabindex', '0');
  await expect(page.locator('.island-label[tabindex="0"]')).toHaveCount(1);
  const first = (await focused.getAttribute('aria-label'))!;
  expect(first).toMatch(/^Explore .* island, \d+ changed of \d+ files$/);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveAttribute('data-kind', 'island');
  await expect(tooltip).toContainText(first.replace(/^Explore (.*) island,.*$/, '$1'));
  await expect(focused).toHaveAttribute('aria-describedby', 'graph-island-tooltip');
  await expect(page.locator('.island-ring[data-state="keyboard"]')).toBeVisible();
  // Arrow keys move through islands in reading order; the tooltip follows focus.
  await page.keyboard.press('ArrowRight');
  const second = (await page.locator('.island-label:focus').getAttribute('aria-label'))!;
  expect(second).not.toBe(first);
  await expect(tooltip).toContainText(second.replace(/^Explore (.*) island,.*$/, '$1'));
  await expect(page.locator('.island-label[tabindex="0"]')).toHaveAttribute('aria-label', second);
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await expect(page.locator('.island-label:focus')).toHaveAttribute('aria-label', first);
  // Escape hides the tooltip and keeps focus; Enter focuses the island; Escape again clears it.
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(page.locator('.island-label:focus')).toHaveAttribute('aria-label', first);
  // A second Escape has nothing left to close: the place in the island list is kept.
  await page.keyboard.press('Escape');
  await expect(page.locator('.island-label:focus')).toHaveAttribute('aria-label', first);
  await expect(page.getByTestId('file-search')).not.toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.focus-breadcrumb strong')).toHaveText(first.replace(/^Explore (.*) island,.*$/, '$1'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.focus-breadcrumb')).toHaveCount(0);
  // Keyboard focus stays on the same island; it does not jump to search.
  await expect(page.locator('.island-label:focus')).toHaveAttribute('aria-label', first);
  await expect(page.getByTestId('file-search')).not.toBeFocused();
  expect(await page.evaluate(() => scrollY + document.documentElement.scrollLeft + (document.querySelector('.app-shell')?.scrollTop ?? 0))).toBe(0);
});

test('Tab goes from search and the strip to the map, its islands, then the bottom bar', async ({ page, browserName }) => {
  // Like Safari's default, WebKit on macOS moves Tab between form fields only and skips buttons.
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'macOS WebKit Tab skips buttons');
  await openGraph(page);
  await page.getByTestId('file-search').focus();
  const name = () => page.evaluate(() => { const element = document.activeElement as HTMLElement; return element.dataset.testid || element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 30) || element.tagName; });
  const order: string[] = [];
  for (let i = 0; i < 30 && order.at(-1) !== 'Explain graph symbols and connections'; i++) { await page.keyboard.press('Tab'); order.push(await name()); }
  const at = (label: string | RegExp) => order.findIndex(entry => typeof label === 'string' ? entry === label : label.test(entry));
  expect(at(/^Islands:/)).toBeGreaterThanOrEqual(0);
  expect(at('accessible-list-toggle')).toBeGreaterThan(at(/^Islands:/));
  expect(at('graph-canvas')).toBeGreaterThan(at('accessible-list-toggle'));
  expect(at(/^Explore .* island/)).toBe(at('graph-canvas') + 1);
  expect(at('Explain graph symbols and connections')).toBeGreaterThan(at(/^Explore .* island/));
  await page.getByTestId('graph-canvas').focus();
  await page.keyboard.press('Shift+Tab');
  expect(await name()).toBe('accessible-list-toggle');
});

for (const viewport of [{ width: 1600, height: 1000 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
  test(`chrome stays off the fitted map at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const graph of [snapshot, createScaleFixture(10_000, 40_000, 42)]) {
      await openGraph(page, graph);
      await page.getByRole('button', { name: 'Fit all islands', exact: true }).click();
      const result = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const canvas = box('[data-testid="graph-canvas"]'), strip = box('.graph-strip'), bar = box('.graph-bottom-bar'), search = box('.graph-search'), sources = box('.source-bar');
        const islands = [...document.querySelectorAll('.island-label')].map(element => element.getBoundingClientRect());
        const inside = islands.filter(rect => rect.left >= canvas.left - .5 && rect.right <= canvas.right + .5 && rect.top >= strip.bottom - .5 && rect.bottom <= bar.top + .5);
        const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        return { islands: islands.length, inside: inside.length, underSearch: islands.filter(rect => overlaps(rect, search) || overlaps(rect, sources)).length, barInCanvas: bar.bottom <= canvas.bottom && bar.top > strip.bottom };
      });
      expect(result.inside).toBe(result.islands);
      expect(result.underSearch).toBe(0);
      expect(result.barInCanvas).toBe(true);
      await expect(page.getByLabel('Graph detail', { exact: true })).toContainText(`${(graph as { nodes: unknown[] }).nodes.length.toLocaleString('en-US')} / ${(graph as { nodes: unknown[] }).nodes.length.toLocaleString('en-US')} files in view`);
    }
  });
}

test('Imports appears only with import lines, and island names can be drawn always', async ({ page }) => {
  await page.addInitScript(() => {
    const texts = new Set<string>();
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...rest) { texts.add(String(text)); return fill.call(this, text, ...rest); };
    Object.assign(window, { drawnTexts: texts });
  });
  await openGraph(page, { ...snapshot, edges: [] });
  await expect(page.getByRole('button', { name: /^Imports/ })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Graph legend' })).not.toContainText('Lines = imports');
  const drawn = () => page.evaluate(() => [...(window as unknown as { drawnTexts: Set<string> }).drawnTexts]);
  expect(await drawn()).not.toContain('Authentication');
  await page.getByRole('button', { name: /^Islands:/ }).click();
  await expect(page.getByRole('radio', { name: 'On hover' })).toBeChecked();
  await page.getByRole('radio', { name: 'Always, when they fit' }).check();
  await expect.poll(drawn).toContain('Authentication');
  expect(await page.evaluate(() => localStorage.getItem('patchwork.islandNames'))).toBe('always');
  await expect(page.getByText(/Organized by modules · 6 manifest/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
  await page.getByRole('button', { name: /^Islands:/ }).click();
  await expect(page.getByRole('radio', { name: 'Always, when they fit' })).toBeChecked();
  await openGraph(page);
  await expect(page.getByRole('button', { name: /^Imports/ })).toBeVisible();
});

test('a phone keeps the minimap behind a Map toggle and the bar inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openGraph(page);
  await expect(page.getByRole('button', { name: /^Repository minimap/ })).toHaveCount(0);
  const toggle = page.getByRole('button', { name: 'Minimap', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Repository minimap/ })).toBeVisible();
  const bar = (await page.locator('.graph-bottom-bar').boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(0); expect(bar.x + bar.width).toBeLessThanOrEqual(390);
  for (const name of ['Zoom out', 'Zoom in', 'Fit all islands', 'Reset island layout']) {
    const control = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(control.x + control.width).toBeLessThanOrEqual(390);
    expect(control.width).toBeGreaterThanOrEqual(24);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Above the envelope the scope select joins the bar; a long island name must not widen it.
  const large = createScaleFixture(10_000, 40_000, 42);
  large.groups[0] = { ...large.groups[0]!, label: 'ExampleModuleWithAnIntentionallyVeryLongNameForLayoutTests' };
  await openGraph(page, large);
  const select = (await page.getByLabel('Explore scope', { exact: true }).boundingBox())!;
  const largeBar = (await page.locator('.graph-bottom-bar').boundingBox())!;
  expect(select.x + select.width).toBeLessThanOrEqual(largeBar.x + largeBar.width);
  expect(largeBar.x + largeBar.width).toBeLessThanOrEqual(390);
  await expect(page.getByText(/^Showing 10,000 of 10,000 files/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

/** Screen rectangles of every island button, plus the map area between the top band and the bar. */
async function islandGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const canvas = box('[data-testid="graph-canvas"]'), strip = box('.graph-strip'), bar = box('.graph-bottom-bar');
    const islands = [...document.querySelectorAll<HTMLElement>('.island-label')].map(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, changed: Number(/, (\d+) changed/.exec(element.getAttribute('aria-label') ?? '')?.[1] ?? 0) };
    });
    let overlaps = 0;
    islands.forEach((a, i) => islands.slice(i + 1).forEach(b => { if (a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5) overlaps++; }));
    const map = { left: canvas.left, right: canvas.right, top: strip.bottom + 6, bottom: bar.top };
    const inside = islands.filter(rect => rect.left >= map.left - .5 && rect.right <= map.right + .5 && rect.top >= map.top - .5 && rect.bottom <= map.bottom + .5);
    return { islands, overlaps, map, inside: inside.length, changedInside: inside.filter(rect => rect.changed).length };
  });
}
const sharedCamera = (page: Page) => page.evaluate(() => new URLSearchParams(location.search).get('camera'));

test('a camera saved against an older, larger world lands on Fit all and is replaced in the link', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // A camera saved against a much larger world, then a zoomed-in one off the new world.
  for (const old of ['40000,20000,0.025', '45000,22000,0.8']) {
    await page.goto(`/?mode=pr&sources=pr-248,pr-251,pr-256&camera=${old}`);
    await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
    await expect(page.getByLabel('Graph detail', { exact: true })).toContainText('212 / 212 files in view');
    const landed = await camera(page);
    await page.getByRole('button', { name: 'Fit all islands', exact: true }).click();
    const fitted = await camera(page);
    expect(landed.zoom).toBeCloseTo(fitted.zoom, 6); expect(landed.x).toBeCloseTo(fitted.x, 3); expect(landed.y).toBeCloseTo(fitted.y, 3);
    const geometry = await islandGeometry(page);
    expect(geometry.inside).toBe(6);
    await expect.poll(() => sharedCamera(page)).not.toBe(old);
  }
  // A camera that still frames this layout is restored exactly.
  await page.goto('/?mode=pr&sources=pr-248,pr-251,pr-256&camera=700,500,1.5');
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
  await expect.poll(async () => (await camera(page)).zoom).toBe(1.5);
  expect(await camera(page)).toMatchObject({ x: 700, y: 500 });
});

test('an overlay that overflows an island re-packs without overlaps and a camera at Fit follows', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const base = createScaleFixture(10_000, 0, 42);
  const graph: GraphSnapshot = { ...base, id: 'fixture:github:repack', mode: 'github', contextRef: base.contextSha };
  const group = graph.groups[0]!;
  // 600 selection-only files land in one island, far past its rectangle.
  const overlay = Array.from({ length: 600 }, (_, i) => ({ ...graph.nodes[0]!, id: `source-only:${i}`, path: `src/module-1/selection-only-${String(i).padStart(3, '0')}.ts`, groupId: group.id, sourceIds: ['scale-pr-1'], presence: 'source-only' as const }));
  await page.route('**/api/analyze', route => route.fulfill({ json: { snapshot: graph } }));
  await page.route('**/api/sources', route => {
    const ids: string[] = route.request().postDataJSON()?.ids ?? [];
    return route.fulfill({ json: ids.includes('scale-pr-1') ? { ...graph, nodes: [...graph.nodes, ...overlay] } : graph });
  });
  await page.goto('/?repo=example/repository&mode=pr&sources=');
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
  await expect(page.getByTestId('changed-count')).toHaveText('0');
  // The context is a commit: the chip names it once, as its short SHA.
  const chip = page.locator('.context-line');
  await expect(chip).toHaveText(graph.contextSha.slice(0, 7));
  await expect(chip).toHaveAttribute('title', `Context snapshot ${graph.contextSha}`);
  const before = await islandGeometry(page);
  expect(before.inside).toBe(12);
  await page.getByTestId('source-selector').click();
  await page.getByTestId('source-scale-pr-1').click();
  await expect(page.getByTestId('changed-count')).toHaveText('2600');
  await page.keyboard.press('Escape');
  const total = (graph.nodes.length + overlay.length).toLocaleString('en-US');
  await expect(page.getByLabel('Graph detail', { exact: true })).toContainText(`${total} / ${total} files in view`);
  const after = await islandGeometry(page);
  expect(after.overlaps).toBe(0);
  // The camera rested at Fit all, so it follows the re-packed (taller) map: every island stays in view.
  expect(after.inside).toBe(12);
  const followed = await camera(page);
  await page.getByRole('button', { name: 'Fit all islands', exact: true }).click();
  const fitted = await camera(page);
  expect(followed.zoom).toBeCloseTo(fitted.zoom, 6); expect(followed.x).toBeCloseTo(fitted.x, 3); expect(followed.y).toBeCloseTo(fitted.y, 3);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
  test(`a large repository keeps the bottom bar on one row at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openGraph(page, createScaleFixture(10_000, 0, 42));
    const bar = (await page.locator('.graph-bottom-bar').boundingBox())!;
    expect(bar.height).toBeLessThanOrEqual(50);
    const select = page.getByLabel('Explore scope', { exact: true });
    await expect(select).toBeVisible();
    await expect(select).toHaveAttribute('title', 'Showing 10,000 of 10,000 files · 0 of 0 connections. Above the 2,000-file / 8,000-connection target.');
    // The two lines remain for screen readers, and in words in the ? explanation.
    const status = (await page.locator('.graph-scope-status').boundingBox())!;
    expect(status.width).toBeLessThanOrEqual(1);
    await expect(page.locator('.graph-scope-status')).toHaveText('Showing 10,000 of 10,000 files · 0 of 0 connections');
    await page.locator('summary[aria-label="Explain graph symbols and connections"]').click();
    await expect(page.getByRole('region', { name: 'Graph symbols and connections' })).toContainText('This map holds 10,000 files and 0 connections, more than the 2,000 files or 8,000 connections it is tuned for; all of them are drawn.');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fit all islands', exact: true }).click();
    const geometry = await islandGeometry(page);
    expect(geometry.inside).toBe(12);
    // The strip is one row, so Fit leaves the same room above the islands as below them.
    const above = Math.min(...geometry.islands.map(rect => rect.top)) - geometry.map.top;
    const below = geometry.map.bottom - Math.max(...geometry.islands.map(rect => rect.bottom));
    expect(Math.abs(above - below)).toBeLessThanOrEqual(8);
  });
}

for (const viewport of [{ width: 640, height: 360 }, { width: 740, height: 360 }, { width: 900, height: 800 }]) {
  test(`a large repository keeps a one-row bar and a usable map at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openGraph(page, createScaleFixture(10_000, 0, 42));
    await dismissError(page);
    await page.getByTestId('graph-canvas').focus();
    await page.keyboard.press('0');
    const room = await page.evaluate(() => {
      const strip = document.querySelector('.graph-strip')!.getBoundingClientRect(), bar = document.querySelector('.graph-bottom-bar')!.getBoundingClientRect();
      return { bar: bar.height, map: bar.top - strip.bottom - 6 };
    });
    expect(room.bar).toBeLessThanOrEqual(50);
    expect(room.map).toBeGreaterThanOrEqual(viewport.height < 500 ? 60 : 400);
    await expect(page.getByLabel('Explore scope', { exact: true })).toBeVisible();
    await expect(page.locator('summary[aria-label="Explain graph symbols and connections"]')).toBeVisible();
    // The scope line stays for screen readers.
    await expect(page.locator('.graph-scope-status')).toHaveText('Showing 10,000 of 10,000 files · 0 of 0 connections');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('the top band backs the strip so the map never shows between its chips', async ({ page }) => {
  await openGraph(page);
  await page.getByTestId('graph-canvas').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('+');
  // Zoomed in, the map runs under the strip. A point between two chips hits the band, not the canvas,
  // and so does the top of the map beside and below the source bar and search.
  const probe = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const strip = box('.graph-strip'), controls = box('.graph-view-controls'), sources = box('.source-bar'), search = box('.graph-search'), workspace = box('[data-testid="graph-viewport"]');
    const band = getComputedStyle(document.querySelector('.graph-strip')!, '::before');
    const at = (x: number, y: number) => document.elementFromPoint(x, y);
    const between = (sources.right + search.left) / 2;
    return {
      hit: at(controls.left - 24, strip.top + strip.height / 2)?.className, background: band.backgroundColor, content: band.content,
      top: at(between, workspace.top + 4)?.className, beside: at(between, sources.top + sources.height / 2)?.className, below: at(sources.left + 40, (sources.bottom + strip.top) / 2)?.className,
      sourceBarOnTop: !!at(sources.left + sources.width / 2, sources.top + sources.height / 2)?.closest('.source-bar'), searchOnTop: !!at(search.left + search.width / 2, search.top + search.height / 2)?.closest('.graph-search'),
    };
  });
  expect(probe.content).not.toBe('none');
  expect(probe.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(probe.hit).toBe('graph-strip');
  expect([probe.top, probe.beside, probe.below]).toEqual(['graph-strip', 'graph-strip', 'graph-strip']);
  expect(probe.sourceBarOnTop).toBe(true); expect(probe.searchOnTop).toBe(true);
  // On a phone rows 1 and 2 are one opaque band from the top edge. The new size applies to layout a
  // frame or more after setViewportSize (WebKit), so measure until it has.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(async () => {
    const phone = await page.evaluate(() => {
      const sources = document.querySelector('.source-bar')!.getBoundingClientRect(), search = document.querySelector('.graph-search')!.getBoundingClientRect();
      const workspace = document.querySelector('[data-testid="graph-viewport"]')!.getBoundingClientRect();
      const at = (x: number, y: number) => document.elementFromPoint(x, y);
      return {
        gap: at(200, (sources.bottom + search.top) / 2)?.className,
        edge: at(4, workspace.top + 4)?.className,
        sourceBarOnTop: !!at(sources.left + sources.width / 2, sources.top + sources.height / 2)?.closest('.source-bar'),
        band: getComputedStyle(document.querySelector('.graph-strip')!, '::before').backgroundColor,
      };
    });
    expect(phone.gap).toBe('graph-strip'); expect(phone.edge).toBe('graph-strip');
    expect(phone.sourceBarOnTop).toBe(true);
    expect(phone.band).toBe('rgb(12, 16, 19)');
  }).toPass();
});

test('the open Islands menu stays above file details, and the source bar above the band', async ({ page }) => {
  await openGraph(page);
  await page.getByTestId('file-search').fill('refresh.ts');
  await page.getByRole('option', { name: /refresh\.ts/ }).click();
  await expect(page.getByTestId('file-inspector')).toBeVisible();
  await page.getByRole('button', { name: /^Islands:/ }).click();
  await expect(page.getByRole('button', { name: 'Review grouping' })).toBeVisible();
  // WebKit restacks a frame after the menu opens, so measure until it has.
  await expect(async () => {
    const covered = await page.evaluate(() => {
      const items = [...document.querySelectorAll<HTMLElement>('.group-level-menu button, .group-level-menu label')];
      const hidden = items.filter(item => { const rect = item.getBoundingClientRect(); return !document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.group-level-menu'); });
      const sources = document.querySelector('.source-bar')!.getBoundingClientRect();
      return { items: items.length, hidden: hidden.map(item => item.textContent), sourceBarOnTop: !!document.elementFromPoint(sources.left + sources.width / 2, sources.top + sources.height / 2)?.closest('.source-bar') };
    });
    expect(covered.items).toBeGreaterThanOrEqual(6);
    expect(covered.hidden).toEqual([]);
    expect(covered.sourceBarOnTop).toBe(true);
  }).toPass();
  await page.getByRole('radio', { name: 'Always, when they fit' }).check();
  await expect(page.getByRole('radio', { name: 'Always, when they fit' })).toBeChecked();
});

test('a click a little past the pointer island tooltip still reaches the island under it', async ({ page }) => {
  await openGraph(page);
  const hover = await islandPoint(page, 'Authentication');
  await page.mouse.move(hover.x, hover.y);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveAttribute('data-kind', 'island');
  // About 40 px down-right, inside the island and under the tooltip, at the point farthest from any file.
  const island = layout.islands.find(group => group.label === 'Authentication')!;
  const box = (await page.getByTestId('graph-canvas').boundingBox())!, current = await camera(page);
  const files = island.nodes.map(node => worldToScreen(node, current, box.width, box.height)).map(point => ({ x: box.x + point.x, y: box.y + point.y }));
  let target = { x: hover.x + 40, y: hover.y + 40 }, room = 0;
  for (let dx = 24; dx <= 56; dx += 2) for (let dy = 24; dy <= 56; dy += 2) {
    const point = { x: hover.x + dx, y: hover.y + dy }, nearest = Math.min(...files.map(file => Math.hypot(file.x - point.x, file.y - point.y)));
    if (nearest > room) { room = nearest; target = point; }
  }
  const tip = (await tooltip.boundingBox())!;
  expect(target.x > tip.x && target.x < tip.x + tip.width && target.y > tip.y && target.y < tip.y + tip.height).toBe(true);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), target)).toBe('graph-canvas');
  await page.mouse.move(target.x, target.y);
  await expect(tooltip).toContainText('Authentication');
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('.focus-breadcrumb strong')).toHaveText('Authentication');
  await expect(page.getByTestId('file-inspector')).toHaveCount(0);
});

test('a hover island tooltip does not use up the Escape meant for search or the explanation', async ({ page }) => {
  await openGraph(page);
  const auth = await islandPoint(page, 'Authentication');
  await page.mouse.move(auth.x, auth.y);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveAttribute('data-kind', 'island');
  await page.keyboard.press('/');
  const search = page.getByTestId('file-search');
  await expect(search).toBeFocused();
  await page.keyboard.type('auth');
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(tooltip).toBeHidden();
  // The ? explanation, opened from the keyboard while the pointer rests on an island (a dismissed
  // island stays quiet until the pointer moves to another one).
  const billing = await islandPoint(page, 'Billing');
  await page.mouse.move(billing.x, billing.y);
  await expect(tooltip).toHaveAttribute('data-kind', 'island');
  const toggle = page.locator('summary[aria-label="Explain graph symbols and connections"]');
  await toggle.focus();
  await page.keyboard.press('Enter');
  const explanation = page.getByRole('region', { name: 'Graph symbols and connections' });
  await expect(explanation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(explanation).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('one zoom step past the file threshold, an island padding band still names the island', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const graph = createScaleFixture(10_000, 0, 42), scaled = layoutGraph(graph), pitch = scaled.islands[0]!.grid!.pitch;
  await openGraph(page, graph);
  await dismissError(page);
  await page.getByTestId('graph-canvas').focus();
  await page.keyboard.press('0');
  while ((await camera(page)).zoom * pitch < 10) await page.keyboard.press('+');
  const current = await camera(page);
  expect(current.zoom * pitch).toBeLessThan(16);
  const box = (await page.getByTestId('graph-canvas').boundingBox())!;
  const area = await page.evaluate(() => ({ top: document.querySelector('.graph-strip')!.getBoundingClientRect().bottom + 30, bottom: document.querySelector('.graph-bottom-bar')!.getBoundingClientRect().top - 30 }));
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // 3 px inside the left edge of the visible island nearest the centre: the padding band before the first file column.
  const [choice] = scaled.islands
    .map(island => { const edge = worldToScreen({ x: island.x - island.rx, y: island.y }, current, box.width, box.height); return { island, band: { x: box.x + edge.x + 3, y: box.y + edge.y } }; })
    .filter(({ band }) => band.x > box.x + 40 && band.x < box.x + box.width - 420 && band.y > area.top && band.y < area.bottom)
    .sort((a, b) => Math.hypot(a.band.x - centre.x, a.band.y - centre.y) - Math.hypot(b.band.x - centre.x, b.band.y - centre.y));
  expect(choice).toBeDefined();
  await page.mouse.move(choice!.band.x, choice!.band.y);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveAttribute('data-kind', 'island');
  await expect(tooltip).toContainText(choice!.island.label);
  // A file centre is still a file.
  const file = worldToScreen(choice!.island.nodes[0]!, current, box.width, box.height);
  await page.mouse.move(box.x + file.x, box.y + file.y);
  await expect(tooltip).toHaveAttribute('data-kind', 'file');
});

test('overlap rings leave a dense overview and return once files are apart', async ({ page }) => {
  await page.addInitScript(() => {
    // Arc calls of the most recent scene build, per canvas (file circles and rings are the only arcs).
    const logs = new Map<HTMLCanvasElement, number[][]>();
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function(...args) { logs.set(this.canvas as HTMLCanvasElement, []); return clear.apply(this, args); };
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function(...args) { logs.get(this.canvas as HTMLCanvasElement)?.push(args.slice(0, 3) as number[]); return arc.apply(this, args); };
    Object.assign(window, { ringedCentres: () => {
      const build = [...logs.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const seen = new Map<string, number>();
      for (const [x, y] of build) seen.set(`${x}:${y}`, (seen.get(`${x}:${y}`) ?? 0) + 1);
      return { circles: seen.size, ringed: [...seen.values()].filter(count => count > 1).length };
    } });
  });
  await openGraph(page, createScaleFixture(10_000, 0, 42));
  await expect(page.getByTestId('overlap-count')).not.toHaveText('0');
  const rings = () => page.evaluate(() => (window as unknown as { ringedCentres: () => { circles: number; ringed: number } }).ringedCentres());
  const pitch = async () => (await camera(page)).zoom * layoutGraph(createScaleFixture(10_000, 0, 42)).islands[0]!.grid!.pitch;
  expect(await pitch()).toBeLessThan(8);
  await expect.poll(async () => (await rings()).circles).toBe(10_000);
  expect((await rings()).ringed).toBe(0);
  await page.getByTestId('graph-canvas').focus();
  while (await pitch() < 10) await page.keyboard.press('+');
  await expect.poll(async () => (await rings()).ringed).toBeGreaterThan(0);
});

test('the minimap frame is drawn inside the map at Fit', async ({ page }) => {
  await openGraph(page, createScaleFixture(10_000, 0, 42));
  await page.getByRole('button', { name: 'Fit all islands', exact: true }).click();
  const frame = await page.evaluate(() => {
    const svg = document.querySelector('.graph-minimap svg')!, rect = svg.querySelector('.graph-minimap-viewport')!;
    const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const get = (name: string) => Number(rect.getAttribute(name));
    return { inside: get('x') > x && get('y') > y && get('x') + get('width') < x + width && get('y') + get('height') < y + height, width: get('width'), worldWidth: width };
  });
  expect(frame.inside).toBe(true);
  expect(frame.width).toBeGreaterThan(frame.worldWidth * .9);
});

test('a phone lands on whole changed islands inside the map area', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openGraph(page, createScaleFixture(10_000, 0, 42));
  const landed = await camera(page);
  const geometry = await islandGeometry(page);
  expect(geometry.changedInside).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Fit all islands', exact: true }).click();
  expect((await camera(page)).zoom).toBeLessThan(landed.zoom);
});
