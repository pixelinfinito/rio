# Evaluation tooling

Requires python3 and Rio's eval/ source directory (current Rio checkout or RIO_EVAL_DIR). The installed binary alone cannot run this developer harness. Evaluation can invoke reviews/models and write datasets/results; use dedicated fixtures/accounts.

## noise
`rio eval noise --help` forwards harness options. Run known-clean PR cases to write noise adjudication skeletons and a summary. Preserve case identifiers, baseline classification, model routes, dates and budgets. Independently adjudicate findings; zero machine-reported issues alone does not establish quality.

## incidents
`rio eval import-incident PR_URL FIX_PR_URL --help` forwards options for turning a PR/fix pair into an incident case. Supply actual URLs and inspect the harness help before a live import. Arguments after the subcommand are forwarded to isolated Python scripts; the harness must exist locally.

## gates
Missing harness exits 2 with setup advice; Python launch failure exits 3; otherwise harness status is propagated. Release evidence and live council A/B gates are separate from passing unit tests. Current repository records do not establish a stable acceptance pass. Consult version-specific evidence rather than promoting implementation status into a quality claim.
