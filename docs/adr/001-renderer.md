# ADR-001: retain Canvas 2D for the measured Constellation envelope

Status: accepted for the 0.1.0 implementation; revisited on 2026-11-03 after a bounded Sigma candidate spike. This records the actual sequence: Canvas existed before this comparison. It does not pretend the candidate was measured before the initial implementation.

## Decision and boundary

Keep the browser's native Canvas 2D API in `ConstellationGraph` for the initial **2,000 files / 8,000 connections** envelope. Application release 0.1.0 owns this renderer; there is no external Canvas package version. `ConstellationGraphProps` is the application adapter boundary: positioned domain inputs and selected IDs enter, file/group callbacks leave. `packages/graph-core` owns deterministic layout and camera coordinate functions without React, Canvas, Sigma or Graphology dependencies. Source selections never become layout inputs.

Do not replace the renderer on the basis of a generic performance claim. An isolated, pinned **Sigma 4.0.4 / Graphology 0.26.0** implementation now proves that this alternative can consume the same layout, render both target fixtures, pick individual circles, focus directed imports, suppress labels, show overlap/selection rings and pan/zoom with synchronized islands. It remains an opt-in developer tool, with no production bundle or root installation dependency.

Canvas already provides the approved organic island treatment, hollow context circles, collision-bounded labels and semantic application controls. The bounded measurements below show both approaches can reach the required target on this machine. They do not establish a speed ranking: the Canvas sample used a production build and an earlier Chrome patch; the candidate sample uses Vite development and includes its deliberately simple overlay and full-list implementation. Migrating now adds WebGL/program lifecycle and coordinate synchronization cost without an established user benefit.

## Measured candidate

Recorded 2026-11-03T17:09:14Z; Windows x64, Intel Core Ultra 9 275HX, 24 logical CPUs, 33,752,997,888 RAM bytes; Chrome 156.0.8078.80; 1600×1000, DPR 1, seed 42. The renderer string reported `WebKit WebGL`; this identifies the API result, not a verified physical GPU model.

| Fixture | Script start → observed ready | Navigation → observed ready | Median / p95 pan interval | JS heap before / after pan |
| --- | --- | --- | --- | --- |
| 212 files / 235 imports / 6 islands | 392.4 ms | 490.0 ms | 16.7 / 16.8 ms | 13,590,333 / 15,737,769 bytes |
| 2,000 files / 8,000 imports / 12 islands | 334.9 ms | 403.7 ms | 16.7 / 16.8 ms | 42,156,705 / 41,392,815 bytes |

Each case records 86 frame intervals after five warmup frames and no observed long tasks during that short pan window. Native picking selected a known positioned file; 4 and 9 incident imports respectively entered focus. Both lists retained every file. Blocking WebGL yielded the complete 212-file list; retry remained usable while WebGL stayed blocked.

These are one-run observations with other development work on the host. The initialization number is an upper bound at test observation, not GPU first-paint timing. JS heap is neither GPU memory nor total process memory. A before/after pair does not prove leak freedom. Raw values and six screenshots are in [graph-01 evidence](../evidence/graph-01/sigma-results.json). [Reproduction instructions](../../tools/renderer-spike/README.md) include a separate type check and frozen install.

The published screenshots are text SVG envelopes ([design overview](../evidence/graph-01/212-overview.svg), [zoom out](../evidence/graph-01/212-out.svg), [zoom in](../evidence/graph-01/212-in.svg); [2k overview](../evidence/graph-01/2000-overview.svg), [zoom out](../evidence/graph-01/2000-out.svg), [zoom in](../evidence/graph-01/2000-in.svg)). Each embeds the exact original JPEG bytes as `data:image/jpeg;base64` and preserves its 1600×1000 viewBox. This is transport packaging only, with no pixel editing or JPEG re-encoding. The [manifest](../evidence/graph-01/screenshots-manifest.json) records original byte lengths and SHA-256 hashes; `node tools/renderer-spike/package-evidence.mjs verify docs/evidence/graph-01` verifies every decoded payload. Renderer measurements and the browser fallback proof are unchanged.

The existing [Canvas production measurements](../GRAPH_BENCHMARK.md) record a 2k/8k p95 pan interval of 16.8 ms and navigation-to-rendered circles of 202 ms on the declared earlier Chrome build. The 10k/40k stress sample reached 33.4 ms p95, slightly exceeding the proposed 33 ms target. Neither candidate sample certifies 10k as the supported production envelope. Selection latency, repeated-session memory, touch, more GPUs and the integrated release remain separate GRAPH-04 / DEL-05 gates.

## Island layering, transforms and clipping

The production Canvas draws the subtle screen-space grid first. Its world transform is `translate(viewport/2) → scale(zoom) → translate(-camera center)`, after the DPR backing-store transform. Islands, imports, circles and file labels share that world transform, so they cannot drift relative to one another. Semantic island buttons use the pure `worldToScreen` formula. The canvas and its host clip at the graph viewport; offscreen circles are culled and offscreen island buttons hidden. DOM controls and inspection never depend on pixel hit testing.

The Sigma spike evaluates a synchronized Canvas layer rather than a custom WebGL island program. A Canvas underlay paints organic outlines; a pointer-transparent overlay paints overlap/focus rings. Both repaint on Sigma `afterRender` / camera updates using **`graphToViewport`**, with the domain's downward Y mapped to Sigma's upward Y. Sigma owns graph normalization, camera ratio and aspect handling. A custom bounding box includes island extents; otherwise node-only auto-fit clips island labels and boundaries. Both overlay backing stores account for DPR and both are clipped by the same `overflow:hidden` surface. HTML island labels use the identical conversion. Camera rotation is disabled in this spike; enabling rotation requires an outline transform update and new alignment tests.

Use a synchronized Canvas layer if the candidate is later adopted: the bounded island count makes it simpler to maintain than a custom GPU island shape program. The overlay adds CPU work and lifecycle synchronization; the measurements include it. A future bottleneck may justify a WebGL contour layer, but this spike provides no measurement for that path.

## Failure and disposal

Production now exposes **Open file list** and **Retry graph** when Canvas is unavailable. Source selection and data remain outside the renderer. The retry reattaches sizing observation after an initial capability failure; a browser regression verifies that recovery produces drawn pixels rather than a blank default-size canvas. Context loss/restoration follows the same recovery path. DOM controls and the existing file inspector remain available.

The candidate catches initialization failure, retains its complete semantic file list, and offers retry. It calls Sigma `kill()` before replacing an instance and on page disposal. This is a technical spike, not a claim that comprehensive context-loss or long-session lifecycle testing is complete.

## Verified sources and licenses

The [official quickstart](https://www.sigmajs.org/get-started/quickstart/) identifies Sigma 4.0.4 and Graphology 0.26.0 and documents their pairing; v3 APIs are archived separately. The [official camera guide](https://www.sigmajs.org/how-to/interactivity/camera-viewport/) documents coordinate conversion and camera state. The [primitive schema](https://www.sigmajs.org/reference/primitives-schema/) documents curved paths and arrow extremities. Both installed candidate packages declare MIT, consistent with the [Sigma license](https://github.com/jacomyal/sigma.js/blob/main/LICENSE.txt) and [Graphology license](https://github.com/graphology/graphology/blob/master/LICENSE.txt), checked on 2026-11-03. These dependency licenses do not select a license for Patchwork's own code.
