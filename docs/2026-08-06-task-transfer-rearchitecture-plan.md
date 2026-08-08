# Task Transfer Repair & Re-architecture Plan

Status: adopted (implementation tasks created from this plan)
Related: [2026-07-05-desktop-server-migration-plan.md](2026-07-05-desktop-server-migration-plan.md),
[kanna-server-boundary.md](kanna-server-boundary.md)

## Incident

On 2026-08-06 a Claude PTY task was pulled from one staging desktop to another
over the cloud/relay transport. The transfer **succeeded** — and the agent
restarted on the destination with no conversation history, silently, with zero
errors on either machine. The source's 2.1 MB transcript
(`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`) never left the source.
The destination minted a fresh session id. The same window surfaced two more
defects (adopted-session finalization refusal; duplicate-push 500) and one
architectural finding that explains most of the rest.

## Root causes

### 1. The conversation is never shipped (data loss, silent, since `c5d51022` / 2026-04-18)

`SESSION_ARCHIVE_CONFIGS` (`apps/desktop/src/stores/transfer.ts:225`) stages
Claude session state from `~/.claude/tasks/<session-id>` — a real, session-keyed
directory that holds only `.lock` and `.highwatermark`. Claude **transcripts**
live at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, keyed by the
session's working directory. Two independent silent drops then compound:

- **Source** — `stageSessionArchiveArtifact` (`transfer.ts:303`):
  `if (!exists) return []`. The payload ships `artifacts: []` beside a valid
  `resume_session_id`. When the wrong directory *does* exist, Kanna tars a lock
  file and the transfer "succeeds", which is why the bug looked intermittent.
- **Receiver** — `importTransferredResumeState` (`transfer.ts:423`):
  `if (!artifact) return null`, discarding the resume id;
  `agentCommand.ts:244` (`params.resumeSessionId || createAgentSessionId(params)`)
  then mints a fresh session.

The asymmetry that constrains any fix: transcripts are **cwd-keyed**, and the
artifact contract's `home_rel_path` carries one fixed home-relative path — the
source cannot name where the file must land, because the destination worktree
path (and hence the slug) exists only on the receiver. The receiver must derive
its own slug. Codex differs twice over: `findCodexRolloutArtifact`
(`transfer.ts:244`) scans `~/.codex/sessions/**` for `-<sessionId>.jsonl`, and
the rollout may only be complete/nameable after CLI exit, whereas Claude's UUID
is minted by Kanna up front via `--session-id`.

### 2. Adopted-PTY finalization refusal (every task older than the running daemon)

Source finalization signals the agent with `SIGINT`
(`transfer.ts:815` → Tauri `signal_session` → daemon `Command::Signal`). The
daemon refuses signals for *adopted* sessions — inherited via handoff when the
daemon is replaced; it holds the master fd but never forked the child, so it
cannot pin the pid across `kill(2)` (`crates/daemon/src/pty.rs:919-940`, fails
closed by design, and correctly so). Consequence: **after every app upgrade,
no pre-existing task can be finalized by signal.** The refusal is swallowed by
a `.catch` that only logs, and `finalizedCleanly` (`transfer.ts:808-824`) is
computed but never load-bearing — the transfer proceeds and ships whatever
state happens to be on disk.

The daemon's **input** path has no such restriction: `Command::Input`
(`crates/daemon/src/connection.rs:678-711`) performs zero ownership checks —
bytes are written to the master fd for any live session, adopted or not. This
is the lever the finalization redesign stands on (see Decision 3).

### 3. Duplicate push → raw 500

`sourceIsEligible()` (`useAppLifecycle.ts:240`) reads `store.items`, a stale
renderer snapshot, not the DB. Two `task-pull-requested` deliveries raced; the
second re-ran `pushTaskToPeer` and collided with migration 036's
`idx_task_transfer_active_outgoing_source` partial unique index
(`crates/kanna-server/src/db/mod.rs:1371-1406`), surfacing as
`POST /v1/transfers → 500 UNIQUE constraint failed` and leaving an orphaned
sidecar reservation on disk. The incoming side already handles the same shape
correctly (`isDuplicateTaskTransferError`, `transfer.ts:107`).

