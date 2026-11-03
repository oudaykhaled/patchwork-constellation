# Graph capacity and regression gate

The supported target remains **2,000 files / 8,000 connections**. The 10,000-file / 40,000-connection fixture is a stress experiment. It has not passed the pan budget and must not be presented as supported release capacity.

The renderer retains every file and connection in the canonical snapshot. Above the target it offers an explicit **Explore scope** selector with shown/total file and connection counts. A selected island draws its files and internal connections; the full Files view and inspector retain the surrounding evidence. Fit all restores the complete view. This filtering does not change source selection, membership or layout identities. Selecting a file outside the current scope restores the full view.

Canvas circles and offscreen island backgrounds are culled against the viewport. Connection culling uses conservative curve bounds, retaining connections that cross the viewport with both endpoints outside. Semantic zoom suppresses background edges and labels with an explicit count notice; focused connections remain available. Layout workers are cancellable and terminate after success, failure, timeout or cancellation. A blocked worker or lost 2D canvas context exposes Files and retry while preserving source choices. Canvas2D uses `contextlost/contextrestored`; the development-only Sigma candidate separately exercises WebGL failure.

## Recorded production sample

Measured on 2026-11-03 using worker/camera/fallback changes from issues #13/#15/#6 and issue #27 implementation commit `ec65e13e8d78bfbf3fb41becc134ba87e2d77dfd`. Later changes correct fixture-seed metadata and isolate optional App credentials; they do not change the rendered scene. The final integrated commit must be rebuilt and rerun.

Windows x64, Intel Core Ultra 9 275HX (24 logical CPUs), 33,752,997,888 bytes RAM, Node24.22.1, Chrome156.0.8078.4, 1600×1000, DPR1. Production frontend on loopback4427; synthetic data only, no GitHub/model traffic. A fresh browser context was used for each sample. Sixteen parallel issue worktrees and other browser activity were active: this is contended development evidence, not a reference-capacity certification.

| Files / connections | First useful view after JSON | Navigation to circles | Pan median / p95 | JS heap used | Pan long tasks |
| --- | --- | --- | --- | --- | --- |
| 212 / 235 | 103.4ms | 180.7ms | 16.7 / 16.8ms | 11,089,905B | 0 |
| 2,000 / 8,000 | 114.8ms | 226.6ms | 16.7 / 16.8ms | 16,628,511B | 0 |
| 10,000 / 40,000 | 298.7ms | 541.7ms | 50.1 / 66.8ms | 25,705,198B | 88, durations50–73ms |

The 212 fixture is authored Constellation v1 (six islands); scale fixtures use seed42 and twelve islands. Layout seed is0. Every pan window alternates directions, excludes five warmup frames and records86 intervals. First-use timing starts when demo JSON is parsed and ends at polled green-circle and worker-ready proof; it includes polling overhead. Startup records contained no observed long tasks in this sample. Pixel-proof overhead is included and this does not isolate worker CPU. JS heap is browser-reported, not process or GPU memory. CPU-only25-run p95 layout+footprint+neighbor calculation was0.80/2.23/10.19ms; it excludes browser/worker transport/rendering.

Numeric evidence and conditions are in [results.json](evidence/graph-04/results.json), with per-fixture records and CPU samples alongside it. The aggregate status is **partial**: the target sample passed while stress pan failed. Independent GPU/browser coverage, hosted gate readback, long-session integrated measurements and uncontented reference-runner acceptance remain. DEL-05 owns warm-selection, hover and sustained lifecycle evidence; combine both reports on the final commit.

## Reproduce and enforce

```powershell
pnpm build
$env:PLAYWRIGHT_CHROME='1' # omit when using installed Playwright Chromium
$env:GRAPH_BENCHMARK_BUILD='production'
$env:GRAPH_BENCHMARK_COMMIT=(git rev-parse HEAD)
$env:GRAPH_BENCHMARK_OUTPUT='test-results/graph-budgets'
$env:GRAPH_BENCHMARK_CONCURRENCY='record actual concurrent activity'
$env:GRAPH_ENFORCE_BUDGETS='true'
pnpm exec playwright test --config playwright.performance.config.ts
pnpm exec tsx packages/graph-core/src/benchmark.ts
```

The dedicated config starts a production server on4427 by default, uses one Chromium worker and no retries, and clears provider/App/database credentials. Set `GRAPH_BENCHMARK_PORT` for another isolated port. Reusing a known production server requires explicit `GRAPH_BENCHMARK_REUSE=true`; record that choice. The dedicated read-only CI workflow builds the app, installs Chromium and gates first-use≤2s, panp95≤33ms and observed startup tasks≤100ms for the212/2k target fixtures. Stress metrics remain visible and cannot silently certify capacity. CI stores numeric synthetic evidence for7days and has no deployment/provider credentials. This workflow has been authored and exercised locally; hosted success and required-check settings are separate evidence.

Functional regressions cover stress scope/count preservation, context/worker failures, camera anchors, resize/input interruption and worker reuse across source toggles. Pure bounds tests preserve crossing connections and prove filters leave canonical data unchanged. Release review must additionally consume DEL-05 churn results, run on the integrated commit and inspect a real GPU/browser matrix.
