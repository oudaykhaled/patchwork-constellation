import type { ChangeSource, FileChange, FileNode, GraphSnapshot, Group, ImportEdge } from '@patchwork/contracts';

/** Explicit synthetic declaration, never a default for an unanalyzed real repository. */
export function authoredFileFacts(coverage: FileNode['importCoverage']): Pick<FileNode, 'fileKind' | 'presence' | 'status' | 'importCoverage' | 'importReasons' | 'externalImports' | 'unresolvedImports'> {
  return { fileKind: 'file', presence: 'context', status: 'unchanged', importCoverage: coverage, importReasons: [coverage === 'complete' ? 'Complete within the author-declared synthetic dependency graph; no live parser result is claimed.' : 'Dependency analysis is intentionally incomplete in this authored fixture.'], externalImports: [], unresolvedImports: [] };
}

/** Authored, synthetic repository. None of these source links claims a real PR exists. */
export const DEMO_REPOSITORY = {
  owner: 'patchwork-demo',
  name: 'platform',
  fullName: 'patchwork-demo/platform',
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/patchwork-demo/platform',
};
export const DEMO_DEFAULT_SOURCE_IDS = ['pr-248', 'pr-251', 'pr-256'] as const;
export const DEMO_COMMIT_SOURCE_IDS = ['commit-a81f3c2', 'commit-b72d9e1'] as const;
const SNAPSHOT_SHA = '8edc3125f1d2e3c4b5a697887766554433221100';
const CREATED_AT = '2026-11-03T12:00:00.000Z';

export const DEMO_GROUPS: Group[] = [
  { id: 'auth', label: 'Authentication', component: 'Identity', color: '#66BFA0', origin: 'manifest' },
  { id: 'billing', label: 'Billing', component: 'Commerce', color: '#9D8FD4', origin: 'manifest' },
  { id: 'api', label: 'API', component: 'Platform', color: '#6A9EC7', origin: 'manifest' },
  { id: 'interface', label: 'Interface', component: 'Experience', color: '#B8A073', origin: 'manifest' },
  { id: 'shared', label: 'Shared', component: 'Platform', color: '#B377C3', origin: 'manifest' },
  { id: 'infra', label: 'Infrastructure', component: 'Platform', color: '#839DA0', origin: 'manifest' },
];

