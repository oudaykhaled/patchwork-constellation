import { describe, expect, it, vi } from 'vitest';
import { demoSnapshot } from '@patchwork/fixtures';
import { ANALYZER_VERSION, PARSER_VERSION } from '@patchwork/analysis';
import { IncrementalAnalysisBaselineSchema, type GraphSnapshot } from '@patchwork/contracts';
import { createStore } from '@patchwork/storage';
import { AnalysisJobs } from './analysis-jobs';
import { WorkerAdmission } from './worker-admission';
import type { runAnalysisInWorker } from '../worker/src/index';

const scope = { ownerId: 'github:alice', repository: demoSnapshot.repository.fullName };
const input = { repository: scope.repository, contextRef: demoSnapshot.contextSha, refreshVersion: 'refresh-one' };
function previous(repository = scope.repository): GraphSnapshot {
  const snapshot = structuredClone(demoSnapshot);
  const [owner, name] = repository.split('/');
  snapshot.mode = 'github'; snapshot.repository = { ...snapshot.repository, fullName: repository, owner: owner!, name: name!, htmlUrl: `https://github.com/${repository}` };
  snapshot.analyzerVersion = ANALYZER_VERSION; snapshot.parserVersion = PARSER_VERSION;
  snapshot.nodes[0] = { ...snapshot.nodes[0]!, blobSha: 'b'.repeat(40), parserVersion: PARSER_VERSION, parseFacts: { schemaVersion: '1', scriptKind: 'ts', references: [{ specifier: './known', line: 1, kind: 'import' }], reasons: [] }, sourceText: 'PRIVATE_SOURCE_BODY_SENTINEL' };
  snapshot.groups[0]!.label = 'PRIVATE_GROUP_SENTINEL'; snapshot.serverToken = 'PRIVATE_TOKEN_SENTINEL';
  return snapshot;
}

describe('authorized incremental job handoff', () => {
  it('loads the exact owner baseline after credentials and forwards only validated thin facts', async () => {
    const store = await createStore({ databaseUrl: '' }), timeline: string[] = [];
    await store.putSnapshot(scope, previous());
    const bob = previous(); bob.nodes[0]!.parseFacts = { schemaVersion: '1', scriptKind: 'ts', references: [{ specifier: './bob-private', line: 1, kind: 'import' }], reasons: [] };
    await store.putSnapshot({ ...scope, ownerId: 'github:bob' }, bob);
    const load = store.getLatestSnapshot.bind(store);
    store.getLatestSnapshot = async selected => { timeline.push('load'); expect(selected).toEqual(scope); return load(selected); };
    const run: typeof runAnalysisInWorker = vi.fn(async (_input, options) => {
      timeline.push('worker'); expect(options?.token).toBe('server-only-token');
      const baseline = IncrementalAnalysisBaselineSchema.parse(options?.incrementalBaseline);
      expect(baseline.repository).toBe(scope.repository); expect(baseline.files).toHaveLength(1);
      expect(baseline.files[0]!.path).toBe(demoSnapshot.nodes[0]!.path);
      expect(JSON.stringify(baseline)).not.toMatch(/PRIVATE_|bob-private|server-only-token|"nodes"|"edges"|"groups"/);
      return structuredClone(demoSnapshot);
    });
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, async snapshot => snapshot, async selected => { timeline.push('authorize'); expect(selected).toEqual(scope); return { token: 'server-only-token', allowPrivate: true }; });
    try {
      const { jobId } = await jobs.submit(scope, input);
      await vi.waitFor(async () => expect((await jobs.get(jobId, scope))?.status).toBe('ready'));
      expect(timeline).toEqual(['authorize', 'load', 'worker']);
      const persisted = await store.getJob(scope, jobId);
      expect(persisted?.input).not.toHaveProperty('incrementalBaseline'); expect(persisted?.input).not.toHaveProperty('token');
      expect(JSON.stringify(persisted?.input)).not.toMatch(/parseFacts|PRIVATE_|server-only-token/);
    } finally { await jobs.close(); await store.close(); }
  });

  it('never loads old metadata after revoked credentials', async () => {
    const store = await createStore({ databaseUrl: '' }), read = vi.spyOn(store, 'getLatestSnapshot'), run: typeof runAnalysisInWorker = vi.fn(async () => structuredClone(demoSnapshot));
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, async snapshot => snapshot, async () => { throw Object.assign(new Error('Denied'), { status: 403, code: 'REPOSITORY_DENIED' }); });
    try {
      const { jobId } = await jobs.submit(scope, input);
      await vi.waitFor(async () => expect((await jobs.get(jobId, scope))?.status).toBe('failed'));
      expect(read).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    } finally { await jobs.close(); await store.close(); }
  });

  it('ignores a foreign snapshot supplied by a faulty store and safely runs full analysis', async () => {
    const store = await createStore({ databaseUrl: '' });
    vi.spyOn(store, 'getLatestSnapshot').mockResolvedValue(previous('foreign/private'));
    const run: typeof runAnalysisInWorker = vi.fn(async (_input, options) => { expect(options?.incrementalBaseline).toBeUndefined(); return structuredClone(demoSnapshot); });
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, async snapshot => snapshot, async () => ({}));
    try { const { jobId } = await jobs.submit(scope, input); await vi.waitFor(async () => expect((await jobs.get(jobId, scope))?.status).toBe('ready')); expect(run).toHaveBeenCalledTimes(1); }
    finally { await jobs.close(); await store.close(); }
  });

  it('purge fences a delayed baseline read before a worker can receive private facts', async () => {
    const store = await createStore({ databaseUrl: '' }); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { entered = resolve; });
    store.getLatestSnapshot = async () => { entered(); await gate; return previous(); };
    const run: typeof runAnalysisInWorker = vi.fn(async () => structuredClone(demoSnapshot));
    const jobs = new AnalysisJobs(store, new WorkerAdmission(2), run, async snapshot => snapshot, async () => ({}));
    try {
      const { jobId } = await jobs.submit(scope, input); await began;
      await jobs.invalidateRepository(scope); await store.deleteRepository(scope); jobs.finishInvalidation(scope);
      release(); await jobs.close(); expect(run).not.toHaveBeenCalled(); expect(await store.getJob(scope, jobId)).toBeUndefined();
    } finally { release(); await jobs.close(); await store.close(); }
  });
});
