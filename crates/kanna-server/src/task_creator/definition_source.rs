use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

/// Every definition Kanna resolves lives under this directory, so a snapshot
/// loads that one subtree instead of reaching back into Git per file.
const DEFINITION_ROOT: &str = ".kanna";

/// How current `origin` must be before a snapshot is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OriginFreshness {
    /// Fetch `origin` first. Task creation and the other operations that pin a
    /// workflow or fork a workspace take this path: they commit the repo to a
    /// definition, so they must see the true remote tip and are allowed to wait
    /// for the network to say what it is.
    Fetch,
    /// Read the remote-tracking refs already on disk. Everything that only
    /// displays definitions reads this way, so no operator interaction ever
    /// waits on a network round trip.
    Local,
}

#[derive(Clone, Debug)]
pub(crate) struct RepoDefinitionSnapshot {
    ref_name: String,
    commit_id: Option<String>,
    tree: DefinitionTree,
}

/// The `.kanna` subtree of one commit, read by a single pair of Git
/// invocations. Reads used to shell out twice per file — a tree lookup plus a
/// blob read — so resolving one repo's definitions spawned ~20 `git` processes
/// every time, which is seconds of scheduling latency on a busy machine even
/// though the cached snapshot had already answered the same question.
#[derive(Clone, Debug, Default)]
struct DefinitionTree {
    /// Every entry path in Git's own tree order, so listings keep that order.
    paths: Vec<String>,
    kinds: HashMap<String, String>,
    blobs: HashMap<String, Vec<u8>>,
}

impl RepoDefinitionSnapshot {
    pub(crate) fn resolve(
        repo_path: impl AsRef<Path>,
        default_branch: Option<&str>,
        freshness: OriginFreshness,
    ) -> Result<Self, String> {
        let repo_path = repo_path.as_ref().to_path_buf();
        let branch = default_branch
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .unwrap_or("main");
        let ref_name = format!("origin/{branch}");

        if freshness == OriginFreshness::Fetch {
            fetch_origin(&repo_path);
        }

        let full_ref_name = format!("refs/remotes/origin/{branch}");
        let output = Command::new("git")
            .args([
                "for-each-ref",
                "--format=%(refname)%09%(objectname)",
                full_ref_name.as_str(),
            ])
            .current_dir(&repo_path)
            .output()
            .map_err(|error| {
                format!(
                    "failed to look up Git ref `{ref_name}` (`{full_ref_name}`) in repository `{}`: {error}",
                    repo_path.display()
                )
            })?;
        if !output.status.success() {
            return Err(format_git_ref_failure(
                "look up",
                &ref_name,
                &full_ref_name,
                &repo_path,
                &output,
            ));
        }

        let refs = String::from_utf8(output.stdout).map_err(|error| {
            format!(
                "Git ref lookup for `{ref_name}` (`{full_ref_name}`) in repository `{}` returned non-UTF-8 output: {error}",
                repo_path.display()
            )
        })?;
        let mut exact_oid = None;
        for line in refs.lines().filter(|line| !line.is_empty()) {
            let (candidate_ref, candidate_oid) = line.split_once('\t').ok_or_else(|| {
                format!(
                    "Git ref lookup for `{ref_name}` (`{full_ref_name}`) in repository `{}` returned malformed output `{line}`",
                    repo_path.display()
                )
            })?;
            if candidate_ref == full_ref_name {
                if exact_oid.replace(candidate_oid.to_string()).is_some() {
                    return Err(format!(
                        "Git ref lookup for `{ref_name}` (`{full_ref_name}`) in repository `{}` returned the exact ref more than once",
                        repo_path.display()
                    ));
                }
            }
        }

        let commit_id = if let Some(oid) = exact_oid {
            if oid.is_empty() {
                return Err(format!(
                    "Git ref `{ref_name}` (`{full_ref_name}`) in repository `{}` resolved to an empty object ID",
                    repo_path.display()
                ));
            }
            let commit_object = format!("{oid}^{{commit}}");
            let output = Command::new("git")
                .args(["rev-parse", "--verify", commit_object.as_str()])
                .current_dir(&repo_path)
                .output()
                .map_err(|error| {
                    format!(
                        "failed to peel Git ref `{ref_name}` (`{full_ref_name}` at `{oid}`) to a commit in repository `{}`: {error}",
                        repo_path.display()
                    )
                })?;
            if !output.status.success() {
                return Err(format_git_ref_failure(
                    "peel to a commit",
                    &ref_name,
                    &format!("{full_ref_name} at {oid}"),
                    &repo_path,
                    &output,
                ));
            }
            let revision = String::from_utf8(output.stdout).map_err(|error| {
                format!(
                    "Git ref `{ref_name}` (`{full_ref_name}`) in repository `{}` resolved to non-UTF-8 commit output: {error}",
                    repo_path.display()
                )
            })?;
            let revision = revision.trim();
            if revision.is_empty() {
                return Err(format!(
                    "Git ref `{ref_name}` (`{full_ref_name}`) in repository `{}` resolved to an empty commit ID",
                    repo_path.display()
                ));
            }
            Some(revision.to_string())
        } else if has_any_remote(&repo_path)? {
            return Err(format!(
                "recorded default-branch snapshot `{ref_name}` (`{full_ref_name}`) does not exist in repository `{}`; reconcile the repository metadata before resolving definitions",
                repo_path.display()
            ));
        } else {
            None
        };

        let tree = match commit_id.as_deref() {
            Some(commit_id) => load_definition_tree(&repo_path, commit_id)?,
            None => DefinitionTree::default(),
        };

        Ok(Self {
            ref_name,
            commit_id,
            tree,
        })
    }

