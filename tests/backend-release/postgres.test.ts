import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from '@patchwork/storage';
import { demoSnapshot } from '@patchwork/fixtures';
import { AnalysisJobs, analysisJobId } from '../../apps/web/analysis-jobs';
import { WorkerAdmission } from '../../apps/web/worker-admission';
import type { runAnalysisInWorker } from '../../apps/worker/src/index';

const enabled = Boolean(process.env.TEST_DATABASE_URL) && process.env.PG_PROCESS_REHEARSAL === '1';
describe.skipIf(!enabled)('real PostgreSQL process-loss rehearsal (explicit isolated database only)', () => {
  it('recovers a hard-killed coordinator after real lease expiry and rejects the stale lease', async () => {
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname) || !databaseUrl.pathname.startsWith('/constellation_')) throw new Error('Process rehearsal requires a named loopback synthetic database');
    const ownerId = `pg-process-${randomUUID()}`, scope = { ownerId, repository: demoSnapshot.repository.fullName };
    const input = { repository: scope.repository, contextRef: demoSnapshot.contextSha, displayContextRef: 'pinned-main', mode: 'pr' as const };
    const id = analysisJobId(scope, input), store = await createStore({ databaseUrl: process.env.TEST_DATABASE_URL });
    let child: ChildProcess | undefined, restart: AnalysisJobs | undefined;
    let exited: Promise<void> | undefined;
    try {
      child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./pg-job-child.ts', import.meta.url)), ownerId], { windowsHide: true, shell: false, env: { ...process.env, PG_PROCESS_REHEARSAL: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
      const ownedChild = child;
      exited = new Promise<void>((resolve, reject) => { ownedChild.once('exit', () => resolve()); ownedChild.once('error', reject); });
      await vi.waitFor(async () => {
        expect(child?.exitCode).toBeNull();
        expect(await store.getJob(scope, id)).toMatchObject({ status: 'indexing', progress: 61, attempts: 1 });
      }, { timeout: 15_000, interval: 100 });
      const interrupted = (await store.getJob(scope, id))!;
      expect(interrupted.leaseOwner).toBeDefined(); expect(interrupted.input.contextRef).toBe(demoSnapshot.contextSha);
      expect(child.kill('SIGKILL')).toBe(true);
      await exited;
      // Do not change clocks or edit the lease row: wait for its real 30-second expiry.
      const observedPins: string[] = [];
      const run: typeof runAnalysisInWorker = async (pinned, options) => {
        observedPins.push(pinned.contextRef!);
        options?.onProgress?.({ stage: 'fetching', progress: 3, message: 'Restarted from pinned context' });
        return { ...structuredClone(demoSnapshot), id: `recovered-${ownerId}` };
      };
      restart = new AnalysisJobs(store, new WorkerAdmission(2), run, async (snapshot, authorizedScope) => { await store.putSnapshot(authorizedScope, snapshot); return snapshot; }, async authorizedScope => { expect(authorizedScope).toEqual(scope); return {}; });
      restart.startRecovery(ownerId);
      await vi.waitFor(async () => expect((await restart!.get(id, scope))?.status).toBe('ready'), { timeout: 45_000, interval: 200 });
      const recovered = (await store.getJob(scope, id))!;
      expect(recovered.attempts).toBe(2); expect(recovered.progress).toBe(100);
      expect(observedPins).toEqual([demoSnapshot.contextSha]);
      expect((await restart.get(id, scope))?.snapshot?.contextRef).toBe('pinned-main');
      expect(await store.completeJob(scope, id, interrupted.leaseOwner!, { status: 'failed', error: 'Stale process cannot publish' })).toBe(false);
      expect(await store.getSnapshot({ ...scope, ownerId: 'outsider' }, recovered.snapshotId!)).toBeUndefined();
      console.info(JSON.stringify({ postgresProcessRehearsal: { hardKill: true, realLeaseExpiry: true, attempts: recovered.attempts, pinnedContextRetained: true, staleLeaseRejected: true, liveExternalGitHub: false } }));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      await restart?.close(); await store.deleteRepository(scope); await store.close();
    }
  }, 65_000);
});
