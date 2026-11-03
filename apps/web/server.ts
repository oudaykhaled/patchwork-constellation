import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
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
import { RepositoryFences } from './repository-fences';
import { checkWorkerHealth } from '../worker/src/health';
import { ConfigurationError, validateEnvironment } from './environment';
import { GitHubAppAuth, githubAuthConfig, AuthError, type GitHubSession } from './github-auth';
import { publicErrorCode, publicErrorMessage, PRODUCTION_CONTENT_SECURITY_POLICY } from './public-errors';

let environmentLoadFailure = false;
try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') environmentLoadFailure = true; }
const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = resolve(root, 'dist');
const production = process.argv.includes('--production');
const MAX_SNAPSHOTS = 48;
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
const requestBodies = new WeakMap<IncomingMessage, unknown>();
async function body(req: IncomingMessage) {
  if (requestBodies.has(req)) return requestBodies.get(req);
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Use application/json.'), { status: 415 });
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 128_000) throw Object.assign(new Error('Request exceeds 128 KB.'), { status: 413 }); chunks.push(chunk); }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); requestBodies.set(req, value); return value; } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

const sourceRequest = z.object({ snapshotId: z.string(), kind: z.enum(['pr', 'commit']), ids: z.array(z.string().max(100)).max(20) });
const analyzeRequest = z.object({ repository: z.string().trim().min(3).max(250), contextRef: z.string().max(200).optional(), mode: z.enum(['pr', 'commit']).optional() });
const idRequest = z.object({ snapshotId: z.string().max(500) });

