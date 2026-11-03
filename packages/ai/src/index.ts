import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GraphSnapshot, Group } from '@patchwork/contracts';
import { decideMembership, discoverJevModel, generateLabels, plainText, type EvidenceBundle, type RequestBudget } from './providers';
import { GroupingError, type GroupingConfig, type GroupingOperation, type GroupingProposal, type GroupingResult, type GroupingRevision, type RequestContext } from './types';
import { AI_FIELDS_SENT, AI_POLICY_VERSION, createExternalDataPolicy, externalGroupingCacheKey } from './policy';
import { ProviderBudgetLedger } from './budget';

export * from './types';
export * from './contracts';
import { GroupingRevisionSchema, validateGroupingProposal, validateGroupingRevision } from './contracts';
export { validateCandidateLabels, TypeSafeDecisionProvider, OpenAIGenerativeProvider, PROVIDER_CONTRACT_VERSION, LABEL_PROMPT_VERSION, MEMBERSHIP_PROMPT_VERSION, type DecisionProvider, type GenerativeProvider, type ChoiceQuestion, type ScoreQuestion, type NoulQuestion, type ChoiceAnswer, type ScoreAnswer, type NoulAnswer, type DecisionResponse, type DiscoveredModel } from './providers';
export { createExternalDataPolicy, externalGroupingCacheKey } from './policy';

const MAX_CONTEXTS = 100;
const MAX_REVISIONS = 20;
const copy = <T>(value: T): T => structuredClone(value);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownRecord = (): Record<string, string> => Object.create(null) as Record<string, string>;
const repositoryKey = (snapshot: GraphSnapshot): string => snapshot.repository.fullName;

function assertSnapshot(snapshot: GraphSnapshot): void {
  if (snapshot.schemaVersion !== '1' || !snapshot.id || !snapshot.nodes.length || !snapshot.groups.length) throw new GroupingError('INVALID_SNAPSHOT', 'Grouping requires a versioned, non-empty analyzed snapshot.');
  const groups = new Set(snapshot.groups.map(group => group.id));
  const files = new Set(snapshot.nodes.map(node => node.id));
  if (groups.size !== snapshot.groups.length || files.size !== snapshot.nodes.length || snapshot.nodes.some(node => !groups.has(node.groupId))) throw new GroupingError('INVALID_SNAPSHOT', 'Snapshot file and group identities must be unique and complete.');
}

function membershipOf(snapshot: GraphSnapshot): Record<string, string> {
  const membership = ownRecord();
  for (const node of snapshot.nodes) membership[node.id] = node.groupId;
  return membership;
}

function assertMembership(snapshot: GraphSnapshot, groups: Group[], membership: Record<string, string>): void {
  const ids = new Set(groups.map(group => group.id));
  if (ids.size !== groups.length || Object.keys(membership).length !== snapshot.nodes.length || snapshot.nodes.some(node => !Object.hasOwn(membership, node.id) || !ids.has(membership[node.id]!))) throw new GroupingError('INVALID_MEMBERSHIP', 'Every file must belong to exactly one existing island.');
}

function makeEvidence(snapshot: GraphSnapshot, revision: GroupingRevision, maxFiles: number, policy: ReturnType<typeof createExternalDataPolicy>): { evidence: EvidenceBundle; excludedFiles: number } {
  const eligible = snapshot.nodes.filter(node => !policy.excludeFile(node));
  const unlocked = eligible.filter(node => !revision.lockedFileIds.includes(node.id));
  const files = unlocked.slice().sort((a, b) => a.id.localeCompare(b.id)).slice(0, maxFiles);
  // A bounded subset is explicit in dataPolicy; omitted files retain their existing membership.
  const selectedIds = new Set(files.map(file => file.id));
  const relevantGroups = revision.groups.filter(group => files.some(file => revision.membership[file.id] === group.id));
  const groups = relevantGroups.slice(0, 64).map((group, index) => ({ id: group.id, label: policy.sanitizeLabel(group.label, `Island ${index + 1}`), paths: eligible.filter(node => revision.membership[node.id] === group.id).slice(0, 8).map(node => node.path.slice(0, 300)) }));
  const groupIds = new Set(groups.map(group => group.id));
  const evidenceFiles = files.filter(file => groupIds.has(revision.membership[file.id]!)).map(file => ({
    id: file.id, path: file.path.slice(0, 300), groupId: revision.membership[file.id]!, evidenceId: `file:${file.id}`,
    imports: snapshot.edges.filter(edge => edge.source === file.id && selectedIds.has(edge.target)).slice(0, 12).map(edge => edge.target),
  }));
  return { evidence: { files: evidenceFiles, groups, allowedEvidenceIds: evidenceFiles.map(file => file.evidenceId) }, excludedFiles: snapshot.nodes.length - eligible.length };
}

