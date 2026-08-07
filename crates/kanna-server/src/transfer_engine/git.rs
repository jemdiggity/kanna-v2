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

/// Normalizes a ref name and refuses anything git would not read as one.
///
/// The destination's checkout ref comes from a *peer's* payload, so this is a
/// fence, not a formatter: a value that reaches git's argv beginning with `-`
/// is an option, and one containing `..` addresses a ref this transfer has no
/// business naming. Everything that survives is `refs/`-prefixed, which also
/// makes a leading dash unrepresentable.
fn normalize_ref(reference: Option<&str>) -> Option<String> {
    let reference = reference?.trim();
    if reference.is_empty() {
        return None;
    }
    let normalized = if reference.starts_with("refs/") {
        reference.to_string()
    } else {
        format!("refs/heads/{reference}")
    };
    let safe = normalized.len() <= 512
        && !normalized.contains("..")
        && !normalized.contains("//")
        && !normalized.ends_with('/')
        && normalized.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b'+')
        });
    safe.then_some(normalized)
}

/// Whether a peer-supplied clone URL is one this machine will hand to git.
///
/// Two things are being refused, and neither is "an address I do not
/// recognise". `git clone` parses options before its positional arguments, so
/// `--upload-pack=/bin/sh` is a command rather than an address; and git's
/// `ext::` transport runs a command by design. The `--` separator below stops
/// the first and the `::` refusal stops the second.
///
/// Everything else git accepts stays accepted, including a plain absolute path
/// — cloning from a local repository is an ordinary thing to do, and it is what
/// a fixture repo, a mounted volume, or a peer that shares a filesystem looks
/// like. A relative path is refused only because it would resolve against the
/// server's cwd, which means nothing to the peer that sent it.
fn is_safe_clone_url(url: &str) -> bool {
    const SCHEMES: &[&str] = &[
        "https://",
        "http://",
        "ssh://",
        "git://",
        "file://",
        "git+ssh://",
    ];
    let trimmed = url.trim();
    if trimmed.is_empty()
        || trimmed.len() > 2048
        || trimmed.starts_with('-')
        // `ext::<command>` is the transport that runs a command; `::` appears
        // in no legitimate remote address, so refusing it outright is cheaper
        // than reasoning about every helper git might resolve.
        || trimmed.contains("::")
        || trimmed
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return false;
    }
    if SCHEMES.iter().any(|scheme| trimmed.starts_with(scheme)) {
        return true;
    }
    if trimmed.starts_with('/') {
        return true;
    }
    // scp-style `[user@]host:path`, git's other documented form. The host must
    // not contain a slash, which is what distinguishes it from a local path.
    match trimmed.split_once(':') {
        Some((host, path)) => !host.is_empty() && !host.contains('/') && !path.is_empty(),
        None => false,
    }
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
    if !is_safe_clone_url(url) {
        return Err(format!(
            "refusing to clone a transferred repository from an unsupported URL: {url}"
        ));
    }
    let destination = destination
        .to_str()
        .ok_or_else(|| "clone destination is not valid unicode".to_string())?;
    // `--` ends option parsing, so a URL is a URL even if it begins with a dash.
    git(Path::new("."), &["clone", "--", url, destination]).map(|_| ())
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

    /// The checkout ref comes from a peer's payload. A value that reaches git's
    /// argv as an option, or that walks out of the ref namespace, is refused
    /// rather than prefixed into something that only looks safe.
    #[test]
    fn a_hostile_ref_is_refused_rather_than_handed_to_git() {
        for hostile in [
            "refs/--upload-pack=/bin/sh",
            "refs/heads/../../etc",
            "refs/heads/a b",
            "refs/heads/x\nrm -rf /",
            "refs/heads/",
            "refs//heads/x",
        ] {
            assert_eq!(normalize_ref(Some(hostile)), None, "{hostile}");
        }
        // A dash-leading branch name is still usable — it just cannot become an
        // option once the `refs/heads/` prefix is in front of it.
        assert_eq!(
            normalize_ref(Some("--upload-pack")).as_deref(),
            Some("refs/heads/--upload-pack"),
        );
    }

    /// `git clone` parses options before positionals, and its `ext::` transport
    /// runs commands by design. A repository URL arrives from another machine,
    /// so both are refused before git sees them.
    #[test]
    fn a_hostile_clone_url_never_reaches_git() {
        for hostile in [
            "--upload-pack=/bin/sh",
            "-u/bin/sh",
            "ext::sh -c whoami",
            "ext::sh",
            // Relative paths resolve against the server's cwd, which means
            // nothing to the peer that sent them.
            "../../etc/passwd",
            "repo.git",
            "https://example.com/repo.git ; rm -rf /",
            "",
            "   ",
        ] {
            assert!(!is_safe_clone_url(hostile), "{hostile}");
        }
        // Refusing an address git accepts is its own failure mode: a local
        // clone source is ordinary, and rejecting it silently strands every
        // transfer of a repo with no network remote.
        for legitimate in [
            "https://github.com/anthropics/kanna.git",
            "ssh://git@github.com/anthropics/kanna.git",
            "git@github.com:anthropics/kanna.git",
            "file:///Users/x/repos/kanna",
            "/Users/x/repos/kanna-origin.git",
            "/private/var/folders/5k/tmp/fixture/repo-origin.git",
        ] {
            assert!(is_safe_clone_url(legitimate), "{legitimate}");
        }
    }

    #[test]
    fn cloning_refuses_an_unsupported_url_without_running_git() {
        let temp = tempfile::tempdir().expect("temp dir");
        let error = clone_remote("--upload-pack=/bin/sh", &temp.path().join("repo"))
            .expect_err("an option-shaped URL was handed to git");
        assert!(error.contains("unsupported URL"), "{error}");
        assert!(!temp.path().join("repo").exists());
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
