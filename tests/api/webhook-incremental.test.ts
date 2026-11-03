import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { analyzeRepository } from '@patchwork/analysis';
import type { GraphSnapshot } from '@patchwork/contracts';
import { createStore, createPostgresWebhookInbox, MemoryWebhookInbox } from '@patchwork/storage';
import { clearGitHubCacheForTests } from '@patchwork/github';
import { clearImportCacheForTests } from '../../packages/analysis/src/imports';
import { createApplicationServer } from '../../apps/web/server';
import { pinAnalysisInput } from '../../apps/web/analysis-jobs';
import { GitHubAppAuth, type GitHubSession } from '../../apps/web/github-auth';

const repository = 'fixture/webhook-incremental';
const FIRST = 'a'.repeat(40), CONFIG_CHANGED = 'b'.repeat(40), SOURCE_CHANGED = 'c'.repeat(40);
const blob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const initialFiles: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@target': ['src/old/target.ts'] } } }),
  'src/main.ts': "import { value } from '@target'; export const main = value;",
  'src/stable.ts': "import { value } from './old/target'; export const stable = value;",
  'src/old/target.ts': 'export const value = 1;',
  'src/new/target.ts': 'export const value = 2;',
};
const configFiles = { ...initialFiles, 'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@target': ['src/new/target.ts'] } } }) };
const changedFiles = { ...configFiles, 'src/main.ts': "import { value } from './new/target'; import { stable } from './stable'; export const main = value + stable;" };
class ControlledInbox extends MemoryWebhookInbox { override readonly durable = true; }
class IncrementalAuth extends GitHubAppAuth {
  readonly owner = `github:incremental-${randomUUID()}`;
  constructor() { super({ appId: '7009', clientId: 'synthetic', clientSecret: 'synthetic', privateKey: '', origin: 'http://127.0.0.1' }); }
  override session(req: IncomingMessage): GitHubSession | undefined { return req.headers.cookie === 'synthetic-reviewer' ? { id: 'synthetic-reviewer', ownerId: this.owner, login: 'synthetic-reviewer', csrf: 'synthetic-csrf', expiresAt: Date.now() + 60_000 } : undefined; }
  override async repositories() { return [{ id: 9009, full_name: repository, private: true, installationId: 7009 }]; }
  override async repositoryToken(session: GitHubSession, fullName: string) { await this.authorize(session, fullName); return 'synthetic-server-only-token'; }
  override async credentialsForOwner(ownerId: string, fullName: string) {
    expect(ownerId).toBe(this.owner);
    const session = this.session({ headers: { cookie: 'synthetic-reviewer' } } as IncomingMessage)!;
    return { token: await this.repositoryToken(session, fullName), allowPrivate: true as const };
  }
}

