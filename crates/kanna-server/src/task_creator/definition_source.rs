use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug)]
pub(crate) struct RepoDefinitionSnapshot {
    repo_path: PathBuf,
    ref_name: String,
    commit_id: Option<String>,
}

#[derive(Debug)]
struct GitTreeEntry {
    kind: String,
    object_id: String,
}

impl RepoDefinitionSnapshot {
    pub(crate) fn resolve(
        repo_path: impl AsRef<Path>,
        default_branch: Option<&str>,
    ) -> Result<Self, String> {
        let repo_path = repo_path.as_ref().to_path_buf();
        let branch = default_branch
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .unwrap_or("main");
        let ref_name = format!("origin/{branch}");

        match Command::new("git")
            .args(["fetch", "origin"])
            .current_dir(&repo_path)
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
        } else {
            None
        };

        Ok(Self {
            repo_path,
            ref_name,
            commit_id,
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
        let relative_path = validate_relative_path(relative_path.as_ref())?;
        let Some(commit_id) = self.commit_id.as_deref() else {
            return Ok(None);
        };
        let object_context = format!("{commit_id}:{relative_path}");
        let Some(entry) = self.lookup_entry(commit_id, &relative_path)? else {
            return Ok(None);
        };
        if entry.kind != "blob" {
            return Err(format!(
                "Git object `{object_context}` is a {}, not a blob",
                entry.kind
            ));
        }

        let output = Command::new("git")
            .args(["cat-file", "blob", entry.object_id.as_str()])
            .current_dir(&self.repo_path)
            .output()
            .map_err(|error| {
                format!(
                    "failed to read Git object `{object_context}` in repository `{}`: {error}",
                    self.repo_path.display()
                )
            })?;
        if !output.status.success() {
            return Err(format_git_failure(
                "read",
                &object_context,
                &self.repo_path,
                &output,
            ));
        }

        String::from_utf8(output.stdout)
            .map(Some)
            .map_err(|error| format!("Git blob `{object_context}` is not valid UTF-8: {error}"))
    }

    pub(crate) fn list_direct_entries(
        &self,
        relative_tree: impl AsRef<Path>,
    ) -> Result<Vec<String>, String> {
        let relative_tree = validate_relative_path(relative_tree.as_ref())?;
        let Some(commit_id) = self.commit_id.as_deref() else {
            return Ok(Vec::new());
        };
        let object_context = format!("{commit_id}:{relative_tree}");
        let Some(entry) = self.lookup_entry(commit_id, &relative_tree)? else {
            return Ok(Vec::new());
        };
        if entry.kind != "tree" {
            return Err(format!(
                "Git object `{object_context}` is a {}, not a tree",
                entry.kind
            ));
        }

        let output = Command::new("git")
            .args(["ls-tree", "-z", "--name-only", entry.object_id.as_str()])
            .current_dir(&self.repo_path)
            .output()
            .map_err(|error| {
                format!(
                    "failed to list Git tree `{object_context}` in repository `{}`: {error}",
                    self.repo_path.display()
                )
            })?;
        if !output.status.success() {
            return Err(format_git_failure(
                "list",
                &object_context,
                &self.repo_path,
                &output,
            ));
        }

        output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
            .map(|name| {
                String::from_utf8(name.to_vec()).map_err(|error| {
                    format!("Git tree `{object_context}` contains a non-UTF-8 entry name: {error}")
                })
            })
            .collect()
    }

    fn lookup_entry(
        &self,
        commit_id: &str,
        relative_path: &str,
    ) -> Result<Option<GitTreeEntry>, String> {
        let object_context = format!("{commit_id}:{relative_path}");
        let literal_pathspec = format!(":(literal){relative_path}");
        let output = Command::new("git")
            .args([
                "ls-tree",
                "-z",
                "--full-tree",
                commit_id,
                "--",
                literal_pathspec.as_str(),
            ])
            .current_dir(&self.repo_path)
            .output()
            .map_err(|error| {
                format!(
                    "failed to inspect Git object `{object_context}` in repository `{}`: {error}",
                    self.repo_path.display()
                )
            })?;
        if !output.status.success() {
            return Err(format_git_failure(
                "inspect",
                &object_context,
                &self.repo_path,
                &output,
            ));
        }

        let mut encoded_entries = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty());
        let Some(encoded_entry) = encoded_entries.next() else {
            return Ok(None);
        };
        if encoded_entries.next().is_some() {
            return Err(format!(
                "Git lookup for `{object_context}` returned multiple entries"
            ));
        }

        let tab_index = encoded_entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| format!("Git lookup for `{object_context}` returned malformed data"))?;
        let header = std::str::from_utf8(&encoded_entry[..tab_index]).map_err(|error| {
            format!("Git lookup for `{object_context}` returned a malformed header: {error}")
        })?;
        let mut fields = header.split_ascii_whitespace();
        let _mode = fields.next();
        let kind = fields.next();
        let object_id = fields.next();
        if _mode.is_none() || kind.is_none() || object_id.is_none() || fields.next().is_some() {
            return Err(format!(
                "Git lookup for `{object_context}` returned malformed metadata `{header}`"
            ));
        }

