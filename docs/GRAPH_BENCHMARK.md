# Graph renderer evidence

Measured locally on 2026-11-03. These samples establish the initial renderer's behavior on this machine; they are not a promise for every repository, GPU, browser, or display density.

## Renderer decision

The initial implementation uses a Canvas 2D renderer behind pure graph layout and camera functions. It draws data-driven file circles, overlap/focus rings, directed import connections and organic island boundaries. Island controls, zoom controls, minimap controls, tooltips and file inspection remain semantic DOM UI. The synchronized Files view exposes the same repository evidence without canvas hit testing.

Canvas 2D was selected for this implementation because the measured 2,000-file/8,000-edge target remains within the proposed interaction budget while supporting the required island visual treatment without a custom WebGL program. Sigma/Graphology remains an alternative for a later measured bottleneck; it is not a dependency of this renderer.

Layout is a bounded deterministic calculation. It has no continuing force simulation. The current calculation runs synchronously, with the CPU timing below; a layout worker is future hardening rather than a capability claimed by these results. Source toggles do not participate in placement, and new source-only files preserve surviving file coordinates. A changed context/grouping key explicitly resets layout and framing.

At more than 10,000 edges and overview zoom below 0.6, the renderer explicitly shows one third of background import lines and displays a detail-reduction notice. It retains every file node and the full underlying connection data. Focused connections and closer zoom reveal detail. Viewport culling avoids drawing offscreen circles.

## Conditions

- Windows x64; Intel Core Ultra 9 275HX; Node 24.22.1.
- Chrome 156.0.8078.4, viewport 1600 × 1000, device pixel ratio 1.
- Local Vite development build on loopback, with no GitHub or AI requests.
- Deterministic synthetic scale fixtures, seed 42. The 212-file visual fixture contains six islands and 235 connections; the scale fixtures contain twelve module islands.
- This is one local run for each browser fixture. Other development activity can affect wall-clock samples.

## CPU calculation

Each of 25 runs calculates layout, selected-file membership and immediate neighbors. This excludes browser rendering, network, repository ingestion and AI.

| Files | Connections | Median | p95 |
| --- | --- | --- | --- |
| 212 | 235 | 0.13 ms | 0.61 ms |
| 2,000 | 8,000 | 0.76 ms | 2.06 ms |
| 10,000 | 40,000 | 3.89 ms | 5.48 ms |

## Actual browser rendering

The browser tests assert green file-circle pixels on the main canvas, not only visible DOM island labels or the minimap. This also guards against a React StrictMode effect cleanup regression that previously prevented the remounted canvas from scheduling a draw.

Each panning sample alternates left and right so that the graph stays in view throughout the measurement. The first five frames are warmup; 86 subsequent animation-frame intervals are recorded. PerformanceObserver records browser long tasks during this window. Values include the browser's display scheduling interval and do not isolate only the drawing function's CPU duration.

| Files | Connections | Navigation to rendered circles | Median frame interval | p95 frame interval | Observed long tasks during pan |
| --- | --- | --- | --- | --- | --- |
| 212 | 235 | 394 ms | 16.7 ms | 16.8 ms | 0 |
| 2,000 | 8,000 | 380 ms | 16.7 ms | 16.8 ms | 0 |
| 10,000 | 40,000 | 661 ms | 16.8 ms | 33.4 ms | 0 |

The initial 2,000-file target was below the proposed 33 ms p95 frame interval in this sample. The 10,000-file stress case reached approximately 30 fps at p95, slightly above 33 ms. Navigation timings include HTML/module loading and cannot be presented as a separate network-independent layout time or a repository-analysis latency result. Selection latency, GPU memory and repeated long-session leak behavior need separate release evidence.

## Reproduce

From the repository root:

```powershell
pnpm exec vitest run packages/graph-core/src/index.test.ts
pnpm exec tsx packages/graph-core/src/benchmark.ts
$env:PLAYWRIGHT_CHROME='1'
pnpm exec playwright test tests/e2e/graph-performance.spec.ts --project=chromium --workers=1
```

The Playwright configuration starts the local server when needed. On a machine using Playwright's installed Chromium, omit `PLAYWRIGHT_CHROME`. Run performance tests with a single worker. The tests attach JSON measurements and rendered screenshots, and write PNGs into their test output directory. A later Playwright invocation may clear that transient directory.

The browser tests intercept only `/api/demo` to inject synthetic graph data. No debug fixture-loading endpoint is added to the application. The tests assert rendering and camera behavior; timing values are recorded as evidence rather than brittle machine-specific pass/fail assertions.

Eleven pure graph tests cover deterministic placement, exact PR/commit footprints and overlap, source-only file placement continuity, one-circle-per-file preservation at 10,000 files, island bounds, camera coordinate transforms, pointer-anchored zoom and incoming/outgoing neighbor focus.
