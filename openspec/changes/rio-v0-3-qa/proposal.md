# Proposal

## Why

Rio reviews code, so it cannot see the class of defects that only exist in a running interface: a form that submits but shows no confirmation, a modal that cannot be closed on a phone, a button with no hover or focus state, a regression that only appears after a redirect, or styling that reads as machine-generated (gradient hero backgrounds, cards with a colored left border, unstyled primitives beside a design system). Those defects ship through every static review today. This change adds a QA engine: Rio runs the application, an agent walks committed user journeys in a browser as the intended user, and the result is evidence-backed findings about the changed part of the product or the whole product. It implements a new PRD requirement R32.

**Scope assumption.** Depends on the v0.2 endpoint, snapshot protocol, verifier quorum and self-hosted runner. Local runs need Docker on the developer's machine. The step is off in `rio/base` and on in a new `rio/qa` built-in profile. PR publishing of QA results depends on the GitHub App change (PRD R14); this change specifies the QA-specific comment, check-run and convergence behavior and nothing about the App transport itself.

## What Changes

- **Journeys are repository artifacts.** `.rio/qa/journeys/<name>.yaml` documents, validated by a new `schemas/journey-v1.json`, describe one end-to-end journey each: persona, preconditions, natural-language steps with expectations, success criteria, and the routes and source globs the journey covers. `rio qa init` runs the app once and generates the first set with the agent; `rio qa sync` proposes updates when the app changes; both write files for the developer to review and commit.
- **A shipped agent skill.** `rio qa init` writes `.rio/qa/skills/rio-qa/SKILL.md` and registers it for Claude Code (`.claude/skills/rio-qa`) and for Codex and other harnesses through an `AGENTS.md` section, so any coding agent working in the repository can author or update journeys in the same format Rio executes.
- **A launch contract.** `.rio/qa.yaml` declares how the app starts, its base URL, a readiness probe, seed and teardown commands, test personas whose credentials are named environment variables, viewports and color schemes. `rio qa init` detects defaults from `package.json`, a Dockerfile or Compose file and asks the agent to fill gaps once.
- **New step `rio/qa`** with options `enabled`, `mode` (`changed` | `full`), `harness` (`codex` default, `pi` optional), `baseline`, `max_journeys`, `max_findings`, `rules`, `viewports` and its own `fail_on`. It consumes the snapshot, the impact graph and the journeys, selects journeys whose declared coverage intersects the change (expanded through the graph), always includes `smoke` journeys, adds one exploratory pass over changed screens, and emits hypotheses for the verifier. `rio qa [--full] [--journey NAME] [--baseline]` runs it standalone.
- **One browser contract for every harness.** Rio starts Chromium with tracing, screenshots, console and network capture, and exposes it to the harness through the Playwright MCP server over CDP. Codex uses the user's OpenAI subscription or the Rio AI Gateway with an OpenRouter key; pi uses the gateway. Rio, not the harness, records evidence.
- **Built-in UI quality ruleset** `modules/qa/rules/ui-v1.yaml`: deterministic DOM and computed-style probes (gradient backgrounds, accent-border cards, raw primitives beside a design system, inconsistent spacing and type scale, low contrast, overflow, layout shift, console errors, broken images) and agent-judged rules (missing feedback, dead ends, inconsistent copy, unreachable actions). Projects disable or add rules in `.rio/qa.yaml`.
- **Evidence outside the repository.** Per step: screenshot, trace, DOM and accessibility snapshot, console and network log, and the harness transcript; optional video. Local runs store them in the review cache; hosted runs store them in R2 under the tenant and the report links time-limited signed URLs. Redaction and password masking apply before storage.
- **Findings use `finding-v1`** with new category `ux`, a `qa` block (journey, step, kind `functional` | `ux` | `style` | `accessibility`, viewport, evidence references) and a location that is the attributed source file when attribution succeeds or the journey file otherwise. Deterministic probe hits are `static_proven`; agent observations are hypotheses the verifier quorum settles against the recorded artifacts.
- **Runner changes.** A new `qa` job class with a QA runner image (Chromium, Playwright, Node, Codex, pi) and limits up to 30 minutes wall, network egress for model calls only, and streamed evidence upload. Without an endpoint, `rio qa` runs the same image in local Docker.
- **Report.** A QA section after security: journeys run with pass, fail or skipped, each with evidence links, then QA findings; footer counts and cost.
- **PR publishing through the GitHub App.** With `publish: auto` or confirmed `ask`, QA findings attributed to a source line become inline review comments on the PR diff, journey-attributed findings and all journey outcomes go into one edited summary comment, the failing screenshot is embedded by signed URL with its expiry, and a `rio/qa` check run carries a neutral conclusion unless the QA fail policy matches. The convergence rules (lineage, never re-post, auto-resolve, `/rio dismiss`) apply to QA findings by their identity. The transport is the GitHub App change; QA adds no publishing path of its own.
- **Metrics in `eval/`:** precision and recall on a fixture app with seeded UI defects, noise on the clean fixture, cost and wall time per journey.