        let encoded_path = &encoded_entry[tab_index + 1..];
        if encoded_path != relative_path.as_bytes() {
            return Err(format!(
                "Git lookup for `{object_context}` unexpectedly returned path `{}`",
                String::from_utf8_lossy(encoded_path)
            ));
        }

        Ok(Some(GitTreeEntry {
            kind: kind.unwrap().to_string(),
            object_id: object_id.unwrap().to_string(),
        }))
    }
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
    use super::RepoDefinitionSnapshot;
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

        let snapshot = RepoDefinitionSnapshot::resolve(&fixture.consumer, Some("main")).unwrap();

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
    fn resolve_treats_default_branch_as_an_exact_remote_ref() {
        let fixture = GitFixture::new();
        fixture.publish_config("remote-v2");

        let snapshot = RepoDefinitionSnapshot::resolve(&fixture.consumer, Some("main~1")).unwrap();

        assert_eq!(snapshot.ref_name(), "origin/main~1");
        assert_eq!(snapshot.revision(), None);
        assert_eq!(
            snapshot.read_optional_utf8(".kanna/config.json").unwrap(),
            None
        );
    }

    #[test]
    fn resolve_reports_non_git_directories_instead_of_treating_them_as_bundled_only() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("not-a-repository");
        std::fs::create_dir(&directory).unwrap();

        let error = RepoDefinitionSnapshot::resolve(&directory, Some("main")).unwrap_err();

        assert!(error.contains("origin/main"), "{error}");
        assert!(error.contains(&directory.display().to_string()), "{error}");
        assert!(error.contains("status"), "{error}");
        assert!(error.contains("not a git repository"), "{error}");
    }

    #[test]
    fn one_snapshot_stays_pinned_when_origin_advances() {
        let fixture = GitFixture::new();
        let first = RepoDefinitionSnapshot::resolve(&fixture.consumer, Some("main")).unwrap();

        fixture.publish_config("remote-v2");
        let second = RepoDefinitionSnapshot::resolve(&fixture.consumer, Some("main")).unwrap();

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

        let cached = RepoDefinitionSnapshot::resolve(&fixture.consumer, Some("main")).unwrap();

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

        let bundled_only = RepoDefinitionSnapshot::resolve(&local_only, Some("main")).unwrap();

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
            let snapshot =
                RepoDefinitionSnapshot::resolve(&fixture.consumer, default_branch).unwrap();
            assert_eq!(snapshot.ref_name(), "origin/main");
            assert!(snapshot.revision().is_some());
        }
    }

    #[test]
    fn path_validation_rejects_absolute_empty_parent_and_non_normal_components() {
        let fixture = GitFixture::new();
        let snapshot = RepoDefinitionSnapshot::resolve(&fixture.consumer, Some("main")).unwrap();

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

        let snapshot = RepoDefinitionSnapshot::resolve(&fixture.consumer, Some("main")).unwrap();

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
    fn non_utf8_blobs_return_a_clear_error() {
        let fixture = GitFixture::new();
        std::fs::write(
            fixture.publisher.join(".kanna/config.json"),
            [0xff, 0xfe, 0xfd],
        )
        .unwrap();
        fixture.publish_changes("publish non-utf8 config");
        let snapshot = RepoDefinitionSnapshot::resolve(&fixture.consumer, Some("main")).unwrap();

        let error = snapshot
            .read_optional_utf8(".kanna/config.json")
            .unwrap_err();

        assert!(error.contains(".kanna/config.json"), "{error}");
        assert!(error.contains("UTF-8"), "{error}");
    }
}