interface ProposalEntry { tenantId: string; repository: string; proposal: GroupingProposal; expires: number }
interface HistoryEntry { key: string; revisions: GroupingRevision[] }
interface SharedProposal { promise: Promise<GroupingProposal>; controller: AbortController; subscribers: number; settled: boolean; tenantId: string; repository: string }
interface CachedProposal { proposal: GroupingProposal; expires: number; tenantId: string; repository: string }

/** Server-only, bounded grouping registry. A configured storagePath persists manual history locally. */
export class GroupingService {
  private readonly config: Required<Pick<GroupingConfig, 'maxFiles' | 'maxRequestsPerAnalysis' | 'maxRequestsPerTenant' | 'maxInputCharacters' | 'minimumConfidence' | 'timeoutMs'>> & GroupingConfig;
  private readonly histories = new Map<string, GroupingRevision[]>();
  private readonly proposals = new Map<string, ProposalEntry>();
  private readonly cached = new Map<string, CachedProposal>();
  private readonly inflight = new Map<string, SharedProposal>();
  private readonly policy: ReturnType<typeof createExternalDataPolicy>;
  private readonly ledger: ProviderBudgetLedger;
  private active = 0;

  constructor(config: GroupingConfig = {}) {
    this.config = {
      maxFiles: 32, maxRequestsPerAnalysis: 5, maxRequestsPerTenant: 100, maxInputCharacters: 40_000, minimumConfidence: 0.8, timeoutMs: 15_000,
      ...config,
    };
    if (!Number.isSafeInteger(this.config.maxFiles) || this.config.maxFiles < 1 || this.config.maxFiles > 64 || !Number.isSafeInteger(this.config.maxRequestsPerAnalysis) || this.config.maxRequestsPerAnalysis < 3 || this.config.maxRequestsPerAnalysis > 10 || !Number.isFinite(this.config.minimumConfidence) || this.config.minimumConfidence < 0 || this.config.minimumConfidence > 1) throw new GroupingError('INVALID_CONFIG', 'AI limits are outside the supported bounds.');
    if (!Number.isSafeInteger(this.config.maxRequestsPerTenant) || this.config.maxRequestsPerTenant < 1 || !Number.isSafeInteger(this.config.maxInputCharacters) || this.config.maxInputCharacters < 1 || this.config.maxInputCharacters > 100_000 || !Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs < 1 || this.config.timeoutMs > 60_000 || this.config.proposalTtlMs !== undefined && (!Number.isSafeInteger(this.config.proposalTtlMs) || this.config.proposalTtlMs < 1 || this.config.proposalTtlMs > 900_000) || this.config.maxReservedTokensPerTenant !== undefined && (!Number.isSafeInteger(this.config.maxReservedTokensPerTenant) || this.config.maxReservedTokensPerTenant < 1)) throw new GroupingError('INVALID_CONFIG', 'AI budget or retention settings are outside the supported bounds.');
    this.policy = createExternalDataPolicy(this.config.excludedPaths);
    this.ledger = new ProviderBudgetLedger(this.config.maxRequestsPerTenant, this.config.maxReservedTokensPerTenant ?? 1_000_000);
    this.restore();
  }

