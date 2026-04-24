//! Razer Synapse import subsystem.
//!
//! Slice 1 (this module) supports `.synapse4` JSON+base64 format for
//! profiles and macros. Later slices will add `.synapse3` ZIP+XML and
//! standalone `.xml` macro folders.

pub mod format_v4;
pub mod makecode;
pub mod mapping;
pub mod merge;
pub mod types;

pub use format_v4::parse_synapse_v4_file;
pub use merge::apply_parsed_into_config;
pub use types::*;
