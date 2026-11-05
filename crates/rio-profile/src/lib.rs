//! Review profile discovery, validation, inheritance, and built-in modules.

mod diagnostic;
mod discovery;
pub use diagnostic::*;
pub use discovery::*;
mod registry;
mod rules;
pub use registry::*;
pub use rules::*;
mod loader;
pub use loader::*;
