import { z } from 'zod';
import { GroupSchema, type GraphSnapshot, type Group } from '@patchwork/contracts';
import { GroupingError, type GroupingProposal, type GroupingRevision, type MembershipDecision } from './types';

export const GROUPING_SCHEMA_VERSION = '1' as const;
const identity = z.string().min(1).max(500);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum).refine(value => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'Use bounded plain text');
const membership = z.record(identity, identity);
export const GroupingProvenanceSchema = z.object({
  snapshotId: identity,
  contextSha: identity,
  source: z.enum(['canonical', 'model', 'manual']),
  models: z.object({ generative: boundedText(160), jev: boundedText(160) }).optional(),
});
export const CanonicalHierarchySchema = z.object({ groups: z.array(GroupSchema), membership });

export const MembershipDecisionSchema = z.object({
  schemaVersion: z.literal(GROUPING_SCHEMA_VERSION),
  snapshotId: identity,
  fileId: identity,
  groupId: identity,
  origin: z.enum(['rules', 'ai-jev', 'manual']),
  evidenceIds: z.array(identity).max(64),
  confidence: z.number().finite().min(0).max(1).optional(),
  model: boundedText(160).optional(),
  rationale: boundedText(1000),
}).passthrough();

export const GroupingRevisionSchema = z.object({
  schemaVersion: z.literal(GROUPING_SCHEMA_VERSION),
  status: z.literal('accepted'),
  id: identity,
  snapshotId: identity,
  parentRevisionId: identity.nullable(),
  origin: z.enum(['rules', 'ai-jev', 'manual']),
  provenance: GroupingProvenanceSchema,
  canonicalHierarchy: CanonicalHierarchySchema,
  groups: z.array(GroupSchema),
  membership,
  secondaryTags: z.record(identity, z.array(boundedText(80)).max(16)).optional(),
  decisions: z.array(MembershipDecisionSchema).optional(),
  models: z.object({ generative: boundedText(160), jev: boundedText(160) }).optional(),
  lockedFileIds: z.array(identity),
  lockedGroupIds: z.array(identity),
  createdAt: z.string().datetime(),
}).passthrough();

export const GroupingProposalSchema = z.object({
  schemaVersion: z.literal(GROUPING_SCHEMA_VERSION),
  id: identity,
  snapshotId: identity,
  parentRevisionId: identity.nullable(),
  status: z.enum(['proposed', 'baseline']),
  origin: z.enum(['rules', 'ai-jev', 'manual']),
  provenance: GroupingProvenanceSchema,
  groups: z.array(GroupSchema),
  membership,
  decisions: z.array(MembershipDecisionSchema),
  message: boundedText(2000),
  createdAt: z.string().datetime(),
  models: z.object({ generative: boundedText(160), jev: boundedText(160) }).optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), requests: z.number().int().nonnegative() }).optional(),
  dataPolicy: z.object({ fieldsSent: z.array(boundedText(200)), excludedFiles: z.number().int().nonnegative(), analyzedFiles: z.number().int().nonnegative() }),
}).passthrough();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new GroupingError('INVALID_GROUPING_CONTRACT', 'Grouping data does not satisfy the versioned contract.');
  return result.data;
}

function assertContext(snapshot: GraphSnapshot, value: { snapshotId: string; provenance: { snapshotId: string; contextSha: string; source: string }; origin: string }) {
  if (value.snapshotId !== snapshot.id || value.provenance.snapshotId !== snapshot.id || value.provenance.contextSha !== snapshot.contextSha) throw new GroupingError('FOREIGN_SNAPSHOT', 'Grouping evidence belongs to a different snapshot.');
  const expectedSource = value.origin === 'rules' ? 'canonical' : value.origin === 'ai-jev' ? 'model' : 'manual';
  if (value.provenance.source !== expectedSource) throw new GroupingError('INVALID_PROVENANCE', 'The grouping source does not match its provenance.');
}

function assertPrimary(snapshot: GraphSnapshot, groups: Group[], values: Record<string, string>) {
  const ids = new Set(groups.map(group => group.id));
  const files = new Set(snapshot.nodes.map(node => node.id));
  if (!groups.length || ids.size !== groups.length || Object.keys(values).length !== files.size || Object.keys(values).some(id => !files.has(id)) || snapshot.nodes.some(node => !Object.hasOwn(values, node.id) || !ids.has(values[node.id]!))) throw new GroupingError('INVALID_MEMBERSHIP', 'Every known file must have exactly one primary island.');
}

