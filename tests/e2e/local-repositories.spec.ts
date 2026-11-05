import { expect, test } from '@playwright/test';
import { createDemoSnapshot } from '../../packages/fixtures/src/index';
import type { GraphSnapshot } from '../../packages/contracts/src/index';

// The local-repository picker with a synthetic registry: /api/config advertises one local mirror
// and /api/analyze returns a local-git snapshot. No server-side registry is involved.
const demo = createDemoSnapshot();
const local: GraphSnapshot = {
  ...demo, id: 'snapshot:local-orbit-notes', mode: 'local-git', contextRef: 'main',
  repository: { owner: 'local', name: 'orbit-notes', fullName: 'local/orbit-notes', defaultBranch: 'main', htmlUrl: 'local-git://local/orbit-notes', label: 'Orbit Notes' } as GraphSnapshot['repository'],
  sources: demo.sources.map(source => source.id === 'pr-259' ? { ...source, comparisonKind: 'recorded', recordedOrigin: 'review notes', url: 'local-git://local/orbit-notes/pull/259' } : { ...source, url: `local-git://local/orbit-notes/${source.kind === 'pr' ? 'pull' : 'commit'}/${source.label.replace('#', '')}` }),
  ...({ sourceViews: [{ id: 'sync-review', title: 'Sync review', description: 'Changes to the sync engine', kind: 'pr', sourceIds: ['pr-251', 'pr-259'], omitted: 0 }] } as object),
};

test('a registered local repository opens from the dialog and its prepared view selects its changes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/config', async route => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({ response, json: { ...config, github: { ...config.github, publicRepositories: false }, local: { enabled: true, only: true, repositories: [{ fullName: 'local/orbit-notes', label: 'Orbit Notes', defaultRef: 'main' }] } } });
  });
  const analyzed: unknown[] = [], selections: { snapshotId: string; kind: string; ids: string[] }[] = [];
  await page.route('**/api/analyze', async route => { analyzed.push(route.request().postDataJSON()); await route.fulfill({ json: { snapshot: local } }); });
  await page.route('**/api/sources**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sources: [], nextPage: null } });
    const body = route.request().postDataJSON() as { snapshotId: string; kind: string; ids: string[] };
    selections.push(body);
    return route.fulfill({ json: local });
  });
  await page.goto('/');
  await expect(page.getByTestId('mode-badge')).toHaveText('Demo workspace');

  await page.getByRole('button', { name: 'Choose repository' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Everything is read from local Git mirrors; nothing is sent over the network.');
  const section = dialog.getByRole('region', { name: 'Local repositories' });
  await expect(section).toContainText('LOCAL REPOSITORIES');
  const card = page.getByTestId('local-repo-local/orbit-notes');
  await expect(card).toContainText('Orbit Notes');
  await expect(card).toContainText('local/orbit-notes · main · local mirror');
  await expect(dialog).toContainText('GitHub access is turned off on this server (local repositories only).');
  await card.click();

  // The card asks for the registered id at its default ref, never a path.
  await expect.poll(() => analyzed).toEqual([{ repository: 'local/orbit-notes', contextRef: 'main', mode: 'pr' }]);
  await expect(page.getByTestId('mode-badge')).toHaveText('Local repository');
  await expect(page.getByRole('button', { name: 'Choose repository' })).toContainText('local / orbit-notes');
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');

  // A prepared view selects exactly its sources, through the server.
  await page.getByTestId('source-selector').click();
  await expect(page.getByTestId('source-views')).toContainText('Prepared views');
  const view = page.getByTestId('source-view-sync-review');
  await expect(view).toHaveText('Sync review (2)');
  await expect(view).toHaveAttribute('title', 'Changes to the sync engine');
  await expect(page.getByRole('dialog')).toContainText('Recorded footprint');
  const before = selections.length;
  await view.click();
  await expect.poll(() => selections.length).toBeGreaterThan(before);
  expect(selections.at(-1)).toEqual({ snapshotId: local.id, kind: 'pr', ids: ['pr-251', 'pr-259'] });
  await page.keyboard.press('Escape');

  // The repository dialog offers the way back to the demo.
  await page.getByRole('button', { name: 'Choose repository' }).click();
  await page.getByRole('button', { name: 'Return to demo' }).click();
  await expect(page.getByTestId('mode-badge')).toHaveText('Demo workspace');
});
