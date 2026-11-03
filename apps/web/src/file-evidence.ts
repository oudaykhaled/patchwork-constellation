import type { ChangeSource, FileChange, FileNode, GraphSnapshot, Group, ImportEdge } from '@patchwork/contracts';

const sha = /^[a-f0-9]{40,64}$/i;
const repositoryPart = /^[a-z0-9_.-]+$/i;
export const basename = (path: string) => path.split('/').pop() || path;
export function githubRepositoryUrl(snapshot: GraphSnapshot): string | undefined {
  const { owner, name } = snapshot.repository;
  if (!repositoryPart.test(owner) || !repositoryPart.test(name)) return undefined;
  return `https://github.com/${owner}/${name}`;
}
export function sourceLink(snapshot: GraphSnapshot, source: ChangeSource): string | undefined {
  if (snapshot.mode === 'demo') return undefined;
  const root = githubRepositoryUrl(snapshot);
  if (!root) return undefined;
  if (source.kind === 'pr' && source.number && Number.isSafeInteger(source.number) && source.number > 0) return `${root}/pull/${source.number}`;
  const commit = source.headSha || source.sha;
  return commit && sha.test(commit) ? `${root}/commit/${commit}` : undefined;
}
export function sourceFileLink(snapshot: GraphSnapshot, path: string, ref = snapshot.contextSha, line?: number): string | undefined {
  const root = githubRepositoryUrl(snapshot);
  if (snapshot.mode === 'demo' || !root || !sha.test(ref) || !path || path.split('/').some(part => part === '.' || part === '..')) return undefined;
  return `${root}/blob/${ref}/${path.split('/').map(encodeURIComponent).join('/')}${line && Number.isSafeInteger(line) && line > 0 ? `#L${line}` : ''}`;
}
export async function diffLink(snapshot: GraphSnapshot, source: ChangeSource, file: FileChange): Promise<string | undefined> {
  if (snapshot.mode === 'demo') return undefined;
  const root = githubRepositoryUrl(snapshot);
  const head = source.headSha || source.sha;
  if (!root || !head || !sha.test(head) || !file.path) return undefined;
  // GitHub hashes the current filename, including for a confirmed rename. Keep
  // immutable comparisons so a moving PR head cannot change the shown footprint.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.path));
  const anchor = `#diff-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  if (source.comparisonKind === 'empty-tree') return `${root}/commit/${head}${anchor}`;
  if (!source.baseSha || !sha.test(source.baseSha)) return undefined;
  return `${root}/compare/${source.baseSha}..${head}${anchor}`;
}
export function groupBreadcrumb(groups: Group[], groupId: string): string {
  const labels: string[] = [];
  const visited = new Set<string>();
  let current = groups.find(group => group.id === groupId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id); labels.unshift(current.label);
    current = groups.find(group => group.id === current?.parentId);
  }
  return labels.join(' / ') || groupId;
}
export function findFiles(snapshot: GraphSnapshot | null, query: string, limit = 8): FileNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized || !snapshot) return [];
  return snapshot.nodes.filter(node => node.path.toLocaleLowerCase().includes(normalized)).sort((a, b) => {
    const exactA = basename(a.path).toLocaleLowerCase() === normalized ? 0 : 1;
    const exactB = basename(b.path).toLocaleLowerCase() === normalized ? 0 : 1;
    return exactA - exactB || a.path.localeCompare(b.path) || a.id.localeCompare(b.id);
  }).slice(0, limit);
}
export function isBinaryFile(file: FileNode, change?: FileChange): boolean {
  return file.status === 'binary' || file.binary === true || change?.status === 'binary' || change?.binary === true || /\.(?:png|jpe?g|gif|webp|ico|pdf|woff2?|zip|gz|wasm)$/i.test(change?.path || file.path);
}
export function fileAvailability(snapshot: GraphSnapshot, file: FileNode, changes: FileChange[]): string[] {
  const messages: string[] = [];
  const statuses = new Set([file.status, ...changes.map(change => change.status)]);
  if (file.presence === 'deleted' || statuses.has('deleted') || statuses.has('removed')) messages.push('Removed file: this path is absent from a compared head. Its pinned diff still records the deletion.');
  if (file.presence === 'source-only') messages.push('Source-only file: this path is absent from the pinned context. Review the selected source diff.');
  if (isBinaryFile(file) || changes.some(change => isBinaryFile(file, change))) messages.push('Binary or asset file: a text diff and static imports may be unavailable. GitHub may offer a binary preview.');
  if (file.importCoverage === 'unsupported' || statuses.has('unparsed') || !/\.[cm]?[jt]sx?$/i.test(file.path)) messages.push('Unsupported parser for this file: dependency connections may be incomplete. No resolved imports does not mean no dependencies.');
  else if (file.importCoverage && file.importCoverage !== 'complete') messages.push(`Import analysis ${String(file.importCoverage)}: missing connections do not establish absence of dependencies.`);
  if (snapshot.stale === true || snapshot.coverage.reasons.some(reason => /stale|force.push|changed since|newer.*available/i.test(reason))) messages.push('Stale snapshot: these facts remain pinned to the displayed revision. Refresh the repository to analyze current changes.');
  return messages;
}
export function connectionEvidence(snapshot: GraphSnapshot, edge: ImportEdge): { text: string; url?: string } {
  const evidence = edge.evidence;
  if (!evidence) return { text: 'Evidence unavailable. This connection is review context only.' };
  if (typeof evidence === 'string') return { text: `${snapshot.mode === 'demo' ? 'Synthetic evidence' : 'Evidence reference'}: ${evidence}` };
  const ref = evidence.snapshotSha || snapshot.contextSha;
  return {
    text: `${evidence.path}${evidence.line ? `:${evidence.line}` : ''} · ${evidence.resolver || 'resolver not recorded'}${evidence.specifier ? ` · ${evidence.specifier}` : ''} · ${ref.slice(0, 7)}`,
    url: sourceFileLink(snapshot, evidence.path, ref, evidence.line),
  };
}
