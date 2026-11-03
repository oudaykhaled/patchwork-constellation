import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cpus, platform } from 'node:os';
import { GroupingService } from '../index';
import type { GroupingProposal } from '../types';
import { EVALUATION_VERSIONS, QUALITY_TARGETS } from '../evaluation-gate';
import { EVALUATION_CORPUS, HUMAN_REVIEW, CORPUS_VERSION, corpusDigest, snapshotForCase, type EvaluationCase } from './corpus';
import { measure, tuneThreshold, type Observation } from './metrics';
import { testEvaluationManifest } from './test-support';

const MODELS = { jev: 'jev-1.14.0', generative: 'synthetic-generative-2026-11-03' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const p95 = (values: number[]) => values.length ? values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)]! : 0;
function syntheticTransport(item: EvaluationCase, fault?: 'unknown' | 'outage') {
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    calls++;
    if (fault === 'outage') return Response.json({}, { status: 401 });
    const url = String(input);
    if (url === 'https://api.typesafe.ai/v1/models') return Response.json({ models: [{ name: MODELS.jev }] });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url === 'https://api.openai.com/v1/responses') {
      const evidence = JSON.parse(String(body.input)) as { files: Array<{ evidenceId: string; groupId: string }>; groups: Array<{ id: string; label: string }> };
      return Response.json({ status: 'completed', model: MODELS.generative, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ groups: evidence.groups.map(group => ({ groupId: fault === 'unknown' ? 'unknown-island' : group.id, label: `${group.label} component`, rationale: 'Authored fixture label, not a live model result.', evidenceIds: [evidence.files.find(file => file.groupId === group.id)!.evidenceId] })) }) }] }], usage: { input_tokens: 17, output_tokens: 8 } });
    }
    if (url === 'https://api.typesafe.ai/v1/systemone') {
      const state = body.state as { files: Array<{ id: string }>; groups: Array<{ id: string }> };
      const questions = body.questions as Record<string, { criteria: Record<string, string> }>;
      const answers = Object.fromEntries(state.files.map((file, index) => {
        const golden = item.files.find(candidate => candidate.id === file.id)!;
        const groupIndex = state.groups.findIndex(group => group.id === golden.mockChoice);
        const choice = golden.mockChoice === null ? 'uncertain' : `g${groupIndex}`;
        return [`f${index}`, { type: 'choice', choice, confidence: golden.mockConfidence, probabilities: Object.fromEntries(Object.keys(questions[`f${index}`]!.criteria).map(id => [id, id === choice ? 1 : 0])) }];
      }));
      return Response.json({ model: MODELS.jev, answers, usage: { input_tokens: 23, output_tokens: 9 } });
    }
    throw new Error('Evaluation attempted an unexpected destination.');
  };
  return { transport, calls: () => calls };
}
function serviceFor(item: EvaluationCase, threshold: number, fault?: 'unknown' | 'outage') {
  const transport = syntheticTransport(item, fault);
  const settings = {
    enabled: true, jevApiKey: 'synthetic-not-a-secret', generativeApiKey: 'synthetic-not-a-secret',
    jevModel: MODELS.jev, generativeModel: MODELS.generative, minimumConfidence: threshold,
    fetch: transport.transport, evaluationManifest: testEvaluationManifest(MODELS, threshold),
    membershipPolicy: { evaluatedJevModel: MODELS.jev, evaluationId: 'synthetic-test-only', minimumEvidenceCoverage: 0.5 },
  };
  return { service: new GroupingService(settings), calls: transport.calls };
}
function observations(item: EvaluationCase, membership: Record<string, string>, proposal?: GroupingProposal, threshold = 0.8): Observation[] {
  return item.files.map(file => {
    const decision = proposal?.decisions.find(value => value.fileId === file.id);
    return { expected: file.expected, predicted: membership[file.id]!, confidence: decision?.confidence,
      accepted: proposal ? Boolean(decision && !decision.reviewReason) : true,
      validEvidence: item.groups.some(group => group.id === membership[file.id]) && (!decision || decision.evidenceIds.length > 0 && decision.evidenceIds.every(id => item.files.some(value => id === `file:${value.id}`) || item.imports.some((_edge, index) => id === `edge:${item.id}-e${index}`))),
    };
  });
}

