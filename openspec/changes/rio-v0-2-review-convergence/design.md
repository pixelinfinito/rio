## Context

The v0.1 change ships a local reviewer with stable finding identities and reserved keys for rounds and author responses. The v0.2 endpoint adds agents and a verifier, and with them the failure mode of every AI reviewer: noise accumulating across pushes. This design specifies how a review converges over a sequence of heads, how findings are answered, and how the answers feed evaluation. It follows the Claude Code team's published practice (Anthropic, Oct 2026): cap the rounds, re-review only the diff after the first round, flag the class rather than the instance, and treat every finding as a question the author must answer.

Constraints:

- Finding identity `blake3(rule_id | normalized_location | trigger_hash)` is fixed by v0.1 and is the key for "never re-post".
- PR mode (GitHub App) is a later change. Everything here must work for local lineages first and attach to PR threads without redesign.
- Policy comes only from the resolved profile; a PR comment can dismiss a finding but cannot change posture, budgets or rules.

## Goals / Non-Goals

**Goals:**

- A PR reviewed three times receives strictly less text each round, and never the same finding twice.
- Every posted finding has a terminal state with a reason, written to the finding and queryable per repository.
- The evaluation set grows from production: incidents become cases automatically, and clean PRs measure noise nightly.

**Non-Goals:**

- Auto-fixing or committing on the author's behalf.
- Learning per-user preferences; reasons feed repository-level and global evaluation only.
- Resolving threads on hosts other than GitHub in this change (GitLab follows the same design when its webhook lands).

## Decisions

### D1. Lineage identity

A lineage is keyed by `(repo_id, kind, ref)` where `kind` is `pr` with the PR number, or `branch` with the branch name for `--since-last` in the CLI. Each review in a lineage gets `round = 1 + number of earlier reviews in the lineage that posted at least one finding`; a review that posts nothing does not consume a round. `rounds_to_pass` is the round of the first review whose open defect count is zero, or null while open. Force-pushes keep the lineage: identity is by PR or branch, not by commit ancestry, because the author's experience is per PR. The endpoint is the single authority for lineage state. A reset (maintainer `/rio review`, or `--reset-lineage` for a branch) starts a new generation of the same key at round 1; losing a client's local copy never resets anything. Alternative: lineage by first-parent ancestry. Rejected because a rebase would start a new lineage and defeat the cap.

### D2. Round cap and the "reconsider" message

When `round > rounds.cap`, the report step still produces the full report (the CLI and `GET /report` show everything), but the publisher posts a single message instead of findings: the count of unresolved findings, the three highest-impact ones by title and location, and a request to reconsider the approach or split the change. The message carries a hidden marker so it is edited, not duplicated, on later pushes. A maintainer `/rio review` comment resets the lineage's round counter and posts normally. The cap applies to agent findings; deterministic findings (type errors, secrets) are always posted because they are facts about the head, not opinions that can fail to converge.

### D3. Diff-only re-review

For `round > rounds.diff_only_after`, prepare computes a second diff: previous reviewed head → new head. Agents receive that diff as the change under review, the previous round's findings with current states as context, the intent artifact (confirmed once, carried forward), and the same repository-wide tools. Deterministic checks and the graph still run on the full base → head change, because they are cheap and because classification against base is what separates regressions from pre-existing issues. The verifier re-verifies only hypotheses on changed code plus previously open findings whose location changed. Alternative: full re-review every round. Rejected: it costs the full budget and re-derives the same findings, which "never re-post" then suppresses, so the tokens buy nothing.

### D4. Class-level findings

After root-cause grouping, consolidation groups findings sharing `rule_id` and `trigger_hash` across different symbol paths. When a group has more than `class_threshold` members (consolidation option, default 3), it is replaced by one class-level finding: identity `blake3(rule_id | "class" | trigger_hash)` (an explicit exception to the location-based identity, recorded in the `findings` delta), `locations` listing every instance, message rewritten as "N occurrences of <pattern>; fix the pattern, for example at <first location>". Suppressing the class suppresses the instances. The class finding's `author_response` applies to all instances. Deterministic checks already do this per function; this extends it across the diff.

### D5. Never re-post

The publisher keeps, per lineage, the set of posted finding identities with the comment or thread id. Before posting, it removes identities in the set and instead edits the existing comment with the new state (`open`, `fixed`, `dismissed: <reason>`). The report footer counts held-back findings. The set survives force-pushes because the lineage does. Identities are stable under line shifts by v0.1 design, so a moved but unchanged finding is correctly held back.

### D6. Findings are answered

A posted finding carries a lifecycle `status` (`open`, `fixed`, `dismissed`) separate from its regression `state`, which keeps its v0.1 meaning; `status` never changes `state` or `fail_on`. A dismissal's reason is `author_response.reason`. Transitions:

- the next review in the lineage is `complete`, re-assessed the location (covering checks succeeded; for agent findings, verification finished without incomplete votes), no longer produces the identity, and the location's code was changed or removed → `fixed` (auto-resolution; the thread is resolved with "fixed in <sha>"). A partial or incomplete review never auto-resolves, because absence there is missing evidence, not a fix;
- the next review no longer produces the identity but the code is unchanged → remains `open` with a note that the finding did not reproduce, because a vanished finding on unchanged code is a verifier calibration signal, not a fix;
- `rio feedback <id> --dismiss <reason>`, `POST /v1/findings/{id}/feedback`, or a `/rio dismiss <id> <reason>` comment by a collaborator → `dismissed(reason)`, and `author_response = { reason, actor, at, note }` is written to the finding and to `feedback`.