const inventory: Record<string, { prefix: string; names: string[] }> = {
  auth: { prefix: 'src/auth/', names: [
    'session/refresh.ts', 'session/tokens.ts', 'guard.ts', 'session/rotate.ts', 'session/create.ts',
    'session/revoke.ts', 'session/cookie.ts', 'session/store.ts', 'session/expiry.ts', 'claims.ts',
    'oauth.ts', 'oidc.ts', 'providers/google.ts', 'providers/github.ts', 'roles.ts', 'scope.ts',
    'types.ts', 'index.ts', 'audit.ts', 'login.ts', 'logout.ts', 'identity.ts', 'password.ts',
    'reset.ts', 'challenge.ts', 'mfa.ts', 'recovery.ts', 'crypto.ts', 'policy.ts', 'principal.ts',
    'permissions.ts', 'credentials.ts', 'csrf.ts', 'headers.ts', 'config.ts', 'issuer.ts',
    'validate.ts', 'session.test.ts', 'guard.test.ts', 'providers/types.ts', 'middleware.ts', 'events.ts',
  ] },
  billing: { prefix: 'src/billing/', names: [
    'checkout.ts', 'subscriptions.ts', 'plans.ts', 'prices.ts', 'invoices.ts', 'customers.ts',
    'payments.ts', 'refunds.ts', 'proration.ts', 'tax.ts', 'currency.ts', 'discounts.ts',
    'coupons.ts', 'trial.ts', 'renewal.ts', 'cancel.ts', 'usage.ts', 'metering.ts',
    'receipts.ts', 'events.ts', 'webhooks.ts', 'signature.ts', 'stripe.ts', 'provider.ts',
    'retry.ts', 'dunning.ts', 'ledger.ts', 'balance.ts', 'credits.ts', 'types.ts',
    'config.ts', 'index.ts', 'checkout.test.ts', 'invoices.test.ts', 'plans.test.ts', 'fixtures.ts',
  ] },
  api: { prefix: 'src/api/', names: [
    'router.ts', 'request.ts', 'response.ts', 'validate.ts', 'schema.ts', 'errors.ts',
    'middleware/auth.ts', 'middleware/logging.ts', 'middleware/cors.ts', 'middleware/rate-limit.ts',
    'validation/input.ts', 'validation/body.ts', 'validation/query.ts', 'validation/params.ts',
    'routes/users.ts', 'routes/sessions.ts', 'routes/checkout.ts', 'routes/subscriptions.ts',
    'routes/projects.ts', 'routes/health.ts', 'routes/settings.ts', 'routes/events.ts',
    'pagination.ts', 'cursor.ts', 'headers.ts', 'cookies.ts', 'status.ts', 'context.ts',
    'telemetry.ts', 'tracing.ts', 'idempotency.ts', 'cache.ts', 'timeout.ts', 'serialize.ts',
    'types.ts', 'config.ts', 'index.ts', 'router.test.ts', 'validation.test.ts', 'fixtures.ts',
  ] },
  interface: { prefix: 'src/ui/', names: [
    'App.tsx', 'Checkout.tsx', 'Subscription.tsx', 'Account.tsx', 'Settings.tsx', 'Dashboard.tsx',
    'Navigation.tsx', 'Header.tsx', 'Sidebar.tsx', 'Breadcrumbs.tsx', 'Button.tsx', 'IconButton.tsx',
    'Input.tsx', 'Select.tsx', 'Checkbox.tsx', 'Dialog.tsx', 'Drawer.tsx', 'Popover.tsx',
    'Tooltip.tsx', 'Tabs.tsx', 'Menu.tsx', 'Card.tsx', 'Badge.tsx', 'Table.tsx', 'List.tsx',
    'Avatar.tsx', 'EmptyState.tsx', 'ErrorState.tsx', 'LoadingState.tsx', 'Progress.tsx',
    'Toast.tsx', 'Alert.tsx', 'Form.tsx', 'Field.tsx', 'Label.tsx', 'Switch.tsx',
    'hooks/useSession.ts', 'hooks/useBilling.ts', 'hooks/useTheme.ts', 'hooks/useFocus.ts',
    'hooks/useKeyboard.ts', 'hooks/useMedia.ts', 'tokens.ts', 'types.ts', 'index.ts', 'App.test.tsx',
  ] },
  shared: { prefix: 'packages/shared/', names: [
    'validation.ts', 'errors.ts', 'result.ts', 'types.ts', 'constants.ts', 'dates.ts', 'money.ts',
    'strings.ts', 'arrays.ts', 'objects.ts', 'ids.ts', 'hash.ts', 'encoding.ts', 'urls.ts',
    'events.ts', 'logger.ts', 'metrics.ts', 'retry.ts', 'timeout.ts', 'cache.ts', 'queue.ts',
    'schema.ts', 'assert.ts', 'guards.ts', 'config.ts', 'index.ts', 'validation.test.ts', 'fixtures.ts',
  ] },
  infra: { prefix: 'infra/', names: [
    'deploy.ts', 'environment.ts', 'secrets.ts', 'health.ts', 'database.ts', 'migrations.ts',
    'worker.ts', 'scheduler.ts', 'network.ts', 'storage.ts', 'logging.ts', 'metrics.ts',
    'alerts.ts', 'backup.ts', 'restore.ts', 'preview.ts', 'release.ts', 'rollback.ts', 'config.ts', 'types.ts',
  ] },
};

type GroupSelection = Record<string, number[]>;
const range = (count: number, from = 0) => Array.from({ length: count }, (_, i) => i + from);