### 4. The architectural finding: transfer was never moved out of the renderer

The 2026-07-05 migration plan scheduled it (Phase 3: "Task-transfer raw SQL
folds into the transfer/server surface") — but only the raw SQL moved.
`crates/kanna-server/src/http_api/transfers.rs` is 321 lines of pure CRUD.
The orchestration — `pushTaskToPeer`, `finalizeOutgoingTransfer`,
`importTransferredResumeState`, `approveIncomingTransfer` — lives in
`apps/desktop/src/stores/transfer.ts` (1088 lines of renderer TypeScript), and
`apps/desktop/src-tauri/src/transfer_sidecar.rs` (2850 lines) exists largely to
deliver lifecycle events to *a window*: deliveries, consumer incarnations,
30-second leases, ack/nack, phase claims, a 1 Hz redelivery sweeper —
~480 lines of machinery plus ~950 lines of tests whose only job is electing one
renderer among many and surviving its disappearance. `docs/kanna-server-boundary.md`
lists every task lifecycle action and no transfer routes at all.

Observed symptoms of that ownership, from the incident window alone:

- Mid-transfer, window ownership collapsed: `ownership was lost before PTY
  finalization signal`, then the failure report itself could not be sent, then
  the commit acknowledgment failed. All three are one design.
- The duplicate-push race is a stale renderer snapshot racing the DB — exactly
  the class the migration plan's Phase 2 kills.
- Artifact staging shells out to `tar` via `run_script` **from the renderer**;
  the renderer drives `git bundle`, `git clone`, and `git init` the same way.
- A transfer implicitly requires an open, signed-in window to complete.
- Of the four durable lifecycle events, only `transfer-request` survives an app
  restart (via sidecar replay + DB sweep). `task-pull-requested`,
  `outgoing-transfer-committed`, and `outgoing-transfer-finalization-requested`
  have **no restart recovery path** — the in-memory queue dies with the app.

## Decisions

### Decision 1 — Sequencing: correctness fixes land first, on the current architecture

The fixes ship in the renderer-owned code, then the ownership move ports them.
Rationale:

- The transcript loss is **live, silent, and destroys user data**; the ownership
  move is multi-week. Leaving a known data-loss bug open that long is the worse
  risk.
- The throwaway surface is small. What Phase 1 builds is mostly *contract*, not
  *plumbing*: the artifact schema extension (`session-transcript` kind), the
  receiver-side security fence and slug derivation
  (`transfer_artifact.rs` — already Rust, already server-portable, survives the
  move untouched), the fail-loud semantics, and the DB-backed idempotency rules.
  The TS locator/staging code that does get rewritten in Rust is ~150 lines.
- The genuinely new orchestration — injected-input finalization — is **not**
  built twice: it waits for the new server-side home (Phase 4), because it needs
  the daemon status events kanna-server already consumes and would be pure
  throwaway as renderer code.

### Decision 2 — `kanna-task-transfer` re-parents under `kanna-server`

Yes — decided, not deferred. The transport sidecar becomes a child of
`kanna-server`, which owns its stdio control plane; transfer orchestration
becomes server code.

- The sidecar's control plane is **unauthenticated newline-JSON over stdio**
  (`transfer_sidecar.rs:507-522`) — trusted purely because it is a private
  pipe. Whoever holds the pipe owns transfers; that should be the process that
  owns the DB rows, the task lifecycle actions, and the daemon event stream.
- `kanna-server` already terminates the **inbound** side of the same relay
  (`crates/kanna-server/src/relay.rs:520-525`,
  `task_transfer_tunnel.rs:68-78`), bridging tunnel frames to the sidecar's
  loopback port. Ownership is already split down the middle today.
- Transfers must not require an open window. Server ownership is the only
  arrangement that satisfies that.

Constraints the move must respect (from the sidecar trace):

- **Identity**: `<appDataDir>/transfer/identity.json` is resolved via Tauri
  paths (`transfer_identity.rs:27-42`). The desktop passes the resolved path
  (or the identity values) to `kanna-server` at spawn; the file does not move.
- **Port parity**: `KANNA_TRANSFER_PORT` is derived from the bundle identifier
  (`transfer_sidecar.rs:1831-1847`) so staging/prod don't collide. The desktop
  keeps deriving it and passes it into the server env; the server's own
  `transfer_port` config (`config.rs:149`) must agree — one derivation, one
  owner.
- **Outbound relay auth**: the Firebase ID token is fetched by the renderer
  (`desktopTransferMachines.ts:109`) and rotated into the desktop-process
  `cloud_transfer_proxy` (`cloud_transfer_proxy.rs`). The proxy moves into
  `kanna-server`; the renderer pushes/rotates the token via a server route.
  (Whether the server's existing relay client can carry outbound transfer
  traffic instead is an implementation question for the move — either way the
  desktop-process proxy is deleted.)
- **Lazy spawn** stays: the server spawns the sidecar on first use and on
  inbound tunnel demand, and re-spawns on death — same semantics as
  `transfer_client()` today (`commands/transfer.rs:37-70`).

### Decision 3 — Finalization becomes notify-then-idle-then-quit via injected input, server-side

Replace the SIGINT with a sequenced, observable shutdown driven by
`kanna-server`:

1. Inject a wrap-up message through the existing two-step input helper
   (`crates/kanna-server/src/http_api/task_input.rs:82-109` — text write, 150 ms,
   then CR as a discrete keystroke; the same helper the completion-notify
   boundary uses).
2. Wait for the session to reach **`Idle`** — the composer-free state — via the
   daemon `StatusChanged` events the server already consumes
   (`terminal_watcher.rs:261`, edge-detected in `db/task_events.rs:369-402`).
   `Waiting` is a permission prompt, not idleness; key on `Idle`. Status
   detection is 500 ms-throttled, so the state machine waits for the next
   transition, never assumes ack ordering.
3. Inject the provider quit command (`/exit` for Claude, `/quit` for Codex).
   The wait-for-idle *must* precede this: `/exit` preempts a busy agent
   immediately (product-owner observation, pinned by the live contract tests),
   so quitting early truncates the wrap-up.
4. Wait for the daemon `Exit` event (bounded), then stage artifacts — the
   transcript is now complete, including the wrap-up, and the Codex rollout is
   final.
5. Degradation ladder, each step loud: on injection failure or idle timeout,
   snapshot the transcript as-is and mark the transfer not-cleanly-finalized
   (surfaced to the user, not logged-and-forgotten); destructive teardown
   (`PtySession::kill`, which *does* work on adopted sessions — SIGKILL sweep
   authenticated by the master fd) remains the last resort after snapshot.

Why injection is trustworthy here — the two open questions this hinged on,
now resolved by code trace:

- **The protected-input fence does not block it.** `operator_input_only` is
  hard-coded `false` in production (`crates/kanna-server/src/runtime.rs:82`);
  `Command::OperatorInput`/`SystemInput` have no non-test callers. The
  `protected-input daemon generation is not ready` log seen during the incident
  comes from the *steady-state* maintenance loop (`runtime.rs:26-28` +
  `daemon_client.rs:314-318`) waiting for a successor daemon; in that state the
  HTTP listener and `/v1/tasks/{id}/input` keep working. The gate blocks input
  only during *startup* (`runtime.rs:126` runs before the listener binds), when
  there is no server to call anyway. (That log message is misleading in steady
  state — worth a wording fix, tracked in the move.)
- **Injected input is mechanically identical to typing.** Both are byte writes
  to the PTY master fd; the daemon applies no per-source transformation. Parity
  for slash commands, and the quit-preemption and transcript-flush behaviors,
  are *pinned by live CLI contract tests* (Phase 0) rather than assumed — they
  are provider-owned behaviors that can change under us.

### Decision 4 — Transcript-shipping contract (the durable part of fix 1)

- New artifact `kind: "session-transcript"`, `materialization: "copy-file"`,
  shipped **in addition to** the existing `~/.claude/tasks/<id>` archive (its
  highwatermark may matter for resume; it is not wrong, just insufficient).
- The source locates the transcript from the session's cwd (the stage-run
  worktree, recorded on `stage_run.cwd`) → slug → 
  `~/.claude/projects/<slug>/<session-id>.jsonl`.
