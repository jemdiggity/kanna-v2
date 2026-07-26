# Workspace command supervision

**Status:** Approved for implementation.

## Problem

Stage transitions synchronously run repository-controlled setup commands while
preparing the next workspace. `run_workspace_setup_commands` uses
`std::process::Command::output()`, so it waits without a deadline for both the
direct child and EOF on inherited stdout/stderr pipes. A hung child, or a child
that exits while a grandchild retains either pipe, permanently occupies a Tokio
blocking-pool thread.

The HTTP handlers detach only after transition preparation completes. The
detached executor therefore does not protect `advance-stage`,
auto-advancing `complete-stage`, or revision preparation from setup commands.
Enough hung commands can exhaust the useful blocking pool while read routes
continue responding.

Workspace teardown is detached through the daemon, but it has no deadline. The
daemon creates a session/process group for a PTY child, yet its kill operation
signals only the direct child. This repeats the incident's unsafe direct-child
kill behavior for teardown commands.

Finally, `/v1/status` reports identity but not write-path liveness. Desktop
startup adopts a matching server solely from `desktop_id`, version, and
environment, so restarting the app preserves a server whose write path is
degraded.

## Decision

Kanna will:

1. supervise every headless workspace setup command with a soft threshold, hard
   deadline, process-group kill, bounded output capture, and pipe draining that
   cannot delay completion indefinitely;
2. defer stage-transition setup until the existing detached transition worker,
   preserving synchronous action validation while removing repository commands
   from the HTTP request future;
3. cap concurrent headless workspace commands at four;
4. bound detached teardown sessions and make daemon PTY kills target the whole
   process group;
5. expose write-path health in `/v1/status`; and
6. adopt an existing server only when its identity matches and it explicitly
   reports a healthy write path.

The default thresholds are:

| Policy | Default |
| --- | --- |
| Soft warning/degraded health | 10 minutes |
| Hard setup/teardown timeout | 30 minutes |
| Concurrent headless workspace commands | 4 |

Tests use injected shorter durations. Production repository configuration does
not gain timeout knobs in this change.

## Alternatives considered

### Detach the entire preparation call

This is mechanically smaller, but the API would acknowledge missing, blocked,
or otherwise invalid tasks before discovering the error. That is an avoidable
semantic regression.

### Durable transition job queue

A database-backed queue would add crash recovery and durable progress, but it
would introduce a new scheduler and recovery protocol. Process supervision and
deferred setup solve the incident without that broader subsystem.

### Chosen: pending prepared stage session

Transition preparation continues to resolve the task, pipeline, prompt, fork,
environment, and setup command list. When setup is nonempty it returns a
pending stage session instead of running the commands or resolving the final
provider executable. The detached transition worker finishes setup, performs
post-setup provider selection, builds the daemon spawn, and continues the
existing transition.

This retains current validation, provider fallback, setup-created executable,
fork rollback, and post-fallback behavior.

## Supervised process execution

The setup runner spawns `/bin/zsh --login -c <command>` in a new process group.
Stdout and stderr remain piped, but their descriptors are placed in nonblocking
mode and drained explicitly while the runner polls `Child::try_wait`.

The completion signal is the direct child's status, not pipe EOF. After the
child exits, Kanna kills any remaining members of its process group and drains
available output only for a small bounded interval. An escaped descendant that
keeps a pipe open therefore cannot hold the call after the direct child exits.
If that bounded drain ends without EOF, Kanna logs the condition and preserves
the direct child's exit result.

At the hard deadline Kanna sends `SIGKILL` to the process group, polls the
direct child for reaping, performs the same bounded final drain, and returns a
normal setup error. The error identifies the timeout and includes captured
stdout/stderr, subject to a fixed memory cap with an explicit truncation
marker.

The runner logs once when the soft threshold is crossed. A process-wide permit
guard admits at most four active headless workspace commands. Calls beyond the
cap fail promptly with a capacity error instead of parking additional blocking
threads. Stage-transition callers record that error through the same failure
path as command exit or timeout.

## Detached transition flow

For stage swaps with nonempty setup:

1. The HTTP handler validates and prepares the transition without executing
   setup.
2. The handler starts `execute_stage_transition_detached` and returns the
   existing `TaskActionResponse`.
3. The detached blocking worker runs the supervised setup.
4. Setup success triggers provider selection, prepared-session construction,
   daemon replacement/spawn, stage/worktree updates, and the existing detached
   teardown.
5. Setup failure rolls back a newly forked worktree and branch, inserts a
   failed run for the target stage, marks the task unread, publishes task state,
   and logs the error.

Transitions with no setup retain their current ready-session path. A post
prepared for delivery to a live session must not run fallback-only environment
setup eagerly.

## Teardown supervision

Detached teardown remains daemon-owned so output and cleanup behavior stay
consistent. After the daemon acknowledges the teardown session, kanna-server
schedules:

- a soft-threshold check that logs only if the session is still active; and
- a hard-deadline kill if it remains active.

Daemon PTY session termination will signal `-pid` so the complete session
process group receives `SIGKILL`. The direct child is still reaped through the
existing background reaper. This also makes normal PTY task/session kills
consistent with the process-group isolation already established by `setsid`.

## Health and adoption

`MobileServerStatus` gains a `writePathHealth` object:

- `healthy`: false when any workspace command exceeds the soft threshold;
- `status`: `healthy`, `busy`, or `degraded`;
- `activeWorkspaceCommands`;
- `maxWorkspaceCommands`;
- `longRunningWorkspaceCommands`; and
- `oldestWorkspaceCommandSeconds`.

An idle server is healthy. Active work below the soft threshold is busy but
healthy. A soft-threshold breach is degraded and unhealthy. Hard timeout
removes the active command, so a server that successfully recovers becomes
healthy again.

Desktop deserialization treats a missing health object as unknown, not healthy.
`is_current_server_status` requires matching identity/build metadata and
`writePathHealth.healthy == true`. Thus legacy servers and unhealthy current
servers are stopped and replaced rather than adopted.

## Failure semantics

Setup timeout, nonzero exit, spawn failure, and capacity exhaustion are
ordinary stage-transition failures. The failure result retains captured output
and is visible through the task's latest run. The task remains on its previous
durable stage because stage/worktree mutation lands only after the new session
starts.

Teardown remains best-effort. Its timeout is logged and its complete process
group is killed; it does not retroactively fail an otherwise successful stage
transition or task close.

## Verification

Narrow process tests will use real shell processes to prove:

- a forever-hanging command reaches the injected hard deadline, kills its
  process group, and returns a timeout error with captured output;
- a direct child that exits while a grandchild retains stdout/stderr returns
  without waiting for pipe EOF and terminates the grandchild;
- more than four simultaneous hung setups never create more than four active
  command groups and excess calls fail promptly; and
- daemon PTY kill terminates grandchildren in the session process group.

HTTP integration tests will exercise the real router, Git worktree fork,
configuration setup command, detached transition, database, and fake daemon.
They will assert that the action response arrives while setup is still running,
then that success lands the stage or timeout produces a failed latest run.
These route tests are the cross-boundary/E2E coverage for the server path; the
desktop Webdriver suite is not required because it cannot observe or control
the server's Unix process groups reliably.

Status and desktop-manager tests will verify busy/degraded snapshots,
backward-compatible deserialization, healthy adoption, and replacement of an
identity-matching but unhealthy server.
