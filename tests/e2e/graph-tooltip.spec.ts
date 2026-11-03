import { expect, test, type Page } from '@playwright/test';
import { createDemoSnapshot } from '../../packages/fixtures/src/index';
import { layoutGraph, worldToScreen } from '../../packages/graph-core/src/index';

const snapshot = createDemoSnapshot();
const layout = layoutGraph(snapshot, { seed: 0 });

async function openGraph(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/demo', route => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await expect.poll(async () => Number(await page.getByTestId('graph-canvas').getAttribute('data-visible-file-count'))).toBe(212);
}

async function camera(page: Page) {
  const canvas = page.getByTestId('graph-canvas');
  return { x: Number(await canvas.getAttribute('data-camera-x')), y: Number(await canvas.getAttribute('data-camera-y')), zoom: Number(await canvas.getAttribute('data-camera-scale')) };
}

/** Use the same pure layout and actual camera; reject DOM-overlay-covered points. */
async function visibleFilePoint(page: Page, excludePath?: string) {
  const canvas = page.getByTestId('graph-canvas'), box = (await canvas.boundingBox())!, current = await camera(page);
  const candidates = layout.nodes.filter(node => node.path !== excludePath).map(node => {
    const point = worldToScreen(node, current, box.width, box.height);
    return { id: node.id, path: node.path, x: box.x + point.x, y: box.y + point.y };
  }).filter(point => point.x > box.x + 30 && point.x < box.x + box.width - 300 && point.y > box.y + 220 && point.y < box.y + box.height - 180);
  const point = await canvas.evaluate((element, points) => points.find(point => document.elementFromPoint(point.x, point.y) === element), candidates);
  expect(point, 'a rendered file circle must be reachable without crossing an application overlay').toBeTruthy();
  return point!;
}

test('circle tooltip is hoverable, persistent and dismissible without moving keyboard focus', async ({ page }) => {
  await openGraph(page);
  const search = page.getByTestId('file-search'); await search.focus();
  const beforeCamera = await camera(page), point = await visibleFilePoint(page);
  await page.mouse.move(point.x, point.y);
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText(point.path);
  await expect(search).toBeFocused();
  const box = (await tooltip.boundingBox())!;
  // Cross the actual gap into content in several pointer steps. Its anchor
  // stays fixed while the pointer leaves the circle's hit radius.
  await page.mouse.move(box.x + 8, Math.max(box.y + 8, Math.min(point.y, box.y + box.height - 8)), { steps: 6 });
  await page.waitForTimeout(650); // Exceeds the bounded 220ms leave bridge.
  await expect(tooltip).toContainText(point.path);
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection-cue', 'none');
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(search).toBeFocused();
  expect(await camera(page)).toEqual(beforeCamera);
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await expect(page.getByTestId('overlap-count')).toHaveText('14');
  // Escape suppression survives another move over the same circle; leaving
  // its trigger permits a later deliberate hover and normal leave dismissal.
  await page.mouse.move(point.x, point.y);
  await expect(tooltip).toBeHidden();
  const header = (await page.getByRole('link', { name: 'Patchwork home' }).boundingBox())!;
  await page.mouse.move(header.x + 5, header.y + 5);
  await page.mouse.move(point.x, point.y);
  await expect(tooltip).toContainText(point.path);
  await page.mouse.move(header.x + 5, header.y + 5);
  await expect(tooltip).toBeHidden();
});

test('Escape dismisses hover before file details and preserves exact selected sources', async ({ page }) => {
  await openGraph(page);
  const search = page.getByTestId('file-search');
  await search.fill('refresh.ts');
  await page.getByRole('option', { name: /refresh\.ts/ }).first().click();
  const inspector = page.getByTestId('file-inspector'); await expect(inspector).toBeVisible();
  // Opening details intentionally transfers focus on the next animation frame.
  // Visibility alone does not mean that transfer finished (notably WebKit on
  // a loaded CI host). Deliberately move away only after its focus contract.
  await expect(page.getByRole('button', { name: 'Close file inspector', exact: true })).toBeFocused();
  await search.focus();
  await expect(search).toBeFocused();
  const beforeCamera = await camera(page), before = new URL(page.url());
  const point = await visibleFilePoint(page, 'src/auth/session/refresh.ts');
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toContainText(point.path);
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();
  await expect(inspector).toBeVisible();
  await expect(search).toBeFocused();
  const after = new URL(page.url());
  expect(after.searchParams.get('file')).toBe(before.searchParams.get('file'));
  expect(after.searchParams.get('sources')).toBe(before.searchParams.get('sources'));
  expect(await camera(page)).toEqual(beforeCamera);
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await expect(page.getByTestId('overlap-count')).toHaveText('14');
  // Opening a native modal by keyboard can leave the pointer over its former
  // trigger. Hover behind the inert backdrop must not consume modal Escape.
  const home = (await page.getByRole('link', { name: 'Patchwork home' }).boundingBox())!;
  await page.mouse.move(home.x + 5, home.y + 5); await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.getByTestId('source-selector').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Choose your changes' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await expect(inspector).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector).toBeHidden();
});
