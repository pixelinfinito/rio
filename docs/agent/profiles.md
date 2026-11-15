# Profiles and policy

Profiles define repository review behavior. Edit .rio/profiles/default.yaml deliberately and commit changes with the code; machine credentials/configuration belong in the user directory. Validate before review.

## selection
`rio profile list` shows built-in, personal and repository profiles and marks the default. `rio profile show rio/base` prints resolved YAML; `rio profile show strict --raw` prints authored YAML. `rio profile validate [NAME_OR_PATH]` exits 0 if valid, 2 if invalid, reporting YAML paths.
Default precedence: repository .rio/profiles/default.yaml, personal profiles/default.yaml, rio/base. Named profiles and explicit paths work with `rio review --profile strict`. Built-ins include base, openrouter, anthropic, security, critical and qa; list the installed binary for the exact set.

## inheritance
Use `version: 1`, a name and `extends: rio/base`. Maps merge; lists replace. Overriding steps requires listing every step you want to keep, including prepare and report and valid needs dependencies. `rio profile show NAME` checks the resolved result. Unknown modules, invalid options or dependency cycles stop validation before tools run.

## recipes
To require tools, extend rio/base and set `fail_on: {required_checks: [typecheck, lint]}`. To keep incomplete analysis from exit 4, set `fail_on: {incomplete: false}`; reports still show incompleteness. For coverage off, copy the resolved steps and set `coverage: false` under the rio/checks step's with block. Exclusions go in rio/prepare `with.exclude`; suppressions go in top-level suppress, with documented reasons. Suppression proposals provide validated entries; see suppressions.
Other controls: max_lines (default 1500), posture balanced, rounds cap 3/diff_only_after 1, publish never|ask|auto, always_human, security, council, models, budget and rules. Inspect schemas/module docs for exact keys using `rio docs modules` and `rio docs budgets`. Local agents/verification defer without an endpoint.
