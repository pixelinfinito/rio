# Spec Delta

## Purpose

Define what rio[bot]'s inline finding comments and per-lineage summary comment say and how they are laid out in GitHub-flavored Markdown. This lets a reviewer see what is wrong, how rio knows, and how to answer in one screen. The posting mechanics stay with PR publishing.

## ADDED Requirements

### Requirement: One glyph, one meaning
Comment bodies SHALL use emoji only with these meanings:
- 🔴 🟠 🔵 for error, warning and info;
- 🧪 for reproduced, 📐 for proven by a named tool or probe, ❔ for plausible;
- ✅ for fixed or passed, ❌ for a failed QA cell or trace step;
- 💤 for dismissed, ↩️ for regression, 💡 for advice;
- 🧭 for QA, 🌊 for the summary title.

✅ SHALL NOT appear on an open finding.

#### Scenario: Statically proven error
- **WHEN** an open `static_proven` error found by `tsc` is published
- **THEN** its comment shows `🔴` in the title and `proven by \`tsc\`` in the metadata line, and contains no ✅

### Requirement: Inline finding layout
An open inline finding comment SHALL contain, in this order:
1. A level-4 heading of the severity glyph and the message's first sentence.
2. One `<sub>` metadata line: severity, category, catalog item if any, proof, and `**matches \`fail_on\`**` when the finding matches the policy.
3. One paragraph joining the rest of the message, the trigger and the impact.
4. The fix.
5. The folded detail.
6. The reply footer.

It SHALL have no bold sub-headings.

#### Scenario: Layout
- **WHEN** an open finding with a trigger, an impact and a prose suggested fix is published
- **THEN** the body starts with `#### 🔴 ` and the headline, then one `<sub>` line, then one paragraph containing the trigger and impact, then the fix, and contains no `**When it happens**` or `**Impact**` headings

### Requirement: Proof wording
The proof SHALL read:
- `🧪 reproduced by experiment` for `reproduced`;
- `📐 proven by <tool>` for `static_proven`, naming the tool or QA probe;
- `❔ plausible` for `plausible`.

A refuted finding SHALL never be published.

#### Scenario: Plausible risk
- **WHEN** a plausible warning is published
- **THEN** its metadata line contains `❔ plausible` and no other proof glyph

### Requirement: Suggestion blocks
When a finding carries a `fix` whose line range lies within the diff hunk the comment is anchored to, the comment SHALL contain a GitHub `suggestion` block with the replacement covering exactly that range. Otherwise it SHALL show `suggested_fix` as prose, if present.

#### Scenario: In-hunk fix
- **WHEN** a finding anchored at line 42 carries `fix: { line_start: 42, line_end: 42, replacement: "..." }` and line 42 is in the hunk
- **THEN** the comment contains a `suggestion` block for line 42 and GitHub offers Commit suggestion

#### Scenario: Fix outside the hunk
- **WHEN** a finding's `fix` covers lines outside the anchored hunk
- **THEN** no suggestion block is emitted and `suggested_fix` is shown as prose

### Requirement: Folded detail
These SHALL each be folded into a `<details>` block with a summary that states its content:
- tool output or verification evidence ("How rio knows");
- other locations;
- catalog coverage.

A council block SHALL be open by default only when the council decided the finding. Each fold SHALL list members, families, round positions, abstentions and timeouts, and state that the decision follows the evidence tier, not a vote count.

#### Scenario: Other locations folded
- **WHEN** a finding has two other locations
- **THEN** they appear inside `<details>` whose summary reads `Same pattern in 2 more places`

### Requirement: Security finding comment
A security finding comment SHALL show:
- its catalog item in the metadata line;
- its trace as a numbered table of steps with locations, marking a missing step with ❌;
- each council experiment that ran, with its command and its outcome on head and base, in a code block.

The council fold SHALL list each member's role, family and per-round answer, marking changed positions.

#### Scenario: Reproduced access-control finding
- **WHEN** a security finding with a three-step trace whose middle step is missing, and a council experiment failing on head and passing on base, is published
- **THEN** the comment shows the trace table with `❌` on the missing step, the experiment's command with `head → failed` and `base → passed`, and the council table with families and both rounds

