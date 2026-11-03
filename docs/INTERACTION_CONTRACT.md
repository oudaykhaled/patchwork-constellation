# Constellation interaction and meaning contract

This is the UX-01 specification for the second [Constellation design](https://www.figma.com/design/A7h1fCr1SbLPRwY4vstSup?node-id=17-2113). It defines the intended behavior and names implementation limits explicitly. It does not certify accessibility, dependency completeness or AI quality. The contribution grid and timelines are outside this product direction.

## Space, typography and controls

The default desktop graph surface occupies at least 80% of the entire application viewport at 1280×720, 1440×900 and 1600×1000. Area means the graph element's width × height divided by viewport width × height, before opening an optional overlay. The present 64px header leaves 91.1%, 92.9% and 93.6% respectively. Floating source, search, view, legend and camera controls do not create a permanent sidebar. Opening details temporarily covers part of the surface; Close and Escape dismiss details and restore the review context.

Use Geist for interface text and Geist Mono for paths, immutable SHAs and compact counts. Current tokens are background `#0C1013`, graph `#091216`, panel `#11171B`, border `#2B383D`, text `#EAF2ED`, muted `#A2B1AA`, accent `#A2F4BA` and direct-change green `#42B968`. Muted colors are a hierarchy, not proof that every use meets contrast requirements; UX-05 audits actual text/size/background combinations. Controls retain visible focus outlines and text names even when icons are shown.

The compact legend remains available at every width. Its `?` disclosure explains file, island, connection and coverage meaning without leaving the map. Enter/Space toggles it; Escape closes it and returns focus to its summary. Long explanation content scrolls within viewport bounds.

## What the marks mean

| Mark or field | Required meaning | Evidence and exclusions |
| --- | --- | --- |
| One circle | One canonical repository file identity | Counts use file IDs, not paths alone, lines changed or group count. |
| Filled green circle | At least one selected source directly touched this file | The selected-source union is not runtime impact or a merged code state. |
| Hollow/dark center circle | Unchanged context in this source selection | Does not mean unused, safe or unaffected at runtime. |
| Outer overlap ring | Two or more selected sources directly touched the same identity | Inspector lists source membership; overlap alone is not a merge conflict. |
| Selected file | A distinct selection cue plus file details and path | Selection must remain recognizable without color. Do not rely solely on green or a thicker overlap ring. |
| Keyboard focus | A visible outline around the focused DOM control/canvas | Focus is independent of selection; Tab moves focus without selecting a file. File exploration remains available in Files. |
| Organic boundary + label | A collection of file circles at the selected grouping level | Boundary/label is not another file circle and is excluded from file totals. |
| Curved connection | A code-derived relationship between canonical file identities | Direction is importer → imported file. Focused arrows and inspector text expose direction. |
| Connection relation | `import`, `reexport`, `type-import` or `dynamic-import` | Inspector names the relation and available path/line/specifier/resolver/ref evidence. Do not collapse these into inferred runtime impact. |
| AI grouping | A separately labeled proposed or accepted semantic membership revision | It cannot create observed dependency edges or change source footprint counts. No AI-inferred connection lines are implemented; future inferred relations require a separate toggle and different line pattern with explicit provenance. |
| Coverage | Snapshot analysis status and reasons/counts | Missing or unresolved edges never establish absence of a dependency. |

Hover, neighbor emphasis and selection must not masquerade as persistent overlap. The integrated renderer draws corner brackets for the selected file, a dashed ring for hover, and separate overlap rings. Canvas instructions name the selection cue, while Files and details expose status and source membership in text. Keyboard focus remains the outline of the active DOM control and is independent of the inspected file.

## File lifecycle and incomplete analysis

Every discoverable repository file stays a file circle, including unsupported language, binary and generated files when they are within the inventoried scope. A source-only or deleted file can remain as a ghost identity outside the pinned context; its inspector must name presence, comparison and coverage. Lifecycle status is an explicit word/symbol in details and Files, not another meaning assigned to green.

| Condition | Required representation | Current boundary |
| --- | --- | --- |
| Added | Direct-change circle when selected; text `Added`; source/base/head evidence | The fill encodes selection membership, not addition specifically. |
| Modified | Direct-change circle when selected; text `Modified`; per-source statistics | Do not sum different sources into a fictitious merged diff. |
| Deleted/removed | Retained discoverable ghost file; text `Deleted`/`Removed`; deletion comparison evidence | No current-context blob is promised. The present canvas does not yet add a distinct ghost pattern. |
| Renamed | One canonical identity when confirmed evidence connects old and new path; text `Renamed`, previous path and comparison provenance | Keep ambiguous rename/delete/recreate as separate reviewable identities; never merge on basename similarity. |
| Unparsed/unsupported | File circle remains inventoried; explicit status/coverage reason; no invented imports | A language label alone does not establish parse coverage. Details show per-file pinned-context import coverage and reasons. Selected-head evidence is a separate explicitly bounded layer. |
| Binary/generated/excluded content | File remains in inventory if known; content/edge analysis exclusion is named | Do not imply a readable diff or provider submission. Truly un-inventoried files are covered by counts/reasons, not fabricated circles. |
| External package/unresolved import | A coverage/evidence entry associated with the importer, including specifier where available | An unresolved external target is not a repository file circle. The current graph draws only resolved file-to-file edges. |

The integrated inspector displays selected-source change status, previous path for an evidenced rename, removed/source-only availability, per-file pinned-context parse coverage and external/unresolved imports. Selected-head provenance and outgoing changed-file imports are labeled separately. Demo diff content remains explicitly illustrative; real source comparisons use immutable links when available. A separate deleted-file canvas pattern is not currently drawn, so presence is communicated in details and Files rather than assigned another implicit circle-fill meaning.

## Group hierarchy

Physical structure and semantic grouping are different dimensions. `path` remains the repository fact. Folder view uses physical path grouping; module/component labels are deterministic manifest/code rules or an explicitly accepted AI/manual revision with origin. Every file has one primary island in a view. Secondary tags and hierarchy do not multiply files or change footprint counts.

Changing Modules/Folders/Components changes boundaries and labels, while circles continue to represent files. Source selection changes membership highlights and affected-group counts, not grouping revision, context SHA, circle identity or settled coordinates. A deliberate grouping/context change may reposition files; preserve valid focus and expose the active grouping source. Parent labels/breadcrumbs explain hierarchy rather than drawing unlabeled groups as oversized file nodes. Current folder presentation groups the first two path segments and the component view uses `component` or the existing label; it is a bounded presentation, not a complete nested explorer.

## Seven reference states

These states are testable views of one continuous map rather than seven static image routes. They share the same 212-file, six-island, 235-connection fixture. Counts below are canonical demo expectations, not assumptions for other repositories.

| Reference state | Entry and expected behavior | Exit and continuity |
| --- | --- | --- |
| Overview | Open the sample: PRs #248, #251 and #256 selected; 68 unique touched files and 14 overlaps. Show all six labeled islands and the compact legend. | No timeline or persistent sidebar. Pan/zoom begins from settled coordinates. |
| Zoomed-out islands | Zoom out continuously or use Fit. Preserve individual file circles; reduce colliding file labels while retaining useful island names/counts. | Zoom about pointer/pinch center; source counts remain exact. Detail suppression must be disclosed. |
| Authentication zoom | Activate the Authentication island label. Fit its file region, display a breadcrumb and keep surrounding context navigable. | All islands/Fit exits focus; source selection and inspected identity remain unless deliberately cleared. |
| File/neighbor focus | Search/select `src/auth/session/refresh.ts`. Show its details, source membership, typed inbound/outbound neighbors and evidence; emphasize the selected file and actual neighbors. | Close/Escape dismisses details. Neighbor activation inspects that file without changing selected sources. Synthetic demo diff is explicitly unavailable. |
| Two-PR selection | Remove #256 from the overview. Expect 57 touched files and two overlaps. | Existing coordinates and camera remain unchanged. Re-adding restores 68/14 without simulation or ref change. |
| Source overlay | Open Edit selection. Keep PR and commit modes separate, expose checked items/filter/paging/selected count, and show the touched-file union and overlap. | Explore changes/Escape returns to the same map. Clear selection retains context files and provides an explicit zero-selection prompt. |
| Commit footprint | Switch to the two demo commits. Expect 24 touched files, four overlaps and five affected islands. | First-parent/root comparison semantics are explicit; switching mode does not convert commits into a first-to-last net diff. |

Loading, cancel, failure, empty selection, partial coverage, stale selection and access revocation extend these states. Keep the last usable map until a replacement is validated; make retry, cancel, source reselect or repository switch available. No error becomes a blank canvas or fabricated successful AI state.

## Narrow and 200% text flow

At narrow widths, source controls and search form separate rows; the graph stays behind them. The inspector becomes a bounded overlay with an independent scroll area. Source and grouping dialogs scroll within the viewport. Files exposes the same file identities and inspector actions without requiring precise circle targeting. The legend explanation retains all meanings even when compact labels are hidden. No horizontal page scroll is needed to reach controls.

At 200% text/browser zoom, preserve source selection, search, open/close details, Files, graph controls and recovery. Reflow controls or use the narrow flow rather than clipping text or hiding the only action. A smaller simultaneous graph region is acceptable when text expansion requires it; the ≥80% default-desktop metric is measured at default zoom. Reduced motion removes camera/layout animation while keeping direct controls responsive.

The styles use pixel font sizes and absolute positions. At short heights the shell must not force a document taller than the viewport: a narrow 640×360 review regression reproduced focus-driven page scrolling that clipped the legend, and the short-height shell rule removes that artificial minimum. `compact-review.spec.ts` exercises source changes, search, inspector close, Files filtering and legend bounds at 640×360, 800×450 and 853×421; these are CSS-viewport reflow checks, not native browser-zoom evidence. Existing 390px reduced-motion and desktop-area checks also retain their own scope. Native browser/text zoom and assistive-technology review must record their actual browser/AT conditions; automated layout success does not establish screen-reader conformance or human task-study results.

## Review handoff

The seven-state contract and legend are specified here. Implemented browser checks live in `tests/e2e/constellation.spec.ts`; layout/identity facts live in `packages/graph-core` and `packages/fixtures`. UX-02 owns selection/recovery, GRAPH-02/03 owns continuity/camera/mark distinctions, UX-03 owns lifecycle/connection detail, and UX-05 owns accessibility implementation and observed review evidence. See [issue evidence](issues/05.md) for what was actually checked for UX-01.
