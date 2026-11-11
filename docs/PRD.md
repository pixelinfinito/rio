# Rio — Product Requirements Document (PRD)

Nov 4, 2026 · @Marcos Lisboa

Rio is an open-source, risk-driven code review tool: a Rust CLI, a self-hosted Cloudflare backend, and YAML review profiles. Every reported issue is backed by evidence and has survived an independent attempt to refute it.

## Problem and opportunity

AI code review tools are judged by the noise they produce, and most produce too much. Typical failures: style nitpicks presented as defects, confident claims with no evidence, the same issue repeated on every push, bugs that already existed before the change, and no way to tell a deliberate behavior change from a regression. Teams turn the bot off within weeks.

The opportunity is a reviewer whose every finding is relevant to the change, supported by the code, and useful to the person fixing it. That requires three things current tools skip: knowing the intent of the change, comparing behavior before and after, and letting an independent verifier try to refute each finding before it is shown.

A second opportunity is ownership. Teams increasingly refuse to send source code to a third-party review service. Rio runs on the user's own Cloudflare account, with their own model keys, from an open-source codebase they can audit and extend.

## Goals and non-goals

**Goals**

1. Findings a reviewer trusts: precision above 80 % on the reference set before any merge-blocking is offered.
2. A terminal-first experience that is useful without any PR integration.
3. Review behavior defined by shareable YAML profiles, not hard-coded in the engine.
4. Self-hosting on a personal or team Cloudflare account in under 15 minutes via a wizard.
5. Extensible by the community: language adapters, agents, runners and profiles are all modules.

**Non-goals (v1)**

- Replacing human review or auto-merging.
- Auto-fixing code; Rio suggests, it does not commit.
- Supporting every language on day one. v1 ships TypeScript, Python and Rust (so Rio reviews its own codebase from the first release); others arrive through adapters.
- A hosted SaaS operated by the Rio project.
- IDE plugins (SARIF output lets existing IDE integrations consume results).

## Users and jobs to be done

| User | Job to be done | What Rio must do for them |
| --- | --- | --- |
| Individual developer | Catch my own mistakes before I open a PR | `rio review` on local changes in minutes, no backend required for deterministic checks |
| PR author | Know what a reviewer will flag, and fix it first | Intent summary, confirmed behaviors, findings with evidence and a suggested fix |
| Reviewer / maintainer | Spend review time on business logic, not on what a tool can prove | Deterministic layer handles types, coverage, dependencies; agents surface only verified regressions |
| Platform / DevEx engineer | Standardize review across repos without writing a bot | Team profiles in `.rio/profiles/`, shared endpoint, SARIF into existing dashboards |
| Security engineer | Make sure risky changes get a security pass | Triage rules that enable the security agent on sensitive paths; OWASP ASVS catalog |
| Open-source contributor | Add support for my language or framework | Adapter and agent modules with a documented contract and a validation command |

## Product principles

- **Deterministic before probabilistic.** Anything a tool can prove (types, coverage, known vulnerabilities) never goes through a model.
- **Evidence, not confidence.** A finding carries an evidence level (reproduced, statically proven, plausible); never a percentage.
- **Zero findings is a valid result.** There is no quota and no pressure to report something.
- **The terminal report is the product.** Publishing to a PR is explicit and opt-in.
- **Pluggable on three axes.** Review profiles, language adapters, and execution runners.
- **Repository content is data.** Comments, docs, PR descriptions and tool output are never instructions; policy comes only from versioned configuration.
- **Own your stack.** Your Cloudflare account, your model keys, your data.
- **Pre-PR review is the center of gravity.** The cheapest fix is the one made before anyone else reads the change, so `rio review` on local changes stays the primary surface and PR mode is a projection of it. The Claude Code team reports the same lesson in "How the Claude Code team does code review" (Anthropic, Oct 2026): review that reaches the author before the PR converges faster than review that lands as threads afterwards.
- **Findings must be answered.** A finding is a question to the author, not a verdict. Every posted finding is either fixed or dismissed with a reason, the reasons feed evaluation, and Rio never posts the same finding twice.

## Core experience: the `rio review` command

The CLI is a single Rust binary. `review` is the center of the product; everything else supports configuration and hosting.

