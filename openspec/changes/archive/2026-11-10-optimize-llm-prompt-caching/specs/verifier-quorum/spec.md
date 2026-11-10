# Spec Delta

## MODIFIED Requirements

### Requirement: Two-turn blind verification
Each voter SHALL first receive the location, enclosing symbol, base and head symbol content, direct callers, intent and applicable owner guidance without the hypothesis. It SHALL answer what, if anything, is wrong using the hypothesis schema; an empty answer SHALL be valid. Only after recording this answer SHALL the voter receive the hypothesis and verify it using tools. The second turn SHALL append the hypothesis after the voter's complete blind conversation, without altering any earlier message. While the `verifier-system` layout feature is enabled, both turns SHALL use one unchanged system prompt, and the verification instructions and the verification answer schema SHALL arrive only with the hypothesis in the appended message, unless the first disclosed request in that form would not fit the voter's remaining token allowance; that voter SHALL then send the disclosed turn as it would with the feature off. While it is off, each turn SHALL keep the system prompt it used before this change.

#### Scenario: Hypothesis withheld until blind answer
- **WHEN** a voter starts examining a hypothesis
- **THEN** its first turn contains no hypothesis, trigger, proposed impact or generating rationale, and the original hypothesis is disclosed only in the second turn

#### Scenario: Disclosure only after the blind vote is persisted
- **WHEN** a voter's blind answer is accepted
- **THEN** the vote with its blind answer and blind match is saved before any request containing the hypothesis is built or sent, and a failure to save it ends the voter without disclosure

#### Scenario: Disclosed turn extends the blind conversation
- **WHEN** `verifier-system` is enabled and a voter's first disclosed request is sent after a blind phase of three model turns
- **THEN** its system text is identical to the blind requests' system text, its messages begin with the text of every blind message unchanged, and the disclosure is the single appended user message

#### Scenario: Answer schema arrives with the disclosure
- **WHEN** `verifier-system` is enabled and the blind requests of a voter are inspected
- **THEN** none of them contains the verification answer schema, the hypothesis, its rule id or its trigger, and the first disclosed request contains all of them

#### Scenario: Shared system prompt that would not fit
- **WHEN** `verifier-system` is enabled and a voter's remaining allowance covers its disclosed request with the vote-schema system prompt but not with the shared system prompt
- **THEN** the voter's disclosed requests use the vote-schema system prompt and the disclosure without the answer schema, as with the feature off, and the voter is not marked exhausted for it

#### Scenario: Feature off keeps per-phase system prompts
- **WHEN** `verifier-system` is not enabled
- **THEN** blind requests use the hypothesis-schema system prompt and disclosed requests use the vote-schema system prompt, as before this change, and the blindness scenarios above still hold
