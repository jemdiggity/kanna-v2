# Task Action Race and Retention Hardening Design

## Goal

Close the seven reviewer-identified races and durability gaps without changing
Kanna's durable-task, workspace-fork, or live-post product behavior.

## Desktop interaction ownership

Every asynchronous stage action captures the task/view that initiated it.
Final-stage fallback selection is restored only if the originating task is
still selected when the close becomes visible. Diff review completion is
likewise applied only while the same task and diff view key are current.
Keying the modal by its view identity also gives each reopened task view fresh
local composer state.

Advance and rerun requests use one generated idempotency key for the complete
retry loop, just as revision requests already do. Pending durable requests are
polled with that same key.

## Durable task actions and retention

The server uses the existing `task_action_request` table for advance, rerun,
and revision actions. A replay returns the recorded HTTP result; a pending
request returns the explicit pending response until its reserved successor or
terminal result is known. Completed records are retained for recent replay,
then garbage-collected by age and a global hard cap. Pending rows are never
collected. Cleanup runs on claims and task close so a quiet database and a
high-action database both remain bounded.

## Provider resume compatibility

A revision resume is only prepared when the resolved provider executable
demonstrates the provider-specific resume feature through its help surface.
Claude, Copilot, and Antigravity require their resume option; Codex requires
the `resume` subcommand; OpenCode requires `run --session`. A failed, timed
out, or unsupported probe falls back to a fresh workspace before any source
run is failed or successor is reserved. Deferred setup resumes also fall back
fresh because their executable cannot be safely probed before teardown.

## Post completion ownership

An injected post receives a random completion-attempt token in its prompt and
durable `stage_run` row. The unchanged live process may still present its main
run ID, but that ID authorizes the post only together with the exact post
token. Exact post-run ownership remains valid for fresh fallback post
processes. Delayed or duplicate main-run completion without the token cannot
complete or advance the post.

## Startup watcher handoff

Pending-action startup reconciliation keeps its versioned daemon lifecycle
subscription open after the List snapshot and landing decision. The first
long-lived terminal watcher iteration adopts that exact connection, including
events buffered during landing, while adding its normal legacy overlap and
fresh control List. No unsubscribe/resubscribe gap remains.

## Verification

Tests cover delayed desktop selection and modal switches, lost-response replay
for advance/rerun, action-record growth and cleanup, old/no-resume CLI
fixtures for PTY and headless runs, post-token ownership, and an Exit emitted
after startup List but before successor landing completes.