    pub(crate) fn revision(&self) -> Option<&str> {
        self.commit_id.as_deref()
    }

    pub(crate) fn ref_name(&self) -> &str {
        &self.ref_name
    }

    pub(crate) fn read_optional_utf8(
        &self,
        relative_path: impl AsRef<Path>,
    ) -> Result<Option<String>, String> {
        let relative_path = validate_definition_path(relative_path.as_ref())?;
        let Some(commit_id) = self.commit_id.as_deref() else {
            return Ok(None);
        };
        let object_context = format!("{commit_id}:{relative_path}");
        let Some(kind) = self.tree.kinds.get(&relative_path) else {
            return Ok(None);
        };
        if kind != "blob" {
            return Err(format!(
                "Git object `{object_context}` is a {kind}, not a blob"
            ));
        }
        let contents = self
            .tree
            .blobs
            .get(&relative_path)
            .ok_or_else(|| format!("Git blob `{object_context}` was listed but never read"))?;

        String::from_utf8(contents.clone())
            .map(Some)
            .map_err(|error| format!("Git blob `{object_context}` is not valid UTF-8: {error}"))
    }

    pub(crate) fn list_direct_entries(
        &self,
        relative_tree: impl AsRef<Path>,
    ) -> Result<Vec<String>, String> {
        let relative_tree = validate_definition_path(relative_tree.as_ref())?;
        let Some(commit_id) = self.commit_id.as_deref() else {
            return Ok(Vec::new());
        };
        let object_context = format!("{commit_id}:{relative_tree}");
        let Some(kind) = self.tree.kinds.get(&relative_tree) else {
            return Ok(Vec::new());
        };
        if kind != "tree" {
            return Err(format!(
                "Git object `{object_context}` is a {kind}, not a tree"
            ));
        }

        let prefix = format!("{relative_tree}/");
        Ok(self
            .tree
            .paths
            .iter()
            .filter_map(|path| path.strip_prefix(prefix.as_str()))
            .filter(|name| !name.contains('/'))
            .map(str::to_string)
            .collect())
    }
}

fn has_any_remote(repo_path: &Path) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("remote")
        .current_dir(repo_path)
        .output()
        .map_err(|error| {
            format!(
                "failed to list Git remotes in `{}`: {error}",
                repo_path.display()
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "failed to list Git remotes in `{}` (status {}): {}",
            repo_path.display(),
            output.status,
            command_stderr(&output)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|remote| !remote.trim().is_empty()))
}

