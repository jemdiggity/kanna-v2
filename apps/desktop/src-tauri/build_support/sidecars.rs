//! What a Cargo build of `kanna-desktop` should do when the Tauri
//! `bundle.externalBin` sidecars have not been staged into `binaries/`.
//!
//! `tauri_build` hard-fails on a missing `externalBin` entry, which made
//! `cargo check --workspace` and `cargo clippy --all-targets` unusable in a
//! fresh worktree: neither produces a bundle, but both run this crate's build
//! script. Staging the sidecars costs six cargo builds, so paying it to lint
//! is the wrong trade.
//!
//! The Bazel release path already resolved this the same way — see the
//! `desktop_build_script` target in `apps/desktop/src-tauri/BUILD.bazel`,
//! which hands the build script
//! `TAURI_CONFIG={"bundle":{"externalBin":[],"resources":[]}}` and assembles
//! the real sidecars from Bazel targets instead. This module lets the Cargo
//! path make the same distinction, but decide it per invocation rather than
//! unconditionally: a build that *is* producing a bundle still hard-requires
//! every sidecar.
//!
//! Compiled both by `build.rs` and by
//! `apps/desktop/src-tauri/tests/sidecar_build_policy.rs`, so the decision is
//! covered by ordinary `cargo test`. Keep it free of build-script-only APIs.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Set to a truthy value by every in-repo path that drives the Tauri CLI, so
/// a bundling or dev build keeps failing loudly on unstaged sidecars.
pub const REQUIRE_SIDECARS_ENV: &str = "KANNA_REQUIRE_SIDECARS";

/// Best-effort secondary signal: the Tauri CLI sets this on the cargo command
/// it spawns. Treated as advisory — [`REQUIRE_SIDECARS_ENV`] is the contract.
pub const TAURI_CLI_ENV: &str = "TAURI_CLI_VERBOSITY";

/// What this invocation should do about `bundle.externalBin`.
#[derive(Debug, PartialEq, Eq)]
pub enum ExternalBinDecision {
    /// Every declared sidecar is staged (or none are declared): leave the
    /// config alone and let `tauri_build` wire them through.
    Wire,
    /// Sidecars are missing and this invocation cannot produce a bundle:
    /// drop `externalBin` so checking, linting, and testing still work.
    Relax { missing: Vec<PathBuf> },
    /// Sidecars are missing and this invocation is bundling: fail loudly.
    Require { missing: Vec<PathBuf> },
}

/// The staged filenames `tauri_build` will look for, mirroring
/// `tauri_utils::resources::external_binaries`.
pub fn external_binary_paths(external_bin: &[String], target_triple: &str) -> Vec<PathBuf> {
    let extension = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    external_bin
        .iter()
        .map(|path| PathBuf::from(format!("{path}-{target_triple}{extension}")))
        .collect()
}

/// The subset of `paths` that `exists` reports as absent, resolved against
/// `manifest_dir` the way `tauri_build` resolves them.
pub fn missing_external_binaries(
    manifest_dir: &Path,
    paths: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|path| !exists(&manifest_dir.join(path)))
        .cloned()
        .collect()
}

/// Whether this invocation is one that produces a runnable app or a bundle,
/// and therefore may not relax the sidecar requirement.
pub fn is_bundling_build(var: impl Fn(&str) -> Option<String>) -> bool {
    is_truthy(var(REQUIRE_SIDECARS_ENV).as_deref()) || var(TAURI_CLI_ENV).is_some()
}

fn is_truthy(value: Option<&str>) -> bool {
    !matches!(
        value.map(str::trim).unwrap_or_default(),
        "" | "0" | "false" | "no"
    )
}

pub fn decide(missing: Vec<PathBuf>, bundling: bool) -> ExternalBinDecision {
    if missing.is_empty() {
        ExternalBinDecision::Wire
    } else if bundling {
        ExternalBinDecision::Require { missing }
    } else {
        ExternalBinDecision::Relax { missing }
    }
}

