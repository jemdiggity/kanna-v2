//! The previous-daemon fixture compiles an archived older release with a nested
//! Cargo process. If that build inherits the active worktree's output
//! directories, two source revisions share one Cargo fingerprint tree and the
//! current sources can be handed a stale artifact — the failure mode that
//! produced `E0432: no session_id in the root` in the daemon doctest.
//!
//! These tests drive a real nested `cargo build` through the same helper the
//! fixture uses, against a synthetic archive small enough to compile in seconds.

mod support;

use std::fs;
use std::path::Path;
use support::previous_daemon::{isolated_cargo_build, CARGO_DIRECTORY_ENV};

fn write_crate(source: &Path, module: Option<&str>) {
    fs::create_dir_all(source.join("src")).expect("create fixture source");
    fs::create_dir_all(source.join(".cargo")).expect("create fixture cargo dir");
    fs::write(
        source.join("Cargo.toml"),
        "[package]\nname = \"kanna-fixture-probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n",
    )
    .expect("write manifest");
    // Mirrors the real archive, which pins its own output directories in config.
    // The environment must still win, and must point at fixture-private paths.
    fs::write(
        source.join(".cargo/config.toml"),
        "[build]\ntarget-dir = \".build\"\nbuild-dir = \".build/cargo-build\"\n",
    )
    .expect("write cargo config");
    let lib = match module {
        Some(name) => format!("pub mod {name};\npub fn base() -> u32 {{ 1 }}\n"),
        None => "pub fn base() -> u32 { 1 }\n".to_string(),
    };
    fs::write(source.join("src/lib.rs"), lib).expect("write lib");
    if let Some(name) = module {
        fs::write(
            source.join(format!("src/{name}.rs")),
            "pub fn validate(id: &str) -> bool { !id.is_empty() }\n",
        )
        .expect("write module");
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "kanna-fixture-isolation-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("create scratch root");
    root
}

#[test]
fn nested_fixture_build_leaves_the_outer_cargo_directories_untouched() {
    let scratch = scratch("outer");
    let outer_build = scratch.join("outer/cargo-build");
    let outer_target = scratch.join("outer/target");
    fs::create_dir_all(&outer_build).expect("create outer build dir");
    fs::create_dir_all(&outer_target).expect("create outer target dir");

    let root = scratch.join("fixture");
    let source = root.join("source");
    write_crate(&source, None);

    // Exactly what a kd-managed worktree exports around `cargo test`.
    for key in CARGO_DIRECTORY_ENV {
        std::env::set_var(key, &outer_build);
    }
    std::env::set_var("CARGO_TARGET_DIR", &outer_target);

    let status = isolated_cargo_build(&source, &root)
        .arg("build")
        .status()
        .expect("run nested fixture build");

    for key in CARGO_DIRECTORY_ENV {
        std::env::remove_var(key);
    }
    assert!(status.success(), "nested fixture build failed");

    let outer_build_entries = fs::read_dir(&outer_build)
        .expect("read outer build dir")
        .count();
    let outer_target_entries = fs::read_dir(&outer_target)
        .expect("read outer target dir")
        .count();
    assert_eq!(
        outer_build_entries, 0,
        "nested fixture build wrote into the outer Cargo build directory"
    );
    assert_eq!(
        outer_target_entries, 0,
        "nested fixture build wrote into the outer Cargo target directory"
    );
    assert!(
        root.join("target").is_dir(),
        "fixture build did not use its own target directory"
    );

    let _ = fs::remove_dir_all(&scratch);
}

#[test]
fn an_older_archive_cannot_poison_a_later_current_source_build() {
    let scratch = scratch("revisions");
    let shared_build = scratch.join("shared/cargo-build");
    fs::create_dir_all(&shared_build).expect("create shared build dir");

    // The archived revision: no `session_id`, exactly like v0.1.0-staging.1.
    let archive_root = scratch.join("archive");
    write_crate(&archive_root.join("source"), None);

    // The current revision, whose consumer needs `session_id` to resolve.
    let current = scratch.join("current");
    write_crate(&current, Some("session_id"));
    fs::write(
        current.join("src/lib.rs"),
        "pub mod session_id;\npub use session_id::validate;\npub fn base() -> u32 { 1 }\n",
    )
    .expect("write current lib");

    for key in CARGO_DIRECTORY_ENV {
        std::env::set_var(key, &shared_build);
    }

    // Archive first, then current sources — the ordering that produced E0432.
    let archived = isolated_cargo_build(&archive_root.join("source"), &archive_root)
        .arg("build")
        .status()
        .expect("run archived build");
    let built_current = isolated_cargo_build(&current, &current)
        .arg("build")
        .status()
        .expect("run current build");

    for key in CARGO_DIRECTORY_ENV {
        std::env::remove_var(key);
    }
    assert!(archived.success(), "archived fixture build failed");
    assert!(
        built_current.success(),
        "current-source build failed after the archived build; the archive leaked into a shared tree"
    );
    assert_eq!(
        fs::read_dir(&shared_build)
            .expect("read shared build dir")
            .count(),
        0,
        "a fixture build wrote into the shared Cargo build directory"
    );

    let _ = fs::remove_dir_all(&scratch);
}
