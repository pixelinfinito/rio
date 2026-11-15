# Independent council

Council is hosted, opt-in, and sends finding evidence to allowlisted vendors. Implementation exists; the change's final/live A/B acceptance tasks remain pending. It does not turn agreement into proof.

## configure
rio/base keeps council disabled; rio/security and rio/critical enable it with placeholder members until configured. `rio init` offers council setup; --no-council skips it. --council-vendor accepts the deployment's vendor:family:model entry syntax (see command help). Profile council.vendors_allowed and deployment COUNCIL_VENDORS must both allow a vendor before a pack is built/sent. Self-hosted members require runner model capability.

## behavior
Triggers include plausible high-severity findings, verifier disagreement, high risk, deep and nightly runs. Members independently assess identical evidence, may request bounded experiments, and exchange one structured round. Default limits: two experiments, two rounds, minimum three members. A base-pass/head-fail experiment can reproduce; demonstrated protection can refute; remaining issues stay plausible with a human-readable note. Agreement count/learned weights cannot promote evidence tiers.

## inspect
Inspect per-finding council decision/tier, members/roles, experiments, note and partial markers plus cost. Missing/excluded/timed-out members must be visible. Audit records track vendors, model routes and pack hashes; do not log pack contents. Exceeding a budget cannot justify silently calling the council complete. Use profiles/budgets to tune it; consult live acceptance records before relying on quality claims.

<!-- schema-options:start -->
## option-fields
rio/council@0.1.0:
enabled: boolean; default=false
