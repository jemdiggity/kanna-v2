# Terminal Lifecycle Blocking Boundary Design

Follow-up to `2026-07-21-terminal-transport-runtime-starvation-design.md`. That
fix moved repository-definition HTTP lookups onto the blocking pool and
single-flighted the definition cache, but the user still reported delayed
agent terminal echo that "is affected by de-selecting and re-selecting the
task".

## Live production diagnosis

The remaining freezes were caught in the act on the staging instance
(v0.0.69-staging.2, which already contains the daemon fanout and the runtime
starvation fixes):

- The daemon's `terminal_perf` records show `attached_writer` stalls of
  9–38 seconds on the **selected** task's session: a single socket write to
  the kanna-server KSP attachment could not complete because the server
  stopped draining its daemon connection.
- An independent probe (a second KSP WebSocket client attached to the same
  task's terminal from a plain Node process) froze for the same window and
  recovered at the same millisecond as the desktop — proving the freeze is
  server-side, not a webview/renderer problem.
- A thread sample of kanna-server taken during a 9-second freeze shows the
  exact mechanism: one Tokio runtime worker was inside
  `axum::serve::handle_connection → complete_stage →
  task_creator::prepare_stage_completion_for_api → prepare_stage_run_spawn →
  environment::run_workspace_setup_commands → std::process::Command::output`,
  while every other worker sat parked **on a condvar** and *no thread was
  parked in `kevent`*: the busy worker held Tokio's IO driver, so no socket
  readiness was delivered anywhere in the process. Every KSP terminal stream,
  daemon connection, and WebSocket froze together until the setup command
  finished.

This explains the reported symptom precisely. Stage lifecycle work — a
`kanna-cli stage-complete` auto-advance, a mobile advance-stage, a revision —
runs synchronous git and process work (definition `git fetch origin`,
`git worktree add` forks, workspace setup/kanache warming, teardown prep) for
seconds to minutes. When any of it runs on a runtime worker, all server IO
can freeze for the duration. The user's deselect/reselect was a workaround:
by the time the terminal reattached, the lifecycle work had finished and the
fresh snapshot repainted the terminal, so reattaching *appeared* to fix it.

One blocked worker is sufficient — this is not a worker-count problem. A
worker that holds the IO driver while executing a blocking task stops IO for
the whole process, so the blocking boundary is mandatory at every entry
point, not merely advisable under load.

## Design

Continue the architecture the previous two fixes established: synchronous
git/filesystem/SQLite work never executes on a runtime worker.

1. **Task lifecycle handlers** (`advance_stage`, `complete_stage`,
   `rerun_stage`, `request_revision`, `close_task`, `run_merge_agent`,
   `reopen_task`, `create_task`) run their preparation sections — DB opens,
   `prepare_*` calls that resolve definitions, fork worktrees, and run
   workspace setup — through a shared `run_handler_blocking` boundary
   (`http_api/blocking.rs`, `tokio::task::spawn_blocking` with the standard
   error mapping). `close_task` also runs its finalize section (close +
   worktree snapshot/cleanup git work) behind the boundary.

2. **Detached stage execution** (`execute_stage_transition_detached`, the
   rerun path) interleaves async daemon IO with synchronous run records,
   fork rollback, and teardown prep. The whole detached future is driven
   from the blocking pool via `spawn_blocking(|| Handle::block_on(...))` —
   the same pattern `dispatch_ksp_request` already uses — so none of it can
   land on a runtime worker.

3. **Relay HTTP invokes** were dispatched inline in the relay read loop: a
   slow invoke occupied a runtime worker *and* head-of-line blocked every
   later relay message (tunnel establishment, snapshot acks).
   `dispatch_relay_http_invoke` now returns immediately, drives the handler
   from the blocking pool, and lets id-addressed responses complete out of
   order, capped by the KSP request worker's CPU-aware concurrency with an
   id-addressed 503 on saturation.

4. **Task diff reads** (`GET /v1/tasks/{id}/diff`, the mobile diff viewer)
   shell out to git against the task worktree; they now run behind the same
   boundary.

5. **Observability repair:** kanna-server's default log filter was
   `kanna_server=info`, which silently discarded every `terminal_perf`
   record the KSP backpressure tracing emits under the `kanna_daemon`
   target — production had zero server-side terminal diagnostics. The
   default filter now includes `kanna_daemon=warn`.

## Verification

- `advance_stage_route_stays_responsive_while_prepare_blocks_on_git`
  (current-thread runtime, real route, a repo whose `origin` fetch blocks via
  `core.sshCommand`): red against the inline prepare — the runtime measured
  4.36s blocked — green with the boundary, and the detached transition still
  lands while the single-threaded test keeps polling.
- `relay_http_invoke_dispatch_is_concurrent_and_off_the_runtime`
  (current-thread runtime, real WebSocket sink, definition load held open):
  a later invoke's response arrives while the earlier one is still blocked,
  and the blocked one completes after release.
- `relay_http_invoke_dispatch_rejects_when_saturated`: exhausted permits
  produce an immediate id-addressed 503.
- Full `cargo test -p kanna-server` suite green.

A full desktop E2E (human-visible echo latency across app + server + daemon
+ agent) is not yet automatable: it requires a packaged app, a live daemon,
and an agent session producing output while a stage transition runs. The
current-thread responsiveness tests above pin the causal defect at the
boundary the thread sample identified; the live `terminal_perf` records (now
actually emitted, see 5) prove or disprove recurrence in production.

## Follow-ups

- Route stage-transition definition resolution through the shared
  single-flight `RepoDefinitionsCache` instead of direct
  `RepoDefinitions::resolve` — transitions currently re-fetch per prepare.
- The relay `Command` invoke arm still dispatches inline (it is async daemon
  IO only, but head-of-line blocking applies).
- Remaining pure-DB handlers still open SQLite on runtime workers; the 10s
  busy timeout makes each a bounded but real stall risk.
- Consider isolating KSP terminal streaming onto a dedicated runtime so no
  future control-plane blocking bug can freeze the transport; this requires
  moving the LAN listener's stream upgrades as well and is deliberately out
  of scope here.
