# OpenCode session transfer — E2E note

Date: 2026-08-07
Scope: shipping an OpenCode conversation across a task transfer, and the
conversation-continuity E2E that runs under the real-E2E runner.

Companion to [2026-08-06-claude-transcript-transfer-e2e-gap.md](2026-08-06-claude-transcript-transfer-e2e-gap.md),
which covers the same contract for Claude.

## Why this exists

`local-transfer-claude-transcript.test.ts` asserts conversation continuity for
Claude, but the real-E2E runner forces `KANNA_E2E_REAL_AGENT_PROVIDER=opencode`
for every real suite (`apps/desktop/tests/e2e/runEnv.ts`) — OpenCode's free
models are what make a live-agent E2E affordable, and driving Claude
programmatically is not something to automate. The destination task is spawned
with that forced provider, so the Claude suite's `agent_provider: "claude"`
assertion can never hold. It now skips unless the runner is actually running
Claude, and continuity is asserted on the provider the runner does launch.

Making that possible meant OpenCode had to *have* a transferable session at all.

## What OpenCode actually does (pinned empirically against CLI 1.16.2)

Every fact below was verified against a real session, not inferred — the same
trap that caused the original incident, where Claude's config pointed at a
directory holding only a lock file.

- **There is no per-session file.** Conversations live in one shared SQLite
  store under `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`).
  Nothing in `~/.opencode` or `storage/` holds a conversation. So the
  copy-a-file / tar-a-directory artifact shapes do not fit; the transferable
  unit is `opencode export <session-id>` → self-contained JSON, replayed by
  `opencode import <file>`, which **preserves the session id**.
- **Kanna cannot know the session id at spawn.** `opencode run` has no
  `--session-id` that *assigns* one; `--session <unknown-id>` fails with
  "Session not found". Nothing parses one out of the terminal either, so an
  OpenCode task's `pipeline_item.agent_session_id` is always `NULL`. The
  transfer therefore discovers it from `opencode session list --format json`,
  matching the session's recorded `directory` against the task's worktree.
- **`opencode session list` and `export` are project-scoped.** A session opened
  in a task worktree is invisible from any other project's directory, so every
  lookup runs with the worktree as its working directory.
- **Resume is directory-keyed.** OpenCode matches a session's recorded
  `directory` against the current working directory;
  `opencode run --session <id>` from anywhere else is a **silent no-op** — no
  error, no history, no output. `opencode import` re-keys the session to the
  directory the import runs in, which is why the receiver runs it in the
  destination worktree.

That last point is the incident's failure shape in OpenCode's terms: without
the re-key, a transferred task would resume "successfully" against an empty
conversation.

## What is covered

`apps/desktop/tests/e2e/real/local-transfer-opencode-continuity.test.ts` runs a
real two-instance LAN transfer of a **live** OpenCode PTY task and asserts:

- the source task's `agent_session_id` is `NULL` — the id the payload carries
  came from discovery, not from the task row;
- the outgoing payload carries the discovered `resume_session_id` and a
  `session-export` / `opencode-import` artifact;
- the destination task resumes that same session id
  (`pipeline_item.agent_session_id`, and the `stage_run.provider_session_id`
  keyed to the destination worktree via `stage_run.cwd`);
- the session is re-keyed to the destination worktree — the resume precondition;
- the **assistant's** turns from the source machine are still in the
  conversation on the destination. The role filter is load-bearing: Kanna
  re-sends the same prompt on the destination, so the user half of the exchange
  reappears whether or not any history crossed.

Verified non-vacuous: with the OpenCode arm disabled, the suite fails with
`expected null to be 'ses_…'` — the payload ships no resume id, which is exactly
the silent-loss shape.

The Rust fence (`transfer_artifact.rs`) has unit coverage asserting that an
OpenCode `session-export` is refused by the filesystem materializer under every
kind/materialization combination and creates nothing under `$HOME`, and that
`opencode-import` cannot be used to smuggle another provider's artifact past the
arms that do place files. Contract parsing, the staging command, and the
receiver's import are covered in `taskTransfer.test.ts` and
`kannaTransfer.test.ts`.

## What is not covered, and why

**A genuinely separate OpenCode store on the receiving side.** Both E2E
instances run on one machine and share `~/.local/share/opencode`, so the
receiver's `opencode import` re-keys the session that is already there instead
of creating one from the shipped JSON. The assertion is the same either way —
after the transfer, the destination worktree is the directory this conversation
belongs to — but the *create* path (a receiver that has never seen the session)
is exercised only by `opencode import`'s own behaviour, which was verified by
hand against an isolated `XDG_DATA_HOME` while building this: the session is
recreated under the same id, with its messages, keyed to the import directory.

Making that path automatic would mean giving each E2E instance its own
`XDG_DATA_HOME` and seeding it with OpenCode credentials (`auth.json`,
`account.json`) so the destination agent can still reach a model — the harness
does this for Codex (`setupIsolatedCodexHome`) and the same shape would work
here. It is not done yet because the single-machine assertion already fails when
the shipping is broken, which is what this suite exists to catch.

**Session-id discovery is scoped to the transfer path.** Kanna still does not
track OpenCode session ids for tasks generally, so resume-after-restart and
revision resume remain Claude-only for OpenCode tasks. That is a larger change
than shipping the conversation and is deliberately not attempted here; the
lookup added for transfer does not stand in its way.

**Provider drift.** If OpenCode changes its export/import format, its
directory-keyed resume, or the `session list --format json` shape, this suite
fails loudly rather than silently — the discovery step returns nothing and the
transfer ships no artifact, which the suite asserts against. There is no live
CLI contract test for OpenCode yet (`tests/cli-contract/tests/live/` covers
Claude); adding one would be the canary.
