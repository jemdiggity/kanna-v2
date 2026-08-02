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
  `kanna-wt-{worktree-dir}.db` (same Application Support dir).
- **Daemon** — worktrees use `{worktree}/.kanna-daemon/` instead of
  `~/Library/Application Support/Kanna/`.
- **tmux** — worktrees get their own tmux *server* named
  `kanna-{worktree-dir}`.
- **Tauri config** — `kd dev up` writes `tauri.conf.local.json` with the port
  override and passes `--config`; the committed `tauri.conf.json` is never
  modified.

`./kd env print` shows everything resolved for the current context.

## kd command reference

Grouped highlights — run `./kd` for the full surface (task ids live in
`tools/kd/src/tasks/registry.ts`).

### Dev environment

```sh
./kd dev up                  # start desktop dev stack in background tmux
./kd dev up --mobile         # + Expo mobile app
./kd dev up --emulators      # + Firebase emulators
./kd dev up --seed           # + seed data (from a worktree)
./kd dev up --attach         # attach to the tmux session
./kd dev down                # stop; --kill-daemon also kills workspace daemons
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
./kd mobile run --device     # dev stack + install/launch on a physical iPhone
./kd mobile doctor --device  # on-device preflight without building
./kd mobile up --staging     # staging Metro against installed Kanna Staging
./kd mobile up --production  # mobile against installed /Applications/Kanna.app
./kd mobile ota status --staging  # OTA channel pointer; all OTA workflows in release.md
```

