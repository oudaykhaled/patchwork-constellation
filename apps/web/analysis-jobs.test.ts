import { describe, expect, it, vi } from 'vitest';
import { createStore, newJob, type StoreScope } from '@patchwork/storage';
import { demoSnapshot } from '@patchwork/fixtures';
import { AnalysisJobs, analysisJobId, pinAnalysisInput } from './analysis-jobs';
import { WorkerAdmission } from './worker-admission';
import type { runAnalysisInWorker } from '../worker/src/index';

const scope: StoreScope = { ownerId: 'local-public', repository: demoSnapshot.repository.fullName };
const input = { repository: scope.repository, contextRef: 'a'.repeat(40), displayContextRef: 'main', mode: 'pr' as const };
describe('durable analysis coordination', () => {
  it('pins an authorized private ref using server credentials while preserving its display ref', async () => {
    const headers: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      headers.push(new Headers(options?.headers).get('authorization')!);
      return new Response(JSON.stringify(String(url).includes('/commits/') ? { sha: 'c'.repeat(40) } : { private: true, default_branch: 'trunk' }), { status: 200 });
    }) as unknown as typeof fetch;
    const pinned = await pinAnalysisInput({ repository: 'acme/private' }, { token: 'server-only', allowPrivate: true, fetch: fetcher });
    expect(pinned).toMatchObject({ contextRef: 'c'.repeat(40), displayContextRef: 'trunk' }); expect(headers).toEqual(['Bearer server-only', 'Bearer server-only']);
    expect(JSON.stringify(pinned)).not.toContain('server-only');
    await expect(pinAnalysisInput({ repository: 'another/private' }, { fetch: fetcher })).rejects.toMatchObject({ code: 'PRIVATE_UNSUPPORTED' });
  });
  it('atomically deduplicates pinned work, completed results and owner scopes', async () => {
    const store = await createStore({ databaseUrl: '' });
    let resolve!: (value: typeof demoSnapshot) => void;
    const run: typeof runAnalysisInWorker = vi.fn(() => new Promise<typeof demoSnapshot>(value => { resolve = value; }));
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, async (snapshot, owner) => { await store.putSnapshot(owner, snapshot); return snapshot; });
    const first = jobs.submit(scope, input), second = jobs.submit(scope, input);
    const [a, b] = await Promise.all([first, second]); expect(a.jobId).toBe(b.jobId); expect(b.reused).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await jobs.operationalStatus('another-user')).toMatchObject({ activeWorkersInProcess: 0, pendingEnqueueWrites: 0, failuresSinceProcessStart: 0, queuedJobs: 0, leasedJobs: 0 });
    expect((await jobs.get(a.jobId))?.stage).toBe('fetching');
    resolve(structuredClone(demoSnapshot));
    await vi.waitFor(async () => expect((await jobs.get(a.jobId))?.status).toBe('ready'));
    expect((await jobs.submit(scope, input)).reused).toBe(true); expect(run).toHaveBeenCalledTimes(1);
    expect(await jobs.get(a.jobId, { ...scope, ownerId: 'another-user' })).toBeUndefined();
    expect(analysisJobId(scope, input)).not.toBe(analysisJobId({ ...scope, ownerId: 'another-user' }, input));
    expect(analysisJobId(scope, input)).not.toBe(analysisJobId(scope, { ...input, contextRef: 'b'.repeat(40) }));
    await jobs.close(); await store.close();
  });

  it('never reuses a stored local job after the local configuration changed', async () => {
    // One durable store outlives two coordinators, as Postgres outlives a server restart.
    const store = await createStore({ databaseUrl: '' });
    const run: typeof runAnalysisInWorker = vi.fn(async () => structuredClone(demoSnapshot));
    const save = async (snapshot: typeof demoSnapshot, owner: StoreScope) => { await store.putSnapshot(owner, snapshot); return snapshot; };
    const before = { ...input, localFingerprint: 'a'.repeat(20) }, after = { ...input, localFingerprint: 'b'.repeat(20) };
    expect(analysisJobId(scope, before)).not.toBe(analysisJobId(scope, after));
    // A GitHub job for the same name and commit is a different job as well.
    expect(analysisJobId(scope, before)).not.toBe(analysisJobId(scope, input));
    expect(() => analysisJobId(scope, { ...input, localFingerprint: '../x' })).toThrow('Invalid local repository fingerprint.');
    const first = new AnalysisJobs(store, new WorkerAdmission(2), run, save);
    const original = await first.submit(scope, before);
    await vi.waitFor(async () => expect((await first.get(original.jobId))?.status).toBe('ready'));
    await first.close();
    const restarted = new AnalysisJobs(store, new WorkerAdmission(2), run, save);
    expect((await restarted.submit(scope, before)).reused).toBe(true);
    const changed = await restarted.submit(scope, after);
    expect(changed).toMatchObject({ reused: false });
    expect(changed.jobId).not.toBe(original.jobId);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await restarted.close(); await store.close();
  });

  it('reclaims an expired crashed-worker lease, retaining pinned input and monotonic progress', async () => {
    let clock = Date.now(); const store = await createStore({ databaseUrl: '', now: () => clock });
    const job = newJob({ ...input, analysisVersion: 'static-v2', groupingVersion: 'baseline-v1' }, { id: analysisJobId(scope, input), now: clock });
    await store.enqueueJob(scope, job); await store.claimJob(scope, 'dead-worker', 30_000, job.id);
    await store.updateJobProgress(scope, job.id, 'dead-worker', { status: 'indexing', progress: 67, message: 'Interrupted indexing' });
    clock += 31_000; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const observed: number[] = [];
    const run: typeof runAnalysisInWorker = vi.fn(async (pinned, options) => { expect(pinned.contextRef).toBe(input.contextRef); options?.onProgress?.({ stage: 'fetching', progress: 3, message: 'Restarted fetch' }); observed.push((await store.getJob(scope, job.id))!.progress); return structuredClone(demoSnapshot); });
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, async (snapshot, owner) => { await store.putSnapshot(owner, snapshot); return snapshot; });
    jobs.startRecovery();
    await vi.waitFor(async () => expect((await jobs.get(job.id, scope))?.status).toBe('ready'));
    const recovered = await store.getJob(scope, job.id); expect(recovered?.attempts).toBe(2); expect(observed[0]).toBeGreaterThanOrEqual(67);
    expect((await jobs.get(job.id, scope))?.snapshot?.contextRef).toBe('main');
    // The stale worker cannot publish over the reclaimed lease.
    expect(await store.completeJob(scope, job.id, 'dead-worker', { status: 'failed', error: 'late failure' })).toBe(false);
    await jobs.close(); await store.close();
  });

  it('cancels work durably and cannot publish a stale completion', async () => {
    const store = await createStore({ databaseUrl: '' }); let resolve!: (value: typeof demoSnapshot) => void;
    const run: typeof runAnalysisInWorker = vi.fn(() => new Promise<typeof demoSnapshot>(value => { resolve = value; }));
    const save = vi.fn(async snapshot => snapshot);
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, save);
    const { jobId } = await jobs.submit(scope, input); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect((await jobs.cancel(jobId, scope))?.status).toBe('cancelled');
    resolve(structuredClone(demoSnapshot)); await jobs.close();
    expect((await store.getJob(scope, jobId))?.status).toBe('cancelled'); expect(save).not.toHaveBeenCalled();
    await store.close();
  });

  it('requeues interrupted work on graceful shutdown, and refreshes credentials before resume', async () => {
    const store = await createStore({ databaseUrl: '' });
    const first: typeof runAnalysisInWorker = vi.fn((_input, options) => new Promise<typeof demoSnapshot>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Restart', 'AbortError')), { once: true })));
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), first, async snapshot => snapshot);
    const { jobId } = await jobs.submit(scope, input); await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1)); await jobs.close();
    expect((await store.getJob(scope, jobId))?.status).toBe('queued');
    const credentials = vi.fn(async () => ({ token: 'server-only-test-token' }));
    const resumed: typeof runAnalysisInWorker = vi.fn(async (_input, options) => { expect(options?.token).toBe('server-only-test-token'); return structuredClone(demoSnapshot); });
    const restart = new AnalysisJobs(store, new WorkerAdmission(2), resumed, async snapshot => snapshot, credentials);
    restart.startRecovery(); await vi.waitFor(async () => expect((await restart.get(jobId, scope))?.status).toBe('ready'));
    expect(credentials).toHaveBeenCalledWith(scope); expect(JSON.stringify(await store.getJob(scope, jobId))).not.toContain('server-only-test-token');
    await restart.close(); await store.close();
  });

  it('reports permanent errors without retries and permits an explicit fresh retry', async () => {
    const store = await createStore({ databaseUrl: '' });
    const run: typeof runAnalysisInWorker = vi.fn(async () => { throw Object.assign(new Error('Repository removed'), { status: 404, code: 'NOT_FOUND' }); });
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, async snapshot => snapshot);
    const { jobId } = await jobs.submit(scope, input);
    await vi.waitFor(async () => expect((await jobs.get(jobId, scope))?.status).toBe('failed'));
    expect(await jobs.get(jobId, scope)).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect((await store.getJob(scope, jobId))?.attempts).toBe(1);
    const operations = await jobs.operationalStatus(scope.ownerId);
    expect(operations.failuresSinceProcessStart).toBe(1); expect(operations.pendingJobs).toBe(0);
    expect(JSON.stringify(operations)).not.toContain(scope.repository);
    await jobs.submit(scope, input); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await jobs.close(); await store.close();
  });
});
