# Development Workflow

Day-to-day development runs through the `kd` CLI (`./kd` at the repo root,
implemented in `tools/kd/`). `kd` is the canonical self-development surface for
both humans and agents; when an MCP client has `kd-mcp` configured, the same
tasks are available as MCP tools.

## The three contexts

We develop Kanna in and on Kanna. Any given session runs in one of:

1. **Main checkout** — the stable instance at the repo root, used to manage
   tasks and spawn worktrees.
2. **Release build** — the installed `/Applications/Kanna.app`, used when the
   main checkout itself is being modified.
3. **Dev worktree** — a task branch checked out at
   `{repo}/.kanna-worktrees/task-{uuid}`, running its own fully isolated dev
   instance.

## Worktree isolation

`kd` auto-detects the context and isolates each instance so main + N worktrees
run simultaneously without conflicts:

- **Ports** — base ports come from `.kanna/config.json` `ports` (e.g.
  `KANNA_DEV_PORT: 1420`); each worktree gets the next free offset and the
  resolved values are passed to its processes as env vars.
- **Database** — main uses `kanna-v2.db`; worktrees use
  `kanna-wt-{worktree-dir}.db` (same application-data dir).
- **Daemon** — worktrees use `{worktree}/.kanna-daemon/` instead of the
  machine's application-data directory.

Where "application data" is depends on the platform, resolved once in
`crates/runtime-defaults` and mirrored by `kd`: `~/Library/Application Support`
on macOS, and `$XDG_DATA_HOME` (else `~/.local/share`) on Linux — the same
resolution `dirs::data_dir()` performs, which is how `kanna-server` reaches the
same directory. The daemon's control sockets live in `/tmp` on macOS and in
`$XDG_RUNTIME_DIR` on Linux when the session manager provides one, because that
directory is per-user and `0700` while a shared `/tmp` socket path can be
pre-created by any local user.
- **tmux** — worktrees get their own tmux *server* named
  `kanna-{worktree-dir}`.
- **Tauri config** — `kd dev up` writes `tauri.conf.local.json` with the port
  override and passes `--config`; the committed `tauri.conf.json` is never
  modified.

`./kd env print` shows everything resolved for the current context.

## Database access protection

The database selection crosses several independently launched processes:

| Caller | Selection and context available at access |
| --- | --- |
| `kd` | Knows the worktree and explicit `--db` override; exports `KANNA_DB_NAME` and `KANNA_DB_PATH`. Its reset/delete/seed helpers also touch SQLite directly. Dev startup already refuses the production name. |
| Desktop | Reads `KANNA_DB_PATH`, then `KANNA_DB_NAME`, then its Tauri app-data directory and the default name; writes the selection into server configuration. It knows it is launching the desktop's server. |
| `kanna-server` | Reads `server.toml`; an omitted `db_path` resolves through the platform data directory. Normalizes legacy selection, relocates legacy state, then calls `Db::open_migrated`; later connections use `Db::open`. A path or the build's `environment` label does not identify the caller's intent. |
| Task-transfer | Reads `KANNA_DB_PATH` / `KANNA_CLI_DB_PATH`, otherwise prefers the canonical or legacy desktop path. The server supplies its selected path to the sidecar; companion workspace lookup independently opens SQLite. |
| CLI / MCP | Call the server API; they do not need authorization to open SQLite themselves. |
| Headless worker | The Phase 1 launcher selects a DB and supplies server configuration. A lost `--db-path`, including in an installed service unit, leaves the downstream server with a production fallback but no desktop authorization. The worker is developed separately from this checkout. |
| Tests | Unit fixtures open temporary paths directly; relocation integration tests use canonical/legacy resolvers with temporary roots; process gates launch ordinary binaries. A dependency's `cfg(test)` does not identify an integration-test child, so launch context must travel to that child. |

Database naming is not permission to open the production database. The Rust
SQLite opening and legacy-relocation boundaries enforce
`kanna_runtime_defaults::database_access`: accessing the account's real
`build.kanna/kanna-v2.db` or legacy `com.kanna.app/kanna-v2.db` requires
`KANNA_DESKTOP_DB_ACCESS=desktop`. The desktop supplies this explicitly when
spawning its server; CLI and MCP continue using that server over the API.
A standalone server must deliberately supply that authorization to run the real
desktop instance. An explicit production `db_path` alone does not authorize it.
The path and database name are unchanged, including on a fresh install.

This also covers an installed worker whose generated service unit drops
`--db-path`: its canonical fallback is refused by the server unless the process
explicitly declares desktop access. No test, worktree or XDG marker is needed
for that refusal. Passing a fallback path in server configuration grants no
authority either.

Every `kd` context exports `KANNA_DB_ISOLATED=1`. This veto takes precedence
over desktop authorization, as do test binaries, task/worktree context and
WebDriver/E2E context. On macOS, setting `XDG_DATA_HOME` also vetoes production
access: macOS ignores that variable for Application Support, so treating it as
isolation must produce an error instead of opening production. Use an explicit
isolated database path (`./kd dev up --db ...`, or `KANNA_DB_PATH` for launchers
that consume it). An isolated process can still open a temporary fixture with
the production basename outside the account's production directories.

The guard obtains the account home from the operating system, independently of
`HOME` and `XDG_DATA_HOME`, and protects its macOS Application Support and
Linux `.local/share` production locations. It checks symlinks, existing file
identity (including hard links), and existing ancestors of fresh paths before
opening SQLite. Pure path resolvers remain usable by relocation fixtures;
returning a path grants no access. `kd` additionally refuses production names
at its direct SQLite reset, delete and seed boundaries.

