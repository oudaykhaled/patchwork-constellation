import type { FileNode, GraphSnapshot, Group, ImportEdge } from '@patchwork/contracts';
import type { CandidateLabel, EvidenceBundle, EvidenceImport } from './providers';
import { validateCandidateLabels } from './providers';
import { GroupingError, type GroupingMembershipPolicy, type GroupingRevision, type MembershipDecision, type MembershipReviewItem, type MembershipReviewReason } from './types';

export const GROUPING_PIPELINE_VERSION = 'evidence-gated-v1';
const clone = <T>(value: T): T => structuredClone(value);
const DEFAULT_EXCLUDED = /(^|\/)(?:\.env(?:\.[^/]*)?|\.git|node_modules|vendor|dist|build|coverage|secrets?|credentials?|private[-_]?keys?)(\/|$)|\.(?:pem|key|p12|pfx|keystore)$/i;

export interface EvidencePolicy {
  excludeFile?: (node: FileNode) => boolean;
  sanitizeLabel?: (label: string, fallback: string) => string;
}

function importFact(edge: ImportEdge, snapshot: GraphSnapshot): EvidenceImport | null {
  const source = snapshot.nodes.find(node => node.id === edge.source);
  if (!source || !edge.evidence) return null;
  // Authored demo evidence is explicit. Production evidence must identify its pinned context.
  if (typeof edge.evidence === 'string') return snapshot.mode === 'demo' ? { evidenceId: `edge:${edge.id}`, edgeId: edge.id, source: edge.source, target: edge.target, relation: edge.kind, path: source.path } : null;
  if (edge.evidence.path !== source.path || snapshot.mode !== 'demo' && edge.evidence.snapshotSha !== snapshot.contextSha) return null;
  return { evidenceId: `edge:${edge.id}`, edgeId: edge.id, source: edge.source, target: edge.target, relation: edge.kind, path: edge.evidence.path, ...(edge.evidence.line ? { line: edge.evidence.line } : {}), ...(edge.evidence.snapshotSha ? { snapshotSha: edge.evidence.snapshotSha } : {}) };
}

/** Bounded, resolvable facts only. No source text, repository instructions or model-created edges. */
export function createGroupingEvidence(snapshot: GraphSnapshot, revision: GroupingRevision, maxFiles: number, policy: EvidencePolicy = {}): { evidence: EvidenceBundle; excludedFiles: number } {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 64) throw new GroupingError('INVALID_CONFIG', 'Evidence must contain between one and 64 files.');
  const eligible = snapshot.nodes.filter(node => !DEFAULT_EXCLUDED.test(node.path) && !policy.excludeFile?.(node));
  const unlocked = eligible.filter(node => !revision.lockedFileIds.includes(node.id));
  const files = unlocked.slice().sort((a, b) => a.id.localeCompare(b.id)).slice(0, maxFiles);
  const groupIds = new Set(files.map(file => revision.membership[file.id]!));
  const groups = revision.groups.filter(group => groupIds.has(group.id)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 64).map((group, index) => ({ id: group.id, label: policy.sanitizeLabel?.(group.label, `Island ${index + 1}`) ?? group.label, paths: files.filter(node => revision.membership[node.id] === group.id).sort((a, b) => a.path.localeCompare(b.path)).slice(0, 8).map(node => node.path.slice(0, 300)) }));
  const includedGroupIds = new Set(groups.map(group => group.id));
  const boundedFiles = files.filter(file => includedGroupIds.has(revision.membership[file.id]!));
  const includedIds = new Set(boundedFiles.map(file => file.id));
  const importFacts: EvidenceImport[] = [];
  // Per-file quotas prevent a hub from consuming the entire context.
  const degree = new Map<string, number>();
  for (const edge of snapshot.edges.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (!includedIds.has(edge.source) || !includedIds.has(edge.target) || (degree.get(edge.source) ?? 0) >= 12 || (degree.get(edge.target) ?? 0) >= 12) continue;
    const fact = importFact(edge, snapshot);
    if (!fact) continue;
    importFacts.push(fact);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const evidenceFiles = boundedFiles.map(file => {
    const allIncident = snapshot.edges.filter(edge => edge.source === file.id || edge.target === file.id);
    const includedIncident = importFacts.filter(edge => edge.source === file.id || edge.target === file.id);
    const reasons: string[] = [];
    const importCoverage = file.importCoverage;
    let evidenceCoverage = allIncident.length ? includedIncident.length / allIncident.length : 1;
    if (importCoverage && importCoverage !== 'complete') { evidenceCoverage = 0; reasons.push(`Static imports are ${String(importCoverage)} for this file.`); }
    else if (!importCoverage && snapshot.coverage.status !== 'complete') {
      const ratio = snapshot.coverage.totalFiles && snapshot.coverage.filesAnalyzed !== undefined ? Math.min(1, snapshot.coverage.filesAnalyzed / snapshot.coverage.totalFiles) : 0;
      evidenceCoverage = Math.min(evidenceCoverage, ratio);
      reasons.push('Per-file completeness is unavailable; repository coverage is used conservatively.');
    }
    if (includedIncident.length < allIncident.length) reasons.push('Some incident imports are outside the bounded evidence bundle or have unresolved provenance.');
    if (file.path.length > 300) { evidenceCoverage = 0; reasons.push('The path exceeds the metadata display budget.'); }
    return { id: file.id, path: file.path.slice(0, 300), groupId: revision.membership[file.id]!, evidenceId: `file:${file.id}`, imports: importFacts.filter(edge => edge.source === file.id).map(edge => edge.target), evidenceCoverage, coverageReasons: reasons };
  });
  const packages = evidenceFiles.filter(file => /(^|\/)package\.json$/.test(file.path)).map(file => ({ evidenceId: file.evidenceId, fileId: file.id, path: file.path, groupId: file.groupId }));
  return { evidence: { files: evidenceFiles, groups, importFacts, packages, allowedEvidenceIds: [...evidenceFiles.map(file => file.evidenceId), ...importFacts.map(edge => edge.evidenceId)], snapshot: { id: snapshot.id, contextSha: snapshot.contextSha, coverage: snapshot.coverage.status } }, excludedFiles: snapshot.nodes.length - eligible.length };
}

