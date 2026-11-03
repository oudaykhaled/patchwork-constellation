# Contribution workflow

This repository contains a build plan. Implementation starts with Ready issues. A maintainer-selected license is required before accepting external code contributions.

1. Read one Ready issue's dependencies, acceptance criteria, verification and design.
2. Create an issue-specific branch; coordinate ownership of shared contracts.
3. Implement a complete scoped slice with meaningful correctness/user-flow tests and failure cases.
4. Open a PR linked to the issue. Describe behavior, validation and limitations; include screenshots/benchmarks where relevant.
5. Move to In review when evidence/checks are ready; Done only after accepted implementation is merged.

Backlog → Ready → In progress → In review → Done. Ready requires resolved prerequisites and testable criteria. Limits: three items In progress and five In review across the project. Record external blocks in the issue; planning completion does not close implementation tasks.

No credentials, private repository source, raw model prompts or machine-specific paths in commits. Use synthetic/authorized fixtures. Never execute analyzed repository code. Demo mode makes no provider/GitHub calls.

Data analysis owns file/source identity and evidence; the graph consumes these rather than recomputing truth. AI owns proposal/revision APIs; UX owns review controls. Coordinate schema changes in packages/contracts once scaffolded.

DEL-02 creates implementation checks. Missing CI is not evidence of passing tests. planning/issues.json preserves the reviewed plan; GitHub issues are the live execution record.
