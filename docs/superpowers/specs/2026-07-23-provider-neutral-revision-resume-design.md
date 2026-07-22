# Provider-Neutral Revision Resume Design

## Goal

When review requests changes from an earlier pipeline stage, Kanna should resume that stage's previous agent conversation in its existing workspace whenever the provider and recorded run support resumption. A revision should fork a numbered workspace only when resumption is not mechanically available.

## Behavior

`request_revision` continues to target the same durable task and stage. Kanna looks up the latest main run for the target stage and resumes it when all of these conditions hold:

- the run recorded a provider session ID and working directory;
- the provider has a supported resume command;
- the previous worktree still exists and its committed tip matches the current task workspace's committed tip; and
- any provider-specific local resume prerequisite is present, such as Claude's cwd-scoped transcript.

On success, Kanna adopts the prior run's branch and worktree, starts the provider with its native resume command, sends the composed original-task-plus-review-feedback message, and records `resumed_from_run_id`. It does not create a `task-<id>-N` workspace. If any condition fails, the existing fresh-agent, numbered-workspace fallback remains unchanged.

## Provider Support

Resume behavior is capability-driven rather than Claude-specific:

- Claude uses `--resume <session-id>` and keeps its existing cwd-scoped transcript check. Kanna assigns the initial session ID.
- Codex uses `codex resume <session-id> <prompt>`. Kanna persists the session ID the daemon extracts from the terminal footer; headless Codex continues using the adapter-captured thread ID.
- OpenCode uses `opencode run --session <session-id> ...`. Headless OpenCode uses the adapter-captured session ID. PTY OpenCode falls back to a fresh fork until Kanna has a reliable session-ID capture surface.
- Copilot uses `--resume=<session-id>`. Kanna assigns and records the initial session ID with `--session-id`.
- Antigravity uses `--conversation <id>` when a recorded conversation ID exists. Fresh PTY Antigravity runs continue to fall back until Kanna can reliably capture that ID.

This distinction is intentional: a provider may support a resume flag while a particular run remains non-resumable because Kanna never obtained a stable handle.

## Architecture

Replace the Claude-only session binding passed through task preparation with a provider-neutral binding that can either assign a Kanna-controlled ID or resume a recorded ID. The provider command builder owns the exact CLI syntax; stage orchestration owns only the capability and selected session ID.

Generalize revision preparation to validate the prior run and existing workspace before constructing `RunWorkspaceSpec::Resume`. Claude retains its transcript existence check; other providers rely on their native session stores. The prepared run must resolve to the same provider and session ID as the prior run or preparation falls back without mutating disk.

Persist provider handles back to both `pipeline_item.agent_session_id` and the applicable `stage_run.provider_session_id`. In particular, persist the Codex ID included with an orchestrated daemon exit before filtering the killed event, so the completed implementation run remains resumable after the review-stage swap.

## Failure Handling

Resume preparation is fail-closed. Missing handles, missing worktrees, divergent tips, changed providers, unsupported session types, missing Claude transcripts, or command-construction mismatches log the reason and use the existing fresh-fork path. A failed resume spawn leaves the adopted workspace intact.

## Testing

Add focused tests that first demonstrate the current Claude-only failure for each supported provider binding, then cover:

- Codex, OpenCode, Copilot, and Antigravity resume command construction;
- provider-neutral revision preparation adopting the old workspace and preserving the session ID;
- Claude's transcript-specific fallback;
- missing provider handles and unsupported runs falling back to numbered workspaces;
- Codex session IDs being persisted to the completed stage run during an orchestrated replacement; and
- existing provider pinning, prompt composition, transition policy, and workspace safety behavior.
