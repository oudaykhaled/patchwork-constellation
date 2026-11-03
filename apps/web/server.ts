import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { validateGraphSnapshot, type GraphSnapshot } from '@patchwork/contracts';
import { demoSnapshot } from '@patchwork/fixtures';
import { listRepositorySources } from '@patchwork/analysis';
import { runAnalysisInWorker, runSourceAnalysisInWorker } from '../worker/src/index';
import { GroupingService } from '@patchwork/ai';
import { parseRepository } from '@patchwork/github';
import { createStore, type SnapshotStore, type StoreScope } from '@patchwork/storage';
import { BusyError, WorkerAdmission } from './worker-admission';
import { AnalysisJobs, pinAnalysisInput, type PinnedAnalysisInput } from './analysis-jobs';
import { graphMetadata, graphChunk, fileDetail } from './graph-api';

try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = resolve(root, 'dist');
const production = process.argv.includes('--production');
const MAX_SNAPSHOTS = 48;
const snapshots = new Map<string, GraphSnapshot>();
const grouping = new GroupingService({ enabled: process.env.AI_ENABLED === 'true', jevApiKey: process.env.TYPESAFE_API_KEY, jevModel: process.env.JEV_MODEL, generativeApiKey: process.env.OPENAI_API_KEY, generativeModel: process.env.OPENAI_MODEL, storagePath: process.env.GROUPING_STORAGE_PATH });
function remember(snapshot: GraphSnapshot) {
  validateGraphSnapshot(snapshot);
  snapshots.set(snapshot.id, snapshot);
  while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
  return snapshot;
}
remember(demoSnapshot);
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Use application/json.'), { status: 415 });
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 128_000) throw Object.assign(new Error('Request exceeds 128 KB.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function getSnapshot(id: string) { const snapshot = snapshots.get(id); if (!snapshot) throw Object.assign(new Error('This snapshot expired. Analyze the repository again.'), { status: 404 }); return snapshot; }
const sourceRequest = z.object({ snapshotId: z.string(), kind: z.enum(['pr', 'commit']), ids: z.array(z.string().max(100)).max(20) });
const analyzeRequest = z.object({ repository: z.string().trim().min(3).max(250), contextRef: z.string().max(200).optional(), mode: z.enum(['pr', 'commit']).optional() });
const idRequest = z.object({ snapshotId: z.string().max(500) });
const rateWindows = new Map<string, { start: number; requests: number }>();

export async function createApplicationServer(options: { production?: boolean; store?: SnapshotStore; runAnalysis?: typeof runAnalysisInWorker; runSources?: typeof runSourceAnalysisInWorker; resolveAnalysisInput?: (input: Parameters<typeof runAnalysisInWorker>[0]) => Promise<PinnedAnalysisInput> } = {}) {
  const useProduction = options.production ?? production;
  const store = options.store ?? await createStore({ maxSnapshots: MAX_SNAPSHOTS, maxJobs: 100 });
  const analyze = options.runAnalysis ?? runAnalysisInWorker;
  const loadSources = options.runSources ?? runSourceAnalysisInWorker;
  const admission = new WorkerAdmission(2);
  const sourceRequests = new Map<string, { controller: AbortController }>();
  const runningTasks = new Set<Promise<unknown>>();
  const snapshotWrites = new Map<string, Promise<unknown>>();
  const snapshotPending = new Map<string, number>();
  const scopeFor = (repository: string): StoreScope => ({ ownerId: 'local-public', repository: parseRepository(repository).fullName.toLowerCase() });
  async function saveSnapshot(snapshot: GraphSnapshot) {
    validateGraphSnapshot(snapshot);
    await store.putSnapshot(scopeFor(snapshot.repository.fullName), snapshot);
    return remember(snapshot);
  }
  async function lookupSnapshot(id: string, repository?: string | null): Promise<GraphSnapshot> {
    const cached = snapshots.get(id);
    if (cached && (!repository || cached.repository.fullName.toLowerCase() === scopeFor(repository).repository)) return cached;
    if (repository) {
      const saved = await store.getSnapshot(scopeFor(repository), id);
      if (saved) return remember(validateGraphSnapshot(saved));
    }
    throw Object.assign(new Error('This snapshot is unavailable. Analyze again, or supply its repository when restoring a saved snapshot.'), { status: 404 });
  }
  async function serialSnapshot<T>(id: string, run: () => Promise<T>): Promise<T> {
    const pending = snapshotPending.get(id) ?? 0;
    if (pending >= 2) throw new BusyError();
    snapshotPending.set(id, pending + 1);
    const previous = snapshotWrites.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    snapshotWrites.set(id, next);
    try { return await next; } finally {
      if (snapshotWrites.get(id) === next) snapshotWrites.delete(id);
      const remaining = (snapshotPending.get(id) ?? 1) - 1;
      if (remaining) snapshotPending.set(id, remaining); else snapshotPending.delete(id);
    }
  }
  const analysisJobs = new AnalysisJobs(store, admission, analyze, snapshot => saveSnapshot(grouping.view(snapshot).snapshot));
  const resolveAnalysisInput = options.resolveAnalysisInput ?? (options.runAnalysis ? async (input: Parameters<typeof runAnalysisInWorker>[0]) => input : pinAnalysisInput);
  analysisJobs.startRecovery();
  await saveSnapshot(structuredClone(demoSnapshot));
  const vite = useProduction ? null : await (await import('vite')).createServer({ configFile: resolve(root, 'apps/web/vite.config.ts'), server: { middlewareMode: true }, appType: 'spa' });
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        // This runnable edition is a local, single-user tool. It only analyzes public repositories.
        const host = req.headers.host ?? '';
        if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return json(res, 403, { error: 'Use the local application address.', code: 'HOST_DENIED' });
        if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.', code: 'ORIGIN_DENIED' });
        const key = req.socket.remoteAddress ?? 'local'; const now = Date.now(); let window = rateWindows.get(key);
        if (!window || now - window.start > 60_000) { window = { start: now, requests: 0 }; rateWindows.set(key, window); }
        if (++window.requests > 240) { res.setHeader('Retry-After', '60'); return json(res, 429, { error: 'Too many requests. Try again shortly.', code: 'RATE_LIMITED', retryAfter: 60 }); }
        if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', version: '0.1.0', mode: 'local-public' });
        if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { mode: 'local-public', github: { publicRepositories: true, privateRepositories: false, configuredToken: Boolean(process.env.GITHUB_TOKEN) }, ai: grouping.capabilities(), storage: store.kind, deployment: 'local', recovery: { snapshots: store.kind === 'postgres', jobs: store.kind === 'postgres', automaticJobResume: store.kind === 'postgres' } });
        if (req.method === 'GET' && url.pathname === '/api/demo') return json(res, 200, await saveSnapshot(grouping.view(structuredClone(demoSnapshot)).snapshot));
        if (req.method === 'GET' && url.pathname.startsWith('/api/snapshots/')) return json(res, 200, await lookupSnapshot(decodeURIComponent(url.pathname.slice(15)), url.searchParams.get('repository')));
        const graphMatch = url.pathname.match(/^\/api\/graphs\/([^/]+)(\/chunks)?$/);
        if (req.method === 'GET' && graphMatch) {
          const snapshot = await lookupSnapshot(decodeURIComponent(graphMatch[1]!), url.searchParams.get('repository'));
          return json(res, 200, graphMatch[2] ? graphChunk(snapshot, url.searchParams) : graphMetadata(snapshot));
        }
        const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
        if (req.method === 'GET' && fileMatch) {
          const snapshot = await lookupSnapshot(decodeURIComponent(fileMatch[1]!), url.searchParams.get('repository'));
          return json(res, 200, fileDetail(snapshot, decodeURIComponent(fileMatch[2]!)));
        }
        if (req.method === 'POST' && url.pathname === '/api/analyze') {
          const input = analyzeRequest.parse(await body(req));
          input.repository = parseRepository(input.repository).fullName;
          const pinned = await resolveAnalysisInput(input);
          return json(res, 202, await analysisJobs.submit(scopeFor(input.repository), pinned));
        }
        const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)(\/cancel)?$/);
        if (jobMatch) {
          const repository = url.searchParams.get('repository');
          const scope = repository ? scopeFor(repository) : undefined;
          if (req.method === 'POST' && jobMatch[2]) {
            const job = await analysisJobs.cancel(jobMatch[1]!, scope);
            return json(res, job ? 200 : 404, job ?? { error: 'Analysis job not found.' });
          }
          if (req.method === 'GET' && !jobMatch[2]) {
            const job = await analysisJobs.get(jobMatch[1]!, scope, url.searchParams.get('includeSnapshot') !== 'false');
            if (job && url.searchParams.has('version') && url.searchParams.get('version') !== job.version) return json(res, 409, { error: 'Analysis version changed. Submit a new analysis.', code: 'STALE_VERSION' });
            return json(res, job ? 200 : 404, job ?? { error: 'Analysis job not found. Supply its repository to reconnect.' });
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/sources') {
          const input = sourceRequest.pick({ snapshotId: true, kind: true }).extend({ page: z.coerce.number().int().min(1).max(100).default(1) }).parse({ snapshotId: url.searchParams.get('snapshotId'), kind: url.searchParams.get('kind'), page: url.searchParams.get('page') ?? 1 });
          const result = await serialSnapshot(input.snapshotId, async () => {
            const snapshot = await lookupSnapshot(input.snapshotId, url.searchParams.get('repository'));
            if (snapshot.mode === 'demo') return { sources: snapshot.sources.filter(source => source.kind === input.kind), nextPage: null, snapshot };
            const page = await listRepositorySources(snapshot.repository.fullName, input.kind, input.page, snapshot.contextSha, { signal: AbortSignal.timeout(30_000) });
            const byId = new Map(snapshot.sources.map(source => [source.id, source]));
            for (const source of page.sources) if (!byId.has(source.id)) byId.set(source.id, source);
            const updated = await saveSnapshot({ ...snapshot, sources: [...byId.values()], sourcePagination: { ...(snapshot.sourcePagination as Record<string, number | null> | undefined), [input.kind]: page.nextPage } });
            return { sources: page.sources.map(source => byId.get(source.id)!), nextPage: page.nextPage, snapshot: updated };
          });
          return json(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/sources') {
          const input = sourceRequest.parse(await body(req));
          const snapshot = getSnapshot(input.snapshotId); const ids = [...new Set(input.ids)];
          if (ids.some(id => !snapshot.sources.some(source => source.id === id && source.kind === input.kind))) throw Object.assign(new Error('Unknown change source.'), { status: 400 });
          if (snapshot.mode === 'demo') return json(res, 200, await serialSnapshot(input.snapshotId, () => saveSnapshot(grouping.view(getSnapshot(input.snapshotId)).snapshot)));
          // A newer selection cancels its predecessor rather than joining a work queue.
          sourceRequests.get(input.snapshotId)?.controller.abort();
          if (ids.every(id => snapshot.sources.find(source => source.id === id)?.loaded === true)) {
            sourceRequests.delete(input.snapshotId);
            return json(res, 200, await serialSnapshot(input.snapshotId, () => saveSnapshot(grouping.view({ ...getSnapshot(input.snapshotId), defaultSelection: ids }).snapshot)));
          }
          const release = admission.reserve();
          const request = { controller: new AbortController() }; sourceRequests.set(input.snapshotId, request);
          const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(90_000)]);
          const disconnect = () => { if (!res.writableEnded) request.controller.abort(); };
          res.once('close', disconnect);
          const superseded = () => { if (signal.aborted || sourceRequests.get(input.snapshotId) !== request) throw Object.assign(new Error('This selection was superseded or cancelled. Retry the latest selection.'), { status: 409, code: 'SUPERSEDED' }); };
          const task = (async () => {
            try {
              const loaded = await loadSources(snapshot, input.kind, ids, { signal });
              superseded();
              return await serialSnapshot(input.snapshotId, async () => {
                superseded();
                const latest = getSnapshot(input.snapshotId);
                const sources = new Map(loaded.sources.map(source => [source.id, source]));
                for (const source of latest.sources) if (!sources.has(source.id)) sources.set(source.id, source);
                return saveSnapshot(grouping.view({ ...loaded, sources: [...sources.values()] }).snapshot);
              });
            } catch (error) { superseded(); throw error; }
            finally { res.removeListener('close', disconnect); if (sourceRequests.get(input.snapshotId) === request) sourceRequests.delete(input.snapshotId); release(); }
          })();
          runningTasks.add(task);
          void task.finally(() => runningTasks.delete(task)).catch(() => {});
          return json(res, 200, await task);
        }
        if (req.method === 'POST' && url.pathname === '/api/grouping') {
          const input = idRequest.extend({ enabled: z.boolean().default(false) }).parse(await body(req));
          return json(res, 200, await grouping.propose(getSnapshot(input.snapshotId), { enabled: input.enabled, tenantId: 'local', signal: AbortSignal.timeout(60_000) }));
        }
        if (req.method === 'POST' && url.pathname === '/api/grouping/apply') {
          const input = idRequest.extend({ proposalId: z.string().max(500) }).parse(await body(req)); const result = await serialSnapshot(input.snapshotId, async () => { const value = await grouping.apply(getSnapshot(input.snapshotId), input.proposalId); await saveSnapshot(value.snapshot); return value; }); return json(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/grouping/mutate') {
          const input = idRequest.extend({ operation: z.unknown() }).parse(await body(req)); const result = await serialSnapshot(input.snapshotId, async () => { const value = await grouping.mutate(getSnapshot(input.snapshotId), input.operation as Parameters<typeof grouping.mutate>[1]); await saveSnapshot(value.snapshot); return value; }); return json(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/grouping/undo') { const input = idRequest.parse(await body(req)); const result = await serialSnapshot(input.snapshotId, async () => { const value = await grouping.undo(getSnapshot(input.snapshotId)); await saveSnapshot(value.snapshot); return value; }); return json(res, 200, result); }
        return json(res, 404, { error: 'API route not found.' });
      }
      if (!useProduction && vite) return vite.middlewares(req, res, () => json(res, 404, { error: 'Not found' }));
      if (!['GET', 'HEAD'].includes(req.method ?? '')) return json(res, 405, { error: 'Method not allowed.' });
      const requested = resolve(dist, '.' + decodeURIComponent(url.pathname));
      if (requested !== dist && !requested.startsWith(dist + sep)) return json(res, 403, { error: 'Invalid path.' });
      let file = requested; try { if (!(await stat(file)).isFile()) file = resolve(dist, 'index.html'); } catch { file = resolve(dist, 'index.html'); }
      const mime: Record<string,string> = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.png':'image/png', '.ico':'image/x-icon' };
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); res.setHeader('Cache-Control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600');
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : typeof error === 'object' && error && 'status' in error ? Number(error.status) || 500 : 500;
      if (error instanceof BusyError) res.setHeader('Retry-After', String(error.retryAfter));
      const code = error instanceof z.ZodError ? 'VALIDATION' : typeof error === 'object' && error && 'code' in error ? String(error.code) : 'REQUEST_FAILED';
      if (!res.headersSent) json(res, status >= 400 && status < 600 ? status : 500, { error: safeError(error), code }); else res.end();
    }
  });
  server.on('close', () => { for (const request of sourceRequests.values()) request.controller.abort(); void vite?.close(); void Promise.allSettled([...runningTasks, analysisJobs.close()]).then(() => store.close()); });
  return server;
}
function safeError(error: unknown) { const message = error instanceof Error ? error.message : 'Request failed.'; return message.replace(/(?:gh[pousr]_[a-zA-Z0-9]+|sk-[a-zA-Z0-9_-]+)/g, '[redacted]').slice(0, 500); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApplicationServer(); const port = Number(process.env.PORT ?? 4310);
  server.listen(port, '127.0.0.1', () => console.log(`Constellation ready at http://127.0.0.1:${port}`));
}
