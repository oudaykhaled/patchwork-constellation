import { beforeEach, describe, expect, it } from 'vitest';
import { clearGitHubCacheForTests, GitHubClient } from '@patchwork/github';
import type { ChangeSource, GraphSnapshot } from '@patchwork/contracts';
import { buildStaticGraph } from './static-graph';
import { analyzeSourceDependencies, enrichSelectedSourceDependencies } from './source-dependencies';

const CONTEXT = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const address = { owner: 'acme', name: 'tool', fullName: 'acme/tool' };
type Entry = { path: string; type: 'blob' | 'commit'; mode: string; sha: string; size: number };
function fixture(content: Record<string, string>, overrides: Partial<Entry>[] = []) {
  const requests: string[] = [];
  const entries: Entry[] = Object.keys(content).map((path, index) => ({ path, type: 'blob', mode: '100644', sha: `blob-${index}`, size: content[path]!.length }));
  for (const override of overrides) {
    const existing = entries.find(entry => entry.path === override.path);
    if (existing) Object.assign(existing, override);
    else entries.push({ path: 'extra', type: 'blob', mode: '100644', sha: 'extra', size: 10, ...override });
  }
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); requests.push(url.href);
    if (url.hostname === 'api.github.com' && url.pathname.includes('/git/trees/')) return Response.json({ tree: entries, truncated: false });
    if (url.hostname === 'raw.githubusercontent.com') {
      const path = url.pathname.split('/').slice(4).map(decodeURIComponent).join('/');
      return new Response(content[path] ?? 'missing', { status: content[path] !== undefined ? 200 : 404 });
    }
    return new Response('unexpected', { status: 404 });
  }) as typeof fetch;
  return { entries, requests, fetcher };
}
beforeEach(clearGitHubCacheForTests);
describe('bounded static inventory', () => {
  it('keeps circular and barrel dependencies directed with resolvable file/line evidence', async () => {
    const f = fixture({ 'a.ts': "import { b } from './b'; export const a = b;", 'b.ts': "export { a as b } from './a';", 'types.ts': "import type { a } from './a';" });
    const graph = await buildStaticGraph(new GitHubClient({ fetch: f.fetcher }), address, CONTEXT);
    const paths = new Map(graph.nodes.map(node => [node.id, node.path]));
    expect(graph.edges.map(edge => [paths.get(edge.source), paths.get(edge.target), edge.kind]).sort()).toEqual([['a.ts', 'b.ts', 'import'], ['b.ts', 'a.ts', 'reexport'], ['types.ts', 'a.ts', 'type-import']]);
    for (const edge of graph.edges) expect(edge.evidence).toMatchObject({ path: paths.get(edge.source), line: 1, snapshotSha: CONTEXT });
  });
  it('preserves unsupported/special files while attaching per-file exclusions and external metadata', async () => {
    const f = fixture({
      'src/main.ts': "import './target'; import './missing'; import React from 'react'; import(name);",
      'src/target.ts': 'export const n = 1;',
      'src/link.ts': '../../outside.ts',
      'src/large.ts': 'export const big = 1;',
      'src/generated/generated.ts': "import '../secret';",
      'src/lfs.ts': 'version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 99\n',
      'src/binary.ts': '\0\0bad',
      'image.png': 'binary',
      'tool.py': 'import secret',
    }, [{ path: 'src/link.ts', mode: '120000' }, { path: 'src/large.ts', size: 80_001 }, { path: 'embedded', type: 'commit', mode: '160000' }]);
    const graph = await buildStaticGraph(new GitHubClient({ fetch: f.fetcher }), address, CONTEXT);
    expect(graph.nodes).toHaveLength(10); expect(graph.edges).toHaveLength(1);
    const nodes = new Map(graph.nodes.map(node => [node.path, node]));
    expect(nodes.get('src/main.ts')).toMatchObject({ importCoverage: 'partial', externalImports: [{ specifier: 'react' }], unresolvedImports: [{ specifier: './missing' }] });
    expect((nodes.get('src/main.ts')!.importReasons as string[]).join(' ')).toContain('Non-literal');
    for (const [path, kind, coverage] of [['src/link.ts', 'symlink', 'excluded'], ['embedded', 'submodule', 'excluded'], ['src/lfs.ts', 'lfs-pointer', 'excluded'], ['src/binary.ts', 'binary', 'unsupported'], ['src/generated/generated.ts', 'generated', 'excluded'], ['tool.py', 'file', 'unsupported']]) expect(nodes.get(path!)).toMatchObject({ fileKind: kind, importCoverage: coverage });
    expect(nodes.get('src/large.ts')!.importCoverage).toBe('excluded');
    expect(f.requests.some(url => url.includes('/src/link.ts') || url.includes('/src/large.ts') || url.includes('/generated/generated.ts'))).toBe(false);
    expect(graph.edges[0]).toMatchObject({ provenance: 'context', evidence: { path: 'src/main.ts', snapshotSha: CONTEXT, resolver: 'typescript-static-exports-v3' } });
    expect(graph.coverage.status).toBe('partial');
  });
  it('resolves declarative package exports and applies repository mapping with manifest evidence', async () => {
    const f = fixture({
      '.constellation.json': JSON.stringify({ version: 1, modules: [{ id: 'feature', label: 'Feature island', paths: ['apps/web'] }] }),
      'apps/web/main.ts': "import { value } from '@acme/lib/feature';",
      'packages/lib/package.json': JSON.stringify({ name: '@acme/lib', exports: { './feature': './src/feature.ts' }, scripts: { postinstall: 'DO NOT EXECUTE' } }),
      'packages/lib/src/feature.ts': 'export const value = 1;',
    });
    const graph = await buildStaticGraph(new GitHubClient({ fetch: f.fetcher }), address, CONTEXT);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.find(node => node.path === 'apps/web/main.ts')!.groupId).toBe('group:user:feature');
    expect(graph.hierarchy.mappingVersion).toBe(1);
    expect(graph.hierarchy.groups.find(group => group.label === '@acme/lib')).toMatchObject({ origin: 'manifest' });
    expect(f.requests).toHaveLength(5); // tree, mapping, manifest, two source blobs; scripts stay data.
  });
  it('bounds parser work, rejects unsafe paths and falls back from invalid mapping explicitly', async () => {
    const f = fixture({ '.constellation.json': '{"version":99}', 'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 2;' }, [{ path: '../escape.ts' }]);
    const graph = await buildStaticGraph(new GitHubClient({ fetch: f.fetcher }), address, CONTEXT, { maxSourceFiles: 1 });
    expect(graph.nodes.map(node => node.path)).not.toContain('../escape.ts');
    expect(graph.nodes.find(node => node.path === 'b.ts')).toMatchObject({ importCoverage: 'partial' });
    expect(graph.coverage.reasons.join(' ')).toContain('failed validation');
    expect(graph.coverage.reasons.join(' ')).toContain('invalid repository paths');
  });
  it('does not label imports complete when nearest alias configuration is unsupported', async () => {
    const f = fixture({ 'tsconfig.json': '{"extends":"./unknown.json","compilerOptions":{"paths":{"@/*":["src/*"]}}}', 'src/main.ts': "import '@/unknown';" });
    const graph = await buildStaticGraph(new GitHubClient({ fetch: f.fetcher }), address, CONTEXT);
    expect(graph.nodes.find(node => node.path === 'src/main.ts')).toMatchObject({ importCoverage: 'partial' });
    expect((graph.nodes.find(node => node.path === 'src/main.ts')!.importReasons as string[]).join(' ')).toContain('unsupported inheritance');
  });
});

