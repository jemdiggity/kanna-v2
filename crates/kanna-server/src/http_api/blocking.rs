//! Blocking-boundary helper for HTTP handlers.
//!
//! Task lifecycle preparation and teardown run synchronous git, filesystem,
//! process, and SQLite work — definition resolution runs `git fetch origin`,
//! stage forks run `git worktree add` plus workspace setup, and SQLite waits
//! up to its 10s busy timeout. The same Tokio runtime carries every KSP
//! terminal stream; occupying its workers with that work freezes terminal
//! output and input across the app (frozen terminals, delayed echo). Every
//! handler section that can block must run through this boundary instead of
//! directly on a runtime worker.

/// Run synchronous handler work on the blocking pool, keeping runtime
/// workers free for streaming and I/O tasks. The label names the operation
/// in the worker-failure error surfaced to the client.
pub(super) async fn run_handler_blocking<T>(
    label: &'static str,
    work: impl FnOnce() -> Result<T, (axum::http::StatusCode, String)> + Send + 'static,
) -> Result<T, (axum::http::StatusCode, String)>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work).await.map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("{label} worker failed: {error}"),
        )
    })?
}
