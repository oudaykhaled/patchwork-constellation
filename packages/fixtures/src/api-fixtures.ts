/** Authored HTTP facts, not recordings of any user's repository, tokens or source. */
export type ApiReplayStep = {
  path: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

const repository = '/repos/patchwork-demo/history';
const root = '1'.repeat(40);
const oldHead = '2'.repeat(40);
const newHead = '3'.repeat(40);
const file = (i: number) => ({ filename: `src/file-${i}.ts`, status: 'modified', additions: 1, deletions: 1, changes: 2 });

export const API_FIXTURE_PROVENANCE = {
  origin: 'Independently authored synthetic GitHub REST responses',
  apiVersion: '2022-11-28',
  createdAt: '2026-11-03',
  containsPrivateSource: false,
  containsCredentials: false,
};

/** Source-truth cardinalities unavailable from GitHub's capped comparison response. */
export const API_GOLDEN = { comparisonChangedFiles: 301, comparisonReturnedFiles: 300, pullRequestChangedFiles: 3_001, paginatedPullRequestNumbers: [11, 12, 13] } as const;

export function createApiScenarios(): Record<string, ApiReplayStep[]> {
  return {
    pagination: [
      { path: `${repository}/pulls?per_page=2&page=1`, status: 200, headers: { link: `<https://api.github.com${repository}/pulls?per_page=2&page=2>; rel="next", <https://api.github.com${repository}/pulls?per_page=2&page=2>; rel="last"` }, body: [{ number: 11, title: 'Authored PR A' }, { number: 12, title: 'Authored PR B' }] },
      { path: `${repository}/pulls?per_page=2&page=2`, status: 200, body: [{ number: 13, title: 'Authored PR C' }] },
    ],
    conditional: [
      { path: `${repository}/pulls/11`, status: 200, headers: { etag: '"fixture-revision-1"' }, body: { number: 11, base: { sha: root }, head: { sha: oldHead } } },
      { path: `${repository}/pulls/11`, status: 304, headers: { etag: '"fixture-revision-1"' } },
    ],
    rateLimit: [
      { path: `${repository}/commits`, status: 429, headers: { 'retry-after': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793707201' }, body: { message: 'Synthetic primary rate limit' } },
      { path: `${repository}/commits`, status: 200, headers: { 'x-ratelimit-remaining': '49' }, body: [{ sha: oldHead }] },
    ],
    secondaryRateLimit: [
      { path: `${repository}/pulls`, status: 403, headers: { 'retry-after': '2' }, body: { message: 'Synthetic secondary rate limit' } },
      { path: `${repository}/pulls`, status: 200, body: [] },
    ],
    truncatedTree: [{ path: `${repository}/git/trees/${root}?recursive=1`, status: 200, body: { sha: root, truncated: true, tree: [{ path: 'src', type: 'tree', mode: '040000', sha: oldHead }, { path: 'README.md', type: 'blob', mode: '100644', sha: newHead }] } }],
    cappedPullRequest: [{ path: `${repository}/pulls/11`, status: 200, body: { number: 11, changed_files: 3_001, base: { sha: root }, head: { sha: oldHead } } }],
    cappedComparison: [{ path: `${repository}/compare/${root}...${oldHead}`, status: 200, body: { base_commit: { sha: root }, merge_base_commit: { sha: root }, total_commits: 1, files: Array.from({ length: 300 }, (_, i) => file(i)), commits: [{ sha: oldHead }] } }],
    permissionRevocation: [
      { path: repository, status: 200, body: { id: 42, full_name: 'patchwork-demo/history', private: true, permissions: { pull: true } } },
      { path: repository, status: 403, body: { message: 'Resource not accessible by integration' } },
    ],
    removedRepository: [{ path: repository, status: 404, body: { message: 'Not Found' } }],
    disconnectedAccount: [{ path: '/user', status: 401, body: { message: 'Bad credentials' } }],
    staleSelection: [
      { path: `${repository}/pulls/11`, status: 200, body: { number: 11, base: { sha: root }, head: { sha: oldHead } } },
      { path: `${repository}/pulls/11`, status: 200, body: { number: 11, base: { sha: root }, head: { sha: newHead } } },
    ],
  };
}

/** Ordered replay rejects unexpected URLs and exhausted recordings instead of reaching a network. */
export function createApiReplay(steps: readonly ApiReplayStep[]) {
  let position = 0;
  const requests: { path: string; method: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const step = steps[position];
    const path = url.pathname + url.search;
    if (url.origin !== 'https://api.github.com' || method !== 'GET' || !step || step.path !== path) throw new Error(`Unexpected synthetic API replay request: ${method} ${url.origin}${path}`);
    position++;
    requests.push({ path, method });
    const headers = { 'content-type': 'application/json', ...step.headers };
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), { status: step.status, headers });
  };
  return { fetch, requests, remaining: () => steps.length - position };
}