/// Update the remote-tracking refs definitions resolve against. A failure is
/// logged rather than raised: the refs already on disk remain a usable answer,
/// and refusing to resolve because the network is down would strand the repo.
pub(crate) fn fetch_origin(repo_path: &Path) {
    match Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(repo_path)
        .output()
    {
        Ok(output) if !output.status.success() => {
            log::warn!(
                "failed to fetch definitions from origin in {} (status {}): {}",
                repo_path.display(),
                output.status,
                command_stderr(&output)
            );
        }
        Err(error) => {
            log::warn!(
                "failed to run git fetch origin for definitions in {}: {error}",
                repo_path.display()
            );
        }
        Ok(_) => {}
    }
}

/// Read `.kanna` at one commit with two Git invocations: the recursive listing
/// that names every entry, then one batched read of every blob it named.
fn load_definition_tree(repo_path: &Path, commit_id: &str) -> Result<DefinitionTree, String> {
    let object_context = format!("{commit_id}:{DEFINITION_ROOT}");
    let literal_pathspec = format!(":(literal){DEFINITION_ROOT}");
    let output = Command::new("git")
        .args([
            "ls-tree",
            "-r",
            "-t",
            "-z",
            "--full-tree",
            commit_id,
            "--",
            literal_pathspec.as_str(),
        ])
        .current_dir(repo_path)
        .output()
        .map_err(|error| {
            format!(
                "failed to list Git tree `{object_context}` in repository `{}`: {error}",
                repo_path.display()
            )
        })?;
    if !output.status.success() {
        return Err(format_git_failure(
            "list",
            &object_context,
            repo_path,
            &output,
        ));
    }

    let mut paths = Vec::new();
    let mut kinds = HashMap::new();
    let mut blob_object_ids: Vec<(String, String)> = Vec::new();
    for encoded_entry in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let (kind, object_id, path) = parse_tree_entry(&object_context, encoded_entry)?;
        if kind == "blob" {
            blob_object_ids.push((path.clone(), object_id));
        }
        kinds.insert(path.clone(), kind);
        paths.push(path);
    }

    let blobs = read_blobs(repo_path, &object_context, &blob_object_ids)?;
    Ok(DefinitionTree {
        paths,
        kinds,
        blobs,
    })
}

/// One `<mode> <type> <object-id>\t<path>` record from `git ls-tree -z`.
fn parse_tree_entry(
    object_context: &str,
    encoded_entry: &[u8],
) -> Result<(String, String, String), String> {
    let tab_index = encoded_entry
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| format!("Git listing for `{object_context}` returned malformed data"))?;
    let header = std::str::from_utf8(&encoded_entry[..tab_index]).map_err(|error| {
        format!("Git listing for `{object_context}` returned a malformed header: {error}")
    })?;
    let mut fields = header.split_ascii_whitespace();
    let (Some(_mode), Some(kind), Some(object_id), None) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return Err(format!(
            "Git listing for `{object_context}` returned malformed metadata `{header}`"
        ));
    };

    let path = std::str::from_utf8(&encoded_entry[tab_index + 1..]).map_err(|error| {
        format!("Git listing for `{object_context}` returned a non-UTF-8 path: {error}")
    })?;

    Ok((kind.to_string(), object_id.to_string(), path.to_string()))
}

/// Read every listed blob through one `git cat-file --batch`. Object ids are
/// written from their own thread: Git stops reading requests once its output
/// pipe fills, so writing and reading from this thread would deadlock on a
/// definition tree larger than a pipe buffer.
fn read_blobs(
    repo_path: &Path,
    object_context: &str,
    blobs: &[(String, String)],
) -> Result<HashMap<String, Vec<u8>>, String> {
    if blobs.is_empty() {
        return Ok(HashMap::new());
    }

    let mut requested = HashSet::new();
    let request: String = blobs
        .iter()
        .filter(|(_, object_id)| requested.insert(object_id.clone()))
        .map(|(_, object_id)| format!("{object_id}\n"))
        .collect();

    let mut child = Command::new("git")
        .args(["cat-file", "--batch"])
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "failed to read Git objects for `{object_context}` in repository `{}`: {error}",
                repo_path.display()
            )
        })?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        format!("Git object read for `{object_context}` did not provide a request pipe")
    })?;
    let writer = std::thread::spawn(move || stdin.write_all(request.as_bytes()));

    let output = child.wait_with_output().map_err(|error| {
        format!(
            "failed to read Git objects for `{object_context}` in repository `{}`: {error}",
            repo_path.display()
        )
    })?;
    let write_result = writer.join().map_err(|_| {
        format!("Git object read for `{object_context}` lost its request writer to a panic")
    })?;
    if !output.status.success() {
        return Err(format_git_failure(
            "read",
            object_context,
            repo_path,
            &output,
        ));
    }
    write_result.map_err(|error| {
        format!(
            "failed to request Git objects for `{object_context}` in repository `{}`: {error}",
            repo_path.display()
        )
    })?;

    let contents = parse_batch_objects(object_context, &output.stdout)?;
    blobs
        .iter()
        .map(|(path, object_id)| {
            contents
                .get(object_id)
                .map(|content| (path.clone(), content.clone()))
                .ok_or_else(|| {
                    format!(
                        "Git object read for `{object_context}` did not return `{object_id}` for `{path}`"
                    )
                })
        })
        .collect()
}

