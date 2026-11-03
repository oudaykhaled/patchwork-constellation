# Implementation status

Reviewed locally on 2026-11-03. This is a working local public-repository edition. Original issue acceptance criteria remain the release contract; this matrix does not close issues or imply a merge.

**Full** means the scoped local foundation is implemented and checked. **Partial** means useful implementation exists with material acceptance work remaining. **Not verified** means the planned release outcome has not been established.

| Plan key | Status | Implemented evidence and remaining work |
| --- | --- | --- |
| DEL-01 | Full | Pinned workspace, credential-free demo, environment example, local BFF and check/build/run commands. |
| DEL-02 | Partial | Pinned CI actions, frozen-lockfile checks, browser workflow, dependency updates and templates authored. Hosted CI and required-check settings remain. |
| DATA-01 | Partial | Shared types/runtime validation and reference tests exist. Continue full coverage/provenance invariants as the API expands. |
| DEL-03 | Partial | Canonical 212-file fixture, exact source sets, seeded scale graphs and API mocks exist. Full authored Git-history corpus remains. |
| UX-01 | Partial | Constellation specification and working screen; desktop area and narrow flows tested. Assistive-technology/design-contract review remains. |
| GRAPH-01 | Partial | Canvas proves circles, islands, camera, labels, rings and hit testing with local measurements. Formal release capacity review remains. |
| DATA-02 | Partial | Public-repository flow and optional server token work. GitHub App installation/user authorization and private access remain. |
| DATA-03 | Partial | Pinned refs, pagination, credential-isolated cache, response bounds and coverage errors exist. Full retry/fallback traversal remains. |
| DATA-04 | Partial | PR/first-parent footprints, deduplicated overlap and stale-source checks exist. Git fallback and exhaustive lineage/cross-branch fixtures remain. |
| DATA-05 | Partial | Inventory, bounded TS/JS imports, path resolution and evidence exist. Broader exports, selected-head edges and exhaustive lineage remain. |
| DATA-06 | Partial | Deterministic folder/package islands and manual grouping work. Complete complex hierarchy/override migration coverage remains. |
| DATA-07 | Partial | Job polling, cancellation, bounded workers, scoped storage and optional PostgreSQL adapter exist. Automatic restart/resume and distributed load gates remain. |
| GRAPH-02 | Partial | Stable seeded layout and selection coordinates are tested. Layout is synchronous; worker offload and full incremental refresh/pins remain. |
| UX-02 | Partial | Multi-source selection, modes, overlap, paging, repository switching and URL state exist. Complete stale/error/deep-link journeys remain. |
| GRAPH-03 | Partial | Continuous drag/wheel/pinch, keyboard, minimap, Fit and detail levels work. Full touch/overlay and large-graph acceptance matrix remains. |
| UX-03 | Partial | Search, inspector, directional neighbors, per-source stats and GitHub links work. File-anchored diff links and exhaustive unavailable states remain. |
| UX-05 | Partial | Semantic controls, synchronized list, keyboard/reduced-motion/narrow journeys pass. Screen-reader review, WCAG audit and user study remain. |
| DEL-04 | Partial | Chromium and WebKit journeys pass locally. Firefox launch is blocked on this Windows host; hosted three-engine CI remains. |
| AI-01 | Partial | Evidence/grouping contracts, provenance, known-ID validation and fallback exist. Extend shared schemas for later integrations. |
| DATA-08 | Partial | Signature, deduplication and scoped storage helpers are tested. HTTP ingress, authorized routing and refresh enqueue are not wired. |
| AI-02 | Partial | Typed Jev/generative adapters, configuration reporting and mocks exist. Authorized live account/model smoke test remains. |
| AI-05 | Partial | AI defaults off; bounded metadata, budgets, caching and fallback are tested. Account data terms, retention and measured spend policy remain. |
| AI-03 | Partial | Candidate naming, bounded decisions and grounding checks are implemented against mocks. Live model quality needs evaluation. |
| AI-04 | Partial | Rename/move/merge/split/undo service and optional persistence tests exist. Durable app wiring, concurrent edits and refresh migration need completion. |
| UX-04 | Partial | Availability, fallback, preview/apply and manual correction UI exist. Live uncertainty/rationale review remains. |
| AI-06 | Not verified | Safety/mock tests exist; human holdout quality, calibration, live latency/cost and rollout evaluation have not run. |
| GRAPH-04 | Partial | 212/2k/10k render/pan samples and pixel regression exist. Full regression, context loss and production/GPU matrix remain. |
| DATA-09 | Partial | Correctness/security fixtures cover local bounds and common cases. Large Git histories, full isolation corpus and recovery evidence remain. |
| DEL-05 | Partial | Local type/unit/browser/rendering evidence exists. Sustained load/memory, failure injection and production measurements remain. |
| DEL-06 | Partial | Local Host/Origin/body/input and adapter negative tests pass. Complete multi-user/deployed security review remains. |
| DEL-07 | Not verified | No hosting, live PostgreSQL integration, backup/restore/rollback rehearsal, owner license decision or evaluated AI-enabled release is claimed. |

See [verification](VERIFICATION.md), [storage](STORAGE.md), [benchmarks](GRAPH_BENCHMARK.md), the [issue index](../planning/ISSUES.md) and [Kanban](https://github.com/users/oudaykhaled/projects/5) for evidence and next work.