```bash
rio review                          # working-tree changes
rio review --staged                 # staged changes
rio review --base origin/main       # branch vs. main
rio review --pr 123                 # review a pull request
rio review --profile security       # YAML profile to run
rio review --deep                   # extended budget
rio review --format json|sarif|md   # machine-readable output
rio review --publish                # post comments to the PR (opt-in)
rio review --since-last             # only what changed since the last run

rio init                            # wizard: Cloudflare account, deploy, first profile
rio profile list|show|validate
rio status <review-id>
rio feedback <issue-id> --dismiss <reason>   # fixed | wrong | intentional | irrelevant | style
rio doctor
rio eval import-incident <pr> <fix-pr>      # turn a revert or fix-forward into a labeled eval case
```

**What the user sees, in order:**

1. Intent summary — a short list of behaviors the change introduces, which the author can confirm or correct in the terminal.
2. Deterministic results within seconds: compile and type errors, lint groups, secrets, untested changed lines, dependency vulnerabilities.
3. A progress line while agents and the verifier run; the user can stop and keep the partial report.
4. Verified findings, one per root cause, each with location, trigger condition, impact, evidence level and suggested fix.
5. Plausible risks flagged for human judgment, clearly separated from defects.
6. A footer listing what could not be analyzed (missing adapters, unresolved references).

Every run is pinned to immutable versions: commits, or a content-hashed snapshot for local changes. Two explicit budgets exist, **fast** (a few minutes) and **deep**; the numbers live in the profile. Orthogonal to budget, a profile sets a **posture** (`critical-only`, `balanced`, `thorough`) that decides how many findings are worth the reader's attention. The three presets a user meets are combinations of the two: **Quick** is `critical-only` on the fast budget, **Standard** is `balanced` on the fast budget, and **Deep** (`--deep`) is `thorough` on the deep budget.

## Functional requirements

P0 = required for v0.2 (first usable release with backend); P1 = v0.3; P2 = later.

| ID | Requirement | Priority |
| --- | --- | --- |
| R1 | Review local, staged, branch and PR changes from the CLI | P0 |
| R2 | Infer the intent of the change and let the author confirm it | P0 |
| R3 | Run deterministic checks: compile, types, lint, secrets, diff coverage, dependency vulnerabilities. TypeScript: `tsc`, `eslint`, `vitest`/`jest` coverage, npm/pnpm/yarn lockfile audit. Python: `pyright`/`mypy`, `ruff`, `pytest` with `coverage.py`, `uv`/`poetry`/`pip` lockfile audit. Rust: `cargo check` (workspace-aware), `cargo clippy` when the project configures it, `cargo fmt --check` as a formatting group, `cargo llvm-cov` diff coverage, `Cargo.lock` audit against the `crates.io` OSV ecosystem | P0 |
| R4 | Build a lazy impact graph (changed symbols + N hops) for both versions of the code | P0 |
| R5 | Activate agents by triage rules defined in the profile | P0 |
| R6 | Correctness and intent agents | P0 |
| R7 | Independent verifier, able to run code and compare both versions; a quorum of same-class voters by default, a different model as an option | P0 |
| R8 | Evidence levels on every finding; configurable minimum, never below plausible | P0 |
| R9 | One finding per root cause; style only when it matches a project rule; old issues separated from regressions | P0 |
| R10 | YAML profiles with inheritance, validation and a published JSON schema | P0 |
| R11 | `rio init` wizard deploys to the user's Cloudflare account | P0 |
| R12 | Terminal, Markdown and JSON output | P0 |
| R13 | Contracts and security agents (OWASP ASVS catalog) | P1 |
| R14 | PR mode with GitHub App; comments edited, never duplicated | P1 |
| R15 | Stable finding identity and state across runs (open, fixed, accepted, false positive) | P1 |
| R16 | SARIF output | P1 |
| R17 | Feedback with reason; per-repo suppressions proposed, applied only with confirmation | P1 |
| R18 | Result cache keyed by hunk + context hash; `--since-last` | P1 |
| R19 | Full background graph with content-addressed per-file symbol tables | P2 |
| R20 | Data/concurrency, supply-chain and performance agents | P2 |
| R21 | GitHub Actions runner; community module registry | P2 |
| R22 | Large-PR handling: review by logical parts or recommend splitting | P2 |
| R23 | Optional merge-blocking, gated on demonstrated evaluation quality | P2 |
| R24 | Posture dial (`critical-only`, `balanced`, `thorough`) and a defect cap per review, so precision and recall are one explicit choice | P0 |
| R25 | Risk tier per change (`low`, `medium`, `high`) with reasons, plus `always_human` paths; exposed in JSON and SARIF for branch protection. Rio never approves | P0 |
| R26 | Owner guidance: `REVIEW.md`, `CLAUDE.md` and `AGENTS.md` read per directory and given to agents and the verifier as data; contradictions and stale lines are flagged | P0 |
| R27 | Review convergence: round cap per PR head lineage, diff-only re-review after the first round, class-level findings for repeated patterns, no re-posting of a posted finding | P0 |
| R28 | Standardized dismissal reasons recorded on the finding; auto-resolution when a later commit removes the code; reasons are the feedback signal | P1 |
| R29 | Security as its own step with its own posture and `fail_on` | P1 |
| R30 | Council step for selected findings: five members from different model families and vendors, one structured exchange round, deterministic aggregation | P1 |
| R31 | Noise measurement on known-clean PRs and incident import (`rio eval import-incident`) feeding the evaluation set | P1 |
| R32 | Browser QA from committed journeys: isolated app/browser/controller runtime, synthetic seed and service fixtures, mobile-first viewport and color-scheme coverage, masked screenshot/DOM/trace evidence, and independent verification. Immutable scoped `REVIEW.md` requirements guide execution and UX assessment, including passing flows. Evidence-backed UX recommendations carry principle references, actionable proposals and explicitly untested expected benefits; they remain separate from defect findings and fail policy. Local runs label unverified results; hosted evidence expires through scheduled per-run deletion. | P1 |

