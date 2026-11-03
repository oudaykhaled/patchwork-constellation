import { useEffect, useMemo, useState, type ReactNode, type Ref } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, FileCode2, GitCommitHorizontal, GitPullRequest, ShieldCheck, X } from 'lucide-react';
import type { ChangeSource, FileNode, GraphSnapshot } from '@patchwork/contracts';
import { basename, connectionEvidence, diffLink, fileAvailability, groupBreadcrumb, importReferences, isBinaryFile, selectedHeadEvidence, sourceFileLink, sourceLink, textReasons } from '../file-evidence';
import './file-inspector.css';

export function FileInspector({ snapshot, file, selectedSources, closeRef, onClose, onBack, onSelectFile, onFocusGroup, onExplainGroup, organizeControls }: {
  snapshot: GraphSnapshot; file: FileNode; selectedSources: ChangeSource[]; closeRef: Ref<HTMLButtonElement>;
  onClose: () => void; onBack: () => void; onSelectFile: (id: string) => void; onFocusGroup: () => void; organizeControls: ReactNode;
  onExplainGroup?: () => void;
}) {
  const [direction, setDirection] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [visibleNeighbors, setVisibleNeighbors] = useState(8);
  const changes = selectedSources.flatMap(source => source.files.filter(change => change.fileId === file.id).map(change => ({ source, change })));
  const linkKey = JSON.stringify([snapshot.id, snapshot.mode, file.id, changes.map(({ source, change }) => [source.id, source.baseSha, source.headSha, source.sha, source.comparisonKind, change.path])]);
  const [links, setLinks] = useState<{ key: string; urls: Record<string, string | undefined> }>({ key: '', urls: {} });
  useEffect(() => {
    let current = true;
    void Promise.all(changes.map(async ({ source, change }) => [source.id, await diffLink(snapshot, source, change).catch(() => undefined)] as const)).then(pairs => {
      if (current) setLinks({ key: linkKey, urls: Object.fromEntries(pairs) });
    });
    return () => { current = false; };
  }, [linkKey]);
  const nodes = useMemo(() => new Map(snapshot.nodes.map(node => [node.id, node])), [snapshot.nodes]);
  const neighbors = snapshot.edges.filter(edge => edge.source === file.id || edge.target === file.id).map(edge => ({ edge, inbound: edge.target === file.id, node: nodes.get(edge.target === file.id ? edge.source : edge.target) })).filter(item => !!item.node);
  const filteredNeighbors = neighbors.filter(item => direction === 'all' || item.inbound === (direction === 'inbound'));
  const group = snapshot.groups.find(item => item.id === file.groupId);
  const availability = fileAvailability(snapshot, file, changes.map(item => item.change));
  const externalImports = importReferences(file.externalImports), unresolvedImports = importReferences(file.unresolvedImports);
  const contextReasons = textReasons(file.importReasons);
  const contextLink = file.presence === 'deleted' || file.presence === 'source-only' ? undefined : sourceFileLink(snapshot, file.path);
  return <aside className="file-inspector panel" data-testid="file-inspector" aria-label="File inspector">
    <div className="inspector-top"><span className="eyebrow">FILE DETAILS</span><button ref={closeRef} className="icon-button" aria-label="Close file inspector" onClick={onClose}><X size={17} /></button></div>
    <div className="file-title"><span className="file-icon"><FileCode2 size={22} /></span><div><h2>{basename(file.path)}</h2><span className="status-tag">{[...new Set(changes.map(item => item.change.status))].join(' / ') || file.status || 'Unchanged context'}</span></div></div>
    <p className="file-path">{file.path}</p>
    <button className="island-breadcrumb" onClick={onFocusGroup}><span className="island-color" style={{ background: group?.color || '#66bfa0' }} />{groupBreadcrumb(snapshot.groups, file.groupId)}<ArrowRight size={13} /></button>
    {onExplainGroup && <button className="text-button inspector-why-group" onClick={onExplainGroup}>Why this group?</button>}
    <p className="inspector-ref">Context <code>{snapshot.contextSha.slice(0, 12)}</code> · {snapshot.coverage.status} coverage</p>
    <details className="inspector-import-coverage" data-testid="context-import-coverage"><summary>Pinned context import coverage: {file.presence === 'source-only' ? 'not in context' : typeof file.importCoverage === 'string' ? file.importCoverage : 'not recorded'}</summary><p>These import facts belong to context {snapshot.contextSha.slice(0, 12)}. Selected source heads are listed separately below.</p>{file.presence === 'source-only' && <p>This source-only file has no blob or dependency analysis in the pinned context.</p>}{contextReasons.length > 0 && <ul>{contextReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}<h4>External imports ({externalImports.length})</h4>{externalImports.length ? <ul>{externalImports.map((item, index) => <li key={index}><code>{item.specifier}</code>{item.line ? ` · line ${item.line}` : ''}{item.reason ? ` · ${item.reason}` : ''}</li>)}</ul> : <p>No external import metadata recorded. This is not proof that none exist.</p>}<h4>Unresolved imports ({unresolvedImports.length})</h4>{unresolvedImports.length ? <ul>{unresolvedImports.map((item, index) => <li key={index}><code>{item.specifier}</code>{item.line ? ` · line ${item.line}` : ''}{item.reason ? ` · ${item.reason}` : ''}</li>)}</ul> : <p>No unresolved import metadata recorded.</p>}</details>
    {availability.map(message => <p className="inspector-availability" key={message}>{message}</p>)}
    <div className="inspector-divider" /><h3>Selected changes <span>{changes.length}</span></h3>
    {changes.length ? changes.map(({ source, change }) => {
      const url = sourceLink(snapshot, source);
      const diff = links.key === linkKey ? links.urls[source.id] : undefined;
      const label = source.label || source.id;
      const headEvidence = selectedHeadEvidence(snapshot, source, file);
      return <section className="inspector-source" key={source.id}>
        <div className="source-detail">{source.kind === 'pr' ? <GitPullRequest size={15} /> : <GitCommitHorizontal size={15} />}<span>{url ? <a href={url} target="_blank" rel="noreferrer"><strong>{label}</strong><ExternalLink size={11} /></a> : <strong>{label} · {snapshot.mode === 'demo' ? 'synthetic change' : 'source link unavailable'}</strong>}<small>{source.title}</small></span>{isBinaryFile(file, change) ? <span className="small muted">Binary · no line counts</span> : <span className="line-stats"><b>+{change.additions}</b><em>−{change.deletions}</em></span>}</div>
        <p className="inspector-change-kind">{change.status}{change.previousPath ? ` · renamed from ${change.previousPath}` : ''}</p>
        <details className="inspector-import-coverage source-head-evidence" data-testid={`source-head-${source.id}`}><summary>Selected-head dependency evidence · {headEvidence.status}</summary><p>{label} head <code>{(source.headSha || source.sha)?.slice(0, 12) || 'unavailable'}</code> · file coverage: {headEvidence.fileStatus}</p><p>This separate layer covers outgoing imports of directly changed files only. It is not a merged code state, a complete head graph, or proof of runtime impact. It does not change context connection or changed-file counts.</p>{[...headEvidence.reasons, ...headEvidence.fileReasons].length > 0 && <ul>{[...headEvidence.reasons, ...headEvidence.fileReasons].map((reason, index) => <li key={index}>{reason}</li>)}</ul>}{headEvidence.rejectedEdges > 0 && <p>{headEvidence.rejectedEdges} unverified or mismatched head connection records were omitted.</p>}<p>{headEvidence.edges.length} verified head connections involving this file.</p>{headEvidence.edges.map(edge => {
          const inbound = edge.target === file.id, target = nodes.get(inbound ? edge.source : edge.target)!;
          const evidence = connectionEvidence(snapshot, edge);
          return <div className="source-head-connection" key={edge.id}><button className="text-button" onClick={() => onSelectFile(target.id)}>{target.path} · {edge.kind.replaceAll('-', ' ')} · {inbound ? 'imports this file' : 'imported by this file'}</button><p>{evidence.url ? <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.text}<ExternalLink size={11} /></a> : evidence.text}</p></div>;
        })}</details>
        {diff ? <a className="inspector-diff-link" href={diff} target="_blank" rel="noreferrer">Open {label} file diff<ExternalLink size={12} /></a> : snapshot.mode === 'github' && <p className="small muted">{links.key === linkKey ? 'Pinned file diff unavailable. Use the source link above to review the available comparison.' : 'Preparing pinned file diff…'}</p>}
      </section>;
    }) : <p className="muted small">This file is unchanged in your current selection. No selected diff is available.</p>}
    <div className="evidence-note"><ShieldCheck size={15} /><p>{changes.length > 1 ? 'Touched by multiple selected changes. Review each independent diff together.' : changes.length ? 'Directly changed in your selection. Its connections can guide your review.' : 'A context file in this repository map.'}</p></div>
    <h3>Pinned context connections <span>{neighbors.length}</span></h3>
    <p className="muted small neighbor-caption">Inbound files import this file. Outbound files are imported by this file. Neighbors are review candidates, not verified breakage.</p>
    <div className="neighbor-filters" aria-label="Connection direction">{(['all', 'inbound', 'outbound'] as const).map(value => <button key={value} aria-pressed={direction === value} onClick={() => { setDirection(value); setVisibleNeighbors(8); }}>{value === 'all' ? 'All' : value === 'inbound' ? 'Inbound' : 'Outbound'} ({value === 'all' ? neighbors.length : neighbors.filter(item => item.inbound === (value === 'inbound')).length})</button>)}</div>
    <div className="neighbors inspector-neighbors">{filteredNeighbors.slice(0, visibleNeighbors).map(({ edge, node, inbound }) => {
      const evidence = connectionEvidence(snapshot, edge);
      return <div className="neighbor-item" key={edge.id}><button onClick={() => onSelectFile(node!.id)} title={node!.path}>{inbound ? <ArrowLeft size={13} /> : <ArrowRight size={13} />}<span>{basename(node!.path)}<small>{node!.path}</small><small>{edge.kind.replaceAll('-', ' ')} · {inbound ? 'imports this file' : 'imported by this file'}</small></span></button><details><summary>Connection evidence</summary><p>{evidence.url ? <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.text}<ExternalLink size={11} /></a> : evidence.text}</p></details></div>;
    })}{!filteredNeighbors.length && <p className="muted small">No resolved {direction === 'all' ? '' : `${direction} `}imports for this file. Unparsed or unresolved dependencies may still exist.</p>}{filteredNeighbors.length > visibleNeighbors && <button className="text-button" onClick={() => setVisibleNeighbors(value => value + 20)}>Show more connections ({filteredNeighbors.length - visibleNeighbors} remaining)</button>}</div>
    {organizeControls}
    <div className="inspector-footer">{snapshot.mode === 'demo' ? <div className="demo-diff-note"><FileCode2 size={15} /><span>Sample diff · illustrative data<small>Connect a real repository to open its GitHub diffs.</small></span></div> : contextLink ? <a className="button" href={contextLink} target="_blank" rel="noreferrer">Open pinned context file<ExternalLink size={14} /></a> : <p className="small muted">Context file unavailable at this snapshot. Use the selected deletion or source diff above.</p>}<button className="button inspector-overview" onClick={onBack}><ArrowLeft size={14} />Back to overview</button></div>
  </aside>;
}