  capabilities() {
    const configured = Boolean(this.config.jevApiKey && this.config.jevModel && this.config.generativeApiKey && this.config.generativeModel);
    return {
      enabled: Boolean(this.config.enabled), configured, available: Boolean(this.config.enabled && configured),
      jevConfigured: Boolean(this.config.jevApiKey && this.config.jevModel),
      generativeConfigured: Boolean(this.config.generativeApiKey && this.config.generativeModel),
      models: { jev: this.config.jevModel ?? null, generative: this.config.generativeModel ?? null },
      policy: { version: AI_POLICY_VERSION, fieldsSent: AI_FIELDS_SENT, sourceExcerpts: false, maxFiles: this.config.maxFiles, maxRequests: this.config.maxRequestsPerAnalysis, maxOutputTokens: 3000, proposalRetentionMs: this.config.proposalTtlMs ?? 900_000, currencyBudgetVerified: false },
      persistence: this.config.storagePath ? 'local-file' : 'process-memory',
      message: !this.config.enabled ? 'External AI is disabled. Folder grouping and manual corrections remain available.' : !configured ? 'Configure both model providers and pinned model names on the server to enable AI + Jev.' : 'External AI sends only the disclosed metadata when explicitly requested.',
    };
  }

  current(snapshot: GraphSnapshot, context: RequestContext = {}): GroupingRevision {
    assertSnapshot(snapshot);
    const key = this.contextKey(snapshot, context.tenantId);
    const history = this.histories.get(key);
    if (history?.length) {
      let revision = history[history.length - 1]!;
      const fileIds = new Set(snapshot.nodes.map(node => node.id));
      const changedInventory = Object.keys(revision.membership).length !== fileIds.size || snapshot.nodes.some(node => !Object.hasOwn(revision.membership, node.id));
      if (changedInventory) {
        // Source-only additions can extend an immutable context. Preserve known overrides;
        // new files use observed baseline membership and make existing proposals stale.
        const reconciled = history.map<GroupingRevision>(previous => {
          const membership = ownRecord();
          const groups = copy(previous.groups);
          for (const node of snapshot.nodes) {
            membership[node.id] = Object.hasOwn(previous.membership, node.id) ? previous.membership[node.id]! : node.groupId;
            if (!groups.some(group => group.id === membership[node.id])) groups.push(copy(snapshot.groups.find(group => group.id === membership[node.id])!));
          }
          const canonicalMembership = ownRecord();
          const canonicalGroups = copy(previous.canonicalHierarchy.groups);
          for (const node of snapshot.nodes) {
            canonicalMembership[node.id] = previous.canonicalHierarchy.membership[node.id] ?? node.groupId;
            if (!canonicalGroups.some(group => group.id === canonicalMembership[node.id])) canonicalGroups.push(copy(snapshot.groups.find(group => group.id === canonicalMembership[node.id])!));
          }
          return { ...previous, groups, membership, canonicalHierarchy: { groups: canonicalGroups, membership: canonicalMembership }, lockedFileIds: previous.lockedFileIds.filter(id => fileIds.has(id)), secondaryTags: previous.secondaryTags ? Object.fromEntries(Object.entries(previous.secondaryTags).filter(([id]) => fileIds.has(id))) : undefined };
        });
        const latest = reconciled[reconciled.length - 1]!;
        revision = { ...latest, id: `reconcile-${digest({ parent: latest.id, membership: latest.membership }).slice(0, 20)}`, createdAt: new Date().toISOString() };
        // An overlay refresh is not an extra undo step. Earlier manual states receive
        // the same new inventory, so undo remains meaningful after a source toggle.
        reconciled[reconciled.length - 1] = revision;
        this.histories.set(key, reconciled);
      }
      assertMembership(snapshot, revision.groups, revision.membership);
      return copy(validateGroupingRevision(revision, snapshot));
    }
    const baseline: GroupingRevision = {
      schemaVersion: '1', status: 'accepted', provenance: { snapshotId: snapshot.id, contextSha: snapshot.contextSha, source: 'canonical' }, canonicalHierarchy: { groups: copy(snapshot.groups), membership: membershipOf(snapshot) },
      id: `baseline-${digest({ snapshot: snapshot.id, groups: snapshot.groups, membership: membershipOf(snapshot) }).slice(0, 20)}`,
      snapshotId: snapshot.id, parentRevisionId: null, origin: 'rules', groups: copy(snapshot.groups), membership: membershipOf(snapshot), lockedFileIds: [], lockedGroupIds: [], createdAt: new Date().toISOString(),
    };
    this.histories.set(key, [baseline]);
    this.trimHistories();
    return copy(validateGroupingRevision(baseline, snapshot));
  }

