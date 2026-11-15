# Continuous integration

CI must install project dependencies/tools before running Rio and choose the intended diff. Hosted mode needs endpoint credentials; local mode works without them. Do not expose credentials to untrusted fork jobs. Review may execute project code.

## run
Fetch enough Git history for the merge base. `rio doctor --base origin/main --format json`; `rio review --base origin/main --format json > rio-report.json`. For offline local execution add --offline and apply external network isolation if required. CI disables TUI; explicit --format makes output stable.
Save the exit code while uploading artifacts, then exit with it. Exit 0 does not guarantee every optional check ran; enforce fail_on.required_checks for required typecheck/lint. Avoid `|| true` as a final gating policy. Profile comes from the reviewed setup; PR mode applies merge-base policy at the endpoint.

## sarif
`rio review --base origin/main --format sarif > rio.sarif`. Upload with GitHub's code-scanning SARIF action and security-events write permission where supported. Preserve the review exit code even when upload runs after failure. SARIF 2.1.0 contains invocation errors for exits 2/3 and no results for those failures. No output is guaranteed after parser errors or second interrupt; check file existence/validity before upload.

## limits
Shallow clone: fetch deeper history; partial clone: hydrate objects before review. Bare repositories/conflicted selections are refused. Submodules are gitlinks, LFS stays pointers. Hosted checks without vendored/installed dependencies can skip; running hosted review does not install dependencies automatically. PR App check runs are neutral and should not replace explicit fail_on-based gating.
