//! Git and filesystem work for a transfer.
//!
//! The renderer used to drive `git bundle`, `git clone`, `git init` and `tar`
//! through the `run_script` Tauri command — shelling out from a window, with a
//! hand-built command string and the worktree environment scrubbed by hand at
//! every call site. The server already forks worktrees for every task; these
//! follow the same shape, as argument vectors with no shell in the path at all.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Whether a clone source is safe to move between paired machines.
///
/// HTTP credentials and signed URLs belong to the machine where the origin was
/// configured. Forwarding them would provision those credentials on a second
/// machine and could expose them through API or git error output.
pub fn is_credential_free_clone_source(source: &str) -> bool {
    let trimmed = source.trim();
    let lowercase = trimmed.to_ascii_lowercase();
    if !lowercase.starts_with("http://") && !lowercase.starts_with("https://") {
        return true;
    }

    let authority_and_path = if lowercase.starts_with("https://") {
        &trimmed["https://".len()..]
    } else {
        &trimmed["http://".len()..]
    };
    let authority = authority_and_path
        .split_once('/')
        .map_or(authority_and_path, |(authority, _)| authority);
    !authority.is_empty()
        && !authority.contains('@')
        && !authority_and_path.contains('?')
        && !authority_and_path.contains('#')
}

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
    fn cross_machine_clone_sources_exclude_http_credentials_and_signed_urls() {
        for credential_bearing in [
            "https://token@example.com/private.git",
            "https://user:password@example.com/private.git",
            "https://example.com/private.git?signed=value",
            "https://example.com/private.git#signed-fragment",
            "http://token@example.com/private.git",
        ] {
            assert!(
                !is_credential_free_clone_source(credential_bearing),
                "{credential_bearing}",
            );
        }
        for credential_free in [
            "https://example.com/repo.git",
            "ssh://git@example.com/repo.git",
            "git@example.com:repo.git",
            "file:///tmp/repo.git",
        ] {
            assert!(
                is_credential_free_clone_source(credential_free),
                "{credential_free}",
            );
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

// ---------------------------------------------------------------------------
// OpenCode session state
// ---------------------------------------------------------------------------

/// Runs one `opencode` invocation in a task's worktree.
///
/// Argument vector, no shell — a session id reaching this command comes from a
/// peer's payload on the import side, and the same discipline the git helpers
/// use applies here. `session list` and `export` are project-scoped, so `cwd`
/// is load-bearing rather than incidental.
///
/// The binary is resolved to an absolute path rather than execed by bare name.
/// Upstream this ran through the Tauri `run_script` command, which execs
/// `$SHELL -l -c` and so sees the user's profile PATH; `kanna-server` is spawned
/// with no PATH injected at all, and `opencode` lives in `~/.opencode/bin`,
/// `~/.bun/bin` or Homebrew — none of them on the launchd default PATH. Without
/// this, every OpenCode transfer fails on a packaged, Finder-launched Kanna and
/// works on the terminal-launched one the tests run in.
fn opencode(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let executable = crate::task_creator::resolve_agent_executable(
        kanna_agent_protocol::AgentProvider::Opencode,
    )?;
    let output = Command::new(&executable)
        .args(args)
        .current_dir(cwd)
        // The server inherits the spawning instance's worktree-scoped
        // environment; an agent CLI must not adopt it.
        .env_remove("KANNA_TMUX_SESSION")
        .env_remove("KANNA_DB_NAME")
        .env_remove("KANNA_DB_PATH")
        .env_remove("KANNA_DAEMON_DIR")
        .env("KANNA_WORKTREE", "1")
        .output()
        .map_err(|error| format!("failed to run opencode {}: {error}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "opencode {} failed: {}",
            args.join(" "),
            bounded_stderr(&output.stderr),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// How much of a failed CLI's stderr is worth keeping.
///
/// These messages are not only logged: they become a work item's `error` and a
/// transfer's `error`, both of which the operator reads and the snapshot
/// carries. An agent CLI that fails while printing a stack trace or a progress
/// spinner would otherwise put an unbounded blob in a DB column, so the head —
/// where the actual reason is — is kept and the rest is marked as dropped.
fn bounded_stderr(stderr: &[u8]) -> String {
    const BUDGET: usize = 2048;
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    if text.len() <= BUDGET {
        return text.to_string();
    }
    let mut end = BUDGET;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… ({} more bytes)", &text[..end], text.len() - end)
}

/// The OpenCode session this worktree has been talking to, newest first.
///
/// Two different paths are load-bearing here and they are not interchangeable.
/// The CLI runs in `worktree_path` **as given**, because `session list` is
/// scoped to the project of the directory it runs in and handing it a different
/// spelling of that directory can scope it somewhere else. The comparison is
/// against the kernel-resolved path, because that is what OpenCode *records* —
/// and a worktree can sit under a symlinked root, which is the case for every
/// E2E fixture.
pub fn latest_opencode_session_for_worktree(
    worktree_path: &Path,
) -> Result<Option<String>, String> {
    let resolved = worktree_path
        .canonicalize()
        .unwrap_or_else(|_| worktree_path.to_path_buf());
    let listing = opencode(worktree_path, &["session", "list", "--format", "json"])?;
    // A project with no sessions writes *nothing* — zero bytes, exit 0 — not
    // `[]` (verified against the installed CLI). Parsing that as JSON fails, so
    // reading it as an error would make legitimate absence unreachable and turn
    // every first transfer out of a fresh worktree into a failure.
    let listing = listing.trim();
    if listing.is_empty() {
        return Ok(None);
    }
    let sessions: serde_json::Value = serde_json::from_str(listing)
        .map_err(|error| format!("opencode session listing is not valid JSON: {error}"))?;
    let Some(sessions) = sessions.as_array() else {
        return Err("opencode session listing is not an array".to_string());
    };

    let mut matches: Vec<(i64, String)> = sessions
        .iter()
        .filter_map(|session| {
            let id = session.get("id")?.as_str()?;
            let directory = session.get("directory")?.as_str()?;
            (Path::new(directory) == resolved).then(|| {
                (
                    session
                        .get("updated")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(0),
                    id.to_string(),
                )
            })
        })
        .collect();
    matches.sort_by(|left, right| right.0.cmp(&left.0));

    let Some((_, session_id)) = matches.into_iter().next() else {
        return Ok(None);
    };
    if !super::payload::is_opencode_session_id(&session_id) {
        return Err(format!(
            "opencode reported an unrecognized session id: {session_id}"
        ));
    }
    Ok(Some(session_id))
}

/// Asks OpenCode for a self-contained JSON copy of one conversation.
///
/// `opencode export` writes the session to stdout (its progress line goes to
/// stderr), and the receiver feeds the file straight back to `opencode import`.
pub fn export_opencode_session(
    worktree_path: &Path,
    session_id: &str,
    destination: &Path,
) -> Result<(), String> {
    if !super::payload::is_opencode_session_id(session_id) {
        return Err(format!(
            "refusing to export an unrecognized OpenCode session id: {session_id}"
        ));
    }
    let exported = opencode(worktree_path, &["export", session_id])?;
    std::fs::write(destination, exported)
        .map_err(|error| format!("failed to write the OpenCode session export: {error}"))
}

/// Replays a shipped OpenCode conversation into this machine's session store.
///
/// `opencode import` keeps the session's id and re-keys it to the directory the
/// import runs in, which is why it must run in the destination worktree:
/// OpenCode resumes by matching the session's recorded directory against the
/// current working directory, and `opencode run --session <id>` from anywhere
/// else is a *silent* no-op — the same failure shape as the transcript loss this
/// artifact contract exists to stop.
///
/// The worktree is created here rather than waited for: the destination task —
/// and therefore its worktree path — is deterministic before creation, but the
/// checkout only happens once the task is created, which is after the agent
/// would need the session. `git worktree add` accepts an existing empty
/// directory, so claiming the path early costs nothing and a failed import
/// leaves only an empty directory behind.
pub fn import_opencode_session(
    export_path: &Path,
    session_id: &str,
    destination_worktree: &Path,
    live_worktrees: &LiveLocalWorktrees,
) -> Result<(), OpencodeImportError> {
    if !super::payload::is_opencode_session_id(session_id) {
        return Err(OpencodeImportError::Refused(format!(
            "incoming transfer resume id is not an OpenCode session id: {session_id}"
        )));
    }

    // The id Kanna will resume with has to be the id this export actually
    // carries. `opencode import` ignores the id it is asked about and takes the
    // session id from `info.id` inside the peer-supplied bytes, so without this
    // a payload can promise one session and install another — the destination
    // then spawns `--session <promised>` against a session that does not exist,
    // which is the silent-conversation-loss shape the artifact contract exists
    // to stop. Every other provider gets this binding structurally from the
    // filename; OpenCode's filename is a constant, so it is checked here.
    let (exported_id, exported_directory) =
        read_opencode_export_identity(export_path).map_err(OpencodeImportError::Refused)?;
    if exported_id != session_id {
        return Err(OpencodeImportError::Refused(format!(
            "OpenCode export carries session {exported_id} but the transfer promised {session_id}"
        )));
    }

    // The directory has to exist before either CLI call: both run *in* it.
    std::fs::create_dir_all(destination_worktree).map_err(|error| {
        OpencodeImportError::Unavailable(format!(
            "failed to create the destination worktree for an OpenCode import: {error}"
        ))
    })?;

    // `opencode import` does not replace a session id it already holds — it
    // re-keys the *existing* session's directory to the import cwd, keeping the
    // id and the messages (verified against the installed CLI: exit 0, no
    // warning). On a collision that would yank one of this operator's own
    // conversations out of its worktree, breaking that task's resume, and
    // splice this task onto an unrelated conversation while the shipped one is
    // dropped. Every other artifact leaves a pre-existing destination
    // untouched; so does this one.
    //
    // The exception is a session already keyed to *this* destination, which is
    // this transfer's own earlier attempt. Re-keying it to where it already
    // points changes nothing, so that is a completed import rather than a
    // collision — the distinction the directory exists to make.
    let resolved_destination = destination_worktree
        .canonicalize()
        .unwrap_or_else(|_| destination_worktree.to_path_buf());
    match local_opencode_session(destination_worktree, session_id) {
        LocalOpencodeSession::Present { directory } if directory == resolved_destination => {
            return Ok(());
        }
        // The conversation being shipped, still sitting where the source left
        // it. Both peers run on one machine in development and share a single
        // OpenCode store, so the destination legitimately finds the very
        // session it is importing — and re-keying *that* one to the new
        // worktree is what the transfer means.
        //
        // Two things have to hold, and only the second is load-bearing for
        // safety. The export naming the directory the local store reports keeps
        // an unrelated conversation that merely shares an id — the operator's
        // own `opencode` use somewhere outside Kanna — from being yanked out of
        // its directory. But that value comes out of the peer's own export, and
        // a peer holds it verbatim for every session this machine ever shipped
        // it, so on its own it authorizes a replay: push the id back with the
        // directory it was told, and the import re-keys a session of *this*
        // operator's into a worktree running the peer's prompt.
        //
        // So the arm is gated on a fact this machine owns and the peer cannot
        // assert: the session must not be sitting in a worktree one of this
        // instance's own open tasks is using. That is the harm — a live task
        // silently losing its resume — and it is the case the shared-store
        // reading never covers, because the session the destination finds there
        // belongs to the *other* instance's task and is absent from this
        // instance's worktree table.
        LocalOpencodeSession::Present { directory }
            if exported_directory.as_deref() == Some(directory.as_path())
                && !live_worktrees.owns(&directory) =>
        {
            log::info!(
                "re-keying OpenCode session {session_id} from {} to the destination worktree",
                directory.display(),
            );
        }
        LocalOpencodeSession::Present { .. } => {
            return Err(OpencodeImportError::DestinationExists(
                session_id.to_string(),
            ));
        }
        // Never proof of absence: importing here could re-key a live session.
        LocalOpencodeSession::Inconclusive(message) => {
            return Err(OpencodeImportError::Unavailable(message));
        }
        LocalOpencodeSession::Absent => {}
    }

    let export_path = export_path.to_str().ok_or_else(|| {
        OpencodeImportError::Refused("OpenCode export path is not valid unicode".to_string())
    })?;
    opencode(destination_worktree, &["import", export_path])
        .map(|_| ())
        .map_err(OpencodeImportError::Unavailable)
}

/// The worktrees this instance's own open tasks are working in.
///
/// The unforgeable half of the OpenCode re-key guard. A peer supplies the
/// session id and, through its export, the directory it claims that session
/// sits at; it supplies nothing here. Read from this instance's own database
/// immediately before the import, so a session an operator is actively using
/// cannot be re-keyed out from under the task using it.
///
/// Open tasks only. A closed task's worktree is removed and has no resume left
/// to lose, so protecting it would refuse the ordinary case — re-importing a
/// conversation this machine transferred away earlier — for nothing.
#[derive(Debug, Default)]
pub struct LiveLocalWorktrees {
    paths: Vec<PathBuf>,
}

impl LiveLocalWorktrees {
    pub fn new(paths: impl IntoIterator<Item = PathBuf>) -> Self {
        Self {
            // Canonicalized on the way in, because the directory it is compared
            // against comes back canonicalized from OpenCode's store and a
            // worktree path can reach it through a symlinked temp dir or a
            // `/var` → `/private/var` prefix.
            paths: paths.into_iter().map(canonical_or_self).collect(),
        }
    }

    fn owns(&self, directory: &Path) -> bool {
        let directory = canonical_or_self(directory.to_path_buf());
        self.paths.iter().any(|path| path == &directory)
    }
}

fn canonical_or_self(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

/// Why an OpenCode import did not happen.
///
/// The split is what the transfer's failure handling keys on. A refusal is a
/// statement about the payload and will say the same thing on every retry; an
/// `Unavailable` is the CLI or the machine, and OpenCode's store is one shared
/// SQLite file that many agents write — `opencode import` exits non-zero when
/// another process holds the write lock. Failing a transfer permanently for
/// that, after finalization has already shut the source agent down, throws away
/// a conversation over a lock that clears in seconds.
#[derive(Debug)]
pub enum OpencodeImportError {
    /// The payload is wrong and will still be wrong next time.
    Refused(String),
    /// This machine already owns a session with that id.
    DestinationExists(String),
    /// The CLI could not run, or could not finish. Worth another attempt.
    Unavailable(String),
}

impl std::fmt::Display for OpencodeImportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(message) | Self::Unavailable(message) => formatter.write_str(message),
            Self::DestinationExists(session_id) => write!(
                formatter,
                "OpenCode session {session_id} already exists on this machine"
            ),
        }
    }
}

/// The session id an export carries, and the directory it was keyed to when it
/// was taken. The directory is what tells the shipped conversation apart from
/// an unrelated local session that happens to share its id.
fn read_opencode_export_identity(export_path: &Path) -> Result<(String, Option<PathBuf>), String> {
    let raw = std::fs::read(export_path)
        .map_err(|error| format!("failed to read the OpenCode session export: {error}"))?;
    let export: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|error| format!("OpenCode session export is not valid JSON: {error}"))?;
    let session_id = export
        .get("info")
        .and_then(|info| info.get("id"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "OpenCode session export has no info.id".to_string())?;
    if !super::payload::is_opencode_session_id(session_id) {
        return Err(format!(
            "OpenCode session export carries an unrecognized session id: {session_id}"
        ));
    }
    let directory = export
        .get("info")
        .and_then(|info| info.get("directory"))
        .and_then(serde_json::Value::as_str)
        .filter(|directory| !directory.is_empty())
        .map(PathBuf::from);
    Ok((session_id.to_string(), directory))
}

/// What this machine's OpenCode store says about a session id.
#[derive(Debug, PartialEq, Eq)]
enum LocalOpencodeSession {
    /// The store answered with the session, and this is where it points.
    Present { directory: PathBuf },
    /// The store answered a listing, so it is readable, and it does not hold
    /// this id.
    Absent,
    /// The store could not answer. Never treated as absence.
    Inconclusive(String),
}

/// Asks this machine's OpenCode store about a session id.
///
/// `opencode export` is the right *lookup*: it resolves an id across every
/// project, the way `import` finds one, while `session list` only reports the
/// project of the directory it runs in. What it is not is a reliable *absence*
/// signal. Its whole body is wrapped in `catchCause(() => fail("Session not
/// found: <id>"))`, so a locked store — the common case this artifact's retry
/// handling exists for — reports in exactly the words an absent session does.
/// Reading that message as absence is what would let an import re-key one of
/// the operator's own conversations out of its worktree.
///
/// So absence is established by a *different* question. `session list` proves
/// the store is readable right now; an export that fails against a store that
/// just answered is genuine absence, and an export that fails against a store
/// that could not answer either is inconclusive and retried. An empty project
/// lists as zero bytes rather than `[]`, which is why the caller below accepts
/// an empty listing as an answer.
fn local_opencode_session(cwd: &Path, session_id: &str) -> LocalOpencodeSession {
    let export_failure = match opencode(cwd, &["export", session_id]) {
        Ok(exported) => {
            return match opencode_export_directory(&exported) {
                // A session with no recorded directory cannot be told apart
                // from one belonging to another worktree, so it is treated as
                // occupied rather than assumed to be ours.
                Some(directory) => LocalOpencodeSession::Present { directory },
                None => LocalOpencodeSession::Present {
                    directory: PathBuf::new(),
                },
            };
        }
        Err(message) => message,
    };
    match opencode(cwd, &["session", "list", "--format", "json"]) {
        Ok(_) => LocalOpencodeSession::Absent,
        Err(listing_failure) => LocalOpencodeSession::Inconclusive(format!(
            "OpenCode could not say whether session {session_id} exists here \
             (export: {export_failure}; session list: {listing_failure})"
        )),
    }
}

/// The directory an exported session is currently keyed to.
fn opencode_export_directory(exported: &str) -> Option<PathBuf> {
    serde_json::from_str::<serde_json::Value>(exported)
        .ok()?
        .get("info")?
        .get("directory")?
        .as_str()
        .map(PathBuf::from)
}

#[cfg(test)]
mod opencode_tests {
    use super::*;
    use std::path::PathBuf;

    const SESSION_ID: &str = "ses_02645d9aaffeeOgwt2rbXIcTdp";

    /// Points the provider-executable lookup at a stub `opencode`. The lookup
    /// path is process-global, so this holds the crate's env guard.
    struct StubOpencode {
        _guard: std::sync::MutexGuard<'static, ()>,
        dir: tempfile::TempDir,
    }

    impl StubOpencode {
        fn responding(script_body: &str) -> Self {
            let guard = crate::test_sidecar_guard();
            let dir = tempfile::tempdir().expect("stub dir");
            let stub = dir.path().join("opencode");
            std::fs::write(&stub, format!("#!/bin/sh\n{script_body}\n")).expect("write stub");
            std::fs::set_permissions(
                &stub,
                <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755),
            )
            .expect("chmod stub");
            unsafe {
                std::env::set_var("KANNA_TEST_PROVIDER_LOOKUP_PATH", dir.path());
            }
            Self { _guard: guard, dir }
        }

        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("calls"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    impl Drop for StubOpencode {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("KANNA_TEST_PROVIDER_LOOKUP_PATH");
            }
        }
    }

    fn write_export(dir: &Path, session_id: &str) -> PathBuf {
        let path = dir.join("export.json");
        std::fs::write(
            &path,
            serde_json::json!({ "info": { "id": session_id }, "messages": [] }).to_string(),
        )
        .expect("write export");
        path
    }

    /// The CLI is resolved to an absolute path, not execed by bare name.
    ///
    /// Upstream these commands ran through the Tauri `run_script` command,
    /// which execs `$SHELL -l -c` and so sees the user's profile PATH.
    /// `kanna-server` is spawned with no PATH injected, and `opencode` lives in
    /// `~/.opencode/bin`, `~/.bun/bin` or Homebrew — none of them on the
    /// launchd default PATH a Finder-launched Kanna inherits. The stub below is
    /// reachable *only* through the provider resolver: its directory is not on
    /// this process's PATH, so a bare-name exec would miss it (and silently run
    /// the host's own CLI instead).
    #[test]
    fn the_opencode_binary_is_resolved_rather_than_execed_by_bare_name() {
        let stub = StubOpencode::responding(r#"printf '%s\n' "$*" >> "$(dirname "$0")/calls""#);
        assert!(
            !std::env::var("PATH")
                .unwrap_or_default()
                .split(':')
                .any(|entry| Path::new(entry) == stub.dir.path()),
            "the stub must not be reachable without the resolver",
        );
        let temp = tempfile::tempdir().expect("temp");

        opencode(temp.path(), &["session", "list"]).expect("the resolver found the stub");

        assert_eq!(stub.calls(), vec!["session list".to_string()]);
    }

    /// The id Kanna resumes with has to be the id the export actually carries.
    /// `opencode import` ignores the id it is asked about and takes `info.id`
    /// from the peer-supplied bytes, so a payload could otherwise promise one
    /// session and install another — leaving the destination spawned with
    /// `--session <promised>` against a session that does not exist.
    #[test]
    fn an_export_whose_session_id_is_not_the_promised_one_is_refused() {
        let stub = StubOpencode::responding(r#"printf '%s\n' "$*" >> "$(dirname "$0")/calls""#);
        let temp = tempfile::tempdir().expect("temp");
        let export = write_export(temp.path(), "ses_0299051920000tGF3K0qC5s5G9a");

        let error = import_opencode_session(
            &export,
            SESSION_ID,
            &temp.path().join("worktree"),
            &LiveLocalWorktrees::default(),
        )
        .expect_err("a mismatched export was imported");
        assert!(
            matches!(error, OpencodeImportError::Refused(_)),
            "{error:?}",
        );
        assert!(error.to_string().contains("promised"), "{error}");
        assert!(
            stub.calls().iter().all(|call| !call.starts_with("import")),
            "the import ran anyway: {:?}",
            stub.calls(),
        );
    }

    /// A session id this machine already holds is a destination it owns. Every
    /// other artifact leaves an occupied destination untouched; so does this
    /// one, because `opencode import` would re-key the *existing* session out
    /// of its own worktree rather than replace it.
    #[test]
    fn an_id_this_machine_already_holds_is_never_imported_over() {
        let stub = StubOpencode::responding(
            r#"printf '%s\n' "$*" >> "$(dirname "$0")/calls"
case "$1" in
  export) printf '{"info":{"id":"%s","directory":"/some/other/worktree"}}' "$2" ;;
esac"#,
        );
        let temp = tempfile::tempdir().expect("temp");
        let export = write_export(temp.path(), SESSION_ID);

        let error = import_opencode_session(
            &export,
            SESSION_ID,
            &temp.path().join("worktree"),
            &LiveLocalWorktrees::default(),
        )
        .expect_err("an occupied destination was overwritten");
        assert!(
            matches!(error, OpencodeImportError::DestinationExists(_)),
            "{error:?}",
        );
        assert!(
            stub.calls().iter().all(|call| !call.starts_with("import")),
            "the import ran over an existing session: {:?}",
            stub.calls(),
        );
    }

    /// A failing CLI's stderr becomes a DB column the operator reads, so it is
    /// bounded — head kept, remainder counted — rather than stored whole.
    #[test]
    fn a_failing_cli_cannot_put_an_unbounded_blob_in_the_error_column() {
        assert_eq!(
            bounded_stderr(b"  Session not found  "),
            "Session not found"
        );
        let huge = "x".repeat(64 * 1024);
        let bounded = bounded_stderr(huge.as_bytes());
        assert!(bounded.len() < 2200, "{} bytes", bounded.len());
        assert!(bounded.starts_with("xxx"));
        assert!(bounded.contains("more bytes"), "{bounded}");
        // Multi-byte characters at the cut are not split.
        let multibyte = "é".repeat(64 * 1024);
        assert!(std::str::from_utf8(bounded_stderr(multibyte.as_bytes()).as_bytes()).is_ok());
    }

    /// A project with no sessions writes *nothing*, not `[]`.
    ///
    /// Verified against the installed CLI (1.16.2): `opencode session list
    /// --format json` in a fresh git project exits 0 with zero bytes on stdout
    /// and an empty stderr. Parsing that as JSON fails, so reading a parse
    /// error as a hard failure makes legitimate absence unreachable — every
    /// first OpenCode transfer out of a fresh worktree would fail instead of
    /// reporting that there is no session yet.
    #[test]
    fn an_empty_project_lists_as_no_sessions_rather_than_as_a_parse_error() {
        let temp = tempfile::tempdir().expect("temp");
        let worktree = temp.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("worktree");

        {
            // The real shape: exit 0, nothing at all on stdout.
            let _stub = StubOpencode::responding("exit 0");
            assert_eq!(
                latest_opencode_session_for_worktree(&worktree).expect("an empty project answers"),
                None,
            );
        }

        // A listing that is genuinely malformed is still an error — the empty
        // case is not a licence to swallow every unparseable answer.
        let _stub = StubOpencode::responding(r#"printf 'not json'"#);
        assert!(latest_opencode_session_for_worktree(&worktree).is_err());
    }

    /// `export` cannot prove absence, so absence is not read off its message.
    ///
    /// Every stub here reproduces the installed CLI (1.16.2) rather than a
    /// plausible-looking invention. `opencode export <unknown>` exits 1 with an
    /// ANSI-coloured `Error: Session not found: <id>` on stderr — and its whole
    /// body is wrapped in `catchCause(() => fail("Session not found: <id>"))`,
    /// so a store that is merely *locked* says the same words. That is why the
    /// locked case below prints the identical message: a probe that reads it as
    /// absence would import over a live session, which is the defect this guard
    /// exists to prevent.
    #[test]
    fn an_export_failure_is_never_read_as_an_absent_session() {
        let temp = tempfile::tempdir().expect("temp");
        let worktree = temp.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("worktree");
        // The real message, ANSI escapes included.
        let not_found = r#"printf 'Exporting session: %s\n' "$2" >&2
printf '\033[91m\033[1mError: \033[0mSession not found: %s\n' "$2" >&2
exit 1"#;

        // Absent: export fails, and `session list` answers — an empty project
        // answers with zero bytes, which is the shape the CLI actually emits.
        {
            let _stub = StubOpencode::responding(&format!(
                r#"case "$1" in
  export) {not_found} ;;
  session) exit 0 ;;
esac"#
            ));
            assert_eq!(
                local_opencode_session(&worktree, SESSION_ID),
                LocalOpencodeSession::Absent,
            );
        }

        // Locked: export fails with the *same* words, and the listing cannot
        // answer either. Absence is unprovable, so it is not claimed.
        {
            let _stub = StubOpencode::responding(&format!(
                r#"case "$1" in
  export) {not_found} ;;
  session) echo "SqliteError: database is locked" >&2; exit 1 ;;
esac"#
            ));
            assert!(
                matches!(
                    local_opencode_session(&worktree, SESSION_ID),
                    LocalOpencodeSession::Inconclusive(_),
                ),
                "a store that could not answer was reported as an absent session",
            );
        }

        // Present: export succeeds and says where the session points.
        let _stub = StubOpencode::responding(
            r#"case "$1" in
  export) printf '{"info":{"id":"%s","directory":"/elsewhere"}}' "$2" ;;
esac"#,
        );
        assert_eq!(
            local_opencode_session(&worktree, SESSION_ID),
            LocalOpencodeSession::Present {
                directory: PathBuf::from("/elsewhere"),
            },
        );
    }

    /// The inconclusive answer has to reach the *import* as a retry, not as a
    /// silent skip. A locked store clears in seconds; treating it as absence
    /// re-keys a live session, and treating it as a refusal throws away a
    /// conversation the source has already been shut down to hand over.
    #[test]
    fn an_unanswerable_store_makes_the_import_retry_rather_than_guess() {
        let _stub = StubOpencode::responding(
            r#"case "$1" in
  export) printf '\033[91m\033[1mError: \033[0mSession not found: %s\n' "$2" >&2; exit 1 ;;
  session) echo "SqliteError: database is locked" >&2; exit 1 ;;
  import) echo "imported" ;;
