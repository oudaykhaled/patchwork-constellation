import { EVALUATION_VERSIONS, type EvaluationManifest } from '../evaluation-gate';
import { corpusDigest } from './corpus';

/** Test-only fictional sign-offs. Never a real release artifact; not exported by the package. */
export function testEvaluationManifest(models = { jev: 'test-jev', generative: 'test-generative' }, minimumConfidence = 0.8, now = Date.now()): EvaluationManifest {
  const reviewed = new Date(now - 1_000).toISOString();
  return {
    schemaVersion: '1', status: 'passed', evaluationId: 'synthetic-test-only', corpusDigest: corpusDigest(), reportDigest: '0'.repeat(64),
    versions: { ...EVALUATION_VERSIONS }, models, minimumConfidence, minimumEvidenceCoverage: 1,
    review: { reviewer: 'synthetic-test-reviewer', independentReviewer: 'synthetic-test-independent-reviewer', reviewedAt: reviewed, dataTermsReviewedAt: reviewed },
    live: { kind: 'live', runId: 'synthetic-test-only-not-a-live-run', completedAt: reviewed, actualModels: models, cases: 6, latencyP95Ms: 1, costPerCaseUsd: 0 },
    metrics: { baselineAgreement: 0.6, gatedAgreement: 0.95, selectiveAccuracy: 0.95, reviewRate: 0.2, calibrationError: 0.05, evidenceValidity: 1, stability: 1 },
    hardGates: { unknownIdsRejected: true, disabledNoTransfer: true, manualOverridesPreserved: true, failuresKeepBaseline: true },
    rollout: { phase: 'general', percentage: 100 }, expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  };
}
