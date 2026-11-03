# Native GPU behavior review

Issue #27 explicitly asks for manual GPU behavior testing beyond CI. The production renderer is Canvas2D; the Sigma/WebGL spike is a separate rejected candidate. A driver inventory or a software-rendered CI screenshot cannot establish the native browser's active rendering path.

## Recorded hardware and existing reference

[Native inventory](evidence/graph-04/native-hardware.json) was collected through Windows CIM on 2026-11-03: Windows 11 build26200, Acer Predator PHN16-73, Core Ultra9 275HX with24 logical CPUs and33,752,997,888 bytes RAM. Installed adapters are Intel Graphics driver32.0.101.8132 and NVIDIA RTX5070Ti Laptop GPU driver32.0.15.7713. These are installed adapters, not an assertion that either rendered the reviewed page. WMI's32-bit AdapterRAM field is deliberately omitted because it can truncate modern VRAM capacity.

The [hosted production benchmark](evidence/published/hosted-renderer/fixture-2000.json) is an independent software-rendered reference and passed the declared2k/8k budgets. Local interactive work during parallel development is behavior evidence, not an uncontended performance certification. [Capacity policy](GRAPH_CAPACITY.md) separates those measurements and keeps10k stress-only.

## Interactive procedure

Use the existing native browser and production demo. Keep data synthetic and providers disabled. Record the exact application commit, browser version, actual viewport and displayed native zoom. Do not change browser flags or system GPU assignments merely to obtain a preferred result.

1. Record the active renderer plus Canvas/compositing feature status from a maintainer's browser diagnostic record when available through the permitted review surface. A hardware model in Windows inventory is insufficient; software fallback must be labeled as such. If the review surface blocks browser internals, leave the backend unverified and request maintainer confirmation; do not bypass that policy through another automation surface.
2. Open the212-file/six-island demo. Confirm that file circles, island labels and connections appear, with68 directly changed files and14 overlaps for the default three-PR selection. Capture the graph in context.
3. Pan using pointer and keyboard; zoom at a file and Fit all. Check that circles, labels and edges remain aligned, that no persistent trails or blank regions remain after movement, and that the final view is stable.
4. Toggle sources, switch to commits, open and close a file inspector, resize, and navigate back to the overview. Check that changed/overlap counts and selected sources remain correct. Use an actual diff in the inspector; inspect its immutable source link without treating fixture content as instructions.
5. Exercise actual browser200% zoom with the graph focused. Verify that controls, search, Files and inspector remain reachable and that browser zoom remains separate from graph zoom. Reset native zoom afterward.
6. Open Files and navigate to a file using the keyboard. The Files path must remain usable independently of the canvas. Record any render/focus failures rather than inferring success from a screenshot.

For another native browser or hardware path, record a separate row instead of copying the Chrome outcome. GPU-loss/worker-failure injection and repeated lifecycle measurements retain their existing automated evidence; the interactive review does not claim a real physical GPU reset or process/GPU memory bound.

## Current review state

| Evidence | State |
| --- | --- |
| Native machine/installed driver inventory | Recorded; active renderer not established by this record. |
| Dedicated software-reference2k budgets | Passed, linked above; pan-only frame percentiles. |
| Native active GPU/backend screenshot | Unverified: the browser review policy blocked the internal diagnostic scheme. No workaround attempted. Maintainer confirmation remains required. |
| Native graph pan/zoom/resize/source/Files observations | Recorded in [the native review](NATIVE_ZOOM_REVIEW.md). These establish native platform behavior, with active hardware acceleration still unverified. |
| Native browser200% zoom | Actual Windows Chrome menu, dimensions/DPR and complete short-height review flow were observed. Safe application screenshots are linked in [the native review](NATIVE_ZOOM_REVIEW.md). |
| Accessibility/usability review | Excluded at the owner's explicit request on 2026-11-03; no conformance claim is made. |

Until the native inspection is recorded with its actual backend and observations, the last acceptance item of #27 remains partial. Root's actual200% menu observation is useful native-zoom evidence but does not establish the active GPU. This checklist is a runnable review artifact, not a completed GPU review or a reason to mark the issue Done.
