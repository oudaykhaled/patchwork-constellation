import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { demoSnapshot } from '../../packages/fixtures/src/index';
import type { GraphSnapshot } from '../../packages/contracts/src/index';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const fixture: GraphSnapshot = {
  ...demoSnapshot, id: 'inspector-fixture', mode: 'github', contextSha: head,
  repository: { owner: 'example', name: 'review', fullName: 'example/review', defaultBranch: 'main', htmlUrl: 'https://github.com/example/review' },
  groups: [{ id: 'alpha', label: 'Alpha module', origin: 'rules' }, { id: 'beta', label: 'Beta module', origin: 'rules' }],
  nodes: [
    { id: 'a', path: 'alpha/index.ts', groupId: 'alpha', sourceIds: ['pr:1'], status: 'renamed', importCoverage: 'complete' },
    { id: 'b', path: 'beta/index.ts', groupId: 'beta', sourceIds: ['pr:1'], importCoverage: 'complete' },
    { id: 'c', path: 'assets/removed.png', groupId: 'beta', sourceIds: ['pr:1'], status: 'binary', presence: 'deleted', importCoverage: 'unsupported' },
    { id: 'd', path: 'services/task.py', groupId: 'beta', sourceIds: [], importCoverage: 'unsupported' },
  ],
  edges: [{ id: 'a-b', source: 'a', target: 'b', kind: 'type-import', evidence: { path: 'alpha/index.ts', line: 3, specifier: '../beta', resolver: 'typescript-ast', snapshotSha: head } }],
  sources: [{ id: 'pr:1', kind: 'pr', number: 1, title: 'Pinned rename and asset deletion', label: '#1', baseSha: base, headSha: head, comparisonKind: 'merge-base', url: 'https://github.com/example/review/pull/1', files: [
    { fileId: 'a', path: 'alpha/index.ts', previousPath: 'alpha/old.ts', status: 'renamed', additions: 4, deletions: 2 },
    { fileId: 'b', path: 'beta/index.ts', status: 'modified', additions: 2, deletions: 1 },
    { fileId: 'c', path: 'assets/removed.png', status: 'removed', additions: 0, deletions: 0 },
  ] }],
  coverage: { status: 'partial', reasons: ['Stale snapshot: newer analysis available.', 'Python and binary imports unsupported.'] },
};
async function openFixture(page: Page, snapshot = fixture) {
  await page.route('**/api/demo', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/sources', route => route.fulfill({ json: { snapshot } }));
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('3');
}
async function inspect(page: Page, query: string, result: string | RegExp) {
  await page.getByTestId('file-search').fill(query);
  await page.getByRole('option', { name: result }).click();
  return page.getByTestId('file-inspector');
}
test('duplicate basenames retain path/group context and show pinned per-file diff evidence', async ({ page }) => {
  await openFixture(page);
  await page.getByTestId('file-search').fill('index.ts');
  await expect(page.getByRole('option')).toHaveCount(2);
  await expect(page.getByRole('option').first()).toContainText('Alpha module');
  await page.getByRole('option', { name: /alpha\/index.ts/ }).click();
  const inspector = page.getByTestId('file-inspector');
  await expect(inspector).toContainText('renamed from alpha/old.ts');
  await expect(inspector).toContainText('+4');
  await expect(inspector).toContainText('Stale snapshot');
  const anchor = createHash('sha256').update('alpha/index.ts').digest('hex');
  await expect(inspector.getByRole('link', { name: 'Open #1 file diff' })).toHaveAttribute('href', `https://github.com/example/review/compare/${base}..${head}#diff-${anchor}`);
  await inspector.getByText('Connection evidence', { exact: true }).click();
  await expect(inspector.getByRole('link', { name: /typescript-ast/ })).toHaveAttribute('href', `https://github.com/example/review/blob/${head}/alpha/index.ts#L3`);
  await expect(inspector).toContainText('type import · imported by this file');
  await inspector.getByRole('button', { name: /^index.ts beta/ }).click();
  await expect(inspector).toContainText('beta/index.ts');
  await expect(inspector).toContainText('type import · imports this file');
  await expect(page.getByTestId('changed-count')).toHaveText('3');
  await inspector.getByRole('button', { name: 'Inbound (1)', exact: true }).click();
  await expect(inspector.getByRole('button', { name: /^index.ts alpha/ })).toBeVisible();
});

test('context coverage and selected-head evidence remain separate, including source-only limitations', async ({ page }) => {
  const context = 'd'.repeat(40);
  const snapshot = structuredClone(fixture);
  snapshot.contextSha = context;
  snapshot.nodes[0] = { ...snapshot.nodes[0]!, importCoverage: 'partial', importReasons: ['Context resolver budget reached.'], externalImports: [{ specifier: 'react', line: 2, reason: 'External package' }], unresolvedImports: [{ specifier: './missing', line: 4, reason: 'No inventoried target' }] };
  snapshot.nodes[1] = { ...snapshot.nodes[1]!, presence: 'source-only', importCoverage: 'unsupported' };
  snapshot.edges[0]!.evidence = { path: 'alpha/index.ts', line: 3, resolver: 'context-resolver', snapshotSha: context };
  snapshot.sources[0] = { ...snapshot.sources[0]!, importHeadSha: head, importCoverage: { status: 'partial', reasons: ['Only outgoing changed-file imports are parsed.'] }, importFiles: [{ fileId: 'a', path: 'alpha/index.ts', status: 'partial', reasons: ['Head identity coverage is bounded.'] }, { fileId: 'b', path: 'beta/index.ts', status: 'unsupported', reasons: ['Source-head file was not parsed.'] }], importEdges: [{ id: 'head-a-b', source: 'a', target: 'b', kind: 'dynamic-import', sourceId: 'pr:1', provenance: 'selected-head', evidence: { sourceId: 'pr:1', path: 'alpha/index.ts', line: 6, resolver: 'head-resolver', snapshotSha: head } }] };
  await openFixture(page, snapshot);
  const inspector = await inspect(page, 'alpha/index.ts', /alpha\/index.ts/);
  const contextDetails = inspector.getByTestId('context-import-coverage');
  await contextDetails.locator('summary').click();
  await expect(contextDetails).toContainText('Context resolver budget reached.');
  await expect(contextDetails).toContainText('react');
  await expect(contextDetails).toContainText('./missing');
  await expect(contextDetails).toContainText(context.slice(0, 12));
  const sourceDetails = inspector.getByTestId('source-head-pr:1');
  await sourceDetails.locator('summary').click();
  await expect(sourceDetails).toContainText('file coverage: partial');
  await expect(sourceDetails).toContainText('1 verified head connections');
  await expect(sourceDetails).toContainText('not a merged code state');
  await expect(sourceDetails.getByRole('link', { name: /head-resolver/ })).toHaveAttribute('href', `https://github.com/example/review/blob/${head}/alpha/index.ts#L6`);
  await expect(inspector.getByRole('heading', { name: 'Pinned context connections 1' })).toBeVisible();
  await expect(page.getByTestId('changed-count')).toHaveText('3');
  await sourceDetails.getByRole('button', { name: /beta\/index.ts/ }).click();
  await expect(inspector).toContainText('Source-only file');
  await expect(inspector.getByTestId('context-import-coverage')).toContainText('not in context');
  await inspector.getByTestId('source-head-pr:1').locator('summary').click();
  await expect(inspector.getByTestId('source-head-pr:1')).toContainText('Source-head file was not parsed.');
});
test('removed binary and unsupported files explain absent data, and no-results recovers', async ({ page }) => {
  await openFixture(page);
  const inspector = await inspect(page, 'removed.png', /removed.png/);
  await expect(inspector).toContainText('Removed file');
  await expect(inspector).toContainText('Binary or asset file');
  await expect(inspector).toContainText('Binary · no line counts');
  await expect(inspector).toContainText('Context file unavailable');
  await page.keyboard.press('Escape');
  await page.getByTestId('file-search').fill('task.py');
  await page.getByRole('option', { name: /task.py/ }).click();
  await expect(inspector).toContainText('Unsupported parser');
  await expect(inspector).toContainText('No selected diff is available');
  await expect(inspector).toContainText('No resolved imports');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('file-search')).toBeFocused();
  await page.getByTestId('file-search').fill('no-such-file');
  await expect(page.getByText(/No files or islands match/)).toBeVisible();
});
test('rapid selection cannot replace the current file diff with an older digest completion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (algorithm, data) => {
      if (new TextDecoder().decode(data as ArrayBuffer).includes('alpha/index.ts')) await new Promise(resolve => setTimeout(resolve, 350));
      return digest(algorithm, data);
    };
  });
  await openFixture(page);
  await inspect(page, 'alpha/index.ts', /alpha\/index.ts/);
  const canvas = page.getByTestId('graph-canvas');
  await canvas.focus();
  const beforePan = Number(await canvas.getAttribute('data-camera-x'));
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await canvas.getAttribute('data-camera-x'))).toBeGreaterThan(beforePan);
  await inspect(page, 'beta/index.ts', /beta\/index.ts/);
  const inspector = page.getByTestId('file-inspector');
  const anchor = createHash('sha256').update('beta/index.ts').digest('hex');
  await expect(inspector.getByRole('link', { name: 'Open #1 file diff' })).toHaveAttribute('href', `https://github.com/example/review/compare/${base}..${head}#diff-${anchor}`);
  await page.waitForTimeout(400);
  await expect(inspector).toContainText('beta/index.ts');
  await expect(inspector.getByRole('link', { name: 'Open #1 file diff' })).toHaveAttribute('href', new RegExp(`${anchor}$`));
  await inspector.getByRole('button', { name: 'Back to overview', exact: true }).click();
  await expect(inspector).toBeHidden();
  await expect(page.getByTestId('changed-count')).toHaveText('3');
});
