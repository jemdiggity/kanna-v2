//! Git and filesystem work for a transfer.
//!
//! The renderer used to drive `git bundle`, `git clone`, `git init` and `tar`
//! through the `run_script` Tauri command — shelling out from a window, with a
//! hand-built command string and the worktree environment scrubbed by hand at
//! every call site. The server already forks worktrees for every task; these
//! follow the same shape, as argument vectors with no shell in the path at all.

use std::path::Path;
use std::process::Command;

/// Runs one git invocation, returning its stderr on failure.
///
/// Arguments are passed as a vector, never as a shell string: a repository
/// name, a branch, or a ref from a peer payload must not be able to become a
/// second command.
fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        // The server inherits the worktree-scoped environment of the instance
        // that spawned it; a nested git run must not adopt it.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .map_err(|error| format!("failed to run git {}: {error}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn remote_url(repo_path: &Path) -> Option<String> {
    git(repo_path, &["remote", "get-url", "origin"])
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
}

fn normalize_ref(reference: Option<&str>) -> Option<String> {
    let reference = reference?.trim();
    if reference.is_empty() {
        return None;
    }
    Some(if reference.starts_with("refs/") {
        reference.to_string()
    } else {
        format!("refs/heads/{reference}")
    })
}

/// Bundles the refs a transferred task needs when the destination has neither
/// the repository nor a remote it can clone from.
///
/// The task's own branch is the only ref that must cross; its base ref is the
/// fallback for a task that has not branched yet. `--all` is the last resort
/// rather than the default — bundling a whole repository over a relay for one
/// task is not something to do by accident.
pub fn create_bundle(
    repo_path: &Path,
    bundle_path: &Path,
    branch: Option<&str>,
    base_ref: Option<&str>,
) -> Result<Option<String>, String> {
    let ref_name = normalize_ref(branch).or_else(|| normalize_ref(base_ref));
    let bundle_path = bundle_path
        .to_str()
        .ok_or_else(|| "bundle path is not valid unicode".to_string())?;
    match &ref_name {
        Some(reference) => {
            git(repo_path, &["bundle", "create", bundle_path, reference])?;
        }
        None => {
            git(repo_path, &["bundle", "create", bundle_path, "--all"])?;
        }
    }
    Ok(ref_name)
}

/// Materializes a repository from a bundle the source staged.
///
/// `git fetch <bundle> '+refs/*:refs/*'` then checkout, exactly as the renderer
/// did — but the checkout ref comes from the validated payload rather than from
/// string concatenation, and a checkout that fails leaves the caller with the
/// git error instead of a shell exit code.
pub fn init_from_bundle(
    repo_path: &Path,
    bundle_path: &Path,
    checkout_ref: Option<&str>,
) -> Result<(), String> {
    std::fs::create_dir_all(repo_path)
        .map_err(|error| format!("failed to create transferred repo directory: {error}"))?;
    let repo_path_arg = repo_path
        .to_str()
        .ok_or_else(|| "repo path is not valid unicode".to_string())?;
    git(Path::new("."), &["init", repo_path_arg])?;
    let bundle_path = bundle_path
        .to_str()
        .ok_or_else(|| "bundle path is not valid unicode".to_string())?;
    git(repo_path, &["fetch", bundle_path, "+refs/*:refs/*"])?;
    let checkout_ref = normalize_ref(checkout_ref).unwrap_or_else(|| "HEAD".to_string());
    git(repo_path, &["checkout", &checkout_ref])?;
    Ok(())
}

pub fn clone_remote(url: &str, destination: &Path) -> Result<(), String> {
    let destination = destination
        .to_str()
        .ok_or_else(|| "clone destination is not valid unicode".to_string())?;
    git(Path::new("."), &["clone", url, destination]).map(|_| ())
}

/// Packs one session-state directory into a gzip tar the receiver extracts.
///
/// Written with the `tar` crate rather than by shelling out: the directory name
/// is a session id from the DB, and building a `tar -C … -czf …` command line
/// around it was the last place a transfer still composed a shell string.
pub fn create_session_archive(
    source_root: &Path,
    entry_name: &str,
    archive_path: &Path,
) -> Result<(), String> {
    let file = std::fs::File::create(archive_path)
        .map_err(|error| format!("failed to create session archive: {error}"))?;
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    builder
        .append_dir_all(entry_name, source_root.join(entry_name))
        .map_err(|error| format!("failed to archive session state: {error}"))?;
    builder
        .into_inner()
        .map_err(|error| format!("failed to finish session archive: {error}"))?
        .finish()
        .map_err(|error| format!("failed to compress session archive: {error}"))?;
    Ok(())
}