  /** Reapply accepted/manual grouping after a source overlay is refreshed. */
  view(snapshot: GraphSnapshot, context: RequestContext = {}): GroupingResult {
    const revision = this.current(snapshot, context);
    return { snapshot: this.snapshotWith(snapshot, revision), revision };
  }

  async propose(snapshot: GraphSnapshot, options: RequestContext & { enabled?: boolean } = {}): Promise<GroupingProposal> {
    this.pruneExternalData();
    const revision = this.current(snapshot, options);
    const { evidence, excludedFiles } = makeEvidence(snapshot, revision, this.config.maxFiles, this.policy);
    const baseline = (message: string): GroupingProposal => validateGroupingProposal({
      schemaVersion: '1', provenance: copy(revision.provenance),
      id: `baseline-${randomUUID()}`, snapshotId: snapshot.id, parentRevisionId: revision.id, status: 'baseline', origin: revision.origin, groups: copy(revision.groups), membership: copy(revision.membership), decisions: [], message, createdAt: new Date().toISOString(),
      dataPolicy: { fieldsSent: [], excludedFiles, analyzedFiles: 0 },
    }, snapshot, revision.groups.map(group => group.id));
    if (!options.enabled || !this.capabilities().available) return baseline(this.capabilities().message);
    if (options.signal?.aborted) return baseline('Grouping analysis was cancelled. The current grouping is retained.');
    if (!evidence.files.length) return baseline('No eligible unlocked files are available for external grouping.');
    if (JSON.stringify(evidence).length > this.config.maxInputCharacters) return baseline('The metadata budget was exceeded. Narrow the repository scope before requesting AI grouping.');
    const tenantId = options.tenantId ?? 'local';
    const repository = repositoryKey(snapshot);
    const cacheKey = externalGroupingCacheKey({ tenantId, snapshot, revisionId: revision.id, evidence, jevModel: this.config.jevModel, generativeModel: this.config.generativeModel, policyDigest: this.policy.digest, minimumConfidence: this.config.minimumConfidence });
    const cached = this.cached.get(cacheKey);
    if (cached) { this.registerProposal(snapshot, cached.proposal, options); this.telemetry(cached.proposal, 0, true); return copy(cached.proposal); }
    const running = this.inflight.get(cacheKey);
    if (running) return this.subscribe(running, options.signal, baseline);
    if (this.active >= 2) return baseline('Grouping capacity is busy. The current grouping is retained; try again shortly.');
    this.active++;
    const controller = new AbortController();
    const startedAt = Date.now();
    const metrics = { requests: 0 };
    const entry: SharedProposal = { promise: Promise.resolve(null as unknown as GroupingProposal), controller, subscribers: 0, settled: false, tenantId, repository };
    const work = this.runProviders(snapshot, revision, evidence, excludedFiles, { ...options, signal: controller.signal }, metrics).then(proposal => {
      if (controller.signal.aborted) return baseline('Grouping analysis was cancelled. The current grouping is retained.');
      this.cached.set(cacheKey, { proposal: copy(proposal), expires: Date.now() + (this.config.proposalTtlMs ?? 900_000), tenantId, repository });
      if (this.cached.size > 64) this.cached.delete(this.cached.keys().next().value!);
      this.registerProposal(snapshot, proposal, options);
      return proposal;
    }).catch((error: unknown) => baseline(error instanceof GroupingError ? `${error.message} The current grouping is retained.` : 'Grouping analysis failed. The current grouping is retained.')).then(proposal => {
      this.telemetry(proposal, Date.now() - startedAt, false, metrics.requests);
      return proposal;
    }).finally(() => {
      entry.settled = true; this.active--; this.inflight.delete(cacheKey);
    });
    entry.promise = work;
    this.inflight.set(cacheKey, entry);
    return this.subscribe(entry, options.signal, baseline);
  }

