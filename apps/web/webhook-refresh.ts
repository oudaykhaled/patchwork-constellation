import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { verifyWebhook, type StoreScope } from '@patchwork/storage';
import type { RefreshTask, WebhookInbox, RefreshState } from '../../packages/storage/src/webhook-inbox';

export interface InstallationBinding { scope: StoreScope; installationId: number; repositoryId: number; contextRef?: string }
export interface WebhookRefreshOptions {
  secret: string;
  inbox: WebhookInbox;
  /** Only server-side, previously authorized installation bindings; body owner/repo is never authority. */
  resolveInstallation: (installationId: number) => Promise<InstallationBinding[]>;
  resolveScope: (scope: StoreScope) => Promise<InstallationBinding | undefined>;
  /** Must reauthorize, resolve CURRENT refs, and idempotently enqueue in AnalysisJobs. Never trust event SHA. */
  enqueueRefresh: (task: RefreshTask) => Promise<{ jobId: string }>;
  invalidateMetadata: (repository: string) => void | Promise<void>;
  invalidateAuthorization: (installationId: number, repositoryId?: number) => void | Promise<void>;
  /** Must fence/cancel in-flight writes before deleting repository snapshots, jobs and grouping history. */
  purgeRepository: (scope: StoreScope) => Promise<void>;
  allowVolatileInboxForTests?: boolean;
  now?: () => number;
}
function failure(message: string, status = 400) { return Object.assign(new Error(message), { status }); }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function sameScope(left: StoreScope, right: StoreScope) { return left.ownerId === right.ownerId && left.repository.toLowerCase() === right.repository.toLowerCase(); }

export class WebhookRefreshService {
  private working = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: WebhookRefreshOptions) {
    if (options.secret.length < 16) throw failure('A webhook secret of at least 16 characters is required.', 503);
    if (!options.inbox.durable && !options.allowVolatileInboxForTests) throw failure('Webhook ingress requires a durable inbox.', 503);
  }
  async accept(raw: Uint8Array, headers: { signature?: string; deliveryId?: string; event?: string }) {
    let webhook;
    try { webhook = verifyWebhook(raw, headers, this.options.secret); } catch { throw failure('Webhook signature, headers or payload are invalid.', 401); }
    if (webhook.event === 'ping') return { accepted: true, duplicate: false, queued: 0 };
    const payload = webhook.payload;
    const installationId = integer(object(payload.installation).id);
    if (!installationId) throw failure('Webhook installation is required.', 403);
    const bindings = await this.options.resolveInstallation(installationId);
    if (bindings.length > 1000) throw failure('Installation routing exceeds capacity.', 503);
    const action = typeof payload.action === 'string' ? payload.action : '';
    let tasks: RefreshTask[] = [];
    if (webhook.event === 'installation' && ['deleted', 'suspend'].includes(action)) {
      tasks = bindings.map(binding => ({ ...binding, kind: 'revoke', reason: 'installation_deleted' }));
    } else if (webhook.event === 'installation_repositories' && action === 'removed') {
      const removed = Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [];
      if (removed.length > 1000) throw failure('Removal routing exceeds capacity.', 413);
      const ids = new Set(removed.map(value => integer(object(value).id)).filter(Boolean));
      tasks = bindings.filter(binding => ids.has(binding.repositoryId)).map(binding => ({ ...binding, kind: 'revoke', reason: 'repository_removed' }));
    } else if (webhook.event === 'push' || (webhook.event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'edited', 'closed'].includes(action))) {
      const repository = object(payload.repository), repositoryId = integer(repository.id);
      if (!repositoryId || typeof repository.full_name !== 'string') throw failure('Webhook repository is invalid.');
      tasks = bindings.filter(binding => binding.repositoryId === repositoryId && binding.scope.repository.toLowerCase() === String(repository.full_name).toLowerCase()).map(binding => ({ ...binding, kind: 'refresh', reason: webhook.event as 'push' | 'pull_request' }));
    }
    tasks = [...new Map(tasks.map(task => [JSON.stringify([task.scope.ownerId, task.repositoryId, task.kind]), { ...task, refreshVersion: webhook.deliveryId }])).values()];
    // One atomic write persists replay identity AND all work. Failure leaves delivery retryable.
    const inserted = await this.options.inbox.enqueue({ deliveryId: webhook.deliveryId, tasks, createdAt: new Date(this.options.now?.() ?? Date.now()).toISOString() });
    if (inserted && tasks.some(task => task.kind === 'revoke')) {
      // Immediately invalidate broker caches after durable acceptance; purge runs off-request.
      if (webhook.event === 'installation') await this.options.invalidateAuthorization(installationId);
      else for (const repositoryId of new Set(tasks.map(task => task.repositoryId))) await this.options.invalidateAuthorization(installationId, repositoryId);
    }
    return { accepted: true, duplicate: !inserted, queued: inserted ? tasks.length : 0 };
  }
  async processOne(): Promise<boolean> {
    if (this.working || this.stopped) return false;
    this.working = true;
    try {
      const delivery = await this.options.inbox.claim();
      if (!delivery) return false;
      let leaseLost = false;
      const heartbeat = setInterval(() => { void this.options.inbox.renew(delivery).then(valid => { if (!valid) leaseLost = true; }).catch(() => { leaseLost = true; }); }, 20_000);
      heartbeat.unref();
      try {
        for (const task of delivery.tasks) {
          if (leaseLost || this.stopped) throw failure('Webhook work lease interrupted.', 503);
          await this.options.invalidateMetadata(task.scope.repository);
          if (task.kind === 'revoke') {
            await this.options.inbox.mark(task);
            await this.options.invalidateAuthorization(task.installationId, task.reason === 'installation_deleted' ? undefined : task.repositoryId);
            await this.options.purgeRepository(task.scope);
          } else {
            let current: InstallationBinding | undefined;
            try { current = await this.options.resolveScope(task.scope); }
            catch (error) { const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500; if (![401, 403].includes(status)) throw error; }
            if (!current || !sameScope(current.scope, task.scope) || current.installationId !== task.installationId || current.repositoryId !== task.repositoryId) {
              const revoked: RefreshTask = { ...task, kind: 'revoke', reason: 'repository_removed' };
              await this.options.inbox.mark(revoked); await this.options.invalidateAuthorization(task.installationId, task.repositoryId); await this.options.purgeRepository(task.scope); continue;
            }
            // The callback rechecks live access; event ordering/force-push cannot roll refs backward.
            const result = await this.options.enqueueRefresh(task);
            await this.options.inbox.mark(task, result.jobId);
          }
        }
        await this.options.inbox.finish(delivery);
      } catch {
        // Sanitized retry state only; provider/GitHub failures may contain secret-bearing URLs.
        await this.options.inbox.retry(delivery);
      } finally { clearInterval(heartbeat); }
      return true;
    } finally { this.working = false; }
  }
  async state(scope: StoreScope): Promise<RefreshState | undefined> { return this.options.inbox.state(scope); }
  async reconcile(scope: StoreScope, contextRef?: string) {
    const binding = await this.options.resolveScope(scope);
    if (!binding || !sameScope(scope, binding.scope)) throw failure('Repository refresh is not authorized.', 403);
    const task: RefreshTask = { ...binding, ...(contextRef ? { contextRef } : {}), refreshVersion: randomUUID(), kind: 'refresh', reason: 'reconcile' };
    await this.options.invalidateMetadata(scope.repository);
    const result = await this.options.enqueueRefresh(task);
    return this.options.inbox.mark(task, result.jobId);
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.processOne().catch(() => {}); }, 1000);
    this.timer.unref();
    void this.processOne().catch(() => {});
  }
  async close() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.options.inbox.close(); }
}

