# Rounds and finding history

Requires online endpoint/API token and a repository identity. Feedback changes endpoint finding state; it does not alter review policy or suppressions. Lineage needs a checked-out branch.

## rounds
`rio review --since-last` continues a branch lineage; `--reset-lineage` starts a new generation and requires --since-last. Repository key normalizes origin URL or falls back to directory name. Branch rebases preserve lineage. Endpoint owns rounds; losing the local cache does not reset them. Beyond rounds.cap, unresolved issues are summarized as reconsideration; report/fail_on still consider findings.

## answer
`rio feedback 8c1e4a9b --dismiss intentional --note "documented behavior"`. Reasons: fixed, wrong, intentional, irrelevant, style. Use an actual ID with at least 8 characters, unique among findings. Actor uses git user.email when set. Exit 0 recorded; 2 invalid reason/ID or missing endpoint/token; 3 rejected, missing, or ambiguous finding. Ambiguity lists matching identities.
Intentional/irrelevant/style are remembered while the enclosing symbol is unchanged. Wrong is not remembered; recurrence cites the earlier answer. Fixed findings that return are regressions. `rio review --show-remembered` lists remembered entries without changing exit policy.

## history
`rio findings --status dismissed --format json`; optional --rule RULE and --since RFC3339 timestamp. Status values open|fixed|dismissed. No endpoint exits 2. TUI F opens history. Repeated style/irrelevant dismissals can propose a suppression; nothing is suppressed until applied. Fix code for real defects; do not use a dismissal to claim a failed check ran successfully.
