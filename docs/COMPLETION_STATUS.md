# Current completion decisions

Recorded 2026-11-03. [PR #32](https://github.com/oudaykhaled/patchwork-constellation/pull/32) is merged. This follow-up supplies the remaining implementation fixes, actual public GitHub smoke, and disposable hosted-staging deployment/rollback tooling. Final run results and issue dispositions are linked from the [GitHub board](https://github.com/users/oudaykhaled/projects/5/views/1) and the follow-up pull request; an uncompleted run is not a pass.

The owner explicitly excluded accessibility tickets and review work on 2026-11-03. Issue #17 is closed **not planned**, not certified accessible. Accessibility-only acceptance portions of the mixed browser/release issues are excluded by that scope decision. Implemented behavior and automated regression checks remain. No screen-reader, human usability or whole-product WCAG conformance is claimed.

## Completed implementation and evidence

- Actual native Chrome 200% zoom and compact review flow: [observations](NATIVE_ZOOM_REVIEW.md). Short viewports no longer acquire an artificial page scroll that clips the legend.
- Public repository access: [six live checks](issues/18-public-github-smoke.md) use the real BFF, worker and GitHub HTTP transport, independently verified against pinned GitHub tree/commit data and genuine diff text. No App/private-repository deployment is inferred from public-mode verification.
- Account disconnect now cancels and fences all same-owner work, removes same-owner sessions and purges stored analysis/grouping data while preserving another owner. [Actual PostgreSQL evidence](evidence/data-09-staging-local.json).
- Disposable staging deploys distinct verified archives behind one stable HTTP address, uses DML-only serving credentials after explicit migrations, restores a native database backup, and switches traffic back to the distinct prior archive. [Deployment procedure](STAGING.md) and [local observed rehearsal](issues/31-staging-local.json). A hosted run is required before recording hosted acceptance.
- Provider smoke rejects mutable/drifted model versions; live evaluation collection now shares the production evidence builder and has bounded offline replay with separate tuning/holdout data. [Provider evidence](issues/21-followup.json) and [evaluation review packet](evaluation/REVIEW.md).
- The TypeScript 7 command uses Microsoft's compatibility package for the existing TypeScript 6 compiler API; action updates remain pinned to verified full commit hashes.

The combined local checks passed **399 tests**, five intentional opt-in skips, formatting, lint, type checking and production build. Those are local results, not a substitute for the current hosted browser, reference-renderer and staging runs. Historical performance measurements retain their original source/build identifiers.

## External functionality gates

**#21 and #26 remain blocked by provider configuration and live evaluation.** Presence-only inspection found no configured TypeSafe or OpenAI key. A candidate Jev pin is not an evaluated model. The original human-reviewed goldens, authorized live results, actual costs and independent report review must be obtained before enabling intelligence. Accessibility exclusion does not waive these AI functionality requirements. [Configuration](issues/21.md) and [review steps](evaluation/REVIEW.md).

**#27 now has native interaction evidence and maintainer-confirmed acceleration.** Native Windows Chrome pan/zoom, source selection, search, inspector, Files and resize/zoom behavior were inspected. After checking Chrome's GPU diagnostics, the maintainer replied **Hardware accelerated** on 2026-11-03. This is owner-reported diagnostic evidence, separate from the installed hardware inventory and automated software-rendered CI. Exact active adapter, native GPU timings and GPU memory were not measured. The automated diagnostic access block was respected.

The deliverable remains a **deterministic preview** while live intelligence is blocked. A completed preview staging rehearsal is not an intelligence-enabled beta, persistent public hosting, or production traffic deployment.
