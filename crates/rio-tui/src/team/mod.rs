//! The `team` flow: P1 security finding and council, P2 publish preview,
//! P3 finding history and P4 suppression proposals (`Board::V3`).
//!
//! The host fills the data structs and answers the screens' requests as
//! `Msg::Done(Outcome::Value(name, json))`:
//!
//! | Request | `name` | JSON |
//! | --- | --- | --- |
//! | `Effect::PreviewPublish` (P1 `P`) | `publish:preview` | the body of `POST /v1/reviews/{id}/publish?dry_run=1` ([`Preview`]) |
//! | `Effect::Fetch("findings")` (P1 `F`) | `findings` | the body of `GET /v1/findings`: `{findings: [`[`RegistryRecord`]`]}` |
//! | `Effect::Fetch("suppressions")` (P3 `S`) | `suppressions` | the body of `GET /v1/suppressions`: `{suppressions: [`[`Proposal`]`]}`, each open proposal with the host's [`ProfileChange`] |
//! | `Effect::Fetch("audit")` (P1 `a`) | `audit` | the body of `GET /v1/reviews/{id}/audit`; P1 lists its `council` transfers for the focused finding |
//!
//! A failed request answers `Outcome::Failed(error)`; the waiting screen shows it.
//!
//! Consent: `Effect::Publish` is emitted only by `y` on a loaded preview whose
//! policy is not `never`, and posts exactly what the preview shows (there is no
//! narrower selection: `e` only hides the dialog to browse the preview).
//! `Effect::ApplyProposal` only on `y`, `Effect::DeclineProposal` only after `x`
//! and a typed reason. `n` on P2 and `N` on P4 emit nothing.

mod history;
mod picker;
mod proposals;
mod publish;
mod security;
mod ui;

pub use history::{
    HistoryData, HistoryScreen, ProposalHint, RecordLocation, RegistryRecord, Response, history,
};
pub use proposals::{
    DECLINE_QUIET_DAYS, Entry, Evidence, ProfileChange, ProfileLine, Proposal, ProposalsData,
    ProposalsScreen, date_after, proposals,
};
pub use publish::{CheckPreview, Preview, PreviewComment, PublishData, PublishScreen, publish};
pub use security::{
    CodeLine, ExperimentNote, Observation, SecurityData, SecurityEntry, SecurityScreen, StepText,
    security,
};