  /** Preview only the metadata that passes policy; excluded names are never echoed. */
  previewPolicy(snapshot: GraphSnapshot, context: RequestContext = {}) {
    const { evidence, excludedFiles } = makeEvidence(snapshot, this.current(snapshot, context), this.config.maxFiles, this.policy);
    return { version: AI_POLICY_VERSION, fieldsSent: AI_FIELDS_SENT.slice(), sourceExcerpts: false, excludedFiles, analyzedFiles: evidence.files.length, metadata: evidence, externalEnabled: this.capabilities().available };
  }

  /** Purge ephemeral provider data for disconnect/revocation; accepted manual history is separate. */
  clearExternalData(context: { tenantId?: string; repository?: string } = {}): void {
    const tenant = context.tenantId ?? 'local';
    const matches = (entry: { tenantId: string; repository: string }) => entry.tenantId === tenant && (!context.repository || entry.repository.toLowerCase() === context.repository.toLowerCase());
    for (const [key, entry] of this.cached) if (matches(entry)) this.cached.delete(key);
    for (const [key, entry] of this.proposals) if (matches(entry)) this.proposals.delete(key);
    for (const entry of this.inflight.values()) if (matches(entry)) entry.controller.abort();
  }

  private pruneExternalData() {
    const now = Date.now();
    for (const [key, entry] of this.cached) if (entry.expires <= now) this.cached.delete(key);
    for (const [key, entry] of this.proposals) if (entry.expires <= now) this.proposals.delete(key);
  }
  private async subscribe(entry: SharedProposal, signal: AbortSignal | undefined, baseline: (message: string) => GroupingProposal): Promise<GroupingProposal> {
    entry.subscribers++;
    const cancelled = () => baseline('Grouping analysis was cancelled. The current grouping is retained.');
    if (signal?.aborted) { entry.subscribers--; if (!entry.subscribers && !entry.settled) entry.controller.abort(); return cancelled(); }
    let listener: (() => void) | undefined;
    try {
      const proposal = signal ? await Promise.race([entry.promise, new Promise<GroupingProposal>(resolve => { listener = () => resolve(cancelled()); signal.addEventListener('abort', listener, { once: true }); })]) : await entry.promise;
      return copy(proposal);
    } finally {
      if (listener) signal?.removeEventListener('abort', listener);
      entry.subscribers--; if (!entry.subscribers && !entry.settled) entry.controller.abort();
    }
  }
  private telemetry(proposal: GroupingProposal, durationMs: number, cacheHit: boolean, requests = 0) {
    // Explicit allowlist: no tenant/repo identifiers, prompts, paths, provider messages or secrets.
    try { this.config.onTelemetry?.({ event: 'grouping', outcome: proposal.status, durationMs, requests: cacheHit ? 0 : requests, inputTokens: cacheHit ? 0 : proposal.usage?.inputTokens ?? null, outputTokens: cacheHit ? 0 : proposal.usage?.outputTokens ?? null, cacheHit }); } catch { /* A metrics sink cannot interrupt the review flow. */ }
  }

  apply(snapshot: GraphSnapshot, proposalId: string, context: RequestContext = {}): GroupingResult {
    const entry = this.proposals.get(proposalId);
    const tenant = context.tenantId ?? 'local';
    if (!entry || entry.expires < Date.now() || entry.tenantId !== tenant || entry.repository !== repositoryKey(snapshot) || entry.proposal.snapshotId !== snapshot.id) throw new GroupingError('PROPOSAL_NOT_FOUND', 'This proposal is unavailable for this repository session.');
    const current = this.current(snapshot, context);
    if (entry.proposal.parentRevisionId !== current.id) throw new GroupingError('REVISION_CONFLICT', 'Grouping changed since this proposal. Request a new preview.');
    const revision: GroupingRevision = {
      ...current, id: `grouping-${randomUUID()}`, parentRevisionId: current.id, origin: 'ai-jev', provenance: { snapshotId: snapshot.id, contextSha: snapshot.contextSha, source: 'model', models: entry.proposal.models }, groups: copy(entry.proposal.groups), membership: copy(entry.proposal.membership), createdAt: new Date().toISOString(),
    };
    const result = this.commit(snapshot, revision, context);
    this.proposals.delete(proposalId);
    return result;
  }