/** Independently authored membership sets; overlapping source stats must never be summed. */
const selections: Record<string, GroupSelection> = {
  'pr-248': { auth: range(12), billing: [0, 1], api: range(5), interface: range(4), shared: range(4), infra: [0] },
  'pr-251': { auth: range(4, 12), billing: range(12, 2), api: range(6, 4), interface: range(6, 4), shared: [3, 4], infra: [1] },
  'pr-256': { auth: [0, 1, 2, 3, 16, 17], billing: [0, 1, 2, 3], api: [0, 4, 10, 11], interface: [0, 4], shared: [0, 3, 5, 6, 7], infra: [2, 3, 4, 5] },
  'pr-259': { interface: range(8, 34) },
  'commit-a81f3c2': { auth: range(7), billing: [0, 1, 2], api: [0, 1], interface: [0], shared: [0] },
  'commit-b72d9e1': { auth: [0, 1, 7], billing: [0, 3, 4, 5], api: [0, 2, 3, 4], interface: [1, 2], shared: [1] },
};

type SourceSpec = Pick<ChangeSource, 'id' | 'kind' | 'title' | 'label' | 'url' | 'number' | 'sha' | 'baseSha' | 'headSha' | 'comparisonKind'> & { commitCount?: number };
const sourceSpecs: SourceSpec[] = [
  { id: 'pr-248', kind: 'pr', title: 'Rotate session tokens', label: '#248', number: 248, url: `${DEMO_REPOSITORY.htmlUrl}/pull/248`, comparisonKind: 'merge-base', baseSha: SNAPSHOT_SHA, headSha: '2480000000000000000000000000000000000000', commitCount: 5 },
  { id: 'pr-251', kind: 'pr', title: 'Add subscription checkout', label: '#251', number: 251, url: `${DEMO_REPOSITORY.htmlUrl}/pull/251`, comparisonKind: 'merge-base', baseSha: SNAPSHOT_SHA, headSha: '2510000000000000000000000000000000000000', commitCount: 6 },
  { id: 'pr-256', kind: 'pr', title: 'Consolidate request validation', label: '#256', number: 256, url: `${DEMO_REPOSITORY.htmlUrl}/pull/256`, comparisonKind: 'merge-base', baseSha: SNAPSHOT_SHA, headSha: '2560000000000000000000000000000000000000', commitCount: 3 },
  { id: 'pr-259', kind: 'pr', title: 'Update docs navigation', label: '#259', number: 259, url: `${DEMO_REPOSITORY.htmlUrl}/pull/259`, comparisonKind: 'merge-base', baseSha: SNAPSHOT_SHA, headSha: '2590000000000000000000000000000000000000', commitCount: 2 },
  { id: 'commit-a81f3c2', kind: 'commit', title: 'Rotate refresh tokens', label: 'a81f3c2', sha: 'a81f3c2'.padEnd(40, '0'), baseSha: SNAPSHOT_SHA, headSha: 'a81f3c2'.padEnd(40, '0'), comparisonKind: 'first-parent', url: `${DEMO_REPOSITORY.htmlUrl}/commit/a81f3c2` },
  { id: 'commit-b72d9e1', kind: 'commit', title: 'Normalize input validation', label: 'b72d9e1', sha: 'b72d9e1'.padEnd(40, '0'), baseSha: SNAPSHOT_SHA, headSha: 'b72d9e1'.padEnd(40, '0'), comparisonKind: 'first-parent', url: `${DEMO_REPOSITORY.htmlUrl}/commit/b72d9e1` },
];

function changedFile(node: FileNode, index: number): FileChange {
  const status = node.id === 'auth-17' ? 'added' : node.id === 'infra-5' ? 'deleted' : node.id === 'api-11' ? 'renamed' : 'modified';
  return {
    fileId: node.id,
    path: node.path,
    status,
    additions: status === 'deleted' ? 0 : node.id === 'auth-0' ? 86 : 3 + (index * 17) % 97,
    deletions: status === 'added' ? 0 : node.id === 'auth-0' ? 24 : (index * 7) % 29,
    ...(node.id === 'api-11' ? { previousPath: 'src/api/legacy/body.ts' } : {}),
  };
}