- The receiver **derives its own slug** from the destination worktree path,
  which is deterministic before task creation
  (`destinationTaskIdForTransfer(transferId)` →
  `{repoPath}/.kanna-worktrees/task-{destTaskId}`), and materializes the
  transcript there before the agent spawns with `--resume`.
- The `transfer_artifact.rs` fence (`validate_artifact_contract`, :115-194) is
  widened **deliberately**: it is a security boundary. The new arm accepts only
  `<uuid>.jsonl` filenames for provider `claude`, and the destination directory
  is *receiver-computed* (`.claude/projects/<receiver-derived-slug>/`) — the
  sender never names a destination path. Same openat/O_NOFOLLOW/renameat-
  no-replace discipline as the existing arms.
- The exact slug algorithm is pinned by a live contract test (Phase 0), not
  hard-coded from folklore. Observed shape: `/` and `.` map to `-`
  (`/Users/x/.kanna/repos/r` → `-Users-x--kanna-repos-r`).

## Open questions — disposition

| Question | Disposition |
|---|---|
| Does the protected-input fence gate server-side injection? | **Resolved: no** in steady state; startup-only listener gate. Trace in Decision 3. |
| Is injected input accepted identically to keystrokes, slash commands included? | **Resolved mechanically** (same fd, no transformation); provider-side handling **pinned by live contract tests** (Phase 0) as the standing guard. |
| Does `/exit`//`/quit` preempt a busy agent? | **Assumed yes** (product-owner report); design sequences wait-for-Idle before quit regardless; pinned by live contract test. |
| Is Claude's transcript appended continuously or flushed at exit? | **Believed continuous** (hooks and `--resume` read transcripts mid-session); pinned by live contract test. Until pinned, finalization prefers graceful exit over idle-snapshot. |
| Re-parent `kanna-task-transfer` under `kanna-server`? | **Decided: yes** (Decision 2), phased as Phase 2. |

