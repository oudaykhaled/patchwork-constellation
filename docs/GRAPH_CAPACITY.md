# Graph capacity and regression gate

The supported target remains **2,000 files / 8,000 connections**. The 10,000-file / 40,000-connection fixture remains a stress experiment: the current cached-pan sample passes, but initial rendering exceeds the startup-task target. It must not be presented as supported release capacity.

## Current integrated evidence

Application `2f6a59174ed981b27957218890ee75c4d6b9019a` passed the [dedicated hosted budget gate](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712031705) and the [three-engine browser workflow](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712031764). The budget checkout `76aa8e4aba5227dbc28efedb211d8180627e7e5c` was independently verified to have the same Git tree as that application commit. PR #32 was subsequently merged as `2100fbe7d36ed8bdfa86d9129339dbb39a2b8bd7`; its source changes after the application freeze were documentation only.

The hosted 2k/8k record measured **16.7 ms pan p95**, **243.7 ms first useful view after data**, and a maximum observed startup task of **52 ms**. All supported-envelope assertions passed without reducing files, edges or the original budgets. The dedicated conditions were a four-logical-CPU AMD EPYC 7763 Linux runner, about 16.8 GB RAM, Chromium 156.0.8078.4, 1600×1000/DPR1, one worker, trace/video off and a loopback synthetic response. Its active backend was SwiftShader software rendering. This is a repeatable CI reference, not physical-GPU behavior evidence or a universal laptop claim.

The 10k/40k record measured **16.8 ms pan p95**, but its startup-task assertion failed. The earlier 66.8 ms local and 66.6 ms hosted pan failures below remain historical measurements of earlier code. See [current raw 2k](evidence/published/hosted-renderer/fixture-2000.json), [10k stress](evidence/published/hosted-renderer/fixture-10000.json), [production lifecycle/authenticated measurements](PUBLICATION_STATUS.md), and the [native GPU behavior review](GRAPH_NATIVE_GPU_REVIEW.md).

Frame percentiles above measure keyboard panning. Pointer/touch/keyboard zoom correctness has separate functional coverage; these pan percentiles do not establish a measured zoom-frame percentile. Browser-reported JavaScript heap is recorded, while total process and GPU memory remain unmeasured. The one scene bitmap is capped at 16 million physical pixels /64MB; that cap does not bound the whole browser.

The renderer retains every file and connection in the canonical snapshot. Above the target it offers an explicit **Explore scope** selector with shown/total file and connection counts. A selected island draws its files and internal connections; the full Files view and inspector retain the surrounding evidence. Fit all restores the complete view. This filtering does not change source selection, membership or layout identities. Selecting a file outside the current scope restores the full view.

Canvas circles and offscreen island backgrounds are culled against the viewport. Connection culling uses conservative curve bounds, retaining connections that cross the viewport with both endpoints outside. Semantic zoom suppresses background edges and labels with an explicit count notice; focused connections remain available. Layout workers are cancellable and terminate after success, failure, timeout or cancellation. A blocked worker or lost 2D canvas context exposes Files and retry while preserving source choices. Canvas2D uses `contextlost/contextrestored`; the development-only Sigma candidate separately exercises WebGL failure.

## Historical pre-cache production sample

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

The dedicated config starts a production server on4427 by default, uses one Chromium worker and no retries, and clears provider/App/database credentials. Set `GRAPH_BENCHMARK_PORT` for another isolated port. Reusing a known production server requires explicit `GRAPH_BENCHMARK_REUSE=true`; record that choice. The dedicated read-only CI workflow builds the app, installs Chromium and gates first-use≤2s, panp95≤33ms and observed startup tasks≤100ms for the212/2k target fixtures. Stress metrics remain visible and cannot silently certify capacity. CI stores numeric synthetic evidence for7days and has no deployment/provider credentials. Hosted success is linked in the current integrated evidence above; repository required-check settings remain separate evidence.

Functional regressions cover stress scope/count preservation, context/worker failures, camera anchors, resize/input interruption and worker reuse across source toggles. Pure bounds tests preserve crossing connections and prove filters leave canonical data unchanged. Release review must additionally consume DEL-05 churn results, run on the integrated commit and inspect a real GPU/browser matrix.

## Hosted pan-budget remediation

The first [hosted target run](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41710071078) failed the 2k/8k pan budget: p95 was66.6ms on a four-logical-CPU AMD EPYC Ubuntu runner, while first useful view248.1ms and observed startup task59ms passed. Local timing had not established hosted capacity.

The renderer now caches one padded bitmap of the complete current scene at its exact zoom/DPR. Panning within the padding translates those pixels instead of rasterizing every unchanged import curve and circle again. Data, layout, selection, hover, search, scope, zoom, resize, DPR and font changes invalidate the image. Drawing facts and detail thresholds are unchanged. The bitmap is capped at16million physical pixels (64MB backing); oversized viewports use direct drawing. Disposal/context loss/font invalidation release the backing buffer explicitly.

A new browser regression verifies that the2k scene assembles all8,000 curves, then pans without new curve operations or scene rebuilds while preserving shifted green-file pixels within2% tolerance. It also tests bounded backing bytes and search/zoom/context invalidation. Pure tests cover identity changes, scale, dimensions, DPR, translation limits and allocation refusal. Local strict production samples after this change recorded2k/10k panp9516.8ms and no pan long tasks; these remain diagnostic observations. The unchanged hosted budgets subsequently passed for the supported2k envelope, as linked in the current evidence above.
