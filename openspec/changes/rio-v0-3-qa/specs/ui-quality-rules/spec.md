# Spec Delta

## Purpose

A versioned, built-in ruleset names the interface defects and generated-looking styling Rio looks for, separates what a deterministic probe can prove from what the agent judges, and lets a project adjust it.

## ADDED Requirements

### Requirement: Built-in ruleset
`modules/qa/rules/ui-v1.yaml` SHALL be a module of kind `ruleset` listing rules with `id` (`ui/<name>` or `mobile/<name>`), `kind` (`probe` or `judged`), `category` (`functional`, `ux`, `style`, `accessibility`), default `severity`, a description and, for probes, the computed-style or DOM predicate and its threshold.

#### Scenario: Ruleset validates as a module
- **WHEN** the built-in ruleset is loaded
- **THEN** it validates against module-v1 with kind `ruleset` and every rule id is unique

#### Scenario: Shipped rule set
- **WHEN** the built-in ruleset is listed with `rio qa rules`
- **THEN** it contains at least the probes `ui/gradient-background`, `ui/accent-border-card`, `ui/raw-primitive`, `ui/spacing-scale`, `ui/type-scale`, `ui/low-contrast`, `ui/horizontal-overflow`, `ui/layout-shift`, `ui/console-error`, `ui/broken-image`, `ui/missing-focus-style`, the mobile probes `mobile/tap-target`, `mobile/viewport-meta`, `mobile/input-zoom`, `mobile/fixed-overlap`, `mobile/offscreen-content`, `mobile/text-truncation`, `mobile/hover-only`, and the judged rules `ui/no-feedback`, `ui/dead-end`, `ui/inconsistent-copy`, `ui/unreachable-action`, `ui/placeholder-content`, `ui/decorative-emoji`, `mobile/navigation-reachable`

### Requirement: Mobile probes
Probes with the `mobile/` prefix SHALL run only in viewports with `mobile: true` or touch enabled, and SHALL carry their thresholds in the ruleset like every other probe.

#### Scenario: Mobile probe definitions
- **WHEN** the ruleset is listed for a mobile viewport
- **THEN** it defines `mobile/tap-target` (interactive targets under 44×44 CSS px or closer than 8 px to another), `mobile/viewport-meta` (missing or non-responsive `viewport` meta), `mobile/input-zoom` (text inputs with computed font size under 16 px), `mobile/fixed-overlap` (fixed or sticky elements covering an interactive target or over 30 % of the viewport), `mobile/offscreen-content` (content beyond the layout viewport), `mobile/text-truncation` (text clipped by `overflow: hidden` without an ellipsis) and `mobile/hover-only` (content revealed only by `:hover` with no touch equivalent)

#### Scenario: Pay button under a fixed footer
- **WHEN** in `mobile` a fixed cookie banner covers the pay button's bounding box
- **THEN** a `mobile/fixed-overlap` finding names both elements with the step screenshot

#### Scenario: Small tap targets
- **WHEN** a toolbar renders five icon buttons of 28×28 px with 4 px gaps in `mobile`
- **THEN** one `mobile/tap-target` finding lists the five element paths and measured sizes

#### Scenario: Desktop does not run mobile probes
- **WHEN** the same toolbar renders in `desktop`
- **THEN** no `mobile/*` finding is emitted for that viewport

### Requirement: Probes run at every step boundary
After each step, Rio SHALL evaluate every enabled probe against the current DOM and computed styles in the current viewport and color scheme, and SHALL emit one finding per rule and element group with evidence level `static_proven`, the step screenshot, the DOM snapshot and the matched element paths. Probes SHALL NOT depend on the harness or the model.

#### Scenario: Accent-border cards
- **WHEN** a page renders four cards whose computed `border-left-width` is at least 3 px with a `border-left-color` distinct from the other borders and a card-like box
- **THEN** one `ui/accent-border-card` finding with four element paths is emitted at `static_proven`

#### Scenario: Gradient background
- **WHEN** a section's computed `background-image` contains `linear-gradient` or `radial-gradient` spanning more than 25 % of the viewport
- **THEN** a `ui/gradient-background` finding is emitted with the element path and a crop of the screenshot

#### Scenario: Raw primitive beside a design system
- **WHEN** the page uses a design-system button class on most buttons and one `<button>` renders with user-agent default styling
- **THEN** a `ui/raw-primitive` finding names that element

### Requirement: Judged rules produce hypotheses
Judged rules SHALL be given to the agent as named criteria; an observation matching a judged rule SHALL be a hypothesis carrying the rule id and SHALL be settled by the verifier against the evidence. A judged rule SHALL never be reported above `plausible` without a verifier quorum supported by a recorded browser artifact.

#### Scenario: Missing feedback
- **WHEN** the agent submits a form and sees no confirmation, error or state change within the wait budget
- **THEN** a `ui/no-feedback` hypothesis cites the before and after screenshots and the network log, and the verifier decides its level

### Requirement: Project overrides
`.rio/qa.yaml` `rules.disable[]` SHALL disable built-in rules by id or glob and `rules.add[]` SHALL add judged rules with `id` (`project/<name>`), `category`, `severity` and a description. Probes SHALL NOT be addable from the project file. Disabled and added rules SHALL be listed in the resolved profile and the footer.

#### Scenario: Gradient allowed by design
- **WHEN** `rules.disable: [ui/gradient-background]` is set
- **THEN** no `ui/gradient-background` finding is emitted and the footer lists the rule as disabled by the project

#### Scenario: Project rule
- **WHEN** `rules.add` declares `project/brand-voice` with a description
- **THEN** the agent receives it as a judged criterion and findings use that rule id

### Requirement: Rules only where the project disagrees with itself
A style probe SHALL emit a finding only when its pattern is a minority in the application: a threshold in the rule compares the matched elements with the page's or run's dominant pattern, so a product that uses gradients everywhere is not flagged on every page. The threshold SHALL be part of the rule definition and reported with the finding.

#### Scenario: Consistent gradients
- **WHEN** every page section in the run uses a gradient background
- **THEN** no `ui/gradient-background` finding is emitted and the footer notes the rule's threshold was not met
