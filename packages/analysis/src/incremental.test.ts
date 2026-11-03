import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AstImportFactsSchema, IncrementalAnalysisBaselineSchema, INCREMENTAL_BASELINE_LIMITS, type IncrementalAnalysisBaseline } from '@patchwork/contracts';
import { clearGitHubCacheForTests } from '@patchwork/github';
import { analyzeRepository, ANALYZER_VERSION, createIncrementalAnalysisBaseline, PARSER_VERSION } from './index';
import { clearImportCacheForTests } from './imports';

const FIRST = 'a'.repeat(40), NEXT = 'b'.repeat(40);
const repo = { name: 'tool', full_name: 'acme/tool', private: false, default_branch: 'main', html_url: 'https://github.com/acme/tool', owner: { login: 'acme' } };
const blob = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
const firstFiles: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@value': ['src/old/value.ts'] } } }),
  'packages/lib/package.json': JSON.stringify({ name: '@acme/lib', exports: { './feature': './src/old.ts' } }),
  'src/app.ts': "import '@value'; import '@acme/lib/feature'; import './neighbor';",
  'src/neighbor.ts': "export const neighbor = 'RAW_SOURCE_SENTINEL';",
  'src/changed.ts': "import './old/value';",
  'src/old/value.ts': 'export const value = 1;',
  'src/new/value.ts': 'export const value = 2;',
  'packages/lib/src/old.ts': "export const feature = 'old';",
  'packages/lib/src/new.ts': "export const feature = 'new';",
  'src/old/moved.ts': "import './local'; export const moved = true;",
  'src/old/local.ts': "export const local = 'old';",
  'src/new/local.ts': "export const local = 'new';",
  'src/deleted.ts': 'export const deleted = true;',
};
const nextFiles: Record<string, string> = { ...firstFiles,
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@value': ['src/new/value.ts'] } } }),
  'packages/lib/package.json': JSON.stringify({ name: '@acme/lib', exports: { './feature': './src/new.ts' } }),
  'src/changed.ts': "import './new/value';",
  'src/new/moved.ts': firstFiles['src/old/moved.ts']!,
  'src/added.ts': 'export const added = true;',
};
delete nextFiles['src/old/moved.ts']; delete nextFiles['src/deleted.ts'];

function fixture(first = firstFiles, next = nextFiles) {
  const downloads: { sha: string; path: string }[] = [];
  const contexts: Record<string, Record<string, string>> = { [FIRST]: first, [NEXT]: next };
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'raw.githubusercontent.com') {
      const [, , , sha, ...segments] = url.pathname.split('/'); const path = segments.map(decodeURIComponent).join('/');
      downloads.push({ sha: sha!, path }); const text = contexts[sha!]?.[path];
      return new Response(text ?? 'missing', { status: text === undefined ? 404 : 200 });
    }
    if (url.pathname === '/repos/acme/tool') return Response.json(repo);
    if (url.pathname.startsWith('/repos/acme/tool/git/trees/')) {
      const sha = url.pathname.split('/').at(-1)!;
      return Response.json({ truncated: false, tree: Object.entries(contexts[sha] ?? {}).map(([path, content]) => ({ path, type: 'blob', mode: '100644', sha: blob(content), size: Buffer.byteLength(content) })) });
    }
    if (url.pathname.startsWith('/repos/acme/tool/commits/')) return Response.json({ sha: url.pathname.split('/').at(-1)!, commit: { message: 'context' }, parents: [] });
    if (url.pathname === '/repos/acme/tool/pulls' || url.pathname === '/repos/acme/tool/commits') return Response.json([]);
    return new Response('unexpected fixture URL', { status: 404 });
  }) as typeof fetch;
  return { fetcher, downloads };
}
function graphFacts(snapshot: Awaited<ReturnType<typeof analyzeRepository>>) {
  return { nodes: snapshot.nodes, edges: snapshot.edges, groups: snapshot.groups, hierarchy: snapshot.hierarchy, coverage: snapshot.coverage };
}
beforeEach(() => { clearGitHubCacheForTests(); clearImportCacheForTests(); });