This is an accidental-access guard for Kanna's openers, not an OS sandbox for
arbitrary programs running as the same user. New SQLite openers must call the
shared check before touching files. A resolver-only guard was rejected because
it misses explicit paths and relocation; worktree detection alone was rejected
because it misses standalone launchers; an authorization flag alone was
rejected because inherited authorization must never override a test lane.

## kd command reference

Grouped highlights — run `./kd` for the full surface (task ids live in
`tools/kd/src/tasks/registry.ts`).

### Dev environment

```sh
./kd dev up                  # start desktop dev stack in background tmux
./kd dev up --staging        # worktree desktop against staging cloud services
./kd dev up --staging --with-credentials  # + local staging desktop auto-sign-in
./kd dev up --mobile         # + Expo mobile app
./kd dev up --emulators      # + Firebase emulators
./kd dev up --cloud staging  # dev desktop + worktree owner + staging cloud
./kd dev up --seed           # + seed data (from a worktree)
./kd dev up --attach         # attach to the tmux session
./kd dev down                # stop + reap inventoried processes; --kill-daemon also
                             #   kills the workspace daemon (pidfile + identity-matched
                             #   inventory record required, otherwise a no-op)
./kd dev restart             # stop + start (optional component: desktop|mobile|backend)
./kd dev status              # inspect tmux session status
./kd dev log                 # recent desktop output
./kd dev log mobile          # recent mobile output
./kd env print               # resolved ports, DB, daemon dir, transfer root
./kd doctor                  # prerequisite check
./kd clean --all             # remove generated artifacts
```

### Build & test

```sh
./kd build desktop           # workspace build
./kd build sidecars          # sidecar-only build + staging
./kd test all                # canonical verification: every lane, failing fast
pnpm test                    # JS/TS suite only
./kd test rust               # Rust suite only
```

### Mobile

```sh
./kd mobile run --simulator  # dev stack + boot/install/launch on the default Simulator
./kd mobile run --simulator "iPhone 17 Pro"
                             # select a Simulator by name (a UDID also works)
./kd mobile run --device     # dev stack + install/launch on a physical iPhone
./kd mobile run --device --build dev --owner staging
                             # dev iPhone app + installed staging owner/cloud
./kd mobile doctor --device  # on-device preflight without building
./kd mobile uninstall --device --staging --confirm-bundle build.kanna.app.staging
./kd mobile up --staging     # staging Metro against installed Kanna Staging
./kd mobile up --production  # mobile against installed /Applications/Kanna.app
./kd mobile ota status --staging  # OTA channel pointer; all OTA workflows in release.md
```

Always start end-to-end mobile runs from `./kd mobile run --simulator`,
`./kd mobile run --device`, `./kd dev up --mobile`, or `./kd mobile up` —
launching Expo directly from `apps/mobile` does not start
the desktop-side `kanna-server`, so the app boots but can't reach desktop
data. Physical-device flows, staging installs, and the Buffy staging test
identity are documented in detail below.

Development launches resolve three independent axes before starting anything:

| Profile | Client build identity | Desktop owner (server + daemon) | Cloud |
|---|---|---|---|
| normal dev | dev | worktree | emulators |
| mobile dev on staging | dev | installed staging | staging |
| desktop dev on staging cloud | dev | worktree | staging |
| full staging (`--staging`) | staging | installed staging | staging |
| production (`--production`) | production | installed production | production |

Use `--build`, `--owner`, and `--cloud` when a non-default axis needs to be
explicit. `--staging` remains the full-staging compatibility profile for
mobile commands and the `--cloud staging` compatibility alias for `dev up`.
Production remains behind its existing `--production` guard; kd rejects
explicit production axes. Server and daemon always move together with their
desktop owner. Command results print the resolved profile and owner/device
endpoints.

### Cloud & release

```sh
./kd cloud deploy --staging            # Firestore rules + indexes + account portal
./kd cloud deploy --staging --functions  # services/firebase-functions only
./kd cloud deploy --staging --portal     # account portal only
./kd cloud deploy --staging --relay      # relay VM only
./kd cloud deploy --production --ref release/0.2   # --ref required for production
./kd relay stats --staging             # deployed relay's /stats (--open: dashboard)
./kd release ship --dry-run            # build/sign without publishing
./kd release ship --release            # tag, publish, upload manifest
./kd release ship --staging --release  # staging channel prerelease
./kd release status                    # channel state + promotion blockers
./kd release cut / promote / reset-staging   # RC lifecycle — see release.md
./kd pages build-schema --out-dir <dir>  # build the config-schema Pages artifact (CI runs this)
```

See [Release](release.md). Never run `firebase deploy` or `pnpm exec tauri`
directly; if a `kd` workflow is broken, fix `kd` and rerun through it. Every
refused `kd` invocation — unknown flag, missing prerequisite, failed
precondition — prints its message to stderr and exits nonzero, so `kd` gates
can be scripted.

## Repo-level Kanna config: `.kanna/`

Per-repo product configuration, used by Kanna when running tasks against this
repo (and dogfooded by this repo on itself):

- `config.json` — worktree `setup` commands (here: `pnpm install`,
  `./kd env sync`, `./kd rust-cache warm`, and the optional
  `.kanna/setup.local.sh` hook), `teardown`, `test`, base `ports`, default
  workflow.
- `agents/{name}/AGENT.md` (+ optional `EXTEND.md`) — agent definitions and
  repo-local extensions.
