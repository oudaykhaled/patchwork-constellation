# Publishing status

GitHub CLI 2.103.3 is authenticated as the owner using Windows keyring storage. The complete application is published on feat/constellation-mvp in [PR #32](https://github.com/oudaykhaled/patchwork-constellation/pull/32). An ordinary fast-forward push replaced the earlier MVP tree; no force push or merge was performed. Git uses a repository-scoped HTTPS helper and an 8 MiB upload buffer, which resolved the failed chunked upload. Credential values are not stored in this repository.

The remote fix/31-issue-integration branch is only a historical partial web-editor upload. Use the active PR branch for complete source. Current source/test/acceptance details are in [publication verification](PUBLICATION_STATUS.md).

The intentional-failure proof PR #33 was closed unmerged. No implementation issue was closed. Keep the nine explicit partial issues open for their human/live/deployed requirements, and review candidate issues before closure. Intelligence stays disabled until its original evaluation gates pass. Publishing authentication does not configure the product GitHub App deployment.