### Requirement: Reply footer
Every finding comment SHALL end with a `<sub>` footer followed by the hidden identity marker as the last line. The footer SHALL contain:
- the first eight characters of the identity;
- the rule id;
- the complete reply `/rio dismiss <id8> wrong`;
- the other reasons.

The reply SHALL work when pasted unchanged.

#### Scenario: Pasted reply
- **WHEN** a collaborator pastes `/rio dismiss 8c1e4a9b wrong` from the footer as a comment
- **THEN** the finding is dismissed with reason `wrong`

### Requirement: QA finding comment
A QA finding comment SHALL show:
- the base and head screenshots side by side when signed URLs are available;
- a viewport × color-scheme table marking passed and failed cells;
- the cause paragraph and the fix;
- the evidence links with their expiry date.

#### Scenario: Dark mobile failure
- **WHEN** a QA finding failed only on mobile/dark at step 4
- **THEN** the table shows `❌ **step 4**` in that cell and `✅ passed` in the other three

### Requirement: Fixed state
When a posted finding becomes `fixed`, its comment SHALL be edited to:
- `✅ **Fixed in \`<sha>\`**`;
- the struck-through headline;
- the original body folded under "Original finding", with the identity marker unchanged.

#### Scenario: Fixed edit
- **WHEN** a later round marks a finding fixed in `a7c41e2`
- **THEN** the comment starts with `✅ **Fixed in \`a7c41e2\`**`, the headline is struck through, and the marker is unchanged

### Requirement: Dismissed state
When a posted finding is dismissed, its comment SHALL be edited to:
- `💤 **Dismissed as \`<reason>\`** by <actor>`;
- one sentence on what rio remembers for that reason;
- the original body folded.

For `wrong`, the sentence SHALL say the answer counts toward calibration and the finding is re-reported if it reproduces after the code changes.

#### Scenario: Intentional dismissal
- **WHEN** `@ana` dismisses a finding as `intentional`
- **THEN** the comment starts with `💤 **Dismissed as \`intentional\`** by @ana` and states that rio won't report it again while the code is unchanged

### Requirement: Regression state
When a finding that was fixed in an earlier pull request reappears, its comment title SHALL start with `↩️ Back again:`. It SHALL include a table of the pull requests where it was first reported and fixed, ending with this pull request.

#### Scenario: Regression
- **WHEN** a finding fixed in #131 reappears
- **THEN** the title starts with `#### ↩️ Back again:` and the table lists #128, #131 and this PR

### Requirement: Summary verdict and scoreboard
The summary comment SHALL have:
- a title stating the verdict: `🌊 rio · <n> to fix before merge`, or `🌊 rio · Nothing to fix`;
- one `<sub>` provenance line with head, round, profile, duration and risk tier with reasons;
- a CAUTION alert when findings match `fail_on`, and a NOTE otherwise, stating that the check run stays neutral;
- a one-row scoreboard whose counts equal the title.

#### Scenario: Title matches scoreboard
- **WHEN** a round has three findings matching `fail_on` and one warning
- **THEN** the title reads `3 to fix before merge` and the scoreboard shows `3` to fix and `1` worth a look

### Requirement: Summary groups by action
The summary SHALL list findings in "To fix before merge" and "Worth a look" tables. Each row links to the finding's thread, or to its location when unanchored, and shows its proof. The QA section SHALL be a journeys × cells table. Recommendations, round history and what ran SHALL be folded. The footer SHALL list the available replies.

#### Scenario: Unanchored finding
- **WHEN** a finding cannot be anchored inline
- **THEN** its row appears in the summary with its location and no thread link

### Requirement: Comment size limits
Each comment body SHALL stay under 65,536 characters. The summary SHALL show at most 25 finding rows and 10 journeys, each followed by an "n more" row linking to the full report. Folded sections SHALL be truncated before visible ones.

#### Scenario: Many journeys
- **WHEN** a QA run covers 14 journeys
- **THEN** the table shows 10 journeys and a row stating 4 more with the report link

### Requirement: Edits keep identity
Re-rendering a comment for a later round or a state change SHALL keep its hidden marker byte-identical, so the publisher edits it in place. The summary SHALL remain one comment per lineage.

#### Scenario: Re-run
- **WHEN** a lineage's second round re-renders an unchanged open finding
- **THEN** the comment is edited with the same marker and no new comment exists
