//! Shared desktop wire types, errors, capture frames, keys, AX registry, and
//! the `Backend`/`AxBackend` traits every platform backend implements.

pub mod ax;
pub mod backend;
pub mod error;
pub mod frame;
pub mod keys;
pub mod types;
