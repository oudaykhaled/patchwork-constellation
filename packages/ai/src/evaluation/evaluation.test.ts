import { describe, expect, it, vi } from 'vitest';
import { GroupingService } from '../index';
import { evaluateReleaseGate, evaluationAllowsTenant } from '../evaluation-gate';
import { EVALUATION_CORPUS, corpusDigest, snapshotForCase } from './corpus';
import { measure, tuneThreshold } from './metrics';
import { testEvaluationManifest } from './test-support';
import { runDeterministicEvaluation } from './runner';

const models = { jev: 'test-jev', generative: 'test-generative' };
const config = { jevModel: models.jev, generativeModel: models.generative, minimumConfidence: 0.8 };
describe('reviewed evaluation release gate', () => {
  it('blocks missing, mock, mismatched, expired and failed releases', () => {
    const approved = testEvaluationManifest();
    expect(evaluateReleaseGate(approved, config).passed).toBe(true);
    for (const manifest of [undefined, { status: 'mock-passed' }, { ...approved, corpusDigest: '1'.repeat(64) }, { ...approved, models: { ...models, jev: 'another' } }, { ...approved, versions: { ...approved.versions, policy: 'old' } }, { ...approved, minimumConfidence: 0.7 }, { ...approved, expiresAt: new Date(Date.now() - 1).toISOString() }, { ...approved, hardGates: { ...approved.hardGates, unknownIdsRejected: false } }, { ...approved, metrics: { ...approved.metrics, evidenceValidity: 0.99 } }, { ...approved, review: { ...approved.review, independentReviewer: approved.review.reviewer } }, { ...approved, live: { ...approved.live, kind: 'mock' } }]) expect(evaluateReleaseGate(manifest, config).passed).toBe(false);
  });
  it('enforces predeclared quality, calibration, latency, cost and canary budgets', () => {
    const approved = testEvaluationManifest();
    for (const manifest of [
      { ...approved, metrics: { ...approved.metrics, gatedAgreement: 0.61 } },
      { ...approved, metrics: { ...approved.metrics, selectiveAccuracy: 0.89 } },
      { ...approved, metrics: { ...approved.metrics, calibrationError: 0.16 } },
      { ...approved, metrics: { ...approved.metrics, reviewRate: 0.6 } },
      { ...approved, live: { ...approved.live, latencyP95Ms: 15_001 } },
      { ...approved, live: { ...approved.live, costPerCaseUsd: 0.051 } },
      { ...approved, rollout: { phase: 'canary', percentage: 11 } },
    ]) expect(evaluateReleaseGate(manifest, config).passed).toBe(false);
    const canary = evaluateReleaseGate({ ...approved, rollout: { phase: 'canary', percentage: 10 } }, config);
    const admitted = Array.from({ length: 1000 }, (_, i) => evaluationAllowsTenant(canary, `tenant-${i}`));
    expect(admitted.filter(Boolean).length).toBeGreaterThan(50);
    expect(admitted.filter(Boolean).length).toBeLessThan(150);
    expect(evaluationAllowsTenant(canary, 'fixed')).toBe(evaluationAllowsTenant(canary, 'fixed'));
  });
  it('AI_ENABLED and keys alone cannot emit provider traffic; manual edits still work', async () => {
    const transport = vi.fn();
    const service = new GroupingService({ enabled: true, jevApiKey: 'test-only', generativeApiKey: 'test-only', ...config, fetch: transport });
    const snapshot = snapshotForCase(EVALUATION_CORPUS[2]);
    expect(service.capabilities().available).toBe(false);
    const original = service.mutate(snapshot, { type: 'rename', groupId: 'domain', label: 'Reviewed Domain' });
    const proposal = await service.propose(original.snapshot, { enabled: true });
    expect(proposal.status).toBe('baseline');
    expect(proposal.groups.find(group => group.id === 'domain')?.label).toBe('Reviewed Domain');
    expect(proposal.message).toContain('evaluation');
    expect(transport).not.toHaveBeenCalled();
  });
});
describe('frozen corpus and calibration', () => {
  it('runs all three stages through the authored service harness while keeping release blocked', async () => {
    const report = await runDeterministicEvaluation();
    expect(report.kind).toBe('authored-mock');
    expect(report.status).toBe('blocked');
    expect(report.corpus.review.status).toBe('pending');
    expect(report.stages.jevGated.count).toBe(18);
    expect(report.stages.baseline.membershipAgreement).toBeCloseTo(2 / 3);
    expect(report.stages.generativeNamingOnly.membershipAgreement).toBeCloseTo(2 / 3);
    // Tied/unsupported observed evidence abstains; mocked high confidence cannot force a move.
    expect(report.stages.jevGated.membershipAgreement).toBeCloseTo(2 / 3);
    expect(report.hardGates).toEqual({ unknownIdsRejected: true, disabledNoTransfer: true, manualOverridesPreserved: true, failuresKeepBaseline: true });
    expect(report.stability).toBe(1);
    expect(report.cost.billedUsd).toBeNull();
    expect(evaluateReleaseGate(report, config).passed).toBe(false);
  });
  it('keeps tuning and holdout disjoint and corpus mutations detectable', () => {
    expect(EVALUATION_CORPUS.filter(item => item.split === 'holdout')).toHaveLength(6);
    expect(EVALUATION_CORPUS.filter(item => item.split === 'tuning')).toHaveLength(2);
    expect(corpusDigest()).not.toBe(corpusDigest('tuning'));
    expect(corpusDigest()).toBe('f1fb3a6732b073e0fb5ee78f9c19bd615ac2c0d516bc827cc300d0c0a748e001');
    expect(new Set(EVALUATION_CORPUS.map(item => item.id)).size).toBe(8);
  });
  it('tunes only on calibration data and reports nonzero error for overconfidence', () => {
    const tuning = [
      { expected: 'a', predicted: 'a', confidence: 0.94, accepted: true, validEvidence: true },
      { expected: 'a', predicted: 'b', confidence: 0.72, accepted: true, validEvidence: true },
    ];
    expect(tuneThreshold(tuning)).toBe(0.8);
    const metrics = measure([{ expected: 'a', predicted: 'b', confidence: 0.99, accepted: true, validEvidence: true }, { expected: 'a', predicted: 'a', confidence: 0.95, accepted: true, validEvidence: true }]);
    expect(metrics.selectiveAccuracy).toBe(0.5);
    expect(metrics.calibrationError).toBeCloseTo(0.47);
    expect(metrics.brierScore).toBeGreaterThan(0.4);
    expect(measure([]).selectiveAccuracy).toBeNull();
  });
});
