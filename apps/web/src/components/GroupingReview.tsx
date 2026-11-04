import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleHelp, LoaderCircle, RotateCcw, ShieldCheck, X } from 'lucide-react';
import type { GraphSnapshot } from '@patchwork/contracts';
import { islandIdentityColor, type GraphLayout } from '../../../../packages/graph-core/src/index';
import { previewLayoutChanges, startLayoutTask, type LayoutWorkerPort } from '../../../../packages/graph-core/src/layout-task';
import { describeEvidence, groupingSource, inspectProposal, type ReviewDecision, type ReviewPolicy, type ReviewProposal, type ReviewRevision } from '../grouping-review';
import './grouping-review.css';

export type Movement = ReturnType<typeof previewLayoutChanges>[number];
type Props = {
  snapshot: GraphSnapshot; presentationSnapshot?: GraphSnapshot | null; proposal: ReviewProposal | null; revision: ReviewRevision | null;
  busy: boolean; error: string; hasUndo: boolean; persistence?: string; available?: boolean;
  availabilityMessage?: string; configured?: boolean; evaluation?: { passed: boolean; reason?: string };
  policyPreview: ReviewPolicy | null; onPreviewPolicy: () => void;
  explainedGroupId: string | null; activeLayout: GraphLayout | null;
  onExplain: (id: string) => void; onRequest: () => void; onUndo: () => void;
  onApply: () => void; onReject: () => void; onReload: () => void; onMutate: (operation: unknown) => void;
};

function DecisionEvidence({ snapshot, decision }: { snapshot: GraphSnapshot; decision: ReviewDecision }) {
  return <div className="review-decision">
    <strong>{snapshot.nodes.find(node => node.id === decision.fileId)?.path}</strong>
    <p>{decision.rationale || 'No model rationale was supplied. Inspect the observed facts before accepting.'}</p>
    <small>{typeof decision.confidence === 'number' ? `Model uncertainty score: ${Math.round(decision.confidence * 100)}% confidence` : 'Model confidence was not provided'} · not measured accuracy</small>
    {decision.evidenceCoverage !== undefined && <small>Observed evidence coverage: {Math.round(decision.evidenceCoverage * 100)}% · independent of model confidence</small>}
    {(decision.origin === 'rules' || decision.outcome === 'retained') && <small>Baseline membership retained; review is needed before any reassignment.</small>}
    <ul aria-label="Supporting evidence">{(decision.evidenceIds ?? []).map(id => <li key={id}>{describeEvidence(snapshot, id) || 'Evidence is unavailable in this snapshot.'}</li>)}</ul>
  </div>;
}

