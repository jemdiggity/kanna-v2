# Provider Resume Ownership Design

## Goal

Make revision resume fail closed unless Kanna can prove that the selected provider
conversation belongs to the exact task run and daemon spawn being resumed. Preserve
fresh numbered-workspace fallback behavior whenever proof or daemon support is
missing.

## Ownership Model

The durable terminal `session_id` is intentionally reused when a task changes
stages, so it cannot identify a process or stage run. Kanna Server will generate the
owning main `stage_run.id` before each daemon spawn and use it as the immutable
`run_id` carried by that spawn. The value is:

- the primary key of the owning main `stage_run`;
- sent in both PTY and headless daemon spawn commands;
- retained by the daemon for that process lifetime; and
- echoed on `SessionCreated`, `ProviderSessionChanged`, and `Exit` events.

Provider-handle persistence will update a stage run by `run_id`, never by selecting
the newest row sharing a reusable terminal ID. Events from an old process therefore
remain attributable to the old main run after a replacement starts.

A post sent into an existing process is a continuation rather than a new spawn. Its
post run may inherit an already-known provider handle for display, but subsequent
handle discovery remains owned by the main run whose `run_id` started the process.
Revision selection reads main runs only.

## Spawn Ordering

Kanna Server will generate and insert the main stage-run ID before asking the daemon
to spawn. This closes the race in which the daemon can broadcast provider metadata
before the row exists.

The pre-spawn row starts in `pending`. A successful `SessionCreated` promotes it to
`running` while applying the prepared task stage and workspace changes. A failed
spawn marks it `failed` and performs the existing worktree rollback where applicable.
No provider event needs an in-memory retry queue, and ownership survives a server
restart.

## Codex Handle Discovery

Interactive Codex output is assistant-controlled and is not an identity channel.
Kanna will stop extracting a resume UUID from visible terminal footer text.

For a fresh Codex PTY spawn, the daemon records the Codex session IDs already present
before launching the process. It then discovers the new conversation through
Codex-owned `session_meta` records under the effective Codex home. A candidate is
accepted only when:

- its origin is the Codex TUI;
- its canonical working directory equals the spawned worktree;
- its UUID was not present in the pre-spawn snapshot; and
- it was created during the current spawn lifetime.

An already-resumed Codex run keeps the server-supplied, previously verified handle.
If discovery is absent or ambiguous, the run remains without a handle and later
revision preparation forks fresh. A forged `codex resume <UUID>` assistant message
cannot affect discovery; a regression fixture will place forged footer text before
a genuine provider metadata record and require the genuine ID.

## Resume Selection

The database query returns the newest main run for the requested stage regardless of
whether it has a handle. The caller then validates that exact run's provider, handle,
working directory, transcript prerequisites, committed tip, and current provider
definition.

Kanna never skips a newer incomplete or different-provider run to resume an older
conversation. For example, an older Claude run with a handle followed by a newer
Codex run without one must fork fresh.

## Daemon Capability Negotiation

The existing `List` response will include optional protocol capabilities. Extra
response fields remain readable by old servers, while their absence identifies an
old daemon to a new server. Capabilities cover:

- immutable spawn ownership;
- provider-session events;
- provider resume parameters; and
- the negotiated event-stream version.

New event variants are delivered only on a versioned subscription selected after
capability negotiation. The legacy `Subscribe` stream continues to contain only
legacy variants, so an old Kanna Server connected to a new daemon cannot lose its
stream on `ProviderSessionChanged`.

Before spawning a prepared resume, a new server requires the daemon to advertise
both provider resume and immutable spawn ownership. If either is absent, it returns
a compatibility error before inserting or recording a resumed run. The revision
caller can retain or retry the existing safe fresh-fork path; it must never claim
that an old daemon honored an ignored resume field.

Fresh non-resume spawns remain available across mixed versions. Provider handles
from legacy events are not persisted without immutable ownership.

## Database Changes

No stage-run ownership column is needed: `stage_run.id` is already immutable and
unique. Legacy daemon events that do not carry a run ID cannot receive newly
discovered handles through the ownership-sensitive update path.

The provider-handle update takes `run_id` and updates only that matching main run
when its handle is null. It reports whether a row changed. Updating
`pipeline_item.agent_session_id` is allowed only when the event's spawn still owns
the task's active run.

## Failure Handling

All uncertainty fails toward a fresh conversation:

- unverified or ambiguous Codex metadata leaves the handle null;
- missing spawn ownership ignores delayed provider metadata;
- a newest main run without a valid handle blocks older candidates;
- a stale event can update only its historical owning main run;
- a daemon without resume capability causes an error before resumed-run recording;
  and
- failed spawns leave a failed diagnostic run rather than a falsely running or
  resumed row.

## Testing

Focused regressions will cover:

- forged Codex footer text before genuine provider metadata;
- provider discovery emitted before the spawn call returns and before the run would
  previously have been inserted;
- a delayed old-spawn event after a replacement run starts;
- main run to commit-post continuation to replacement, proving the old handle stays
  on the owning main run;
- an older Claude handle followed by a newer null-handle Codex or other-provider
  main run;
- a new server refusing resume against an old daemon without recording a resumed
  run;
- an old server retaining its legacy subscription when connected to a new daemon;
  and
- protocol serialization defaults for both mixed-version directions.

Focused daemon, server database, lifecycle, revision, and watcher tests run before
the canonical `./kd test rust` suite.
