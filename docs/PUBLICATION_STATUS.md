# Published implementation and verification

Updated 2026-11-03. The complete implementation is published on **feat/constellation-mvp** in [PR #32](https://github.com/oudaykhaled/patchwork-constellation/pull/32). The application code is at **2f6a59174ed981b27957218890ee75c4d6b9019a**; subsequent evidence commits change documentation only. The PR remains unmerged. GitHub CLI 2.103.3 authenticated as the owner through the Windows keyring and completed ordinary fast-forward pushes. Product GitHub App deployment configuration remains separately required for that product capability.

There are **22 conditional closure candidates and nine partial issues**, with no implementation issue closed and no beta approved. The partial list is **#5, #15, #17, #18, #21, #26, #27, #28 and #31**. Their original native zoom, human accessibility/task review, live provider evaluation, manual GPU or deployed staging/release requirements remain. Current [acceptance audit](ISSUE_REMEDIATION.md) and [machine-readable verification](publication-verification.json) retain these limits.

## Hosted checks

The [implementation workflow](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712031764) passed at application `2f6a591`: **389 automated tests**, three opt-in skips, type/lint/format/build and **185 browser checks with 16 intentional skips** across Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2 on Linux. The [dedicated graph budget workflow](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712031705) also passed. Its checkout is PR merge **76aa8e4aba5227dbc28efedb211d8180627e7e5c**; Git tree equality with application `2f6a591` was independently verified. Later documentation-only check reruns are visible in the PR checks.

The first hosted attempt exposed a genuine 2k pan failure (p95 66.6 ms) and a WebKit test race with opening inspector autofocus. The renderer now caches one bounded padded scene bitmap for translations, invalidating it for changed scene facts, scale, viewport, DPR, fonts or context. Files, edges and proposed budgets are unchanged. The tooltip regression now waits for intended opening focus before testing a later user focus. Trace recording was removed from reference timing; local A/B did not establish tracing as the original cause, so that change is not credited as the renderer fix.

Hosted reference conditions: Ubuntu, AMD EPYC 7763, four logical CPUs, about 16.8 GB RAM, Node 24.22.2, Chromium 156.0.8078.4, 1600×1000 / DPR 1, SwiftShader software rendering, one test worker, loopback synthetic fixtures, trace/video off. All supported 2k budget assertions passed, including **pan p95 16.7 ms**, first useful pixels 243.7 ms after data and the startup-task limit. Raw intervals, renderer/browser metadata and results are in [hosted evidence](evidence/published/hosted-renderer/fixture-2000.json). This is recorded CI reference evidence, not a human physical-GPU certification.

## Post-fix local retention and authenticated view

The production application at `2f6a591` passed all three **1,000-toggle** fixtures. Worker/global-listener counts remained stable and bounded post-GC heap/DOM samples stayed within diagnostic tolerances. These detect gross retention; they do not prove every browser/GPU allocation is leak-free. The bitmap alone is capped at 64 MB; total process/GPU memory is not claimed bounded by that number.

| Files / edges | Selection p95 | Hover p95 | Hosted pan p95 | Local retained GC heap delta |
| --- | --- | --- | --- | --- |
| 212 / 235 | 27.7 ms | 8.9 ms | 16.7 ms | 1,083,036 B |
| 2,000 / 8,000 | 27.1 ms | 11.7 ms | 16.7 ms | 948,576 B |
| 10,000 / 40,000 | 27.3 ms | 13.9 ms | 16.8 ms | 477,640 B |

The 20-sample controlled authenticated BFF run passed both test cases, including denied session/CSRF/repository controls, and measured **149.3 ms p95** from authenticated body arrival to real worker-ready file pixels. GitHub transport and data are controlled; no real App key, browser-response interception, WAN/private-account verification or paid model call is implied. Local renderer diagnostics ran concurrently with a separate deliberate-failure check; their activity note is corrected explicitly, while metric values are preserved. The dedicated hosted reference above is separate.

The 10k graph remains **stress-only**: cached pan is fast in this window, but initial hosted rendering still exceeds the 100 ms task target. Complete counts, scope controls and Files remain. See [capacity policy](GRAPH_CAPACITY.md). The 22 actual PostgreSQL checks and native backup/restore reports remain valid for the unchanged storage/database implementation; these UI/harness follow-ups did not rerun that database suite. Earlier [local verification](FINAL_VERIFICATION.md) and artifact rollback records identify their own source commits.

## CI failure proof and publication state

[Temporary PR #33](https://github.com/oudaykhaled/patchwork-constellation/pull/33) demonstrated a single intentional assertion failing the hosted check after the preceding format/lint/quality/type checks passed. Its exact 515-byte allowlisted artifact was inspected. The PR was closed **without merging**, and remaining proof browser work was canceled after the check failure was recorded. The failing test was never part of the product branch. [Detailed proof](issues/02-hosted.md). This satisfies issue #2's formerly missing hosted failure demonstration; workflow permissions were read back as Contents/Metadata read. No branch-protection activation is claimed.

The old remote fix/31-issue-integration at `630bbe9` remains an incomplete historical web-editor upload. The complete active code is in feat/constellation-mvp/PR32. No force-push, merge, hosted deployment or issue closure was performed. Intelligence remains gated off until its live/human acceptance is actually established.
