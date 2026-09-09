use kanna_runtime_defaults::database_access;
use std::path::Path;

/// Only the server-owned cleanup step returns to the server's task identity.
/// Repo teardown still runs with build_spawn_env's isolation markers. Check
/// permission here before restoring anything; the child checks again at open.
pub(crate) fn cleanup_shell_command(
    executable: &str,
    db_path: &str,
    repo_path: &str,
    task_id: &str,
) -> String {
    let mut environment = String::new();
    if database_access::check(Path::new(db_path), false).is_ok() {
        environment.push_str("/usr/bin/env -u KANNA_TASK_ID -u KANNA_WORKTREE");
        for key in [
            "KANNA_TASK_ID",
            "KANNA_WORKTREE",
            database_access::DESKTOP_ACCESS_ENV,
        ] {
            if let Ok(value) = std::env::var(key) {
                environment.push_str(&format!(" '{}={}'", quote(key), quote(&value)));
            }
        }
        environment.push(' ');
    }
    format!(
        "cd '{}' && {environment}'{}' worktree-cleanup '{}' '{}'",
        quote(repo_path),
        quote(executable),
        quote(db_path),
        quote(task_id)
    )
}

fn quote(value: &str) -> String {
    value.replace('\'', "'\\''")
}
