import { authoredFileFacts } from '@patchwork/fixtures';
import { describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '@patchwork/contracts';
import { createGroupingEvidence, evaluateGroupingProposal, GroupingService } from './index';
import type { GroupingMembershipPolicy } from './types';
import { testEvaluationManifest } from './evaluation/test-support';

const policy: GroupingMembershipPolicy = { evaluatedJevModel: 'jev-1.14.0', evaluationId: 'synthetic-evaluation-v1', minimumEvidenceCoverage: 1 };
function snapshot(): GraphSnapshot {
  return {
    schemaVersion: '1', id: 'ambiguous-module-v1', repository: { owner: 'fixture', name: 'review', fullName: 'fixture/review', defaultBranch: 'main', htmlUrl: 'https://github.com/fixture/review' }, contextRef: 'main', contextSha: 'a'.repeat(40), mode: 'demo', createdAt: '2026-11-03T00:00:00Z', coverage: { status: 'complete', reasons: [], filesAnalyzed: 5, totalFiles: 5 }, sources: [],
    groups: [{ id: 'core', label: 'Core', origin: 'rules' }, { id: 'billing', label: 'Billing', origin: 'manifest' }],
    nodes: [
      { ...authoredFileFacts('complete'), id: 'a', path: 'src/shared/not-billing.ts', groupId: 'core', sourceIds: [], importCoverage: 'complete' },
      { ...authoredFileFacts('complete'), id: 'b', path: 'src/shared/util.ts', groupId: 'core', sourceIds: [], importCoverage: 'complete' },
      { ...authoredFileFacts('complete'), id: 'c', path: 'packages/billing/charge.ts', groupId: 'billing', sourceIds: [], importCoverage: 'complete' },
      { ...authoredFileFacts('complete'), id: 'd', path: 'packages/billing/ledger.ts', groupId: 'billing', sourceIds: [], importCoverage: 'complete' },
      { ...authoredFileFacts('complete'), id: 'p', path: 'packages/billing/package.json', groupId: 'billing', sourceIds: [] },
      { ...authoredFileFacts('complete'), id: 'secret', path: '.env.local', groupId: 'core', sourceIds: [] },
    ], edges: [
      { id: 'ac', source: 'a', target: 'c', kind: 'import', evidence: { path: 'src/shared/not-billing.ts', line: 2, resolver: 'authored-fixture', snapshotSha: 'a'.repeat(40) } },
      { id: 'ad', source: 'a', target: 'd', kind: 'type-import', evidence: { path: 'src/shared/not-billing.ts', line: 3, resolver: 'authored-fixture', snapshotSha: 'a'.repeat(40) } },
      { id: 'ba', source: 'b', target: 'a', kind: 'import', evidence: { path: 'src/shared/util.ts', line: 1, resolver: 'authored-fixture', snapshotSha: 'a'.repeat(40) } },
    ],
  };
}
function input(value = snapshot()) {
  const revision = new GroupingService().current(value);
  const { evidence } = createGroupingEvidence(value, revision, 32);
  const labels = evidence.groups.map(group => ({ groupId: group.id, label: `${group.label} module`, rationale: 'Observed fixture paths share an existing module boundary.', evidenceIds: [evidence.files.find(file => file.groupId === group.id)!.evidenceId] }));
  return { snapshot: value, revision, evidence, labels, decisions: evidence.files.map(file => ({ fileId: file.id, groupId: file.id === 'a' ? 'billing' : file.groupId, confidence: 0.95 })), model: 'jev-1.14.0', minimumConfidence: 0.8, policy };
}

describe('bounded grouping evidence', () => {
  it('contains resolvable file, package and observed import facts without private contents', () => {
    const value = input();
    expect(value.evidence.files).toHaveLength(5);
    expect(value.evidence.packages).toEqual([{ evidenceId: 'file:p', fileId: 'p', path: 'packages/billing/package.json', groupId: 'billing' }]);
    expect(value.evidence.importFacts!.map(edge => edge.evidenceId)).toEqual(['edge:ac', 'edge:ad', 'edge:ba']);
    expect(JSON.stringify(value.evidence)).not.toContain('.env.local');
    expect(value.evidence.files[0]!.evidenceCoverage).toBe(1);
    expect(value.evidence.snapshot?.contextSha).toBe('a'.repeat(40));
  });
  it('accounts for omitted imports instead of pretending the bounded graph is complete', () => {
    const value = snapshot(); const revision = new GroupingService().current(value);
    const { evidence } = createGroupingEvidence(value, revision, 2);
    expect(evidence.files).toHaveLength(2);
    expect(evidence.files[0]!.evidenceCoverage).toBeCloseTo(1 / 3);
    expect(evidence.files[0]!.coverageReasons).toContain('Some incident imports are outside the bounded evidence bundle or have unresolved provenance.');
    expect(evidence.importFacts).toHaveLength(1);
  });
  it('respects injected exclusions and label sanitization across all evidence fields', () => {
    const value = snapshot(); value.groups[0]!.label = 'sensitive-label'; const revision = new GroupingService().current(value);
    const { evidence } = createGroupingEvidence(value, revision, 32, { excludeFile: file => file.id === 'b', sanitizeLabel: (_label, fallback) => fallback });
    expect(evidence.files.some(file => file.id === 'b')).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain('sensitive-label');
    expect(evidence.importFacts!.some(edge => edge.source === 'b')).toBe(false);
  });
});

describe('reviewable membership decisions', () => {
  it('proposes only evidence-supported changes and keeps canonical facts immutable', () => {
    const value = input(); const before = structuredClone(value.snapshot);
    const result = evaluateGroupingProposal(value);
    expect(result.changedMemberships).toEqual([{ fileId: 'a', fromGroupId: 'core', toGroupId: 'billing' }]);
    expect(result.decisions.find(decision => decision.fileId === 'a')).toMatchObject({ outcome: 'proposed', evidenceCoverage: 1, confidence: 0.95, evidenceIds: ['file:a', 'edge:ac', 'edge:ad', 'edge:ba'] });
    expect(result.evaluation).toMatchObject({ status: 'evaluated', evaluationId: 'synthetic-evaluation-v1', actualModel: 'jev-1.14.0' });
    expect(value.snapshot).toEqual(before);
    expect(result).not.toHaveProperty('edges'); expect(result).not.toHaveProperty('sources');
  });
  it('retains low, missing confidence and explicit uncertain decisions with separate review reasons', () => {
    for (const [confidence, groupId, reason] of [[0.2, 'billing', 'low-confidence'], [undefined, 'billing', 'missing-confidence'], [0.99, null, 'uncertain']] as const) {
      const value = input(); const decision = value.decisions[0]!;
      const result = evaluateGroupingProposal({ ...value, decisions: [{ ...decision, confidence, groupId }, ...value.decisions.slice(1)] });
      expect(result.membership.a).toBe('core'); expect(result.reviewItems[0]!.reason).toBe(reason);
      expect(result.changedMemberships).toHaveLength(0);
    }
  });
  it('does not treat an unreviewed or mismatched model as calibrated', () => {
    for (const testPolicy of [undefined, { ...policy, evaluatedJevModel: 'jev-1.13.0' }]) {
      const result = evaluateGroupingProposal({ ...input(), policy: testPolicy });
      expect(result.membership.a).toBe('core'); expect(result.reviewItems.some(item => item.reason === 'unreviewed-model')).toBe(true);
      expect(result.evaluation.status).toBe('unreviewed');
    }
  });
  it('retains the baseline on partial parsing, conflicting imports or misleading names without destination facts', () => {
    const unsupported = snapshot(); unsupported.nodes[0]!.importCoverage = 'unsupported';
    const conflict = snapshot(); conflict.edges = conflict.edges.filter(edge => edge.id !== 'ad');
    const missing = snapshot(); missing.edges = missing.edges.filter(edge => edge.id === 'ba');
    for (const [value, reason] of [[unsupported, 'incomplete-evidence'], [conflict, 'conflicting-evidence'], [missing, 'missing-evidence']] as const) {
      const result = evaluateGroupingProposal(input(value));
      expect(result.membership.a).toBe('core'); expect(result.reviewItems.find(item => item.fileId === 'a')!.reason).toBe(reason);
    }
  });
  it('rejects invented file, island, import and unsupported rationale references', () => {
    const foreignFile = input(); foreignFile.decisions[0]!.fileId = 'invented';
    const foreignGroup = input(); foreignGroup.decisions[0]!.groupId = 'invented';
    const foreignEdge = input(); foreignEdge.evidence.importFacts![0]!.edgeId = 'invented';
    const foreignRationale = input(); foreignRationale.labels[0]!.evidenceIds = ['file:invented'];
    const unrelatedRationale = input(); unrelatedRationale.labels.find(label => label.groupId === 'core')!.evidenceIds = ['file:c'];
    for (const value of [foreignFile, foreignGroup, foreignEdge, foreignRationale, unrelatedRationale]) expect(() => evaluateGroupingProposal(value)).toThrow();
  });
  it('locks manual files and reports actual evidence coverage separately from uncertainty', () => {
    const value = input(); value.revision.lockedFileIds.push('a');
    const result = evaluateGroupingProposal(value);
    expect(result.membership.a).toBe('core'); expect(result.reviewItems[0]!.reason).toBe('manual-override');
    expect(result.decisions[0]).toMatchObject({ confidence: 0.95, evidenceCoverage: 1 });
    expect(result.evaluation.confidenceMeaning).toContain('not measured correctness');
  });
});

it('runs the mocked pipeline as a preview and applies only its grounded membership delta', async () => {
  const value = snapshot();
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return Response.json({ models: [{ name: 'jev-latest' }] });
    const request = JSON.parse(String(init?.body));
    if (String(url).endsWith('/responses')) {
      const evidence = JSON.parse(request.input);
      return Response.json({ status: 'completed', model: 'generative-fixture-v1', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ groups: evidence.groups.map((group: {id:string;label:string}) => ({ groupId: group.id, label: group.label, rationale: 'Authored fixture path evidence.', evidenceIds: [evidence.files.find((file: {groupId:string}) => file.groupId === group.id).evidenceId] })) }) }] }], usage: { input_tokens: 100, output_tokens: 30 } });
    }
    const state = request.state;
    const answers = Object.fromEntries(Object.keys(request.questions).map((key, index) => {
      const file = state.files[index]; const groupId = file.id === 'a' ? 'billing' : file.groupId;
      const choice = `g${state.groups.findIndex((group: {id:string}) => group.id === groupId)}`;
      return [key, { type: 'choice', choice, confidence: 0.95, probabilities: Object.fromEntries(Object.keys(request.questions[key].criteria).map(candidate => [candidate, candidate === choice ? 1 : 0])) }];
    }));
    return Response.json({ model: 'jev-1.14.0', answers, usage: { input_tokens: 100, output_tokens: 30 } });
  });
  const service = new GroupingService({ enabled: true, jevApiKey: 'fixture', jevModel: 'jev-1.14.0', generativeApiKey: 'fixture', generativeModel: 'generative-fixture-v1', fetch: transport as typeof fetch, evaluationManifest: testEvaluationManifest({ jev: 'jev-1.14.0', generative: 'generative-fixture-v1' }), membershipPolicy: policy });
  const active = service.current(value);
  const proposal = await service.propose(value, { enabled: true });
  expect(proposal.changedMemberships).toEqual([{ fileId: 'a', fromGroupId: 'core', toGroupId: 'billing' }]);
  expect(service.current(value).id).toBe(active.id); expect(value.nodes[0]!.groupId).toBe('core');
  const applied = service.apply(value, proposal.id);
  expect(applied.snapshot.nodes[0]!.groupId).toBe('billing');
  expect(applied.snapshot.edges).toEqual(value.edges); expect(applied.snapshot.sources).toEqual(value.sources);
  expect(applied.snapshot.nodes.map(file => ({ id: file.id, path: file.path, sourceIds: file.sourceIds }))).toEqual(value.nodes.map(file => ({ id: file.id, path: file.path, sourceIds: file.sourceIds })));
});
