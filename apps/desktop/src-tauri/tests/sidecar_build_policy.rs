//! Runs `build_support/sidecars.rs`'s own tests as part of `cargo test`, and
//! guards the `build.rs` wiring that puts them to work.
//!
//! The module is compiled into `build.rs`, which `cargo test` never links, so
//! without this target the rule that keeps `cargo check`/`cargo clippy`
//! working in a fresh worktree — while a bundling build still hard-requires
//! the sidecars — would have no coverage at all.

#[path = "../build_support/sidecars.rs"]
mod sidecars;

/// Guards the glue between the decision and the build, which no behavioral
/// test in this repository can reach.
///
/// `./kd test rust` runs `./kd build sidecars` before `cargo test --workspace`
/// (see `tools/kd/src/runtime/rust-test.ts`), so by the time any Rust test
/// runs the sidecars are always staged and the relax path is never taken. A
/// real end-to-end check would need a sidecar-less tree and a cold
/// `cargo check -p kanna-desktop` — about ninety seconds — for one assertion,
/// and it would have to run before the gate stages the binaries.
///
/// These are source-level assertions, and they are honest about their limit:
/// they prove the wiring is still *present* and still ordered correctly, not
/// that it behaves. `sidecars::tests` above covers the behavior. What this
/// catches is the regression that is otherwise silent — deleting the call in
/// `main()`, or moving it after the fingerprint, leaves every other test in
/// this repository passing.
mod wiring {
    use super::sidecars;
    use std::path::{Path, PathBuf};

    fn repo_root() -> PathBuf {
        // CARGO_MANIFEST_DIR is apps/desktop/src-tauri.
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("repository root above apps/desktop/src-tauri")
            .to_path_buf()
    }

    fn read(relative: &str) -> String {
        let path = repo_root().join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path:?}: {error}"))
    }

    #[test]
    fn build_script_relaxes_external_bin_before_it_builds() {
        let build_rs = read("apps/desktop/src-tauri/build.rs");

        let relax = build_rs
            .find("    relax_external_bin_when_sidecars_are_absent();")
            .expect(
                "build.rs must still call relax_external_bin_when_sidecars_are_absent() from \
                 main(); without it a fresh worktree cannot cargo check or clippy this crate",
            );
        let fingerprint = build_rs
            .find("    pin_tauri_config_fingerprint();")
            .expect("build.rs must still call pin_tauri_config_fingerprint() from main()");
        let build = build_rs
            .find("tauri_build::try_build(")
            .expect("build.rs must still call tauri_build::try_build");

        assert!(
            relax < fingerprint,
            "the relax step must run before the config fingerprint, or a check-only build bakes \
             a fingerprint that does not match the config it compiled against",
        );
        assert!(
            relax < build,
            "the relax step must run before tauri_build::try_build, which is what rejects a \
             missing externalBin entry",
        );
    }

    /// The relax path is only safe because every invocation that produces a
    /// runnable app opts back into the hard requirement. Losing the flag on
    /// one of these scripts would let `pnpm tauri build` emit a bundle with no
    /// sidecars in it.
    #[test]
    fn every_tauri_cli_script_still_requires_staged_sidecars() {
        let manifest: serde_json::Value =
            serde_json::from_str(&read("apps/desktop/package.json")).expect("parse package.json");

        for script in ["tauri", "tauri:dev", "tauri:build"] {
            let command = manifest["scripts"][script].as_str().unwrap_or_else(|| {
                panic!("apps/desktop/package.json is missing the {script:?} script")
            });
            assert!(
                command.contains(&format!("{}=1", sidecars::REQUIRE_SIDECARS_ENV)),
                "the {script:?} script drives the Tauri CLI, so it must set {}=1: {command:?}",
                sidecars::REQUIRE_SIDECARS_ENV,
            );
        }
    }
}
