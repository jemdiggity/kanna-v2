#[path = "build_support/sidecars.rs"]
mod sidecars;

fn merge_json(base: &mut serde_json::Value, overlay: serde_json::Value) {
    match (base, overlay) {
        (serde_json::Value::Object(base_map), serde_json::Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                match base_map.get_mut(&key) {
                    Some(existing) => merge_json(existing, value),
                    None => {
                        base_map.insert(key, value);
                    }
                }
            }
        }
        (base_value, overlay_value) => *base_value = overlay_value,
    }
}

fn merge_updater_pubkey_into_tauri_config() {
    let updater_pubkey = std::env::var("KANNA_UPDATER_PUBKEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    println!("cargo:rerun-if-env-changed=KANNA_UPDATER_PUBKEY");

    let Some(updater_pubkey) = updater_pubkey else {
        return;
    };

    let mut tauri_config = match std::env::var("TAURI_CONFIG") {
        Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .unwrap_or_else(|error| panic!("failed to parse TAURI_CONFIG as JSON: {error}")),
        Err(std::env::VarError::NotPresent) => serde_json::Value::Object(serde_json::Map::new()),
        Err(error) => panic!("failed to read TAURI_CONFIG: {error}"),
    };

    merge_json(
        &mut tauri_config,
        serde_json::json!({
            "plugins": {
                "updater": {
                    "pubkey": updater_pubkey,
                }
            }
        }),
    );

    std::env::set_var(
        "TAURI_CONFIG",
        serde_json::to_string(&tauri_config)
            .unwrap_or_else(|error| panic!("failed to serialize merged TAURI_CONFIG: {error}")),
    );
}

/// Reads the effective Tauri config: `tauri.conf.json` with the current
/// `TAURI_CONFIG` overlay merged on top, which is the same view `tauri_build`
/// resolves.
fn effective_tauri_config() -> serde_json::Value {
    let mut config = std::fs::read_to_string("tauri.conf.json")
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
    if let Ok(raw) = std::env::var("TAURI_CONFIG") {
        if let Ok(overlay) = serde_json::from_str::<serde_json::Value>(&raw) {
            merge_json(&mut config, overlay);
        }
    }
    config
}

/// Drops `bundle.externalBin` when its sidecars have not been staged and this
/// invocation cannot produce a bundle.
///
/// `tauri_build` treats a missing `externalBin` entry as fatal, which made
/// `cargo check --workspace` and `cargo clippy --all-targets` fail in every
/// fresh worktree until someone ran `./kd build sidecars` — a six-crate build
/// paid to lint. Bundling and dev builds still hard-require every sidecar; see
/// `build_support/sidecars.rs` for how the two are told apart.
fn relax_external_bin_when_sidecars_are_absent() {
    println!(
        "cargo:rerun-if-env-changed={}",
        sidecars::REQUIRE_SIDECARS_ENV
    );
    println!("cargo:rerun-if-env-changed={}", sidecars::TAURI_CLI_ENV);

    let config = effective_tauri_config();
    let declared = config
        .pointer("/bundle/externalBin")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if declared.is_empty() {
        return;
    }

    let target_triple = std::env::var("TARGET").unwrap_or_default();
    let paths = sidecars::external_binary_paths(&declared, &target_triple);
    // Staging a sidecar must dirty this script, or a `cargo check` that
    // relaxed the requirement would leave a stale config baked into the next
    // `tauri dev` build.
    for path in &paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let missing =
        sidecars::missing_external_binaries(std::path::Path::new(&manifest_dir), &paths, |path| {
            path.exists()
        });
    let bundling = sidecars::is_bundling_build(|name| std::env::var(name).ok());
    match sidecars::decide(missing, bundling) {
        sidecars::ExternalBinDecision::Wire => {}
        sidecars::ExternalBinDecision::Require { missing } => {
            panic!("{}", sidecars::missing_sidecar_report(&missing));
        }
        sidecars::ExternalBinDecision::Relax { missing } => {
            println!(
                "cargo:warning={} This build drops them, so it can check, lint, and \
                 test but cannot produce a runnable app.",
                sidecars::missing_sidecar_report(&missing)
            );
            let mut config = match std::env::var("TAURI_CONFIG") {
                Ok(raw) => {
                    serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_else(|error| {
                        panic!("failed to parse TAURI_CONFIG as JSON: {error}")
                    })
                }
                Err(_) => serde_json::Value::Object(serde_json::Map::new()),
            };
            merge_json(
                &mut config,
                serde_json::json!({ "bundle": { "externalBin": [] } }),
            );
            std::env::set_var(
                "TAURI_CONFIG",
                serde_json::to_string(&config)
                    .unwrap_or_else(|error| panic!("failed to serialize TAURI_CONFIG: {error}")),
            );
        }
    }
}

/// Makes the compiled crate depend on the effective `TAURI_CONFIG`.
///
/// `tauri::generate_context!()` expands the merged config at rustc time, but cargo has no
/// way to know that: `tauri_build` only asks to rerun *this script* when `TAURI_CONFIG`
/// changes, and a rerun whose output is identical leaves the compiled crate alone. A dev
/// binary could therefore be relinked and still carry an earlier run's `build.devUrl` —
/// which is both the URL the window loads and what the capability ACL treats as "local",
/// so the app either sat at `about:blank` or was denied every ACL-scoped command.
///
/// Emitting the config's fingerprint changes this script's output whenever the config
/// changes, which is what dirties the crate and re-expands the context.
fn pin_tauri_config_fingerprint() {
    use std::hash::{Hash, Hasher};

    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let config = std::env::var("TAURI_CONFIG").unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    config.hash(&mut hasher);
    println!(
        "cargo:rustc-env=KANNA_TAURI_CONFIG_FINGERPRINT={:016x}",
        hasher.finish()
    );
}

fn main() {
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        std::env::set_current_dir(&manifest_dir)
            .unwrap_or_else(|error| panic!("failed to chdir to {manifest_dir}: {error}"));
    }

    let version = std::env::var("KANNA_VERSION")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("KANNA_VERSION_FILE")
                .ok()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=KANNA_VERSION={version}");
    println!("cargo:rerun-if-env-changed=KANNA_VERSION");
    println!("cargo:rerun-if-env-changed=KANNA_VERSION_FILE");

    let build_branch = std::env::var("KANNA_BUILD_BRANCH").unwrap_or_default();
    let build_commit = std::env::var("KANNA_BUILD_COMMIT").unwrap_or_default();
    let build_task_id = std::env::var("KANNA_BUILD_TASK_ID").unwrap_or_default();
    let build_worktree = std::env::var("KANNA_BUILD_WORKTREE").unwrap_or_default();
    println!("cargo:rustc-env=KANNA_BUILD_BRANCH={}", build_branch);
    println!("cargo:rustc-env=KANNA_BUILD_COMMIT={}", build_commit);
    println!("cargo:rustc-env=KANNA_BUILD_TASK_ID={}", build_task_id);
    println!("cargo:rustc-env=KANNA_BUILD_WORKTREE={}", build_worktree);
    let build_info = if build_branch.is_empty() {
        String::new()
    } else if !build_task_id.is_empty() && build_worktree.is_empty() {
        format!(
            "task {} · {} @ {}",
            build_task_id, build_branch, build_commit
        )
    } else if !build_task_id.is_empty() && build_branch == build_worktree {
        format!(
            "task {} · {} @ {}",
            build_task_id, build_worktree, build_commit
        )
    } else if !build_task_id.is_empty() && build_worktree == format!("task-{}", build_task_id) {
        format!(
            "task {} · {} @ {}",
            build_task_id, build_branch, build_commit
        )
    } else if !build_task_id.is_empty() {
        format!(
            "task {} · {} · {} @ {}",
            build_task_id, build_worktree, build_branch, build_commit
        )
    } else if build_worktree.is_empty() {
        format!("{} @ {}", build_branch, build_commit)
    } else {
        format!("{} · {} @ {}", build_worktree, build_branch, build_commit)
    };
    println!("cargo:rustc-env=KANNA_BUILD_INFO={}", build_info);
    println!("cargo:rerun-if-env-changed=KANNA_BUILD_BRANCH");
    println!("cargo:rerun-if-env-changed=KANNA_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=KANNA_BUILD_TASK_ID");
    println!("cargo:rerun-if-env-changed=KANNA_BUILD_WORKTREE");

    merge_updater_pubkey_into_tauri_config();
    relax_external_bin_when_sidecars_are_absent();
    pin_tauri_config_fingerprint();

    if let Err(error) = tauri_build::try_build(Default::default()) {
        let cwd = std::env::current_dir().ok();
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").ok();
        let diagnostics = [
            ("Cargo.toml", std::path::Path::new("Cargo.toml").exists()),
            ("Info.plist", std::path::Path::new("Info.plist").exists()),
            (
                "tauri.conf.json",
                std::path::Path::new("tauri.conf.json").exists(),
            ),
            ("icons", std::path::Path::new("icons").exists()),
            (
                "capabilities",
                std::path::Path::new("capabilities").exists(),
            ),
            (
                "../dist (tauri.conf.json frontendDist)",
                std::path::Path::new("../dist").exists(),
            ),
        ];
        panic!(
            "tauri_build failed: {error:#}\ncwd={cwd:?}\nCARGO_MANIFEST_DIR={manifest_dir:?}\npath_diagnostics={diagnostics:?}\nMissing externalBin sidecars are handled separately (see build_support/sidecars.rs); this failure is something else."
        );
    }
}
