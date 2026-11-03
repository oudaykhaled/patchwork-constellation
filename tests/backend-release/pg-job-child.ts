/** Deliberately killed by the opt-in PostgreSQL recovery test. No remote data is read. */
import { createStore } from '@patchwork/storage';
import { demoSnapshot } from '@patchwork/fixtures';
import { AnalysisJobs } from '../../apps/web/analysis-jobs';
import { WorkerAdmission } from '../../apps/web/worker-admission';
import type { runAnalysisInWorker } from '../../apps/worker/src/index';

if (!process.env.TEST_DATABASE_URL || process.env.PG_PROCESS_REHEARSAL !== '1') throw new Error('Explicit isolated database rehearsal is required');
const ownerId = process.argv[2];
if (!ownerId?.startsWith('pg-process-')) throw new Error('Expected a synthetic process-rehearsal owner');
const store = await createStore({ databaseUrl: process.env.TEST_DATABASE_URL });
const run: typeof runAnalysisInWorker = async (_input, options) => {
  options?.onProgress?.({ stage: 'indexing', progress: 61, message: 'Synthetic process interrupted during indexing' });
  return new Promise(() => {});
};
const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, async (snapshot, scope) => { await store.putSnapshot(scope, snapshot); return snapshot; });
await jobs.submit({ ownerId, repository: demoSnapshot.repository.fullName }, { repository: demoSnapshot.repository.fullName, contextRef: demoSnapshot.contextSha, displayContextRef: 'pinned-main', mode: 'pr' });
// The parent kills this exact process. Keep a real process alive even when timers are unref'ed.
setInterval(() => {}, 1_000);
