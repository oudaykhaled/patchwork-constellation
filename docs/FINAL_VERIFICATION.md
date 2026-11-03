> Historical pre-publication measurement record. The complete source has since been published and hosted CI regressions corrected; see [current publication and verification](PUBLICATION_STATUS.md). Metrics below identify their original source commit.

# Final integrated verification

Recorded 2026-11-03. This pre-publication application was measured at **bcfa5110ee0c4f30568b730e868d5be658c3aae9**. Subsequent renderer/harness fixes are recorded separately in the current publication report. All 31 issue lanes were implemented in isolated worktrees with up to 16 agents at once; bounded integration follow-ups resolved shared contracts, authorization/purge races, incremental refresh and the camera reload defect. Apache-2.0 is applied, with the exact bundled MIT/ISC/OFL notices retained.

The final audit has **21 conditional closure candidates and 10 partial issues**. No issue was closed and the complete implementation has not been published. The [acceptance audit](ISSUE_REMEDIATION.md) identifies each original requirement; [machine-readable verification](final-verification.json) records scope and limits.

## Completed checks

- Full `pnpm check`: **386 tests passed**, three opt-in database/process tests skipped; five quality-script checks, formatting, lint, typecheck, dependency notices and production build passed.
- Real isolated PostgreSQL 17.11: **22 checks across four suites passed**, including independent connections, latest owner/repository snapshot selection, coordinator hard kill and real lease expiry, signed HTTP webhook/inbox restart, revocation and purge. The subsequent runtime change was the UI camera fix; storage/database files are unchanged.
- Functional Chromium/WebKit: **118 passed, two intentional skips** (WebKit shared mutation and unsupported CDP touch injection). The earlier 10k reload failure was reproduced on old production and corrected; both engines now pass settled-camera reload and rapid-pan/source-retention checks.
- Dedicated production Chromium renderer/capacity: **five passed**. Separate production churn: **three passed, 1,000 toggles per fixture**. No additional workers or global listeners were retained by those toggles; bounded post-GC heap/DOM samples stayed within diagnostic limits.
- Controlled authenticated production BFF: **two tests passed**, including missing/tampered session, missing CSRF and removed-repository denial controls; **20 warm samples, p95 156.7 ms** from authenticated JSON body arrival to real worker readiness and painted file circles. Actual session/CSRF/repository guards ran against controlled GitHub transport. Token minting and analysis data were injected; no real App key, browser response interception, production bypass or WAN claim.
- Actual authored Git goldens, unavailable-fork/force-push fallback, full-versus-incremental graph equality, owner isolation, provider-disabled behavior and failure recovery passed within the combined suites. Signed configured refresh reused unchanged syntax while resolving current aliases/exports; changed files alone were fetched and parsed. See [incremental refresh](INCREMENTAL_REFRESH.md) and [configured evidence](issues/20-incremental.md).

## Measured production window

Windows x64, Core Ultra 9 275HX, 24 logical CPUs, 33,752,997,888 B memory, Node 24.22.1, Chrome 156.0.8078.4, 1600×1000/DPR 1. Loopback with no artificial throttling; authored/synthetic graph responses. All issue agents and other test suites were stopped; the local preview was idle and ordinary desktop background activity was uncontrolled. This is a recorded local sample, not dedicated reference/GPU or multi-user staging certification.

| Files / edges | Cold / warm navigation to file pixels | Selection p95 | Hover p95 | Pan frame p95 | Retained GC heap delta |
| --- | --- | --- | --- | --- | --- |
| 212 / 235 | 340.1 / 113.9 ms | 27.3 ms | 8.8 ms | 16.9 ms | 1,064,468 B |
| 2,000 / 8,000 | 271.1 / 184.6 ms | 26.9 ms | 7.4 ms | 16.8 ms | 967,360 B |
| 10,000 / 40,000 | 621.1 / 530.6 ms | 66.3 ms | 8.3 ms | 66.7 ms | 438,216 B |

All supported 2k targets passed: selection ≤250 ms, hover <100 ms, pan ≤33 ms and authenticated cached useful view ≤2 seconds. Navigation and authenticated-response timings remain separate. At 10k/40k, pan is **66.7 ms**, with long tasks; this is stress-only and does not expand the supported envelope. Complete file counts, scope controls and the Files view remain. The open [GRAPH-04 issue #27](https://github.com/oudaykhaled/patchwork-constellation/issues/27) retains this capacity limitation.

Controlled real-Git analysis took 366.75 ms, with separately recorded phase checkpoints and 174.62 ms source-overlay work. Progressive HTTP delivered exactly 10,000 nodes and 40,000 edges across 20/40 pages; maximum payloads were 191,148/186,593 B. These figures describe local fixture transport, not live GitHub or database latency. [Raw evidence](evidence/final/backend.json) retains partial deployment/containment limits.

## Artifact and database recovery

The clean frozen source packaged twice to identical SHA-256 **673ad66406d3c196fefc29fa5e0b2828bda403bce81556736015950ed7bdbf71** (382 entries; 2,076,702 B). Candidate extraction, frozen offline installation, production HTML/demo, real worker/storage/queue readiness, exact dependency/font notices and disabled-provider zero-transfer checks passed. A distinct previous licensed artifact was restored successfully. See [artifact record](evidence/final/artifact.json) and [rollback](evidence/final/artifact-rollback.json). This archive represents the measured implementation commit; the final Git bundle also includes these later verification documents.

Native pg_dump/pg_restore of the current schema into fresh synthetic databases passed migration, four-table count and snapshot/job digest equality, followed by idempotent migrations. Both disposable databases were dropped and the owned loopback service stopped. [Database report](evidence/final/database-restore.json). No existing database or hosted service was overwritten.

## Remaining acceptance and publication

Keep #2, #5, #15, #17, #18, #21, #26, #27, #28 and #31 open for their specific hosted CI, actual browser zoom, human accessibility/task study, live-account/model evaluation, GPU/reference or deployed staging/release requirements. Local Firefox failed to launch on this Windows host; older PR checks do not verify this implementation. Intelligence stays off because actual reviewed live/human quality gates are unmet. The aggregate release gate remains partial; local timing success does not approve a beta.

GitHub connector writes returned 403, Git has no saved account and web-editor commits failed generically after 118 of an initial 221-file frozen set. Readback verified those 118, but the remote branch at 630bbe9 is incomplete and is not a runnable integration snapshot. Fresh verified browser tabs also failed. No remediation PR, issue closure or Kanban completion is claimed. [Publishing handoff](PUBLISHING_HANDOFF.md) gives the safe continuation after local authentication.
