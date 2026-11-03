import { createHash } from 'node:crypto';
import { validateGraphSnapshot, type GraphSnapshot, type ChangeSource, type FileChange, type FileNode, type ChangeStatus } from '@patchwork/contracts';
import { GitHubClient, GitHubError, parseRepository } from '@patchwork/github';
import type { AnalysisOptions } from './index';
import { deriveGroups, nodeForPath } from './groups';
import { languageFor } from './imports';
import { boundedGitComparison, boundedGitDiff } from './git-fallback';
import { enrichSelectedSourceDependencies } from './source-dependencies';

interface ApiCommit { sha: string; html_url?: string; commit: { message: string; committer?: { date?: string } }; parents: { sha: string }[]; files?: ApiFile[]; }
interface ApiPull { number: number; title: string; html_url: string; state: string; updated_at?: string; changed_files?: number; base: { sha: string; ref: string }; head: { sha: string; ref: string }; }
interface ApiFile { filename: string; previous_filename?: string; status: string; additions?: number; deletions?: number; sha?: string; binary?: boolean; }
interface ApiComparison { merge_base_commit: { sha: string }; files?: ApiFile[]; }
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_SELECTION = 20;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const unique = (values: string[]) => [...new Set(values)];
const prefixFor = (fullName: string) => '/repos/'+fullName.split('/').map(encodeURIComponent).join('/');
const statusFor = (value: string): ChangeStatus => ['added', 'modified', 'removed', 'renamed', 'copied', 'unchanged', 'binary'].includes(value) ? value as ChangeStatus : 'modified';
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value);
let validationNonce = 0;
const freshCheck = () => `state_check=${Date.now()}-${++validationNonce}`;
function permitsPinnedFallback(error: unknown): boolean {
  // This handles only an already-authorized source's object/file endpoint. It
  // never catches repository authorization or an invalid/expired credential.
  return error instanceof GitHubError && error.code !== 'AUTH_FAILED' && (error.status === 403 || error.status === 404 || error.status === 422 || error.status === 429 || error.status >= 500);
}

function toChanges(files: ApiFile[], snapshot: GraphSnapshot, sourceId: string): { changes: FileChange[]; nodes: FileNode[] } {
  const pathMap = new Map<string, FileNode[]>(); const extra: FileNode[] = [];
  const remember = (path: string, node: FileNode) => { const nodes = pathMap.get(path) ?? []; if (!nodes.includes(node)) nodes.push(node); pathMap.set(path, nodes); };
  for (const node of snapshot.nodes) { remember(node.path, node); if (Array.isArray(node.lineageAliases)) for (const alias of node.lineageAliases) if (typeof alias === 'string') remember(alias, node); }
  const unambiguous = (path: string) => { const candidates = pathMap.get(path) ?? []; return candidates.length === 1 ? candidates[0] : undefined; };
  const changes = files.map(file => {
    // A reported rename may map to a surviving context path, never an invented fuzzy rename.
    let node = unambiguous(file.filename) ?? (file.status === 'renamed' && file.previous_filename ? unambiguous(file.previous_filename) : undefined);
    // Independent source-only additions are not proven to share lineage, even
    // when their path/content is identical. Content equality is not ancestry.
    const candidates = pathMap.get(file.filename) ?? [];
    const ambiguousAddition = file.status === 'added' && candidates.some(candidate => candidate.presence === 'source-only' && !candidate.sourceIds.includes(sourceId));
    if (!node || ambiguousAddition) {
      // A confirmed rename anchors a missing-context identity at its former path.
      // A later deletion of that former path then resolves through the retained alias.
      const base = nodeForPath(snapshot.repository.fullName, file.status === 'renamed' && file.previous_filename ? file.previous_filename : file.filename);
      const candidateId = ambiguousAddition || file.status === 'added' ? `${base.id}@${hash(`${sourceId}:${file.sha ?? 'unknown-blob'}`).slice(0, 12)}` : base.id;
      node = snapshot.nodes.find(item => item.id === candidateId) ?? extra.find(item => item.id === candidateId);
      if (!node) { node = { ...base, path: file.filename, groupId: nodeForPath(snapshot.repository.fullName, file.filename).groupId, id: candidateId, presence: file.status === 'removed' ? 'deleted' : 'source-only', status: 'unparsed', language: languageFor(file.filename), sourceIds: [sourceId], importCoverage: 'excluded', importReasons: ['This file has no inventoried context blob. Its source-specific status and dependency evidence remain in the source comparison layer.'], blobSha: file.sha, ...(ambiguousAddition ? { ambiguousLineage: true } : {}) }; extra.push(node); }
      remember(file.filename, node);
    }
    if (file.status === 'renamed' && file.previous_filename) {
      node.lineageAliases = unique([node.path, file.filename, file.previous_filename, ...(Array.isArray(node.lineageAliases) ? node.lineageAliases.filter((value): value is string => typeof value === 'string') : [])]).sort();
      remember(file.previous_filename, node); remember(file.filename, node);
    }
    return { fileId: node.id, path: file.filename, status: statusFor(file.status), additions: Math.max(0, file.additions ?? 0), deletions: Math.max(0, file.deletions ?? 0), ...(file.binary ? { binary: true } : {}), ...(file.previous_filename ? { previousPath: file.previous_filename } : {}) };
  });
  return { changes, nodes: extra };
}

