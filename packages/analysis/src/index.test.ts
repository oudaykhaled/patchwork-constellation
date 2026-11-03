import { beforeEach, describe, expect, it } from 'vitest';
import { clearGitHubCacheForTests } from '@patchwork/github';
import { analyzeRepository, loadSourceChanges } from './index';
const SHA = 'a'.repeat(40), HEAD = 'b'.repeat(40), BASE = 'c'.repeat(40);
const repo = { name: 'tool', full_name: 'acme/tool', private: false, default_branch: 'main', html_url: 'https://github.com/acme/tool', owner: { login: 'acme' } };
const pull = { number: 1, title: 'Change auth', html_url: 'https://github.com/acme/tool/pull/1', state: 'open', changed_files: 2, base: { sha: SHA, ref: 'main' }, head: { sha: HEAD, ref: 'auth' } };
const commit = { sha: SHA, html_url: `https://github.com/acme/tool/commit/${SHA}`, commit: { message: 'Change app' }, parents: [{ sha: BASE }] };
function mockFetch(extra: (url: URL) => unknown = () => undefined): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input)); const override = extra(url); if (override !== undefined) return new Response(JSON.stringify(override));
    if (url.hostname === 'raw.githubusercontent.com') return new Response(url.pathname.endsWith('app.ts') ? "import { login } from './auth/login'; export { login };" : 'export const login = () => true;');
    if (url.pathname === '/repos/acme/tool') return Response.json(repo);
    if (url.pathname === '/repos/acme/tool/commits/main') return Response.json(commit);
    if (url.pathname.includes('/git/trees/')) return Response.json({ truncated: false, tree: [{ path: 'src/app.ts', type: 'blob', mode: '100644', sha: '1', size: 30 }, { path: 'src/auth/login.ts', type: 'blob', mode: '100644', sha: '2', size: 30 }] });
    if (url.pathname === '/repos/acme/tool/pulls') return Response.json([pull]);
    if (url.pathname === '/repos/acme/tool/commits') return Response.json([commit]);
    if (url.pathname === '/repos/acme/tool/pulls/1') return Response.json(pull);
    if (url.pathname.includes('/compare/')) return Response.json({ merge_base_commit: { sha: BASE }, files: [{ filename: 'src/auth/login.ts', status: 'modified', additions: 2, deletions: 1 }, { filename: 'src/deleted.ts', status: 'removed', additions: 0, deletions: 9 }] });
    if (url.pathname === `/repos/acme/tool/commits/${SHA}`) return Response.json({ ...commit, files: [{ filename: 'src/auth/login.ts', status: 'modified', additions: 3, deletions: 0 }] });
    return new Response('missing fixture ' + url.href, { status: 404 });
  }) as typeof fetch;
}
beforeEach(() => clearGitHubCacheForTests());
describe('repository analysis and source overlays', () => {
  it('pins context, derives evidenced imports and keeps geometry identities stable on changes', async () => {
    const fetch = mockFetch(); const progress: number[] = [];
    const snapshot = await analyzeRepository({ repository: 'acme/tool' }, { fetch, onProgress: item => progress.push(item.progress) });
    expect(snapshot.contextSha).toBe(SHA); expect(snapshot.nodes).toHaveLength(2); expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]?.evidence).toMatchObject({ path: 'src/app.ts', specifier: './auth/login', snapshotSha: SHA });
    expect(progress.at(-1)).toBe(100);
    const selected = await loadSourceChanges(snapshot, 'pr', ['pr:1'], { fetch });
    expect(selected.nodes.find(node => node.path === 'src/auth/login.ts')?.id).toBe(snapshot.nodes.find(node => node.path === 'src/auth/login.ts')?.id);
    expect(selected.nodes.find(node => node.path === 'src/deleted.ts')?.presence).toBe('deleted');
    expect(selected.sources[0]).toMatchObject({ baseSha: BASE, headSha: HEAD, comparisonKind: 'merge-base', loaded: true });
    const combined = await loadSourceChanges(selected, 'commit', [`commit:${SHA}`], { fetch });
    expect(combined.nodes.find(node => node.path === 'src/auth/login.ts')?.sourceIds).toEqual(['pr:1', `commit:${SHA}`]);
    expect(combined.sources.find(source => source.kind === 'commit')).toMatchObject({ comparisonKind: 'first-parent', baseSha: BASE });
    const empty = await loadSourceChanges(combined, 'pr', [], { fetch });
    expect(empty.nodes.map(node => node.id)).toEqual(combined.nodes.map(node => node.id));
  });
  it('rejects private repositories and unknown selected sources', async () => {
    await expect(analyzeRepository({ repository: 'acme/tool' }, { fetch: mockFetch(url => url.pathname === '/repos/acme/tool' ? { ...repo, private: true } : undefined) })).rejects.toMatchObject({ code: 'PRIVATE_UNSUPPORTED' });
    clearGitHubCacheForTests(); const snapshot = await analyzeRepository({ repository: 'acme/tool' }, { fetch: mockFetch() });
    await expect(loadSourceChanges(snapshot, 'pr', ['pr:999'], { fetch: mockFetch() })).rejects.toMatchObject({ code: 'UNKNOWN_SOURCE' });
  });
  it('marks truncation and bounded parsing as partial coverage', async () => {
    const snapshot = await analyzeRepository({ repository: 'acme/tool' }, { fetch: mockFetch(url => url.pathname.includes('/git/trees/') ? { truncated: true, tree: [{ path: 'a.ts', type: 'blob', mode: '100644', sha: '1', size: 5 }, { path: 'b.ts', type: 'blob', mode: '100644', sha: '2', size: 5 }] } : undefined), maxFiles: 1, maxSourceFiles: 0 });
    expect(snapshot.coverage.status).toBe('partial'); expect(snapshot.coverage.reasons.join(' ')).toContain('truncated'); expect(snapshot.coverage.reasons.join(' ')).toContain('limited to 1');
  });
  it('rejects force-pushed pull requests instead of silently updating the selected snapshot', async () => {
    const snapshot = await analyzeRepository({ repository: 'acme/tool' }, { fetch: mockFetch() });
    await expect(loadSourceChanges(snapshot, 'pr', ['pr:1'], { fetch: mockFetch(url => url.pathname === '/repos/acme/tool/pulls/1' ? { ...pull, head: { sha: 'd'.repeat(40), ref: 'auth' } } : undefined) })).rejects.toMatchObject({ code: 'STALE_SOURCE' });
  });
  it('scopes identical monorepo aliases to the importing package regardless of fetch completion order', async () => {
    const content: Record<string, string> = {
      'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'packages/b/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'packages/a/src/main.ts': "import { value } from '@/value'; export { value };",
      'packages/a/src/value.ts': 'export const value = "a";',
      'packages/b/src/main.ts': "import { value } from '@/value'; export { value };",
      'packages/b/src/value.ts': 'export const value = "b";',
    };
    const expected = ['packages/a/src/main.ts → packages/a/src/value.ts', 'packages/b/src/main.ts → packages/b/src/value.ts'];
    for (const reverse of [false, true]) {
      clearGitHubCacheForTests();
      const fallback = mockFetch();
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === 'raw.githubusercontent.com') {
          const path = url.pathname.split('/').slice(4).join('/');
          if (path.endsWith('tsconfig.json')) await new Promise(resolve => setTimeout(resolve, path.includes('/a/') === reverse ? 1 : 15));
          return new Response(content[path] ?? '', { status: content[path] ? 200 : 404 });
        }
        if (url.pathname.includes('/git/trees/')) return Response.json({ truncated: false, tree: Object.keys(content).map((path, index) => ({ path, type: 'blob', mode: '100644', sha: String(index), size: 80 })) });
        return fallback(input, init);
      }) as typeof fetch;
      const result = await analyzeRepository({ repository: 'acme/tool' }, { fetch: fetcher });
      const paths = new Map(result.nodes.map(node => [node.id, node.path]));
      expect(result.edges.map(edge => `${paths.get(edge.source)} → ${paths.get(edge.target)}`).sort()).toEqual(expected);
    }
  });
});
