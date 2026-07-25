# Provider Resume Review Hardening Design

## Goal

Close the remaining identity, ordering, compatibility, and release-build gaps in
provider-session resume so a revision can safely return to its original workspace
without allowing an old process, foreign Codex session, duplicate HTTP action, or
legacy daemon to mutate the replacement run.

## Identity Boundaries

Kanna must not use reusable task/session identifiers as process ownership.

- A Codex PTY spawn records its effective metadata root and process group.
  Fresh-session discovery inspects only rollout JSONL files held open by that
  exact process group. A verified resume handle bypasses discovery.
- A headless daemon child receives an immutable spawn generation. Both pipe readers,
  event parsing, EOF, lifecycle mutation, and Kill commands prove that generation
  still owns the registry record before changing it.
- A server task action receives an immutable action lease plus an expected source
  stage, branch, and active main-run ID. Database mutation and landing compare those
  values atomically.
- A daemon Exit may finish a task only when its `run_id` is still the active owning
  main run. Reused terminal session IDs are not sufficient.

## Codex Discovery and Handoff

For a new interactive Codex run, Kanna records the effective `CODEX_HOME`, spawn
timestamp, and PTY process group. Codex keeps its active rollout JSONL descriptor
open for the session lifetime. Kanna enumerates descriptors only for members of
that process group, retains paths under the recorded `sessions` root, and parses
the bounded candidate set. A same-cwd foreign run is rejected unless the exact
spawned process group owns its descriptor. This preserves Codex configuration,
authentication, skills, and other state in the user's effective home.

Handoff serializes the complete locator state rather than rediscovering global
environment defaults: sessions root, canonical cwd, spawn timestamp, process group,
and any verified handle. A locator without a verified handle and without intact
process correlation fails closed after handoff. A locator with a verified resume ID
returns that ID without process or filesystem traversal.

## Daemon Ordering and Generations

`AgentSessionRecord` owns a monotonically increasing spawn generation. Initial spawn,
respawn, and handoff adoption assign a generation and pass it to stdout/stderr reader
threads. Every registry access checks `(session_id, generation)`. Old output, provider
IDs, status changes, permission changes, EOF, and child waits are ignored when the
record has been replaced.

For per-turn respawn, the accepted `UserMessage` is journaled and fanned out before
readers can deliver child output. Reader delivery is gated until this append is
complete. A generation-conditional Kill removes and signals only the expected run;
a stale transition worker cannot kill a newer child.

## Server Action Ownership

Revision, advance, completion, and rerun share a task-scoped single-flight registry.
The accepted action records expected stage, branch, and active main-run ID. Database
helpers use these values as compare-and-swap predicates when finishing a run,
creating a pending successor, landing a workspace, or starting a rerun. A retry that
finds the intended result already applied is idempotent; a conflicting successor
returns a conflict and performs no daemon mutation.

Resume capability negotiation happens before marking the current run failed,
creating a pending resumed run, killing a process, or replying success. If the daemon
is legacy or unreachable, revision either selects the already-prepared fresh-fork
fallback or returns an error with the original stage/run unchanged.

Detached workers retain their action lease and expected spawn generation. Their Kill
and landing operations fail closed when a newer action has taken ownership.

## Release Dependency Graph

`chrono` is declared consistently in the daemon Cargo manifests and all sidecar lock
files. The Bazel crate-universe metadata is regenerated through the repository's
canonical tooling so daemon, server, and task-transfer release graphs agree. Release
verification builds the three affected Apple sidecars.

## Regression Coverage

- Known Codex IDs perform zero discovery traversal.
- Large unrelated history does not affect fresh discovery work.
- A foreign post-spawn same-cwd Codex record is rejected.
- Custom `CODEX_HOME` and correlation state survive handoff.
- Respawn journaling precedes a barrier-released `TurnCompleted`.
- Buffered output and EOF from a killed generation cannot mutate its replacement.
- A delayed old Exit cannot mark a replacement unread or notify completion.
- Concurrent/retried revision, advance, completion, and rerun have one owner.
- A stale worker cannot kill or land over a newer run.
- The full HTTP revision path preserves state when resume capability is unavailable.
- Cargo tests, canonical Rust tests, three Bazel sidecar builds, and compatibility
  specialty review all pass.
