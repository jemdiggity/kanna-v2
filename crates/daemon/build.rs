#[path = "build_support/git_identity.rs"]
mod git_identity;

use std::path::PathBuf;

fn main() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .expect("daemon crate should live under <repo>/crates/daemon");
    let version_file = repo_root.join("VERSION");

    let identity = git_identity::identity(&repo_root);

    // Version from repo VERSION file, fallback to latest git tag (strip leading 'v').
    let version = if version_file.exists() {
        std::fs::read_to_string(&version_file)
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        match git_identity::git(&repo_root, &["describe", "--tags", "--abbrev=0"]) {
            Some(tag) => tag.strip_prefix('v').unwrap_or(&tag).to_string(),
            None => "0.0.0".to_string(),
        }
    };

    println!("cargo:rustc-env=KANNA_VERSION={}", version);
    println!("cargo:rustc-env=GIT_COMMIT={}", identity.commit);
    println!("cargo:rustc-env=GIT_BRANCH={}", identity.branch);

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=build_support/git_identity.rs");
    println!("cargo:rerun-if-changed={}", version_file.display());
    // Without these, moving HEAD leaves both the embedded identity and the
    // linked binary untouched: no file under `crates/daemon` changes when a
    // commit lands. See `build_support/git_identity.rs`.
    for path in git_identity::watch_paths(&repo_root) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}