/// The one message both outcomes render, so the actionable instruction cannot
/// drift between the warning and the panic.
pub fn missing_sidecar_report(missing: &[PathBuf]) -> String {
    let names = missing
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Tauri externalBin sidecars are not staged in apps/desktop/src-tauri: {names}. \
         Run `./kd build sidecars` to stage them."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn declared() -> Vec<String> {
        vec![
            "binaries/kanna-daemon".to_string(),
            "binaries/kanna-cli".to_string(),
        ]
    }

    fn env_of(pairs: Vec<(&'static str, &'static str)>) -> impl Fn(&str) -> Option<String> {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn staged_names_carry_the_target_triple() {
        assert_eq!(
            external_binary_paths(&declared(), "aarch64-apple-darwin"),
            vec![
                PathBuf::from("binaries/kanna-daemon-aarch64-apple-darwin"),
                PathBuf::from("binaries/kanna-cli-aarch64-apple-darwin"),
            ]
        );
        assert_eq!(
            external_binary_paths(&declared(), "x86_64-pc-windows-msvc"),
            vec![
                PathBuf::from("binaries/kanna-daemon-x86_64-pc-windows-msvc.exe"),
                PathBuf::from("binaries/kanna-cli-x86_64-pc-windows-msvc.exe"),
            ]
        );
    }

    #[test]
    fn missing_entries_are_resolved_against_the_manifest_directory() {
        let manifest = Path::new("/repo/apps/desktop/src-tauri");
        let paths = external_binary_paths(&declared(), "aarch64-apple-darwin");
        let staged: HashSet<PathBuf> = [manifest.join(&paths[0])].into_iter().collect();

        assert_eq!(
            missing_external_binaries(manifest, &paths, |path| staged.contains(path)),
            vec![PathBuf::from("binaries/kanna-cli-aarch64-apple-darwin")]
        );
    }

    #[test]
    fn a_check_only_build_relaxes_the_requirement() {
        let missing = vec![PathBuf::from("binaries/kanna-daemon-aarch64-apple-darwin")];
        assert_eq!(
            decide(missing.clone(), is_bundling_build(env_of(Vec::new()))),
            ExternalBinDecision::Relax { missing }
        );
    }

    #[test]
    fn a_bundling_build_still_hard_requires_every_sidecar() {
        let missing = vec![PathBuf::from("binaries/kanna-daemon-aarch64-apple-darwin")];
        for env in [
            vec![(REQUIRE_SIDECARS_ENV, "1")],
            vec![(TAURI_CLI_ENV, "0")],
        ] {
            let label = format!("{env:?}");
            assert_eq!(
                decide(missing.clone(), is_bundling_build(env_of(env))),
                ExternalBinDecision::Require {
                    missing: missing.clone()
                },
                "{label} must not relax the requirement"
            );
        }
    }

    #[test]
    fn an_explicitly_disabled_requirement_is_not_a_bundling_build() {
        for value in ["", " ", "0", "false", "no"] {
            assert!(
                !is_bundling_build(env_of(vec![(REQUIRE_SIDECARS_ENV, value)])),
                "{value:?} must read as off"
            );
        }
    }

    #[test]
    fn fully_staged_sidecars_are_wired_through_even_when_bundling() {
        assert_eq!(decide(Vec::new(), true), ExternalBinDecision::Wire);
        assert_eq!(decide(Vec::new(), false), ExternalBinDecision::Wire);
    }

    #[test]
    fn the_report_names_every_missing_sidecar_and_the_command_that_stages_them() {
        let report = missing_sidecar_report(&[
            PathBuf::from("binaries/kanna-daemon-aarch64-apple-darwin"),
            PathBuf::from("binaries/kanna-cli-aarch64-apple-darwin"),
        ]);
        assert!(
            report.contains("binaries/kanna-daemon-aarch64-apple-darwin"),
            "{report}"
        );
        assert!(
            report.contains("binaries/kanna-cli-aarch64-apple-darwin"),
            "{report}"
        );
        assert!(report.contains("./kd build sidecars"), "{report}");
    }
}