- `workflows/{name}.json` — workflow definitions. Stage and post
  `agent_provider` entries are compact provider selectors,
  `provider[-model[-effort]]`: a plain provider id (`codex`), an optional
  model passed to the CLI verbatim (`claude-fable`, `codex-gpt-5-codex`), and
  an optional trailing effort token (`lo`/`low`, `med`/`medium`, `hi`/`high`,
  `xhi`/`xhigh`, `max`) — e.g. `claude-fable-hi`, `codex-astra-lo`. Each
  selector names exactly one provider, so an ordered fallback list gives every
  candidate its own coherent model/effort pair; anything under-specified
  inherits the provider CLI's own defaults. Selectors are workflow-JSON
  syntax only — explicit overrides, `agentProviders` entries, and agent
  frontmatter keep naming plain provider ids with separate `model`/`effort`
  fields.
- `tasks/{slug}/agent.md` — custom task templates.
- `config.local.json` — optional, gitignored, machine-local overrides for
  `config.json` (see below).
- `config.schema.json` — the public JSON Schema for `config.json`, served at
  `https://schemas.kanna.build/config.schema.json`. This checked-in file is the
  single maintained copy.

Built-in agents/workflows ship as Tauri bundled resources; per-repo files
override them by name.

Long-lived processes started by `kd`, the E2E harnesses, and the desktop app's
own daemon spawn path (when running from a worktree) are spawn-owned. Each
entry in `.kanna/kd-state/process-inventory.json` records the PID or tmux
socket **plus a spawn identity** — the kernel process start time (`ps -o
lstart=`) captured at spawn. Normal harness `finally` paths remove their
entries, while `kd dev down` and `kd clean` consume surviving entries after a
crash. Cleanup never discovers targets from process names, arguments, or
working directories, and never signals on a PID alone: the identity is
re-validated before SIGTERM and again before escalating to SIGKILL (grace 2 s),
so a reused PID can never be killed; an entry whose exit could not be
confirmed is retained rather than dropped. Inventory mutations are serialized
by an atomically published lock directory with owner metadata, and abandoned
locks (dead owner) are recovered — the same protocol is implemented in both the
kd TypeScript and the Rust desktop/daemon spawn paths. A worktree daemon also
records each `kanna-terminal-recovery` child in this inventory and removes the
record after reaping it. Cleanup deliberately terminates the daemon before its
recovery child so closing the child's control pipe can produce a clean exit
instead of leaving a daemon-owned zombie. The counterpart contract for
agents is one line in the shared task-environment prompt
(`packages/core/src/workflow/kanna-task-environment.md`): stop every background
process you start before recording stage completion. Detached repository
teardown remains best-effort, but startup failures and hard timeouts (30 min)
are logged and appended to the task event feed as `task.teardown_failed`.

### Machine-local config: `.kanna/config.local.json`

Agents, workflows, and `config.json` are resolved from `origin/<default_branch>`
at every spawn (`RepoDefinitionSnapshot::resolve`), which is why a task runs the
same way on every machine — and why, when one provider CLI hit its account usage
limit, the only way to unwedge this repo's review lane was to land a one-line
`agentProviders` reorder on `origin/main` through a merge.

`.kanna/config.local.json` is the escape hatch. It is read from the **open
repo's working tree**, not the origin snapshot, so it never needs a commit, and
it is gitignored so it never accidentally gets one. Its values are deep-merged
over the resolved `config.json`, with local winning:

```json
{
  "$schema": "https://schemas.kanna.build/config.schema.json",
  "agentProviders": {
    "*": { "provider": ["claude", "codex", "copilot", "opencode", "antigravity"] }
  }
}
```

(Strict JSON — no comments, and never committed.)

**What it may set.** Only `agentProviders`, `workflow`, `ports`, `setup`,
`teardown`, and `test` — this machine's plumbing. `vars` and `flavors` are
excluded because they feed stage prompts and agent selection: a task created
under a local value for either has a prompt no other machine can reproduce, and
nothing durable records why. That also breaks task transfer, where the
destination re-resolves definitions from its own checkout and a resumed or
re-forked stage would silently render a different prompt than the task ran with.
`workspace`, `stage_order`, `reserved_ports`, and `reserved_port_offsets` are
excluded because they are committed so every machine runs agents in the same
environment, and nothing about an outage needs them changed.

**Merge semantics**, per key, deliberately boring:

| Key | Merge |
|---|---|
| `agentProviders`, `ports` | entry by entry: a local entry replaces the committed entry of the same name; unnamed committed entries survive. One level deep — a named entry is replaced whole, not field by field. |
| `workflow` | replaces. |
| `setup`, `teardown`, `test` | replace. Arrays never concatenate: a local `setup` is the whole setup list. |

There is no delete: to drop a committed `agentProviders` entry, replace it with
the value you want instead.

**Nothing is ignored quietly.** An unknown key, a malformed value, invalid JSON,
or an unreadable file fails definition resolution with an error naming the file,
so task creation stops rather than silently running the committed config. Only
`$schema` is accepted and ignored, for editor completion.

**When it takes effect.** Task creation and stage transitions resolve
definitions fresh, so an edit reaches the next spawn; the read-only definition
lookups behind the desktop's pickers are cached per repo for 30 seconds.
Already-running agent sessions keep the configuration they started with.

**What it does to an already-stamped task.** A task's provider is stamped when
it is created and recorded on every run, and whether a local entry can move it
depends on what the next spawn is:

| Next spawn | Provider it uses | Why |
|---|---|---|
| Rerun, resume, revision, recovery | the stamp | These reproduce a *recorded run*; its provider is fed back as an explicit override, which outranks `agentProviders`. Re-resolving would break `--resume` — agent-CLI transcripts are per-provider and per-worktree — and silently change what the run is continuing. |
| Stage advance (and the fallback spawn of a stage's post, when the live session is gone) | re-resolved from the chain, with the stamp only as the final fallback | A transition is a new run of a stage, so it resolves that stage's own bindings: stage `agent_provider`, then this map (locally merged), then the agent definition, then the task's stamp. A local entry therefore does move an in-flight task at its next stage boundary — which is how a task is routed around a wedged provider without a commit. |
| Stage advance carrying `next_stage_agent_provider` | that provider, with the `next_stage_model` / `next_stage_effort` written beside it | The advance fills the explicit-override slot, so it outranks everything above for *that one stage*. Nothing is pinned: no workflow definition, no default, and no later stage changes. |

Nothing rebinds a task in place: the move happens when the task next spawns, and
never mid-run.

### Choosing the next stage's model at the boundary

`kanna_advance_stage` / `kanna-cli task advance-stage` accept a provider
override for the stage the advance *enters*:

```sh
kanna-cli task advance-stage --task-id "$TASK" --source operator \
  --next-stage-agent-provider codex \
  --next-stage-model gpt-6-astra --next-stage-effort low \
  --next-stage-provider-source agent
```

This is what turns a plan agent's build-tier recommendation into the builder
that actually runs: the human reads the plan at the `plan-build-review`
workflow's manual gate and advances with the recommended tier, and the record
keeps both facts apart — `--source operator` advanced the stage,
`--next-stage-provider-source agent` picked the model. Both are unauthenticated
caller declarations, stored on the spawned run and reported by
`kanna_get_task` as `latestRun.providerOverride`.

Model and effort need the provider beside them; a request naming one without it,
or naming a pair the provider cannot take (`codex -m opus`, an effort outside a
provider's published vocabulary) is a `400` before anything is scheduled rather
than a stage that fails at spawn and parks the task. An override is also refused
when the advance dispatches the current stage's post, because the transition
then happens when that post completes.

**What a local entry must never do is hand a task a model written for another
provider.** A local `{"provider": "claude", "model": "opus"}` entry, applied to
tasks stamped `codex`, produced `codex -m opus` — which the Codex CLI rejects
outright (`The 'opus' model is not supported when using Codex with a ChatGPT
account.`), parking the task unread with raw JSON in its terminal (2026-08-17).
Model and effort now come from the first layer that both names a value and would
itself have selected the resolved provider, so whichever provider wins above, its
model comes from the layer that chose it. Two consequences worth knowing:

- A stamped `codex` task that keeps codex runs on codex's own model, not the
  local entry's.
- In `{"provider": ["claude", "codex"], "model": "opus"}` the model belongs to
  `claude`, the leading candidate it was written beside. When claude is
  unavailable and resolution falls through to codex, codex runs on its own
  default rather than inheriting `opus` — otherwise the outage this file exists
  for would rebuild the same broken invocation. Name the model in an entry whose
  provider is a single id when you want it pinned.

Coverage: `a_stamped_provider_never_takes_a_local_model_written_for_another_provider`
in `crates/kanna-server/tests/provider_resolution_http.rs` drives the defect from
HTTP task creation through to the daemon spawn command, and
`stage_advance_takes_the_local_entry_over_the_stamp_with_a_coherent_pair` in
`crates/kanna-server/src/task_creator/tests/stage.rs` pins the table above.

**Provenance.** When the layer is active, `kanna-server` logs the file and the
overridden keys at resolution, the repo's definition manifest carries them as
`config.localOverride`, and every PTY spawn it touched prints them before setup
runs (headless SDK sessions have no terminal, so there the log and the manifest
are the record):

```
Machine-local repo config in effect
  /Users/you/code/kanna/.kanna/config.local.json
  overrides: agentProviders
```

**Granularity.** The file is per *checkout*, which is the right unit: several
Kanna instances share one repo checkout and therefore share its local config,
while a second clone of the same repo has its own. Tasks a registered repo runs
need no copy in their worktrees — the layer is read from the repo root Kanna has
registered. Note that `kd` reads only `ports` from the committed `config.json`
when deriving dev ports for a worktree; a local `ports` override changes what
Kanna gives spawned tasks, not what `./kd dev up` derives.

**Worktrees inherit it via `./kd env sync`.** A per-worktree dev instance is its
own Kanna, opening its *own* checkout, so "the open repo's working tree" is the
worktree — and `git worktree add` does not copy ignored files. Every worktree's
`setup` runs `./kd env sync`, which copies `.kanna/config.local.json` from the
repository's **primary checkout** (resolved through the common Git directory,
the same checkout `setup.local.sh` is read from) into the worktree, logging the
source path:

```
Synced Kanna dev environment files.
  machine-local repo config from /Users/you/code/kanna/.kanna/config.local.json
```

The primary checkout's copy is canonical and wins on every sync, so editing it
there reaches every worktree at its next sync. The reverse is not a delete:
if the primary checkout has no copy, a file placed directly in a worktree is
left alone (env sync says so) — propagating nothing must not destroy the only
copy of something an operator wrote deliberately.

### Machine-local workspace setup

The `setup` list optionally runs `.kanna/setup.local.sh` from the
repository's **primary checkout**. The primary checkout is deliberate: ignored
files are not copied by `git worktree add`, so one local hook there is shared by
every current and future task worktree. A missing, non-executable, or failing
hook is ignored and cannot block task creation or a stage transition.

Tracked `kd env sync` steps bracket that optional hook. Before the hook, env
sync atomically migrates any identity-safe legacy external `.build` symlink
into the durable target record, including a dangling link whose volume is
currently unavailable. After the hook, env sync captures a first-time link
created by an older installed hook. A link whose final component does not
exactly match the worktree fails setup visibly; env sync derives the target
from the link and never reconstructs the hook's machine-local external root.

Start from the committed template, from either the primary checkout or a task
worktree:

```sh
primary_checkout="$(git rev-parse --git-common-dir)/.."
cp .kanna/setup.local.sh.example "$primary_checkout/.kanna/setup.local.sh"
chmod +x "$primary_checkout/.kanna/setup.local.sh"
```

Then edit the two values at the top of the ignored local copy. For example, a
machine with an external volume mounted at `/Volumes/BUILD_DISK` can set
`external_volume=/Volumes/BUILD_DISK` and choose a repository-specific
directory such as `/Volumes/BUILD_DISK/kanna-builds/kanna-7` for
`external_build_root`. The hook uses the current worktree directory name below
that root, so `task-abc` and `task-def` get different Cargo target and build
directories. Never point two worktrees at the same external directory: Cargo
fingerprint state is mutable and sharing it can silently reuse artifacts from
another checkout.

If `.build` is already a real directory and its external destination does not
exist, the template migrates that directory intact before replacing it with a
symlink. If both locations contain state, it leaves the local directory alone
and prints a warning; it never merges or deletes build artifacts implicitly.
The one-time migration may take a while for a large build tree, while later
fresh-worktree runs only create a directory and symlink.

Do not eject the volume during a build. An ejection makes the symlink dangling
immediately and the next build fails visibly at `.build`; rerun the local hook
afterward. When setup finds its own dangling link while the volume is absent, it
first persists the exact external target in the gitignored
`.kanna-external-build-target` record, then replaces only the link with an empty
local `.build` directory and preserves the external artifacts. The target record
survives this fallback. After remounting, setup relinks an empty fallback; if
new local artifacts were produced meanwhile, it leaves them in place for an
explicit manual choice while retaining the record for teardown.

Cargo's `.cargo/config.toml` resolves `.build` and `.build/cargo-build` relative
to the worktree, and kd's sidecar staging reads final binaries through that same
worktree-private path, so the symlink preserves both Cargo isolation and the
private sidecar provenance boundary. The durable target record is `kd clean`'s
source of truth for external storage; setup computes it from its machine-local
configuration and cleanup reads it rather than duplicating that computation.
Legacy workspaces without a record still use their `.build` symlink. Cleanup
removes a target only when its final path component exactly matches the current
worktree directory. A mismatched record, a record/link disagreement, or a
chained external target fails visibly instead of risking another workspace. If
the recorded target cannot be resolved (for example, because its volume is
unavailable), cleanup fails visibly and preserves the record and local layout
for a later retry; it never reports success or guesses another path. Once the
target is available, the repository's normal `./kd clean --all` teardown
removes the exact per-workspace external directory, local `.build` path, and
target record.

The setup list comes from `origin/main` but runs against the forked branch. This
hook invocation does not depend on a tracked script in that branch: branches
cut before the hook landed either find the primary checkout's machine-local
script or take the exit-zero no-op path, so they remain transition-compatible.

### Publishing the config schema

Publishing is automatic, and there is no `kd` command that publishes.
`.github/workflows/config-schema-pages.yml` runs on pushes to `main` that touch
`.kanna/config.schema.json`, the workflow file, or `tools/kd/**`. It runs
`./kd pages build-schema --out-dir .build/pages-schema` — which stages
`config.schema.json` plus the `schemas.kanna.build` `CNAME` into an artifact
directory — then deploys that artifact with `actions/upload-pages-artifact` and
`actions/deploy-pages`.

That deploy path requires the repository's Pages source to be **"GitHub
Actions"**, which is how this repo is configured, along with the
`schemas.kanna.build` custom domain. Both are human-applied repository settings.
Branch-based publishing (pushing a built artifact to a `gh-pages` branch) is
mutually exclusive with it: a repository serves Pages from one source or the
other, never both. So do not add one — against this configuration it would push
a branch nothing serves, and switching the source to serve it would break the
workflow that publishes today.

Consequences worth knowing:

- Merging a `config.schema.json` change to `main` publishes it. Nothing else is
  needed, and nobody has to remember a manual step.
- The schema only goes live from `main`, so a branch build cannot publish.
- To republish without a schema change — after a failed run, say — re-run the
  workflow: `gh workflow run config-schema-pages.yml`, or use the Actions tab
  (it declares `workflow_dispatch`).
- `./kd pages build-schema --out-dir <dir>` still runs locally, and is the way
  to inspect exactly what CI would upload.

## Linux development (headless)

Linux has no GUI lane yet: `kd dev up` is macOS-only, and the Linux surface is
the **headless worker** — the daemon, the server, the CLI and the sidecars
under `kanna-worker`. Everything below is verified on the Ubuntu 26.04 aarch64
VM described in
[`docs/2026-09-08-linux-phase1-headless-worker.md`](../2026-09-08-linux-phase1-headless-worker.md).

Prerequisites beyond the macOS list: the apt packages in the Phase 0 baseline
(including `libssl-dev`, still a build prerequisite because two crates route
TLS through `native-tls`), and `sqlite3` for `./kd doctor`.

```bash
# One shared Ghostty checkout. Unset, libghostty-vt-sys clones the whole
# repository into every new OUT_DIR, so a `cargo test` after a `cargo build`
# re-fetches it.
git clone --filter=blob:none https://github.com/jemdiggity/ghostty.git ~/.cache/ghostty-src
git -C ~/.cache/ghostty-src checkout 665a03f380204ce1976941d36649963b4da80880
export GHOSTTY_SOURCE_DIR=$HOME/.cache/ghostty-src

./kd test rust                 # skips the desktop crate and its frontend off macOS
./kd test headless-worker      # the exit gate: a real worker, daemon, server and task

cargo build -p kanna-worker -p kanna-daemon -p kanna-server -p kanna-cli
# --lan-port because 48120 is the desktop app's: a worker refuses a port
# another Kanna instance already serves rather than stopping it.
.build/debug/kanna-worker run --data-dir ~/.local/share/Kanna \
  --db-path ~/.local/share/build.kanna/kanna-v2.db --lan-port 48140
.build/debug/kanna-worker print-unit     # inspect the systemd --user unit
.build/debug/kanna-worker install-unit   # write it, then follow the printed steps
```

Two things to know when driving a worker:

- `systemctl --user` over SSH needs `XDG_RUNTIME_DIR=/run/user/$(id -u)` and
  `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`, and surviving
  logout needs `loginctl enable-linger $USER`.
- **`SIGTERM` stops only the server.** The daemon and every agent session it
  owns keep running, exactly as they do when the desktop app is closed. The
  unit sets `KillMode=process` so a `systemctl --user restart` behaves the same
  way. `kanna-worker stop-daemon` is the full teardown.

## Debugging map

| Symptom / need | Look at |
|---|---|
| Frontend behavior, console output | `/tmp/kanna-webview-*.log` (worktrees use the directory name, e.g. `kanna-webview-task-348cf000.log`; main uses a cwd hash) |
| Dev process output (vite, tauri, mobile) | `./kd dev log [mobile]`, or attach with `./kd dev up --attach` |
| Daemon behavior, PTY sessions | `kanna-daemon.log` (current process), `kanna-daemon_*.log` (history), and `kanna-daemon-lifecycle.log` (startup/handoff audit) in the instance's daemon dir |
| Local API | `curl http://127.0.0.1:48120/v1/status` (main/production instance) |
| Resolved instance config | `./kd env print` |
| Silent agent CLI failures | The agent SDK captures stderr — check it |
| Stuck daemons across worktrees | `./kd dev down --kill-daemon`, or `./kd daemon kill` |

## Conventions and pitfalls

Coding style (TypeScript, Rust, Vue), the E2E coverage expectation, and the
hard-won "Common Pitfalls" list are maintained in
[`AGENTS.md`](../../AGENTS.md) and apply to human contributions exactly as they
do to agent contributions. Highlights you will hit early:

- Run `pnpm exec tsc --noEmit` and `cargo clippy` before calling work done;
  `cargo fmt --all` from the repo root before committing Rust.
- `cargo check --workspace` / `cargo clippy --all-targets` work in a fresh
  worktree without staging sidecars first — see "Sidecars and check-only
  builds" below for what the warning they print means.
- No `any` in TypeScript; no `unwrap()` in production Rust.
- Trace the full data flow (DB → server → store → component → daemon) before
  changing any layer; fix designs rather than layering workarounds.
- Cross-boundary behavior changes need E2E coverage, or an explicit dated note
  in `docs/` explaining why not yet (see the `*-e2e-gap.md` / `*-e2e-note.md`
  convention).

### Sidecars and check-only builds

`apps/desktop/src-tauri/tauri.conf.json` declares six `bundle.externalBin`
sidecars, staged into `apps/desktop/src-tauri/binaries/` by
`./kd build sidecars`. `tauri_build` treats a missing entry as fatal, so a
fresh worktree used to fail `cargo check --workspace` and
`cargo clippy --all-targets` on `kanna-desktop` until six extra crate builds
had been paid for — purely to lint.

The build script now decides per invocation
(`apps/desktop/src-tauri/build_support/sidecars.rs`):

- **Sidecars staged** — wired through unchanged. Nothing about a normal build
  changes.
- **Sidecars missing, check-only invocation** — `bundle.externalBin` is dropped
  from the effective `TAURI_CONFIG` and the build prints a `cargo:warning`
  naming every missing file and `./kd build sidecars`. Checking, linting, and
  `cargo test` work; the resulting binary is not a runnable app.
- **Sidecars missing, bundling or dev invocation** — hard failure with the same
  message. `KANNA_REQUIRE_SIDECARS=1` is what marks an invocation as bundling;
  every in-repo path that drives the Tauri CLI sets it (`./kd dev up`'s desktop
  window and the `tauri`, `tauri:dev`, `tauri:build` scripts in
  `apps/desktop/package.json`). The Tauri CLI's own `TAURI_CLI_VERBOSITY` is
  honored as a best-effort second signal.

Staging a sidecar dirties the build script, so a `tauri dev` that follows a
`cargo check` re-expands the full config rather than inheriting the relaxed one.

This mirrors what the Bazel release path already did: `desktop_build_script` in
`apps/desktop/src-tauri/BUILD.bazel` hands the build script
`TAURI_CONFIG={"bundle":{"externalBin":[],"resources":[]}}` and assembles the
shipped sidecars from Bazel targets, so release bundles never read
`binaries/` at all. Nothing a relaxed build produces can stand in for a real
sidecar — the entry is removed, not stubbed.

`apps/desktop/src-tauri/tests/sidecar_build_policy.rs` runs that decision's
tests under ordinary `cargo test`.

## Build caches

### kd installation cache

`./kd` and `kd-mcp` install a self-contained bundle under
`~/Library/Caches/kanna/tools/kd/<input-hash>/`. Worktrees with identical
`tools/kd` sources and resolved kd dependencies share that immutable bundle;
committed or dirty kd source changes select a new hash. Parallel cold launches
serialize on one build. The cached code still runs with the invoking
worktree's cwd, ports, database, daemon directory, and tmux identity.

### Rust build cache

Kanna can use [`kache`](https://github.com/kunobi-ninja/kache) as a
content-addressed compiler cache, pinned by exact version and per-architecture
SHA-256 in `tools/kd/src/runtime/rust-cache-policy.ts`.

**It is on by default.** It applies to every CI-less macOS Cargo command `kd`
spawns — sidecars, `./kd test rust`, and the Tauri dev window. It is on because
the measured trade below was accepted, not because it is free: you are buying
cross-worktree reuse and a much smaller build tree with a slower single-file
edit loop.

The escape hatch is one variable:

```sh
export KANNA_RUST_CACHE=off   # Cargo incremental compilation, for this shell
```

Setup installs the tool (`./kd rust-cache install`, which this repository's
`setup` list runs). If it is missing, `kd` says so once and builds without the
cache rather than downloading a compiler wrapper mid-build.

```sh
./kd rust-cache install     # downloads and checksum-verifies the pinned release
./kd rust-cache status      # pin, store path, hit/miss stats
```

Under the cache, each Cargo invocation keeps its own private `.build` and
`.build/cargo-build`; hits are materialized into that private tree, so worktrees
share compilation results without sharing Cargo's mutable fingerprint state. The
store is per repository at `~/Library/Caches/kanna/rust-kache/<repository-id>/`,
capped at 10 GiB with LRU eviction, local-only, and configured not to cache
user-facing executables so sidecars and Tauri `externalBin` inputs are always
produced in and staged from the current checkout.

The cache is hermetic, not incremental: kache strips `-C incremental` from every
invocation it handles, so `kd` sets `CARGO_INCREMENTAL=0` to match. Measured on
this repo, a cold private tree against a warm store restores 96.5% of cacheable
invocations and cuts sidecar build CPU by 56%, and `.build/cargo-build` shrinks
from 3.2 GiB to 1.9 GiB — in exchange, a one-line workspace edit rebuilds about
3x slower (re-measured at the new default: 5.47 s to 15.87 s, and 7.4x the CPU).
That last number is the one you will feel; `KANNA_RUST_CACHE=off` is there for
exactly that reason. Current measurements and the reasoning behind
the default are in
[`docs/specs/safe-rust-build-caching.md`](../specs/safe-rust-build-caching.md).

Its cross-revision key selection is exercised against the real pinned binary by
`tools/kd/tests/rust-cache.integration.test.ts`, which runs whenever that binary
is installed — the same condition under which the cache can affect a build. See
[`docs/2026-08-02-kache-cache-key-e2e-gap.md`](../2026-08-02-kache-cache-key-e2e-gap.md).
(An `E0432` failure originally blamed on kache turned out to be two of Kanna's
own test fixtures — the kd real-Cargo integration tests and the daemon's
previous-release cross-version fixture — compiling into the repository's Cargo
build directory. Both are fixed and neither was a cache defect.)

Environment resolution is authoritative: `kd` scrubs every compiler-wrapper and
`KACHE_*` control it owns before deciding, on both the enabled and disabled
paths. Setting `KANNA_RUST_CACHE=off` inside a kd-spawned shell therefore really
restores direct incremental compilation instead of leaving an inherited wrapper
in place, and an ambient `RUSTC_WORKSPACE_WRAPPER` or `KACHE_DISABLED` cannot
ride along into an enabled build.

If you previously built with the cache enabled, or ran the test suite before the
fixture-isolation fix, run `./kd clean --all` once in that worktree: a poisoned
artifact in the private tree is one Cargo considers fresh, and nothing
invalidates it automatically. When verifying that area, also remove
`.build/daemon-cross-version` — the previous-daemon fixture caches its built
binary there and skips the nested build when it exists.

The cache is development-only. Release builds remain Bazel-only:
`loadReleaseEnvironment` strips `RUSTC_WRAPPER`, `RUSTC_WORKSPACE_WRAPPER`,
`CARGO_BUILD_RUSTC_WRAPPER`, `CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER`,
`CARGO_INCREMENTAL`, and every `KACHE_*` variable, including any inherited from
the caller's shell.

### First build in a worktree

The first `./kd dev up` in a fresh worktree compiles ~523 Rust crates. With a
warm store most of those are restored rather than compiled; with a cold store
the daemon builds quickly but the full Tauri app takes several minutes.

## iOS development targets

For iOS Simulator development, run `./kd mobile run --simulator` from a
worktree. kd prefers an already booted iPhone Simulator; otherwise it selects
an iPhone from the newest installed iOS runtime. Pass an exact simulator UDID
or name after the flag to override that choice. The command boots the selected
simulator, waits for it to become ready, opens Simulator, and then follows the
same profile resolution, native prebuild, worktree/staging owner startup, and
Expo dev-client build/install path as `--device`. For the normal development
profile this starts the task-scoped Firebase emulators, relay, desktop app,
`kanna-server`, and Metro before building and opening the dev client. Because
the Simulator shares the Mac network namespace, its Metro host is
`127.0.0.1`; physical iPhones continue to use the selected Mac LAN address.
`--install` remains the physical-iPhone standalone Release flow and cannot be
combined with `--simulator`.

For physical iPhone dev-build launches, set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME`, then run `./kd mobile run --device` from a worktree. This is the canonical single-command normal-dev flow: it starts or augments the worktree dev stack with Firebase emulators, relay, desktop, and a resilient dev-client Metro on `KANNA_MOBILE_PORT`; resolves the Mac LAN IP; prints the exact Metro URL (`http://<LAN-IP>:<KANNA_MOBILE_PORT>`); then runs `expo run:ios --device <udid> --port <KANNA_MOBILE_PORT>` with `REACT_NATIVE_PACKAGER_HOSTNAME=<LAN-IP>`. It reuses the kd-managed Metro and does not kill Metro after launch. Use `./kd mobile doctor --device` to run the same on-device preflight without building or launching.

To run the dev app identity against staging, use `./kd mobile run --device --build dev --owner staging`. kd first requires the authoritative installed staging owner at `http://127.0.0.1:48121/v1/status`, verifies that desktop in the staging relay, and only then starts a mobile-only Metro, prebuilds/installs `build.kanna.app.dev`, and launches it on the attached iPhone. The device uses staging Firebase and `wss://relay-staging.kanna.build`; kd never starts or silently substitutes the worktree desktop/server. This is a development build and does not enable staging OTA/signing behavior.

iOS requires a one-time Local Network permission grant for the dev build: Settings -> Privacy & Security -> Local Network -> Kanna = ON. If this permission is denied or dismissed, the app can show "Could not connect to development server" even when the Metro URL is correct. Troubleshooting map: "No script URL provided" means Metro is down or the app launched against the wrong port; "Could not connect to development server" means Metro is down, the phone cannot reach the printed LAN URL, or Local Network permission is off.

Mobile native identity is keyed by `KANNA_APP_ENV` from `apps/mobile/src/mobileEnvironments.json`. The iOS bundle ids are `build.kanna.app.dev` for dev, `build.kanna.app.staging` for staging, and `build.kanna.app` for production; display names are `Kanna Dev`, `Kanna Staging`, and `Kanna`. Both `./kd mobile run --simulator` and `./kd mobile run --device` resolve the environment, then run `expo prebuild --platform ios` with `KANNA_APP_ENV` before invoking `expo run:ios`. This is the standard Expo Continuous Native Generation path: `apps/mobile/app.config.ts` sets `ios.bundleIdentifier`, and `apps/mobile/plugins/withKannaNativeIdentity.js` applies the bundle id and display name to only the `KannaMobile` app target during prebuild. Because Expo config plugins make the Xcode changes during the same prebuild-sync path that `expo run:ios` uses before compiling, there is no runtime `project.pbxproj` patch for Expo to revert; test targets such as WebDriverAgentRunner keep their own bundle ids.

If iOS cannot replace an installed app because its signing team's application-identifier prefix changed, remove only the affected environment with the guarded physical-device command. For staging, set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME`, then run `./kd mobile uninstall --device --staging --confirm-bundle build.kanna.app.staging`. The confirmation must exactly match the bundle id resolved from the selected environment. The command prints the selected device name, UDID, and bundle before mutation; checks whether that exact bundle is installed; uninstalls only that bundle; and verifies whether it was removed. It does not build, install, launch, or touch the production `build.kanna.app` bundle. Uninstalling deletes that environment's on-device local data and pairing state. Production additionally requires `--production --confirm-bundle build.kanna.app --confirm-production`; do not use it without explicit human authorization to remove production.

Mobile OTA runtime compatibility is keyed by the `runtimeVersion` value in `apps/mobile/src/mobileEnvironments.json`. Bump this value whenever a change touches native code, native config, the Expo SDK, native dependencies, or `apps/mobile/plugins/withKannaNativeIdentity.js`; JS-only changes keep the same runtimeVersion and are OTA-deliverable.

For the full staging identity, first distinguish a dev-client launch from a standalone install. Set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME` for both workflows. Use the compatibility profile `./kd mobile run --device --staging` for live development: it is equivalent to staging build + installed staging owner + staging cloud, starts staging dev-client Metro with `KANNA_APP_ENV=staging`, uses staging Firebase/relay defaults (`kanna-staging`, `wss://relay-staging.kanna.build`), prebuilds the staging native identity, and runs `expo run:ios` with both `--port <KANNA_MOBILE_PORT>` and `RCT_METRO_PORT=<KANNA_MOBILE_PORT>`. The resulting app requires Metro to keep running. Use `./kd mobile run --device --staging --install` when the operator asks to install staging without Metro or wants a self-contained app: it builds the bundled Release app with `xcodebuild` (automatic signing with `-allowProvisioningUpdates`, so a changed entitlement can mint a fresh provisioning profile — this requires an Apple ID for the team in Xcode → Settings → Accounts), then installs and launches it with `devicectl`; it neither starts nor requires Metro. Both paths default their marketing version to `apps/mobile/VERSION`, independently of the active desktop staging RC, and do not query desktop release status to choose it. An explicit `KANNA_APP_VERSION` overrides only that marketing version. In both cases the installed `/Applications/Kanna Staging.app` desktop/server is the desktop owner; staging must not start a worktree desktop. Use `./kd mobile up --staging` only when a staging dev-client app is already installed and you only need staging Metro running; it does not install or relaunch a physical iPhone app. To use the committed persistent Buffy the Bug Slayer test identity, a human with `kanna-staging` credentials first provisions the real staging Firebase data with:

```bash
gcloud auth application-default login
pnpm --dir services/firebase-functions exec node scripts/provision-staging-buffy-user.mjs
KANNA_E2E_DEVICE_TOKEN=staging-buffy-device-token ./kd mobile up --staging
```

The script is idempotent: it upserts the Firebase Auth user `upvote.sieve.7t@icloud.com` / `password123` with display name `Buffy the Bug Slayer`, stores the committed avatar reference `file://services/firebase/emulator-seed/assets/buffy-avatar.jpg`, and merges `devices/staging-buffy-device-token` in `kanna-staging` Firestore so the staging relay can authenticate the desktop when that token is supplied. Use `--dry-run` on the script to print the planned Auth user and Firestore document without writing staging data.

Appium device smoke is local/human-only, after the app is installed:

```bash
pnpm --dir apps/mobile run test:e2e:device:preflight
pnpm --dir apps/mobile run test:e2e:device:smoke
```

Device smoke reuses an existing kd-managed Metro on `KANNA_MOBILE_PORT` and only
stops Metro when the smoke runner started that Metro itself. Set
`KANNA_IOS_DEVICE_UDID` for an exact device, or `KANNA_IOS_PHYSICAL_DEVICE_NAME`
to target the visible phone name — one of them is required when more than one
iPhone is attached.