it('configured webhook and explicit reconciliation reuse stored syntax, skip unchanged downloads/parses and resolve changed imports freshly', async () => {
  clearGitHubCacheForTests(); clearImportCacheForTests();
  let currentHead = FIRST;
  const contexts: Record<string, Record<string, string>> = { [FIRST]: initialFiles, [CONFIG_CHANGED]: configFiles, [SOURCE_CHANGED]: changedFiles };
  const downloads: { sha: string; path: string }[] = [];
  const prefix = `/repos/${repository}`;
  const fetcher = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.github.com');
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer synthetic-server-only-token');
    if (url.pathname === prefix) return Response.json({ name: 'webhook-incremental', full_name: repository, private: true, default_branch: 'main', html_url: `https://github.com/${repository}`, owner: { login: 'fixture' } });
    if (url.pathname.startsWith(`${prefix}/commits/`)) { const ref = decodeURIComponent(url.pathname.slice(`${prefix}/commits/`.length)); return Response.json({ sha: ref === 'main' ? currentHead : ref, commit: { message: 'Authored fixture context' }, parents: [] }); }
    if (url.pathname.startsWith(`${prefix}/git/trees/`)) { const sha = url.pathname.split('/').at(-1)!; return Response.json({ truncated: false, tree: Object.entries(contexts[sha]!).map(([path, text]) => ({ path, type: 'blob', mode: '100644', sha: blob(text), size: Buffer.byteLength(text) })) }); }
    if (url.pathname.startsWith(`${prefix}/contents/`)) { const sha = url.searchParams.get('ref')!, path = decodeURIComponent(url.pathname.slice(`${prefix}/contents/`.length)); downloads.push({ sha, path }); const text = contexts[sha]?.[path]; return new Response(text ?? 'missing authored fixture', { status: text === undefined ? 404 : 200 }); }
    if (url.pathname === `${prefix}/pulls` || url.pathname === `${prefix}/commits`) return Response.json([]);
    throw new Error('Unexpected authored GitHub fixture path');
  }) as typeof fetch;
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const store = await createStore({ databaseUrl: databaseUrl ?? '' });
  const inbox = databaseUrl ? await createPostgresWebhookInbox({ databaseUrl }) : new ControlledInbox();
  const auth = new IncrementalAuth(), secret = 'synthetic-incremental-webhook-secret';
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', secret); vi.stubEnv('DATABASE_URL', databaseUrl ?? 'postgresql://synthetic@127.0.0.1/controlled-test');
  // The runtime factory, live-authorized binding lookup, queue, scoped store,
  // baseline projection and analyzer/TypeScript parser are actual implementations.
  // Only GitHub HTTP and session ownership are controlled external boundaries.
  const app = await createApplicationServer({ production: true, auth, store, webhookInbox: inbox,
    resolveAnalysisInput: (input, credentials) => pinAnalysisInput(input, { ...credentials, fetch: fetcher }),
    runAnalysis: (input, options) => analyzeRepository(input, { ...options, fetch: fetcher }),
  });
  try {
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; auth.config.origin = base;
    const headers = { Cookie: 'synthetic-reviewer', Origin: base, 'X-CSRF-Token': 'synthetic-csrf', 'Content-Type': 'application/json' };
    const post = (path: string, value: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(value) });
    const get = (path: string) => fetch(base + path, { headers });
    const ready = async (jobId: string): Promise<GraphSnapshot> => {
      let result: { status: string; snapshot: GraphSnapshot; error?: string };
      await vi.waitFor(async () => { result = await get(`/api/jobs/${jobId}?repository=${repository}`).then(response => response.json()); expect(result.status, result.error).toBe('ready'); }, { timeout: 3000 });
      return result!.snapshot;
    };
    const edgePaths = (graph: GraphSnapshot) => { const paths = new Map(graph.nodes.map(node => [node.id, node.path])); return graph.edges.map(edge => `${paths.get(edge.source)} -> ${paths.get(edge.target)}`).sort(); };
    const initialRequest = await post('/api/analyze', { repository }); expect(initialRequest.status).toBe(202);
    const first = await ready((await initialRequest.json()).jobId);
    expect(first.incremental).toMatchObject({ mode: 'full', eligibleFiles: 4, reusedFiles: 0, fetchedSourceFiles: 4, parsedFiles: 4, parserCacheHits: 0 });
    expect(edgePaths(first)).toContain('src/main.ts -> src/old/target.ts');

    // Clear both process caches: reuse must come from the authorized stored
    // snapshot, not warm HTTP responses or a hidden AST cache.
    clearGitHubCacheForTests(); clearImportCacheForTests(); downloads.length = 0; currentHead = CONFIG_CHANGED;
    const raw = JSON.stringify({ installation: { id: 7009 }, repository: { id: 9009, full_name: repository }, ref: 'refs/heads/main', after: 'UNTRUSTED-PAYLOAD-SHA' });
    const deliveryId = randomUUID();
    const webhook = await fetch(base + '/api/webhooks/github', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': deliveryId, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw });
    expect(webhook.status).toBe(202); expect(await webhook.json()).toMatchObject({ queued: 1 });
    for (let index = 0; index < 10; index++) if (!await app.webhooks!.processOne()) break;
    const feed = await get(`/api/refresh?repository=${repository}`).then(response => response.json());
    const configRefresh = await ready(feed.state.jobId);
    expect(configRefresh.incremental).toMatchObject({ mode: 'incremental', baselineStatus: 'accepted', basisSha: FIRST, reusedFiles: 4, fetchedSourceFiles: 0, parsedFiles: 0, parserCacheHits: 0 });
    expect(downloads).toEqual([{ sha: CONFIG_CHANGED, path: 'tsconfig.json' }]);
    expect(edgePaths(configRefresh)).toContain('src/main.ts -> src/new/target.ts');
    expect(edgePaths(configRefresh)).not.toContain('src/main.ts -> src/old/target.ts');

    clearGitHubCacheForTests(); clearImportCacheForTests(); downloads.length = 0; currentHead = SOURCE_CHANGED;
    const reconcile = await post('/api/refresh/reconcile', { repository, contextRef: 'main' }); expect(reconcile.status).toBe(202);
    const secondJob = (await reconcile.json()).state.jobId, sourceRefresh = await ready(secondJob);
    expect(sourceRefresh.incremental).toMatchObject({ mode: 'incremental', baselineStatus: 'accepted', basisSha: CONFIG_CHANGED, reusedFiles: 3, fetchedSourceFiles: 1, parsedFiles: 1, parserCacheHits: 0, invalidatedFiles: 1 });
    expect(downloads.filter(item => item.path.endsWith('.ts'))).toEqual([{ sha: SOURCE_CHANGED, path: 'src/main.ts' }]);
    expect(edgePaths(sourceRefresh)).toContain('src/main.ts -> src/stable.ts');
    expect(edgePaths(sourceRefresh)).toContain('src/main.ts -> src/new/target.ts');
    for (const edge of sourceRefresh.edges) expect(edge.evidence).toMatchObject({ snapshotSha: SOURCE_CHANGED });
    const stored = await store.getJob({ ownerId: auth.owner, repository }, secondJob);
    expect(stored?.input).not.toHaveProperty('incrementalBaseline');
    expect(JSON.stringify(stored?.input)).not.toMatch(/synthetic-server-only-token|parseFacts|import \{/);
    expect((await get(`/api/snapshots/${encodeURIComponent(first.id)}?repository=${repository}`).then(response => response.json())).contextSha).toBe(FIRST);
    const fileIds = sourceRefresh.nodes.map(node => node.id);
    clearGitHubCacheForTests(); clearImportCacheForTests(); downloads.length = 0;
    const sameShaRequest = await post('/api/refresh/reconcile', { repository, contextRef: 'main' });
    const sameShaJob = (await sameShaRequest.json()).state.jobId, sameSha = await ready(sameShaJob);
    expect(sameShaJob).not.toBe(secondJob); expect(sameSha.id).not.toBe(sourceRefresh.id);
    expect(sameSha.incremental).toMatchObject({ mode: 'incremental', baselineStatus: 'accepted', basisSha: SOURCE_CHANGED, reusedFiles: 4, fetchedSourceFiles: 0, parsedFiles: 0, parserCacheHits: 0 });
    expect(downloads).toEqual([{ sha: SOURCE_CHANGED, path: 'tsconfig.json' }]);
    expect(sameSha.nodes.map(node => node.id)).toEqual(fileIds); expect(edgePaths(sameSha)).toEqual(edgePaths(sourceRefresh));
  } finally {
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); await app.analysisJobs.close(); await app.webhooks?.close();
    vi.unstubAllEnvs(); clearGitHubCacheForTests(); clearImportCacheForTests();
  }
});