export interface CandidateDecision { fileId: string; groupId: string | null; confidence?: number }
export interface MembershipEvaluationInput {
  snapshot: GraphSnapshot;
  revision: GroupingRevision;
  evidence: EvidenceBundle;
  labels: CandidateLabel[];
  decisions: CandidateDecision[];
  model: string;
  minimumConfidence: number;
  policy?: GroupingMembershipPolicy;
}

const reviewMessages: Record<MembershipReviewReason, string> = {
  uncertain: 'Jev selected uncertain; the current island is retained.',
  'low-confidence': 'Model uncertainty is below the evaluated threshold; the current island is retained.',
  'missing-confidence': 'The provider supplied no confidence; the current island is retained for review.',
  'unreviewed-model': 'This exact response model has no matching evaluation policy; the current island is retained.',
  'missing-evidence': 'No observed import supports the proposed destination; a filename alone is insufficient to move this file.',
  'incomplete-evidence': 'Evidence coverage is below the reviewed threshold; the current island is retained.',
  'conflicting-evidence': 'Observed imports support conflicting islands; the current island is retained.',
  'manual-override': 'A manual membership override takes precedence over this suggestion.',
};

/** Decide whether a suggestion is supported, never whether it is proven correct. */
export function evaluateGroupingProposal(input: MembershipEvaluationInput) {
  const { snapshot, revision, evidence, labels, decisions, model, minimumConfidence, policy } = input;
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) throw new GroupingError('INVALID_CONFIG', 'The confidence threshold is outside the supported range.');
  const files = new Map(evidence.files.map(file => [file.id, file]));
  const observedFiles = new Map(snapshot.nodes.map(file => [file.id, file]));
  if (files.size !== evidence.files.length || evidence.files.some(file => !observedFiles.has(file.id) || file.evidenceId !== `file:${file.id}` || file.path !== observedFiles.get(file.id)!.path.slice(0, 300) || file.groupId !== revision.membership[file.id])) throw new GroupingError('UNKNOWN_EVIDENCE', 'Evidence must resolve to files in this exact snapshot and revision.');
  const observedEdges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  for (const fact of evidence.importFacts ?? []) {
    const edge = observedEdges.get(fact.edgeId);
    const actual = edge ? importFact(edge, snapshot) : null;
    if (!actual || fact.evidenceId !== actual.evidenceId || fact.source !== actual.source || fact.target !== actual.target || fact.path !== actual.path || fact.snapshotSha !== actual.snapshotSha || fact.line !== actual.line || fact.relation !== actual.relation) throw new GroupingError('UNKNOWN_EVIDENCE', 'Import evidence must resolve to an observed edge in this exact snapshot.');
  }
  const revisionGroupIds = new Set(revision.groups.map(group => group.id));
  const allowedGroups = new Set(evidence.groups.map(group => group.id));
  if (allowedGroups.size !== evidence.groups.length || evidence.groups.some(group => !revisionGroupIds.has(group.id))) throw new GroupingError('UNKNOWN_EVIDENCE', 'Candidate islands must belong to this exact revision.');
  const allowedEvidence = new Set(evidence.allowedEvidenceIds);
  const catalogIds = new Set([...evidence.files.map(file => file.evidenceId), ...(evidence.importFacts ?? []).map(edge => edge.evidenceId)]);
  if (allowedEvidence.size !== evidence.allowedEvidenceIds.length || allowedEvidence.size !== catalogIds.size || [...allowedEvidence].some(id => !catalogIds.has(id))) throw new GroupingError('UNKNOWN_EVIDENCE', 'The evidence catalog contains a foreign or duplicate reference.');
  if (new Set((evidence.importFacts ?? []).map(edge => edge.edgeId)).size !== (evidence.importFacts ?? []).length) throw new GroupingError('UNKNOWN_EVIDENCE', 'Duplicate imports cannot increase evidence support.');
  for (const fact of evidence.packages ?? []) {
    const file = files.get(fact.fileId);
    if (!file || fact.evidenceId !== file.evidenceId || fact.path !== file.path || fact.groupId !== file.groupId || !/(^|\/)package\.json$/.test(fact.path)) throw new GroupingError('UNKNOWN_EVIDENCE', 'Package facts must identify an included manifest file.');
  }
  const validatedLabels = validateCandidateLabels({ groups: labels }, evidence);
  const seen = new Set<string>();
  if (decisions.length !== files.size) throw new GroupingError('INVALID_OUTPUT', 'Membership decisions must cover exactly the supplied evidence files.');
  const evaluated = Boolean(policy?.evaluationId.trim() && policy.evaluatedJevModel === model && Number.isFinite(policy.minimumEvidenceCoverage) && policy.minimumEvidenceCoverage >= 0 && policy.minimumEvidenceCoverage <= 1);
  const membership = clone(revision.membership);
  const reviewItems: MembershipReviewItem[] = [];
  const detailed: MembershipDecision[] = [];
  for (const decision of decisions) {
    const file = files.get(decision.fileId);
    if (!file || seen.has(decision.fileId) || decision.groupId !== null && !allowedGroups.has(decision.groupId)) throw new GroupingError('UNKNOWN_ID', 'A decision referenced an unknown or duplicate file or island.');
    seen.add(decision.fileId);
    if (decision.confidence !== undefined && (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1)) throw new GroupingError('INVALID_OUTPUT', 'A decision has invalid confidence.');
    const baseline = revision.membership[file.id]!;
    const coverage = file.evidenceCoverage ?? 0;
    if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) throw new GroupingError('UNKNOWN_EVIDENCE', 'Evidence coverage must be a bounded observed fraction.');
    const incident = (evidence.importFacts ?? []).filter(edge => edge.source === file.id || edge.target === file.id);
    const support = new Map<string, number>();
    for (const edge of incident) {
      if (!allowedEvidence.has(edge.evidenceId) || !files.has(edge.source) || !files.has(edge.target)) throw new GroupingError('UNKNOWN_EVIDENCE', 'An import fact is outside the supplied evidence.');
      const other = edge.source === file.id ? edge.target : edge.source;
      const groupId = revision.membership[other]!;
      support.set(groupId, (support.get(groupId) ?? 0) + 1);
    }
    let reason: MembershipReviewReason | undefined;
    if (revision.lockedFileIds.includes(file.id)) reason = 'manual-override';
    else if (decision.groupId === null) reason = 'uncertain';
    else if (decision.confidence === undefined) reason = 'missing-confidence';
    else if (decision.confidence < minimumConfidence) reason = 'low-confidence';
    else if (!evaluated) reason = 'unreviewed-model';
    else if (coverage <= 0 || coverage < policy!.minimumEvidenceCoverage) reason = 'incomplete-evidence';
    else if (decision.groupId !== baseline) {
      const targetSupport = support.get(decision.groupId) ?? 0;
      if (!targetSupport) reason = 'missing-evidence';
      else if ([...support].some(([id, count]) => id !== decision.groupId && count >= targetSupport)) reason = 'conflicting-evidence';
    }
    if (!reason && decision.groupId !== null) membership[file.id] = decision.groupId;
    const evidenceIds = [file.evidenceId, ...incident.map(edge => edge.evidenceId)];
    if (reason) reviewItems.push({ fileId: file.id, reason, message: reviewMessages[reason], evidenceIds });
    detailed.push({ schemaVersion: '1', snapshotId: snapshot.id, fileId: file.id, groupId: membership[file.id]!, proposedGroupId: decision.groupId, origin: 'ai-jev', evidenceIds, ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}), model, evidenceCoverage: coverage, outcome: !reason && decision.groupId !== baseline ? 'proposed' : 'retained', ...(reason ? { reviewReason: reason } : {}), rationale: reason ? reviewMessages[reason] : 'Jev selected an existing island using bounded observed facts. Model confidence is uncertainty, not observed accuracy; the grouping remains a preview until applied.' });
  }
  const supportedGroups = new Set(detailed.filter(decision => !decision.reviewReason).map(decision => decision.groupId));
  const groups: Group[] = revision.groups.map(group => {
    const label = validatedLabels.find(item => item.groupId === group.id);
    return label && evaluated && supportedGroups.has(group.id) && !revision.lockedGroupIds.includes(group.id) ? { ...clone(group), label: label.label, origin: 'ai' } : clone(group);
  });
  const changedMemberships = snapshot.nodes.filter(file => membership[file.id] !== revision.membership[file.id]).map(file => ({ fileId: file.id, fromGroupId: revision.membership[file.id]!, toGroupId: membership[file.id]! }));
  return { groups, membership, decisions: detailed, reviewItems, changedMemberships, labelEvidence: clone(validatedLabels), evaluation: { policyVersion: GROUPING_PIPELINE_VERSION, evaluationId: evaluated ? policy!.evaluationId : null, expectedModel: policy?.evaluatedJevModel ?? null, actualModel: model, status: evaluated ? 'evaluated' as const : 'unreviewed' as const, confidenceMeaning: 'Provider confidence describes model uncertainty. It is not measured correctness; evidence coverage is reported separately.' } };
}
