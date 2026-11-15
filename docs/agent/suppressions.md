# Suppression proposals

Requires endpoint/API token and repository. Apply writes .rio/profiles/default.yaml and marks the endpoint proposal applied; decline changes proposal state. Review evidence before mutation.

## list
`rio suppressions list --format json` shows proposals and evidence; --status proposed|applied|declined filters. Repeated irrelevant/style dismissals (default three in 90 days) can propose rule/directory suppressions. No automatic suppression follows from a proposal. The report footer and TUI S expose them too.

## apply
`rio suppressions apply PROPOSAL_ID` shows proposed YAML and asks confirmation. Only y applies; anything else keeps profile and proposal unchanged and exits 1. --yes intentionally bypasses the prompt for automation. The default profile is created extending rio/base when absent. Rio writes and validates a temporary sibling before atomic replacement; validation/write failure preserves original bytes. Commit the resulting profile change.

## decline
`rio suppressions decline PROPOSAL_ID --note "still useful"` records rejection and avoids proposing the entry for 180 days. Do not substitute a finding ID for a proposal ID. General failures: 2 usage/config/validation; 3 endpoint/repository/persistence. If profile application succeeds but endpoint update fails, inspect the profile and proposal before retrying; never assume a remote error means no local effect.
