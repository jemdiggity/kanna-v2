# Provider resume after daemon death: E2E gap (2026-09-03)

The desktop/server recovery wiring now has automated boundary coverage, but
the current app E2E harness cannot safely and deterministically kill the
application-owned daemon and then exercise the launcher's crash restart. Its
daemon replacement hook tests transactional handoff; killing the shared daemon
would destroy every session owned by that suite process and bypass the
production launcher sequence this behavior depends on.

Narrower coverage added meanwhile:

- desktop store tests prove a missing task session calls the server's `resume`
  action, registers its waiter before that request can race the detached
  replacement, completes from the daemon's `session_created` event without
  polling `List`, and never invokes the local initial-prompt spawn path;
- server integration tests begin with a durable `running` run and an absent
  daemon session, drive the HTTP action over the daemon protocol, and verify
  both Claude's recorded-id resume and Codex's cwd-discovered resume command;
- the Codex no-match case verifies the new run is fresh only with the exact
  `resumeFallbackReason`, while the successful cases verify
  `resumedFromRunId`.

A full-process E2E becomes practical when the harness can launch an isolated
desktop/server/daemon group per test and exposes a test-only crash-and-relaunch
operation that preserves the old daemon's recovery journal. That test should
start a provider fixture which writes identifiable conversation state, kill
the daemon without an `Exit`, restart the group, select the task, and assert
both restored provider state and the served run metadata. It should cover one
assigned-id provider (Claude) and one cwd-discovered provider (Codex).
