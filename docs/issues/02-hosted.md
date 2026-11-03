# DEL-02 hosted deliberate-failure proof

Executed 2026-11-03 after authenticated publication became available. This supplements the earlier local-only [DEL-02 report](02.md). It verifies the original requirement to demonstrate an intentionally failing check on a real hosted PR; it is not a production or release approval.

[Temporary draft PR #33](https://github.com/oudaykhaled/patchwork-constellation/pull/33) compared base `feat/constellation-mvp` at `2f6a59174ed981b27957218890ee75c4d6b9019a` with proof head `9c6a3c2f8c9212e499a042e04487973995cef426`. The complete diff was one five-line file, `tests/ci/intentional-failure-proof.test.ts`, containing one clearly named deliberately failing Vitest assertion. No application or workflow change was added. The draft body prominently said **DO NOT MERGE**.

Local `pnpm check` passed format, lint, quality-runner tests and typecheck, then exited 1 at the deliberate assertion: 389 other tests passed and three optional database cases skipped. The build stage did not run after the failure.

## Hosted outcome

- [Implementation run 41712260638](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712260638), [check job 126183046159](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712260638/job/126183046159): **failure**, completed at `2026-11-03T20:25:13Z`. The actual hosted log identifies only the intentionally failing assertion; 389 tests passed, three skipped, and the check command exited 1.
- Format, lint, quality checks and typecheck each succeeded before `test` returned 1. No later `build` result appears, proving fail-fast propagation in the hosted runner.
- [Failure artifact 13268885309](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712260638/artifacts/13268885309) uploaded successfully. The ZIP is 309 bytes; its single `check.json` is **515 bytes**, below the 2 KB verification bound. Seven-day retention expires `2026-11-10T20:25:09Z`. The exact downloaded JSON is preserved as [ci-proof-check.json](../evidence/ci-proof-check.json), SHA-256 `4014bc28031a4eb98e551e20e54dd63b38d6fd7211defc13ca9f237956669305`.
- Strict inspection accepted only `schemaVersion`, `suite`, `success`, `results`; each result contains only `check`, `exitCode`, `durationMs`. It contains no stdout, environment, paths, test payload, source, provider prompt or secret. Raw hosted logs were not added to this repository.
- The actual job setup log reported **Contents: read** and **Metadata: read** for `GITHUB_TOKEN`. The executed workflow is the unchanged ordinary `pull_request` workflow with full action SHAs, `contents: read`, `persist-credentials: false`, and no deployment/provider secret reference. Repository API readback also returned default workflow permissions `read` and PR-review approval capability `false`. This does not assert that branch protection is enabled.
- For passing-check comparison, the unchanged product base's [check job 126182272849](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712031764/job/126182272849) at `2f6a591` completed **success**. Its browser job was still in progress at this report's readback; final all-job acceptance is owned by the integrator. The proof branch's [graph-budget workflow](https://github.com/oudaykhaled/patchwork-constellation/actions/runs/41712260692) separately completed success.

## Cleanup and scope

After the check failed and its artifact was downloaded/inspected, remaining proof browser work was canceled through the normal workflow cancellation API. The request was accepted at approximately `2026-11-03T20:26:12Z`; browser job `126183045590` completed **cancelled** at `20:27:42Z`, and the aggregate workflow completed **cancelled** at `20:27:43Z`. This does not erase the earlier completed check job's observed failure. See the [evidence snapshot](../evidence/ci-hosted-proof.json).

PR #33 was closed at `2026-11-03T20:26:14Z` **without merging**; API readback confirms `state:CLOSED`, `isDraft:true`, `mergedAt:null`. Remote branch `test/ci-failure-proof` remains at `9c6a3c2` for auditability. The deliberately failing test was never merged into the product branch and is not included in this evidence-only commit.

The original hosted deliberate-failure requirement is now evidenced. Final product workflow/browser results and issue/status changes are recorded separately by the integrator; no claim of all 31 issues complete follows from this proof.