## Phases

Each phase is independently shippable, cuts over, and deletes the path it
replaces. Every phase crossing a component boundary carries an E2E expectation —
noting that the existing transfer E2E
(`apps/desktop/tests/e2e/real/cloud-task-transfer.test.ts`,
`local-transfer-pair-machine.test.ts`) asserts the transfer *completed*, which
is exactly why this shipped: **from Phase 1 on, transfer E2E asserts
conversation continuity, not completion.**

### Phase 0 — Guards and visibility (parallel with everything)

- **Live CLI contract tests** (`tests/cli-contract/tests/live/`, harness
  exists: `live-contract-guard.ts`, `helpers/claude.ts`, gated on
  `KANNA_RUN_LIVE_AGENT_CLI_CONTRACTS=1`, run via `pnpm test:agent-cli-compat`)
  pinning: Claude transcript location + slug algorithm; transcript
  append-while-running; `--resume` behavior when the transcript's recorded cwd
  differs from the current cwd; injected-input parity incl. slash commands;
  `/exit`//`/quit` preemption; Codex rollout timing (nameable before exit?).
  This suite is the canary for the day a provider moves its layout again.
- **Transfer visibility**: `transfer_status` is plumbed to the frontend
  (`db/mod.rs:163`, `db/snapshot.rs:164`) and rendered nowhere; Sidebar switches
  only on `activity` (`Sidebar.vue:736/:844/:966`). Render transfer state in the
  sidebar, and print receiver-side import steps into the *destination* task's
  terminal at spawn (mirroring the setup banner in
  `task_creator/commands.rs:305`). Do **not** print into the source PTY: it
  holds a live agent TUI; writing to it corrupts the display and pollutes the
  transcript being shipped.

