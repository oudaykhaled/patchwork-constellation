import { describe, expect, it } from 'vitest';
import { EVALUATION_VERSIONS, QUALITY_TARGETS, evaluateReleaseGate } from '../evaluation-gate';
import { EVALUATION_CORPUS, corpusDigest } from './corpus';
import { evaluationContext, replayLiveEvaluation, type LiveObservations } from './live-report';

/** Entirely authored test observations, never recorded/live quality evidence. */
function fixture(): LiveObservations {
  const models = { jev: 'synthetic-jev', generative: 'synthetic-generative' };
  return {
    schemaVersion: '2', kind: 'live-raw-observations', status: 'unreviewed', captureId: '00000000-0000-4000-8000-000000000001', completedAt: '2026-11-03T00:00:00.000Z',
    corpusDigest: corpusDigest(), tuningDigest: corpusDigest('tuning'), versions: { ...EVALUATION_VERSIONS }, targets: { ...QUALITY_TARGETS }, models,
    requests: 17, requestLimit: 20, estimatedCostUsd: 0.01, spendStopUsd: 0.5, costLimitation: 'Synthetic test data, no calls or billing.',
    records: EVALUATION_CORPUS.map(item => {
      const context = evaluationContext(item);
      return {
        caseId: item.id, split: item.split, evidenceDigest: context.evidenceDigest, models,
        labels: context.evidence.groups.map(group => ({ groupId: group.id, label: group.label, rationale: 'Authored test label.', evidenceIds: [context.evidence.files.find(file => file.groupId === group.id)!.evidenceId] })),
        decisions: item.files.map(file => ({ fileId: file.id, groupId: file.mockChoice, confidence: file.mockConfidence })),
        latencyMs: 1, usage: { generative: { inputTokens: 10, outputTokens: 5 }, jev: { inputTokens: 10, outputTokens: 5 } },
      };
    }),
  };
}

describe('offline live-observation replay', () => {
  it('uses actual production import evidence, coverage and gating while retaining a blocked release', () => {
    const context = evaluationContext(EVALUATION_CORPUS[2]);
    expect(context.evidence.importFacts).toHaveLength(2);
    expect(context.evidence.files.every(file => file.evidenceCoverage === 1)).toBe(true);
    expect(context.evidence.allowedEvidenceIds).toContain('edge:hold-monorepo-e0');
    expect(evaluationContext(EVALUATION_CORPUS[6]).evidence.files.find(file => file.path.endsWith('.rs'))?.evidenceCoverage).toBe(0);
    const report = replayLiveEvaluation(fixture());
    expect(report.minimumConfidence).toBe(0.8);
    expect(report.stages.jevGated.count).toBe(18);
    expect(report.stages.jevGated.membershipAgreement).toBeCloseTo(2 / 3);
    expect(report.status).toBe('blocked');
    expect(report.stability).toBeNull();
    expect(report.cost.billedUsd).toBeNull();
    expect(evaluateReleaseGate(report, { minimumConfidence: 0.8 }).passed).toBe(false);
  });
  it('refuses partial, duplicated, foreign-version or differently grounded captures', () => {
    for (const mutate of [
      (value: LiveObservations) => { value.records.pop(); },
      (value: LiveObservations) => { value.records[7] = value.records[6]!; },
      (value: LiveObservations) => { value.records[2]!.split = 'tuning'; },
      (value: LiveObservations) => { value.tuningDigest = 'old'; },
      (value: LiveObservations) => { value.versions.pipeline = 'old'; },
      (value: LiveObservations) => { value.records[2]!.evidenceDigest = 'old'; },
      (value: LiveObservations) => { value.records[2]!.models = { ...value.models, jev: 'other' }; },
    ]) {
      const value = fixture(); mutate(value);
      expect(() => replayLiveEvaluation(value)).toThrow();
    }
  });
  it('rejects unknown decisions and evidence before computing tuning or holdout metrics', () => {
    const decision = fixture(); decision.records[0]!.decisions[0]!.fileId = 'unknown';
    expect(() => replayLiveEvaluation(decision)).toThrow();
    const evidence = fixture(); evidence.records[2]!.labels[0]!.evidenceIds = ['file:unknown'];
    expect(() => replayLiveEvaluation(evidence)).toThrow();
  });
  it('never tunes the threshold using holdout observations', () => {
    const changed = fixture();
    for (const record of changed.records.filter(item => item.split === 'holdout')) for (const decision of record.decisions) decision.confidence = 0.1;
    expect(replayLiveEvaluation(changed).minimumConfidence).toBe(replayLiveEvaluation(fixture()).minimumConfidence);
  });
  it('requires a distinct repeat and reports observed membership instability', () => {
    const first = fixture();
    expect(() => replayLiveEvaluation(first, first)).toThrow(/same capture/);
    const second = fixture(); second.captureId = '00000000-0000-4000-8000-000000000002';
    expect(replayLiveEvaluation(first, second).stability).toBe(1);
    second.records.find(record => record.caseId === 'hold-monorepo')!.decisions.find(decision => decision.fileId === 'hm-shared')!.groupId = 'interface';
    expect(replayLiveEvaluation(first, second).stability).toBe(0);
    second.models = { ...second.models, jev: 'other' };
    for (const record of second.records) record.models = { ...second.models };
    expect(() => replayLiveEvaluation(first, second)).toThrow(/Repeat models/);
  });
});