esac"#,
        );
        let temp = tempfile::tempdir().expect("temp");
        let export = write_export(temp.path(), SESSION_ID);

        let error = import_opencode_session(
            &export,
            SESSION_ID,
            &temp.path().join("worktree"),
            &LiveLocalWorktrees::default(),
        )
        .expect_err("an unprovable absence was imported over");
        assert!(
            matches!(error, OpencodeImportError::Unavailable(_)),
            "{error:?}",
        );
    }

    /// The shipped conversation, found where the source left it, is re-keyed
    /// rather than refused.
    ///
    /// Both peers run on one machine in development and share a single OpenCode
    /// store, so the destination finds the very session it is importing — still
    /// keyed to the source worktree. Re-keying *that* one to the destination is
    /// what a transfer means; refusing it drops the conversation the whole
    /// artifact exists to carry. The export names the directory it was taken
    /// from, which is what tells it apart from a stranger's session.
    #[test]
    fn the_shipped_conversation_is_rekeyed_rather_than_refused() {
        let temp = tempfile::tempdir().expect("temp");
        let source_worktree = temp.path().join("source");
        std::fs::create_dir_all(&source_worktree).expect("source worktree");
        let resolved_source = source_worktree.canonicalize().expect("resolved source");

        let stub = StubOpencode::responding(&format!(
            r#"printf '%s\n' "$*" >> "$(dirname "$0")/calls"
case "$1" in
  export) printf '{{"info":{{"id":"%s","directory":"{}"}}}}' "$2" ;;
esac"#,
            resolved_source.display(),
        ));
        // The export carries the same directory the local store reports, which
        // is what makes them the same conversation.
        let export = temp.path().join("export.json");
        std::fs::write(
            &export,
            serde_json::json!({
                "info": { "id": SESSION_ID, "directory": resolved_source.to_string_lossy() },
                "messages": [],
            })
            .to_string(),
        )
        .expect("write export");

        import_opencode_session(
            &export,
            SESSION_ID,
            &temp.path().join("destination"),
            &LiveLocalWorktrees::default(),
        )
        .expect("the shipped conversation was refused as a collision");
        assert!(
            stub.calls().iter().any(|call| call.starts_with("import")),
            "the re-key never ran: {:?}",
            stub.calls(),
        );
    }

    /// The case that distinguishes the guard from no guard: a peer replaying
    /// the directory it was told.
    ///
    /// Every value the arm above reads is one the peer holds verbatim once this
    /// machine has shipped it that session — the export it received carried
    /// `info.id` and `info.directory`. So a paired peer can push the task back
    /// with the same id and a replayed directory. If the directory alone
    /// authorized the re-key, `opencode import` would pull *this* operator's
    /// live session out of the worktree its task is working in and splice it
    /// onto a task running the peer's prompt: the local task silently loses its
    /// resume, and the peer's task resumes a conversation it was never part of.
    ///
    /// The worktree table is what the peer cannot assert, so the same replay
    /// against a session sitting in one of this instance's open-task worktrees
    /// is the ordinary collision instead.
    #[test]
    fn a_peer_replaying_a_directory_it_was_shipped_cannot_rekey_a_live_local_session() {
        let temp = tempfile::tempdir().expect("temp");
        let live_worktree = temp.path().join("live-local-task");
        std::fs::create_dir_all(&live_worktree).expect("live worktree");
        let resolved_live = live_worktree.canonicalize().expect("resolved live");

        // This machine's store holds the session, keyed to a worktree one of
        // its own open tasks is using.
        let stub = StubOpencode::responding(&format!(
            r#"printf '%s\n' "$*" >> "$(dirname "$0")/calls"
case "$1" in
  export) printf '{{"info":{{"id":"%s","directory":"{}"}}}}' "$2" ;;
esac"#,
            resolved_live.display(),
        ));
        // The peer's export replays exactly what it was shipped, so the
        // directory comparison the arm used to rest on matches.
        let export = temp.path().join("export.json");
        std::fs::write(
            &export,
            serde_json::json!({
                "info": { "id": SESSION_ID, "directory": resolved_live.to_string_lossy() },
                "messages": [],
            })
            .to_string(),
        )
        .expect("write export");

        let error = import_opencode_session(
            &export,
            SESSION_ID,
            &temp.path().join("destination"),
            &LiveLocalWorktrees::new([live_worktree.clone()]),
        )
        .expect_err("a replayed directory re-keyed a live local session");
        assert!(
            matches!(error, OpencodeImportError::DestinationExists(_)),
            "{error:?}",
        );
        assert!(
            stub.calls().iter().all(|call| !call.starts_with("import")),
            "the import ran over a live local session: {:?}",
            stub.calls(),
        );

        // Same replay, same directory — but no open task of this instance's is
        // working there, which is the shared-store case the arm exists for.
        import_opencode_session(
            &export,
            SESSION_ID,
            &temp.path().join("destination"),
            &LiveLocalWorktrees::new([temp.path().join("some-other-task")]),
        )
        .expect("the shared-store re-key was refused");
        assert!(
            stub.calls().iter().any(|call| call.starts_with("import")),
            "the re-key never ran: {:?}",
            stub.calls(),
        );
    }

    /// The same shape with a *different* directory is the collision the guard
    /// exists for: an unrelated local conversation that happens to share an id
    /// must not be yanked out of its worktree.
    #[test]
    fn a_session_at_an_unrelated_directory_is_still_refused() {
        let temp = tempfile::tempdir().expect("temp");
        let stub = StubOpencode::responding(
            r#"printf '%s\n' "$*" >> "$(dirname "$0")/calls"
case "$1" in
  export) printf '{"info":{"id":"%s","directory":"/somebody/elses/worktree"}}' "$2" ;;
esac"#,
        );
        let export = temp.path().join("export.json");
        std::fs::write(
            &export,
            serde_json::json!({
                "info": { "id": SESSION_ID, "directory": "/where/the/source/had/it" },
                "messages": [],
            })
            .to_string(),
        )
        .expect("write export");

        let error = import_opencode_session(
            &export,
            SESSION_ID,
            &temp.path().join("destination"),
            &LiveLocalWorktrees::default(),
        )
        .expect_err("an unrelated conversation was re-keyed");
        assert!(
            matches!(error, OpencodeImportError::DestinationExists(_)),
            "{error:?}",
        );
        assert!(
            stub.calls().iter().all(|call| !call.starts_with("import")),
            "the import ran over an unrelated session: {:?}",
            stub.calls(),
        );
    }

    /// A session already keyed to *this* destination is this transfer's own
    /// earlier attempt, not a collision. Re-keying it where it already points
    /// changes nothing, so the import reports success and the retry keeps the
    /// conversation it already imported.
    #[test]
    fn a_session_already_at_this_destination_is_our_own_completed_import() {
        let temp = tempfile::tempdir().expect("temp");
        let worktree = temp.path().join("worktree");
        std::fs::create_dir_all(&worktree).expect("worktree");
        let resolved = worktree.canonicalize().expect("resolved");
        let stub = StubOpencode::responding(&format!(
            r#"printf '%s\n' "$*" >> "$(dirname "$0")/calls"
case "$1" in
  export) printf '{{"info":{{"id":"%s","directory":"{}"}}}}' "$2" ;;
esac"#,
            resolved.display(),
        ));
        let export = write_export(temp.path(), SESSION_ID);

        import_opencode_session(
            &export,
            SESSION_ID,
            &worktree,
            &LiveLocalWorktrees::default(),
        )
        .expect("our own prior import was reported as a collision");
        assert!(
            stub.calls().iter().all(|call| !call.starts_with("import")),
            "an already-imported session was imported again: {:?}",
            stub.calls(),
        );
    }

    /// OpenCode's store is one shared SQLite file that many agents write, and
    /// `import` exits non-zero while another holds the write lock. Failing the
    /// transfer permanently for that — after finalization has already shut down
    /// the source agent — throws a conversation away over a lock that clears in
    /// seconds, so it is `Unavailable` and stays inside the retry budget.
    #[test]
    fn a_locked_store_is_unavailable_rather_than_a_refusal() {
        let _stub = StubOpencode::responding(
            r#"case "$1" in
  export) printf '\033[91m\033[1mError: \033[0mSession not found: %s\n' "$2" >&2; exit 1 ;;
  session) exit 0 ;;
  import) echo "SqliteError: database is locked" >&2; exit 1 ;;
