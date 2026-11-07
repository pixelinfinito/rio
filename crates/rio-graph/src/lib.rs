//! Bounded impact graphs over the immutable base and head source trees.
mod build;
mod index;
#[cfg(feature = "legacy")]
pub mod legacy;
mod model;
mod resolve;
pub use build::*;
pub use model::*;
