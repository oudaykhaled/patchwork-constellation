import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GroupingService } from '../index';
import { createGroupingEvidence, evaluateGroupingProposal } from '../pipeline';
import { createExternalDataPolicy } from '../policy';
import { EVALUATION_VERSIONS, QUALITY_TARGETS } from '../evaluation-gate';
import { EVALUATION_CORPUS, corpusDigest, snapshotForCase, type EvaluationCase } from './corpus';
import { measure, tuneThreshold, type Observation } from './metrics';

const score = z.number().finite().min(0).max(1);
const text = z.string().min(1).max(1000);
const usage = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict();
const models = z.object({ jev: text, generative: text }).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const p95 = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)]!;

/** v2 records the exact production evidence, including import provenance and coverage. */
export const LiveObservationsSchema = z.object({
  schemaVersion: z.literal('2'), kind: z.literal('live-raw-observations'), status: z.literal('unreviewed'),
  captureId: z.string().uuid(), completedAt: z.string().datetime(), corpusDigest: text, tuningDigest: text,
  versions: z.record(z.string(), text), targets: z.unknown(), models,
  requests: z.number().int().min(1).max(20), requestLimit: z.literal(20),
  estimatedCostUsd: z.number().finite().nonnegative(), spendStopUsd: z.number().finite().positive().max(1), costLimitation: text,
  records: z.array(z.object({
    caseId: text, split: z.enum(['tuning', 'holdout']), evidenceDigest: text, models,
    labels: z.array(z.object({ groupId: text, label: text, rationale: text, evidenceIds: z.array(text).max(100) }).strict()).max(64),
    decisions: z.array(z.object({ fileId: text, groupId: text.nullable(), confidence: score.optional() }).strict()).max(64),
    latencyMs: z.number().finite().nonnegative(), usage: z.object({ generative: usage, jev: usage }).strict(),
  }).strict()).max(8),
}).strict();
export type LiveObservations = z.infer<typeof LiveObservationsSchema>;

export function evaluationContext(item: EvaluationCase) {
  const snapshot = snapshotForCase(item);
  const revision = new GroupingService({ enabled: false }).current(snapshot);
  const policy = createExternalDataPolicy();
  const { evidence } = createGroupingEvidence(snapshot, revision, 32, { excludeFile: policy.excludeFile, sanitizeLabel: policy.sanitizeLabel });
  return { snapshot, revision, evidence, evidenceDigest: hash(evidence) };
}

function validateCapture(value: unknown) {
  const capture = LiveObservationsSchema.parse(value);
  if (capture.corpusDigest !== corpusDigest() || capture.tuningDigest !== corpusDigest('tuning') || hash(capture.targets) !== hash(QUALITY_TARGETS) || Object.keys(capture.versions).length !== Object.keys(EVALUATION_VERSIONS).length || Object.entries(EVALUATION_VERSIONS).some(([key, version]) => capture.versions[key] !== version)) throw new Error('Capture corpus, tuning set, targets or versions differ from this evaluator.');
  const seen = new Set<string>();
  for (const record of capture.records) {
    const item = EVALUATION_CORPUS.find(candidate => candidate.id === record.caseId);
    if (!item || seen.has(item.id) || record.split !== item.split) throw new Error('Capture contains an unknown, duplicate or incorrectly split case.');
    seen.add(item.id);
    if (record.models.jev !== capture.models.jev || record.models.generative !== capture.models.generative) throw new Error('Capture includes a response from a different model.');
    const context = evaluationContext(item);
    if (context.evidenceDigest !== record.evidenceDigest) throw new Error('Capture used different production evidence. Recollect rather than relabeling old observations.');
    // Validate all outputs, including tuning cases, before any metric is calculated.
    evaluateGroupingProposal({ ...context, labels: record.labels, decisions: record.decisions, model: record.models.jev, minimumConfidence: 1 });
  }
  if (seen.size !== EVALUATION_CORPUS.length) throw new Error('Capture is incomplete. All two tuning and six holdout cases are required.');
  return capture;
}