describe('incremental pinned static refresh', () => {
  it('reuses unchanged/relocated syntax without downloads, re-resolving aliases, exports and relative paths against fresh context', async () => {
    const f = fixture();
    const first = await analyzeRepository({ repository: 'acme/tool', contextRef: FIRST }, { fetch: f.fetcher });
    const baseline = createIncrementalAnalysisBaseline(first)!;
    expect(baseline.files).toHaveLength(11);
    expect(JSON.stringify(baseline)).not.toContain('RAW_SOURCE_SENTINEL');
    expect(Object.keys(baseline)).toEqual(['schemaVersion', 'repository', 'analyzerVersion', 'parserVersion', 'contextSha', 'files']);
    expect(Object.keys(baseline.files[0]!)).toEqual(['path', 'blobSha', 'parseFacts']);
    clearGitHubCacheForTests(); clearImportCacheForTests(); f.downloads.length = 0;
    const progress: string[] = [];
    const next = await analyzeRepository({ repository: 'acme/tool', contextRef: NEXT }, { fetch: f.fetcher, incrementalBaseline: baseline, onProgress: value => progress.push(value.message) });
    expect(next.incremental).toMatchObject({ mode: 'incremental', baselineStatus: 'accepted', basisSha: FIRST, eligibleFiles: 11, reusedFiles: 9, reusedAtNewPaths: 1, parsedFiles: 2, parserCacheHits: 0, fetchedSourceFiles: 2, invalidatedFiles: 1 });
    expect(f.downloads.filter(item => /\.ts$/.test(item.path)).map(item => item.path).sort()).toEqual(['src/added.ts', 'src/changed.ts']);
    expect(f.downloads.filter(item => /\.json$/.test(item.path)).map(item => item.path).sort()).toEqual(['packages/lib/package.json', 'tsconfig.json']);
    expect(progress.join(' ')).toContain('reused 9 unchanged blobs');
    const paths = new Map(next.nodes.map(node => [node.id, node.path]));
    const edges = next.edges.map(edge => `${paths.get(edge.source)} -> ${paths.get(edge.target)}`);
    expect(edges).toContain('src/app.ts -> src/new/value.ts'); expect(edges).toContain('src/app.ts -> packages/lib/src/new.ts');
    expect(edges).toContain('src/new/moved.ts -> src/new/local.ts');
    expect(next.nodes.some(node => ['src/deleted.ts', 'src/old/moved.ts'].includes(node.path))).toBe(false);
    clearGitHubCacheForTests(); clearImportCacheForTests();
    const full = await analyzeRepository({ repository: 'acme/tool', contextRef: NEXT }, { fetch: f.fetcher });
    expect(graphFacts(next)).toEqual(graphFacts(full));
  });

  it('supports same-SHA refresh and validates facts even when process caches were cleared', async () => {
    const f = fixture(); const first = await analyzeRepository({ repository: 'acme/tool', contextRef: FIRST }, { fetch: f.fetcher });
    const baseline = createIncrementalAnalysisBaseline(first)!;
    clearGitHubCacheForTests(); clearImportCacheForTests(); f.downloads.length = 0;
    const second = await analyzeRepository({ repository: 'acme/tool', contextRef: FIRST }, { fetch: f.fetcher, incrementalBaseline: baseline });
    expect(second.incremental).toMatchObject({ reusedFiles: 11, parsedFiles: 0, parserCacheHits: 0, fetchedSourceFiles: 0, basisSha: FIRST });
    expect(f.downloads.every(item => item.path.endsWith('.json'))).toBe(true);
    expect(graphFacts(second)).toEqual(graphFacts(first));
  });

  it('invalidates syntax reuse when a same-content path changes parser kind', async () => {
    const text = "const view = <Widget>value;";
    const f = fixture({ 'view.ts': text }, { 'view.tsx': text });
    const first = await analyzeRepository({ repository: 'acme/tool', contextRef: FIRST }, { fetch: f.fetcher });
    clearGitHubCacheForTests(); clearImportCacheForTests(); f.downloads.length = 0;
    const next = await analyzeRepository({ repository: 'acme/tool', contextRef: NEXT }, { fetch: f.fetcher, incrementalBaseline: createIncrementalAnalysisBaseline(first) });
    expect(next.incremental).toMatchObject({ reusedFiles: 0, fetchedSourceFiles: 1, parsedFiles: 1 });
    expect(next.nodes[0]).toMatchObject({ importCoverage: 'partial', parseFacts: { scriptKind: 'tsx' } });
  });

  it('rejects foreign, wrong-version, malformed and oversized baselines and computes normal full results', async () => {
    const f = fixture(); const first = await analyzeRepository({ repository: 'acme/tool', contextRef: FIRST }, { fetch: f.fetcher });
    const baseline = createIncrementalAnalysisBaseline(first)!;
    const invalid: { value: unknown; status: 'invalid' | 'incompatible' }[] = [
      { value: { ...baseline, repository: 'foreign/private' }, status: 'incompatible' },
      { value: { ...baseline, parserVersion: 'old-parser' }, status: 'incompatible' },
      { value: { ...baseline, analyzerVersion: 'old-analyzer' }, status: 'incompatible' },
      { value: { ...baseline, files: [{ ...baseline.files[0], path: '../escape.ts' }] }, status: 'invalid' },
      { value: { ...baseline, files: Array.from({ length: 501 }, () => baseline.files[0]) }, status: 'invalid' },
      { value: { ...baseline, files: [{ ...baseline.files[0], parseFacts: { ...baseline.files[0]!.parseFacts, source: 'raw source is forbidden' } }] }, status: 'invalid' },
    ];
    for (const item of invalid) {
      clearGitHubCacheForTests(); clearImportCacheForTests(); f.downloads.length = 0;
      const next = await analyzeRepository({ repository: 'acme/tool', contextRef: NEXT }, { fetch: f.fetcher, incrementalBaseline: item.value });
      expect(next.incremental).toMatchObject({ mode: 'full', baselineStatus: item.status, reusedFiles: 0, fetchedSourceFiles: 11 });
      expect(next.incremental!.reason).toContain('full analysis');
      expect(f.downloads.filter(value => value.path.endsWith('.ts'))).toHaveLength(11);
    }
  });
});

