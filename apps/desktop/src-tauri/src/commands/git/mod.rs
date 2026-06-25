pub mod clone;
pub mod diff;
pub mod log;
pub mod remote;
pub mod worktree;

use git2::Repository;

fn discover_repo(repo_path: &str) -> Result<Repository, String> {
    Repository::discover(repo_path).map_err(|e| e.to_string())
}

fn diff_to_patch(diff: git2::Diff<'_>) -> Result<String, String> {
    let mut output = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        match origin {
            '+' | '-' | ' ' => output.push(origin as u8),
            _ => {}
        }
        output.extend_from_slice(line.content());
        true
    })
    .map_err(|e| e.to_string())?;

    String::from_utf8(output).map_err(|e| e.to_string())
}

// --- CLI-based commands (use system git for auth) ---

fn read_process_cwd_for_diagnostics() -> String {
    match std::env::current_dir() {
        Ok(path) => path.display().to_string(),
        Err(error) => format!("<unavailable: {}>", error),
    }
}

fn format_git_command_failure(
    command_label: &str,
    repo_path: &str,
    args: &[String],
    process_cwd: String,
    stderr: String,
) -> String {
    let rendered_args = args.join(" ");
    let stderr = stderr.trim();
    format!(
        "{command_label} failed: repo_path={repo_path}; process_cwd={process_cwd}; args={rendered_args}; stderr={stderr}"
    )
}

#[cfg(test)]
mod test_support {
    use git2::{Repository, Signature};
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    pub struct TempRepo {
        pub path: PathBuf,
    }

    impl TempRepo {
        pub fn new(prefix: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should be monotonic")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kanna-git-base-branches-{}-{}-{}",
                prefix,
                std::process::id(),
                unique
            ));
            fs::create_dir_all(&path).expect("temp repo dir should be created");
            Self { path }
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    pub fn create_commit(repo: &Repository, repo_path: &Path) -> git2::Oid {
        fs::write(repo_path.join("README.md"), "test\n").expect("seed file should be written");

        let mut index = repo.index().expect("index should open");
        index
            .add_path(Path::new("README.md"))
            .expect("file should be added to index");
        let tree_id = index.write_tree().expect("tree should be written");
        let tree = repo.find_tree(tree_id).expect("tree should exist");
        let signature =
            Signature::now("Kanna Tests", "tests@kanna.dev").expect("signature should build");

        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("initial commit should succeed")
    }
}

#[cfg(test)]
mod tests {
    use super::format_git_command_failure;

    #[test]
    fn format_git_command_failure_includes_repo_and_process_context() {
        let args = vec![
            "worktree".to_string(),
            "add".to_string(),
            "/repo/.kanna-worktrees/task-2".to_string(),
        ];

        let message = format_git_command_failure(
            "git worktree add",
            "/repo",
            &args,
            "/app/cwd".to_string(),
            "fatal: Unable to read current working directory: Operation not permitted".to_string(),
        );

        assert!(message.contains("git worktree add failed"));
        assert!(message.contains("repo_path=/repo"));
        assert!(message.contains("process_cwd=/app/cwd"));
        assert!(message.contains("args=worktree add /repo/.kanna-worktrees/task-2"));
        assert!(message.contains(
            "stderr=fatal: Unable to read current working directory: Operation not permitted"
        ));
    }
}