/// `git cat-file --batch` answers each request with `<oid> <type> <size>\n`,
/// then exactly `size` bytes, then a newline.
fn parse_batch_objects(
    object_context: &str,
    mut stdout: &[u8],
) -> Result<HashMap<String, Vec<u8>>, String> {
    let malformed = || format!("Git object read for `{object_context}` returned malformed data");
    let mut contents = HashMap::new();
    while !stdout.is_empty() {
        let newline_index = stdout
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(malformed)?;
        let header = std::str::from_utf8(&stdout[..newline_index]).map_err(|_| malformed())?;
        let mut fields = header.split_ascii_whitespace();
        let (Some(object_id), Some(_kind), Some(size)) =
            (fields.next(), fields.next(), fields.next())
        else {
            return Err(format!(
                "Git object read for `{object_context}` reported `{header}`"
            ));
        };
        let size: usize = size.parse().map_err(|_| malformed())?;

        let body_start = newline_index + 1;
        let body_end = body_start.checked_add(size).ok_or_else(malformed)?;
        if stdout.len() <= body_end {
            return Err(malformed());
        }
        contents.insert(object_id.to_string(), stdout[body_start..body_end].to_vec());
        stdout = &stdout[body_end + 1..];
    }
    Ok(contents)
}

/// Definition reads are confined to the subtree the snapshot loaded, so a path
/// outside it fails loudly instead of silently reading as absent.
fn validate_definition_path(relative_path: &Path) -> Result<String, String> {
    let relative_path = validate_relative_path(relative_path)?;
    if relative_path == DEFINITION_ROOT || relative_path.starts_with(&format!("{DEFINITION_ROOT}/"))
    {
        return Ok(relative_path);
    }
    Err(format!(
        "definition path `{relative_path}` must live under `{DEFINITION_ROOT}/`"
    ))
}

fn validate_relative_path(relative_path: &Path) -> Result<String, String> {
    let mut saw_component = false;
    let mut canonical_path = PathBuf::new();
    for component in relative_path.components() {
        match component {
            Component::Normal(value) => canonical_path.push(value),
            _ => return Err(invalid_path_error(relative_path)),
        }
        saw_component = true;
    }
    if !saw_component || canonical_path.as_os_str() != relative_path.as_os_str() {
        return Err(invalid_path_error(relative_path));
    }

    relative_path.to_str().map(str::to_string).ok_or_else(|| {
        format!(
            "definition path `{}` is not valid UTF-8",
            relative_path.display()
        )
    })
}

fn invalid_path_error(relative_path: &Path) -> String {
    format!(
        "definition path `{}` must be a canonical nonempty relative path containing only normal components",
        relative_path.display()
    )
}

fn command_stderr(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        "no stderr output".to_string()
    } else {
        stderr.to_string()
    }
}

fn format_git_failure(
    action: &str,
    object_context: &str,
    repo_path: &Path,
    output: &std::process::Output,
) -> String {
    format!(
        "failed to {action} Git object `{object_context}` in repository `{}` (status {}): {}",
        repo_path.display(),
        output.status,
        command_stderr(output)
    )
}