### Phase 1 — Stop the data loss (current architecture, three chained changes)

1. **Ship the Claude transcript** per Decision 4: source locator, payload
   contract, receiver re-keying, fence widening. E2E: two-instance transfer of
   a Claude PTY task asserts the destination transcript exists under the
   destination slug with the source conversation, and the destination agent
   resumes with the *same* session id.
2. **Make missing session state a loud failure; make `finalizedCleanly`
   load-bearing.** A payload with `resume_session_id` and no matching artifact
   is a *failed transfer*, on both sides: the source refuses to commit it, the
   receiver refuses to import it (no more fresh-session fallback). The
   swallowed signal-refusal `.catch` (`transfer.ts:815`) and the artifact-
   staging `catch → return []` (`transfer.ts:400-410`) become failures that
   fail the transfer and surface to the user. `finalizedCleanly === false`
   blocks completion instead of decorating it. E2E: transfer with staging
   forced to fail → transfer fails visibly, source task intact and running.
3. **Duplicate push becomes idempotent.** Eligibility reads the DB (server
   snapshot), not renderer memory; a second push for a task with an active
   outgoing transfer returns the existing transfer instead of racing to a
   unique-constraint 500; the constraint violation, when it still happens, maps
   to "already in flight", and the orphaned sidecar reservation is released.
   Mirrors the incoming side's `isDuplicateTaskTransferError` handling.
   E2E/integration: two concurrent `task-pull-requested` deliveries → one
   transfer, zero 500s, zero leaked reservations.

### Phase 2 — `kanna-server` owns the transfer sidecar (transport re-parent)

`kanna-server` spawns `kanna-task-transfer`, owns stdio, and exposes the
control operations as server routes; the desktop's ~30 Tauri transfer commands
become thin calls to those routes (renderer flows otherwise unchanged — this
phase moves *plumbing*, not orchestration). The outbound cloud proxy moves
server-side with a token-rotation route. Env/identity/port constraints per
Decision 2. The desktop-process sidecar client
(`transfer_sidecar.rs` spawn/stdio half) is deleted.
E2E: transfer completes end-to-end with the sidecar under server ownership;
sidecar death mid-transfer re-spawns and recovers; staging/prod port parity
asserted.

### Phase 3 — Orchestration moves server-side; the window-election machinery dies — **landed**

Push, import, approve/reject, and commit handling move from
`stores/transfer.ts` into a `kanna-server` transfer engine (Rust), consuming
sidecar events directly. Git work (bundle/clone/init) and artifact staging run
server-side (the server already forks worktrees; no more renderer
`run_script tar`). Task creation on import uses the server's own task creator.
The four queued lifecycle events become a durable server work queue —
surviving restarts, which the in-memory Tauri queue never did. Deleted:
`TransferEventConsumer` (~480 lines + ~950 test lines), the renderer lifecycle
lease/incarnation/phase-claim protocol in `useAppLifecycle.ts`, and the
duplicate DB claim-lease driven from the renderer
(`useAppTaskTransfer.ts` owner tokens). The renderer keeps: approve/reject
intent, progress display (via snapshot/`StateChanged`), pairing UI.
E2E: a pull completes with **no authoritative renderer consumer** (window
closed / never claimed); app restart mid-transfer resumes rather than orphans.

Landed as described, plus two things the plan did not anticipate. The peer-side
half of T3's reservation release came with it — a losing duplicate push left an
`incoming-reservations/<id>.json` on the *destination*, which only the engine
that owns the push lifecycle could address (see
[2026-08-07-duplicate-push-transfer-e2e-gap.md](2026-08-07-duplicate-push-transfer-e2e-gap.md)).
And moving `git clone` server-side made a peer-supplied remote URL an argv, so
the engine gained a scheme allowlist and a `--` separator: `git clone
--upload-pack=…` and git's `ext::` transport are both remote code execution, and
the renderer's `run_script` path had never fenced either.

