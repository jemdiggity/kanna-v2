# Codex transition resume-session E2E gap (2026-08-16)

Kanna never assigns Codex a session id. The daemon scrapes the rollout uuid off
the live TUI footer (`crates/daemon/src/headless_terminal.rs`,
`extract_codex_resume_session_id`) and reports it on the `Exit` it broadcasts.
Proving the whole chain end to end therefore requires a real `codex` CLI that
renders that footer, holds a real conversation, writes a real rollout file under
`CODEX_HOME`, and can then be resumed — none of which the test environment
provides. The repo's provider fixtures are `#!/bin/sh\nexit 0` stubs precisely
because no agent CLI is available to CI.

A full E2E becomes feasible when the test inputs include either a recorded
Codex TUI byte stream that reproduces the footer through a real PTY plus a
matching rollout fixture, or a hermetic fake `codex` binary that renders the
footer, writes a rollout jsonl, and honours `resume <uuid>`. That fake would
have to be driven through a real daemon PTY so the extraction, the killed-`Exit`
broadcast, and the resumed spawn are all executed rather than injected.

The narrower causal coverage meanwhile is:

- `crates/kanna-server/src/task_creator/tests/provider_session.rs` drives the
  real stage transition, the real terminal-state watcher, and the real revision
  preparation against one fake daemon socket. The killed `Exit` is delivered
  only after the review run exists, which is the ordering that made "the task's
  latest run" the wrong target, and the revision is then asserted to resume the
  recorded conversation in the implementation worktree rather than fork. A
  second case proves an `Exit` that discovered no session still forks and
  records `no stage run recorded a provider session`.
- `crates/kanna-server/src/terminal_watcher.rs` tests cover the watcher half:
  a killed `Exit` records its uuid on the named outgoing run only, leaves the
  post run and the replacement run untouched, does not notify completion, does
  not finalize the live replacement run, and cannot rewrite a run that already
  recorded a conversation.
- `crates/kanna-server/src/session_replacements.rs` tests cover consume-once
  entry semantics, including two overlapping kills that disagree about the
  outgoing run degrading to no attribution at all.
- `crates/daemon/src/headless_terminal.rs` already covers the extraction itself
  (`codex_resume_session_id_comes_from_visible_footer_content`), and
  `crates/daemon/src/protocol.rs` covers the `Exit.killed` wire shape including
  the legacy payload without the field.

Historical evidence for the defect: closed tasks `cf1b5371` (terminal redraw)
and `6a6eb58b` (relay WebSocket bounds), each of which burned four distinct
Codex rollout uuids across one implementation and three revisions because every
revision forked a fresh conversation. Their branches are preserved; the tasks
themselves were closed on 2026-08-16 and are not live fixtures.
