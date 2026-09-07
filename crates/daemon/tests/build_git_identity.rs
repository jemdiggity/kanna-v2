//! Proves the daemon's build script is invalidated whenever its embedded git
//! identity would change.
//!
//! The regression this guards: `build.rs` embedded `git rev-parse --short
//! HEAD` into `GIT_COMMIT` while declaring `rerun-if-changed` only for
//! `VERSION`. Nothing under `crates/daemon` changes when a commit lands, so an
//! ordinary `cargo build` kept both the previously emitted identity and the
//! already-linked binary — and a remote-E2E lane on one commit launched a
//! daemon that logged another.
//!
//! Each case takes the watch set *before* a change that moves HEAD and asserts
//! that the change dirtied at least one path already in it. Cargo compares
//! mtimes and treats a missing watched path as dirty, so comparing content
//! (with absence as its own state) is a faithful proxy: nothing rewrites these
//! files without touching them.

#[path = "../build_support/git_identity.rs"]
mod git_identity;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_temp_root(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let root = std::env::temp_dir().join(format!("kanna-{name}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&root).expect("temp root should be created");
    root
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_AUTHOR_NAME", "Kanna Test")
        .env("GIT_AUTHOR_EMAIL", "test@kanna.invalid")
        .env("GIT_COMMITTER_NAME", "Kanna Test")
        .env("GIT_COMMITTER_EMAIL", "test@kanna.invalid")
        .output()
        .unwrap_or_else(|error| panic!("git {args:?} should run: {error}"));
    assert!(
        output.status.success(),
        "git {args:?} failed in {}: {}",
        repo.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn init_repo(name: &str) -> PathBuf {
    let root = unique_temp_root(name);
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("repo dir should be created");
    // git reports the real path (`/private/var/...` on macOS); comparing
    // against the symlinked temp path would fail on nothing.
    let repo = repo.canonicalize().expect("repo dir should canonicalize");
    git(&repo, &["init", "--initial-branch=main", "."]);
    commit(&repo, "first");
    repo
}

fn commit(repo: &Path, marker: &str) {
    std::fs::write(repo.join("file.txt"), marker).expect("work tree file should be written");
    git(repo, &["add", "file.txt"]);
    git(repo, &["commit", "-m", marker]);
}

/// Content of every watched path, with absence recorded as its own state.
fn fingerprint(paths: &[PathBuf]) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    paths
        .iter()
        .map(|path| (path.clone(), std::fs::read(path).ok()))
        .collect()
}

#[track_caller]
fn assert_invalidated(
    repo: &Path,
    before_paths: &[PathBuf],
    before: &BTreeMap<PathBuf, Option<Vec<u8>>>,
    what_changed: &str,
) {
    assert!(
        !before_paths.is_empty(),
        "a git checkout must declare at least one watched path"
    );
    let after = fingerprint(before_paths);
    assert!(
        after != *before,
        "{what_changed} in {} left every watched path untouched, so cargo would reuse the \
         stale identity: {before_paths:?}",
        repo.display()
    );
}

#[test]
fn committing_on_a_branch_dirties_a_watched_path() {
    let repo = init_repo("build-identity-branch");
    let paths = git_identity::watch_paths(&repo);
    let before = fingerprint(&paths);
    let before_commit = git_identity::identity(&repo).commit;

    commit(&repo, "second");

    assert_invalidated(&repo, &paths, &before, "a commit");
    assert_ne!(
        git_identity::identity(&repo).commit,
        before_commit,
        "the embedded commit should have moved"
    );
}

#[test]
fn switching_branches_dirties_a_watched_path() {
    let repo = init_repo("build-identity-switch");
    git(&repo, &["checkout", "-b", "other"]);
    commit(&repo, "on-other");
    git(&repo, &["checkout", "main"]);

    let paths = git_identity::watch_paths(&repo);
    let before = fingerprint(&paths);
    let before_identity = git_identity::identity(&repo);
    assert_eq!(before_identity.branch, "main");

    git(&repo, &["checkout", "other"]);

    assert_invalidated(&repo, &paths, &before, "a branch switch");
    let after_identity = git_identity::identity(&repo);
    assert_eq!(after_identity.branch, "other");
    assert_ne!(after_identity.commit, before_identity.commit);
}

#[test]
fn moving_a_detached_head_dirties_a_watched_path() {
    let repo = init_repo("build-identity-detached");
    commit(&repo, "second");
    let first = git(&repo, &["rev-parse", "HEAD~1"]);
    let second = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["checkout", "--detach", &second]);

    let paths = git_identity::watch_paths(&repo);
    let before = fingerprint(&paths);

    git(&repo, &["checkout", "--detach", &first]);

    assert_invalidated(&repo, &paths, &before, "a detached-HEAD checkout");
    assert!(
        first.starts_with(&git_identity::identity(&repo).commit),
        "the embedded commit should track the detached HEAD"
    );
}

#[test]
fn committing_onto_a_packed_ref_dirties_a_watched_path() {
    let repo = init_repo("build-identity-packed");
    git(&repo, &["pack-refs", "--all"]);
    let loose_ref = git_identity::git_path(&repo, "refs/heads/main")
        .expect("the branch ref path should resolve");
    assert!(
        !loose_ref.exists(),
        "the ref should be packed for this case to mean anything"
    );

    let paths = git_identity::watch_paths(&repo);
    assert!(
        paths.contains(&loose_ref),
        "a packed branch must still watch the loose ref path it will be written to: {paths:?}"
    );
    let packed_refs =
        git_identity::git_path(&repo, "packed-refs").expect("packed-refs path should resolve");
    assert!(
        paths.contains(&packed_refs),
        "packed refs hold the commit, so packed-refs must be watched: {paths:?}"
    );
    let before = fingerprint(&paths);

    commit(&repo, "second");

    assert_invalidated(&repo, &paths, &before, "a commit onto a packed ref");
}

#[test]
fn a_linked_worktree_watches_its_own_head_and_the_shared_ref() {
    let repo = init_repo("build-identity-worktree");
    let worktree = repo
        .parent()
        .expect("repo should have a parent")
        .join("task-worktree");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "task-1",
            worktree.to_str().expect("worktree path should be UTF-8"),
        ],
    );

    let paths = git_identity::watch_paths(&worktree);
    let head = git_identity::git_path(&worktree, "HEAD").expect("worktree HEAD should resolve");
    assert!(
        head.starts_with(repo.join(".git").join("worktrees")),
        "a linked worktree keeps its own HEAD, not the common one: {}",
        head.display()
    );
    assert!(
        paths.contains(&head),
        "worktree HEAD must be watched: {paths:?}"
    );
    assert!(
        paths
            .iter()
            .any(|path| path.starts_with(repo.join(".git").join("refs"))),
        "the branch ref lives in the common dir and must be watched from there: {paths:?}"
    );
    assert_eq!(git_identity::identity(&worktree).branch, "task-1");

    let before = fingerprint(&paths);
    commit(&worktree, "second");
    assert_invalidated(
        &worktree,
        &paths,
        &before,
        "a commit inside a linked worktree",
    );
}

#[test]
fn a_tree_that_is_not_a_checkout_reports_unknown_and_watches_nothing() {
    let root = unique_temp_root("build-identity-no-repo")
        .canonicalize()
        .expect("temp root should canonicalize");

    assert!(
        git_identity::watch_paths(&root).is_empty(),
        "there is no file that could invalidate an unknown identity"
    );
    let identity = git_identity::identity(&root);
    assert_eq!(identity.commit, git_identity::UNKNOWN);
    assert_eq!(identity.branch, git_identity::UNKNOWN);
}