fn format_git_ref_failure(
    action: &str,
    ref_name: &str,
    full_ref_name: &str,
    repo_path: &Path,
    output: &std::process::Output,
) -> String {
    format!(
        "failed to {action} Git ref `{ref_name}` (`{full_ref_name}`) in repository `{}` (status {}): {}",
        repo_path.display(),
        output.status,
        command_stderr(output)
    )
}

#[cfg(test)]
mod tests {
    use super::{OriginFreshness, RepoDefinitionSnapshot};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tempfile::TempDir;

    struct GitFixture {
        _temp: TempDir,
        origin: PathBuf,
        publisher: PathBuf,
        consumer: PathBuf,
    }

    impl GitFixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("create fixture tempdir");
            let origin = temp.path().join("origin.git");
            let publisher = temp.path().join("publisher");
            let consumer = temp.path().join("consumer");

            run_git(
                temp.path(),
                &[
                    "init",
                    "--bare",
                    "--initial-branch=main",
                    origin.to_str().unwrap(),
                ],
            );
            run_git(
                temp.path(),
                &[
                    "clone",
                    origin.to_str().unwrap(),
                    publisher.to_str().unwrap(),
                ],
            );
            run_git(&publisher, &["config", "user.email", "test@example.com"]);
            run_git(&publisher, &["config", "user.name", "Kanna Test"]);
            write_config(&publisher, "remote-v1");
            run_git(&publisher, &["add", ".kanna/config.json"]);
            run_git(&publisher, &["commit", "-m", "publish remote v1"]);
            run_git(&publisher, &["push", "-u", "origin", "main"]);
            run_git(
                temp.path(),
                &[
                    "clone",
                    origin.to_str().unwrap(),
                    consumer.to_str().unwrap(),
                ],
            );