function buildDemo(): GraphSnapshot {
  const nodes: FileNode[] = Object.entries(inventory).flatMap(([groupId, group]) => group.names.map((name, index) => ({
    ...authoredFileFacts('complete'),
    id: `${groupId}-${index}`,
    path: group.prefix + name,
    groupId,
    language: name.endsWith('.tsx') ? 'TSX' : 'TypeScript',
    status: 'unchanged',
    presence: 'context',
    sourceIds: [],
  })));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sources: ChangeSource[] = sourceSpecs.map((spec) => {
    const ids = Object.entries(selections[spec.id] ?? {}).flatMap(([groupId, indices]) => indices.map((index) => `${groupId}-${index}`));
    ids.forEach((id) => byId.get(id)!.sourceIds.push(spec.id));
    return { ...spec, files: ids.map((id, index) => changedFile(byId.get(id)!, index)), synthetic: true };
  });
  for (const node of nodes) {
    if (node.sourceIds.some((id) => DEMO_DEFAULT_SOURCE_IDS.includes(id as typeof DEMO_DEFAULT_SOURCE_IDS[number]))) node.status = changedFile(node, 0).status;
    if (node.status === 'added') node.presence = 'added';
    if (node.status === 'deleted') node.presence = 'deleted';
  }
  const edges: ImportEdge[] = [];
  const addEdge = (source: string, target: string) => {
    const sourceNode = byId.get(source)!;
    edges.push({ id: `import-${source}-${target}`, source, target, kind: 'import', evidence: { path: sourceNode.path, line: 3, specifier: byId.get(target)!.path, snapshotSha: SNAPSHOT_SHA, resolver: 'authored-demo-v1' } });
  };
  for (const [groupId, group] of Object.entries(inventory)) {
    // An authored binary import tree: every file remains connected to its island.
    for (let i = 1; i < group.names.length; i++) addEdge(`${groupId}-${i}`, `${groupId}-${Math.floor((i - 1) / 2)}`);
  }
  const extraCounts = [3, 3, 4, 5, 3, 3];
  Object.keys(inventory).forEach((groupId, g) => {
    for (let i = 0; i < extraCounts[g]!; i++) addEdge(`${groupId}-${i + 12}`, `${groupId}-${i + 1}`);
  });
  [
    ['auth-0', 'shared-0'], ['auth-14', 'api-6'], ['billing-0', 'api-16'], ['billing-5', 'shared-6'],
    ['interface-1', 'billing-0'], ['interface-4', 'auth-0'], ['api-0', 'shared-0'], ['infra-6', 'api-19'],
  ].forEach(([source, target]) => addEdge(source!, target!));
  return {
    schemaVersion: '1', id: 'demo-constellation-v1', repository: { ...DEMO_REPOSITORY },
    contextSha: SNAPSHOT_SHA, contextRef: 'main', nodes, edges, groups: structuredClone(DEMO_GROUPS), sources,
    coverage: { status: 'complete', reasons: ['Synthetic demonstration data; no live repository or model calls.'], filesAnalyzed: 212, totalFiles: 212 },
    createdAt: CREATED_AT, mode: 'demo',
  };
}

/** A fresh copy keeps tests and manual regrouping from mutating the canonical fixture. */
export function createDemoSnapshot(): GraphSnapshot { return buildDemo(); }
export const demoSnapshot: GraphSnapshot = createDemoSnapshot();