export async function loadSourceChanges(snapshot: GraphSnapshot, kind: 'pr' | 'commit', ids: string[], options: AnalysisOptions = {}): Promise<GraphSnapshot> {
  if (kind !== 'pr' && kind !== 'commit') throw new GitHubError('Choose pull requests or commits.', 400, 'INVALID_SOURCE');
  const selection = unique(ids);
  if (selection.length > MAX_SELECTION) throw new GitHubError(`Select up to ${MAX_SELECTION} changes at once.`, 400, 'SELECTION_LIMIT');
  const result = structuredClone(snapshot); const address = parseRepository(snapshot.repository.fullName); const prefix = prefixFor(address.fullName); const client = new GitHubClient(options);
  const reasons = [...result.coverage.reasons];
  for (const [index, id] of [...selection].sort().entries()) {
    options.signal?.throwIfAborted();
    const source = result.sources.find(item => item.id === id && item.kind === kind);
    if (!source) throw new GitHubError('Selected source is not part of this repository snapshot. Refresh the source list.', 400, 'UNKNOWN_SOURCE');
    if (source.loaded) continue;
    options.onProgress?.({ stage: 'sources', progress: Math.round((index / Math.max(selection.length, 1)) * 100), message: `Loading ${source.label}` });
    let files: ApiFile[] = []; let sourceReasons: string[] = [];
    let fallbackNeeded = false; let needsMergeBase = false;
    let pullPins: { number: number; baseSha: string; headSha: string } | undefined;
    if (kind === 'pr') {
      if (!source.number || !/^pr:\d+$/.test(id)) throw new GitHubError('Invalid pull request ID.', 400, 'INVALID_SOURCE');
      const pull = await client.get<ApiPull>(`${prefix}/pulls/${source.number}`);
      if ((source.headSha && source.headSha !== pull.head.sha) || ((source.baseRefSha ?? source.baseSha) && (source.baseRefSha ?? source.baseSha) !== pull.base.sha)) throw new GitHubError('This pull request changed since the snapshot was created. Refresh the repository before applying it.', 409, 'STALE_SOURCE');
      if (!isSha(pull.base.sha) || !isSha(pull.head.sha)) throw new GitHubError('GitHub did not supply pinned pull request objects.', 502, 'INVALID_RESPONSE');
      pullPins = { number: source.number, baseSha: pull.base.sha, headSha: pull.head.sha };
      source.baseRefSha = pull.base.sha; source.headSha = pull.head.sha; source.comparisonKind = 'merge-base'; source.sourceUpdatedAt = pull.updated_at;
      needsMergeBase = true;
      try {
        const comparison = await client.get<ApiComparison>(`${prefix}/compare/${pull.base.sha}...${pull.head.sha}?per_page=1`, true);
        if (!isSha(comparison.merge_base_commit?.sha)) throw new GitHubError('GitHub did not establish an immutable merge base.', 502, 'INVALID_RESPONSE');
        source.baseSha = comparison.merge_base_commit.sha; source.comparisonResolved = true; needsMergeBase = false;
        files = comparison.files ?? [];
        if (!comparison.files) { fallbackNeeded = true; sourceReasons.push(`${source.label}: GitHub did not supply a compared-file array.`); }
        if ((pull.changed_files ?? files.length) > files.length || files.length >= 300) {
          files = [];
          for (let page = 1; page <= 30; page++) { const batch = await client.page<ApiFile>(`${prefix}/pulls/${source.number}/files`, page, 100); files.push(...batch.items); if (!batch.nextPage) break; }
          const after = await client.get<ApiPull>(`${prefix}/pulls/${source.number}?${freshCheck()}`);
          if (after.head.sha !== pull.head.sha || after.base.sha !== pull.base.sha) throw new GitHubError('The pull request changed while files were loading. Refresh and retry.', 409, 'STALE_SOURCE');
          if ((pull.changed_files ?? 0) > files.length || files.length >= 3_000) { fallbackNeeded = true; sourceReasons.push(`${source.label}: GitHub's 3,000-file PR limit may truncate this change set.`); }
        }
      } catch (error) {
        if (options.signal?.aborted || !permitsPinnedFallback(error)) throw error;
        // A mutable files endpoint may have failed midway across a force push.
        // Discard that unverified array and compare the original pinned objects.
        files = []; fallbackNeeded = true;
        sourceReasons.push(`${source.label}: GitHub's pinned comparison or file endpoint is unavailable; attempting bounded Git evidence.`);
        if (needsMergeBase) { delete source.baseSha; source.comparisonResolved = false; }
      }
    } else {
      if (!source.sha || !/^[a-f0-9]{40,64}$/i.test(source.sha) || id !== `commit:${source.sha}`) throw new GitHubError('Invalid commit ID.', 400, 'INVALID_SOURCE');
      let metadata: ApiCommit | undefined;
      for (let page = 1; page <= 30; page++) { const commit = await client.get<ApiCommit>(`${prefix}/commits/${source.sha}?per_page=100&page=${page}`, true); metadata ??= commit; files.push(...(commit.files ?? [])); if ((commit.files?.length ?? 0) < 100) break; }
      if (files.length >= 3_000) { fallbackNeeded = true; sourceReasons.push(`${source.label}: GitHub's 3,000-file commit limit may truncate this change set.`); }
      if (metadata?.sha !== source.sha) throw new GitHubError('GitHub returned a different commit than the pinned source.', 502, 'INVALID_RESPONSE');
      source.baseSha = metadata?.parents[0]?.sha ?? EMPTY_TREE; source.headSha = source.sha; source.comparisonKind = metadata?.parents.length ? 'first-parent' : 'empty-tree'; source.mergeCommit = (metadata?.parents.length ?? 0) > 1;
      source.sourceUpdatedAt = metadata.commit.committer?.date;
      if (source.mergeCommit) {
        // Commit endpoints may expose combined merge presentation. Comparing the
        // explicit first parent with the merge makes the rule unambiguous.
        files = []; // Combined commit presentation is never retained as a first-parent delta.
        try {
          const comparison = await client.get<ApiComparison>(`${prefix}/compare/${source.baseSha}...${source.headSha}?per_page=1`, true);
          if (comparison.merge_base_commit?.sha !== source.baseSha) throw new GitHubError('The merge first-parent comparison could not be established.', 502, 'INVALID_RESPONSE');
          files = comparison.files ?? [];
          if (!comparison.files || files.length >= 300) { fallbackNeeded = true; sourceReasons.push(`${source.label}: First-parent comparison exceeds GitHub's 300-file comparison limit or is unavailable.`); }
        } catch (error) {
          if (options.signal?.aborted || !permitsPinnedFallback(error)) throw error;
          fallbackNeeded = true; sourceReasons.push(`${source.label}: First-parent comparison API is unavailable; attempting the exact pinned Git delta.`);
        }
      }
    }
    if (fallbackNeeded) {
      try {
        if (needsMergeBase && pullPins) {
          const comparison = await (options.gitComparisonFallback ?? boundedGitComparison)({ repository: snapshot.repository.fullName, baseSha: pullPins.baseSha, headSha: pullPins.headSha, comparisonKind: 'merge-base', signal: options.signal });
          if (!isSha(comparison.baseSha) || comparison.headSha !== pullPins.headSha) throw new GitHubError('Git fallback did not establish the pinned comparison.', 502, 'INVALID_RESPONSE');
          files = comparison.files; source.baseSha = comparison.baseSha; source.comparisonResolved = true;
        } else files = await (options.gitFallback ?? boundedGitDiff)({ repository: snapshot.repository.fullName, baseSha: source.baseSha!, headSha: source.headSha!, signal: options.signal });
        sourceReasons = []; source.fileEvidence = 'bounded-git-diff';
      } catch (error) {
        if (options.signal?.aborted) throw error;
        source.fileEvidence = files.length ? 'github-api-partial' : 'unavailable';
        sourceReasons.push(`${source.label}: Bounded Git fallback could not establish the complete footprint. Verified API results, if any, are retained; refresh or retry explicitly.`);
      }
      if (pullPins) {
        try {
          const after = await client.get<ApiPull>(`${prefix}/pulls/${pullPins.number}?${freshCheck()}`);
          if (after.head.sha !== pullPins.headSha || after.base.sha !== pullPins.baseSha) throw new GitHubError('The pull request changed during bounded Git fallback. The pinned snapshot is unchanged; refresh explicitly.', 409, 'STALE_SOURCE');
        } catch (error) {
          if (options.signal?.aborted || (error instanceof GitHubError && error.code === 'ACCESS_DENIED') || !permitsPinnedFallback(error)) throw error;
          sourceReasons.push(`${source.label}: Current PR refs could not be rechecked after fallback. Results remain pinned to the original objects; refresh explicitly to discover newer refs.`);
          source.refreshRequired = true;
        }
      }
    } else source.fileEvidence = 'github-api';
    source.comparisonAttemptedAt = new Date().toISOString();
    if (source.comparisonResolved === false) {
      delete source.comparedAt; delete source.version;
      source.requestedVersion = `source-request:${hash(`${source.id}:${source.baseRefSha}:${source.headSha}:merge-base`)}`;
    } else {
      source.comparedAt = source.comparisonAttemptedAt;
      source.version = `source:${hash(`${source.id}:${source.baseSha}:${source.headSha}:${source.comparisonKind}`)}`;
    }
    const canonical = toChanges(files, result, id); source.files = canonical.changes; source.loaded = source.comparisonResolved !== false; source.coverage = { status: sourceReasons.length ? 'partial' : 'complete', reasons: sourceReasons }; result.nodes.push(...canonical.nodes);
    if (canonical.nodes.length) reasons.push('Selected-source-only files are visible, but import edges describe the pinned context snapshot. Imports from other source heads have not been analyzed.');
    if (canonical.nodes.some(node => node.ambiguousLineage)) reasons.push('Independent selected sources add the same path. Separate source-only identities are retained because content equality does not establish shared lineage.');
    reasons.push(...sourceReasons);
  }
  // Retain prior source-only nodes and IDs so returning to a previous selection is stable.
  const membership = new Map<string, Set<string>>();
  for (const source of result.sources) for (const file of source.files) { if (!membership.has(file.fileId)) membership.set(file.fileId, new Set()); membership.get(file.fileId)!.add(source.id); }
  result.nodes = result.nodes.map(node => ({ ...node, sourceIds: [...(membership.get(node.id) ?? [])] }));
  const existingGroups = new Set(result.groups.map(group => group.id));
  result.groups.push(...deriveGroups(result.nodes.map(node => node.path)).filter(group => !existingGroups.has(group.id)));
  result.coverage = { ...result.coverage, status: reasons.length ? 'partial' : 'complete', reasons: unique(reasons) }; result.defaultSelection = selection;
  options.onProgress?.({ stage: 'ready', progress: 100, message: 'Selected change footprints are ready' });
  await enrichSelectedSourceDependencies(result, kind, selection, options);
  return validateGraphSnapshot(result);
}
