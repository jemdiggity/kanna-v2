use std::path::Path;
use std::process::Command;

/// A base ref resolved against a worktree, including the merge base shared by
/// branch diffs and ahead/behind statistics.
pub(crate) struct ResolvedBaseRef {
    pub(crate) reference: String,
    pub(crate) merge_base: Option<String>,
}

/// Resolves a base branch remote-first so a missing or stale local branch
/// cannot mask the authoritative remote-tracking branch.
pub(crate) fn resolve_base_ref(root: &Path, base_ref: &str) -> Option<ResolvedBaseRef> {
    let candidates: Vec<String> =
        if base_ref.starts_with("origin/") || base_ref.starts_with("refs/") {
            vec![base_ref.to_string()]
        } else {
            vec![format!("origin/{base_ref}"), base_ref.to_string()]
        };
    for candidate in candidates {
        let resolved = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", "--verify", "--quiet"])
            .arg(format!("{candidate}^{{commit}}"))
            .output();
        if !resolved.is_ok_and(|output| output.status.success()) {
            continue;
        }
        let merge_base = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["merge-base", &candidate, "HEAD"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|merge_base| !merge_base.is_empty());
        return Some(ResolvedBaseRef {
            reference: candidate,
            merge_base,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn resolves_an_unrelated_ref_without_inventing_a_merge_base() {
        let temp_dir = tempfile::tempdir().expect("create git ref fixture");
        let root = temp_dir.path();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "user.name", "Test"]);
        std::fs::write(root.join("main.txt"), "main").expect("write main file");
        git(root, &["add", "main.txt"]);
        git(root, &["commit", "-m", "main"]);
        git(root, &["checkout", "--orphan", "unrelated"]);
        git(root, &["rm", "-rf", "."]);
        std::fs::write(root.join("unrelated.txt"), "unrelated").expect("write unrelated file");
        git(root, &["add", "unrelated.txt"]);
        git(root, &["commit", "-m", "unrelated"]);
        git(
            root,
            &["update-ref", "refs/remotes/origin/unrelated", "HEAD"],
        );
        git(root, &["checkout", "main"]);

        let resolved = resolve_base_ref(root, "unrelated").expect("resolve unrelated ref");
        assert_eq!(resolved.reference, "origin/unrelated");
        assert_eq!(resolved.merge_base, None);
    }
}