function MovementPreview({ snapshot, proposal, activeLayout }: { snapshot: GraphSnapshot; proposal: ReviewProposal; activeLayout: GraphLayout | null }) {
  const review = useMemo(() => inspectProposal(snapshot, proposal), [snapshot, proposal]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    const controller = new AbortController(); setState('loading'); setMovements([]);
    if (!review.valid) { setState('failed'); return; }
    if (!review.changes.length) { setState('ready'); return; }
    const task = async () => {
      const run = (id: number, graph: { nodes: GraphSnapshot['nodes']; groups: GraphSnapshot['groups']; edges: [] }, previous?: GraphLayout) => {
        const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'constellation-grouping-preview' });
        return startLayoutTask(worker as unknown as LayoutWorkerPort, { id, graph, previous }, controller.signal);
      };
      const before = activeLayout ?? await run(1, { nodes: snapshot.nodes, groups: snapshot.groups, edges: [] });
      const after = await run(2, { nodes: snapshot.nodes.map(node => ({ ...node, groupId: proposal.membership![node.id]! })), groups: proposal.groups!, edges: [] }, before);
      if (!controller.signal.aborted) { setMovements(previewLayoutChanges(before, after)); setState('ready'); }
    };
    void task().catch(() => { if (!controller.signal.aborted) setState('failed'); });
    return () => controller.abort();
  }, [snapshot, proposal, activeLayout, review.valid, review.changes.length]);
  const allPoints = movements.flatMap(change => [change.before, change.after]);
  const minX = allPoints.length ? Math.min(...allPoints.map(point => point.x)) : 0;
  const minY = allPoints.length ? Math.min(...allPoints.map(point => point.y)) : 0;
  const width = allPoints.length ? Math.max(1, Math.max(...allPoints.map(point => point.x)) - minX) : 1;
  const height = allPoints.length ? Math.max(1, Math.max(...allPoints.map(point => point.y)) - minY) : 1;
  const point = (position: { x: number; y: number }) => ({ x: 16 + (position.x - minX) / width * 328, y: 16 + (position.y - minY) / height * 108 });
  return <section className="movement-review" aria-label="Grouping movement preview">
    <h3>Before you apply</h3>
    <p><strong>{review.changes.length} files would move between islands.</strong> Other memberships and observed imports stay unchanged.</p>
    {state === 'loading' && <p role="status"><LoaderCircle size={13} className="spinning" /> Calculating settled movement…</p>}
    {state === 'failed' && <p role="status">The movement map is unavailable. The complete membership changes are listed below; your active map is unchanged.</p>}
    {state === 'ready' && movements.length > 0 && <svg className="movement-map" viewBox="0 0 360 140" role="img" aria-label={`${movements.length} file movements; hollow starting points and filled destination points`}>
      {movements.map(change => { const before = point(change.before); const after = point(change.after); return <g key={change.fileId}><line x1={before.x} y1={before.y} x2={after.x} y2={after.y} /><circle cx={before.x} cy={before.y} r={3} className="movement-before" /><circle cx={after.x} cy={after.y} r={3} className="movement-after" /></g>; })}
    </svg>}
    {state === 'ready' && movements.length > 0 && <p className="small muted">Hollow circle: current position. Filled circle: proposed position. Lines show movement, not imports.</p>}
    {state === 'ready' && movements.length < review.changes.length && <p className="small muted">Positions are available for {movements.length} of {review.changes.length} moved files in the active scope. Every changed membership remains listed below.</p>}
    {review.changes.length > 0 && <details><summary>Review every changed membership ({review.changes.length})</summary><ul className="membership-changes">{review.changes.map(change => <li key={change.fileId}><code>{snapshot.nodes.find(node => node.id === change.fileId)?.path}</code><span>{snapshot.groups.find(group => group.id === change.fromGroupId)?.label}<ArrowRight size={12} />{proposal.groups?.find(group => group.id === change.toGroupId)?.label}</span></li>)}</ul></details>}
    <p className="small muted">This preview never moves the active map. Applying creates a revision; undo restores its prior membership and cached layout.</p>
  </section>;
}

