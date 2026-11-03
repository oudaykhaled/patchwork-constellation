import { describe, expect, test } from 'vitest';
import { buildReleaseEvidence, type SoakEvidence } from '../../scripts/release-evidence';

const commit = 'a'.repeat(40);
const sample = (files: number, edges: number): SoakEvidence => ({ schemaVersion: '1', files, edges, seed: 42, appCommit: commit, build: 'production', conditions: { concurrentActivity: 'synthetic unit-test record', network: 'loopback' }, coldNavigationToPaintMs: 120, warmNavigationToPaintMs: 100, selection: { samples: 1_000, durationMs: 32_000, p95Ms: 30 }, hover: { samples: 12, p95Ms: 20 }, retainedBefore: { heapUsedBytes: 5_000_000, nodes: 400 }, retainedAfter: { heapUsedBytes: 5_100_000, nodes: 400 }, resourcesBefore: { workersCreated: 2, workersLive: 1, globalListeners: 4 }, resourcesAfter: { workersCreated: 2, workersLive: 1, globalListeners: 4 } });
const all = () => [sample(212, 235), sample(2_000, 8_000), sample(10_000, 40_000)];
const dependency = () => ({ schemaVersion: '1', status: 'passed', commit, checks: [{ id: 'fixture-check', status: 'passed', evidence: 'unit-test artifact only' }] });

describe('DEL-05 evidence aggregation gates', () => {
  test('timing success does not imply beta readiness without missing dependency and operational evidence', () => {
    const report = buildReleaseEvidence({ soak: all() });
    expect(report.status).toBe('partial'); expect(report.releaseReady).toBe(false);
    expect(report.checks.find(check => check.id === 'selection-budget')?.status).toBe('passed');
    expect(report.checks.find(check => check.id === 'DATA-09')?.status).toBe('partial');
    expect(report.checks.find(check => check.id === 'authenticated-useful-view')?.status).toBe('partial');
  });
  test('invalid numeric artifacts and breached selection/hover budgets fail rather than skip', () => {
    const artifacts = all(); artifacts[0].coldNavigationToPaintMs = Number.NaN;
    artifacts[1].selection.p95Ms = 251; artifacts[1].hover.p95Ms = 100;
    const report = buildReleaseEvidence({ soak: artifacts });
    expect(report.status).toBe('failed');
    expect(report.checks.filter(check => check.status === 'failed').map(check => check.id)).toEqual(['artifact-shape', 'selection-budget', 'hover-budget']);
  });
  test('a zero-observation artifact cannot claim zero-latency success', () => {
    const artifacts = all(); artifacts[1].hover.samples = 0; artifacts[1].hover.p95Ms = 0;
    const report = buildReleaseEvidence({ soak: artifacts });
    expect(report.status).toBe('failed');
    expect(report.checks.find(check => check.id === 'artifact-shape')?.status).toBe('failed');
    expect(report.checks.find(check => check.id === 'hover-budget')).toBeUndefined();
  });
  test('different builds, empty dependency checks and wrong seeds cannot satisfy the release gate', () => {
    const artifacts = all(); artifacts[1].appCommit = 'b'.repeat(40); artifacts[2].seed = 99;
    const report = buildReleaseEvidence({ soak: artifacts, renderer: { ...dependency(), checks: [] }, backend: dependency(), referenceRunner: 'declared reference', analysisPhaseEvidence: 'declared source', authenticatedViewEvidence: 'declared source' });
    expect(report.releaseReady).toBe(false);
    for (const key of ['fixture-10000', 'same-production-build', 'GRAPH-04', 'DATA-09']) expect(report.checks.find(check => check.id === key)?.status).toBe('partial');
  });
  test('a dependency failure and retained worker growth are visible failures', () => {
    const artifacts = all(); artifacts[1].resourcesAfter.workersCreated++;
    const report = buildReleaseEvidence({ soak: artifacts, renderer: { ...dependency(), status: 'failed' }, backend: dependency() });
    expect(report.status).toBe('failed');
    expect(report.checks.find(check => check.id === 'retention-2000')?.status).toBe('failed');
    expect(report.checks.find(check => check.id === 'GRAPH-04')?.status).toBe('failed');
  });
  test('only complete same-commit explicit evidence can pass the aggregate gate', () => {
    const report = buildReleaseEvidence({ soak: all(), renderer: dependency(), backend: dependency(), referenceRunner: 'test reference runner declaration', analysisPhaseEvidence: 'test phase artifact declaration', authenticatedViewEvidence: 'test auth artifact declaration' });
    expect(report.status).toBe('passed'); expect(report.releaseReady).toBe(true);
  });
});
