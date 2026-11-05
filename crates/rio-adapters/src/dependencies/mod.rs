//! Lockfile graphs preserve resolution locations and dependency edges. The audit
//! uses their flattened versions; tool compatibility uses their effective graph.
mod lockfiles;
mod npm;
mod pnpm;
mod python;
mod yarn;
pub use lockfiles::*;
mod effective;
pub use effective::*;
mod installation;
pub use installation::*;
mod compatibility;
pub use compatibility::*;

mod remap;
pub use remap::*;
mod source_entries;

mod scope;
pub use scope::*;