/** No secret means disabled. A configured but unusable durable store fails closed. */
export async function createConfiguredWebhookRefresh(options: Omit<WebhookRefreshOptions, 'secret' | 'inbox' | 'allowVolatileInboxForTests'>, env: NodeJS.ProcessEnv = process.env, configuredInbox?: WebhookInbox) {
  if (!env.GITHUB_WEBHOOK_SECRET) return undefined;
  if (env.GITHUB_WEBHOOK_SECRET.length < 16) throw failure('A webhook secret of at least 16 characters is required.', 503);
  if (!env.DATABASE_URL) throw failure('Webhook durability requires DATABASE_URL.', 503);
  const { createPostgresWebhookInbox } = await import('@patchwork/storage');
  const inbox = configuredInbox ?? await createPostgresWebhookInbox({ databaseUrl: env.DATABASE_URL, autoMigrate: env.DATABASE_AUTO_MIGRATE !== 'false' });
  try { return new WebhookRefreshService({ ...options, secret: env.GITHUB_WEBHOOK_SECRET, inbox }); }
  catch (error) { await inbox.close(); throw error; }
}

/** This endpoint intentionally precedes browser Origin/CSRF checks; HMAC is its authority. */
export async function handleGitHubWebhook(req: IncomingMessage, res: ServerResponse, service?: WebhookRefreshService) {
  if (!service) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'WEBHOOK_UNCONFIGURED', error: 'Webhook ingress is not configured.' })); return; }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
  if (!req.headers['content-type']?.startsWith('application/json')) throw failure('Use application/json.', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1_048_576) throw failure('Webhook payload exceeds 1 MiB.', 413); chunks.push(Buffer.from(chunk)); }
  const header = (name: string) => { const value = req.headers[name]; return typeof value === 'string' ? value : undefined; };
  const result = await service.accept(Buffer.concat(chunks), { signature: header('x-hub-signature-256'), deliveryId: header('x-github-delivery'), event: header('x-github-event') });
  res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result));
}
