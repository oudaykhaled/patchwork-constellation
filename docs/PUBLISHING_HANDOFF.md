# Publishing handoff

The complete local branch is `fix/31-issue-integration`; the final review bundle also provides `fix/31-issue-complete`. The remote branch with the integration name contains only part of an earlier source freeze and must not be treated as runnable. Do not force-push it.

Authentication is the current blocker: connector writes returned 403, Git Credential Manager lists no saved GitHub account, and verified GitHub web-editor tabs returned a generic commit error. The cause of the web-editor error is unknown.

The owner can authenticate using the installed Git Credential Manager in a local terminal: `git credential-manager github login --username oudaykhaled --browser`. Complete any sign-in/consent directly; never paste credentials into chat. Restoring repository write access to the connected GitHub integration is another option.

After access is restored, fetch and verify the remote branch state. The local integration descends from a514823, so an ordinary fast-forward push to `feat/constellation-mvp` can update existing draft PR #32. Use Git's normal non-fast-forward rejection; never force. Alternatively publish `fix/31-issue-complete` as a new branch and create a reviewed remediation PR. Rewrite its description around this complete implementation, link the final verification and preserve the 10 explicit partial issues.

Run the current hosted workflow and inspect its checks before calling CI complete. Only close issues whose original acceptance has been reviewed; do not close all 31 or move every Kanban card to Done from a local build. No merge, release, paid AI call, account registration or hosted deployment has been performed.
