import { expect, test } from '@playwright/test';
import { createDemoSnapshot } from '@patchwork/fixtures';

test('an explicitly empty shared selection stays empty on reload and mode changes preserve it', async ({ page }) => {
  await page.goto('/?mode=pr&sources=');
  await expect(page.getByTestId('changed-count')).toHaveText('0');
  await expect(page.getByText('Your repository, at a glance')).toBeVisible();
  await page.getByTestId('source-selector').click();
  await page.getByTestId('source-mode-commit').click();
  await expect(page.getByTestId('changed-count')).toHaveText('24');
  await page.getByTestId('source-mode-pr').click();
  await expect(page.getByTestId('changed-count')).toHaveText('0');
  await page.reload();
  await expect(page.getByTestId('changed-count')).toHaveText('0');
});

test('a missing shared source is actionable rather than silently replaced by default PRs', async ({ page }) => {
  await page.goto('/?mode=pr&sources=pr-does-not-exist');
  await expect(page.getByRole('alert')).toContainText('saved sample changes no longer exist');
  await expect(page.getByTestId('changed-count')).toHaveText('—');
  await page.getByTestId('source-selector').click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.getByTestId('changed-count')).toHaveText('0');
});

test('shared GitHub selections restore source IDs beyond the first discovery page', async ({ page }) => {
  const snapshot = { ...createDemoSnapshot(), id: 'fixture:github:shared', mode: 'github' as const };
  const savedSource = { ...snapshot.sources[0], id: 'pr:older' };
  const requests: number[] = [];
  await page.route('**/api/analyze', route => route.fulfill({ json: { snapshot } }));
  await page.route('**/api/sources?**', route => {
    const number = Number(new URL(route.request().url()).searchParams.get('page'));
    requests.push(number);
    return route.fulfill({ json: { sources: number === 2 ? [savedSource] : [], nextPage: number === 1 ? 2 : null } });
  });
  let selected: string[] = [];
  await page.route('**/api/sources', async route => {
    selected = route.request().postDataJSON().ids;
    return route.fulfill({ json: { ...snapshot, sources: [...snapshot.sources, savedSource], nodes: snapshot.nodes.map(node => ({ ...node, sourceIds: node.sourceIds.includes(snapshot.sources[0].id) ? [savedSource.id] : [] })) } });
  });
  await page.goto('/?repo=example/repository&mode=pr&sources=pr%3Aolder');
  await expect.poll(() => selected).toEqual(['pr:older']);
  await expect(page.getByTestId('changed-count')).toHaveText(String(savedSource.files.length));
  expect(requests).toEqual([1, 2]);
  await expect(page).toHaveURL(/context=/);
});

test('a shared source-only file opens after the footprint brings it into the snapshot', async ({ page }) => {
  const snapshot = { ...createDemoSnapshot(), id: 'fixture:github:ghost', mode: 'github' as const };
  const ghost = { ...snapshot.nodes[0], id: 'source-only:shared-file', path: 'src/only-on-pr.ts', presence: 'source-only' as const };
  await page.route('**/api/analyze', route => route.fulfill({ json: { snapshot } }));
  await page.route('**/api/sources', route => route.fulfill({ json: { ...snapshot, nodes: [...snapshot.nodes, ghost] } }));
  await page.goto('/?repo=example/repository&sources=pr-248&file=source-only%3Ashared-file');
  await expect(page.getByTestId('file-inspector')).toContainText('src/only-on-pr.ts');
  await expect(page).toHaveURL(/file=source-only%3Ashared-file/);
});

test('rapid source requests cancel obsolete work and preserve the latest footprint', async ({ page }) => {
  const snapshot = { ...createDemoSnapshot(), id: 'fixture:github:latest', mode: 'github' as const };
  await page.route('**/api/analyze', route => route.fulfill({ json: { snapshot } }));
  await page.route('**/api/sources?**', route => route.fulfill({ json: { sources: snapshot.sources, nextPage: null } }));
  await page.route('**/api/sources', async route => {
    const ids: string[] = route.request().postDataJSON().ids;
    if (ids.length === 2) await new Promise(resolve => setTimeout(resolve, 500));
    try { await route.fulfill({ json: snapshot }); } catch { /* obsolete request was aborted */ }
  });
  await page.goto('/?repo=example/repository');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await page.getByTestId('source-selector').click();
  await page.getByTestId('source-pr-256').click();
  await expect(page.getByTestId('changed-count')).toHaveText('—');
  await page.getByTestId('source-pr-251').click();
  await expect(page.getByTestId('changed-count')).toHaveText('28');
  await page.waitForTimeout(600);
  await expect(page.getByTestId('changed-count')).toHaveText('28');
});

test('rate-limited footprints remain unavailable until an explicit successful retry', async ({ page }) => {
  const snapshot = { ...createDemoSnapshot(), id: 'fixture:github:retry', mode: 'github' as const };
  await page.route('**/api/analyze', route => route.fulfill({ json: { snapshot } }));
  await page.route('**/api/sources?**', route => route.fulfill({ json: { sources: snapshot.sources, nextPage: null } }));
  let limited = true;
  await page.route('**/api/sources', async route => {
    const ids: string[] = route.request().postDataJSON().ids;
    if (ids.length === 2 && limited) return route.fulfill({ status: 429, json: { error: 'GitHub rate limit exhausted. Retry after the quota resets.' } });
    return route.fulfill({ json: snapshot });
  });
  await page.goto('/?repo=example/repository');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await page.getByTestId('source-selector').click();
  await page.getByTestId('source-pr-256').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('rate limit exhausted');
  await expect(page.getByTestId('changed-count')).toHaveText('—');
  await page.keyboard.press('Escape');
  limited = false;
  await page.getByRole('button', { name: 'Retry selection', exact: true }).click();
  await expect(page.getByTestId('changed-count')).toHaveText('57');
});

test('canceling an in-flight selection restores the confirmed footprint', async ({ page }) => {
  const snapshot = { ...createDemoSnapshot(), id: 'fixture:github:cancel', mode: 'github' as const };
  await page.route('**/api/analyze', route => route.fulfill({ json: { snapshot } }));
  await page.route('**/api/sources?**', route => route.fulfill({ json: { sources: snapshot.sources, nextPage: null } }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sources', async route => {
    if (route.request().postDataJSON().ids.length === 2) await pending;
    try { await route.fulfill({ json: snapshot }); } catch { /* canceled request */ }
  });
  try {
    await page.goto('/?repo=example/repository');
    await expect(page.getByTestId('changed-count')).toHaveText('68');
    await page.getByTestId('source-selector').click();
    await page.getByTestId('source-pr-256').click();
    await expect(page.getByTestId('changed-count')).toHaveText('—');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByTestId('changed-count')).toHaveText('68');
    await expect(page.getByText('Analysis canceled. Your current map is preserved.')).toBeVisible();
  } finally { release(); }
});