The reason enum is `fixed | wrong | intentional | irrelevant | style`. `fixed` is accepted as a manual reason for cases auto-resolution cannot see (fixed in another PR). Dismissals from non-collaborators on fork PRs are ignored and logged.

### D7. Reasons as the feedback signal

Aggregations computed by `eval/` and shown per repository: author-response ratio = `fixed / (fixed + wrong + intentional + irrelevant + style)` over posted findings with a response; `wrong` per agent and evidence level feeds the false-positive metric (replacing the earlier `false_positive` reason); `intentional` per agent feeds intent calibration (the intent agent should have listed the behavior); `irrelevant` and `style` counts per rule and category feed the category floor and the posture defaults. No per-user model is built. Suppressions proposed from reasons still need approval (v0.1 TRD rule).

### D8. Noise measurement

`rio eval noise` selects known-clean PRs from the reference set: merged PRs where no later commit on the default branch reverts them or touches the same hunks within 90 days. It runs the current pipeline on each and writes an adjudication skeleton, extending the harness's existing verdict files: a human adjudicator labels each finding `harmful` (acting on it would introduce a bug or remove intended behavior), `neutral` or `useful` with a rationale. The harness never infers a label. The harmful count is the headline; the target is zero. A scheduled job on the maintainer's machine (a systemd user timer, or cron) runs it nightly against the pinned provider profile, using the endpoint configuration already saved in `~/.config/rio`; no endpoint URL, token or provider key is stored in the repository or its public hosting. Runs are kept privately outside the repository (default `~/.local/share/rio/noise/<date>/`), scanned for leaked credentials, and pruned after 90 days. A harmful count above the last release's, or any unadjudicated finding, blocks the release.

### D9. Incidents become cases

`rio eval import-incident <pr> <fix-pr>` fetches both PRs, checks that `fix-pr` touches files changed by `pr` (otherwise it refuses with the overlap report), and writes an `eval` case: input = `pr` base and head, expected = one finding whose location is the fix PR's hunks' enclosing symbols and whose trigger is taken from the fix PR's description (editable), labeled `incident`. The case records `counterfactual_catch: ci | human | none`, asked interactively or passed with `--caught-by`, so the metric "would CI or a human have caught it anyway" is available per case. The CI regression gate runs incidents, historical PRs and mutations together; a prompt, tool or model change that lowers precision, recall or the incident recall is dropped.

### D10. Local lineages in the CLI

`rio review --since-last` on a branch uses the `branch` lineage kind. The endpoint holds the lineage; the CLI keeps a versioned copy under `<cache>/lineages/<branch-hash>.json` (previous reviewed head, posted identities, round, generation) for offline display, included in the cache's age and size pruning. A missing copy is refetched; `--reset-lineage` requests a new generation. The terminal report applies the same rules: diff-only context after round 1, held-back findings counted in the footer, and the "reconsider" message at the cap. This makes the rules observable before any PR integration exists, which keeps pre-PR review the center of gravity.

## Risks / Trade-offs

- [Round cap hides a real new defect introduced late in a lineage] → deterministic findings are never capped; the "reconsider" message names the highest-impact open findings; the full report remains available in the CLI and API; a maintainer resets the counter.
- [Diff-only re-review misses a regression caused by the interaction between an old and a new hunk] → the graph and checks still run on the full change; the verifier re-verifies open findings whose location changed; `rounds.diff_only_after` can be raised per profile.
- [Class-level merging hides a genuinely different instance] → merging requires equal `rule_id` and `trigger_hash`, which already encode the message's semantic content; `class_threshold` is configurable; instances remain listed as locations.
- [Auto-resolution marks a finding fixed when the code was merely moved] → identity is location-normalized, so a moved finding is still produced and stays open; only an identity that disappears together with a change to its code resolves.
- [Reason enum is too coarse] → `note` carries free text for humans; the enum is what evaluation aggregates; adding a value is an additive schema change.
- [Known-clean selection is wrong (a silent bug was never fixed)] → the noise metric is a lower bound by construction and is reported as such; cases can be excluded with a reason.
- [Incident import leaks private code into a shared eval set] → cases live in the repository's own `eval/` by default; contributing to the public set is a separate, explicit step (PRD open question).

## Migration Plan

Additive. The migration adds `lineages` (with a generation counter) and a new `findings` table (tenant, review, lineage and generation, identity, regression `state`, lifecycle `status`, `round`, `first_posted_in`, `author_response_json`, location), populated from each lineage review's report when it finishes; the endpoint previously kept findings only inside report artifacts. It adds `feedback` with the fixed reason enum, converting any draft values (`false_positive` → `wrong`, `known` → `intentional`); no production data exists before this change. profile-v1 and report-v1 are unchanged; finding-v1 gains the optional lifecycle `status` and now emits the reserved keys. The CLI lineage file format is versioned and may be deleted at any time (it is cache).

## Resolved Questions (2026-11-06)

- `rounds.cap` counts every review that posted at least one finding, including rounds with only `plausible` risks, as in D1.
- When `max_lines` was exceeded, the "reconsider" message proposes a split along the prepare step's logical parts; otherwise it uses the generic reconsider-or-split request.
- A local `branch` lineage lives until the review cache's normal age and size pruning removes it; a branch recreated with the same name within that window resumes its lineage.

## Carried-over v0.2 acceptance

The archived `rio-v0-2-verifier` change left two acceptance tasks open: the pinned verifier-versus-single-verifier precision/recall comparison and the hosted Linux/macOS/Windows CI matrix. They move here unchanged in substance. The comparison extends the same `eval/` harness this change grows (noise runs, incidents, regression gate), so it is specified in `eval/noise-and-incidents` and gates v0.2 acceptance independently of the convergence features.
