import { GroupSchema, type GraphSnapshot, type Group } from '@patchwork/contracts';
import { z } from 'zod';

export type ReviewDecision = { fileId: string; groupId?: string; islandId?: string; rationale?: string; evidenceIds?: string[]; confidence?: number; model?: string; origin?: string; evidenceCoverage?: number; outcome?: 'proposed' | 'retained'; reviewReason?: string };
export type ReviewProposal = {
  id?: string; snapshotId?: string; status: string; origin?: string; groups?: Group[]; membership?: Record<string, string>;
  decisions?: ReviewDecision[]; message?: string; parentRevisionId?: string | null;
  models?: { generative: string; jev: string };
  labelEvidence?: { groupId: string; label: string; rationale: string; evidenceIds: string[] }[];
  dataPolicy?: { fieldsSent: string[]; excludedFiles: number; analyzedFiles: number };
};
export type ReviewRevision = {
  id: string; parentRevisionId?: string | null; origin?: string; schemaVersion?: string;
  provenance?: { source?: string; snapshotId?: string; contextSha?: string };
  decisions?: ReviewDecision[]; models?: { generative: string; jev: string };
};

const reviewProposalSchema = z.object({
  id: z.string().optional(), snapshotId: z.string().optional(), status: z.enum(['proposed', 'baseline']), origin: z.string().optional(),
  parentRevisionId: z.string().nullable().optional(), message: z.string().optional(),
  groups: z.array(GroupSchema).optional(), membership: z.record(z.string(), z.string()).optional(),
  decisions: z.array(z.object({ fileId: z.string(), groupId: z.string().optional(), islandId: z.string().optional(), rationale: z.string().optional(), evidenceIds: z.array(z.string()).optional(), confidence: z.number().finite().min(0).max(1).optional(), model: z.string().optional(), origin: z.string().optional(), evidenceCoverage: z.number().finite().min(0).max(1).optional(), outcome: z.enum(['proposed', 'retained']).optional(), reviewReason: z.string().optional() })).optional(),
  models: z.object({ generative: z.string(), jev: z.string() }).optional(),
  labelEvidence: z.array(z.object({ groupId: z.string(), label: z.string(), rationale: z.string(), evidenceIds: z.array(z.string()) })).optional(),
  dataPolicy: z.object({ fieldsSent: z.array(z.string()), excludedFiles: z.number().int().nonnegative(), analyzedFiles: z.number().int().nonnegative() }).optional(),
}).passthrough();

export function parseReviewProposal(value: unknown): ReviewProposal {
  const parsed = reviewProposalSchema.safeParse(value);
  return parsed.success ? parsed.data : { status: 'baseline', message: 'The grouping response was invalid. Your current grouping is retained; request another preview.' };
}

export const groupingSource = (snapshot: GraphSnapshot, revision?: ReviewRevision | null): string => {
  if (revision?.origin === 'manual' || revision?.provenance?.source === 'manual' || snapshot.groups.some(group => group.origin === 'manual')) return 'Manual override';
  if (revision?.origin === 'ai-jev' || revision?.provenance?.source === 'model' || snapshot.groups.some(group => group.origin === 'ai')) return 'Approved AI + Jev proposal';
  if (snapshot.groups.every(group => group.kind === 'folder' || group.origin === 'rules' || group.origin === undefined)) return 'Deterministic folder/module rules';
  return 'Deterministic code analysis';
};

/** The UI cannot authorize foreign IDs even if an upstream response is malformed. */
export function inspectProposal(snapshot: GraphSnapshot, proposal: ReviewProposal) {
  if (proposal.status === 'baseline') return { valid: true, error: '', changes: [] as { fileId: string; fromGroupId: string; toGroupId: string }[] };
  const groups = proposal.groups ?? [];
  const groupIds = new Set(groups.map(group => group.id));
  const fileIds = new Set(snapshot.nodes.map(node => node.id));
  const evidenceIds = new Set([...snapshot.nodes.flatMap(node => [node.id, `file:${node.id}`]), ...snapshot.edges.flatMap(edge => [edge.id, `edge:${edge.id}`])]);
  const membership = proposal.membership ?? {};
  const invalidMembership = groupIds.size !== groups.length || !groups.length || Object.keys(membership).length !== fileIds.size || Object.keys(membership).some(id => !fileIds.has(id)) || snapshot.nodes.some(node => !groupIds.has(membership[node.id]!));
  const invalidDecision = (proposal.decisions ?? []).some(decision => !fileIds.has(decision.fileId) || !groupIds.has(decision.groupId ?? decision.islandId ?? '') || (decision.evidenceIds ?? []).some(id => !evidenceIds.has(id)) || (decision.confidence !== undefined && (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1)));
  const invalidLabel = (proposal.labelEvidence ?? []).some(label => !groupIds.has(label.groupId) || label.evidenceIds.some(id => !evidenceIds.has(id)));
  const error = proposal.snapshotId !== undefined && proposal.snapshotId !== snapshot.id ? 'This proposal belongs to another repository snapshot.' : !['proposed'].includes(proposal.status) ? 'This response is not an applicable grouping proposal.' : invalidMembership ? 'Proposal membership is incomplete or contains unknown files or islands.' : invalidDecision || invalidLabel ? 'Proposal evidence contains an unknown reference or invalid uncertainty value.' : '';
  return { valid: !error, error, changes: error ? [] : snapshot.nodes.filter(node => membership[node.id] !== node.groupId).map(node => ({ fileId: node.id, fromGroupId: node.groupId, toGroupId: membership[node.id]! })) };
}

export function describeEvidence(snapshot: GraphSnapshot, id: string): string | null {
  const file = snapshot.nodes.find(node => node.id === id || `file:${node.id}` === id);
  if (file) return file.path;
  const edge = snapshot.edges.find(item => item.id === id || `edge:${item.id}` === id);
  if (!edge) return null;
  const source = snapshot.nodes.find(node => node.id === edge.source)?.path;
  const target = snapshot.nodes.find(node => node.id === edge.target)?.path;
  return source && target ? `${source} → ${target} (${edge.kind})` : null;
}
