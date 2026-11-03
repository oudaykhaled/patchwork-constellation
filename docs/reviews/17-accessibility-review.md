# Core review accessibility evidence

Scope: issue #17, the deterministic core journey before intelligence controls. Review the exact served commit and record the browser/assistive-technology versions below. This worksheet does not record a completed manual session. Automated findings and fixes are recorded separately in [the issue report](../issues/17.md).

## Session record

| Field | Actual observation |
| --- | --- |
| Date, served commit and artifact | Pending |
| Reviewer and method (human or interactive agent) | Pending; identify the method truthfully |
| OS, browser/version, viewport, native browser/text zoom | Pending |
| Screen reader/version, interaction mode and actual output source | Pending; speech viewer/generated speech is distinct from an accessibility-tree assertion |
| Repository, immutable context and three selected source IDs/SHAs | Pending; use authorized public/synthetic evidence, never publish private paths |
| Reduced-motion/high-contrast settings | Pending |
| Evidence references, failures and fixes | Pending |

A repeatable minimum is Windows with NVDA/Firefox or Narrator/Chrome, plus a keyboard-only browser session. VoiceOver/Safari is an additional platform check when available. Record unavailable combinations as untested; do not substitute one for another silently. Assistive-technology output must come from the running reader, not text synthesized from DOM attributes.

## Representative review tasks

For each task record the keys/actions, observed focus, exact useful announcement or output excerpt, outcome, evidence reference and any obstacle. Record observations rather than invented participant rates or completion times.

| Task | Expected observable behavior | Actual result |
| --- | --- | --- |
| Open the source picker using keyboard; select three real PRs | Current PR/commit mode and checkbox states are available; settled selected/unique/overlap totals match the pinned sources; closing returns to the launcher | Pending |
| Open Files; choose multiple-source overlap; inspect one result | Full path, island, observed change kinds, source labels/count and directed import totals are exposed. The full result set is reachable; the inspector close control receives focus | Pending |
| Explain one actual connection | Read the relation and direction, expand its evidence, identify the pinned evidence path/line/ref and distinguish a static import from proven runtime impact | Pending |
| Open that file's actual diff using keyboard | Activate the pinned per-file diff for one selected source; the opened destination identifies the expected file/comparison. A demo's explicit unavailable-diff message is honest but does not complete this task | Pending |
| Return to the review and close details | Prior selection/camera survive. Close returns focus to the persistent Files launcher or search, without a trap | Pending |
| Search and traverse suggestions using arrows, then Enter | Running reader announces a named expanded combobox, active path/island option and selected destination; DOM focus stays on the search while choosing | Pending |
| Dismiss search suggestions while a file remains inspected | Escape closes the suggestions and preserves the inspected file/focus; a later Escape can close details | Pending |
| Change selected sources; pan/zoom repeatedly | Completed review updates and selected-path changes are announced once settled; every animation, hover and camera frame is not announced | Pending |

Use the deterministic 212-file fixture for an additional exact-count check: three PRs produce 68 unique changed files and 14 overlap files. It has no actual GitHub diff. Do not count its illustrative content as the real-diff observation above.

## Applicable WCAG 2.2 AA checks

This is an evaluation checklist, not a blanket conformance declaration. Record pass/fail/not applicable/untested with evidence for each tested scope. Automated axe rules retain their incomplete findings for manual review.

| Criteria | Inspect | Current evidence boundary |
| --- | --- | --- |
| 1.3.1, 4.1.2 | Search has the combobox/listbox/active-option relationship; source modes, checkboxes, group membership and direction controls expose their states | Focused semantic/keyboard regressions; actual AT output pending |
| 1.4.1, 1.4.3, 1.4.11 | Text/symbol status beyond green, small metadata contrast, nontext/focus contrast and system forced colors | Axe covers its tagged subset and forced-color DOM journey; inspect canvas cues and incomplete results manually |
| 1.4.4, 1.4.10, 1.4.12 | Actual 200% text/browser zoom, 320-CSS-pixel reflow where applicable, and text spacing preserve selection/search/details/list/recovery | Native zoom and text-spacing observations pending; a small emulated viewport alone is not native zoom |
| 1.4.13 | Tooltip is dismissible, hoverable and persistent; Escape preserves unrelated review state | Existing actual-pointer tooltip tests; inspect visual and AT interaction |
| 2.1.1, 2.1.2, 2.4.3, 2.4.7, 2.4.11 | Keyboard paths work with visible unobscured focus, stable return and no trap at normal and enlarged sizes | Automated keyboard journeys plus manual enlarged/AT review pending |
| 2.5.8 | Essential controls meet 24-CSS-pixel target size/spacing or a documented exception; spatial file circles have an equivalent Files action | Inspect actual target geometry and alternatives; no general exemption claimed |
| 3.3.1, 3.3.2, 4.1.3 | Error recovery is identified, controls are labeled and settled updates are useful without repeated-frame announcements | Existing recovery/name/status tests; actual reader announcements pending |
| Product motion requirement | Reduced motion disables animated camera/layout transitions; keyboard focus remains stable | Existing reduced-motion regressions; interactive review pending |

## Acceptance readback

Current manual result: **not yet recorded**. Keep any unmet original screen-reader/task requirement explicit. An interactive agent session may be reported as such; it must not be labeled a human usability study. A completed subset never establishes whole-product WCAG conformance.

Sources: [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and the [WAI editable combobox keyboard/state pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
