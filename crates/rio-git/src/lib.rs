//! Git access, immutable change selection, diffs, and materialized snapshots.

mod repo;
pub use repo::*;
mod diff;
pub use diff::*;
mod safe_tree;
pub use safe_tree::*;
mod snapshot;
pub use snapshot::*;
mod materialization;
pub use materialization::*;