Always start end-to-end mobile runs from `./kd dev up --mobile` or
`./kd mobile up` — launching Expo directly from `apps/mobile` does not start
the desktop-side `kanna-server`, so the app boots but can't reach desktop
data. Physical-device flows, staging installs, and the Buffy staging test
identity are documented in detail in
[Physical iPhone development](#physical-iphone-development) below.

### Cloud & release

```sh
./kd cloud deploy --staging            # Firebase; add --relay for the relay
./kd cloud deploy --production
./kd release ship --dry-run            # build/sign without publishing
./kd release ship --release            # tag, publish, upload manifest
./kd release ship --staging --release  # staging channel prerelease
./kd pages build-schema --out-dir <dir>  # build the config-schema Pages artifact (CI runs this)
```

See [Release](release.md). Never run `firebase deploy` or `pnpm exec tauri`
directly; if a `kd` workflow is broken, fix `kd` and rerun through it.

## Repo-level Kanna config: `.kanna/`

Per-repo product configuration, used by Kanna when running tasks against this
repo (and dogfooded by this repo on itself):

- `config.json` — worktree `setup` commands (here: `pnpm install`,
  `./kd env sync`), `teardown`, `test`, base `ports`, default pipeline.
- `agents/{name}/AGENT.md` (+ optional `EXTEND.md`) — agent definitions and
  repo-local extensions.
- `pipelines/{name}.json` — pipeline definitions.
- `tasks/{slug}/agent.md` — custom task templates.
- `config.schema.json` — the public JSON Schema for `config.json`, served at
  `https://schemas.kanna.build/config.schema.json`. This checked-in file is the
  single maintained copy.

Built-in agents/pipelines ship as Tauri bundled resources; per-repo files
override them by name.

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
Branch-based publishing (a `gh-pages` push) is mutually exclusive with it and
would serve nothing; the `kd pages publish-schema` command that did that was
removed for exactly that reason.

Consequences worth knowing:

- Merging a `config.schema.json` change to `main` publishes it. Nothing else is
  needed, and nobody has to remember a manual step.
- The schema only goes live from `main`, so a branch build cannot publish.
- To republish without a schema change — after a failed run, say — re-run the
  workflow: `gh workflow run config-schema-pages.yml`, or use the Actions tab
  (it declares `workflow_dispatch`).
- `./kd pages build-schema --out-dir <dir>` still runs locally, and is the way
  to inspect exactly what CI would upload.

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
- No `any` in TypeScript; no `unwrap()` in production Rust.
- Trace the full data flow (DB → server → store → component → daemon) before
  changing any layer; fix designs rather than layering workarounds.
- Cross-boundary behavior changes need E2E coverage, or an explicit dated note
  in `docs/` explaining why not yet (see the `*-e2e-gap.md` / `*-e2e-note.md`
  convention).

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

**It is off by default and must be opted into.** Its key selection is not
demonstrated by canonical automation — exercising the real pinned binary needs a
network download that `pnpm test` and `./kd test all` deliberately avoid — so
turning it on is a deliberate choice rather than a default. (An `E0432` failure
originally blamed on kache turned out to be two of Kanna's own test fixtures —
the kd real-Cargo integration tests and the daemon's previous-release
cross-version fixture — compiling into the repository's Cargo build directory.
Both are fixed and neither was a cache defect.) Details in
[`docs/2026-08-02-kache-cache-key-e2e-gap.md`](../2026-08-02-kache-cache-key-e2e-gap.md).

To opt in for a shell:

```sh
export KANNA_RUST_CACHE=on
./kd rust-cache install     # downloads and checksum-verifies the pinned release
./kd rust-cache status      # pin, store path, hit/miss stats
```

`KANNA_RUST_CACHE=on` also enables it for CI-less macOS builds `kd` spawns —
sidecars, `./kd test rust`, and the Tauri dev window. Anything else leaves Cargo
running against rustc directly.

When enabled, each Cargo invocation keeps its own private `.build` and
`.build/cargo-build`; hits are materialized into that private tree, so worktrees
share compilation results without sharing Cargo's mutable fingerprint state. The
store is per repository at `~/Library/Caches/kanna/rust-kache/<repository-id>/`,
capped at 10 GiB with LRU eviction, local-only, and configured not to cache
user-facing executables so sidecars and Tauri `externalBin` inputs are always
produced in and staged from the current checkout.

Enabling it is hermetic, not incremental: kache strips `-C incremental` from
every invocation it handles, so `kd` sets `CARGO_INCREMENTAL=0` to match.
Measured on this repo, a cold private tree against a warm store restores 96.5%
of cacheable invocations and cuts sidecar build CPU by 56%, and
`.build/cargo-build` shrinks from 3.2 GiB to 1.9 GiB — in exchange, a one-line
workspace edit rebuilds about 3.5x slower (2.80 s to 9.87 s).

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

## Physical iPhone development

For physical iPhone dev-build launches, set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME`, then run `./kd mobile run --device` from a worktree. This is the canonical single-command flow: it starts or augments the worktree dev stack with Firebase emulators, relay, desktop, and a resilient dev-client Metro on `KANNA_MOBILE_PORT`; resolves the Mac LAN IP; prints the exact Metro URL (`http://<LAN-IP>:<KANNA_MOBILE_PORT>`); then runs `expo run:ios --device <udid> --port <KANNA_MOBILE_PORT>` with `REACT_NATIVE_PACKAGER_HOSTNAME=<LAN-IP>`. It reuses the kd-managed Metro and does not kill Metro after launch. Use `./kd mobile doctor --device` to run the same on-device preflight without building or launching.

iOS requires a one-time Local Network permission grant for the dev build: Settings -> Privacy & Security -> Local Network -> Kanna = ON. If this permission is denied or dismissed, the app can show "Could not connect to development server" even when the Metro URL is correct. Troubleshooting map: "No script URL provided" means Metro is down or the app launched against the wrong port; "Could not connect to development server" means Metro is down, the phone cannot reach the printed LAN URL, or Local Network permission is off.

Mobile native identity is keyed by `KANNA_APP_ENV` from `apps/mobile/src/mobileEnvironments.json`. The iOS bundle ids are `build.kanna.app.dev` for dev, `build.kanna.app.staging` for staging, and `build.kanna.app` for production; display names are `Kanna Dev`, `Kanna Staging`, and `Kanna`. `./kd mobile run --device` resolves the environment, then runs `expo prebuild --platform ios` with `KANNA_APP_ENV` before invoking `expo run:ios`. This is the standard Expo Continuous Native Generation path: `apps/mobile/app.config.ts` sets `ios.bundleIdentifier`, and `apps/mobile/plugins/withKannaNativeIdentity.js` applies the bundle id and display name to only the `KannaMobile` app target during prebuild. Because Expo config plugins make the Xcode changes during the same prebuild-sync path that `expo run:ios` uses before compiling, there is no runtime `project.pbxproj` patch for Expo to revert; test targets such as WebDriverAgentRunner keep their own bundle ids.

Mobile OTA runtime compatibility is keyed by the `runtimeVersion` value in `apps/mobile/src/mobileEnvironments.json`. Bump this value whenever a change touches native code, native config, the Expo SDK, native dependencies, or `apps/mobile/plugins/withKannaNativeIdentity.js`; JS-only changes keep the same runtimeVersion and are OTA-deliverable.

When targeting staging on a physical iPhone, first distinguish a dev-client launch from a standalone install. Set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME` for both workflows. Use `./kd mobile run --device --staging` for live development: it starts staging dev-client Metro with `KANNA_APP_ENV=staging`, uses staging Firebase/relay defaults (`kanna-staging`, `wss://relay-staging.kanna.build`), prebuilds the staging native identity, and runs `expo run:ios` with both `--port <KANNA_MOBILE_PORT>` and `RCT_METRO_PORT=<KANNA_MOBILE_PORT>`. The resulting app requires Metro to keep running. Use `./kd mobile run --device --staging --install` when the operator asks to install staging without Metro or wants a self-contained app: it builds the bundled Release app with `xcodebuild` (automatic signing with `-allowProvisioningUpdates`, so a changed entitlement can mint a fresh provisioning profile — this requires an Apple ID for the team in Xcode → Settings → Accounts), then installs and launches it with `devicectl`; it neither starts nor requires Metro. In both cases the installed `/Applications/Kanna Staging.app` desktop/server is the desktop owner; staging must not start a worktree desktop. Use `./kd mobile up --staging` only when a staging dev-client app is already installed and you only need staging Metro running; it does not install or relaunch a physical iPhone app. To use the committed persistent Buffy the Bug Slayer test identity, a human with `kanna-staging` credentials first provisions the real staging Firebase data with:

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
