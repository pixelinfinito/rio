# Spec Delta

## Purpose

A versioned ruleset evaluates functional usability, accessibility and visual consistency. It defines measurable probes and contextual UX criteria, grounds improvement recommendations in observed user friction, and lets explicit project requirements guide intended behavior.

## ADDED Requirements

### Requirement: Built-in ruleset
`modules/qa/rules/ui-v1.yaml` SHALL be a module of kind `ruleset` listing rules with `id` (`ui/<name>`, `mobile/<name>` or `ux/<name>`), `kind` (`probe` or `judged`), `category` (`functional`, `ux`, `style`, `accessibility`), default `severity`, a description and, for probes, `eligible` (element selector), `measure`, `threshold`, `exclude` and `scope` (`step` or `run`).

#### Scenario: Ruleset validates as a module
- **WHEN** the built-in ruleset is loaded
- **THEN** it validates against module-v1 with kind `ruleset` and every rule id is unique

#### Scenario: Shipped rule set
- **WHEN** the built-in ruleset is listed with `rio qa rules`
- **THEN** it contains at least the probes `ui/gradient-background`, `ui/accent-border-card`, `ui/raw-primitive`, `ui/spacing-scale`, `ui/type-scale`, `ui/low-contrast`, `ui/horizontal-overflow`, `ui/layout-shift`, `ui/console-error`, `ui/broken-image`, `ui/missing-focus-style`, the mobile probes `mobile/tap-target`, `mobile/viewport-meta`, `mobile/input-zoom`, `mobile/fixed-overlap`, `mobile/offscreen-content`, `mobile/text-truncation`, `mobile/hover-only`, and the judged rules `ui/no-feedback`, `ui/dead-end`, `ui/inconsistent-copy`, `ui/unreachable-action`, `ui/placeholder-content`, `ui/decorative-emoji`, `mobile/navigation-reachable`

### Requirement: Probe collection and finalization
After each step Rio SHALL evaluate every enabled probe against the rendered DOM and computed styles of the current cell and record candidates (rule, element role signature, element path, measurements, step, cell). `step`-scoped probes SHALL emit findings immediately; `run`-scoped probes SHALL be finalized once after every cell completes. Probe findings SHALL carry evidence level `static_proven`, the step screenshot, the DOM snapshot, the matched element paths and the measurements.

#### Scenario: Run-scoped probe finalized once
- **WHEN** `ui/gradient-background` candidates are recorded on three steps across two cells
- **THEN** one finding is emitted at run end with occurrences per cell, not one per step

#### Scenario: Step-scoped probe immediate
- **WHEN** a console error is logged during step 3 in `mobile` `light`
- **THEN** a `ui/console-error` finding is emitted for that step and cell without waiting for the run to end

### Requirement: Gradient and accent-border predicates
`ui/gradient-background` SHALL match elements whose computed `background-image` contains `linear-gradient`, `radial-gradient` or `conic-gradient` and whose bounding box exceeds 25 % of the viewport area, excluding images and canvases. `ui/accent-border-card` SHALL match elements with `border-left-width` of at least 3 px, a `border-left-color` differing from the other three borders, a `border-radius` or `box-shadow`, and a bounding box between 5 % and 60 % of the viewport.

#### Scenario: Accent-border cards
- **WHEN** a page renders four cards with a 4 px blue left border, grey other borders, an 8 px radius and 20 % of the viewport each
- **THEN** one `ui/accent-border-card` candidate group with four element paths is recorded

#### Scenario: Gradient hero
- **WHEN** a header's computed `background-image` is `linear-gradient(...)` spanning 40 % of the viewport
- **THEN** a `ui/gradient-background` candidate is recorded with the element path and the measured area

### Requirement: Raw primitive predicate
`ui/raw-primitive` SHALL match a `button`, `input`, `select` or `textarea` whose computed `appearance` is `auto` and whose border, background and font equal the user agent stylesheet values, on a page where at least 80 % of elements of the same tag do not.

#### Scenario: Raw primitive beside a design system
- **WHEN** nine buttons use the design-system class and one `<button>` renders with user-agent defaults
- **THEN** a `ui/raw-primitive` candidate names that element

### Requirement: Spacing and type scale predicates
`ui/spacing-scale` SHALL match, within sibling groups of three or more block elements, margins and paddings that are not multiples of the page's base unit (the most frequent spacing value) and differ from every other value in the group by more than 2 px. `ui/type-scale` SHALL match text elements whose computed `font-size` is used by fewer than 2 % of text nodes on the page and differs from the nearest common size by less than 2 px.

#### Scenario: Off-scale font size
- **WHEN** a page uses 14, 16, 20 and 24 px throughout and one label is 15 px
- **THEN** a `ui/type-scale` candidate names the label with `15px` and nearest `16px`

