//! Platform-specific implementations.
//!
//! Each platform sub-module re-exports the same set of public functions.
//! The parent crate uses `crate::platform::*` and gets the correct
//! implementation for the current target OS at compile time.

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub(crate) use windows::*;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
pub(crate) use linux::*;