esac"#,
        );
        let temp = tempfile::tempdir().expect("temp");
        let export = write_export(temp.path(), SESSION_ID);

        let error = import_opencode_session(
            &export,
            SESSION_ID,
            &temp.path().join("worktree"),
            &LiveLocalWorktrees::default(),
        )
        .expect_err("a locked store reported success");
        assert!(
            matches!(error, OpencodeImportError::Unavailable(_)),
            "{error:?}",
        );
    }

    #[test]
    fn a_clean_import_runs_in_the_destination_worktree() {
        let stub = StubOpencode::responding(
            r#"printf '%s\n' "$PWD|$*" >> "$(dirname "$0")/calls"
case "$1" in
  export) printf '\033[91m\033[1mError: \033[0mSession not found: %s\n' "$2" >&2; exit 1 ;;
  session) exit 0 ;;
esac"#,
        );
        let temp = tempfile::tempdir().expect("temp");
        let export = write_export(temp.path(), SESSION_ID);
        let worktree = temp.path().join("worktree");

        import_opencode_session(
            &export,
            SESSION_ID,
            &worktree,
            &LiveLocalWorktrees::default(),
        )
        .expect("import");

        let resolved = worktree.canonicalize().expect("resolved worktree");
        let import_call = stub
            .calls()
            .into_iter()
            .find(|call| call.contains("|import "))
            .expect("the import ran");
        // Running anywhere else makes `opencode run --session <id>` a silent
        // no-op, because OpenCode resumes by matching the recorded directory.
        assert!(
            import_call.starts_with(&format!("{}|", resolved.display())),
            "{import_call}",
        );
    }

    /// A shape check the payload validator already applies, repeated here
    /// because this function is also reachable from a persisted payload.
    #[test]
    fn an_export_without_a_usable_session_id_is_refused() {
        let temp = tempfile::tempdir().expect("temp");
        for body in [
            serde_json::json!({ "messages": [] }),
            serde_json::json!({ "info": {} }),
            serde_json::json!({ "info": { "id": "not-a-session-id" } }),
        ] {
            let path = temp.path().join("export.json");
            std::fs::write(&path, body.to_string()).expect("write export");
            assert!(
                read_opencode_export_identity(&path).is_err(),
                "{body} was accepted",
            );
        }
    }
}
