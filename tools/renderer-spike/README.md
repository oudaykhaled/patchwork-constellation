# Renderer candidate spike

This opt-in developer tool evaluates Sigma **4.0.4** with Graphology **0.26.0** against the same deterministic layout and fixtures consumed by the application. It is excluded from the application bundle and the root dependency installation. Its independent frozen lockfile records transitive versions. Both candidate packages declare MIT licenses; see their installed `LICENSE.txt` files.

From the repository root, after the normal root installation:

```powershell
pnpm --dir tools/renderer-spike install --ignore-workspace --frozen-lockfile
pnpm exec tsc --noEmit --project tools/renderer-spike/tsconfig.json
$env:PLAYWRIGHT_CHROME='1' # omit for Playwright's installed Chromium
pnpm exec tsx tools/renderer-spike/measure.ts
```

The runner owns and closes its local Vite server on **4366** and launches an isolated browser. It writes JSON and three zoom screenshots per fixture to `.tmp/renderer-spike/`. It checks object counts, actual Sigma picking, focused connection attributes, complete file-list availability, and a WebGL-unavailable/retry case. It samples 86 frame intervals after five warmup frames while alternating camera pan. It records JS heap observations, not total browser/GPU memory. Start and observation timestamps are not an isolated first-paint measurement.

For manual inspection:

```powershell
pnpm exec vite --config tools/renderer-spike/vite.config.ts
```

Open `http://127.0.0.1:4366/?files=212` or `?files=2000`. Scroll/drag the candidate graph or use the semantic controls. Click a file to focus its imports. The Files button exposes every fixture file. Closing the server stops this separate spike; it does not change the running application.

`main.ts` is the candidate adapter: it maps the shared positioned `GraphData` into a private Graphology instance and uses Sigma for drawing, camera and picking. Domain counts, layout and grouping stay in `packages/graph-core` / `packages/fixtures`. Canvas overlays subscribe to Sigma rendering/camera state and use `graphToViewport`; they never reproduce Sigma's normalization math. A production migration would extract this adapter into the application and reuse its existing controls and accessible list rather than shipping this test UI.

See [ADR-001](../../docs/adr/001-renderer.md) and the [recorded evidence](../../docs/evidence/graph-01/sigma-results.json).