### Requirement: Contrast and focus predicates
`ui/low-contrast` SHALL match text whose WCAG contrast ratio against its effective background is below 4.5:1, or 3:1 for text of at least 24 px or bold text of at least 19 px. `ui/missing-focus-style` SHALL match focusable elements whose computed styles under `:focus-visible` equal their unfocused styles.

#### Scenario: Low contrast in dark mode
- **WHEN** in `dark` body text is `#777` on `#1a1a1a`
- **THEN** a `ui/low-contrast` candidate records the ratio 3.3:1 against 4.5:1

### Requirement: Layout probe predicates
`ui/horizontal-overflow` SHALL match when the scrolling element's `scrollWidth` exceeds the viewport width by more than 2 px. `ui/layout-shift` SHALL match a cumulative layout shift above 0.1 during a step, measured with `PerformanceObserver`.

#### Scenario: Horizontal overflow on a phone
- **WHEN** in `mobile` a table makes the page 420 px wide in a 390 px viewport
- **THEN** a `ui/horizontal-overflow` finding records the 30 px excess

### Requirement: Error and asset probe predicates
`ui/console-error` SHALL match a console message of level `error` or an uncaught exception during the step, excluding patterns in `rules.ignore_console[]`. `ui/broken-image` SHALL match an `img` with `complete` true and `naturalWidth` 0, or a CSS background image whose request failed.

#### Scenario: Broken image
- **WHEN** a product image URL returns 404
- **THEN** a `ui/broken-image` finding names the element and the failed request

### Requirement: Mobile probe gating and touch predicates
Probes with the `mobile/` prefix SHALL run only in cells whose viewport has `mobile: true` or touch. `mobile/tap-target` SHALL match interactive elements with a bounding box under 44×44 CSS px or within 8 px of another interactive element. `mobile/viewport-meta` SHALL match a page with no `meta[name=viewport]` or one without `width=device-width`. `mobile/input-zoom` SHALL match text inputs with a computed `font-size` under 16 px.

#### Scenario: Small tap targets
- **WHEN** a toolbar renders five icon buttons of 28×28 px with 4 px gaps in `mobile`
- **THEN** one `mobile/tap-target` finding lists the five element paths and measured sizes

#### Scenario: Desktop does not run mobile probes
- **WHEN** the same toolbar renders in `desktop`
- **THEN** no `mobile/*` finding is emitted for that viewport

### Requirement: Mobile layout predicates
`mobile/fixed-overlap` SHALL match `position: fixed` or `sticky` elements covering an interactive element's box or more than 30 % of the viewport. `mobile/text-truncation` SHALL match text clipped by `overflow: hidden` without `text-overflow: ellipsis`. `mobile/hover-only` SHALL match elements revealed only by `:hover` rules with no `:focus` or touch equivalent.

#### Scenario: Pay button under a fixed footer
- **WHEN** in `mobile` a fixed cookie banner covers the pay button's bounding box
- **THEN** a `mobile/fixed-overlap` finding names both elements with the step screenshot

### Requirement: Reachable mobile content
`mobile/offscreen-content` SHALL match text or interactive elements clipped by a non-scrollable ancestor or positioned beyond reachable scroll bounds. Normal document and nested scrolling SHALL be allowed. Focus-revealed skip links SHALL be excluded only after confirming they become visible and unclipped on keyboard focus.

#### Scenario: Normal scrolling is reachable
- **WHEN** a footer lies below the fold or a control is reachable through a nested scroll container
- **THEN** `mobile/offscreen-content` does not flag it, including after the document or container has scrolled

#### Scenario: Clipped or unreachable content
- **WHEN** a control is clipped by `overflow: hidden` or lies outside reachable scroll bounds, including a fixed control outside the viewport
- **THEN** `mobile/offscreen-content` records the control, clipping ancestor, affected axis and reachable bounds

#### Scenario: Skip link reveals on focus
- **WHEN** an offscreen link to an existing page anchor becomes visible and unclipped under keyboard focus styling
- **THEN** it is excluded from `mobile/offscreen-content` without firing application focus handlers; a link that stays offscreen is still reported

### Requirement: Minority test for style probes
Style probes (`ui/gradient-background`, `ui/accent-border-card`, `ui/raw-primitive`, `ui/spacing-scale`, `ui/type-scale`) SHALL be `run`-scoped and SHALL emit a finding only when, across all pages visited in the run, the matched elements are fewer than the rule's `threshold` ratio (default 0.2) of the eligible elements and at least `min_sample` (default 5) eligible elements were observed. The ratio, counts and visited pages SHALL be recorded with the finding.

