# Integrated performance and recovery evidence

Measured 2026-11-03. The new DEL-05 harness is reproducible; the beta gate remains **partial**. These samples exercised the original production frontend at `a51482357e224819f98c7065ad0a82aec6fd5823`, before the parallel worker/auth/queue changes were integrated. Rerun on the final integrated commit.

The authoritative machine-readable samples are [churn.json](evidence/del-05/churn.json), controlled failure-suite results are [recovery.json](evidence/del-05/recovery.json), and the aggregate [gate.json](evidence/del-05/gate.json) explicitly has `releaseReady: false`.

## Measured interaction window

Windows x64, Intel Core Ultra 9 275HX, 24 logical CPUs, 33,752,997,888 bytes system memory, Node 24.22.1, Chrome 156.0.8078.4, 1600×1000 and DPR 1. Production assets were served on loopback, with no artificial network throttling. Only the synthetic `/api/demo` response was intercepted. No external GitHub or provider requests occurred. Up to 16 agents were building/testing concurrently; this is **not a stable reference-runner capacity certification**.

Each fixture ran four warmup toggles followed by 1,000 measured source toggles. Selection latency is the browser event through updated changed-count text and a subsequent animation frame. Hover latency is a pointer event through the corresponding file-path tooltip. Both use the actual React application and canvas hit testing. Cold/warm navigation includes HTML/modules and fixture delivery; it is not authenticated-response-to-useful-view latency.

| Files / edges | Cold navigation to file pixels | Warm navigation to file pixels | Selection p95 | Hover p95 | Toggle window | GC-retained heap change |
| --- | --- | --- | --- | --- | --- | --- |
| 212 / 235 | 289.3 ms | 109.6 ms | 27.5 ms | 16.7 ms | 33.33 s | +985,876 B |
| 2,000 / 8,000 | 244.2 ms | 161.6 ms | 26.5 ms | 7.4 ms | 33.40 s | +865,180 B |
| 10,000 / 40,000 | 512.4 ms | 380.6 ms | 42.7 ms | 24.0 ms | 41.11 s | +344,792 B |

The 2k selection/hover samples met their proposed 250/100 ms targets in this window. No browser long task was observed during the warm sample window. Global listener counts stayed 15→15 for every fixture; DOM-node changes were +4/+4/−267. Heap values were obtained with Chrome DevTools Protocol after forced garbage collection. They are retained-heap samples, not total process/GPU memory or proof that no leak exists.

The original build did not use layout workers (0→0 in these samples). The instrumentation wraps real `Worker` construction/termination so the integrated worker build must pass the same check. Source toggles must not create extra workers or change the camera. This sample is bounded churn lasting roughly two minutes across three fixtures, not a multi-hour user session.

## Separate evidence lanes

