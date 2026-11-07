# Spec Delta

## MODIFIED Requirements

### Requirement: Finding model
A finding SHALL have: `id` (stable identity), `rule_id`, `category` (`defect`, `risk`, `security` or `ux`), `evidence_level`, `severity` (`error`, `warning`, `info`), `state` (`new`, `worsened`, `pre-existing`, `fixed`, `unclassified`), `location` (repository-relative path, line range, optional column, enclosing symbol path), `message`, `trigger` (the condition under which the problem manifests), optional `impact`, optional `suggested_fix`, `evidence` (references to artifacts in the review cache or the hosted evidence store), `source` (tool and version, or agent name), `locations` for every occurrence merged by root cause, each with its own line range and `occurrence_state` (`new`, `pre-existing`, `fixed` or `unclassified`), and, for `dependency/*` findings, an `advisory` block (`id`, `aliases`, `severity` from `critical`, `high`, `moderate`, `low`, `unknown`, `fixed_version` or `unknown`, `url`). The schema SHALL also define the optional keys `round` (positive integer: the review round within a head lineage that produced the finding), `first_posted_in` (the head SHA or snapshot key of the round in which the finding was first posted) and `author_response` (`{ reason: fixed | wrong | intentional | irrelevant | style, actor, at, note }`); this version never emits them, and their absence SHALL be valid. An optional `verification` block SHALL record `voters`, `agreeing`, per-voter `blind_match` and `split` for verified agent findings; its absence SHALL remain valid for deterministic and historical findings. An optional `qa` block SHALL record `journey`, `step`, `kind` (`functional`, `ux`, `style`, `accessibility`), `viewport`, `color_scheme`, `route`, `element_paths[]` and `attribution` (`source` or `journey`); it SHALL be present exactly on findings produced by the QA step. The JSON form SHALL validate against `schemas/finding-v1.json`.

#### Scenario: JSON validates against the schema
- **WHEN** a review is rendered as JSON
- **THEN** every finding in the document validates against `schemas/finding-v1.json`

#### Scenario: Reserved keys validate
- **WHEN** a hand-written finding document carries `round: 2`, `first_posted_in: "3f2a…"` and `author_response: { reason: intentional, actor: "octocat", at: "2026-11-05T10:00:00Z" }`
- **THEN** it validates against `schemas/finding-v1.json`, and a document with `author_response.reason: known` is rejected

#### Scenario: QA block validates
- **WHEN** a QA finding carries `qa: { journey: checkout, step: 4, kind: functional, viewport: mobile, color_scheme: dark, route: "/checkout/confirm", element_paths: ["main > form > button"], attribution: source }`
- **THEN** it validates, and a non-QA finding carrying a `qa` block is rejected

### Requirement: Category separates defects from risks
`category` SHALL be `defect` for type errors, lint errors, secrets and vulnerable dependencies, `risk` for untested changes, and `ux` for every finding produced by the QA step, whether functional, visual or accessibility. Agent hypotheses SHALL additionally distinguish `security`, `style` and `diagnostic`. Verified security findings SHALL retain category `security`; `style` and `diagnostic` SHALL be confined to the category-floor audit footer, except that QA `style` findings carry category `ux` with `qa.kind: style` and are rendered in the QA section. Renderers SHALL present risks in a section separate from defects and SHALL NOT call a risk a bug. Plausible agent hypotheses SHALL never be presented as proven defects, including in the security and QA sections.

#### Scenario: Risk section
- **WHEN** a review has one type error and two untested changes
- **THEN** the report lists one defect under findings and two entries under risks

#### Scenario: Plausible security remains uncertain
- **WHEN** a security hypothesis is verified only at plausible
- **THEN** it retains its security classification and is labeled as a risk for human judgment

#### Scenario: QA style finding is not dropped by the category floor
- **WHEN** a `ui/accent-border-card` probe finding is produced
- **THEN** it has category `ux`, `qa.kind: style`, is rendered in the QA section and is not counted as a category-floor drop

## ADDED Requirements

### Requirement: Location of findings observed in a browser
A QA finding's `location` SHALL be the attributed source file and line when attribution succeeds, otherwise the journey file and the line of the failing step. The attribution method SHALL be recorded in `qa.attribution` and the element paths in `qa.element_paths`.

#### Scenario: Attributed to a component
- **WHEN** a probe fires on an element whose development annotation names `src/components/Card.tsx:12`
- **THEN** the finding's location is that file and line with `qa.attribution: source`

#### Scenario: No attribution
- **WHEN** the element has no annotation, no console error and its text appears in no changed file
- **THEN** the finding's location is `.rio/qa/journeys/checkout.yaml` at the failing step with `qa.attribution: journey`

### Requirement: Attribution order
Attribution SHALL try, in order: framework development annotations on the element (React, Vue, Svelte and Vite inspector source attributes present in development builds), the stack trace of a console error raised at the step, and a unique match of the element's text or class names in the changed files. The first method that yields exactly one file SHALL win; an ambiguous match SHALL count as no attribution.

#### Scenario: Ambiguous text match
- **WHEN** the element's text `Save` appears in three changed files and no annotation or stack trace exists
- **THEN** attribution fails and the finding is located at the journey file

#### Scenario: Stack trace wins over text
- **WHEN** the element has no annotation and a console error at the step points to `src/pages/Billing.tsx:40`
- **THEN** the finding is located at that file and line with `qa.attribution: source`

### Requirement: Identity of QA findings
The `normalized_location` of a QA finding SHALL be the journey name, the step index, the rule id and the route pattern, so the id is stable when source lines move and when element paths change by one index. Probe findings on the same rule and route within one journey SHALL merge into one finding whose `locations` lists each viewport and color scheme.

#### Scenario: Stable across viewports
- **WHEN** the same probe fires on the same route in `desktop` and `mobile`
- **THEN** one finding is produced with two locations marked by viewport
