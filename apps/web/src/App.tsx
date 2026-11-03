import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleHelp, ExternalLink, FileCode2, FolderGit2, GitCommitHorizontal, GitPullRequest, Layers3, List, LoaderCircle, RefreshCw, RotateCcw, Search, ShieldCheck, Unplug, X } from 'lucide-react';
import type { ChangeSource, FileNode, GraphSnapshot, Group } from '@patchwork/contracts';
import { ConstellationGraph } from './components/ConstellationGraph';
import { GitHubAccount } from './components/GitHubAccount';
import { authenticatedFetch } from './github-session';
import { GraphLegend } from './components/GraphLegend';
import './styles.css';

type SourceKind = 'pr' | 'commit';
type DialogName = 'sources' | 'repository' | 'grouping' | 'list' | 'help' | null;
type GroupLevel = 'Modules' | 'Folders' | 'Components';
type GroupingProposal = { id?: string; status: string; origin?: string; groups?: Group[]; membership?: Record<string, string>; decisions?: { fileId: string; islandId?: string; groupId?: string; rationale?: string; evidenceIds?: string[]; confidence?: number }[]; message?: string };
type RuntimeConfig = { github?: { configuredToken?: boolean }; ai?: { available?: boolean; message?: string; persistence?: string }; [key: string]: unknown };
type GroupingResult = { snapshot: GraphSnapshot; revision?: { parentRevisionId?: string } };

const design = (name: string) => `/design/${name}.svg`;
function DesignIcon({ name, size, className = '' }: { name: string; size?: number; className?: string }) {
  return <span className={`design-icon ${className}`} style={size ? { width: size, height: size } : undefined}><img src={design(name)} alt="" /></span>;
}
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status})`);
  return data as T;
}
const unwrapSnapshot = (value: GraphSnapshot | { snapshot: GraphSnapshot }) => 'snapshot' in value ? value.snapshot as GraphSnapshot : value as GraphSnapshot;
const basename = (path: string) => path.split('/').pop() || path;
const displayLabel = (source: ChangeSource) => source.label || (source.number ? `#${source.number}` : source.sha?.slice(0, 7)) || source.id;
const mergeSources = (existing: ChangeSource[], incoming: ChangeSource[]) => { const merged = new Map(existing.map(source => [source.id, source])); for (const source of incoming) if (!merged.has(source.id)) merged.set(source.id, source); return [...merged.values()]; };

