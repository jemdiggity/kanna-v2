//! Runs `build_support/sidecars.rs`'s own tests as part of `cargo test`.
//!
//! The module is compiled into `build.rs`, which `cargo test` never links, so
//! without this target the rule that keeps `cargo check`/`cargo clippy`
//! working in a fresh worktree — while a bundling build still hard-requires
//! the sidecars — would have no coverage at all.

#[path = "../build_support/sidecars.rs"]
mod sidecars;
