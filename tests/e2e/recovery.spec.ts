import { expect, test, type Page } from '@playwright/test';
import { createDemoSnapshot } from '../../packages/fixtures/src/index';

test.beforeAll(async ({ browser, browserName }) => {
  console.log(`DEL04_BROWSER ${browserName} ${browser.version()} on ${process.platform}/${process.arch}`);
});

/** Browser-only controlled evidence. No GitHub, provider, or account traffic is needed. */
function repositoryFixture() {
  const snapshot = createDemoSnapshot();
  snapshot.id = 'controlled-public-repository';
  snapshot.mode = 'github';
  snapshot.repository = { ...snapshot.repository, owner: 'example', name: 'controlled-repository', fullName: 'example/controlled-repository', htmlUrl: 'https://github.com/example/controlled-repository' };
  snapshot.sources = snapshot.sources.map(source => ({ ...source, url: source.kind === 'pr' ? `${snapshot.repository.htmlUrl}/pull/${source.number}` : `${snapshot.repository.htmlUrl}/commit/${source.headSha}` }));
  snapshot.coverage = { status: 'partial', reasons: ['Controlled fixture: one unsupported language was not parsed.'], filesAnalyzed: 211, totalFiles: 212 };
  return snapshot;
}

async function demo(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
}

async function chooseRepository(page: Page) {
  await page.getByRole('button', { name: 'Choose repository', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a repository', exact: true });
  await dialog.getByLabel('Repository', { exact: true }).fill('example/controlled-repository');
  await dialog.getByRole('button', { name: 'Map repository', exact: true }).click();
  return dialog;
}

test('controlled repository loading, partial coverage and file diff remain reviewable', async ({ page }, testInfo) => {
  const snapshot = repositoryFixture();
  let polls = 0;
  await page.route('**/api/analyze', route => route.fulfill({ status: 202, json: { jobId: 'controlled-partial' } }));
  await page.route('**/api/jobs/controlled-partial', route => route.fulfill({ json: ++polls === 1
    ? { status: 'indexing', progress: 60, message: 'Reading controlled imports' }
    : { status: 'partial', progress: 100, snapshot } }));
  await page.route('**/api/sources*', route => route.fulfill({ json: route.request().method() === 'POST' ? snapshot : { sources: snapshot.sources, nextPage: null } }));
  await demo(page);
  await chooseRepository(page);
  await expect(page.getByText('Reading controlled imports', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Partial analysis' })).toBeVisible();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await expect(page.getByTestId('overlap-count')).toHaveText('14');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(snapshot.coverage.reasons[0]);
  await page.keyboard.press('Escape');
  await page.getByTestId('file-search').fill('refresh.ts');
  await page.getByRole('option', { name: /refresh\.ts/ }).first().click();
  const inspector = page.getByTestId('file-inspector');
  await expect(inspector).toContainText('src/auth/session/refresh.ts');
  const diff = inspector.getByRole('link', { name: /Open GitHub diff/ }).first();
  await expect(diff).toHaveAttribute('href', /https:\/\/github\.com\/example\/controlled-repository\/(pull|compare)\//);
  await testInfo.attach('controlled-partial-review', { body: await page.screenshot(), contentType: 'image/png' });
});

for (const scenario of [
  { name: 'rate limited', status: 429, code: 'RATE_LIMITED', error: 'GitHub quota exhausted. Retry after 60 seconds.' },
  { name: 'access revoked', status: 403, code: 'ACCESS_REVOKED', error: 'Repository access was revoked. Reconnect your account.' },
  { name: 'stale context', status: 409, code: 'STALE_SOURCE', error: 'The selected source changed. Refresh its pinned comparison.' },
]) {
  test(`${scenario.name} preserves map and allows a successful retry`, async ({ page }) => {
    let attempts = 0;
    const snapshot = repositoryFixture();
    await page.route('**/api/analyze', route => route.fulfill(++attempts === 1
      ? { status: scenario.status, json: { error: scenario.error, code: scenario.code, retryAfter: 60 } }
      : { json: { snapshot } }));
    await page.route('**/api/sources*', route => route.fulfill({ json: route.request().method() === 'POST' ? snapshot : { sources: snapshot.sources, nextPage: null } }));
    await demo(page);
    const dialog = await chooseRepository(page);
    await expect(dialog.getByRole('alert')).toContainText(scenario.error);
    await expect(page.getByTestId('changed-count')).toHaveText('68');
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Map repository', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Map repository', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Partial analysis' })).toBeVisible();
    expect(attempts).toBe(2);
  });
}

test('canceling an in-flight analysis preserves selection and ignores its late result', async ({ page }) => {
  let cancelRequests = 0;
  let release!: () => void;
  let completed!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/api/analyze', route => route.fulfill({ status: 202, json: { jobId: 'controlled-cancel' } }));
  await page.route('**/api/jobs/controlled-cancel/cancel', route => { cancelRequests++; return route.fulfill({ json: { status: 'cancelled' } }); });
  await page.route('**/api/jobs/controlled-cancel', async route => {
    await delayed;
    try { await route.fulfill({ json: { status: 'ready', snapshot: repositoryFixture() } }); }
    catch { /* The browser may have aborted the request, which is the desired outcome. */ }
    finally { completed(); }
  });
  try {
    await demo(page);
    const requested = page.waitForRequest('**/api/jobs/controlled-cancel');
    const dialog = await chooseRepository(page);
    await requested;
    await dialog.getByRole('button', { name: 'Cancel analysis', exact: true }).click();
    await expect(page.getByText('Analysis canceled. Your current map is preserved.', { exact: true })).toBeVisible();
    await expect.poll(() => cancelRequests).toBe(1);
    release();
    await finished;
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('changed-count')).toHaveText('68');
    await expect(page.getByText('synthetic data', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Partial analysis' })).toBeHidden();
  } finally { release(); }
});

test('empty selection, keyboard search and island/minimap navigation recover to overview', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await demo(page);
  await page.getByTestId('source-selector').click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.getByTestId('changed-count')).toHaveText('0');
  await expect(page.getByTestId('overlap-count')).toHaveText('0');
  await page.getByTestId('source-pr-248').click();
  await page.getByTestId('source-pr-251').click();
  await page.getByTestId('source-pr-256').click();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Explore Authentication island/ }).click();
  await expect(page.getByRole('button', { name: 'All islands', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All islands', exact: true }).click();
  await page.getByRole('button', { name: 'Fit all islands', exact: true }).click();
  const canvas = page.getByTestId('graph-canvas');
  const x = await canvas.getAttribute('data-camera-x');
  const minimap = page.getByRole('button', { name: /Repository minimap/ });
  await minimap.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => canvas.getAttribute('data-camera-x')).not.toBe(x);
  await expect(minimap).toBeFocused();
  await page.keyboard.press('/');
  await expect(page.getByTestId('file-search')).toBeFocused();
  await page.keyboard.type('refresh.ts');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('file-inspector')).toContainText('refresh.ts');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('file-inspector')).toBeHidden();
  await expect(page.getByTestId('file-search')).toBeFocused();
});