function Modal({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement | null; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
  return <dialog ref={ref} aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [kind, setKind] = useState<SourceKind>('pr');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [focusGroupId, setFocusGroupId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [query, setQuery] = useState('');
  const [sourceQuery, setSourceQuery] = useState('');
  const [listQuery, setListQuery] = useState('');
  const [repoInput, setRepoInput] = useState('');
  const [contextInput, setContextInput] = useState('');
  const [groupLevel, setGroupLevel] = useState<GroupLevel>('Modules');
  const [groupMenu, setGroupMenu] = useState(false);
  const [showImports, setShowImports] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [config, setConfig] = useState<RuntimeConfig>({});
  const [proposal, setProposal] = useState<GroupingProposal | null>(null);
  const [renameGroup, setRenameGroup] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [moveGroup, setMoveGroup] = useState('');
  const [hasUndo, setHasUndo] = useState(false);
  const [nextSourcePage, setNextSourcePage] = useState<number | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [advancedAction, setAdvancedAction] = useState<'merge' | 'split'>('merge');
  const [advancedLabel, setAdvancedLabel] = useState('');
  const [mergeGroupIds, setMergeGroupIds] = useState<string[]>([]);
  const [splitGroupId, setSplitGroupId] = useState('');
  const [splitFileIds, setSplitFileIds] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<string | null>(null);
  const groupingAbortRef = useRef<AbortController | null>(null);
  const contextEpoch = useRef(0);
  const groupingRequest = useRef(0);
  const sourcePageRequest = useRef(0);
  const selectionRequest = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const fileFocusRef = useRef<HTMLElement | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (message: string) => { setNotice(message); if (noticeTimer.current) clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 5000); };

  const installSnapshot = (next: GraphSnapshot, restoreUrl = false) => {
    contextEpoch.current++; groupingRequest.current++; groupingAbortRef.current?.abort();
    sourcePageRequest.current++; setNextSourcePage(null); setLoadingSources(false);
    selectionRequest.current++;
    setSnapshot(next); setSelectedFileId(null); setFocusGroupId(null); setQuery(''); setProposal(null); setHasUndo(false); setGroupLevel('Modules');
    const params = new URLSearchParams(location.search);
    const nextKind: SourceKind = restoreUrl && params.get('mode') === 'commit' ? 'commit' : 'pr';
    const sourceSet = next.sources.filter(source => source.kind === nextKind);
    const restored = restoreUrl ? (params.get('sources') || '').split(',').filter(id => sourceSet.some(source => source.id === id)) : [];
    setKind(nextKind); setSelectedIds(restored.length ? restored : sourceSet.slice(0, nextKind === 'pr' ? 3 : 2).map(source => source.id));
    if (restoreUrl && params.get('file') && next.nodes.some(node => node.id === params.get('file'))) setSelectedFileId(params.get('file'));
  };
  useEffect(() => {
    const controller = new AbortController(); setBusy('Opening constellation…');
    const params = new URLSearchParams(location.search);
    if (params.get('repo')) void analyzeTarget(params.get('repo')!, params.get('context') || undefined, true);
    else api<GraphSnapshot | { snapshot: GraphSnapshot }>('/api/demo', undefined, controller.signal).then(value => installSnapshot(unwrapSnapshot(value), true)).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setBusy(''); });
    api<RuntimeConfig>('/api/config', undefined, controller.signal).then(setConfig).catch(() => {});
    return () => { controller.abort(); abortRef.current?.abort(); groupingAbortRef.current?.abort(); if (noticeTimer.current) clearTimeout(noticeTimer.current); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === '/' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !dialog) { event.preventDefault(); searchRef.current?.focus(); } if (event.key === 'Escape' && !dialog) { setSelectedFileId(null); setQuery(''); setGroupMenu(false); const previous = fileFocusRef.current; if (previous?.isConnected) previous.focus({ preventScroll: true }); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);
  useEffect(() => {
    if (!selectedFileId || dialog || document.activeElement?.tagName === 'CANVAS') return;
    const frame = requestAnimationFrame(() => inspectorCloseRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [selectedFileId, dialog]);
  useEffect(() => {
    if (!snapshot) return;
    const params = new URLSearchParams(location.search); params.set('mode', kind); params.set('sources', selectedIds.join(','));
    if (snapshot.mode === 'github') { params.set('repo', snapshot.repository.fullName); params.set('context', snapshot.contextSha); } else { params.delete('repo'); params.delete('context'); }
    if (selectedFileId) params.set('file', selectedFileId); else params.delete('file');
    history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
  }, [snapshot?.id, kind, selectedIds, selectedFileId]);
  useEffect(() => {
    if (!snapshot || snapshot.mode === 'demo' || dialog !== 'sources') return;
    sourcePageRequest.current++; setNextSourcePage(null);
    const controller = new AbortController(); setLoadingSources(true);
    api<{ sources: ChangeSource[]; nextPage: number | null; snapshot?: GraphSnapshot }>(`/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=${kind}&page=1`, undefined, controller.signal).then(result => { setNextSourcePage(result.nextPage); setSnapshot(current => current?.id === snapshot.id ? { ...current, sources: mergeSources(current.sources, result.sources) } : current); }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoadingSources(false); });
    return () => { controller.abort(); sourcePageRequest.current++; };
  }, [dialog, kind, snapshot?.id, snapshot?.mode]);
  useEffect(() => { if (snapshot?.mode === 'github' && selectedIds.length) void updateSelection(selectedIds, kind); }, [snapshot?.id]);

  const presentationSnapshot = useMemo(() => {
    if (!snapshot || groupLevel === 'Modules') return snapshot;
    const groups = new Map<string, Group>();
    const nodes = snapshot.nodes.map(node => { const original = snapshot.groups.find(group => group.id === node.groupId); const label = groupLevel === 'Folders' ? node.path.split('/').slice(0, -1).slice(0, 2).join('/') || '(root)' : original?.component || original?.label || 'Ungrouped'; const id = `${groupLevel.toLowerCase()}:${label}`; if (!groups.has(id)) groups.set(id, { id, label, origin: 'rules', color: original?.color }); return { ...node, groupId: id }; });
    return { ...snapshot, id: `${snapshot.id}:${groupLevel}`, nodes, groups: [...groups.values()] };
  }, [snapshot, groupLevel]);
  const sources = snapshot?.sources.filter(source => source.kind === kind) || [];
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedSources = sources.filter(source => selectedSet.has(source.id));
  const memberships = useMemo(() => new Map((snapshot?.nodes || []).map(node => [node.id, node.sourceIds.filter(id => selectedSet.has(id))])), [snapshot, selectedSet]);
  const changedNodes = snapshot?.nodes.filter(node => (memberships.get(node.id)?.length || 0) > 0) || [];
  const overlapCount = changedNodes.filter(node => (memberships.get(node.id)?.length || 0) > 1).length;
  const affectedIslands = new Set((presentationSnapshot?.nodes || []).filter(node => (memberships.get(node.id)?.length || 0) > 0).map(node => node.groupId)).size;
  const selectedFile = snapshot?.nodes.find(node => node.id === selectedFileId);
  const selectedGroup = snapshot?.groups.find(group => group.id === selectedFile?.groupId);
  const focusGroup = presentationSnapshot?.groups.find(group => group.id === focusGroupId);
  const fileSources = selectedFile ? selectedSources.filter(source => source.files.some(file => file.fileId === selectedFile.id)) : [];
  const fileChanges = fileSources.map(source => ({ source, file: source.files.find(file => file.fileId === selectedFile?.id)! }));
  const neighbors = useMemo(() => {
    if (!snapshot || !selectedFile) return [];
    return snapshot.edges.filter(edge => edge.source === selectedFile.id || edge.target === selectedFile.id).map(edge => ({ edge, inbound: edge.target === selectedFile.id, node: snapshot.nodes.find(node => node.id === (edge.target === selectedFile.id ? edge.source : edge.target)) })).filter(item => !!item.node);
  }, [snapshot, selectedFile]);
  const matchingFiles = useMemo(() => !query.trim() ? [] : (snapshot?.nodes || []).filter(node => node.path.toLowerCase().includes(query.toLowerCase())).slice(0, 8), [query, snapshot]);
  const matchingGroups = !query.trim() ? [] : (presentationSnapshot?.groups || []).filter(group => group.label.toLowerCase().includes(query.toLowerCase())).slice(0, 3);


  const chooseFile = (id: string | null) => { if (id && !selectedFileId) fileFocusRef.current = document.activeElement as HTMLElement; setSelectedFileId(id); setQuery(''); if (id) { const node = snapshot?.nodes.find(file => file.id === id); if (node) setMoveGroup(node.groupId); } else { const target = fileFocusRef.current; if (target?.isConnected) target.focus({ preventScroll: true }); else searchRef.current?.focus({ preventScroll: true }); } };
  const updateSelection = async (ids: string[], nextKind = kind) => {
    setSelectedIds(ids); setKind(nextKind); setError('');
    if (!snapshot || snapshot.mode === 'demo') return;
    const requestId = ++selectionRequest.current; setBusy('Updating selected changes…');
    try { const result = await api<GraphSnapshot | { snapshot: GraphSnapshot }>('/api/sources', { snapshotId: snapshot.id, kind: nextKind, ids }); if (requestId === selectionRequest.current) setSnapshot(unwrapSnapshot(result)); }
    catch (reason) { if (requestId === selectionRequest.current) setError((reason as Error).message); }
    finally { if (requestId === selectionRequest.current) setBusy(''); }
  };
  const toggleSource = (id: string) => { void updateSelection(selectedSet.has(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id]); };
  const switchKind = (next: SourceKind) => { if (!snapshot || next === kind) return; setSourceQuery(''); void updateSelection(snapshot.sources.filter(source => source.kind === next).slice(0, next === 'pr' ? 3 : 2).map(source => source.id), next); };
  const loadDemo = async () => { contextEpoch.current++; groupingAbortRef.current?.abort(); abortRef.current?.abort(); setBusy('Opening demo…'); setError(''); try { installSnapshot(unwrapSnapshot(await api<GraphSnapshot | { snapshot: GraphSnapshot }>('/api/demo'))); setDialog(null); } catch (reason) { setError((reason as Error).message); } finally { setBusy(''); } };
  async function analyzeTarget(repository: string, contextRef?: string, restoreUrl = false) {
    if (!repository.trim()) return;
    contextEpoch.current++; groupingAbortRef.current?.abort();
    selectionRequest.current++;
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller; setError(''); setBusy('Connecting to repository…');
    try {
      const result = await api<{ jobId?: string; id?: string; snapshot?: GraphSnapshot }>('/api/analyze', { repository: repository.trim(), contextRef, mode: 'pr' }, controller.signal);
      if (result.snapshot) { installSnapshot(result.snapshot, restoreUrl); setDialog(null); return; }
      const jobId = result.jobId || result.id; if (!jobId) throw new Error('The analysis did not return a job. Please try again.');
      jobRef.current = jobId;
      while (!controller.signal.aborted) {
        const job = await api<{ status: string; progress?: number | string; message?: string; snapshot?: GraphSnapshot; error?: string | { message?: string } }>(`/api/jobs/${encodeURIComponent(jobId)}`, undefined, controller.signal);
        if (job.snapshot && ['ready', 'partial', 'complete', 'completed'].includes(job.status)) { installSnapshot(job.snapshot, restoreUrl); setDialog(null); flash('Repository map is ready. Select changes to explore their footprint.'); break; }
        if (['failed', 'cancelled'].includes(job.status)) throw new Error(typeof job.error === 'string' ? job.error : job.error?.message || 'Analysis could not complete.');
        setBusy(job.message || `${job.status.charAt(0).toUpperCase()}${job.status.slice(1)}${typeof job.progress === 'number' ? ` · ${Math.round(job.progress)}%` : '…'}`);
        await new Promise<void>((resolve, reject) => { const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }; const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, 1000); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { if (abortRef.current === controller) { setBusy(''); abortRef.current = null; jobRef.current = null; } }
  }
  const connectRepository = (event: FormEvent) => { event.preventDefault(); void analyzeTarget(repoInput, contextInput.trim() || undefined); };
  const cancelAnalysis = () => { if (jobRef.current) void api(`/api/jobs/${encodeURIComponent(jobRef.current)}/cancel`, {}).catch(() => {}); jobRef.current = null; abortRef.current?.abort(); abortRef.current = null; setBusy(''); flash('Analysis canceled. Your current map is preserved.'); };
  const loadMoreSources = async () => { if (!snapshot || !nextSourcePage) return; const generation = sourcePageRequest.current; setLoadingSources(true); try { const result = await api<{ sources: ChangeSource[]; nextPage: number | null }>(`/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=${kind}&page=${nextSourcePage}`); if (generation !== sourcePageRequest.current) return; setSnapshot(current => current?.id === snapshot.id ? { ...current, sources: mergeSources(current.sources, result.sources) } : current); setNextSourcePage(result.nextPage); } catch (reason) { if (generation === sourcePageRequest.current) setError((reason as Error).message); } finally { if (generation === sourcePageRequest.current) setLoadingSources(false); } };
  async function runGroupingTask<T>(message: string, task: (signal: AbortSignal) => Promise<T>, apply: (result: T) => void) {
    groupingAbortRef.current?.abort();
    const controller = new AbortController(); groupingAbortRef.current = controller;
    const epoch = contextEpoch.current; const requestId = ++groupingRequest.current;
    const isCurrent = () => !controller.signal.aborted && epoch === contextEpoch.current && requestId === groupingRequest.current;
    setBusy(message); setError('');
    try { const result = await task(controller.signal); if (isCurrent()) apply(result); }
    catch (reason) { if (isCurrent()) setError((reason as Error).message); }
    finally { if (isCurrent()) { setBusy(''); groupingAbortRef.current = null; } }
  }
  const requestGrouping = async () => { if (!snapshot) return; await runGroupingTask('Reviewing module evidence…', signal => api<GroupingProposal>('/api/grouping', { snapshotId: snapshot.id, enabled: true }, signal), setProposal); };
  const mutateGrouping = async (operation: unknown) => { if (!snapshot) return; selectionRequest.current++; await runGroupingTask('Updating grouping…', signal => api<GroupingResult>('/api/grouping/mutate', { snapshotId: snapshot.id, operation }, signal), result => { setSnapshot(result.snapshot); setHasUndo(true); setRenameValue(''); flash('Grouping updated. You can undo this change.'); }); };
  const undoGrouping = async () => { if (!snapshot) return; selectionRequest.current++; await runGroupingTask('Restoring previous grouping…', signal => api<GroupingResult>('/api/grouping/undo', { snapshotId: snapshot.id }, signal), result => { setSnapshot(result.snapshot); setHasUndo(Boolean(result.revision?.parentRevisionId)); flash('Previous grouping restored.'); }); };
  const applyProposal = async () => { if (!snapshot || !proposal?.id) return; selectionRequest.current++; await runGroupingTask('Applying grouping…', signal => api<GroupingResult>('/api/grouping/apply', { snapshotId: snapshot.id, proposalId: proposal.id }, signal), result => { setSnapshot(result.snapshot); setHasUndo(true); setProposal(null); setDialog(null); flash('Reviewed grouping applied.'); }); };
  const saveView = async () => { const url = location.href; localStorage.setItem('patchwork:saved-view', url); try { await navigator.clipboard.writeText(url); flash('View saved. Share link copied to clipboard.'); } catch { flash('View saved in this browser. The address bar contains your share link.'); } };
  const focusIsland = (id: string | null) => { setFocusGroupId(id); setQuery(''); };

  return <div className="app-shell">
    <a className="skip-link" href="#graph-workspace">Skip to graph workspace</a>
    <header className="global-header" data-node-id="17:2114">
      <a className="brand" href="/" aria-label="Patchwork home"><DesignIcon name="0-imgIconGraph" size={25} /><span>patchwork</span></a>
      <button className="repo-switch" onClick={() => setDialog('repository')} aria-label="Choose repository"><DesignIcon name="0-imgIconBranch" size={15} /><span>{snapshot ? `${snapshot.repository.owner} / ${snapshot.repository.name}` : 'Choose repository'}</span><DesignIcon name="0-imgIconChevron" size={12} /></button>
      <span className="header-slash">/</span><span className="page-name">Impact graph</span>
      <div className="header-spacer" />
      <span className={`mode-badge ${snapshot?.mode === 'github' ? 'mode-live' : ''}`}>{snapshot?.mode === 'github' ? 'Live repository' : 'Demo workspace'}</span>
      <button className="button ai-button" onClick={() => setDialog('grouping')} data-testid="grouping-controls"><DesignIcon name="0-imgIconSpark" size={15} /><span>AI + Jev</span></button>
      <button className="button save-button" onClick={() => void saveView()}>Save view</button>
      <button className="avatar" onClick={() => setDialog('help')} aria-label="Help and keyboard shortcuts"><CircleHelp size={16} /></button>
    </header>
    <main id="graph-workspace" className={`graph-workspace ${selectedFile ? 'has-inspector' : ''}`} data-testid="graph-viewport">
      {presentationSnapshot && <ConstellationGraph snapshot={presentationSnapshot} selectedSourceIds={selectedIds} selectedFileId={selectedFileId} onSelectFile={chooseFile} focusGroupId={focusGroupId} onFocusGroup={focusIsland} searchQuery={query} showImports={showImports} />}
      {!snapshot && <div className="empty-workspace"><LoaderCircle className="spinning" size={24} /><h1>Opening your constellation</h1><p>Finding the shape of your repository.</p>{error && <><p className="error-text">{error}</p><button className="button" onClick={() => void loadDemo()}>Try again</button></>}</div>}
      {snapshot && <>
        <div className="source-bar panel" data-node-id="17:3072">
          <button className="button source-mode" onClick={() => setDialog('sources')}><span>{kind === 'pr' ? 'Pull requests' : 'Commits'}</span><DesignIcon name="1-imgIconChevron" size={12} /></button>
          <div className="source-chips">{selectedSources.slice(0, 4).map(source => <button key={source.id} className="source-chip" aria-label={`Remove ${displayLabel(source)}`} onClick={() => toggleSource(source.id)}>{displayLabel(source)}<DesignIcon name="1-imgIconClose" size={11} /></button>)}{selectedSources.length > 4 && <span className="muted small">+{selectedSources.length - 4}</span>}</div>
          <span className="selection-count">{selectedIds.length} selected</span><span className="flex-spacer" />
          <button className="button edit-selection" onClick={() => setDialog('sources')} data-testid="source-selector"><DesignIcon name="1-imgIconPlus" size={15} /><span>Edit selection</span></button>
        </div>
        <div className="graph-search panel" data-node-id="17:3095"><DesignIcon name="2-imgIconSearch" size={16} /><input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { if (matchingFiles[0]) chooseFile(matchingFiles[0].id); else if (matchingGroups[0]) focusIsland(matchingGroups[0].id); } }} aria-label="Find a file, folder or island" placeholder="Find a file, folder or island…" data-testid="file-search" /><kbd>/</kbd>
          {query && <div className="search-results panel" role="listbox" aria-label="Search results">{matchingGroups.map(group => <button key={group.id} role="option" aria-selected="false" onClick={() => focusIsland(group.id)}><Layers3 size={15} /><span>{group.label}<small>Island · {presentationSnapshot?.nodes.filter(node => node.groupId === group.id).length} files</small></span><ArrowRight size={14} /></button>)}{matchingFiles.map(node => <button key={node.id} role="option" aria-selected={node.id === selectedFileId} onClick={() => chooseFile(node.id)}><FileCode2 size={15} /><span>{basename(node.path)}<small>{node.path}</small></span><ArrowRight size={14} /></button>)}{!matchingFiles.length && !matchingGroups.length && <p className="search-empty">No files or islands match “{query}”.</p>}</div>}
        </div>
        <div className="graph-heading" data-node-id="17:3102"><h1>Change constellation</h1><p><span data-testid="changed-count">{changedNodes.length}</span> affected files<span className="dot-separator">·</span>{affectedIslands} islands<span className="dot-separator">·</span><span data-testid="overlap-count">{overlapCount}</span> overlapping</p><div className="context-line" title={`Context snapshot ${snapshot.contextSha}`}><GitCommitHorizontal size={12} /><span>{snapshot.contextRef}</span><code>{snapshot.contextSha.slice(0, 7)}</code>{snapshot.mode === 'demo' && <span className="demo-label">synthetic data</span>}</div></div>
        <div className="graph-view-controls" data-node-id="17:3105"><div className="group-menu-wrapper"><button className="button" onClick={() => setGroupMenu(!groupMenu)} aria-expanded={groupMenu}><DesignIcon name="4-imgIconSpark" size={15} />Islands: {groupLevel}<DesignIcon name="4-imgIconChevron" size={12} /></button>{groupMenu && <div className="group-level-menu panel">{(['Modules', 'Folders', 'Components'] as GroupLevel[]).map(level => <button key={level} onClick={() => { setGroupLevel(level); setFocusGroupId(null); setGroupMenu(false); }}><span>{level}</span>{level === groupLevel && <Check size={14} />}</button>)}</div>}</div><button className={`button imports-toggle ${showImports ? 'is-active' : ''}`} onClick={() => setShowImports(!showImports)} aria-pressed={showImports}>Imports<DesignIcon name="4-imgIconChevron" size={12} /></button><button className="button icon-button" aria-label="Open file list" data-testid="accessible-list-toggle" onClick={() => setDialog('list')}><DesignIcon name="4-imgIconSliders" size={15} /></button></div>
        {focusGroup && <div className="focus-breadcrumb"><button onClick={() => focusIsland(null)}><ArrowLeft size={12} />All islands</button><span>/</span><strong>{focusGroup.label}</strong></div>}
        {snapshot.coverage.status !== 'complete' && <div className="coverage-notice panel" role="status"><ShieldCheck size={15} /><span>{snapshot.coverage.status === 'partial' ? 'Partial analysis' : 'Analysis coverage'}<small>{snapshot.coverage.reasons[0] || 'Some dependency information is unavailable.'}</small></span><button className="text-button" onClick={() => setDialog('help')}>Details</button></div>}
        {!selectedIds.length && <div className="zero-selection panel"><GitPullRequest size={20} /><div><strong>Your repository, at a glance</strong><p>Select PRs or commits to highlight the files they touch.</p></div><button className="button accent" onClick={() => setDialog('sources')}>Select changes</button></div>}
        <button className="organization-hint panel" data-node-id="17:3170" onClick={() => setDialog('grouping')}><span><DesignIcon name="6-imgIconSpark" size={14} /><strong>{snapshot.groups.some(group => group.origin === 'ai') ? 'AI + Jev grouping' : snapshot.groups.some(group => group.origin === 'manual') ? 'Your custom grouping' : 'Organized by modules'}</strong></span><small>Select an island to explore its files</small></button>
        <GraphLegend sourceKind={kind} fileCount={snapshot.nodes.length} />
        {selectedFile && <aside className="file-inspector panel" data-testid="file-inspector" aria-label="File inspector"><div className="inspector-top"><span className="eyebrow">FILE DETAILS</span><button ref={inspectorCloseRef} className="icon-button" aria-label="Close file inspector" onClick={() => chooseFile(null)}><X size={17} /></button></div><div className="file-title"><span className="file-icon"><FileCode2 size={22} /></span><div><h2>{basename(selectedFile.path)}</h2><span className="status-tag">{fileChanges[0]?.file.status || 'Unchanged context'}</span></div></div><p className="file-path">{selectedFile.path}</p><button className="island-breadcrumb" onClick={() => focusIsland(presentationSnapshot?.nodes.find(node => node.id === selectedFile.id)?.groupId || selectedFile.groupId)}><span className="island-color" style={{ background: selectedGroup?.color || '#66bfa0' }} />{selectedGroup?.label || selectedFile.groupId}<ArrowRight size={13} /></button><div className="inspector-divider" /><h3>Selected changes <span>{fileSources.length}</span></h3>{fileChanges.length ? fileChanges.map(({ source, file }) => <a className="source-detail" key={source.id} href={snapshot.mode === 'demo' ? undefined : source.url} onClick={snapshot.mode === 'demo' ? event => event.preventDefault() : undefined} aria-label={snapshot.mode === 'demo' ? `${displayLabel(source)} synthetic change example` : undefined} target={snapshot.mode === 'demo' ? undefined : '_blank'} rel="noreferrer"><GitPullRequest size={15} /><span><strong>{displayLabel(source)}</strong><small>{source.title}</small></span><span className="line-stats"><b>+{file.additions}</b><em>−{file.deletions}</em></span><ExternalLink size={12} /></a>) : <p className="muted small">This file is unchanged in your current selection.</p>}<div className="evidence-note"><ShieldCheck size={15} /><p>{fileSources.length > 1 ? 'Touched by multiple selected changes. Review the individual diffs together.' : fileSources.length ? 'Directly changed in your selection. Its connections can help guide your review.' : 'A context file connected to the repository map.'}</p></div><h3>Import connections <span>{neighbors.length}</span></h3><p className="muted small neighbor-caption">Connections are review context, not proof of runtime impact.</p><div className="neighbors">{neighbors.slice(0, 6).map(({ edge, node, inbound }) => <button key={edge.id} onClick={() => chooseFile(node!.id)} title={node!.path}>{inbound ? <ArrowLeft size={13} /> : <ArrowRight size={13} />}<span>{basename(node!.path)}<small>{edge.kind === 'import' ? '' : `${edge.kind.replace('-', ' ')} · `}{inbound ? 'imports this file' : 'imported by this file'}</small></span><span className="neighbor-dot" /></button>)}{!neighbors.length && <p className="muted small">No resolved imports for this file.</p>}{neighbors.length > 6 && <button className="text-button" onClick={() => { setListQuery(''); setDialog('list'); }}>Explore all files and connections</button>}</div><details className="move-file"><summary>Organize this file</summary><label>Primary island<select value={moveGroup || selectedFile.groupId} onChange={event => setMoveGroup(event.target.value)}>{snapshot.groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label><button className="button" disabled={!moveGroup || moveGroup === selectedFile.groupId || !!busy} onClick={() => void mutateGrouping({ type: 'move', fileIds: [selectedFile.id], groupId: moveGroup })}>Move file</button></details><div className="inspector-footer">{snapshot.mode === 'demo' ? <div className="demo-diff-note"><FileCode2 size={15} /><span>Sample diff · illustrative data<small>Connect a real repository to open its GitHub diffs.</small></span></div> : fileSources[0] ? <a className="button accent" href={fileSources[0].kind === 'pr' ? `${fileSources[0].url}/files` : fileSources[0].url} target="_blank" rel="noreferrer">Open GitHub diff<ExternalLink size={14} /></a> : <a className="button" href={`${snapshot.repository.htmlUrl}/blob/${encodeURIComponent(snapshot.contextSha)}/${selectedFile.path.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer">Open file on GitHub<ExternalLink size={14} /></a>}</div></aside>}
      </>}
      {busy && <div className="activity-indicator panel" role="status"><LoaderCircle size={15} className="spinning" /><span>{busy}</span>{abortRef.current && <button className="text-button" onClick={cancelAnalysis}>Cancel</button>}</div>}
      {error && snapshot && <div className="error-banner panel" role="alert"><CircleHelp size={17} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      {notice && <div className="toast panel" role="status"><CheckCheck size={16} />{notice}</div>}
      <div className="sr-only" role="status" aria-live="polite">{snapshot && `${changedNodes.length} affected files, ${overlapCount} overlapping files. ${selectedFile ? `${selectedFile.path} selected.` : ''}`}</div>
    </main>
    {dialog === 'sources' && snapshot && <Modal title="Choose your changes" eyebrow="COMPARE A FOOTPRINT" onClose={() => setDialog(null)}><p className="modal-intro">Select several changes to see where they meet.</p><div className="segmented-control"><button data-testid="source-mode-pr" className={kind === 'pr' ? 'selected' : ''} onClick={() => switchKind('pr')}><GitPullRequest size={15} />Pull requests</button><button data-testid="source-mode-commit" className={kind === 'commit' ? 'selected' : ''} onClick={() => switchKind('commit')}><GitCommitHorizontal size={15} />Commits</button></div><div className="modal-search"><Search size={16} /><input type="search" aria-label="Filter changes" placeholder={kind === 'pr' ? 'Search pull requests…' : 'Search commits…'} value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} /></div><fieldset className="source-list"><legend className="sr-only">Select {kind === 'pr' ? 'pull requests' : 'commits'}</legend>{sources.filter(source => `${source.label} ${source.title}`.toLowerCase().includes(sourceQuery.toLowerCase())).map(source => <label className={`source-option ${selectedSet.has(source.id) ? 'checked' : ''}`} key={source.id}><input type="checkbox" checked={selectedSet.has(source.id)} onChange={() => toggleSource(source.id)} data-testid={`source-${source.id}`} /><span className="source-option-icon">{kind === 'pr' ? <GitPullRequest size={17} /> : <GitCommitHorizontal size={17} />}</span><span className="source-option-body"><strong>{source.title}</strong><small><code>{displayLabel(source)}</code><span>·</span>{source.files.length} files<span>·</span>{source.comparisonKind === 'first-parent' ? 'First-parent delta' : kind === 'pr' ? 'Pull request footprint' : 'Commit footprint'}</small></span></label>)}{!sources.length && <div className="empty-list"><GitPullRequest size={24} /><p>No {kind === 'pr' ? 'pull requests' : 'commits'} are available in this snapshot.</p><small>Try another repository or refresh the analysis.</small></div>}</fieldset>{snapshot.mode === 'github' && nextSourcePage && <button className="button load-more-sources" disabled={loadingSources} onClick={() => void loadMoreSources()}>{loadingSources ? <LoaderCircle size={14} className="spinning" /> : <RefreshCw size={14} />}Load more changes</button>}{error && <p className="form-error" role="alert">{error}</p>}<div className="selection-summary"><span>{selectedIds.length} selected</span><span>{changedNodes.length} unique files · {overlapCount} overlapping</span></div><p className="inline-note">{kind === 'pr' ? 'Each PR is compared to its own pinned base. This view does not simulate a merge.' : 'Each commit is compared to its first parent. Reverted edits remain part of the touched-file footprint.'}</p><div className="modal-footer"><button className="text-button" onClick={() => void updateSelection([])}>Clear selection</button><button className="button accent" onClick={() => setDialog(null)}>Explore changes<ArrowRight size={14} /></button></div></Modal>}
    {dialog === 'repository' && <Modal title="Choose a repository" eyebrow="YOUR CODE, IN CONTEXT" onClose={() => setDialog(null)}><p className="modal-intro">Explore a public repository, or sign in to select repositories shared with the GitHub App.</p><GitHubAccount onSelect={setRepoInput} onDisconnected={() => void loadDemo()} /><form onSubmit={event => void connectRepository(event)}><label className="form-label">Repository<input autoFocus placeholder="owner/repository or GitHub URL" value={repoInput} onChange={event => setRepoInput(event.target.value)} required /></label><label className="form-label">Context branch or commit <span>optional</span><input placeholder="Default branch HEAD" value={contextInput} onChange={event => setContextInput(event.target.value)} /></label><p className="inline-note"><ShieldCheck size={14} />Read-only analysis. Repository code is never executed.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="button accent full-width" type="submit" disabled={!!busy}>{busy ? <LoaderCircle size={15} className="spinning" /> : <FolderGit2 size={16} />}{busy || 'Map repository'}</button>{abortRef.current && <button className="text-button full-width" type="button" onClick={cancelAnalysis}>Cancel analysis</button>}</form><div className="or-divider"><span>or explore the sample</span></div><button className="demo-repo-card" onClick={() => void loadDemo()}><span className="demo-repo-icon"><FolderGit2 size={22} /></span><span><strong>acme / atlas</strong><small>212 files · 6 islands · sample PRs and commits</small></span><ArrowRight size={17} /></button>{snapshot?.mode === 'github' && <button className="text-button disconnect-button" onClick={() => void loadDemo()}><Unplug size={14} />Disconnect and return to demo</button>}<p className="subtle small">{config.github?.configuredToken ? 'Server GitHub credentials are configured.' : 'Public repository analysis is available. Private access requires a configured GitHub App.'}</p></Modal>}
    {dialog === 'grouping' && snapshot && <Modal title="Make sense of the islands" eyebrow="AI + JEV GROUPING" onClose={() => setDialog(null)} wide><p className="modal-intro">Start with repository structure. Review evidence before applying a new organization.</p><div className="grouping-status"><ShieldCheck size={20} /><div><strong>{snapshot.groups.some(group => group.origin === 'ai') ? 'Reviewed AI grouping' : 'Deterministic module grouping'}</strong><p>Your current map stays usable while AI is disabled or unavailable.</p></div><span className="status-tag">{snapshot.groups.some(group => group.origin === 'manual') ? 'Customized' : 'Active'}</span></div><p className="inline-note ai-data-policy">Optional AI analysis sends file IDs, paths, existing island names and bounded import target IDs to the configured providers. File contents are not included.</p><div className="grouping-actions"><button className="button accent" onClick={() => void requestGrouping()} disabled={!!busy}><DesignIcon name="0-imgIconSpark" size={15} />Review with AI + Jev</button><button className="button" disabled={!hasUndo || !!busy} onClick={() => void undoGrouping()}><RotateCcw size={14} />Undo grouping</button></div>{proposal && <section className={`proposal-result ${proposal.status === 'baseline' ? 'baseline' : ''}`}><span className="eyebrow">{proposal.status === 'baseline' ? 'BASELINE PRESERVED' : 'PROPOSED GROUPING'}</span><p>{proposal.message || (proposal.status === 'baseline' ? 'AI providers are not configured. Your deterministic grouping is retained.' : 'Review the proposed islands before applying.')}</p>{proposal.status !== 'baseline' && <><div className="proposal-groups">{proposal.groups?.map(group => <span key={group.id}>{group.label}</span>)}</div><p className="small muted">{Object.entries(proposal.membership || {}).filter(([fileId, groupId]) => snapshot.nodes.find(node => node.id === fileId)?.groupId !== groupId).length} files would move. The active map is unchanged until you apply.</p>{!!proposal.decisions?.length && <details className="proposal-evidence"><summary>Why these groups?</summary>{proposal.decisions.slice(0, 12).map(decision => <div key={decision.fileId}><strong>{snapshot.nodes.find(node => node.id === decision.fileId)?.path || decision.fileId}</strong><p>{decision.rationale}</p>{typeof decision.confidence === 'number' && <small>Model confidence: {Math.round(decision.confidence * 100)}% · uncertainty, not verified accuracy</small>}<small>Evidence: {decision.evidenceIds?.join(', ') || 'Repository file metadata'}</small></div>)}</details>}<button className="button accent" disabled={!!busy} onClick={() => void applyProposal()}>Apply reviewed grouping</button></>}</section>}<h3 className="section-title">Current islands <span>{snapshot.groups.length}</span></h3><div className="grouping-list">{snapshot.groups.map(group => <div key={group.id}><span className="island-color" style={{ background: group.color || '#66bfa0' }} /><span><strong>{group.label}</strong><small>{snapshot.nodes.filter(node => node.groupId === group.id).length} files · {group.origin || 'rules'}</small></span><button className="text-button" onClick={() => { setRenameGroup(group.id); setRenameValue(group.label); }}>Rename</button></div>)}</div>{renameGroup && <form className="rename-form" onSubmit={event => { event.preventDefault(); void mutateGrouping({ type: 'rename', groupId: renameGroup, label: renameValue }); setRenameGroup(''); }}><label className="form-label">Island name<input autoFocus aria-label="Island name" value={renameValue} onChange={event => setRenameValue(event.target.value)} maxLength={80} required /></label><button className="button accent" disabled={!renameValue.trim() || !!busy}>Save name</button><button type="button" className="icon-button" aria-label="Cancel rename" onClick={() => setRenameGroup('')}><X size={15} /></button></form>}<details className="advanced-grouping"><summary>Merge or split islands</summary><div className="segmented-control"><button className={advancedAction === 'merge' ? 'selected' : ''} onClick={() => setAdvancedAction('merge')}>Merge islands</button><button className={advancedAction === 'split' ? 'selected' : ''} onClick={() => setAdvancedAction('split')}>Split an island</button></div><label className="form-label">New island name<input value={advancedLabel} onChange={event => setAdvancedLabel(event.target.value)} maxLength={64} placeholder="e.g. Identity services" /></label>{advancedAction === 'merge' ? <fieldset className="advanced-checks"><legend>Choose at least two islands</legend>{snapshot.groups.map(group => <label key={group.id}><input type="checkbox" checked={mergeGroupIds.includes(group.id)} onChange={() => setMergeGroupIds(current => current.includes(group.id) ? current.filter(id => id !== group.id) : [...current, group.id])} />{group.label}</label>)}</fieldset> : <><label className="form-label">Source island<select value={splitGroupId || snapshot.groups[0]?.id} onChange={event => { setSplitGroupId(event.target.value); setSplitFileIds([]); }}>{snapshot.groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label><fieldset className="advanced-checks file-checks"><legend>Choose files to move into the new island</legend>{snapshot.nodes.filter(node => node.groupId === (splitGroupId || snapshot.groups[0]?.id)).map(node => <label key={node.id}><input type="checkbox" checked={splitFileIds.includes(node.id)} onChange={() => setSplitFileIds(current => current.includes(node.id) ? current.filter(id => id !== node.id) : [...current, node.id])} /><code>{node.path}</code></label>)}</fieldset></>}<div className="advanced-footer"><span className="subtle small">Changes create a revision and can be undone.</span><button className="button accent" disabled={!!busy || !advancedLabel.trim() || (advancedAction === 'merge' ? mergeGroupIds.length < 2 : splitFileIds.length === 0 || splitFileIds.length >= snapshot.nodes.filter(node => node.groupId === (splitGroupId || snapshot.groups[0]?.id)).length)} onClick={() => { void mutateGrouping(advancedAction === 'merge' ? { type: 'merge', groupIds: mergeGroupIds, label: advancedLabel } : { type: 'split', groupId: splitGroupId || snapshot.groups[0]?.id, fileIds: splitFileIds, label: advancedLabel }); setMergeGroupIds([]); setSplitFileIds([]); setAdvancedLabel(''); }}>{advancedAction === 'merge' ? 'Merge selected islands' : 'Create new island'}</button></div></details><p className="inline-note">AI proposals can name and organize files. Observed imports and change counts remain evidence from the repository.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><span className="subtle small">{config.ai?.available ? 'Jev decision adapter configured' : 'Server credentials required for live AI + Jev'}</span><button className="button" onClick={() => setDialog(null)}>Done</button></div></Modal>}
    {dialog === 'list' && snapshot && <Modal title="Files in your constellation" eyebrow="ACCESSIBLE FILE EXPLORER" onClose={() => setDialog(null)} wide><div className="modal-search"><Search size={16} /><input type="search" aria-label="Filter file list" placeholder="Filter by file path…" value={listQuery} onChange={event => setListQuery(event.target.value)} /></div><div className="accessible-file-list">{snapshot.nodes.filter(node => node.path.toLowerCase().includes(listQuery.toLowerCase())).slice(0, 300).map(node => <button key={node.id} onClick={() => { chooseFile(node.id); setDialog(null); }}><span className={`file-state ${(memberships.get(node.id)?.length || 0) > 0 ? 'changed' : ''} ${(memberships.get(node.id)?.length || 0) > 1 ? 'overlapping' : ''}`} /><span><strong>{basename(node.path)}</strong><small>{node.path}</small></span><span className="file-list-group">{snapshot.groups.find(group => group.id === node.groupId)?.label}</span><span className="file-list-status">{(memberships.get(node.id)?.length || 0) > 1 ? 'Overlapping' : (memberships.get(node.id)?.length || 0) ? 'Changed' : 'Context'}</span><ArrowRight size={14} /></button>)}</div><p className="inline-note">Showing up to 300 matching files. Filter by path to narrow larger repositories. Selecting a file opens its evidence and import neighbors.</p><div className="modal-footer"><span className="muted small">{snapshot.nodes.length} files in snapshot</span><button className="button" onClick={() => setDialog(null)}>Back to graph</button></div></Modal>}
    {dialog === 'help' && <Modal title="Explore the constellation" eyebrow="A MAP FOR CODE REVIEW" onClose={() => setDialog(null)}><p className="modal-intro">Each circle is a file. Islands reveal your code structure. Select several changes to see their shared footprint.</p><dl className="shortcut-list"><div><dt>Find a file or island</dt><dd><kbd>/</kbd></dd></div><div><dt>Pan the map</dt><dd>Drag or arrow keys</dd></div><div><dt>Zoom in and out</dt><dd>Scroll, pinch, or + / −</dd></div><div><dt>Close details</dt><dd><kbd>Esc</kbd></dd></div><div><dt>Review without the canvas</dt><dd>Open file list</dd></div></dl>{snapshot && <section className="coverage-details"><h3>Analysis coverage: {snapshot.coverage.status}</h3>{snapshot.coverage.reasons.length ? <ul>{snapshot.coverage.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>All files in this snapshot are represented. Imports describe static code relationships.</p>}<p>Imports suggest review context. They do not establish runtime breakage. File overlap does not establish a merge conflict.</p></section>}<div className="modal-footer"><button className="text-button" onClick={() => setDialog('list')}><List size={15} />Open file list</button><button className="button accent" onClick={() => setDialog(null)}>Start exploring</button></div></Modal>}
  </div>;
}