E2E coverage is `apps/desktop/tests/e2e/real/local-transfer-headless-engine.test.ts`:
a pull that completes with the source renderer navigated away (app process and
`kanna-server` up, no window participating, every assertion read over
`/v1/e2e/sql` rather than through a renderer), and a `kanna-server` SIGKILL
mid-transfer once per direction with the transfer resuming to completion after
the restart.

### Phase 4 — Finalization redesign (in its new home) — **landed**

Implement Decision 3's notify→idle→quit→exit→stage sequence as a server-side
state machine keyed off the daemon events, replacing the SIGINT path entirely
(`signal_session` disappears from the transfer flow; adopted sessions are now
first-class). Codex benefits automatically: staging after `Exit` makes the
rollout final and nameable. The Phase 0 live contract tests are a merge
prerequisite for this phase.
E2E: transfer of a *busy* agent — wrap-up completes, transcript contains the
wrap-up, destination resumes; plus an adopted-session finalization (daemon
handoff simulated, as in `crates/daemon/tests/`) that the old path could never
pass.

Landed as `crates/kanna-server/src/transfer_engine/finalize.rs`, with three
things the plan did not spell out.

The quit command became a property of the provider registry
(`AgentProvider::quit_command`) rather than a two-case match, and every provider
Kanna can spawn answers it: `/quit` for Codex, `/exit` for the rest. Copilot and
Antigravity were verified against the installed CLIs while building this;
Copilot's is now pinned by `tests/cli-contract/tests/live/copilot-tui-quit.test.ts`.

`Waiting` does not merely fail to count as idle — the sequence must *never* type
into it. A permission prompt consumes the next input as its answer, so a quit
command injected there would answer an approval prompt on the operator's behalf.
A session parked that way times out into the degraded rung instead.

The terminal recovery snapshot moved into the sequence, taken after idle and
before the quit. Under the old `SIGINT` the source agent usually survived
finalization, so the snapshot could be taken afterwards; now it cannot — there
is nothing left to photograph once the process has exited, and the destination
replays that picture.

Coverage: `crates/daemon/tests/handoff.rs::test_adopted_session_refuses_signals_but_quits_on_injected_input`
is the incident as a test (the refusal stays, and injection works through it);
`transfer_engine/finalize.rs`'s own tests script a daemon over a real socket and
pin that nothing is typed at a busy agent, that `Waiting` never reads as idle,
and that a retry reports the verdict the live attempt reached; and
`apps/desktop/tests/e2e/real/local-transfer-busy-agent-wrapup.test.ts` transfers
a busy OpenCode agent and asserts the wrap-up — and the agent's answer to it —
are in the conversation the destination resumes.

## Implementation tasks

| # | Task id | Task | Phase | Blocked on |
|---|---|---|---|---|
| T1 | `b3dababd` | Ship Claude transcript (locator, contract, receiver re-keying, fence) | 1.1 | — |
| T2 | `6d1be758` | Loud failure on missing session state; `finalizedCleanly` load-bearing | 1.2 | T1 |
| T3 | `9de722fc` | Idempotent duplicate push | 1.3 | T2 |
| T4 | `31b7ba29` | Live CLI contract tests (transcripts, injection, quit, rollout timing) | 0 | — |
| T5 | `dbf60e69` | Sidecar re-parents under kanna-server (transport plumbing) | 2 | — |
| T6 | `fc2fc1c2` | Transfer orchestration moves server-side; delete window-election machinery | 3 | T3, T5 |
| T7 | `6d43a77d` | Injected-input finalization state machine | 4 | T6, T4 |
| T8 | `8458932e` | Transfer progress UI + receiver-side import step output | 0 | — |

T1→T2→T3 are chained on real file contention: all three edit
`apps/desktop/src/stores/transfer.ts` (staging, finalize, and push paths
respectively call into each other). T4, T5, T8 run in parallel from day one.

T5 was originally created as `000f4de5`; that session was killed and the task
recreated as `dbf60e69` (2026-08-06), continuing from checkpoint commit
`49ccd7e5`. T6's blocker was rewired to the recreated task.