/** Exercises the actual grouping service with authored provider doubles; never uses fetch/network. */
export async function runDeterministicEvaluation() {
  const tuning = EVALUATION_CORPUS.filter(item => item.split === 'tuning').flatMap(item => item.files.map(file => ({ expected: file.expected, predicted: file.mockChoice ?? file.baseline, confidence: file.mockConfidence, accepted: file.mockChoice !== null, validEvidence: true })));
  const threshold = tuneThreshold(tuning);
  const baseline: Observation[] = []; const generated: Observation[] = []; const gated: Observation[] = [];
  const cases = [];
  let stable = true;
  for (const item of EVALUATION_CORPUS.filter(value => value.split === 'holdout')) {
    const snapshot = snapshotForCase(item);
    const before = hash({ edges: snapshot.edges, sources: snapshot.sources });
    const { service } = serviceFor(item, threshold);
    const started = performance.now();
    const proposal = await service.propose(snapshot, { enabled: true });
    const elapsedMs = performance.now() - started;
    if (proposal.status !== 'proposed') throw new Error(`Mock pipeline failed for ${item.id}: ${proposal.message}`);
    const repeated = await serviceFor(item, threshold).service.propose(snapshotForCase(item), { enabled: true });
    stable &&= hash(proposal.membership) === hash(repeated.membership);
    const baselineMembership = Object.fromEntries(item.files.map(file => [file.id, file.baseline]));
    baseline.push(...observations(item, baselineMembership));
    // Current generative adapter only names existing groups; it cannot assign files.
    generated.push(...observations(item, baselineMembership));
    gated.push(...observations(item, proposal.membership, proposal, threshold));
    const applied = service.apply(snapshot, proposal.id);
    if (before !== hash({ edges: applied.snapshot.edges, sources: applied.snapshot.sources })) throw new Error('Grouping changed canonical source facts.');
    cases.push({ id: item.id, elapsedMs, usage: proposal.usage, predictedMembership: proposal.membership, models: proposal.models });
  }
  const guardCase = EVALUATION_CORPUS[2]; const guardSnapshot = snapshotForCase(guardCase);
  const disabledTransport = syntheticTransport(guardCase);
  const disabled = new GroupingService({ enabled: false, fetch: disabledTransport.transport });
  const disabledResult = await disabled.propose(guardSnapshot, { enabled: true });
  const unknown = await serviceFor(guardCase, threshold, 'unknown').service.propose(guardSnapshot, { enabled: true });
  const failed = await serviceFor(guardCase, threshold, 'outage').service.propose(guardSnapshot, { enabled: true });
  const manualService = serviceFor(guardCase, threshold).service;
  const manual = manualService.mutate(guardSnapshot, { type: 'move', fileIds: [guardCase.files[0]!.id], groupId: 'domain' });
  const manualProposal = await manualService.propose(manual.snapshot, { enabled: true });
  const hardGates = { unknownIdsRejected: unknown.status === 'baseline', disabledNoTransfer: disabledTransport.calls() === 0 && disabledResult.status === 'baseline', manualOverridesPreserved: manualProposal.membership[guardCase.files[0]!.id] === 'domain', failuresKeepBaseline: failed.status === 'baseline' && hash(failed.membership) === hash(Object.fromEntries(guardCase.files.map(file => [file.id, file.baseline]))) };
  return {
    schemaVersion: '1', kind: 'authored-mock', status: 'blocked', generatedAt: new Date().toISOString(),
    corpus: { version: CORPUS_VERSION, holdoutDigest: corpusDigest(), tuningDigest: corpusDigest('tuning'), review: HUMAN_REVIEW, tuningCases: 2, holdoutCases: 6 },
    versions: EVALUATION_VERSIONS, targets: QUALITY_TARGETS, minimumConfidence: threshold,
    stages: { baseline: measure(baseline), generativeNamingOnly: measure(generated), jevGated: measure(gated) },
    hardGates, stability: Number(stable), latency: { kind: 'mock-service-wall-clock', p95Ms: p95(cases.map(item => item.elapsedMs)) },
    cost: { kind: 'mock', billedUsd: null, note: 'No provider calls or billed usage. Mock token fields test telemetry only.' },
    environment: { platform: platform(), cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, node: process.version }, cases,
    releaseBlockers: ['Holdout goldens require human review and independent sign-off.', 'No bounded live model run, account data-terms review, measured cost or live calibration has been performed.', 'Authored mock predictions are not evidence of model quality.'],
  };
}
