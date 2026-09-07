//! Build-time git identity for the daemon binary, and the file set cargo must
//! watch so that identity can never outlive the tree it describes.
//!
//! `GIT_COMMIT` is baked into the daemon's `--version` output, its startup log
//! line and its lifecycle audit, so a build that reports one commit while
//! having been compiled from another silently misattributes every session it
//! runs. Cargo cannot infer that dependency: nothing under `crates/daemon`
//! changes when `HEAD` moves, so a build script that only declares
//! `rerun-if-changed=VERSION` keeps its previously emitted `rustc-env` values
//! *and* the already-linked binary. That is exactly how a remote-E2E lane on
//! one commit came to launch a daemon logging another.
//!
//! The watch set is therefore derived from git's own layout rather than
//! guessed: `HEAD` for the current worktree, the branch ref it points at
//! (which git resolves into the common dir, where linked worktrees keep their
//! refs), and `packed-refs` when refs are packed.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Stand-in identity for a tree that is not a git checkout (a source tarball,
/// a vendored copy) or where git is unavailable.
pub const UNKNOWN: &str = "unknown";

/// The git identity compiled into the binary.
pub struct GitIdentity {
    pub commit: String,
    pub branch: String,
}

/// Runs git in `repo_root`, returning trimmed stdout only when git succeeded.
///
/// Exit status matters: `git symbolic-ref -q HEAD` reports a detached HEAD by
/// failing with empty stdout, which is a different answer from "the branch is
/// named the empty string".
pub fn git(repo_root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Resolves a path inside the git directory, honouring worktree relocation.
///
/// `git rev-parse --git-path` is what makes this correct in a linked worktree:
/// `HEAD` resolves to that worktree's private git dir while `refs/heads/*` and
/// `packed-refs` resolve to the shared common dir. Kanna runs every task in a
/// linked worktree, so hand-assembling `<root>/.git/<path>` would watch files
/// that do not exist.
pub fn git_path(repo_root: &Path, path: &str) -> Option<PathBuf> {
    let resolved = git(repo_root, &["rev-parse", "--git-path", path])?;
    let resolved = PathBuf::from(resolved);
    Some(if resolved.is_absolute() {
        resolved
    } else {
        repo_root.join(resolved)
    })
}

pub fn identity(repo_root: &Path) -> GitIdentity {
    GitIdentity {
        commit: git(repo_root, &["rev-parse", "--short", "HEAD"])
            .unwrap_or_else(|| UNKNOWN.to_string()),
        branch: git(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_else(|| UNKNOWN.to_string()),
    }
}

/// Every file whose content decides what [`identity`] returns.
///
/// Empty when `repo_root` is not a git checkout, which is the honest answer:
/// there is no file that could invalidate an `unknown` identity.
pub fn watch_paths(repo_root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Some(head) = git_path(repo_root, "HEAD") else {
        return paths;
    };
    push_unique(&mut paths, head);

    // Detached HEAD holds the commit itself, so HEAD alone is the whole
    // dependency. On a branch, the commit lives in the ref HEAD names.
    if let Some(ref_name) = git(repo_root, &["symbolic-ref", "-q", "HEAD"]) {
        if let Some(loose_ref) = git_path(repo_root, &ref_name) {
            // Declared even when absent. A packed ref has no loose file until
            // the next commit writes one, and cargo treats a missing watched
            // path as dirty — so the cost of a packed branch is an extra build
            // script run, and the cost of omitting it would be a stale
            // identity that no later commit ever invalidates.
            push_unique(&mut paths, loose_ref);
        }
        if let Some(packed_refs) = git_path(repo_root, "packed-refs") {
            if packed_refs.exists() {
                push_unique(&mut paths, packed_refs);
            }
        }
    }
    paths
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}