**Non-functional requirements**

- Fast mode completes within the profile's wall-time budget (default 10 min) for a 300-line diff in a mid-size TypeScript repo.
- Deterministic checks run locally with no backend when `--offline` is set.
- No source code leaves the user's Cloudflare account except to the model provider they configured.
- CLI and endpoint are version-paired; mismatches fail with an actionable message.

## Pluggable review profiles

The review workflow is not hard-coded. A **profile** is a YAML file that declares the steps, tools, agents, budgets and policies of a review; the engine on Cloudflare interprets it. Profiles live in `.rio/profiles/` (versioned with the repo) or `~/.config/rio/profiles/` (personal), can inherit from each other (`extends`), and can be published and shared.

User-facing requirements:

- `rio/base` ships with the project and is the default parent; community profiles such as `security`, `data-migrations`, `frontend`, `minimal` are published from a public git registry anyone can mirror.
- Every step references a module (`uses: rio/checks`). Modules of three kinds — adapters, agents, runners — share one packaging contract so a contributor writes one file to add a language, an agent or an execution backend.
- Triage rules select agents and budgets by what the change touches (`when: touches("**/migrations/**") then: enable(data-concurrency)`).
- `rio profile validate` checks schema, module references and budgets before any run; editors get autocomplete from the published JSON schema.
- Guardrails a profile cannot override: the verifier always runs, and the minimum evidence level cannot drop below plausible.
- A profile is resolved and stored with each review, so any result can be reproduced later.

## Self-hosting and onboarding

Rio does not run a central service. The open-source repository contains the Worker, Workflows and runner code; the CLI deploys them to the user's own Cloudflare account.

`rio init` wizard steps:

1. Connect the Cloudflare account via Wrangler OAuth or a minimal-scope API token (stored in the OS keychain).
2. Create or reuse the Worker, D1 database, R2 bucket and queue, prefixed `rio-`; run migrations.
3. Store model provider keys as Worker secrets (Anthropic, OpenAI, OpenRouter, or any compatible endpoint).
4. Choose a runner: Cloudflare Sandbox (zero config) or self-hosted (`rio runner serve` with a registration token).
5. Optionally register a GitHub App or GitLab webhook for PR mode, with read-code and write-PR-comment permissions only.
6. Copy `rio/base` to `.rio/profiles/default.yaml` or pick a community profile.
7. Run a smoke review against a sample diff.

