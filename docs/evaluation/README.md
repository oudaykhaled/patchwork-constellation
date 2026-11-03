# AI + Jev evaluation and release gate

The intelligence release gate is **blocked**. The checked-in report exercises actual grouping service code with authored provider doubles; it does not measure live model quality or establish that AI improves repository navigation. External AI stays unavailable without a valid reviewed live evaluation artifact, even when `AI_ENABLED=true` and keys are configured. Folder grouping and manual correction continue to work.

## Reproduce the credential-free gate

```sh
pnpm exec tsx packages/ai/src/evaluation/cli.ts --output=docs/evaluation/results.json
pnpm exec vitest run packages/ai/src/grouping.test.ts packages/ai/src/evaluation/evaluation.test.ts
```

The runner cannot access a live provider: its only transport is an injected synthetic response function with fixed destinations. The corpus is authored and versioned as `authored-holdout-v1`; six holdout cases cover monorepo, layered, feature, ambiguous shared, unsupported Rust and malicious/misleading paths. Two separate cases tune the confidence threshold. All 18 holdout files have hand-declared target membership. Goldens have **not** had the required human and independent review. The holdout digest is `f1fb3a6732b073e0fb5ee78f9c19bd615ac2c0d516bc827cc300d0c0a748e001`.

The integrated authored run gives 12/18 baseline memberships and 12/18 Jev-gated memberships. High mocked confidence cannot override tied or unsupported observed evidence: those suggestions retain the baseline for review. This is evidence of abstention behavior and harness arithmetic, with no observed membership gain on this corpus. Generative naming is reported separately: the present generative adapter names existing islands and does not assign files, so its membership result equals the baseline. Name usefulness and navigation quality require human assessment.

Metrics include membership agreement, review/abstention rate, accepted coverage, selective accuracy, evidence validity, repeated-run stability, five-bin reliability, expected calibration error and Brier score. Reliability uses accepted decisions only: confidence in an abstention cannot be scored against a preserved baseline membership. Model confidence is uncertainty metadata, not observed accuracy. Wall-clock numbers in `results.json` measure a local mock service run; mock token values are telemetry fixtures, and billed cost is `null`.

The deterministic safety gate checks unknown-ID rejection, zero traffic with external AI disabled, preservation of a manual override, unchanged canonical edges/source facts, and usable baseline on provider failure. A failing hard gate exits the runner unsuccessfully. A successful mock run still writes `status: blocked` and cannot serve as a release manifest.

## Authorized live collection

No live collection was performed in this work. It must use an authorized provider account after review of its current data terms and spend limits. The collector sends **only this synthetic corpus**, never a selected repository or credentials in output. Set the server-only `TYPESAFE_API_KEY`, `JEV_MODEL` (immutable Jev version), `OPENAI_API_KEY`, and `OPENAI_MODEL` (dated immutable model name). Supply verified current account prices in `EVAL_JEV_INPUT_USD_PER_MILLION`, `EVAL_JEV_OUTPUT_USD_PER_MILLION`, `EVAL_GENERATIVE_INPUT_USD_PER_MILLION`, `EVAL_GENERATIVE_OUTPUT_USD_PER_MILLION`, and a local usage stop `EVAL_MAX_COST_USD` greater than zero and at most one dollar.

```sh
pnpm exec tsx packages/ai/src/evaluation/live-cli.ts --authorized --data-terms-reviewed --provider-hard-cost-cap-confirmed --output=.tmp/live-evaluation.json
```

Collection is bounded to 20 total requests, 12,000 input characters per request, a 15-second per-request timeout and a 180-second overall deadline. It persists an unreviewed partial report even after a later request fails. The usage-based cost stop is checked **between** calls and does not guarantee a hard cap on a single call; a provider-account spending cap is required and explicitly acknowledged. Do not retry a partial paid run blindly. The collector uses existing validated adapter functions and records actual response models, decisions, labels, tokens, latency and operator-priced cost. It does not produce approved grouping, a passed release manifest or a navigation-quality claim.

Review all raw results against frozen goldens. Tune on the two tuning cases only, then freeze the threshold and evaluate the six holdout cases. Replay the final production pipeline and manual-override/failure checks, compare generated naming and Jev-gated results to baseline, assess calibration/selective accuracy and name usefulness, and reconcile usage against provider billing. Publish a redacted report with exact models and prompt/schema/policy/provider/pipeline versions. A second reviewer must inspect goldens, hard gates, costs, limitations and quality claims before rollout.

## Versioned approval and rollout

`evaluation-gate.ts` maintains predeclared targets: membership agreement gain of at least 0.05, accepted selective accuracy at least 0.90, review rate at most 0.50, expected calibration error at most 0.15, evidence validity/stability exactly 1, p95 live latency at most 15 seconds and cost per case at most $0.05. These are proposed release targets; the authored run does not prove live targets met. Change targets before the next holdout run with an explicit review, not to make a failed run pass.

A maintainer-approved manifest must match the frozen holdout digest, all `EVALUATION_VERSIONS`, exact configured/actual model names and the configured threshold. It must reference a report digest, record a live run over all six holdout cases, confirm all four hard gates, record metrics and independent review/data-terms timestamps, and expire within 90 days. The strict schema rejects unknown fields, unreviewed/mock artifacts, stale reviews, weak safety metrics or model-version mismatch. `AI_EVALUATION_MANIFEST` points to this local server file (maximum 64 KB); the browser sees gate status, never the file or credentials. This local approval artifact is an operator trust record, not a cryptographic attestation of human actions.

1. Keep `AI_ENABLED=false` while reviewing the corpus and configuring accounts.
2. Collect and evaluate, perform independent sign-off, and place the approved artifact outside source control.
3. Start with `rollout.phase: canary` and `percentage: 1`. Stable SHA-256 tenant buckets keep membership consistent; the gate caps canary at 10%. Observe abstention, failures, overrides, spend and data-policy exclusions.
4. Raise to at most 10% only after reviewing actual canary evidence. General release requires a new reviewed manifest with `phase: general`.
5. Roll back by setting `AI_ENABLED=false` and restarting. Existing/manual grouping remains available; no external request starts. Remove the manifest to block accidental re-enablement. In-flight cancellation is owned by the provider/request lifecycle.
6. On a model, prompt, schema, policy, corpus, provider contract or threshold change, invalidate the prior approval and caches, rerun tuning/holdout and hard gates, independently review, then restart canary. Never relabel old results for a new model.

The remaining acceptance gate for issue #26 is human corpus review plus a bounded authorized live evaluation, independent report review and observed canary evidence. This repository contains no live keys, fake human approvals or passed release artifact.
