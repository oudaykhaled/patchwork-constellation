# DATA-08 configured incremental refresh acceptance

The regression in `tests/api/webhook-incremental.test.ts` sends a signed synthetic push through the actual configured webhook HTTP endpoint, then uses explicit authenticated reconciliation. It exercises the installed auth binding registry, current-ref pinning, analysis queue, scoped snapshot lookup, thin-baseline projection and real TypeScript analyzer. GitHub HTTP and user-session ownership are controlled boundaries; the test makes no external GitHub or model call. The inbox and snapshots use PostgreSQL when `TEST_DATABASE_URL` is provided, and a controlled memory boundary otherwise.

The hand-authored repository has four TypeScript files and one `tsconfig.json`. The HTTP and AST process caches are cleared between phases, so a warm process cache cannot explain the reuse. Blob identities use Git's SHA-1 object encoding.

| Phase | Source downloads | Actual parses | Reused files | Observed result |
| --- | --- | --- | --- | --- |
| Initial authorized analysis | 4 | 4 | 0 | Import from `src/main.ts` resolves to the old alias target. |
| Signed push, only tsconfig alias changed | 0 | 0 | 4 | Fresh config is fetched; unchanged syntax resolves to the new target. The event's untrusted SHA is ignored. |
| Explicit reconcile, main source changed | 1 | 1 | 3 | Only `src/main.ts` is fetched and parsed; its newly added import resolves. All observed edges cite the new pinned context SHA. |
| Explicit reconcile at the same SHA | 0 | 0 | 4 | A fresh refresh generation is analyzed while stable file IDs and edge facts remain unchanged. |

Each refresh still inventories the pinned tree and reads relevant configuration. Reuse applies to validated syntax facts only; resolved edges are rebuilt. Old immutable snapshots remain readable. Persisted job inputs contain neither baseline facts nor provider tokens/source bodies.

Verification: `pnpm exec vitest run tests/api/webhook-incremental.test.ts apps/web/incremental-jobs.test.ts packages/analysis/src/incremental.test.ts`. The configured regression and TypeScript check passed locally on 2026-11-03 after merging DATA-05 `11178189` and DATA-07 `de5b1249`. Existing refresh browser and pin regressions cover camera, surviving world coordinates, inspector focus and source selection; this change only adds tests/documentation.

This is correctness and reuse evidence for a small authorized synthetic repository, not a latency/capacity measurement or proof of external GitHub delivery. Hosted multi-process operation, restart routing reconciliation and live App setup remain separate release checks. The default local run does not claim a live PostgreSQL execution for this new regression; the root integrator owns the protected database rehearsal.