Everything the wizard decides lands in `~/.config/rio/config.toml`, so `rio init --from config.toml` reproduces a setup non-interactively and in CI. `rio deploy` re-applies the Worker after upgrading Rio; `rio doctor` diagnoses permissions, missing resources and version mismatches.

A team can share one endpoint: the Worker supports multiple CLI tokens with scopes (review-only, profile admin).

## Success metrics

Acceptance rate alone rewards a tool that reports nothing, so recall is measured separately on a reference set of historical PRs with known bugs plus synthetic bug injection. Production incidents are the strongest labels: a revert or fix-forward PR is imported as a case (`rio eval import-incident`), and the full set is rerun on every prompt, tool or model change. The evaluation record template carries, per finding, the rounds it took the PR to pass, the author's response, and whether CI or a human would have caught the issue anyway.

| Metric | Target for v1.0 | How it is measured |
| --- | --- | --- |
| Precision | ≥ 80 % | Findings confirmed by humans on the reference set |
| Recall | above baseline tools on the same set | Known bugs found; synthetic mutations caught |
| False positives per agent | < 15 % | Dismissals with reason "false positive", per agent and evidence level |
| Fast-mode wall time | ≤ 4 min (300-line diff, mid-size repo) | p50 and p95 per run |
| Cost per fast review | known and shown to the user | Tokens and runner time per run |
| Verifier calibration | plausible findings that prove real vs. refuted later | Tracked per repo |
| Rounds to pass | median ≤ 2 rounds per PR head lineage | Rounds posted before a review has no open defects, per repository |
| Author-response ratio | ≥ 70 % of posted findings answered `fixed` | Share of findings dismissed `fixed` versus `wrong`, `intentional`, `irrelevant`, `style`; per repository, shown in the report footer |
| Harmful-change rate | 0 on known-clean PRs | Nightly run on PRs known to be correct; findings that would lead to a harmful change are counted |
| Counterfactual catch | reported per finding | Whether CI or a human reviewer would have caught the issue anyway, recorded in the evaluation record |
| Council disagreement rate | > 5 % (otherwise the step is removed) | Share of council-reviewed findings where members disagree on "real" or "introduced" |
| Council promotion accuracy | above the verifier-only baseline on the `plausible` bucket | `plausible` findings promoted to `reproduced` or `refuted` by the council, checked against later outcomes, A/B against verifier-only |
| Cost per council finding | known and shown | Members × rounds × experiments, tokens and runner time |
| Time to first review after `rio init` | ≤ 15 min | Wizard telemetry, opt-in |
| Retention | teams still running Rio after 30 days | Opt-in telemetry, self-reported |

## Release plan and open questions

| Version | Scope | Exit criterion |
| --- | --- | --- |
| v0.1 | Local-only CLI: deterministic checks, lazy reference graph, terminal report; TypeScript, Python and Rust; profile, finding and report contracts carry posture, rounds, risk tier and author response for later releases | Deterministic layer useful on its own in 10 real PRs |
| v0.2 | Cloudflare endpoint and `rio init`; profile engine with `rio/*` modules; intent and correctness agents; verifier quorum with blind re-derivation; posture and risk tier; review convergence rules; owner guidance; Sandbox and self-hosted runners | Precision ≥ 80 % on the reference set; known cost per fast review |
| v0.3 | Contracts agent; security step; PR mode with GitHub App applying the convergence rules to threads; finding state across runs; SARIF; feedback with standardized reasons; council step for selected findings; noise measurement and incident import | False positives per agent < 15 %; council beats verifier-only on the `plausible` bucket or is removed |
| v0.4 | Full background graph; data/concurrency and supply-chain agents; GitHub Actions runner; community module registry | Recall by bug injection above baseline |
| v1.0 | Community profiles, external language adapters, sophisticated `--deep` reproduction, optional merge-blocking | Demonstrated evaluation quality |

**Open questions**

- [ ] Third-party module format: YAML only, or YAML plus WebAssembly for adapters with their own logic?
- [ ] License: Apache-2.0 for everything, or AGPL for the endpoint?
- [ ] Where the reference evaluation set lives and how contributions are accepted without exposing private code.
- [ ] Actual Cloudflare Sandbox limits at development start; they decide how much of the pipeline fits without a self-hosted runner.
- [ ] Whether the first PR integration is GitHub only, or GitHub and GitLab together.
