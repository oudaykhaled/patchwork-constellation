import type { ReactNode } from 'react';
import './graph-legend.css';

/** The compact key is the left cluster of the bottom bar; its explanation is available at every width. */
export function GraphLegend({ sourceKind, showImports = true, detail, scopeNote }: { sourceKind: 'pr' | 'commit'; showImports?: boolean; detail?: ReactNode; scopeNote?: string }) {
  return <div role="group" className="graph-legend" data-node-id="17:3125" aria-label="Graph legend">
    <span className="legend-unit">1 circle = 1 file</span>
    <span><img className="legend-symbol" src="/design/5-imgEllipse.svg" alt="" />Changed</span>
    <span><img className="legend-symbol" src="/design/5-imgEllipse1.svg" alt="" />Unchanged</span>
    <span className="legend-overlap"><img className="legend-symbol legend-symbol-overlap" src="/design/5-imgEllipse2.svg" alt="" />Multiple selected {sourceKind === 'pr' ? 'PRs' : 'commits'}</span>
    {showImports && <span className="legend-imports">Lines = imports</span>}
    {detail}
    <details className="graph-legend-details" onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }}>
      <summary aria-label="Explain graph symbols and connections" title="Explain graph symbols and connections"><span aria-hidden="true">?</span></summary>
      <section className="graph-legend-explanation" aria-label="Graph symbols and connections">
        <h2>Read the map</h2>
        <dl>
          <div><dt>Files</dt><dd>Each circle is one file. Filled green means changed in your selection; hollow means unchanged context. An outer ring marks files touched by multiple selected changes.</dd></div>
          <div><dt>Islands</dt><dd>Rounded rectangles collect files into the selected component, module or folder view, sized by file count. A green border and a count mark islands your selection changed. Hover or focus an island to see its name; click it or press Enter to focus it. Changing the grouping never turns an island into a file.</dd></div>
          <div><dt>Connections</dt><dd>Lines are code-derived imports, including re-exports, type imports and dynamic imports. Select a file to inspect direction, relation and evidence. AI grouping does not add dependency lines.</dd></div>
          <div><dt>Scope</dt><dd>Above 2,000 files or 8,000 connections, Explore scope can limit drawing to one island.{scopeNote && <> <span className="legend-scope-note">{scopeNote}</span></>} Scope filters affect drawing; Files retains all repository evidence.</dd></div>
          <div><dt>Review context</dt><dd>Imports do not prove runtime impact. Overlap does not prove a merge conflict. Missing connections may reflect incomplete analysis; check coverage.</dd></div>
          <div><dt>Focus and status</dt><dd>The selected file opens its details; keyboard focus outlines the active control. File details name added, renamed, deleted and unparsed changes. Open Files to review without the canvas.</dd></div>
        </dl>
        <p>Press Escape or activate ? again to close.</p>
      </section>
    </details>
  </div>;
}