/** Offline only: validates captured outputs and replays the actual production evidence gate. Never authorizes rollout. */
export function replayLiveEvaluation(value: unknown, repeated?: unknown) {
  const capture = validateCapture(value);
  const repeat = repeated === undefined ? undefined : validateCapture(repeated);
  if (repeat?.captureId === capture.captureId) throw new Error('A replay of the same capture cannot establish repeated live stability.');
  if (repeat && (repeat.models.jev !== capture.models.jev || repeat.models.generative !== capture.models.generative)) throw new Error('Repeat models must match the original capture.');
  const tuning = capture.records.filter(record => record.split === 'tuning').flatMap(record => {
    const item = EVALUATION_CORPUS.find(candidate => candidate.id === record.caseId)!;
    return record.decisions.map(decision => ({ expected: item.files.find(file => file.id === decision.fileId)!.expected, predicted: decision.groupId ?? item.files.find(file => file.id === decision.fileId)!.baseline, confidence: decision.groupId === null ? undefined : decision.confidence, accepted: decision.groupId !== null, validEvidence: true }));
  });
  const threshold = tuneThreshold(tuning, QUALITY_TARGETS.minimumSelectiveAccuracy);
  const baseline: Observation[] = []; const gated: Observation[] = [];
  const replay = (record: LiveObservations['records'][number]) => {
    const item = EVALUATION_CORPUS.find(candidate => candidate.id === record.caseId)!;
    const context = evaluationContext(item);
    return evaluateGroupingProposal({ ...context, labels: record.labels, decisions: record.decisions, model: record.models.jev, minimumConfidence: threshold, policy: { evaluationId: 'unreviewed-live-replay-not-release', evaluatedJevModel: capture.models.jev, minimumEvidenceCoverage: 1 } });
  };
  const cases = capture.records.filter(record => record.split === 'holdout').map(record => {
    const item = EVALUATION_CORPUS.find(candidate => candidate.id === record.caseId)!;
    const result = replay(record);
    for (const file of item.files) {
      const decision = result.decisions.find(candidate => candidate.fileId === file.id)!;
      baseline.push({ expected: file.expected, predicted: file.baseline, accepted: true, validEvidence: true });
      gated.push({ expected: file.expected, predicted: result.membership[file.id]!, accepted: !decision.reviewReason, confidence: decision.confidence, validEvidence: true });
    }
    const second = repeat?.records.find(candidate => candidate.caseId === item.id);
    return { id: item.id, membership: result.membership, reviewItems: result.reviewItems, labels: result.labelEvidence, stableMembership: second ? hash(result.membership) === hash(replay(second).membership) : null, latencyMs: record.latencyMs };
  });
  return {
    schemaVersion: '1', kind: 'live-production-replay', status: 'blocked', corpusDigest: corpusDigest(), tuningDigest: corpusDigest('tuning'), versions: EVALUATION_VERSIONS, targets: QUALITY_TARGETS,
    models: capture.models, minimumConfidence: threshold, minimumEvidenceCoverage: 1,
    stages: { baseline: measure(baseline), generativeNamingOnly: measure(baseline), jevGated: measure(gated) },
    stability: repeat ? Number(cases.every(item => item.stableMembership)) : null,
    latency: { kind: 'captured-provider-wall-clock', p95Ms: p95(cases.map(item => item.latencyMs)) },
    cost: { kind: 'operator-priced-token-estimate', estimatedTotalUsd: capture.estimatedCostUsd, billedUsd: null },
    cases, releaseBlockers: ['Human frozen-corpus and independent report review must be recorded.', 'Reconcile token estimates against actual provider billing; name usefulness and navigation benefit need human assessment.', ...(repeat ? [] : ['A separate bounded repeat capture is required to measure stability.']), 'Replay is not a release manifest and does not attest live failure/override checks or canary operation.'],
  };
}