  mutate(snapshot: GraphSnapshot, operation: GroupingOperation, context: RequestContext = {}): GroupingResult {
    const current = this.current(snapshot, context);
    if (context.expectedRevisionId && context.expectedRevisionId !== current.id) throw new GroupingError('REVISION_CONFLICT', 'Grouping changed. Review the latest revision before editing.');
    if (!operation || typeof operation !== 'object') throw new GroupingError('INVALID_OPERATION', 'A grouping operation is required.');
    const groups = copy(current.groups);
    const membership = copy(current.membership);
    const lockedFiles = new Set(current.lockedFileIds);
    const lockedGroups = new Set(current.lockedGroupIds);
    const requireGroup = (id: string) => {
      const group = groups.find(group => group.id === id);
      if (!group) throw new GroupingError('UNKNOWN_ID', 'The selected island does not exist.');
      return group;
    };
    const requireFiles = (fileIds: string[]) => {
      if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > snapshot.nodes.length || new Set(fileIds).size !== fileIds.length || fileIds.some(id => typeof id !== 'string' || !Object.hasOwn(membership, id))) throw new GroupingError('UNKNOWN_ID', 'Select existing unique file IDs.');
    };
    if (operation.type === 'rename') {
      const group = requireGroup(operation.groupId);
      group.label = plainText(operation.label, 64); group.origin = 'manual';
      lockedGroups.add(operation.groupId);
    } else if (operation.type === 'move') {
      requireGroup(operation.groupId); requireFiles(operation.fileIds);
      for (const id of operation.fileIds) { membership[id] = operation.groupId; lockedFiles.add(id); }
    } else if (operation.type === 'merge') {
      if (!Array.isArray(operation.groupIds) || new Set(operation.groupIds).size !== operation.groupIds.length || operation.groupIds.length < 2) throw new GroupingError('INVALID_OPERATION', 'Select at least two distinct islands to merge.');
      operation.groupIds.forEach(requireGroup);
      const destination = requireGroup(operation.groupIds[0]!);
      destination.label = plainText(operation.label, 64); destination.origin = 'manual';
      for (const node of snapshot.nodes) if (operation.groupIds.includes(membership[node.id]!)) { membership[node.id] = destination.id; lockedFiles.add(node.id); }
      for (let index = groups.length - 1; index >= 0; index--) if (operation.groupIds.slice(1).includes(groups[index]!.id)) groups.splice(index, 1);
      lockedGroups.add(destination.id);
    } else if (operation.type === 'split') {
      const source = requireGroup(operation.groupId); requireFiles(operation.fileIds);
      const total = Object.values(membership).filter(id => id === source.id).length;
      if (operation.fileIds.length >= total || operation.fileIds.some(id => membership[id] !== source.id)) throw new GroupingError('INVALID_OPERATION', 'Split requires a proper subset of files from one island.');
      const destination: Group = { ...copy(source), id: `manual-${randomUUID()}`, label: plainText(operation.label, 64), origin: 'manual' };
      groups.push(destination);
      for (const id of operation.fileIds) { membership[id] = destination.id; lockedFiles.add(id); }
      lockedGroups.add(destination.id);
    } else throw new GroupingError('INVALID_OPERATION', 'Unsupported grouping operation.');
    return this.commit(snapshot, { ...current, id: `grouping-${randomUUID()}`, parentRevisionId: current.id, origin: 'manual', provenance: { snapshotId: snapshot.id, contextSha: snapshot.contextSha, source: 'manual' }, groups, membership, lockedFileIds: [...lockedFiles], lockedGroupIds: [...lockedGroups].filter(id => groups.some(group => group.id === id)), createdAt: new Date().toISOString() }, context);
  }

  undo(snapshot: GraphSnapshot, context: RequestContext = {}): GroupingResult {
    const current = this.current(snapshot, context);
    if (context.expectedRevisionId && current.id !== context.expectedRevisionId) throw new GroupingError('REVISION_CONFLICT', 'Grouping changed. Review the latest revision before undo.');
    const key = this.contextKey(snapshot, context.tenantId);
    const history = this.histories.get(key)!;
    if (history.length < 2) throw new GroupingError('NOTHING_TO_UNDO', 'There is no earlier grouping revision in this session.');
    const previous = history[history.length - 2]!;
    assertMembership(snapshot, previous.groups, previous.membership);
    this.histories.set(key, history.slice(0, -1));
    try { this.persist(); } catch (error) { this.histories.set(key, history); throw error; }
    return { snapshot: this.snapshotWith(snapshot, previous), revision: copy(previous) };
  }

  private async runProviders(snapshot: GraphSnapshot, revision: GroupingRevision, evidence: EvidenceBundle, excludedFiles: number, context: RequestContext, metrics: { requests: number }): Promise<GroupingProposal> {
    const tenant = context.tenantId ?? 'local';
    // Reserve the complete retry envelope atomically before even model discovery.
    // Character count is a deliberately conservative token upper estimate, not pricing.
    const reservation = this.ledger.reserve(tenant, this.config.maxRequestsPerAnalysis, this.config.maxRequestsPerAnalysis * (this.config.maxInputCharacters + 3000));
    let actualTokens: number | undefined;
    const budget: RequestBudget = {
      requests: 0, maxRequests: this.config.maxRequestsPerAnalysis, maxInputCharacters: this.config.maxInputCharacters, fetch: this.config.fetch ?? fetch, signal: context.signal, timeoutMs: this.config.timeoutMs,
      reserveRequest: () => { metrics.requests++; },
    };
    try {
    await discoverJevModel(this.config.jevApiKey!, this.config.jevModel!, budget);
    const generated = await generateLabels({ apiKey: this.config.generativeApiKey!, model: this.config.generativeModel! }, evidence, budget);
    const decisions = await decideMembership({ apiKey: this.config.jevApiKey!, model: this.config.jevModel! }, evidence, generated.labels, budget);
    actualTokens = generated.usage.inputTokens + generated.usage.outputTokens + decisions.usage.inputTokens + decisions.usage.outputTokens;
    const groups = revision.groups.map(group => {
      const proposed = generated.labels.find(label => label.groupId === group.id);
      return proposed && !revision.lockedGroupIds.includes(group.id) ? { ...group, label: proposed.label, origin: 'ai' as const } : copy(group);
    });
    const membership = copy(revision.membership);
    const detailed = decisions.decisions.map(decision => {
      const accepted = decision.groupId !== null && typeof decision.confidence === 'number' && decision.confidence >= this.config.minimumConfidence && !revision.lockedFileIds.includes(decision.fileId);
      if (accepted) membership[decision.fileId] = decision.groupId!;
      return { schemaVersion: '1' as const, snapshotId: snapshot.id, fileId: decision.fileId, groupId: membership[decision.fileId]!, origin: 'ai-jev' as const, evidenceIds: [`file:${decision.fileId}`], confidence: decision.confidence, model: decisions.model,
        rationale: accepted ? 'Jev selected this existing island from bounded path and import evidence. Confidence describes model uncertainty, not verified accuracy.' : 'Evidence was uncertain or a manual override is active; the existing island is retained.',
      };
    });
    assertMembership(snapshot, groups, membership);
    return {
      schemaVersion: '1', provenance: { snapshotId: snapshot.id, contextSha: snapshot.contextSha, source: 'model', models: { generative: generated.model, jev: decisions.model } },
      id: `proposal-${randomUUID()}`, snapshotId: snapshot.id, parentRevisionId: revision.id, status: 'proposed', origin: 'ai-jev', groups, membership, decisions: detailed,
      message: `AI + Jev reviewed ${evidence.files.length} eligible files. Review this bounded proposal before applying; other files keep their current membership.`, createdAt: new Date().toISOString(),
      models: { generative: generated.model, jev: decisions.model },
      usage: { inputTokens: generated.usage.inputTokens + decisions.usage.inputTokens, outputTokens: generated.usage.outputTokens + decisions.usage.outputTokens, requests: budget.requests },
      dataPolicy: { fieldsSent: AI_FIELDS_SENT.slice(), excludedFiles, analyzedFiles: evidence.files.length },
    };
    } finally { reservation.settle(budget.requests, actualTokens); }
  }

  private contextKey(snapshot: GraphSnapshot, tenant = 'local') { return digest({ tenant, repository: repositoryKey(snapshot), snapshot: snapshot.id }); }
  private registerProposal(snapshot: GraphSnapshot, proposal: GroupingProposal, context: RequestContext) {
    validateGroupingProposal(proposal, snapshot, this.current(snapshot, context).groups.map(group => group.id));
    this.pruneExternalData();
    this.proposals.set(proposal.id, { tenantId: context.tenantId ?? 'local', repository: repositoryKey(snapshot), proposal: copy(proposal), expires: Date.now() + (this.config.proposalTtlMs ?? 900_000) });
    if (this.proposals.size > 100) this.proposals.delete(this.proposals.keys().next().value!);
  }
  private snapshotWith(snapshot: GraphSnapshot, revision: GroupingRevision): GraphSnapshot {
    return { ...copy(snapshot), groups: copy(revision.groups), nodes: snapshot.nodes.map(node => ({ ...copy(node), groupId: revision.membership[node.id]! })) };
  }
  private commit(snapshot: GraphSnapshot, revision: GroupingRevision, context: RequestContext): GroupingResult {
    validateGroupingRevision(revision, snapshot);
    assertMembership(snapshot, revision.groups, revision.membership);
    const key = this.contextKey(snapshot, context.tenantId);
    const previous = this.histories.get(key)!;
    this.histories.set(key, [...previous, copy(revision)].slice(-MAX_REVISIONS));
    this.trimHistories();
    try { this.persist(); } catch (error) { this.histories.set(key, previous); throw error; }
    return { snapshot: this.snapshotWith(snapshot, revision), revision: copy(revision) };
  }
  private trimHistories() { while (this.histories.size > MAX_CONTEXTS) this.histories.delete(this.histories.keys().next().value!); }
  private persist() {
    if (!this.config.storagePath) return;
    const target = this.config.storagePath;
    try {
      mkdirSync(dirname(target), { recursive: true });
      const data = JSON.stringify({ version: 1, histories: [...this.histories].map(([key, revisions]) => ({ key, revisions })) });
      if (Buffer.byteLength(data) > 20_000_000) throw new Error('size');
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, target);
    } catch { throw new GroupingError('STORAGE_ERROR', 'Grouping changes could not be saved. The previous revision is retained.'); }
  }
  private restore() {
    if (!this.config.storagePath || !existsSync(this.config.storagePath)) return;
    try {
      const contents = readFileSync(this.config.storagePath, 'utf8');
      if (Buffer.byteLength(contents) > 20_000_000) throw new Error('size');
      const data = JSON.parse(contents) as { version: number; histories: HistoryEntry[] };
      if (data.version !== 1 || !Array.isArray(data.histories) || data.histories.length > MAX_CONTEXTS) throw new Error('shape');
      for (const entry of data.histories) {
        if (typeof entry.key !== 'string' || !Array.isArray(entry.revisions) || !entry.revisions.length || entry.revisions.length > MAX_REVISIONS || entry.revisions.some(revision => typeof revision.id !== 'string' || !Array.isArray(revision.groups) || !revision.membership || !Array.isArray(revision.lockedFileIds) || !Array.isArray(revision.lockedGroupIds))) throw new Error('shape');
        this.histories.set(entry.key, entry.revisions.map(revision => { const result = GroupingRevisionSchema.safeParse(revision); if (!result.success) throw new Error('shape'); return result.data as GroupingRevision; }));
      }
    } catch { throw new GroupingError('STORAGE_ERROR', 'Saved grouping history is invalid. Restore a valid local data file before starting.'); }
  }
}
