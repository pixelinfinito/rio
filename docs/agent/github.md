# GitHub and PR reviews

Requires paired endpoint, registered GitHub App installed on the origin repository, and repository review policy. Publication writes GitHub comments/checks. PR policy comes from the merge base, not untrusted head changes. Fork execution requires a self-hosted runner.

## setup
`rio init --github-app` registers the App through GitHub's manifest flow; --github-org ORG chooses organization ownership. Install the App on intended repositories. `rio doctor` reports installation/endpoint readiness. App permissions include contents read (temporary write only for one thread resolve/unresolve GraphQL mutation), pull_requests write, checks write, metadata read, and organization members read where needed.
Commit .rio/profiles/default.yaml with models and desired `publish: never|ask|auto` to the base branch. rio/base publishes nothing. Open/push events trigger hosted review; maintainers can comment `/rio review` to request/reset review. Preparation (both commits, snapshot, graph) may take 15m before the review starts; that merge-base profile can allow up to 60m with `budget: {prepare: 30m}`.

## run
`rio review --pr 123` submits/polls the endpoint review and opens findings in an eligible terminal. `--format json` is suitable for agents. With publish ask, `--publish` or explicit interactive confirmation authorizes publication. Auto publishes eligible findings and summary; the `never` policy posts no comments or checks. Forks require maintainer escalation before publication. PR check conclusions are neutral; use policy-aware CLI exit codes for CI gating.

## recovery
Inspect report.publication for counts/URLs/reason. Exit 5 means publication failed after an otherwise passing review; do not rerun blindly without checking existing comments. Later rounds edit existing comments by identity rather than duplicating them. `/rio dismiss ID REASON [note]` accepts authorized collaborators and 8-character-or-longer unambiguous IDs.
`rio doctor --rotate` rotates webhook secret; `rio init --replace-private-key FILE.pem` updates App private key. Verify the new key before deleting the old one in GitHub. Missing installation: follow the diagnostic install URL; unknown endpoint protocol: update paired versions.