export function validateMembershipDecision(input: unknown, snapshot: GraphSnapshot, groupIds = snapshot.groups.map(group => group.id)): MembershipDecision {
  const value = parse(MembershipDecisionSchema, input);
  if (value.snapshotId !== snapshot.id) throw new GroupingError('FOREIGN_SNAPSHOT', 'A membership decision belongs to a different snapshot.');
  const files = new Set(snapshot.nodes.map(node => node.id));
  if (!files.has(value.fileId) || !groupIds.includes(value.groupId)) throw new GroupingError('UNKNOWN_ID', 'A membership decision references an unknown file or island.');
  const evidence = new Set([...snapshot.nodes.map(node => `file:${node.id}`), ...snapshot.edges.flatMap(edge => [edge.id, `edge:${edge.id}`])]);
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length || value.evidenceIds.some(id => !evidence.has(id)) || (value.origin === 'ai-jev' && !value.evidenceIds.length)) throw new GroupingError('UNKNOWN_EVIDENCE', 'A membership decision references evidence outside this snapshot.');
  return value as MembershipDecision;
}

export function validateGroupingRevision(input: unknown, snapshot: GraphSnapshot): GroupingRevision {
  const value = parse(GroupingRevisionSchema, input);
  assertContext(snapshot, value);
  assertPrimary(snapshot, value.groups, value.membership);
  assertPrimary(snapshot, value.canonicalHierarchy.groups, value.canonicalHierarchy.membership);
  const files = new Set(snapshot.nodes.map(node => node.id));
  const groups = new Set(value.groups.map(group => group.id));
  if (new Set(value.lockedFileIds).size !== value.lockedFileIds.length || value.lockedFileIds.some(id => !files.has(id)) || new Set(value.lockedGroupIds).size !== value.lockedGroupIds.length || value.lockedGroupIds.some(id => !groups.has(id))) throw new GroupingError('UNKNOWN_ID', 'Revision locks reference unknown or duplicate identities.');
  if (value.secondaryTags && Object.entries(value.secondaryTags).some(([id, tags]) => !files.has(id) || new Set(tags).size !== tags.length)) throw new GroupingError('UNKNOWN_ID', 'Secondary tags require a known file and unique semantic labels.');
  const decided = new Set<string>();
  for (const decision of value.decisions ?? []) {
    validateMembershipDecision(decision, snapshot, [...groups]);
    if (decided.has(decision.fileId) || value.membership[decision.fileId] !== decision.groupId) throw new GroupingError('INVALID_MEMBERSHIP', 'Accepted decisions must be unique and match primary memberships.');
    decided.add(decision.fileId);
  }
  return value as GroupingRevision;
}

export function validateGroupingProposal(input: unknown, snapshot: GraphSnapshot, knownGroupIds = snapshot.groups.map(group => group.id)): GroupingProposal {
  const value = parse(GroupingProposalSchema, input);
  assertContext(snapshot, value);
  assertPrimary(snapshot, value.groups, value.membership);
  if (value.status === 'proposed' && value.origin !== 'ai-jev') throw new GroupingError('INVALID_PROVENANCE', 'Only model enrichment is a proposed revision.');
  if (value.status === 'proposed' && value.groups.some(group => !knownGroupIds.includes(group.id))) throw new GroupingError('UNKNOWN_ID', 'A model proposal cannot create an unrecognized island.');
  if (value.status === 'baseline' && (value.decisions.length || value.dataPolicy.fieldsSent.length || value.dataPolicy.analyzedFiles)) throw new GroupingError('INVALID_PROVENANCE', 'A retained baseline cannot claim a new model analysis.');
  const seen = new Set<string>();
  for (const decision of value.decisions) {
    validateMembershipDecision(decision, snapshot, value.groups.map(group => group.id));
    if (seen.has(decision.fileId) || value.membership[decision.fileId] !== decision.groupId) throw new GroupingError('INVALID_MEMBERSHIP', 'Proposal decisions must be unique and match primary memberships.');
    seen.add(decision.fileId);
  }
  if (value.dataPolicy.excludedFiles > snapshot.nodes.length || value.dataPolicy.analyzedFiles > snapshot.nodes.length - value.dataPolicy.excludedFiles) throw new GroupingError('INVALID_COVERAGE', 'Proposal coverage exceeds the snapshot inventory.');
  return value as GroupingProposal;
}