#### Scenario: Consistent gradients
- **WHEN** every page section visited in the run uses a gradient background
- **THEN** no `ui/gradient-background` finding is emitted and the footer notes the rule's ratio was 1.0 against a 0.2 threshold

#### Scenario: Too few elements
- **WHEN** only three card-like elements were observed in the whole run
- **THEN** no `ui/accent-border-card` finding is emitted and the footer notes the sample was below `min_sample`

### Requirement: Severity and adoption of style probes
Style probe findings SHALL default to severity `info`, so they render in the QA section but never match a fail policy on severity. A project MAY list style rules in `rules.adopt[]` in `.rio/qa.yaml`; adopted rules SHALL use the rule's declared `severity` (default `warning`) and become eligible for `fail_on`. Adopted and non-adopted rules SHALL be distinguished in the footer.

#### Scenario: Not adopted
- **WHEN** `ui/gradient-background` fires and is not adopted
- **THEN** the finding renders at `info` and the QA fail policy does not match it

#### Scenario: Adopted
- **WHEN** `rules.adopt: [ui/accent-border-card]` and the probe fires on a `new` element
- **THEN** the finding renders at `warning` and matches the default QA fail policy

### Requirement: Judged rules produce hypotheses
Judged rules SHALL be named criteria with required evidence. A claimed violation SHALL produce a defect hypothesis; an improvement opportunity SHALL produce a recommendation candidate under the recommendation contract. Both SHALL carry the rule id and undergo verification. A defect hypothesis SHALL never be reported above `plausible` without a verifier quorum supported by a recorded browser artifact.

#### Scenario: Missing feedback
- **WHEN** the agent submits a form and sees no confirmation, error or state change within the wait budget
- **THEN** a `ui/no-feedback` hypothesis cites the before and after screenshots and the network log, and the verifier decides its level

### Requirement: Project overrides
`.rio/qa.yaml` `rules.disable[]` SHALL disable built-in rules by id or glob, `rules.add[]` SHALL add judged rules with `id` (`project/<name>`), `category`, `severity` and a description, and `rules.ignore_console[]` SHALL list console message patterns to ignore. Probes SHALL NOT be addable from the project file. Disabled, adopted and added rules SHALL be listed in the resolved profile and the footer.

#### Scenario: Gradient allowed by design
- **WHEN** `rules.disable: [ui/gradient-background]` is set
- **THEN** no `ui/gradient-background` finding is emitted and the footer lists the rule as disabled by the project

#### Scenario: Project rule
- **WHEN** `rules.add` declares `project/brand-voice` with a description
- **THEN** the agent receives it as a judged criterion and findings use that rule id

### Requirement: Built-in usability rubric
The ruleset SHALL include judged `ux/` criteria for task clarity, system feedback, error prevention, recovery, user control, consistency, recognition over recall, task efficiency and inclusive interaction. Each SHALL name its principle source and version, applicability, required evidence and examples. Nielsen usability heuristics and relevant WCAG 2.2 criteria SHALL be references; stylistic taste SHALL NOT be represented as a universal usability standard.

#### Scenario: Rubric content
- **WHEN** `rio qa rules` lists the UX rubric
- **THEN** it includes `ux/task-clarity`, `ux/system-feedback`, `ux/error-prevention`, `ux/error-recovery`, `ux/user-control`, `ux/consistency`, `ux/recognition`, `ux/task-efficiency` and `ux/inclusive-interaction`, covering discoverability, loading and empty states, actionable errors, preserved input, cancel or undo, familiar language, repeated entry, keyboard access and focus management

### Requirement: Classify context before recommending changes
UX assessment SHALL distinguish a demonstrated requirement violation from an improvement opportunity. Probe evidence SHALL prove only its stated measurement; a measured style or platform heuristic SHALL NOT alone prove user harm or accessibility nonconformance. Recommendations SHALL consider persona, task, applicable guidance and trade-offs, with uncertain impact labeled explicitly.

#### Scenario: Intentional brand styling
- **WHEN** a gradient probe matches but applicable guidance explicitly permits the brand gradient
- **THEN** QA does not recommend removing it solely for its appearance; separately evidenced readability problems remain assessable and the guidance does not silently change configured probe policy

#### Scenario: Touch guidance differs from conformance
- **WHEN** a target is smaller than the 44 px heuristic
- **THEN** QA reports the measured size and heuristic basis and does not claim a WCAG 2.2 AA failure without assessing the relevant criterion and its exceptions

#### Scenario: Platform-specific input heuristic
- **WHEN** Chromium detects an input font smaller than 16 px
- **THEN** the measurement does not establish that Safari zoom behavior was reproduced