            Self {
                _temp: temp,
                origin,
                publisher,
                consumer,
            }
        }

        fn publish_config(&self, content: &str) {
            write_config(&self.publisher, content);
            self.publish_changes(&format!("publish {content}"));
        }

        fn publish_changes(&self, message: &str) {
            run_git(&self.publisher, &["add", ".kanna"]);
            run_git(&self.publisher, &["commit", "-m", message]);
            run_git(&self.publisher, &["push", "origin", "main"]);
        }

        fn disconnect_consumer(&self) {
            let missing_origin = self.origin.with_file_name("disconnected-origin.git");
            run_git(
                &self.consumer,
                &[
                    "remote",
                    "set-url",
                    "origin",
                    missing_origin.to_str().unwrap(),
                ],
            );
        }
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn write_config(repo: &Path, content: &str) {
        std::fs::create_dir_all(repo.join(".kanna")).unwrap();
        std::fs::write(repo.join(".kanna/config.json"), content).unwrap();
    }

    #[test]
    fn resolve_fetches_origin_and_ignores_local_default_branch() {
        let fixture = GitFixture::new();
        fixture.publish_config("remote-v2");
        write_config(&fixture.consumer, "local-stale");

        let snapshot = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        assert_eq!(snapshot.ref_name(), "origin/main");
        assert!(snapshot
            .revision()
            .is_some_and(|revision| !revision.is_empty()));
        assert_eq!(
            snapshot.read_optional_utf8(".kanna/config.json").unwrap(),
            Some("remote-v2".to_string())
        );
    }

    #[test]
    fn resolve_rejects_a_recorded_branch_without_an_exact_remote_ref() {
        let fixture = GitFixture::new();
        fixture.publish_config("remote-v2");

        let error = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main~1"),
            OriginFreshness::Fetch,
        )
        .unwrap_err();

        assert!(error.contains("origin/main~1"), "{error}");
        assert!(error.contains("reconcile"), "{error}");
    }

    #[test]
    fn resolve_reports_non_git_directories_instead_of_treating_them_as_bundled_only() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("not-a-repository");
        std::fs::create_dir(&directory).unwrap();

        let error =
            RepoDefinitionSnapshot::resolve(&directory, Some("main"), OriginFreshness::Fetch)
                .unwrap_err();

        assert!(error.contains("origin/main"), "{error}");
        assert!(error.contains(&directory.display().to_string()), "{error}");
        assert!(error.contains("status"), "{error}");
        assert!(error.contains("not a git repository"), "{error}");
    }

    #[test]
    fn one_snapshot_stays_pinned_when_origin_advances() {
        let fixture = GitFixture::new();
        let first = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        fixture.publish_config("remote-v2");
        let second = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        assert_eq!(
            first.read_optional_utf8(".kanna/config.json").unwrap(),
            Some("remote-v1".to_string())
        );
        assert_eq!(
            second.read_optional_utf8(".kanna/config.json").unwrap(),
            Some("remote-v2".to_string())
        );
        assert_ne!(first.revision(), second.revision());
    }

    #[test]
    fn cached_remote_survives_fetch_failure_and_no_ref_is_bundled_only() {
        let fixture = GitFixture::new();
        fixture.disconnect_consumer();

        let cached = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        assert!(cached.revision().is_some());
        assert_eq!(
            cached.read_optional_utf8(".kanna/config.json").unwrap(),
            Some("remote-v1".to_string())
        );

        let local_only_temp = tempfile::tempdir().unwrap();
        let local_only = local_only_temp.path().join("local-only");
        std::fs::create_dir_all(&local_only).unwrap();
        run_git(&local_only, &["init", "--initial-branch=main"]);
        run_git(&local_only, &["config", "user.email", "test@example.com"]);
        run_git(&local_only, &["config", "user.name", "Kanna Test"]);
        write_config(&local_only, "local-only");
        run_git(&local_only, &["add", ".kanna/config.json"]);
        run_git(&local_only, &["commit", "-m", "local main definition"]);

        let bundled_only =
            RepoDefinitionSnapshot::resolve(&local_only, Some("main"), OriginFreshness::Fetch)
                .unwrap();

        assert_eq!(bundled_only.ref_name(), "origin/main");
        assert_eq!(bundled_only.revision(), None);
        assert_eq!(
            bundled_only
                .read_optional_utf8(".kanna/config.json")
                .unwrap(),
            None
        );
    }

    #[test]
    fn blank_default_branch_uses_main() {
        let fixture = GitFixture::new();

        for default_branch in [None, Some(""), Some(" \t")] {
            let snapshot = RepoDefinitionSnapshot::resolve(
                &fixture.consumer,
                default_branch,
                OriginFreshness::Fetch,
            )
            .unwrap();
            assert_eq!(snapshot.ref_name(), "origin/main");
            assert!(snapshot.revision().is_some());
        }
    }

    #[test]
    fn path_validation_rejects_absolute_empty_parent_and_non_normal_components() {
        let fixture = GitFixture::new();
        let snapshot = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        for invalid_path in [
            "",
            "/.kanna/config.json",
            "..",
            ".kanna/../config.json",
            "./.kanna/config.json",
            ".kanna/./config.json",
            ".kanna//config.json",
            ".kanna/config.json/",
        ] {
            let read_error = snapshot.read_optional_utf8(invalid_path).unwrap_err();
            assert!(
                read_error.contains("nonempty relative path")
                    && read_error.contains("normal components"),
                "unexpected read error for {invalid_path:?}: {read_error}"
            );

            let list_error = snapshot.list_direct_entries(invalid_path).unwrap_err();
            assert!(
                list_error.contains("nonempty relative path")
                    && list_error.contains("normal components"),
                "unexpected list error for {invalid_path:?}: {list_error}"
            );
        }
    }

    #[test]
    fn direct_tree_listing_uses_snapshot_and_missing_objects_are_empty() {
        let fixture = GitFixture::new();
        let agents = fixture.publisher.join(".kanna/agents");
        std::fs::create_dir_all(agents.join("nested")).unwrap();
        std::fs::write(agents.join("alpha.json"), "alpha").unwrap();
        std::fs::write(agents.join("beta.json"), "beta").unwrap();
        std::fs::write(agents.join("nested/child.json"), "child").unwrap();
        fixture.publish_changes("publish agent tree");

        let snapshot = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        assert_eq!(
            snapshot.list_direct_entries(".kanna/agents").unwrap(),
            vec![
                "alpha.json".to_string(),
                "beta.json".to_string(),
                "nested".to_string(),
            ]
        );
        assert_eq!(
            snapshot.list_direct_entries(".kanna/missing-tree").unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            snapshot.read_optional_utf8(".kanna/missing.json").unwrap(),
            None
        );
    }

    #[test]
    fn a_local_resolve_reads_the_refs_on_disk_without_fetching() {
        let fixture = GitFixture::new();
        // Published after the consumer cloned, so it is reachable at origin but
        // absent from the consumer's remote-tracking ref until something fetches.
        fixture.publish_config("remote-v2");

        let local = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Local,
        )
        .unwrap();

        // A fetching resolve answers `remote-v2` here — origin is reachable and
        // holds it. Reading `remote-v1` is what proves no fetch was run.
        assert_eq!(
            local.read_optional_utf8(".kanna/config.json").unwrap(),
            Some("remote-v1".to_string())
        );

        run_git(&fixture.consumer, &["fetch", "origin"]);
        let after_fetch = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Local,
        )
        .unwrap();

        assert_eq!(
            after_fetch
                .read_optional_utf8(".kanna/config.json")
                .unwrap(),
            Some("remote-v2".to_string())
        );
        assert_ne!(local.revision(), after_fetch.revision());
    }

    #[test]
    fn definition_reads_are_confined_to_the_definition_root() {
        let fixture = GitFixture::new();
        std::fs::write(fixture.publisher.join("README.md"), "outside").unwrap();
        run_git(&fixture.publisher, &["add", "README.md"]);
        fixture.publish_changes("publish a file outside the definition root");
        let snapshot = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        // The snapshot loads `.kanna` only, so anything else must fail loudly
        // rather than read as absent.
        let read_error = snapshot.read_optional_utf8("README.md").unwrap_err();
        assert!(
            read_error.contains("must live under `.kanna/`"),
            "{read_error}"
        );
        let list_error = snapshot.list_direct_entries("docs").unwrap_err();
        assert!(
            list_error.contains("must live under `.kanna/`"),
            "{list_error}"
        );
    }

    #[test]
    fn kind_mismatches_name_the_object_kind() {
        let fixture = GitFixture::new();
        std::fs::create_dir_all(fixture.publisher.join(".kanna/workflows")).unwrap();
        std::fs::write(fixture.publisher.join(".kanna/workflows/review.json"), "{}").unwrap();
        fixture.publish_changes("publish a workflow");
        let snapshot = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        let read_error = snapshot.read_optional_utf8(".kanna/workflows").unwrap_err();
        assert!(read_error.contains("is a tree, not a blob"), "{read_error}");
        let list_error = snapshot
            .list_direct_entries(".kanna/workflows/review.json")
            .unwrap_err();
        assert!(list_error.contains("is a blob, not a tree"), "{list_error}");
    }

    #[test]
    fn listings_keep_git_tree_order_when_a_name_collides_with_a_directory() {
        let fixture = GitFixture::new();
        let agents = fixture.publisher.join(".kanna/agents");
        std::fs::create_dir_all(agents.join("review")).unwrap();
        std::fs::write(agents.join("review/AGENT.md"), "nested").unwrap();
        std::fs::write(agents.join("review.md"), "sibling").unwrap();
        fixture.publish_changes("publish colliding agent names");

        let snapshot = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        // Git orders a tree as if its name ended in `/`, which puts
        // `review.md` before `review`; a plain sort of the names would not.
        assert_eq!(
            snapshot.list_direct_entries(".kanna/agents").unwrap(),
            vec!["review.md".to_string(), "review".to_string()],
        );
        assert_eq!(
            snapshot
                .read_optional_utf8(".kanna/agents/review/AGENT.md")
                .unwrap(),
            Some("nested".to_string())
        );
    }

    #[test]
    fn non_utf8_blobs_return_a_clear_error() {
        let fixture = GitFixture::new();
        std::fs::write(
            fixture.publisher.join(".kanna/config.json"),
            [0xff, 0xfe, 0xfd],
        )
        .unwrap();
        fixture.publish_changes("publish non-utf8 config");
        let snapshot = RepoDefinitionSnapshot::resolve(
            &fixture.consumer,
            Some("main"),
            OriginFreshness::Fetch,
        )
        .unwrap();

        let error = snapshot
            .read_optional_utf8(".kanna/config.json")
            .unwrap_err();

        assert!(error.contains(".kanna/config.json"), "{error}");
        assert!(error.contains("UTF-8"), "{error}");
    }
}