/// A repository directory that does not collide with one already there.
///
/// The transferred name comes from a peer, so it is reduced to a single path
/// component before it is joined onto anything.
pub fn allocate_repo_path(
    parent_dir: &Path,
    repo_name: &str,
) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(parent_dir)
        .map_err(|error| format!("failed to create repos directory: {error}"))?;
    let base = sanitize_repo_name(repo_name);
    let candidate = parent_dir.join(&base);
    if !candidate.exists() {
        return Ok(candidate);
    }
    for index in 2..=99 {
        let candidate = parent_dir.join(format!("{base}-{index}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "no free directory for transferred repo {base} under {}",
        parent_dir.display()
    ))
}

fn sanitize_repo_name(name: &str) -> String {
    let sanitized: String = name
        .trim()
        .chars()
        .map(|character| {
            if character == '/' || character == '\\' || (character as u32) < 0x20 {
                '-'
            } else {
                character
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('.').trim().to_string();
    if sanitized.is_empty() {
        "repo".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_supplied_repo_name_cannot_escape_the_repos_directory() {
        for hostile in ["../../etc", "..", ".", "a/b", "a\\b", "  ", ""] {
            let sanitized = sanitize_repo_name(hostile);
            assert!(!sanitized.contains('/'), "{hostile} -> {sanitized}");
            assert!(!sanitized.contains('\\'), "{hostile} -> {sanitized}");
            assert!(
                sanitized != "." && sanitized != ".." && !sanitized.is_empty(),
                "{hostile} -> {sanitized}",
            );
        }
        assert_eq!(sanitize_repo_name("kanna-7"), "kanna-7");
    }

    #[test]
    fn allocation_never_reuses_a_directory_that_already_exists() {
        let temp = tempfile::tempdir().expect("temp dir");
        let first = allocate_repo_path(temp.path(), "repo").expect("first allocation");
        std::fs::create_dir_all(&first).expect("create first");
        let second = allocate_repo_path(temp.path(), "repo").expect("second allocation");
        assert_ne!(first, second);
        assert_eq!(
            second.file_name().and_then(|name| name.to_str()),
            Some("repo-2")
        );
    }

    #[test]
    fn refs_are_normalized_to_full_names_before_they_reach_git() {
        assert_eq!(
            normalize_ref(Some("task-1")).as_deref(),
            Some("refs/heads/task-1")
        );
        assert_eq!(
            normalize_ref(Some("refs/heads/main")).as_deref(),
            Some("refs/heads/main")
        );
        assert_eq!(normalize_ref(Some("  ")), None);
        assert_eq!(normalize_ref(None), None);
    }

    /// A bundle round trip through a real git, so the fetch refspec and the
    /// checkout ref are pinned against git's behaviour rather than assumed.
    #[test]
    fn a_bundled_branch_round_trips_into_a_fresh_repository() {
        let temp = tempfile::tempdir().expect("temp dir");
        let source = temp.path().join("source");
        std::fs::create_dir_all(&source).expect("source dir");
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            git(&source, &args).expect("init source");
        }
        std::fs::write(source.join("file.txt"), b"contents").expect("write file");
        git(&source, &["add", "file.txt"]).expect("stage");
        git(&source, &["commit", "-m", "initial"]).expect("commit");
        git(&source, &["checkout", "-b", "task-1"]).expect("branch");
        std::fs::write(source.join("file.txt"), b"task contents").expect("write task file");
        git(&source, &["commit", "-am", "task"]).expect("task commit");

        let bundle = temp.path().join("transfer.bundle");
        let ref_name =
            create_bundle(&source, &bundle, Some("task-1"), Some("main")).expect("bundle");
        assert_eq!(ref_name.as_deref(), Some("refs/heads/task-1"));

        let destination = temp.path().join("destination");
        init_from_bundle(&destination, &bundle, ref_name.as_deref()).expect("restore");
        assert_eq!(
            std::fs::read_to_string(destination.join("file.txt")).expect("restored file"),
            "task contents",
        );
    }

    #[test]
    fn a_session_archive_carries_the_session_directory_it_names() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("tasks");
        std::fs::create_dir_all(root.join("session-1")).expect("session dir");
        std::fs::write(root.join("session-1").join(".highwatermark"), b"42").expect("write state");

        let archive = temp.path().join("session.tar.gz");
        create_session_archive(&root, "session-1", &archive).expect("archive");

        let decoder =
            flate2::read::GzDecoder::new(std::fs::File::open(&archive).expect("open archive"));
        let names: Vec<String> = tar::Archive::new(decoder)
            .entries()
            .expect("entries")
            .map(|entry| {
                entry
                    .expect("entry")
                    .path()
                    .expect("path")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(
            names
                .iter()
                .any(|name| name.contains("session-1/.highwatermark")),
            "{names:?}",
        );
    }
}