describe('thin baseline contract and limits', () => {
  const facts = { schemaVersion: '1' as const, scriptKind: 'ts' as const, references: [], reasons: [] };
  const base: IncrementalAnalysisBaseline = { schemaVersion: '1', repository: 'acme/tool', analyzerVersion: ANALYZER_VERSION, parserVersion: PARSER_VERSION, contextSha: FIRST, files: [{ path: 'a.ts', blobSha: NEXT, parseFacts: facts }] };
  it('rejects extra graph/source fields, duplicate/conflicting immutable facts and invalid metadata', () => {
    expect(IncrementalAnalysisBaselineSchema.safeParse({ ...base, edges: [] }).success).toBe(false);
    expect(IncrementalAnalysisBaselineSchema.safeParse({ ...base, files: [base.files[0], base.files[0]] }).success).toBe(false);
    const differentFacts = { ...base.files[0], path: 'b.ts', parseFacts: { ...facts, references: [{ specifier: './changed', line: 1, kind: 'import' }] } };
    expect(IncrementalAnalysisBaselineSchema.safeParse({ ...base, files: [base.files[0], differentFacts] }).success).toBe(false);
    expect(AstImportFactsSchema.safeParse({ ...facts, source: 'not allowed' }).success).toBe(false);
  });
  it('enforces bytes and total facts before accepting worker transfer metadata', () => {
    const reference = { specifier: 'x'.repeat(2_048), line: 1, kind: 'import' };
    const oversized = { ...base, files: ['a.ts', 'b.ts'].map(path => ({ path, blobSha: NEXT, parseFacts: { ...facts, references: Array.from({ length: 600 }, () => reference) } })) };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(INCREMENTAL_BASELINE_LIMITS.maxBytes);
    expect(IncrementalAnalysisBaselineSchema.safeParse(oversized).success).toBe(false);
    const tooMany = { ...base, files: Array.from({ length: 21 }, (_, index) => ({ path: `file-${index}.ts`, blobSha: NEXT, parseFacts: { ...facts, references: Array.from({ length: 1_000 }, () => ({ ...reference, specifier: './a' })) } })) };
    expect(IncrementalAnalysisBaselineSchema.safeParse(tooMany).success).toBe(false);
  });
});
