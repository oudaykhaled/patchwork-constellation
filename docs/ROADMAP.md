# Roadmap and execution order

[Kanban board](https://github.com/users/oudaykhaled/projects/5) · [Milestones](https://github.com/oudaykhaled/patchwork-constellation/milestones) · [Issues](https://github.com/oudaykhaled/patchwork-constellation/issues)

These 31 tasks form an acyclic plan. Dates are not promised; milestone exit requires accepted evidence. P0/P1 indicate priority, S/M/L relative complexity. Keys remain stable across GitHub numbering.

## Milestones

| Stage | Exit gate |
| --- | --- |
| M1 Foundation | Clean checkout starts a labeled credential-free demo; schemas/fixtures validate; CI works; renderer decision has measured evidence. |
| M2 Real-data MVP | Read-only connection, exact footprints, stable islands, continuous navigation, file evidence, accessible list and browser journeys pass. No AI credentials required. |
| M3 Intelligence | Verified adapters, bounded policy/budgets, grounded proposals, overrides, refresh and AI evaluation pass. |
| M4 Beta | Measured limits, integrated recovery/security evidence and release/rollback rehearsal; AI accessibility/evaluation checked if enabled. |

## Parallel implementation lanes

Start **DEL-01** (scaffold) and **UX-01** (interaction contract). After scaffold, DATA-01 defines schemas while DEL-02 establishes CI. DEL-03 builds fixtures against those schemas. GRAPH-01 can prove rendering on synthetic data while DATA-02/03 build access and ingestion.

The core integration path is DATA-04 → DATA-05 → DATA-06 → DATA-07, feeding GRAPH-02, UX-02, GRAPH-03 and UX-03. UX-05 and DEL-04 complete the accessible real-data MVP. GRAPH-03 can proceed alongside selection UI once stable layout exists. Source selection never controls layout coordinates.

AI-01 consumes canonical evidence/hierarchy. AI-02 → AI-05 → AI-03 → AI-04 enables UX-04 and AI-06. DATA-08 adds verified refresh separately. The deterministic MVP remains independent of provider jobs.

GRAPH-04 and DATA-09 provide renderer/correctness evidence to DEL-05. DEL-06 reviews implemented trust boundaries. DEL-07 combines those gates with AI-06, UI accessibility, operations and owner license/hosting decisions.

## Task index

| Key | Task | Stage | Priority | Size | Dependencies |
| --- | --- | --- | --- | --- | --- |
| DEL-01 | Scaffold the TypeScript monorepo and reproducible local demo | M1 | P0 | M | None |
| DEL-02 | Add PR quality checks and a safe contribution workflow | M1 | P0 | M | DEL-01 |
| DATA-01 | Define versioned graph, source-selection, and coverage contracts | M1 | P0 | M | DEL-01 |
| DEL-03 | Create deterministic repository fixtures and expected graph snapshots | M1 | P0 | M | DEL-01, DATA-01 |
| UX-01 | Specify the Constellation interaction contract and semantic legend | M1 | P0 | M | None |
| GRAPH-01 | Prove the circle renderer and island layers with a bounded technical spike | M1 | P0 | M | UX-01, DEL-01, DEL-03 |
| DATA-02 | Connect repositories through a read-only GitHub App | M2 | P0 | L | DATA-01 |
| DATA-03 | Build paginated GitHub ingestion with cache and coverage reporting | M2 | P0 | L | DATA-01, DATA-02 |
| DATA-04 | Implement exact multi-PR and multi-commit footprint semantics | M2 | P0 | L | DATA-01, DATA-03 |
| DATA-05 | Build repository inventory and static import graph with file lineage | M2 | P0 | L | DATA-01, DATA-03, DATA-04 |
| DATA-06 | Derive deterministic component, module, folder, and file hierarchy | M2 | P1 | M | DATA-01, DATA-05 |
| DATA-07 | Expose idempotent analysis jobs and progressive graph APIs | M2 | P0 | L | DATA-01, DATA-04, DATA-05, DATA-06 |
| GRAPH-02 | Implement deterministic island layout without movement on source selection | M2 | P0 | L | GRAPH-01, DATA-01, DATA-06 |
| UX-02 | Build multi-PR and multi-commit selection with exact overlap feedback | M2 | P0 | L | UX-01, GRAPH-02, DATA-04, DATA-07 |
| GRAPH-03 | Implement continuous pan, zoom, minimap, and semantic detail levels | M2 | P0 | L | GRAPH-02, UX-01 |
| UX-03 | Build file search, neighbor focus, and an evidence-backed inspector | M2 | P0 | L | UX-02, GRAPH-03 |
| UX-05 | Ship accessible graph alternatives and verify core review journeys | M2 | P0 | L | UX-03 |
| DEL-04 | Verify complete multi-source graph journeys in browsers | M2 | P0 | L | DEL-02, DEL-03, DATA-07, UX-03, UX-05 |
| AI-01 | Define AI enrichment and evidence contracts over the canonical hierarchy | M2 | P0 | M | DATA-05, DATA-06 |
| DATA-08 | Refresh snapshots through verified, idempotent GitHub webhooks | M3 | P1 | M | DATA-02, DATA-03, DATA-07 |
| AI-02 | Integrate a versioned Jev decision adapter and generative provider contract | M3 | P1 | M | AI-01 |
| AI-05 | Enforce AI data policy, cost budgets, caching and failure fallback | M3 | P0 | L | AI-02 |
| AI-03 | Generate evidence-grounded island proposals and Jev membership decisions | M3 | P1 | L | AI-01, AI-02, AI-05 |
| AI-04 | Persist grouping overrides, stable revisions and undo APIs | M3 | P1 | L | AI-01, AI-03 |
| UX-04 | Expose AI and Jev grouping with rationale, confidence, and reversible overrides | M3 | P1 | M | UX-03, GRAPH-02, AI-03, AI-04 |
| AI-06 | Evaluate grouping quality and gate AI rollout against the baseline | M3 | P0 | M | AI-03, AI-04, AI-05, DEL-03 |
| GRAPH-04 | Enforce graph performance budgets and graceful large-repository degradation | M4 | P1 | M | GRAPH-03, UX-03, UX-05 |
| DATA-09 | Gate beta on graph correctness, isolation, and large-repository evidence | M4 | P0 | M | DATA-04, DATA-05, DATA-07, DATA-08, DEL-03 |
| DEL-05 | Establish performance and failure-recovery release evidence | M4 | P1 | L | DEL-04, GRAPH-04, DATA-09 |
| DEL-06 | Review trust boundaries and resolve beta security findings | M4 | P0 | L | DEL-04, DATA-08, AI-04, AI-05, UX-04 |
| DEL-07 | Prepare and rehearse the documented beta release | M4 | P1 | M | DEL-05, DEL-06, AI-06, UX-04 |

## Verification targets

Use 212 files/235 connections for design fidelity, 2,000/8,000 for the initial interactive envelope and 10,000/40,000 for stress. Proposed targets on a declared reference laptop/browser: warm selection p95 ≤250 ms, hover <100 ms, pan/zoom frame p95 ≤33 ms, useful view ≤2 seconds after required graph data arrives, no sustained layout-related main-thread stall >100 ms. Measure network/ingestion separately; these are not achieved results.

Browser checks cover Chromium, Firefox and WebKit, keyboard/list interaction, reduced motion, stale/partial/revoked states and canvas area at 1280×720, 1440×900 and 1600×1000. Unsupported capacity must be visible; silent file loss is unacceptable.

## Board policy

Backlog → Ready → In progress → In review → Done. Ready requires resolved prerequisites and testable scope. WIP limits: 3 In progress, 5 In review. Review needs a PR and evidence; Done needs merged accepted implementation. No implementation issue is complete at planning time.