Nothing is breaking. profile-v1 gains the `rio/qa` step options; finding-v1 gains category `ux` and the optional `qa` block; report-v1 gains the `qa` section; module-v1 gains kind `ruleset`; `journey-v1.json` and `qa-config-v1.json` are new.

## Capabilities

### New Capabilities
- `qa-journeys`: the journey document, its schema, coverage declarations, generation and update commands, and the shipped agent skill.
- `qa-environment`: the `.rio/qa.yaml` launch contract, detection, readiness, personas and credentials, and the runtime (local Docker or hosted runner) in which the app, the browser and the harness run.
- `qa-execution`: the `rio/qa` step and `rio qa` command, journey selection for changed and full modes, harness and browser contract, budgets, degradation and the shape of QA hypotheses.
- `qa-evidence`: evidence kinds, capture, redaction, storage locations, linking and retention.
- `ui-quality-rules`: the built-in ruleset, deterministic probes versus agent-judged rules, evidence levels and project overrides.
- `qa-publishing`: inline comment anchoring, the summary comment, embedded evidence, the `rio/qa` check run, and how convergence and dismissal apply to QA findings on a PR. Depends on the GitHub App change for transport.

### Modified Capabilities
- `review-profiles`: `rio/qa` built-in step options, the local execution subset, and the `rio/qa` built-in profile.
- `findings`: category `ux`, the `qa` block, and location attribution for findings observed in a browser.
- `review-report`: the QA section, QA evidence in the run record, and footer content.
- `verifier-quorum`: recorded browser executions count as runner execution artifacts, and voters may request one deterministic replay.

## Impact

- **Code**: `rio-cli` (`rio qa init|sync|run`, `rio doctor` checks for Docker and the QA image), `rio-core` (category, `qa` block, QA section renderers), `rio-profile` (step options, new built-in profile), `rio-engine` (local QA execution through Docker, selection), new crate `rio-qa` (journey model, selection, browser recorder, probes, harness drivers), `rio-runner` (`qa` job class, long jobs, evidence streaming), `worker/` (QA workflow step, R2 evidence keys, signed URLs, D1 `qa_runs`), `worker/Dockerfile.qa`, `modules/steps/qa`, `modules/qa/rules`, `modules/qa/skill`, `modules/profiles/qa.yaml`, `eval/qa`, `tests/fixtures/qa-sample`.
- **Contracts**: new `schemas/journey-v1.json` and `schemas/qa-config-v1.json`; additive changes to profile-v1, finding-v1, report-v1 and module-v1.
- **Network and data**: QA containers reach the model provider through the gateway; the app under test runs offline. Test credentials are environment variables named in the repository and supplied at run time. Screenshots and traces may contain application data, so they live in the private cache or private R2, never in the repository.
- **Cost**: bounded per journey and per run; a changed-mode run on a typical PR runs the smoke set plus the journeys the change touches.