export function GroupingReview(props: Props) {
  const { snapshot, revision, proposal, busy, error, hasUndo } = props;
  const [renameId, setRenameId] = useState(''); const [renameValue, setRenameValue] = useState('');
  const [action, setAction] = useState<'merge' | 'split'>('merge'); const [label, setLabel] = useState('');
  const [mergeIds, setMergeIds] = useState<string[]>([]); const [splitId, setSplitId] = useState(''); const [splitFiles, setSplitFiles] = useState<string[]>([]);
  const review = proposal ? inspectProposal(snapshot, proposal) : null;
  const canonicalExplained = snapshot.groups.find(group => group.id === props.explainedGroupId);
  const explained = canonicalExplained ?? props.presentationSnapshot?.groups.find(group => group.id === props.explainedGroupId);
  const displayedFileIds = new Set(props.presentationSnapshot?.nodes.filter(node => node.groupId === explained?.id).map(node => node.id) ?? []);
  const explainedFiles = snapshot.nodes.filter(node => canonicalExplained ? node.groupId === canonicalExplained.id : displayedFileIds.has(node.id));
  const explainedDecisions = (revision?.decisions ?? []).filter(decision => explainedFiles.some(node => node.id === decision.fileId));
  const importCount = snapshot.edges.filter(edge => explainedFiles.some(node => node.id === edge.source || node.id === edge.target)).length;
  const availabilityMessage = props.configured && props.evaluation && !props.evaluation.passed ? props.evaluation.reason || 'Quality evaluation is pending. External AI remains disabled.' : props.availabilityMessage || (props.available ? 'Jev adapter configured; account/model evaluation is a separate release gate.' : 'Server credentials required for live AI + Jev.');
  return <>
    <p className="modal-intro">Start with repository structure. Review evidence before applying a new organization.</p>
    <div className="grouping-status"><ShieldCheck size={20} /><div><strong>{groupingSource(snapshot, revision)}</strong><p>Your current map stays usable while AI is disabled or unavailable.</p></div><span className="status-tag">Active</span></div>
    <p className="inline-note">{revision ? <>Revision <code>{revision.id}</code> · {revision.provenance?.source || revision.origin || 'canonical'}<br /></> : 'Loading current revision… '}{props.persistence === 'local-file' ? 'Manual revisions are saved on this server.' : 'Persistence depends on server configuration; process-memory changes end when the server restarts.'}</p>
    <p className="inline-note ai-data-policy">Optional AI sends only the server-disclosed, bounded file IDs, paths, island names and import metadata. File contents are not included. Disabled AI sends no provider request.</p>
    <button className="button" disabled={busy} onClick={props.onPreviewPolicy}>Preview data sent to AI</button>
    {props.policyPreview && <section className="group-explanation" aria-label="External data policy preview">
      <h3>Metadata preview · {props.policyPreview.version}</h3>
      <p>{props.policyPreview.analyzedFiles} eligible files in this request · {props.policyPreview.excludedFiles} excluded by policy. File contents are excluded. Remaining files outside this bounded request retain their current grouping.</p>
      <p>{props.policyPreview.externalEnabled ? 'External AI is enabled, but this preview made no model request.' : 'External AI is disabled. This preview made no model request.'}</p>
      <details><summary>Fields included in the request</summary><ul>{props.policyPreview.fieldsSent.map(field => <li key={field}>{field}</li>)}</ul></details>
      <details><summary>Exact bounded file metadata ({props.policyPreview.metadata.files.length})</summary><ul className="observed-paths">{props.policyPreview.metadata.files.map(file => <li key={file.id}><strong>{file.path}</strong><br /><small>File ID: {file.id} · island: {props.policyPreview!.metadata.groups.find(group => group.id === file.groupId)?.label || file.groupId}</small>{file.imports.length > 0 && <ul>{file.imports.map(id => <li key={id}>Import target: {snapshot.nodes.find(node => node.id === id)?.path} · ID {id}</li>)}</ul>}</li>)}</ul></details>
      <details><summary>Island names included ({props.policyPreview.metadata.groups.length})</summary><ul className="observed-paths">{props.policyPreview.metadata.groups.map(group => <li key={group.id}>{group.label} · ID {group.id}</li>)}</ul></details>
      <p className="small muted">Regenerate this preview after changing the grouping. Choosing “Review with AI + Jev” is a separate action.</p>
    </section>}
    <div className="grouping-actions"><button className="button accent" onClick={props.onRequest} disabled={busy}>Review with AI + Jev</button><button className="button" disabled={!hasUndo || busy || !revision} onClick={props.onUndo}><RotateCcw size={14} />Undo grouping</button><button className="text-button" onClick={props.onReload} disabled={busy}>Reload current grouping</button></div>
    {proposal && <section className={`proposal-result ${proposal.status === 'baseline' ? 'baseline' : ''}`} aria-label="Grouping proposal">
      <span className="eyebrow">{proposal.status === 'baseline' ? 'BASELINE PRESERVED' : 'AI-GENERATED PROPOSAL · REVIEW REQUIRED'}</span>
      <p>{proposal.message || (proposal.status === 'baseline' ? 'Your deterministic grouping is retained.' : 'Review proposed island names and membership before applying.')}</p>
      {proposal.models && <p className="small muted">Models: Jev {proposal.models.jev} · naming {proposal.models.generative}</p>}
      {proposal.dataPolicy && <p className="small muted">Evidence coverage: {proposal.dataPolicy.analyzedFiles} of {snapshot.nodes.length} files analyzed; {proposal.dataPolicy.excludedFiles} excluded by policy. Coverage is separate from model uncertainty.</p>}
      {proposal.status !== 'baseline' && <>
        {review && !review.valid && <p role="alert" className="form-error">{review.error} Your current map is retained. Request another preview.</p>}
        {review?.valid && <><div className="proposal-islands">{proposal.groups?.map(group => {
          const decisions = (proposal.decisions ?? []).filter(decision => (decision.groupId ?? decision.islandId) === group.id);
          const files = snapshot.nodes.filter(node => proposal.membership?.[node.id] === group.id);
          const labelEvidence = proposal.labelEvidence?.find(label => label.groupId === group.id);
          return <details key={group.id}><summary><strong>{group.label}</strong><span>{files.length} files · {decisions.length} reviewed decisions</span></summary><p className="small muted">AI-generated name; observed file paths remain unchanged.</p>{labelEvidence && <div className="review-decision"><strong>Why this name?</strong><p>{labelEvidence.rationale}</p><ul>{labelEvidence.evidenceIds.map(id => <li key={id}>{describeEvidence(snapshot, id)}</li>)}</ul></div>}{decisions.length ? decisions.map(decision => <DecisionEvidence key={decision.fileId} snapshot={snapshot} decision={decision} />) : <p className="small muted">No model decision was recorded for this island. Existing membership is retained.</p>}<details><summary>Observed member paths</summary><ul className="observed-paths">{files.map(file => <li key={file.id}><code>{file.path}</code></li>)}</ul></details></details>;
        })}</div><MovementPreview snapshot={snapshot} proposal={proposal} activeLayout={props.activeLayout} /></>}
        <div className="proposal-review-actions"><button className="button accent" disabled={busy || !revision || !review?.valid} onClick={props.onApply}>Apply reviewed grouping</button><button className="button" disabled={busy || !revision} onClick={props.onReject}>Reject proposal</button></div>
      </>}
    </section>}
    {explained && <section className="group-explanation" aria-label="Why this group?" tabIndex={-1}>
      <h3>Why this group? <span>{explained.label}</span></h3><p>{explained.origin === 'manual' || revision?.origin === 'manual' ? 'This organization includes an explicit user correction. It takes precedence over generated suggestions.' : explained.origin === 'ai' || revision?.origin === 'ai-jev' ? 'A reviewed AI + Jev proposal assigned these files. Its explanation is a suggestion grounded in the evidence below.' : 'This island comes from observed repository structure and deterministic grouping rules.'}</p>
      <p>{explainedFiles.length} observed file paths · {importCount} resolved import connections · coverage {snapshot.coverage.status}. Connections are review context, not proven runtime impact.</p>
      {explainedDecisions.length ? explainedDecisions.map(decision => <DecisionEvidence key={decision.fileId} snapshot={snapshot} decision={decision} />) : <p className="small muted">No persisted model rationale is attached to this island. Inspect its physical paths and observed imports instead.</p>}
      <details><summary>Observed files in {explained.label}</summary><ul className="observed-paths">{explainedFiles.map(file => <li key={file.id}><code>{file.path}</code></li>)}</ul></details>
    </section>}
    <h3 className="section-title">Current islands <span>{snapshot.groups.length}</span></h3>
    <div className="grouping-list">{snapshot.groups.map(group => <div key={group.id}><span className="island-color" style={{ background: islandIdentityColor(group.color || '#6a9ec7') }} /><span><strong>{group.label}</strong><small>{snapshot.nodes.filter(node => node.groupId === group.id).length} files · {group.origin || 'rules'}</small></span><button className="text-button" onClick={() => props.onExplain(group.id)} aria-label={`Why this group: ${group.label}`}><CircleHelp size={14} /></button><button className="text-button" disabled={busy || !revision} onClick={() => { setRenameId(group.id); setRenameValue(group.label); }}>Rename</button></div>)}</div>
    {renameId && <form className="rename-form" onSubmit={event => { event.preventDefault(); props.onMutate({ type: 'rename', groupId: renameId, label: renameValue }); setRenameId(''); }}><label className="form-label">Island name<input autoFocus aria-label="Island name" value={renameValue} onChange={event => setRenameValue(event.target.value)} maxLength={64} required /></label><button className="button accent" disabled={!renameValue.trim() || busy || !revision}>Save name</button><button type="button" className="icon-button" aria-label="Cancel rename" onClick={() => setRenameId('')}><X size={15} /></button></form>}
    <details className="advanced-grouping"><summary>Merge or split islands</summary><div className="segmented-control"><button className={action === 'merge' ? 'selected' : ''} onClick={() => setAction('merge')}>Merge islands</button><button className={action === 'split' ? 'selected' : ''} onClick={() => setAction('split')}>Split an island</button></div><label className="form-label">New island name<input value={label} onChange={event => setLabel(event.target.value)} maxLength={64} placeholder="e.g. Identity services" /></label>{action === 'merge' ? <fieldset className="advanced-checks"><legend>Choose at least two islands</legend>{snapshot.groups.map(group => <label key={group.id}><input type="checkbox" checked={mergeIds.includes(group.id)} onChange={() => setMergeIds(ids => ids.includes(group.id) ? ids.filter(id => id !== group.id) : [...ids, group.id])} />{group.label}</label>)}</fieldset> : <><label className="form-label">Source island<select value={splitId || snapshot.groups[0]?.id} onChange={event => { setSplitId(event.target.value); setSplitFiles([]); }}>{snapshot.groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label><fieldset className="advanced-checks file-checks"><legend>Choose files to move into the new island</legend>{snapshot.nodes.filter(node => node.groupId === (splitId || snapshot.groups[0]?.id)).map(node => <label key={node.id}><input type="checkbox" checked={splitFiles.includes(node.id)} onChange={() => setSplitFiles(ids => ids.includes(node.id) ? ids.filter(id => id !== node.id) : [...ids, node.id])} /><code>{node.path}</code></label>)}</fieldset></>}
    <div className="advanced-footer"><span className="subtle small">Changes create a revision and can be undone.</span><button className="button accent" disabled={busy || !revision || !label.trim() || (action === 'merge' ? mergeIds.length < 2 : splitFiles.length === 0 || splitFiles.length >= snapshot.nodes.filter(node => node.groupId === (splitId || snapshot.groups[0]?.id)).length)} onClick={() => { props.onMutate(action === 'merge' ? { type: 'merge', groupIds: mergeIds, label } : { type: 'split', groupId: splitId || snapshot.groups[0]?.id, fileIds: splitFiles, label }); setMergeIds([]); setSplitFiles([]); setLabel(''); }}>{action === 'merge' ? 'Merge selected islands' : 'Create new island'}</button></div></details>
    <p className="inline-note">AI output is displayed as text and cannot run instructions or change observed imports, physical paths, or source-change counts.</p>
    {error && <div className="form-error" role="alert"><p>{error}</p><button className="button" onClick={props.onReload} disabled={busy}>Review latest revision</button></div>}
    <p className="subtle small" role="status">{availabilityMessage}</p>
  </>;
}
