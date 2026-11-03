import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateGraphSnapshot, type GraphSnapshot } from '@patchwork/contracts';
import { demoSnapshot } from '@patchwork/fixtures';
import { listRepositorySources } from '@patchwork/analysis';
import { runAnalysisInWorker, runSourceAnalysisInWorker } from '../worker/src/index';
import { GroupingService } from '@patchwork/ai';
import { parseRepository } from '@patchwork/github';
import { createStore, newJob, type SnapshotStore, type StoreScope } from '@patchwork/storage';
import { BusyError, WorkerAdmission } from './worker-admission';
import { OperationalMetrics, readiness, type QueueOperations } from './operations';

try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = resolve(root, 'dist');
const production = process.argv.includes('--production');
const MAX_SNAPSHOTS = 48;
const snapshots = new Map<string, GraphSnapshot>();
const jobs = new Map<string, Job>();
const aborts = new Map<string, AbortController>();
const grouping = new GroupingService({ enabled: process.env.AI_ENABLED === 'true', jevApiKey: process.env.TYPESAFE_API_KEY, jevModel: process.env.JEV_MODEL, generativeApiKey: process.env.OPENAI_API_KEY, generativeModel: process.env.OPENAI_MODEL, storagePath: process.env.GROUPING_STORAGE_PATH });
type Job = { id: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'; progress: number; message: string; snapshot?: GraphSnapshot; error?: string; code?: string; createdAt: string };
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

export async function createApplicationServer(options: { production?: boolean; store?: SnapshotStore; runAnalysis?: typeof runAnalysisInWorker; runSources?: typeof runSourceAnalysisInWorker } = {}) {
  const useProduction = options.production ?? production;
  const store = options.store ?? await createStore({ maxSnapshots: MAX_SNAPSHOTS, maxJobs: 100 });
  const analyze = options.runAnalysis ?? runAnalysisInWorker;
  const loadSources = options.runSources ?? runSourceAnalysisInWorker;
  const admission = new WorkerAdmission(2);
  const operations = new OperationalMetrics();
  const queueOperations = async (): Promise<QueueOperations> => {
    const current = [...jobs.values()]; const queued = current.filter(job => job.status === 'queued');
    return { queuedJobs: queued.length, leasedJobs: current.filter(job => job.status === 'running').length, oldestQueuedAgeMs: queued.length ? Math.max(...queued.map(job => Math.max(0, Date.now() - Date.parse(job.createdAt)))) : null, activeWorkersInProcess: current.filter(job => job.status === 'running').length, failuresSinceProcessStart: current.filter(job => job.status === 'failed').length, stopping: false };
  };
  const sourceRequests = new Map<string, { controller: AbortController }>();
  const runningTasks = new Set<Promise<unknown>>();
  const jobScopes = new Map<string, StoreScope>();
  const inFlightAnalyses = new Map<string, string>();
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
        if (req.method === 'GET' && url.pathname === '/api/readiness') {
          const result = await readiness({ storage: () => store.getSnapshot(scopeFor(demoSnapshot.repository.fullName), demoSnapshot.id), queue: queueOperations, productionAssets: () => useProduction ? stat(resolve(dist, 'index.html')) : Promise.resolve(true) });
          return json(res, result.status === 'ready' ? 200 : 503, result);
        }
        if (req.method === 'GET' && url.pathname === '/api/metrics' && process.env.OPS_METRICS_ENABLED === 'true') return json(res, 200, operations.snapshot(await queueOperations()));
        if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { mode: 'local-public', github: { publicRepositories: true, privateRepositories: false, configuredToken: Boolean(process.env.GITHUB_TOKEN) }, ai: grouping.capabilities(), storage: store.kind, deployment: 'local', recovery: { snapshots: store.kind === 'postgres', jobs: store.kind === 'postgres', automaticJobResume: false } });
        if (req.method === 'GET' && url.pathname === '/api/demo') return json(res, 200, await saveSnapshot(grouping.view(structuredClone(demoSnapshot)).snapshot));
        if (req.method === 'GET' && url.pathname.startsWith('/api/snapshots/')) return json(res, 200, await lookupSnapshot(decodeURIComponent(url.pathname.slice(15)), url.searchParams.get('repository')));
        if (req.method === 'POST' && url.pathname === '/api/analyze') {
          const input = analyzeRequest.parse(await body(req));
          input.repository = parseRepository(input.repository).fullName;
          const analysisKey = JSON.stringify(input);
          const existingId = inFlightAnalyses.get(analysisKey);
          if (existingId) return json(res, 202, { jobId: existingId, reused: true });
          const release = admission.reserve();
          const id = randomUUID(); const controller = new AbortController(); const job: Job = { id, status: 'queued', progress: 0, message: 'Preparing analysis…', createdAt: new Date().toISOString() };
          const scope = scopeFor(input.repository); const persisted = newJob(input, { id, maxAttempts: 1 });
          persisted.leaseOwner = `local-bff:${process.pid}`; persisted.leaseExpiresAt = new Date(Date.now() + 240_000).toISOString();
          // Reserve identity and capacity before the first asynchronous database write.
          inFlightAnalyses.set(analysisKey, id);
          jobScopes.set(id, scope); jobs.set(id, job); aborts.set(id, controller);
          try { await store.putJob(scope, persisted); } catch (error) {
            inFlightAnalyses.delete(analysisKey); aborts.delete(id); release(); job.status = 'failed'; job.error = 'Analysis could not be persisted. Check the configured database and retry.'; job.code = 'STORAGE_FAILED'; throw error;
          }
          if (controller.signal.aborted) {
            job.status = 'cancelled'; job.message = 'Analysis cancelled';
            try { await store.cancelJob(scope, id); } finally { inFlightAnalyses.delete(analysisKey); aborts.delete(id); release(); }
            return json(res, 202, { jobId: id });
          }
          job.status = 'running'; job.message = 'Resolving repository…';
          let writes: Promise<void> = Promise.resolve();
          const persist = () => {
            persisted.progress = job.progress; persisted.updatedAt = new Date().toISOString();
            persisted.error = job.error; persisted.input = { ...input, progressMessage: job.message };
            const value = structuredClone(persisted);
            writes = writes.catch(() => {}).then(() => store.putJob(scope, value));
            return writes;
          };
          while (jobs.size > 100) { const oldest = [...jobs].find(([,v]) => !['running','queued'].includes(v.status)); if (!oldest) break; jobs.delete(oldest[0]); }
          const timeout = setTimeout(() => controller.abort(), 180_000);
          // Work is bounded and asynchronous in this process. Persisted interrupted jobs
          // remain inspectable, but automatic restart/resume is intentionally not claimed.
          const task = Promise.resolve().then(() => analyze(input, { signal: controller.signal, onProgress: p => {
            job.progress = p.progress; job.message = p.message; persisted.status = p.stage === 'indexing' ? 'indexing' : 'fetching';
            void persist().catch(() => { controller.abort(); job.code = 'STORAGE_FAILED'; });
          } })).then(async snapshot => {
            if (controller.signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
            await writes;
            job.snapshot = await saveSnapshot(grouping.view(snapshot).snapshot); job.progress = 100; job.message = 'Graph ready';
            persisted.status = snapshot.coverage.status === 'complete' ? 'ready' : 'partial'; persisted.snapshotId = snapshot.id;
            delete persisted.leaseOwner; delete persisted.leaseExpiresAt;
            await persist(); job.status = 'ready';
          }).catch(async (error: unknown) => {
            job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = controller.signal.aborted ? 'Analysis cancelled or exceeded its time limit.' : safeError(error);
            job.code ??= typeof error === 'object' && error && 'code' in error ? String(error.code) : 'ANALYSIS_FAILED'; persisted.status = job.status;
            delete persisted.leaseOwner; delete persisted.leaseExpiresAt;
            try { await persist(); } catch { job.code = 'STORAGE_FAILED'; job.error = 'Analysis state could not be persisted. Check the configured database and retry.'; }
          }).finally(() => { operations.recordAnalysis(Math.max(0, Date.now() - Date.parse(job.createdAt)), job.status === 'failed'); clearTimeout(timeout); aborts.delete(id); inFlightAnalyses.delete(analysisKey); runningTasks.delete(task); release(); });
          runningTasks.add(task);
          return json(res, 202, { jobId: id });
        }
        const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)(\/cancel)?$/);
        if (jobMatch) {
          let job = jobs.get(jobMatch[1]!);
          let scope = jobScopes.get(jobMatch[1]!);
          const repository = url.searchParams.get('repository');
          if (repository) { const requestedScope = scopeFor(repository); if (scope && scope.repository !== requestedScope.repository) return json(res, 404, { error: 'Analysis job not found.' }); scope = requestedScope; }
          if (!job && scope) {
            const saved = await store.getJob(scope, jobMatch[1]!);
            if (saved) {
              const terminal = ['ready', 'partial', 'failed', 'cancelled'].includes(saved.status);
              if (!terminal) { saved.status = 'failed'; saved.error = 'The server restarted during this analysis. Start it again to retry.'; saved.updatedAt = new Date().toISOString(); await store.putJob(scope, saved); }
              const snapshot = saved.snapshotId ? await store.getSnapshot(scope, saved.snapshotId) : undefined;
              job = { id: saved.id, status: saved.status === 'ready' || saved.status === 'partial' ? 'ready' : saved.status === 'cancelled' ? 'cancelled' : 'failed', progress: saved.progress, message: saved.error ?? String(saved.input.progressMessage ?? 'Stored analysis'), createdAt: saved.createdAt, error: saved.error, snapshot: snapshot ? remember(validateGraphSnapshot(snapshot)) : undefined };
              jobs.set(job.id, job); jobScopes.set(job.id, scope);
            }
          }
          if (!job) return json(res, 404, { error: 'Analysis job not found. Supply its repository to restore a persisted job.' });
          if (req.method === 'POST' && jobMatch[2]) { if (job.status === 'running' || job.status === 'queued') { aborts.get(job.id)?.abort(); job.status = 'cancelled'; job.message = 'Analysis cancelled'; if (scope) await store.cancelJob(scope, job.id); } return json(res, 200, job); }
          if (req.method === 'GET' && !jobMatch[2]) return json(res, 200, job);
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
  server.on('close', () => { for (const controller of aborts.values()) controller.abort(); for (const request of sourceRequests.values()) request.controller.abort(); void vite?.close(); void Promise.allSettled([...runningTasks]).then(() => store.close()); });
  return server;
}
function safeError(error: unknown) { const message = error instanceof Error ? error.message : 'Request failed.'; return message.replace(/(?:gh[pousr]_[a-zA-Z0-9]+|sk-[a-zA-Z0-9_-]+)/g, '[redacted]').slice(0, 500); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApplicationServer(); const port = Number(process.env.PORT ?? 4310);
  server.listen(port, '127.0.0.1', () => console.log(`Constellation ready at http://127.0.0.1:${port}`));
}
