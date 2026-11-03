import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { corpusDigest } from './evaluation/corpus';

/** Any change requires a new reviewed holdout run; keep synchronized with the policy/provider modules. */
export const EVALUATION_VERSIONS = {
  policy: 'metadata-only-v2', prompt: 'island-label-membership-v1', schema: 'grouping-evidence-v1',
  providerContract: 'system-one-v2', labelPrompt: 'island-labels-v1', membershipPrompt: 'island-membership-v1', pipeline: 'evidence-gated-v1',
} as const;
export const QUALITY_TARGETS = {
  minimumAgreementGain: 0.05, minimumSelectiveAccuracy: 0.9, maximumReviewRate: 0.5,
  maximumCalibrationError: 0.15, maximumLatencyP95Ms: 15_000, maximumCostPerCaseUsd: 0.05,
} as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const score = z.number().finite().min(0).max(1);
const timestamp = z.string().datetime();
const ManifestSchema = z.object({
  schemaVersion: z.literal('1'), status: z.literal('passed'), evaluationId: z.string().min(1).max(160),
  corpusDigest: sha, reportDigest: sha,
  versions: z.object(Object.fromEntries(Object.keys(EVALUATION_VERSIONS).map(key => [key, z.string().min(1).max(160)])) as Record<keyof typeof EVALUATION_VERSIONS, z.ZodString>).strict(),
  models: z.object({ jev: z.string().min(1).max(160), generative: z.string().min(1).max(160) }).strict(),
  minimumConfidence: score,
  review: z.object({ reviewer: z.string().min(1).max(160), independentReviewer: z.string().min(1).max(160), reviewedAt: timestamp, dataTermsReviewedAt: timestamp }).strict(),
  live: z.object({ kind: z.literal('live'), runId: z.string().min(1).max(160), completedAt: timestamp, actualModels: z.object({ jev: z.string().min(1).max(160), generative: z.string().min(1).max(160) }).strict(), cases: z.number().int().min(6), latencyP95Ms: z.number().finite().nonnegative(), costPerCaseUsd: z.number().finite().nonnegative() }).strict(),
  metrics: z.object({ baselineAgreement: score, gatedAgreement: score, selectiveAccuracy: score, reviewRate: score, calibrationError: score, evidenceValidity: score, stability: score }).strict(),
  hardGates: z.object({ unknownIdsRejected: z.literal(true), disabledNoTransfer: z.literal(true), manualOverridesPreserved: z.literal(true), failuresKeepBaseline: z.literal(true) }).strict(),
  rollout: z.object({ phase: z.enum(['canary', 'general']), percentage: z.number().int().min(1).max(100) }).strict(),
  expiresAt: timestamp,
}).strict();
export type EvaluationManifest = z.infer<typeof ManifestSchema>;
export interface EvaluationGate { passed: boolean; reason: string; evaluationId?: string; rolloutPercent: number; minimumConfidence?: number; evaluatedJevModel?: string }

/** Server-only bounded file loader. Unreadable/invalid configuration is a blocked gate, never provider access. */
export function loadEvaluationManifest(path = process.env.AI_EVALUATION_MANIFEST): unknown {
  if (!path) return undefined;
  try {
    if (statSync(path).size > 64_000) return undefined;
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text) > 64_000) return undefined;
    return JSON.parse(text) as unknown;
  } catch { return undefined; }
}
export function evaluateReleaseGate(value: unknown, config: { jevModel?: string; generativeModel?: string; minimumConfidence: number }, now = Date.now()): EvaluationGate {
  const blocked = (reason: string): EvaluationGate => ({ passed: false, reason, rolloutPercent: 0 });
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) return blocked('AI + Jev is awaiting a reviewed live evaluation. Deterministic grouping remains available.');
  const manifest = parsed.data;
  if (manifest.corpusDigest !== corpusDigest() || Object.entries(EVALUATION_VERSIONS).some(([key, version]) => manifest.versions[key as keyof typeof EVALUATION_VERSIONS] !== version)) return blocked('The evaluation is for a different corpus or analysis version. Re-evaluate before enabling AI + Jev.');
  if (manifest.models.jev !== config.jevModel || manifest.models.generative !== config.generativeModel || manifest.live.actualModels.jev !== manifest.models.jev || manifest.live.actualModels.generative !== manifest.models.generative || manifest.minimumConfidence !== config.minimumConfidence) return blocked('The evaluated models or decision threshold do not match this configuration.');
  const reviewed = Date.parse(manifest.review.reviewedAt); const live = Date.parse(manifest.live.completedAt); const expires = Date.parse(manifest.expiresAt);
  if (reviewed > now || live > reviewed || Date.parse(manifest.review.dataTermsReviewedAt) > now || expires <= now || expires - reviewed > 90 * 24 * 60 * 60 * 1000 || now - live > 90 * 24 * 60 * 60 * 1000 || manifest.review.reviewer === manifest.review.independentReviewer) return blocked('The evaluation review is stale, incomplete or lacks independent sign-off.');
  const metrics = manifest.metrics;
  if (metrics.gatedAgreement - metrics.baselineAgreement < QUALITY_TARGETS.minimumAgreementGain || metrics.selectiveAccuracy < QUALITY_TARGETS.minimumSelectiveAccuracy || metrics.reviewRate > QUALITY_TARGETS.maximumReviewRate || metrics.calibrationError > QUALITY_TARGETS.maximumCalibrationError || metrics.evidenceValidity !== 1 || metrics.stability !== 1 || manifest.live.latencyP95Ms > QUALITY_TARGETS.maximumLatencyP95Ms || manifest.live.costPerCaseUsd > QUALITY_TARGETS.maximumCostPerCaseUsd) return blocked('The live evaluation did not meet the declared quality, safety, latency or cost targets.');
  if (manifest.rollout.phase === 'canary' && manifest.rollout.percentage > 10) return blocked('Canary rollout is limited to ten percent until a general-release review.');
  return { passed: true, reason: 'AI + Jev passed the recorded evaluation for these exact versions.', evaluationId: manifest.evaluationId, rolloutPercent: manifest.rollout.percentage, minimumConfidence: manifest.minimumConfidence, evaluatedJevModel: manifest.models.jev };
}
export function evaluationAllowsTenant(gate: EvaluationGate, tenantId: string): boolean {
  if (!gate.passed || gate.rolloutPercent <= 0) return false;
  const bucket = createHash('sha256').update(`${gate.evaluationId}:${tenantId}`).digest().readUInt32BE() % 100;
  return bucket < gate.rolloutPercent;
}
