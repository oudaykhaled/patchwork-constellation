# Pending human and live evaluation review

This is a review packet, **not an approval**. No human participant, independent sign-off, live model result or observed canary is asserted. Issue #26 stays open until its original evidence exists. Automated agents can inspect code and arithmetic; they cannot supply the requested human golden review or navigation benefit assessment.

## Before any collection

1. A human architecture reviewer checks the six holdout fixtures in `packages/ai/src/evaluation/corpus.ts`: monorepo, layered, feature, ambiguous/shared, unsupported language and malicious names. For each file, record whether its declared membership is justified by the supplied evidence or should instead be ambiguous. Record disagreements without consulting or tuning against model outputs. Freeze revised goldens and their digest **before** the next live run. The current authored digest is `f1fb3a6732b073e0fb5ee78f9c19bd615ac2c0d516bc827cc300d0c0a748e001`.
2. Record the reviewer, independent reviewer, UTC review times, repository commit, holdout/tuning digests and all `EVALUATION_VERSIONS`. Have the independent reviewer check golden reasoning and the proposed targets; different strings in a manifest alone do not demonstrate independent human review.
3. The provider account owner records approved immutable Jev and generative versions, current terms/retention, actual account prices, rate limits and an account-enforced spending limit. Keep keys only in local server configuration. Do not paste them into review documents, chat or source control. The 2026-11-03 presence audit found no configured credentials/model values; no live run was made.
4. Record the threshold-selection rule and the complete-evidence threshold of 1 before observing holdout predictions. Use only the two tuning cases to choose confidence. Review the synthetic outbound metadata preview; no real repository content is needed for this corpus.

## Execute and inspect

Use the bounded [collection and offline replay commands](README.md). Save exact immutable capture IDs and SHA-256 digests of captures and replay reports. The replay checks corpus/tuning/version/evidence bindings and actual output IDs; it never enables AI. A failed or incomplete run is not a quality pass. Obtain separate authorization before a second paid collection for repeated membership stability.

Compare baseline, naming-only and Jev-gated membership, review reasons, abstention, selective accuracy, reliability bins, calibration error and latency. Naming-only membership equals baseline by design; do not count labels as reassigned files. Reconcile usage estimates to actual provider billing. Assess label usefulness and navigation with human reviewers attempting concrete file/module identification tasks; record tasks, observations, errors and disagreements without inventing a participant count or success rate.

Link deterministic and integrated failure/override/disabled-transfer tests separately from live results. Human reviewers check that rejected suggestions preserve a usable baseline and canonical file/import facts. If a target fails, publish the failure and retain disabled intelligence; changing a target requires a new preregistered evaluation.

## Sign-off and rollout

The independent reviewer verifies frozen goldens, report digests, split integrity, actual response models, calibration, cost reconciliation, limitations and all hard-gate evidence. Record approval or refusal with its scope and time. Only actual approval can be reflected in a maintained release manifest. It must match the exact current version tuple and expire within 90 days.

An approved canary starts at 1% and is capped at 10%. Record observed failures, abstention, manual overrides, exclusion policy and spend. Rehearse disable/rollback and retain the deterministic baseline. General release requires a separate reviewed manifest. A human-approved deterministic preview does not satisfy this intelligence gate.