- [GRAPH-04](https://github.com/oudaykhaled/patchwork-constellation/issues/27) owns pan/frame percentiles, worker layout/render timing, viewport culling, context loss and scope degradation. Its benchmark should be linked at `docs/evidence/graph-04/results.json`; do not replace those measurements with selection timings.
- [DATA-09](https://github.com/oudaykhaled/patchwork-constellation/issues/28) owns Git goldens, 10k progressive payloads and isolation. Its controlled Git-read and API timings are in `docs/evidence/data-09.json`. They do not establish live network/database latency.
- [DATA-07](https://github.com/oudaykhaled/patchwork-constellation/issues/12) owns durable queue restart/leases and obsolete completion handling. [DATA-08](https://github.com/oudaykhaled/patchwork-constellation/issues/20) owns durable webhook recovery. Final release evidence must consume these final implementations, including PostgreSQL where configured.

Thirty existing controlled failure/retention tests passed on the original measured build. They verify admission remains occupied until worker termination; source supersession cannot queue unbounded work or apply stale results; invalid/unavailable provider results retain a usable baseline; disabled AI sends no data; cache/revision ownership is preserved; and manual revisions survive process reconstruction. These are real automated tests with injected transports/worker events. They do not claim a live database process restart, real provider outage, live installation revocation or staging rollback was exercised.

## Reproduce on the integrated build

Install with the frozen lockfile, build production assets, and start a dedicated loopback server on port 4429. Set the same port/base URL for the browser suite. Browser tests must use test-only fixtures and no provider credentials. For example, in separate PowerShell terminals:

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:PORT='4429'
$env:AI_ENABLED='false'
$env:GITHUB_TOKEN=''
$env:DATABASE_URL=''
pnpm start
```

```powershell
$env:PORT='4429'
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:4429'
$env:PLAYWRIGHT_CHROME='1' # omit when using installed Playwright Chromium
$env:RELEASE_SOAK_CYCLES='1000'
$env:RELEASE_EVIDENCE_BUILD='production'
$env:RELEASE_EVIDENCE_COMMIT=(git rev-parse HEAD)
$env:RELEASE_EVIDENCE_ACTIVITY='Describe actual concurrent activity and runner conditions'
pnpm exec playwright test tests/e2e/release-soak.spec.ts --project=chromium --workers=1
pnpm exec vitest run tests/release/evidence.test.ts
```

The default is a quick 24-cycle regression. `RELEASE_SOAK_CYCLES` is bounded between 12 and 5,000. On a declared stable reference runner, set `RELEASE_ENFORCE_BUDGETS=1` to fail the 2k selection/hover/warm-navigation sample when its target is missed. Do not confuse the warm-navigation proxy with the authenticated view target. Raw timings, long tasks, GC/DOM counters, worker/handler counts and browser/build conditions are attached to Playwright and written under `.tmp/release-evidence/`.

### Authenticated payload arrival to useful view

The dedicated `authenticated-view.spec.ts` fixture starts the production BFF on an ephemeral loopback port. It uses the actual OAuth session issuer, opaque-cookie lookup, CSRF guard and live user/installation repository intersection with an authored GitHub transport. Installation-token minting and repository analysis/source loading are dependency-injected test doubles. No real App key is loaded or generated, no response is intercepted in the browser, and no production test route exists.

Its controls require missing and tampered sessions to return 401, missing CSRF and removed repository access to return 403, and zero unauthorized analyses. The benchmark cannot run successfully without those controls. It then warms the actual completed owner-scoped BFF job and measures 20 fresh-page cached views. Each browser timestamp starts at `PerformanceResourceTiming.responseEnd` for the authenticated ready-job JSON body, and ends only when the real layout worker is ready and the main canvas contains file-circle pixels. Navigation, module loading and synthetic analysis generation are outside this interval. The test asserts one analysis call across all cached samples and repeated live authorization discovery.

```powershell
pnpm build
$env:PLAYWRIGHT_CHROME='1'
$env:AI_ENABLED='false'
$env:DATABASE_URL=''
$env:API_REQUESTS_PER_MINUTE='2400'
$env:AUTHENTICATED_VIEW_SAMPLES='20'
$env:RELEASE_EVIDENCE_COMMIT=(git rev-parse HEAD)
$env:RELEASE_EVIDENCE_ACTIVITY='Describe actual runner activity'
pnpm exec playwright test --config playwright.authenticated-performance.config.ts
```

This produces `.tmp/release-evidence/authenticated-view.json`. It proves the controlled-identity BFF/browser timing boundary; it does not verify live App registration, real private-repository access, WAN latency, human navigation or GPU behavior. The default 20-sample report is required by the aggregate gate; smaller preparation runs remain diagnostic.

After the renderer/backend suites produce reports, aggregate them:

```powershell
pnpm exec tsx scripts/release-evidence.ts --renderer docs/evidence/graph-04/results.json --backend docs/evidence/data-09.json --authenticated-view .tmp/release-evidence/authenticated-view.json --output .tmp/release-evidence/DEL-05.json
```

The aggregator expects versioned dependency envelopes `{schemaVersion:'1',status,commit,checks:[{id,status,evidence}]}`. It checks the three exact fixture sizes/seed, finite metrics, same recorded production commit, bounded retention and 2k timing targets. Missing/failed/different-commit dependency reports remain visible. `--authenticated-view` now reads and validates a measured JSON artifact: at least 20 warm observations, real workers, response-end timestamps, correct denial controls, computed p95 and the same production commit. A string attestation or zero-worker/zero-observation report fails. Optional `--reference-runner` and `--analysis-phases` arguments remain explicit evidence references supplied by the maintainer; supply them only after those checks were performed. `--require-release` exits nonzero unless all aggregate checks pass. A normal command can finish successfully while its report says `partial`.

## Remaining acceptance

Rerun the three final integrated fixtures and linked dependency suites on one immutable build; collect real authenticated-response-to-view and analysis-phase timings; perform PostgreSQL worker-outage recovery where persistence is used; run a longer staging review session with controlled runner contention. Record any missed budget as a linked remediation. The 10k fixture is a stress case, not an accepted capacity claim; consult GRAPH-04 before expanding the supported envelope. Beta remains blocked by missing or failed evidence.

## Final integrated measurement

The original samples above are historical. [Final verification](FINAL_VERIFICATION.md) and [final raw evidence](evidence/final/) now record the same-commit worker-era renderer, 1,000-toggle retention, controlled authenticated BFF and real-Git phase measurements at bcfa511. All proposed 2k targets passed; 10k is stress-only. The aggregate release gate remains partial for explicitly unverified reference/GPU/deployed acceptance.