export async function createApplicationServer(options: { production?: boolean; store?: SnapshotStore; runAnalysis?: typeof runAnalysisInWorker; runSources?: typeof runSourceAnalysisInWorker; resolveAnalysisInput?: (input: Parameters<typeof runAnalysisInWorker>[0], credentials?: Parameters<typeof pinAnalysisInput>[1]) => Promise<PinnedAnalysisInput>; auth?: GitHubAppAuth | null } = {}) {
  if (environmentLoadFailure) throw new ConfigurationError(['The .env file could not be read. Check its format and file permissions.']);
  validateEnvironment();
  const requestScope = new AsyncLocalStorage<{ ownerId: string; epochs: Map<string, number> }>();
  const ownerId = () => requestScope.getStore()?.ownerId ?? 'local-public';
  const snapshotKey = (id: string) => `${ownerId()}:${id}`;
  const snapshots = new Map<string, GraphSnapshot>();
  const grouping = new GroupingService({ enabled: process.env.AI_ENABLED === 'true', jevApiKey: process.env.TYPESAFE_API_KEY, jevModel: process.env.JEV_MODEL, generativeApiKey: process.env.OPENAI_API_KEY, generativeModel: process.env.OPENAI_MODEL, storagePath: process.env.GROUPING_STORAGE_PATH });
  function remember(snapshot: GraphSnapshot) {
    validateGraphSnapshot(snapshot);
    snapshots.set(snapshotKey(snapshot.id), snapshot);
    while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
    return snapshot;
  }
  remember(demoSnapshot);
  
  function getSnapshot(id: string) { const snapshot = snapshots.get(snapshotKey(id)); if (!snapshot) throw Object.assign(new Error('This snapshot expired. Analyze the repository again.'), { status: 404 }); const scope = scopeFor(snapshot.repository.fullName); repositoryFences.assert(scope, expectedEpoch(scope)); return snapshot; }
  const rateWindows = new Map<string, { start: number; requests: number }>();
  const repositoryFences = new RepositoryFences();
  const useProduction = options.production ?? production;
  const store = options.store ?? await createStore({ maxSnapshots: MAX_SNAPSHOTS, maxJobs: 100 });
  const analyze = options.runAnalysis ?? runAnalysisInWorker;
  const loadSources = options.runSources ?? runSourceAnalysisInWorker;
  const admission = new WorkerAdmission(2);
  const authConfig = options.auth === undefined ? githubAuthConfig() : undefined;
  const auth = options.auth === undefined ? (authConfig ? new GitHubAppAuth(authConfig) : undefined) : options.auth ?? undefined;
  const ownerGroupings = new Map<string, GroupingService>();
  const groupingForOwner = () => {
    if (!auth) return grouping;
    const id = ownerId(); let service = ownerGroupings.get(id);
    if (!service) { if (ownerGroupings.size >= 128) ownerGroupings.delete(ownerGroupings.keys().next().value!); service = new GroupingService({ enabled: process.env.AI_ENABLED === 'true', jevApiKey: process.env.TYPESAFE_API_KEY, jevModel: process.env.JEV_MODEL, generativeApiKey: process.env.OPENAI_API_KEY, generativeModel: process.env.OPENAI_MODEL }); ownerGroupings.set(id, service); }
    return service;
  };
  const sourceRequests = new Map<string, { controller: AbortController; scope: StoreScope }>();
  const groupingRequests = new Set<{ controller: AbortController; scope: StoreScope }>();
  const runningTasks = new Set<Promise<unknown>>();
  const snapshotWrites = new Map<string, Promise<unknown>>();
  const snapshotPending = new Map<string, number>();
  let workerHealth: { checkedAt: number; result: Promise<{ status: 'ok'; schemaVersion: '1' }> } | undefined;
  const scopeKey = (scope: StoreScope) => JSON.stringify([scope.ownerId, scope.repository.toLowerCase()]);
  const expectedEpoch = (scope: StoreScope) => {
    const epochs = requestScope.getStore()?.epochs, key = scopeKey(scope);
    if (epochs?.has(key)) return epochs.get(key)!;
    const epoch = repositoryFences.capture(scope); epochs?.set(key, epoch); return epoch;
  };
  const scopeFor = (repository: string): StoreScope => { const scope = { ownerId: ownerId(), repository: parseRepository(repository).fullName.toLowerCase() }; expectedEpoch(scope); return scope; };
  async function saveSnapshot(snapshot: GraphSnapshot, isCurrent: () => boolean = () => true) {
    validateGraphSnapshot(snapshot); const scope = scopeFor(snapshot.repository.fullName), epoch = expectedEpoch(scope);
    return repositoryFences.write(scope, epoch, async () => {
      if (auth && scope.ownerId !== 'local-public' && snapshot.mode !== 'demo') await auth.credentialsForOwner(scope.ownerId, scope.repository);
      repositoryFences.assert(scope, epoch); if (!isCurrent()) throw new AuthError('Repository analysis was invalidated.', 409, 'REPOSITORY_INVALIDATED');
      await store.putSnapshot(scope, snapshot);
      repositoryFences.assert(scope, epoch); if (!isCurrent()) throw new AuthError('Repository analysis was invalidated.', 409, 'REPOSITORY_INVALIDATED');
      return remember(snapshot);
    });
  }
  async function lookupSnapshot(id: string, repository?: string | null): Promise<GraphSnapshot> {
    const cached = snapshots.get(snapshotKey(id));
    if (cached && (!repository || cached.repository.fullName.toLowerCase() === scopeFor(repository).repository)) { const scope = scopeFor(cached.repository.fullName); repositoryFences.assert(scope, expectedEpoch(scope)); return cached; }
    if (repository) {
      const scope = scopeFor(repository), epoch = expectedEpoch(scope); const saved = await store.getSnapshot(scope, id);
      repositoryFences.assert(scope, epoch);
      if (saved) return remember(validateGraphSnapshot(saved));
    }
    throw Object.assign(new Error('This snapshot is unavailable. Analyze again, or supply its repository when restoring a saved snapshot.'), { status: 404 });
  }
  async function serialSnapshot<T>(id: string, run: () => Promise<T>): Promise<T> {
    id = snapshotKey(id);
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
  const analysisJobs = new AnalysisJobs(store, admission, analyze,
    (snapshot, scope, isCurrent) => requestScope.run({ ownerId: scope.ownerId, epochs: new Map() }, () => saveSnapshot(groupingForOwner().view(snapshot, { tenantId: scope.ownerId }).snapshot, isCurrent)),
    auth ? scope => auth.credentialsForOwner(scope.ownerId, scope.repository) : undefined);
  const resolveAnalysisInput = options.resolveAnalysisInput ?? (options.runAnalysis ? async (input: Parameters<typeof runAnalysisInWorker>[0]) => input : pinAnalysisInput);
  if (!auth) analysisJobs.startRecovery();
  await saveSnapshot(structuredClone(demoSnapshot));
  const vite = useProduction ? null : await (await import('vite')).createServer({ configFile: resolve(root, 'apps/web/vite.config.ts'), server: { middlewareMode: true }, appType: 'spa' });
  const server = createServer((req, res) => requestScope.run({ ownerId: 'local-public', epochs: new Map() }, async () => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (useProduction) res.setHeader('Content-Security-Policy', PRODUCTION_CONTENT_SECURITY_POLICY);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        // This runnable edition is a local, single-user tool. It only analyzes public repositories.
        const host = req.headers.host ?? '';
        if (auth ? host !== new URL(auth.config.origin).host : !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return json(res, 403, { error: 'Use the configured application address.', code: 'HOST_DENIED' });
        if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.', code: 'ORIGIN_DENIED' });
        const key = req.socket.remoteAddress ?? 'local'; const now = Date.now(); let window = rateWindows.get(key);
        if (!window || now - window.start > 60_000) { window = { start: now, requests: 0 }; rateWindows.set(key, window); }
        if (++window.requests > 240) { res.setHeader('Retry-After', '60'); return json(res, 429, { error: 'Too many requests. Try again shortly.', code: 'RATE_LIMITED', retryAfter: 60 }); }
        if (url.pathname.startsWith('/api/auth/')) {
          if (!auth) return json(res, 200, { configured: false, authenticated: false, code: 'AUTH_UNCONFIGURED' });
          if (req.method === 'GET' && url.pathname === '/api/auth/login') { res.writeHead(302, { Location: auth.begin(res), 'Cache-Control': 'no-store' }); return res.end(); }
          if (req.method === 'GET' && url.pathname === '/api/auth/callback') { await auth.complete(req, res, url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? ''); res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
          if (req.method === 'GET' && url.pathname === '/api/auth/session') { const session = auth.session(req); return json(res, 200, session ? { configured: true, authenticated: true, login: session.login, csrf: session.csrf, expiresAt: session.expiresAt } : { configured: true, authenticated: false }); }
          if (req.method === 'POST' && url.pathname === '/api/auth/disconnect') { auth.disconnect(req, res); return json(res, 200, { authenticated: false }); }
          if (req.method === 'GET' && url.pathname === '/api/auth/repositories') return json(res, 200, { repositories: await auth.repositories(auth.requireSession(req)) });
          return json(res, 404, { error: 'Authentication route not found.' });
        }
        let session: GitHubSession | undefined; let repositoryToken: string | undefined;
        const publicRoute = ['/api/health', '/api/health/worker', '/api/config', '/api/demo'].includes(url.pathname);
        if (auth && !publicRoute) {
          session = auth.requireSession(req); requestScope.getStore()!.ownerId = session.ownerId;
          if (!['GET', 'HEAD'].includes(req.method ?? '')) auth.csrf(req, session);
          const payload = req.method === 'POST' ? await body(req) : undefined;
          let repository = url.searchParams.get('repository') ?? undefined;
          if (url.pathname === '/api/analyze') repository = parseRepository(analyzeRequest.parse(payload).repository).fullName;
          const resourceSnapshot = url.pathname.match(/^\/api\/(?:snapshots|graphs|files)\/([^/]+)/)?.[1];
          const snapshotId = resourceSnapshot ? decodeURIComponent(resourceSnapshot) : typeof payload === 'object' && payload && 'snapshotId' in payload && typeof payload.snapshotId === 'string' ? payload.snapshotId : url.searchParams.get('snapshotId');
          if (snapshotId) {
            const cached = snapshots.get(snapshotKey(snapshotId));
            if (cached?.mode === 'demo') repository = undefined;
            else if (cached) repository = cached.repository.fullName;
            else if (!repository) throw new AuthError('Snapshot not found in your account. Supply its repository or analyze again.', 404, 'SNAPSHOT_NOT_FOUND');
          }
          const requestedJob = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)/)?.[1];
          if (requestedJob) { const scope = analysisJobs.scopeForOwner(requestedJob, session.ownerId); repository = scope?.repository ?? repository; if (!repository) throw new AuthError('Analysis job not found. Supply its repository to recover it.', 404, 'JOB_NOT_FOUND'); }
          if (repository) { scopeFor(repository); repositoryToken = await auth.repositoryToken(session, repository); }
        } else if (auth && url.pathname === '/api/demo') { const optionalSession = auth.session(req); if (optionalSession) requestScope.getStore()!.ownerId = optionalSession.ownerId; }
        const grouping = groupingForOwner();
        if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', version: '0.1.0', mode: 'local-public' });
        if (req.method === 'GET' && url.pathname === '/api/health/worker') {
          if (!workerHealth || Date.now() - workerHealth.checkedAt > 10_000) workerHealth = { checkedAt: Date.now(), result: checkWorkerHealth() };
          try { return json(res, 200, await workerHealth.result); }
          catch { return json(res, 503, { status: 'unavailable', code: 'WORKER_UNAVAILABLE', error: 'The analysis worker could not start. Restart the server and check the Node.js installation.' }); }
        }
        if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { mode: auth ? 'github-app' : 'local-public', github: { publicRepositories: true, privateRepositories: Boolean(auth), configuredToken: Boolean(process.env.GITHUB_TOKEN), appConfigured: Boolean(auth), loginUrl: auth ? '/api/auth/login' : null }, ai: grouping.capabilities(), storage: store.kind, deployment: 'local', recovery: { snapshots: store.kind === 'postgres', jobs: store.kind === 'postgres', automaticJobResume: store.kind === 'postgres' } });
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
          const pinned = await resolveAnalysisInput(input, { token: repositoryToken, allowPrivate: Boolean(auth && repositoryToken) });
          return json(res, 202, await analysisJobs.submit(scopeFor(input.repository), pinned));
        }
        const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)(\/cancel)?$/);
        if (jobMatch) {
          const repository = url.searchParams.get('repository');
          const scope = repository ? scopeFor(repository) : auth ? analysisJobs.scopeForOwner(jobMatch[1]!, ownerId()) : undefined;
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
            const page = await listRepositorySources(snapshot.repository.fullName, input.kind, input.page, snapshot.contextSha, { token: repositoryToken, allowPrivate: Boolean(auth && repositoryToken), signal: AbortSignal.timeout(30_000) });
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
          const sourceKey = snapshotKey(input.snapshotId);
          sourceRequests.get(sourceKey)?.controller.abort();
          if (ids.every(id => snapshot.sources.find(source => source.id === id)?.loaded === true)) {
            sourceRequests.delete(sourceKey);
            return json(res, 200, await serialSnapshot(input.snapshotId, () => saveSnapshot(grouping.view({ ...getSnapshot(input.snapshotId), defaultSelection: ids }).snapshot)));
          }
          const release = admission.reserve();
          const request = { controller: new AbortController(), scope: scopeFor(snapshot.repository.fullName) }; sourceRequests.set(sourceKey, request);
          const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(90_000)]);
          const disconnect = () => { if (!res.writableEnded) request.controller.abort(); };
          res.once('close', disconnect);
          const superseded = () => { if (signal.aborted || sourceRequests.get(sourceKey) !== request) throw Object.assign(new Error('This selection was superseded or cancelled. Retry the latest selection.'), { status: 409, code: 'SUPERSEDED' }); };
          const task = (async () => {
            try {
              const loaded = await loadSources(snapshot, input.kind, ids, { token: repositoryToken, allowPrivate: Boolean(auth && repositoryToken), signal });
              superseded();
              return await serialSnapshot(input.snapshotId, async () => {
                superseded();
                const latest = getSnapshot(input.snapshotId);
                const sources = new Map(loaded.sources.map(source => [source.id, source]));
                for (const source of latest.sources) if (!sources.has(source.id)) sources.set(source.id, source);
                return saveSnapshot(grouping.view({ ...loaded, sources: [...sources.values()] }).snapshot);
              });
            } catch (error) { superseded(); throw error; }
            finally { res.removeListener('close', disconnect); if (sourceRequests.get(sourceKey) === request) sourceRequests.delete(sourceKey); release(); }
          })();
          runningTasks.add(task);
          void task.finally(() => runningTasks.delete(task)).catch(() => {});
          return json(res, 200, await task);
        }
        if (req.method === 'POST' && url.pathname === '/api/grouping') {
          const input = idRequest.extend({ enabled: z.boolean().default(false) }).parse(await body(req));
          return json(res, 200, await grouping.propose(getSnapshot(input.snapshotId), { enabled: input.enabled, tenantId: ownerId(), signal: AbortSignal.timeout(60_000) }));
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
      const code = publicErrorCode(error);
      if (!res.headersSent) json(res, status >= 400 && status < 600 ? status : 500, { error: safeError(error), code }); else res.end();
    }
  }));
  server.on('close', () => { for (const request of sourceRequests.values()) request.controller.abort(); void vite?.close(); void Promise.allSettled([...runningTasks, analysisJobs.close()]).then(() => store.close()); });
  return server;
}
function safeError(error: unknown) { return publicErrorMessage(error); }