/** Seeded scale data with exact requested node/edge counts and no duplicate or self edges. */
export function createScaleFixture(nodeCount = 2_000, edgeCount = 8_000, seed = 42): GraphSnapshot {
  if (!Number.isInteger(nodeCount) || nodeCount < 1 || nodeCount > 100_000) throw new RangeError('nodeCount must be an integer between 1 and 100,000');
  if (!Number.isInteger(edgeCount) || edgeCount < 0 || edgeCount > Math.min(500_000, nodeCount * (nodeCount - 1))) throw new RangeError('edgeCount exceeds the supported unique directed graph size');
  if (!Number.isInteger(seed) || !Number.isSafeInteger(seed)) throw new RangeError('seed must be a safe integer');
  let randomState = (seed >>> 0) || 0x9e3779b9;
  const next = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; };
  const groupCount = Math.min(12, nodeCount);
  const groups: Group[] = Array.from({ length: groupCount }, (_, i) => ({ id: `scale-group-${i}`, label: `Module ${i + 1}`, color: DEMO_GROUPS[i % DEMO_GROUPS.length]!.color, origin: 'rules' }));
  const nodes: FileNode[] = Array.from({ length: nodeCount }, (_, i) => ({ ...authoredFileFacts('complete'), id: `scale-file-${i}`, path: `src/module-${i % groupCount + 1}/file-${String(i).padStart(6, '0')}.ts`, groupId: groups[i % groupCount]!.id, sourceIds: [], language: 'TypeScript', presence: 'context', status: 'unchanged' }));
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  const append = (from: number, to: number) => {
    if (from === to) return;
    const pair = `${from}:${to}`;
    if (seen.has(pair)) return;
    seen.add(pair);
    edges.push({ id: `scale-edge-${edges.length}`, source: nodes[from]!.id, target: nodes[to]!.id, kind: 'import', evidence: { path: nodes[from]!.path, line: 1, resolver: `seeded-fixture-${seed}` } });
  };
  // Add a spanning chain before random edges, so scale layouts include connected structure.
  for (let i = 1; i < nodeCount && edges.length < edgeCount; i++) append(i, i - 1);
  let misses = 0;
  while (edges.length < edgeCount && misses < nodeCount * 8 + edgeCount * 4) {
    const before = edges.length;
    append(next() % nodeCount, next() % nodeCount);
    misses = edges.length === before ? misses + 1 : 0;
  }
  // Dense tiny graphs need a bounded deterministic fill rather than random retries.
  if (edges.length < edgeCount) {
    for (let from = 0; from < nodeCount && edges.length < edgeCount; from++) {
      for (let to = 0; to < nodeCount && edges.length < edgeCount; to++) append(from, to);
    }
  }
  const sources: ChangeSource[] = [0, 1].map((sourceIndex) => {
    const id = `scale-pr-${sourceIndex + 1}`;
    const selected = nodes.filter((_, i) => sourceIndex === 0 ? i % 5 === 0 : i % 7 === 0);
    selected.forEach((node) => { node.sourceIds.push(id); node.status = 'modified'; });
    return { id, kind: 'pr', title: `Synthetic change ${sourceIndex + 1}`, label: `#${sourceIndex + 1}`, number: sourceIndex + 1, url: `https://github.com/patchwork-demo/scale/pull/${sourceIndex + 1}`, comparisonKind: 'merge-base', baseSha: SNAPSHOT_SHA, headSha: `${sourceIndex + 1}`.repeat(40), files: selected.map((node, i) => changedFile(node, i)), synthetic: true };
  });
  return { schemaVersion: '1', id: `scale-${nodeCount}-${edgeCount}-${seed}`, repository: { ...DEMO_REPOSITORY, name: 'scale', fullName: 'patchwork-demo/scale', htmlUrl: 'https://github.com/patchwork-demo/scale' }, contextSha: SNAPSHOT_SHA, contextRef: 'main', nodes, edges, groups, sources, coverage: { status: 'complete', reasons: ['Seeded synthetic scale fixture; not a measured capacity claim.'], filesAnalyzed: nodeCount, totalFiles: nodeCount }, createdAt: CREATED_AT, mode: 'demo' };
}
