# rio[bot] PR comments — design handoff

Redesigns of the two comments rio posts on a pull request: the **inline finding comment** (on a diff line) and the **summary comment** (one per lineage, edited every round). Everything uses GitHub-flavored Markdown that renders today, so the work is a rewrite of `findingBody()` and `summaryBody()` in `worker/src/publish.ts`, not a new surface.

## Contents

| Path | What |
| --- | --- |
| `markdown/` | **The deliverable.** GFM bodies for each comment, ready to diff against today's output. `<SIGNED_URL>` and `<THREAD_URL>` mark values the publisher fills in. |
| `clean/` | Each comment rendered alone in GitHub chrome (@2x): before and after for the inline finding and summary, plus the security, QA and three lifecycle states. |
| `annotated/` | The same with numbered notes: red = problems today, blue = what the redesign changes. |
| `rio-pr-comments.pdf` | All sections in one document for review. |
| `board-overview.png` | The full canvas board. |

| Markdown | Image |
| --- | --- |
| `01-inline-finding.md` | `clean/inline-finding-after@2x.png` (before: `clean/inline-finding-before@2x.png`) |
| `02-inline-security-council.md` | `clean/inline-security-council@2x.png` |
| `03-inline-qa-finding.md` | `clean/inline-qa-finding@2x.png` |
| `04-state-fixed.md` | `clean/state-fixed@2x.png` |
| `05-state-dismissed.md` | `clean/state-dismissed@2x.png` |
| `06-state-regression.md` | `clean/state-regression@2x.png` |
| `07-summary.md` | `clean/summary-after@2x.png` (before: `clean/summary-before@2x.png`) |

## What's wrong today (publish.ts)

1. **Metadata before meaning.** Line one is `🔴 Error · Defect · ✅ Proven from the code · 2/3 verifiers agree` (`:393`).
2. **A green check on an error.** `static_proven` renders as “✅ Proven from the code”, and ✅ also means “fixed” (`:346`).
3. **No code, no fix button.** `suggested_fix` is prose, so GitHub never offers Commit suggestion (`:406`).
4. **A wall of bold sub-heads**: When it happens, Impact, Suggested fix, Council (`:404–417`).
5. **An unusable footer**: a 12-character id and `<fixed|wrong|intentional|irrelevant|style>` to retype (`:456`).
6. **Summary**: the title says nothing; a table with an empty header; ✅ on failing rows; QA as 20 bullet lines with an ISO timestamp; UX advice unfolded; no next step (`:540–580`, `:636–690`, `:775`).

## Glyph vocabulary — one emoji, one meaning

GFM has no text color: color comes only from emoji, alerts and links, so each emoji must mean exactly one thing.

| Glyph | Means | Used for |
| --- | --- | --- |
| 🔴 🟠 🔵 | error · warning · info | first glyph of a finding title |
| 🧪 | reproduced | an experiment fails on head and passes on base |
| 📐 | proven by `<tool>` | tsc, eslint, a QA probe — always named |
| ❔ | plausible | verified as possible, not proven |
| ✅ | fixed · passed | **never** on an open finding |
| ❌ | failed | a QA cell or a trace step |
| 💤 | dismissed | always with the reason and who answered |
| ↩️ | regression | was fixed, came back |
| 💡 | advice | UX suggestions, never blocking |
| 🧭 | QA | journeys × cells |
| 🌊 | rio | summary title only |

## Changes in `publish.ts`

1. **Title**: `#### ${SEV} ${headline}`; `plain()` already keeps the message's code spans.
2. **`proof(f)` replaces `EVIDENCE`**: reproduced → `🧪 reproduced by experiment`; static_proven → `📐 proven by <tool or probe>`; plausible → `❔ plausible`. Metadata goes in one `<sub>` line under the title, with `**matches \`fail_on\`**` when `policyMatches()`.
3. **One paragraph of why**: join the rest of the message, `trigger` and `impact`; drop the bold sub-heads.
4. **Suggestion block**: emit a ```` ```suggestion ```` only when a replacement exists for lines inside the anchored hunk; otherwise keep `suggested_fix` as prose.
5. **Fold**: verifier and council detail, tool output, other locations and catalog coverage go into `<details>`.
6. **Footer**: 8-character id (the minimum `/rio dismiss` accepts, `commands.ts:57`), rule id, the likeliest reply written out, the other reasons listed. Keep the hidden marker last.
7. **Lifecycle edits**: fixed → ✅ line plus struck title, original folded, thread resolved; dismissed → 💤 with reason, actor and the remembered rule; regression → ↩️ title with a PR history table.
8. **`summaryBody()`**: the title is the verdict (“3 to fix before merge” / “Nothing to fix”); one `<sub>` provenance line; CAUTION when `fail_on` matches (NOTE otherwise) stating the check stays neutral; a one-row scoreboard; findings grouped by what to do and linked to threads; `qaSummary()` becomes a journeys × cells table; recommendations, round history and what ran go into `<details>`; the footer lists the replies.

## Decisions needed

- **Schema**: `finding-v1` has only `suggested_fix: string`. Suggestion blocks need an optional, additive `fix: { line_start, line_end, replacement }`. Agents and adapters must fill it for the button to appear.
- **Limits**: a GitHub comment holds at most 65,536 characters. Keep the 25-row findings cap, show at most 10 journeys plus “n more”, and link the full report.
- **QA images**: base/head screenshots need signed, public-to-GitHub URLs (GitHub's image proxy fetches them). `qaEvidenceBody()` already notes cached copies may outlive expiry.
- **Dark mode**: designs are GitHub light. Check the scoreboard and tables in dark mode before shipping.

## Acceptance checklist

- [ ] No ✅ appears on an open finding anywhere.
- [ ] Every open inline comment fits on one screen with its `<details>` closed.
- [ ] A finding with an in-hunk `fix` shows **Commit suggestion**; one without falls back to prose.
- [ ] The reply in the footer works when pasted unchanged.
- [ ] Re-running a round edits comments in place (marker unchanged) and never duplicates the summary.
- [ ] The summary title states the verdict and matches the scoreboard counts.

The emoji in the images are canvas stand-ins (shapes and icons); GitHub renders native emoji.
