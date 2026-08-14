# Kanna Server Boundary

`kanna-server` is the desktop-side service boundary for non-desktop consumers.
Mobile clients and future CLI tools should talk to `kanna-server`, not directly to the daemon protocol, Tauri commands, or desktop UI state.

The desktop frontend itself is planned to become a `kanna-server` client as well; see [2026-07-05-desktop-server-migration-plan.md](2026-07-05-desktop-server-migration-plan.md) for the phased migration off direct SQLite access.

## Responsibility Split

- `kanna-server`: LAN HTTP and WebSocket transport, route validation, task listing and search, task lifecycle actions, pairing state
- daemon: PTY and session ownership, terminal input and output, agent process lifecycle
- SQLite DB: repo and task persistence, task metadata, query backing for server resources

## v1 LAN Surface

- `GET /v1/status`
- `GET /v1/stream` (KSP WebSocket for terminal, agent, and streamed task API frames)
- `GET /v1/desktops`
- `GET /v1/repos`
- `GET /v1/repos/{repo_id}/tasks`
- `GET /v1/repos/{repo_id}/agents` (resolved named agent definitions available to task creation)
- `GET /v1/repos/{repo_id}/recent-workflows` (workflow names the repo's tasks were most recently created with, newest first)
- `POST /v1/tasks/{task_id}/actions/set-workflow` (re-pin an open task to a compatible workflow definition)
- `GET /v1/tasks/recent`
- `GET /v1/tasks/search?query=...`
- `GET /v1/tasks/{task_id}/children` (durable direct-child fan-out history; includes closed children)
- `GET /v1/task-events?taskIds=...|parentTaskId=...|repoId=...&cursor=...&timeoutSecs=...&limit=...` (multi-task event feed; blocks server-side until an event arrives or the window elapses)
- `POST /v1/tasks`
- `POST /v1/tasks/{task_id}/input`
- `POST /v1/tasks/{task_id}/actions/complete-stage`
- `POST /v1/tasks/{task_id}/actions/request-revision`
- `POST /v1/tasks/{task_id}/actions/close`
- `POST /v1/tasks/{task_id}/actions/advance-stage`
- `POST /v1/tasks/{task_id}/actions/signal-merge-handoff`
- `POST /v1/tasks/{task_id}/actions/rerun-stage`
- `POST /v1/tasks/{task_id}/actions/run-merge-agent`
- `POST /v1/tasks/{task_id}/actions/set-notify`
- `POST /v1/mobile/notifications`
- `POST /v1/pairing/sessions`

## Multi-machine Agent Routing

`kanna-mcp` and `kanna-cli` remain clients of the machine-local
`kanna-server`; agent processes never receive Firebase credentials and do not
connect to the cloud relay themselves. Their shared tool catalog declares
`kanna_list_machines` (`GET /v1/cloud/desktops`) and an optional `machine_id`
on every routable tool. Machine discovery itself and the local-run-bound
`kanna_complete_stage` omit that property. In the CLI,
the same surface is available as `kanna-cli machine list` and
`kanna-cli tool call <tool> --machine-id <id>`. Omitting `machine_id` preserves
local behavior. Both adapters compare an explicit id with the live desktop id
from the local server first: naming the current machine takes the local path
and never requires relay discovery or availability. A different id wraps the
catalog-resolved HTTP request through
`POST /v1/cloud/desktops/{desktop_id}/invoke`.

Those two bridge routes require a real desktop-loopback request
(`DesktopLocalAccess`). A paired LAN client or an inbound relay request cannot
use one trusted desktop as a proxy into the rest of the account. The local
server submits the request through its existing desktop-authenticated relay
socket; the relay resolves that credential to one user and routes only to a
desktop socket registered under the same user. No raw server URL, device
secret, desktop secret, or Firebase token enters the MCP arguments.

The relay connection is also the availability boundary. Machine discovery
always returns the current machine and reports `relayAvailable` plus an error
when sibling discovery is unavailable. Remote calls fail closed when the
target is offline or the relay disconnects. The server enables the bridge only
after `auth_ok` advertises `desktopRouting` capability version 1, so deploying
the desktop ahead of the relay fails fast instead of hanging. Outstanding and
queued requests are bound to that relay-connection generation and fail instead
of being replayed after reconnect. Task waits retain the normal 240-second MCP
window, with the server-side relay handoff bounded below the MCP client's
300-second tool-call deadline.

`kanna_wait_events` has one additional MCP-side fan-in behavior. When its
explicit `task_ids` belong to several reachable machines and `machine_id` is
omitted, MCP discovers each task's owner, starts one native cursor wait per
owner, and returns as soon as any owner has events. Every returned event gains
`machineId`. Its `km1.` aggregate cursor records the immutable task-to-machine
grouping plus each server's opaque native cursor; callers pass it back exactly
like a local cursor. The MCP process retains the other in-flight long polls and
reuses them on the next call, rather than cancelling them, abandoning relay
work, or replacing the server event feed with client polling. If MCP restarts,
the aggregate cursor contains enough state to recreate those waits without
losing events. Machine failures are returned in `machineErrors` without
advancing that machine's cursor or discarding events received elsewhere.

On every aggregate-cursor resume, kanna-mcp compares the cursor's claimed
`localMachineId` with the live local server identity before using its ownership
map or native cursors. A cursor copied from another machine, made stale by an
identity change, or tampered to relabel the local sequence space is rejected.
Local-versus-remote event routing uses that same live identity, never the
cursor's self-asserted value.

This automatic fan-in applies only to `task_ids`, whose ownership can be
resolved exactly. `parent_task_id` and `repo_id` remain scopes on one machine:
they use the local machine by default or the explicit `machine_id`. Passing
`machine_id` with `task_ids` likewise pins the whole wait to that machine.
There is no global ordering between independent SQLite sequence spaces;
ordering remains exact within each machine and `machineId` identifies the
sequence space for every aggregated event.

## Task Transfer Transport

`kanna-server` owns the `kanna-task-transfer` sidecar: it spawns the process,
holds its stdin/stdout control plane, and terminates both directions of the
relay. It spawns lazily — on the first control request or on an inbound
task-transfer tunnel — and respawns transparently once the previous child is
observed dead. Before this, the desktop process held the pipe, which made every
transfer depend on an open, signed-in window.

These routes are **not** part of the LAN surface. Unlike the rest of
`/v1/transfers/*`, which a paired LAN device may reach, each one requires a
direct desktop loopback connection (`DesktopLocalAccess`): they initiate
pairing and move tasks between machines, and their pre-move equivalent was
reachable only by whoever held a private stdio pipe.

- `POST /v1/transfers/sidecar/control/{operation}` — one control operation from
  a fixed allowlist (`crates/kanna-server/src/transfer_control.rs`), taking and
  returning camelCase JSON. The route cannot hand the sidecar an arbitrary
  message.
- `GET /v1/transfers/sidecar/events?cursor=...&streamId=...&timeoutSecs=...&limit=...`
  — long-poll of sidecar events, following the `/v1/task-events` cursor
  contract: pass the returned cursor back and nothing fired between two calls is
  missed. Unlike `/v1/task-events`, whose cursor is a durable `task_event.seq`,
  this log is in memory and its sequence restarts at zero with every server
  process — while the desktop that holds the cursor outlives those restarts. So
  a cursor should be sent back with the `streamId` it was issued with: a cursor
  presented alongside a `streamId` naming a *different* stream is discarded and
  answered with `missedEvents`, rather than applied to sequence numbers it never
  referred to. A cursor sent with no `streamId` at all — what a desktop from
  before this field existed sends — is honoured under the original sequence
  semantics instead, because refusing it would mean never pruning: the caller
  would be redelivered the same retained events indefinitely while durable
  entries climbed to the cap and backpressured the sidecar reader, wedging
  control. Absence of the field is not evidence of a stale cursor.
  Single-consumer: a read prunes through the cursor it is given, so exactly one
  desktop process subscribes. This feed carries only *advisory* events —
  pairing progress and remote terminal frames. The four state-mutating events
  (`incoming_transfer_request`, `task_pull_requested`,
  `outgoing_transfer_committed`, `outgoing_transfer_finalization_requested`)
  never reach it: the sidecar's stdout reader appends them straight to the
  transfer engine's durable work queue in this process. A full advisory log
  evicts its oldest entries and says so via `missedEvents`, which it could not
  do while a lifecycle event might be among them.
- `POST /v1/transfers/cloud-proxies`, `DELETE /v1/transfers/cloud-proxies`,
  `DELETE /v1/transfers/cloud-proxies/{peer_id}` — outbound cloud transfer
  tunnels. This cannot ride the server's own relay connection: the relay honours
  `tunnel_request` only from a socket authenticated with a Firebase user
  `id_token`, and the server authenticates as a *desktop* with its device token
  or desktop secret. The signed-in renderer holds the only Firebase credential,
  so it pushes and rotates the ID token through the first route.

Identity and port have one owner each, and it is the desktop: it derives
`transfer_port` into `server.toml` (the same value the inbound tunnel bridge
dials), and resolves `transfer/identity.json`, the peer id, the display name and
the registry directory into the server's environment at spawn. `kanna-server`
forwards all of it to the sidecar and re-derives none of it, so staging and
production keep the distinct ports and per-worktree registries they need to run
side by side.

## Task Transfer Orchestration

`kanna-server` performs the transfer, not just its transport. Push (preflight →
git bundle → artifact staging → insert → commit), incoming record and import
(repository acquisition, artifact materialization, task creation through the
server's own creator, provenance, acknowledgment), approve/reject execution,
outgoing-committed handling (closing the source task through the server's own
close action) and failure reporting all run here.

This is what makes a transfer independent of an open window. Orchestration used
to live in the renderer, elected among windows by a lease/incarnation/phase-claim
protocol whose whole job was surviving that window disappearing — and on
2026-08-06 it did not: ownership was lost before the PTY finalization signal,
the failure report could not be sent, and the commit acknowledgment failed. See
[2026-08-06-task-transfer-rearchitecture-plan.md](2026-08-06-task-transfer-rearchitecture-plan.md).

The engine's steps are rows in `transfer_work`, appended by the same reader
that observes the sidecar event, and drained by one in-process loop:

- A work id is **derived from the event** (`pull:<pull-request-id>`,
  `incoming:<transfer-id>`, `committed:<transfer-id>`,
  `finalize:<transfer-id>`), so a redelivery collapses onto the work already
  queued. At-least-once delivery to a window became exactly-once execution in
  one process.
- A step that must happen at most once — typing into the source agent, closing
  the source task, acknowledging an import — claims a row in
  `transfer_work_phase`. That is the durable form of the sidecar's in-memory
  `claimed_phases`, so a resumed item continues rather than repeating. A step
  whose *answer* cannot be recomputed on a retry — what the source session
  looked like before it was shut down, and whether the shutdown was clean —
  records that answer in the same table, first writer wins.
- Work left `running` by a dead process returns to `pending` at engine start,
  and incoming transfers recorded but not imported are re-enqueued. Before this,
  only `transfer-request` had any restart recovery at all.
- Attempts are bounded and backed off. A transfer that can make no further
  progress is driven to `failed` and its sidecar reservation released, rather
  than retried silently forever.

Clients express **intent**; the engine executes. These routes are ordinary
`/v1/` surface (not `DesktopLocalAccess`-only), so mobile can express the same
intents:

- `POST /v1/tasks/{source_task_id}/actions/push-to-peer` —
  `{peerId, transport?, cloudFallback?, targetDesktopId?, intentKey?}`.
  `intentKey` distinguishes a deliberate re-push from a retried request; the
  response's `scheduled: false` means the intent was already queued.
- `POST /v1/transfers/{transfer_id}/actions/approve`
- `POST /v1/transfers/{transfer_id}/actions/reject-incoming`

Progress reaches the UI through the snapshot's `transfer_status`, which the
sidebar already renders. There is no bespoke event protocol between the engine
and a window, and no window is required for a transfer to complete.

### Source finalization

A push cannot ship a conversation the source agent is still writing to, so the
engine shuts that agent down first — by **typing at it**, not by signalling it
(`transfer_engine/finalize.rs`):

1. inject a wrap-up message through the same two-step input helper every other
   Kanna input path uses (`task_input.rs`: the text as one write, 150 ms, then a
   lone CR so it registers as a discrete Enter);
2. wait for the daemon to report the session `Idle` — `Waiting` is a permission
   prompt, not idleness;
3. inject the provider's quit command (`AgentProvider::quit_command`);
4. wait for the daemon `Exit`, and only then stage artifacts.

Nothing is typed while the session is `Waiting`. Step 3 gets that from step 2 —
it is only reached on `Idle` — but step 1 has nothing in front of it, so the
status the daemon reported at attach is checked before the wrap-up goes out. The
helper's trailing CR is the keystroke that accepts a permission prompt's
highlighted option, so a wrap-up typed at a parked session approves whatever
tool call it is holding, in the operator's name — and silently, because the
agent then resumes, goes idle, quits on cue and ships `cleanlyFinalized: true`.
A session already parked when finalization starts degrades immediately instead;
one that parks mid-wrap-up reaches the same rung through the idle timeout.

The old mechanism was a `SIGINT` and a 1500 ms wait, and it could not work on
any session the daemon had **adopted** through a handoff: the daemon refuses
signals for a child it never forked, because the pid cannot be pinned across
`kill(2)`. Every session older than the running daemon is adopted, so after
every app upgrade no pre-existing task could be finalized. `Command::Input` has
no such ownership check, which is what makes injection the mechanism that works
where signalling cannot (pinned in `crates/daemon/tests/handoff.rs`).

Each step appends `task.transfer_finalizing` to the task event feed with a
`payload.phase`, because a wrap-up is legitimately minutes of latency and has to
read as a transfer rather than as a hung task.

That latency is also why `PeerRequest::FinalizeTransfer` has a request window of
its own. Every other peer request is a machine doing its own local work and
fits the ordinary 15 s window; this one is the destination waiting on somebody
else's *agent* being asked to stop. While the two shared a window, any wrap-up
longer than a few seconds surfaced on the destination as `PeerRequestTimeout`,
which is a retriable import failure — so a normal finalization silently spent
attempts from `MAX_TRANSFER_WORK_ATTEMPTS`, the budget held for a locked
OpenCode store or a dropped artifact fetch. The transfer still completed, off
the finalization result the source caches for the retry that collects it, so
nothing failed loudly; only the retry budget was gone.

`finalization_request_timeout` (10 minutes,
`crates/task-transfer/src/runtime/config.rs`) is what the source is given to
answer. The server's own budget must fit inside it — `WRAP_UP_TIMEOUT` plus
`QUIT_EXIT_TIMEOUT` is 6 minutes, leaving the rest for staging the session
artifacts, and a unit test in `finalize.rs` fails if that stops holding. The
destination allows the same window plus one ordinary request window, so the
source's answer — including its own timeout report — always arrives while the
destination is still listening. Injection failure or a session
that never goes idle degrades the finalization — artifacts are staged as they
stand and the payload carries `cleanlyFinalized: false` with the reason —
rather than failing the transfer. Destructive teardown stays last and stays
*after* staging: it is the source task's own close, once the destination has
acknowledged the import.

A payload arrives from another machine, so everything derived from it is fenced
before it is used: the artifact contract
(`transfer_engine/payload.rs`), the openat/`O_NOFOLLOW`/renameat-no-replace
materialization boundary (`transfer_artifact.rs`), and the git argv fence
(`transfer_engine/git.rs`) — a clone URL is checked against a scheme allowlist
and passed after `--`, because `git clone --upload-pack=…` and git's `ext::`
transport are both remote code execution.

## Agent Runtime Identity

`kanna_info` is a catalog-declared, parameterless client tool backed by
`GET /v1/status`; `kanna-cli info` exposes the same result when MCP is not
available. The result deliberately keeps three identities separate:

- `clientAdapter` identifies `kanna-mcp` or `kanna-cli`; MCP results include
  the adapter's MCP protocol version.
- `connection` is client-owned metadata: the exact effective HTTP base URL the
  client is using and its parsed host/port.
- `serverStatus` is an allow-listed snapshot of authoritative server state,
  environment, build version, safe desktop identity, capabilities, and
  write-path health. `lanAdvertisedEndpoint` separately reports the host/port
  advertised by that server, which need not match the actual loopback or relay
  transport endpoint.

The catalog crate owns the status allowlist shared by CLI and MCP. It never
passes the raw `/v1/status` object through, so `pairingCode`, compatibility
aliases, credentials, database paths, unknown future fields, and arbitrary
HTTP error bodies cannot enter the tool result. If status cannot be fetched or
decoded, the tool retains adapter and effective-connection metadata and sets
`serverStatus.available` to `false` with an explicit error; it does not infer
an environment or version. The server route itself is unchanged, preserving
existing mobile and status consumers.

## Agent Definition Discovery

`GET /v1/repos/{repo_id}/agents` and the catalog-backed
`kanna_list_agents` tool list the definitions that the `agent` field of task
creation can run. Names are invokable directory selectors. Descriptions,
default providers, and default models come from the fully resolved definition:
a repo `AGENT.md` wins over a built-in of the same name, then the repo's
`EXTEND.md` is layered on top. `source` is `built_in`, `repo_override`, or
`repo_authored`; extending a built-in counts as a repo override because the
definition that runs is repo-modified. Definitions whose resolved frontmatter
declares `visibility: internal` — the `commit` and `approve` stage posts Kanna
binds itself — are omitted from the listing, but still resolve when the
`agent` field names them explicitly: visibility governs listing, not access.

Task creation uses that same resolution path for any agent role, not only
specialty reviewers. An explicit request provider wins, followed by the
definition's provider candidates, then the configured user default when the
definition declares none. Role-specific agents can still fail their own
preconditions—for example, `pr` needs committed task work to publish—but Kanna
does not reject them as first-stage bindings.

## Task Event Feed

`GET /v1/task-events` is the surface an orchestrating agent watches instead of
polling each child. It is cursor-based, not snapshot-diffed:

- Event order is `task_event.seq` (`INTEGER PRIMARY KEY AUTOINCREMENT`). SQLite
  allows one writer at a time, so a `seq` cannot be committed out of order.
  Fixed task/repo cursors are a single sequence watermark. Parent cursors bind
  that same global watermark to the parent id; they are constant-size and do
  not contain child ids or membership history. Callers pass back the cursor
  they were given unchanged; events that fire between two calls arrive on the
  next one.
- Omitting the cursor returns the scope's retained history (14 days), so a
  watcher that starts after its children does not lose their early events.
- Events are appended by the same DB writes that change the state they describe
  (`pipeline_item`, `stage_run`), inside the caller's transaction where there is
  one — the log cannot drift from the state.
- The wait blocks inside the server, bounded by
  `kanna_tool_catalog::MAX_WAIT_TIMEOUT_SECS`, so `kanna-mcp` and `kanna-cli`
  each issue one plain GET and neither owns a polling loop.
- `task.awaiting_input` comes from the daemon's `Waiting` session status, which
  is a positive match on a prompt the agent CLI rendered. It is deliberately
  never inferred from a session going quiet; see
  [2026-07-29-awaiting-input-detection-e2e-gap.md](2026-07-29-awaiting-input-detection-e2e-gap.md).
- `task.activity_changed` is the provider-neutral fallback. It is appended on
  a `working` → `idle`/`unread` activity edge when the task has a non-empty
  `waitingPromptSnippet`, and carries `previousActivity`, `activity`, and that
  snippet. It does not claim the snippet is a question: PTY providers also use
  this edge after ordinary final output. A changed snippet while activity
  remains stopped is task-detail state only and requires polling
  `kanna_get_task`.
- `task.transfer_finalizing` reports each step of a cross-machine transfer
  shutting the task's agent down (`payload.phase`: `wrap-up-sent`, `idle`,
  `quit-sent`, `exited`, `already-exited`, `degraded`). See
  [Source finalization](#source-finalization).

Three scopes, in precedence order: `taskIds`, then `parentTaskId`, then
`repoId`. `parentTaskId` exists because the other two do not cover a fan-out
that lost the ids it created — an id list dies with the context that held it,
and a repo scope hands the caller every other task's events to filter.
It is evaluated per read against `pipeline_item.parent_task_id`, so a task
created or adopted mid-watch is in scope at the next checkpoint. It covers
direct children only and excludes the parent's own events, which makes it
exactly the set `GET /v1/tasks/{task_id}` reports as `childTaskIds`.

Reparenting uses read-checkpoint semantics. Every response advances one global
sequence after evaluating the membership that exists for that read. Moving a
child away and back never rewinds the sequence or replays acknowledged events;
an event after the checkpoint is eligible if the child is back under the parent
at the next read. An event that was outside the scope when an intervening empty
read advanced past it stays ineligible after the child returns. Omitting the
cursor is the explicit way to request retained history for current membership.
The hot query always starts with the indexable `task_event.seq > ?` range and
uses `idx_pipeline_item_parent_created_id` for membership, so an empty long poll
advances past unrelated rows instead of rescanning retained history on every
recheck.

## Task Parentage

`pipeline_item.parent_task_id` is read from both ends: `GET /v1/tasks/{task_id}`
returns `parentTaskId` upward and `childTaskIds` downward. `childTaskIds` lists
direct children oldest first and **includes closed ones** — parentage is
durable, and a finished child is exactly what a fan-out orchestrator reconciles,
so an empty list means "nothing was dispatched" rather than "everything already
finished". This is deliberately unlike `GET /v1/tasks/search` and
`GET /v1/repos/{repo_id}/tasks`, which list open tasks only.

`GET /v1/tasks/{task_id}/children` is the richer join surface for that same
parentage edge. It returns direct children only, includes closed children, and
orders them oldest first. Each item contains `id`, optional `workflowName`,
optional `agent`, `createdAt`, optional `closedAt`, and optional `latestRun`
(`stage`, `kind`, `status`, `summary`, and `finishedAt`). The workflow
identity and latest run let a fan-out owner reconstruct durable child verdicts
after notifications, context compaction, or a fresh agent session; a closed
child remains part of that history because closure is lifecycle cleanup, not
parentage or verdict deletion. This route is scoped reconstruction for one
parent's fan-out/join. It is not a general endpoint for listing closed tasks;
repository task listing and search keep their existing open-task semantics.

## Activity Confirmation in `kanna-mcp`

`pipeline_item.activity` is written from the daemon's per-frame verdict, and
that classifier is stateless: `claude_status_from_lines` decides Busy from the
literal "esc to interrupt" marker being present in the frame it was handed, with
no hysteresis and no minimum dwell. A frame captured mid-redraw can lose the
marker, fall through to the trailing-prompt test, and classify a mid-turn agent
as idle — which the server correctly stores, because `activity` records the
latest verdict rather than judging it. An orchestrator polling `activity` to
decide whether a child stopped can therefore read a stop that never happened.

`kanna-mcp` smooths that at the point of consumption, asymmetrically:

- A response with nothing stopped-looking in it is returned as-is. Reporting
  busy promptly is never the misread being guarded against.
- A stopped-looking response is re-read once after `ACTIVITY_CONFIRM_DELAY`
  (1s, two daemon detection windows), and the fresher response is what the
  caller sees.
- The confirmation reports whatever it finds and never rewrites one activity
  value into another, so the three-way vocabulary is unchanged and `unread`
  keeps meaning "output nobody has read yet" rather than "stopped" — a busy
  agent can carry `unread`.
- A closed task is exempt: closure is a database fact, not a frame
  classification.
- **A failed confirmation is not a confirmation.** If the re-read fails, the
  tool call fails with a message saying the stop went unconfirmed. Returning the
  unconfirmed first sample instead would surface the exact false stop this
  exists to suppress, and `kanna_wait_task` would resolve on it.
- It smooths Busy/Idle only. `waiting` stays a positive match on prompt chrome
  in the daemon; nothing here turns quiet into blocked.

Which tools pay, and how much — the cost is always one extra `GET` of the same
route plus 1s, never one request per task:

| Tool | When the confirmation fires |
|---|---|
| `kanna_get_task` | Only when that task already looked stopped. |
| `kanna_wait_task` | Once per candidate stop, before resolving `until: finished`. Its deadline can overshoot by up to 1s, inside the 60s of headroom between `MAX_WAIT_TIMEOUT_SECS` and `CLIENT_TOOL_CALL_BUDGET_SECS`. |
| `kanna_list_recent_tasks`, `kanna_search_tasks`, `kanna_list_repo_tasks` | Whenever **any** task in the response looks stopped. For a repo listing that is the common case, so budget these at roughly +1s per call regardless of how many tasks come back. |

The event feed is not debounced: events are appended by the writes that change
the state they describe, and suppressing one would drop it rather than delay it.
`kanna-cli` does not confirm either — it is the shell interface, where a human
reads the value in context.

## Dynamic Workflow Changes

`POST /v1/tasks/{task_id}/actions/set-workflow` and
`kanna_set_task_workflow` replace an open task's current workflow name and
`pipeline_def` snapshot atomically. Resolution and serialization use the same
pinning path as task creation, including repo overrides, legacy snapshot
normalization, and retired built-in aliases (`default` resolves to
`no-review` unless the repo still defines `default.json`).

Stage mapping is deliberately strict: the new definition must contain a stage
whose name exactly matches the task's current stage. The task stays at that
stage. If it is absent, the request returns `409 Conflict`, names the
incompatible stage and workflow, and changes nothing. Kanna does not guess a
nearest stage because that could silently skip or repeat work.

A running `stage_run`, terminal session, branch, and worktree are not replaced
or killed. The live run finishes normally, and the new snapshot governs its
next transition. `revision_rounds` also remains unchanged; switching to a
higher `revision_limit` can therefore make more rounds available, while
switching to an equal or lower limit cannot reset spent rounds. A successful
change emits `task.workflow_changed` with the old and new names, current stage,
spent rounds, and new limit.

## Sticky Workflow Selection

`GET /v1/repos/{repo_id}/recent-workflows` backs the New Task modal's default
workflow: a repo's most recently used workflow outranks the one its
`.kanna/config.json` configures. The caller keeps the first returned name its
repo still offers and otherwise falls back to the configured default, so a
renamed or deleted workflow degrades instead of sticking.

It is a projection of the durable `pipeline_item.initial_pipeline` values, not
a mutable preference. That column captures the successfully created task's
choice and is intentionally not changed by dynamic re-pipelining:

- **No `closed_at` filter.** `db::snapshot` excludes closed tasks, so a create
  whose response was lost and whose task then closed — possibly from another
  window — would be invisible to a snapshot-based answer. The row is what
  matters, and the row survives the close.
- **No recovery record to reconcile or clear.** A create either commits its task
  row or it does not; there is no second write that can fail on its own and lose
  the choice, and nothing to publish after the fact.
- **Every writer feeds it, every reader agrees.** Any path that creates a task —
  desktop, LAN/mobile, relay — updates it without being instrumented, and all
  windows and restarts read the same rows.
- **Child tasks are excluded** (`parent_task_id IS NULL`). A specialty review a
  review stage dispatched is not a workflow the operator picked.

## Task Completion Notification

A task with `notify_task_id` set delivers exactly one message into that task's
terminal when it ends:

```
TASK <child-id> DONE [success|failure|closed]: <title>
```

The status vocabulary is closed — three words, matched exactly. The receiving
agent is expected to act on the payload without re-reading task state, which is
the entire point of `notify_task_id`, so the word has to carry the real outcome:

- `success` — the task ended cleanly: it advanced past its final workflow stage,
  or its session ended with no failing verdict recorded against it.
- `failure` — its terminating `stage_run` reported failure, or the agent process
  itself died (non-zero exit). A verdict of failure wins even when the PTY then
  exits 0, because an agent that reports failure and quits still failed.
- `closed` — the task was closed before finishing its workflow (sidebar ⇧⌘⌫ or
  `POST /v1/tasks/{task_id}/actions/close`). No verdict was ever reached; this is
  not a failure and must not be diagnosed as one.

The status is derived server-side from the *trigger* plus the task's terminating
run, never from the daemon `Exit` alone: the agent erroring, the task advancing
past its final stage, and a human closing the task all end the same PTY the same
way. Deriving it from the exit code alone is what made every clean completion —
and every direct close — report `DONE [failure]`.

Delivery is claimed once via `pipeline_item.notified_at` and goes through the
same two-step input helper as `POST /v1/tasks/{task_id}/input`. All of it is
server/daemon-side; it must not depend on the desktop event bridge being open.

## Merge Handoff

The generic repo-agent signal endpoint, task-input API, desktop task terminal,
KSP/relay steering, and the approve-post helper all deliver ordinary requests
to the `merge` singleton. The resolved repo agent definition independently
accepts or declines each request under the repository's checked-in policy.
Kanna does not interpret review history, bind a saved PR candidate, police
branch names, or attach an approval attestation.

The approve-post helper resolves the task's repository and sends this compact
ordinary request through the same singleton signal path:

```text
MERGE <head> -> <base> [TASK <task-id>] [PR <url>]: <summary>
```

**The handoff is the engine's obligation, not the post agent's memory.** A post
is injected into whatever agent session its stage left running, so a pr agent
that was still mid-work when the approve post arrived reads the post prompt as
its next instruction — it creates the PR, reports that, and never signals. That
happened to four consecutive review-bearing tasks on 2026-08-07, each of which
then closed leaving an open PR the merge master had never heard of.

So delivery is recorded, not assumed. `signal-merge-handoff` stamps
`pipeline_item.merge_signaled_at` *after* the request reaches the merge agent
and appends `task.merge_signaled` (`payload.source`: `agent`). Before closing a
task past a final stage whose pinned workflow declares the merge-signaling
`approve` post, the engine checks that stamp and, if the task still owes a
request, composes and delivers the identical line itself from the recorded
`pr_url` (`payload.source`: `engine`). The head branch comes from the
workspace's live branch, since the pr agent renames what it pushes; the target
is the repo's default branch. Both are hints — the merge agent resolves the
live PR and applies the repository's policy, exactly as for an agent-sent
request. Kanna still attests nothing.

If such a stage finishes with no `pr_url` at all there is nothing to hand off,
which means the approve post reported success without producing the PR it
exists to approve. The engine refuses the close: the task stays open at its
final stage, goes `unread`, and emits `task.merge_handoff_missing`. A watcher
must read that as a failed approval, never as a finished workflow.

A workflow whose final stage declares no `approve` post promised no merge side
effect, and nothing is enforced on its behalf — the same rule the desktop's
approval UI uses (`pinnedApproveMergePost`).

New merge sessions accept ordinary terminal input. On startup and after daemon
replacement, kanna-server clears the retired native-terminal-only
classification from inherited PTYs so older merge singletons also use the
normal input path. This compatibility cleanup is unrelated to daemon process
handoff and descriptor transfer, which continue to preserve PTY sessions
across desktop/server/daemon restarts and upgrades.

The native desktop still uses a private Unix control socket for desktop
adoption. Peer eligibility is checked before reading a request, and the initial
request frame has a fixed deadline so idle or unauthorized local connections
cannot retain server tasks and descriptors indefinitely.

Stage completion is bound to the run id fixed in the spawned agent's protected
environment and an immutable run-scoped completion-context file. A successor
gets a distinct file, so preparing it never publishes an identity to the live
predecessor. Continued posts rebind only the inherited process's file, under a
cross-process lock, while retaining a bounded mapping from verdict attempt keys
to their original runs. MCP and CLI adapters consult that mapping. At startup,
the server compiles the prior run-scoped format from its immutable filename and
the original run's durable exact result; request handling repeats that
server-owned check so a surviving old unlocked adapter cannot overwrite the
protection. A timed-out original verdict therefore retries its original run
and can neither complete the post nor restore stale context. Failed preparation,
replacement, close, and startup prune stale or orphaned context artifacts. The
server rejects a mismatched current run but treats an identical retry of an
already-finished run as idempotent even after a post or replacement starts. For
rolling upgrades, `runId` may be omitted only for a pre-upgrade run whose
durable `completion_bound` bit is false, and new clients tolerate old task-detail
responses that lack `latestRun.id`.

## Mobile Notification Delivery

`POST /v1/mobile/notifications` hands a validated notification to the
desktop-authenticated relay connection. The relay looks up only that Firebase
user's `pushDevices`, submits one FCM multicast, removes tokens rejected as
invalid or unregistered, and acknowledges the request over the same WebSocket.
The server response includes `acceptedCount`, `failedCount`, and aggregated
`failureReasons`. Each reason has a safe provider code, category, count, and
actionable message; it never identifies a device or includes its token, the
Firebase provider's uncontrolled raw message, credentials, or notification
contents. Older relay acknowledgements without `failureReasons` deserialize as
an empty list during rolling upgrades.

The diagnostic categories distinguish invalid tokens, relay IAM permission,
Firebase-project mismatch, APNs credentials, payload validation, rate limits,
temporary provider failures, and an unknown-provider fallback. A
`messaging/mismatched-credential` response whose provider text specifically
reports `cloudmessaging.messages.create` denied is classified as
`relayPermission`; other occurrences remain `firebaseProjectMismatch`. Relay
logs record only the desktop id and these same aggregate safe reasons.

If the Firestore lookup or Firebase Admin call rejects as a whole, there are
no per-device results to diagnose. The relay discards the exception rather
than serializing it: its log and WebSocket acknowledgement contain only the
fixed `relayDependency` category and an opaque incident id. `kanna-server`
propagates that safe acknowledgement as `503 Service Unavailable`, so HTTP,
CLI, MCP, and mobile consumers never receive the provider's raw response,
project or credential diagnostics, or token material. The incident id is the
correlation key for the matching environment's relay logs.

## Local Consumer Model

The desktop app starts `kanna-server` and supplies its config.
Local mobile development points the React Native client at the LAN URL exposed by `kanna-server`.
Consumers such as `kanna-cli` and `kanna-cli mcp serve` target the same route surface so product behavior stays consistent across clients.
The CLI remains the shell/script interface; MCP is the structured agent-tool interface.

## CLI Task Actions

- `kanna-cli task send-input --task-id <TASK_ID> --message <MESSAGE> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/input`. Input is delivered only to an active daemon PTY session, fenced to the PTY process ID observed before the first byte is submitted while the server holds the task lifecycle lease, and is never queued or stored for a later run or stage. A successful acknowledged submission prints `{ "ok": true }`; an absent or concurrently replaced session returns HTTP 409 with `reason: "no_live_agent_session"`, the latest run status/finish time when available, and explicit `kanna_resume_task` / `kanna_rerun_stage` recovery guidance. If delivery becomes uncertain after any bytes were accepted, the server reports that separately so callers do not retry blindly.
- `kanna-cli task advance-stage --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/advance-stage` and prints the action response as JSON.
- `kanna-cli task signal-merge --task-id <TASK_ID> --branch <HEAD> --target <BASE> --summary <SUMMARY> [--pr-url <URL>] [--server-url <URL>]` sends an ordinary request to the repository's merge agent.
- `kanna-cli task resume --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/resume`. It is valid only for a latest `cancelled` or `failed` run whose daemon session is dead. It resumes the provider conversation when its durable transcript and original worktree pass the shared revision-resume checks; unsupported or missing provider context starts fresh and records `resumeFallbackReason`, while task-state precondition failures return an explanatory conflict. An empty route-level 404 identifies an older server that does not provide the action. Callers may use `rerun-stage` when recovery is unavailable or a deliberately fresh conversation is acceptable.
- `kanna-cli task rerun-stage --task-id <TASK_ID> [--server-url <URL>]` calls `POST /v1/tasks/{task_id}/actions/rerun-stage`. This is always an explicit fresh provider conversation, not recovery.
- `kanna-cli task children --task-id <TASK_ID> [--server-url <URL>]` calls `GET /v1/tasks/{task_id}/children` and prints the direct-child history as JSON. It is the typed no-MCP fallback for `kanna_list_task_children`, so it reproduces the route's field set rather than summarizing it.

The provider support and daemon-loss trigger matrix is documented in
[`2026-07-30-session-death-recovery.md`](2026-07-30-session-death-recovery.md).