/** Startup failures remain visible in the browser, without silently falling back from a configured database. */
export function createStartupFailureServer(error: unknown) {
  const message = error instanceof ConfigurationError ? error.message : 'The configured server services could not start. Check the database connection and local configuration, then restart the server.';
  const escapedMessage = message.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return createServer((req, res) => {
    if ((req.url ?? '/').startsWith('/api/')) return json(res, 503, { status: 'unavailable', code: 'CONFIGURATION_ERROR', error: message });
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Constellation configuration</title><body style="background:#0c1013;color:#eaf2ed;font:18px system-ui;max-width:44rem;margin:12vh auto;padding:24px"><main><h1>Constellation needs configuration</h1><p role="alert">${escapedMessage}</p><p>Update your server environment or <code>.env</code>, then stop and restart the app. The credential-free demo uses no external services when <code>DATABASE_URL</code> is empty.</p></main></body></html>`);
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let server;
  let port = 4310;
  let configured = true;
  try { port = validateEnvironment().port; server = await createApplicationServer(); }
  catch (error) { configured = false; server = createStartupFailureServer(error); console.error(error instanceof ConfigurationError ? error.message : 'Constellation startup failed. Check server configuration.'); }
  server.listen(port, '127.0.0.1', () => console.log(`Constellation ${configured ? 'ready' : 'configuration error'} at http://127.0.0.1:${port}`));
}