describe('independent selected-head dependency evidence', () => {
  async function setup() {
    const f = fixture({ 'src/app.ts': "import './added'; import './stable'; import './other';", 'src/added.ts': 'export const a=1;', 'src/stable.ts': 'export const s=1;', 'src/other.ts': 'export const x=1;' });
    const source: ChangeSource = { id: 'pr:1', kind: 'pr', number: 1, label: '#1', title: 'Add feature', url: 'https://github.com/acme/tool/pull/1', loaded: true, baseSha: CONTEXT, headSha: HEAD, comparisonKind: 'merge-base', files: [{ fileId: 'stable-app', path: 'src/app.ts', status: 'modified', additions: 3, deletions: 0 }, { fileId: 'new-added', path: 'src/added.ts', status: 'added', additions: 1, deletions: 0 }, { fileId: 'old-deleted', path: 'src/deleted.ts', status: 'removed', additions: 0, deletions: 1 }] };
    const snapshot: GraphSnapshot = { schemaVersion: '1', id: 'snapshot:test', contextSha: CONTEXT, contextRef: 'main', repository: { ...address, defaultBranch: 'main', htmlUrl: 'https://github.com/acme/tool' }, nodes: [
      { id: 'stable-app', path: 'src/app.ts', groupId: 'group:src/app', sourceIds: ['pr:1'], blobSha: 'old-app' },
      { id: 'new-added', path: 'src/added.ts', groupId: 'group:src/app', sourceIds: ['pr:1'], presence: 'source-only' },
      { id: 'stable-target', path: 'src/stable.ts', groupId: 'group:src/app', sourceIds: [], blobSha: f.entries.find(entry => entry.path === 'src/stable.ts')!.sha },
      { id: 'conflicting-other', path: 'src/other.ts', groupId: 'group:src/app', sourceIds: [], blobSha: 'unrelated-old-other' },
      { id: 'old-deleted', path: 'src/deleted.ts', groupId: 'group:src/app', sourceIds: ['pr:1'], presence: 'deleted' },
    ], edges: [], groups: [{ id: 'group:src/app', label: 'App' }], sources: [source], coverage: { status: 'complete', reasons: [] }, createdAt: '2026-11-03T00:00:00Z', mode: 'github' };
    return { f, snapshot, source };
  }
  it('maps only proven file identities and keeps head SHA/source provenance distinct from context', async () => {
    const { f, snapshot, source } = await setup();
    const result = await analyzeSourceDependencies(snapshot, source, { fetch: f.fetcher });
    expect(result.edges.map(edge => [edge.source, edge.target])).toEqual(expect.arrayContaining([['stable-app', 'new-added'], ['stable-app', 'stable-target']]));
    expect(result.edges).toHaveLength(2);
    expect(result.edges.every(edge => edge.provenance === 'selected-head' && edge.sourceId === 'pr:1')).toBe(true);
    expect(result.edges[0]!.evidence).toMatchObject({ snapshotSha: HEAD, contextSha: CONTEXT, headSha: HEAD, sourceId: 'pr:1' });
    expect(result.coverage.reasons.join(' ')).toContain('without confirmed context/source identity');
    expect(result.files.find(file => file.fileId === 'old-deleted')).toMatchObject({ status: 'excluded' });
    expect(snapshot.edges).toEqual([]); // independent layer cannot alter baseline facts.
  });
  it('keeps head edges outside context edges and preserves exact footprints when extraction fails', async () => {
    const { f, snapshot } = await setup(); const original = structuredClone(snapshot.sources[0]!.files);
    const result = await enrichSelectedSourceDependencies(snapshot, 'pr', ['pr:1'], { fetch: f.fetcher });
    expect(result.edges).toEqual([]); expect(result.sources[0]!.importEdges).toHaveLength(2);
    expect(result.sources[0]!.files).toEqual(original);
    clearGitHubCacheForTests(); delete result.sources[0]!.importHeadSha;
    const failed = await enrichSelectedSourceDependencies(result, 'pr', ['pr:1'], { fetch: (async () => new Response('unavailable', { status: 404 })) as typeof fetch });
    expect(failed.sources[0]!.importCoverage).toMatchObject({ status: 'failed' });
    expect(failed.sources[0]!.files).toEqual(original);
  });
});
