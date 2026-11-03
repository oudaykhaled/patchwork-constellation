# Constellation: graph and UX build plan

This plan implements only the user's second design direction. The visual reference is [page 02, Constellation](https://www.figma.com/design/A7h1fCr1SbLPRwY4vstSup?node-id=17-2113). The Figma file contains seven editable demonstration states; it is not a live graph engine or repository integration.

## Product contract

- One circle is one file. Islands label components, modules, or folders.
- The graph surface fills at least 80% of the default desktop application viewport. The reference design uses 93.6%; floating controls and dismissible details protect that space.
- Source selection supports multiple PRs or multiple commits, without a timeline.
- Green indicates a directly changed file, hollow circles retain unchanged context, and an outer ring indicates multiple selected sources. A distinct focus treatment identifies the inspected file.
- Edges carry explicit relation types and direction. Code-derived facts, optional AI inferences, and review candidates must remain distinguishable.
- Source selection changes highlighting, not node positions. Dynamic means real interaction and data refresh, not perpetual force motion.

## Rendering recommendation

Start with a bounded Sigma.js/Graphology spike. Its official documentation exposes graph rendering, styling, camera controls, and extra layers; that makes it a suitable candidate for the required circles, rings, island backgrounds, and zoom behavior. Confirm versions and prove the design features before committing to a renderer. Keep canonical graph data, layout, and renderer separate. [Sigma quickstart](https://www.sigmajs.org/get-started/quickstart/)

Compute deterministic, bounded layout in a worker, keyed by repository snapshot and grouping revision. Reusing coordinates is essential for mental continuity when a user toggles source selections. Layout animation should settle; reduced-motion mode uses immediate state changes. D3 explicitly recommends workers for large static layouts, but the spike should select the measured implementation. [D3 simulation documentation](https://d3js.org/d3-force/simulation)

Use semantic HTML controls and a synchronized accessible file/island list. Canvas contents alone cannot provide the complete keyboard and assistive-technology interaction contract. Target applicable WCAG 2.2 AA criteria and verify implemented journeys, rather than claiming compliance from design review. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

## Data and integration assumptions

The backend must supply versioned repository snapshots, canonical file identities/rename evidence, typed directed connections, group membership, exact selected-source membership, completeness flags, analysis status, and permission-checked diff URLs. Frontend counts must come from canonical identity sets; additions/deletions are not substitutes for touched-file membership. Deleted or missing files remain discoverable in change results even when not present in the current tree.

The intelligence contract must preserve deterministic fallback groups, record evidence and revisions, and separate manual overrides from suggestions. Jev is the verified TypeSafe decision model; AI-02 owns configured account/model and adapter validation. The UI consumes that contract rather than assuming unsupported capabilities.

## Sequence and handoffs

1. M1: UX-01 defines the contract; GRAPH-01 proves rendering and records a decision.
2. M2: GRAPH-02 stabilizes layout; UX-02 connects source selection; GRAPH-03 adds continuous navigation; UX-03 finishes file inspection; UX-05 delivers accessible core review journeys.
3. M3: UX-04 integrates explainable AI/Jev grouping with reversible edits and fallback.
4. M4: GRAPH-04 validates performance and degradation; DEL-07 rechecks accessibility of the added AI grouping flow.

Reconciled dependencies are encoded in [planning/issues.json](../planning/issues.json), including backend source/snapshot and intelligence-contract handoffs.

## Proposed scale envelope and validation

MVP target: 2,000 files / 8,000 edges. Stress fixture: 10,000 / 40,000. Proposed warm interaction budgets are p95 selection feedback ≤250ms, p95 pan/zoom frame ≤33ms, and useful view ≤2s after graph data arrives, on a documented reference machine. These are planning targets that require measurement. Larger scopes must explain filtering or detail reduction rather than silently hiding facts.

The seven design states cover overview, zoomed-out islands, Authentication zoom, file-neighbor focus, two-PR selection, source overlay, and commit footprint. Implementation adds real continuous camera behavior, loading/error/partial/stale states, keyboard access, WebGL fallback, and non-demo data contracts.
