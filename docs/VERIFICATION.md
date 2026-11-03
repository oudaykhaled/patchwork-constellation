# Verification evidence

Local checks recorded on 2026-11-03 using Windows, Node.js 24.22.1, pnpm 11.25.0 and the committed lockfile. Final core browser checks use the production frontend served locally. Hosted CI, deployment and external provider verification have separate gates.

| Check | Observed result |
| --- | --- |
| `pnpm check` | Passed: type check, 90 unit/integration tests passed, one opt-in PostgreSQL integration skipped, production frontend built. |
| Chromium core browser journeys | 12 passed using the installed Google Chrome channel. |
| WebKit core browser journeys | 11 passed; one shared single-user manual revision scenario intentionally runs only in Chromium. |
| Firefox core browser journeys | Official Playwright Firefox could not start on this Windows host: `spawn UNKNOWN` before page creation. No Firefox application result is claimed. Linux CI retains the project. |
| Graph rendering sample | 212/235, 2,000/8,000 and 10,000/40,000 node/edge fixtures rendered and panned, with canvas pixels checked. See [benchmark evidence](GRAPH_BENCHMARK.md). |
| PostgreSQL | Memory isolation/lease tests pass. Live integration requires `TEST_DATABASE_URL`; skipped without it. |
| AI/Jev | Grounding, isolation, fallback, budgets and revisions use controlled mocks. No paid/live provider call or quality evaluation is claimed. |

## Browser scope

Flows check the 68→57 PR footprint, 24-file commit footprint, camera preservation, actual zoom/keyboard movement, search/inspector, synthetic demo provenance, accessible list, failed repository recovery, stale grouping responses after a context switch, manual rename/undo and disabled-AI UI. Graph area is at least 80% at 1280×720, 1440×900 and 1600×1000. A 390×844 reduced-motion/list journey also passes.

Tests wait for actual file-circle pixels rather than treating a loaded page or labels as proof of painting. Failure traces/screenshots are retained by Playwright and bounded CI artifacts. Screenshot attachments document layout; they are not a completed visual/accessibility audit.

## HTTP and domain scope

HTTP tests cover local Host/Origin restrictions, malformed/unsupported/oversized requests, unknown snapshots/jobs/sources, selection bounds, paging, storage capabilities and repository-scoped retrieval. Unit suites exercise contracts, source sets, layout/camera, GitHub errors/limits, static analysis, grouping and storage primitives.

The default app is a single-user loopback service for public repositories. These checks do not establish multi-user authorization. GitHub App access, webhook refresh, Git fallback, durable restart and selected-head dependency analysis remain in the [status matrix](IMPLEMENTATION_STATUS.md).

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
```

For an installed Chrome, set `PLAYWRIGHT_CHROME=1`, then run `pnpm test:e2e --project=chromium --workers=1 tests/e2e/constellation.spec.ts`. The performance file is `tests/e2e/graph-performance.spec.ts`; it records measurements with declared fixtures and conditions.

Rerun relevant checks after changes and append actual hosted/live results. A plan or authored test is not evidence that an implementation issue is Done.
