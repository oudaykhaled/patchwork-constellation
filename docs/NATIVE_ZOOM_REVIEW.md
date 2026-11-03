# Actual native browser zoom observations

Observed 2026-11-03 through the Windows native Chrome UI and the running production app. Reviewer method: interactive agent; no human participant or assistive-technology result is implied.

Chrome was **156.0.8078.80** on the Windows machine in the [native inventory](evidence/graph-04/native-hardware.json). Chrome's own menu displayed **200%**. At native 100%, the maximized content viewport was 1707 x 842 with devicePixelRatio 1.5; at 200%, it was 853 x 421 with devicePixelRatio 3. This was actual browser zoom, not a viewport emulation or CSS transform. The initial keyboard attempt through tab automation changed graph zoom and was excluded; native Chrome input and the native zoom control established the browser-zoom result.

The served UI included the short-height fixes `6d540b8` and `aef3d7b` (built assets `index-D9I3Yb4i.js` and `index-B5G4FwC4.css`). Later disconnect, provider and staging changes are not relabeled as the build used for these observations. The corresponding compact-flow regressions cover 640 x 360, 800 x 450 and the observed 853 x 421 dimensions; those regressions remain layout tests, distinct from this native observation.

| Native 200% action | Observed result |
| --- | --- |
| Open source selection; remove PR #256; apply | 68 changed / 14 overlapping across three PRs became the authored 57 changed / 2 overlapping across two PRs. The picker was reachable and dismissible. |
| Search `session`; inspect `src/auth/session.test.ts` | Matching full paths and island names were visible. File inspector opened; close received focus. Context/import details and the honest unavailable demo diff state were present. |
| Open Files; filter multiple selected sources | All 212 snapshot files remained represented; the filtered set showed exactly two matching files with source labels and directed import totals. [Observed Files view](evidence/native-zoom/files-200.png). |
| Open the graph legend | The legend remained within the content viewport with its own scrollable explanation. It could be closed without page scrolling. [Observed legend](evidence/native-zoom/legend-200.png). |
| Focus graph; ArrowRight | The camera moved from x=379.05428 to x=850.98705 at the same scale. The canvas received focus; source selection remained unchanged. |
| Fit, navigation and inspector return | Navigation remained available at enlarged text; narrow available graph space reduced simultaneous spatial detail while Files retained complete data. No permanent blank/trailing render was observed. Minimap interaction retains its separate automated journey evidence. |
| Inspect page dimensions | `document.body.scrollHeight` was 421, equal to the 421 content height; page scrollTop was zero after the short-height fix. |
| Native 100% / 200% controls | Chrome's UI reported 100% and 200% separately from graph zoom; dimensions/DPR changed accordingly. |

These observations complete the missing actual native-zoom scenario for #5/#15. They do not independently prove a physical touch-device matrix, an active hardware GPU path, native GPU performance or WCAG conformance. The maintainer separately checked Chrome GPU diagnostics and reported **Hardware accelerated** on 2026-11-03; that source-aware confirmation is recorded under #27. The 212-file demo has illustrative diff content; actual public GitHub access/diff evidence is recorded separately under #18.
