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
./kd pages build-schema --out-dir <dir>  # build the config-schema Pages artifact
./kd pages publish-schema --dry-run      # report the publish plan, without touching origin
./kd pages publish-schema                # publish the artifact to gh-pages on origin
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

`./kd pages build-schema --out-dir <dir>` stages `config.schema.json` plus the
`schemas.kanna.build` `CNAME` into a Pages artifact directory;
`./kd pages publish-schema` publishes it. Publication is branch-based, not
artifact-based, because artifact deploys require GitHub Actions: the command
commits the built artifact as a single orphan commit in a throwaway git
worktree on a uniquely named temporary branch, then force-pushes it to
`gh-pages` on `origin`. The caller's worktree, index, branches, and stash
namespace are never touched, and each publish replaces the branch's content
rather than stacking history.

It refuses to run while `config.schema.json` has uncommitted changes, so what is
published always matches a committed revision. Verify with
`./kd pages publish-schema --dry-run`, which builds and reports exactly what
would be committed and pushed without contacting `origin`.

Publishing only becomes visible after a human applies the one-time repository
setting the command cannot: GitHub repo Settings → Pages → Source must change
from "GitHub Actions" to "Deploy from a branch", branch `gh-pages`, folder
`/ (root)`.

## Debugging map

| Symptom / need | Look at |
|---|---|
| Frontend behavior, console output | `/tmp/kanna-webview-*.log` (worktrees use the directory name, e.g. `kanna-webview-task-348cf000.log`; main uses a cwd hash) |
| Dev process output (vite, tauri, mobile) | `./kd dev log [mobile]`, or attach with `./kd dev up --attach` |
| Daemon behavior, PTY sessions | `kanna-daemon_*.log` in the instance's daemon dir |
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

Kanache worktree warming is enabled by default for local macOS development. Kanna-managed worktree setup runs `./kd rust-cache warm` after environment sync. Kanache copies compatible Cargo intermediates from a clean worktree with the same Rust build-input identity into the destination's private `.build/cargo-build`, including across TypeScript/mobile/docs-only commits. Kd excludes the generated `apps/desktop/src-tauri/binaries` staging root identically when recording and warming exclusion-aware manifests so final sidecars remain private to the producing build. A true legacy manifest with neither the input hash nor exclusions field can still warm only an exact-HEAD worktree with an empty requested exclusion set; reseed it to gain exclusion-aware cross-commit matching. A missing, incompatible, or refused donor is a normal cache miss and falls back to a cold private build.

Unset, blank, `KANNA_RUST_CACHE=on`, and `KANNA_RUST_CACHE=kanache` enable the cache on macOS outside CI. Set `KANNA_RUST_CACHE=off` for an immediate local rollback; CI and non-macOS environments remain disabled. A clean recent main checkout whose dev session is stopped can run `./kd test rust` once to seed both the implicit host and explicit Apple target layouts for every branch with unchanged Rust inputs. Use `./kd rust-cache status` to inspect the pinned revision, current manifest, matching mode, and recent local measurements. The rollout evidence and isolation boundaries are documented in `docs/superpowers/specs/2026-07-20-default-kanache-worktree-cache-design.md`.

Kanache is development-only. Release builds remain Bazel-only and never install or execute Kanache.

### First build in a worktree

The first `./kd dev up` in a fresh worktree reuses a Kanache donor with the same Rust build inputs and generated-output exclusion set when one is available, even when only TypeScript/mobile/docs commits differ. Older donors must be recorded again after an exact-commit build before they can seed the new exclusion-aware flow. Otherwise it compiles ~523 Rust crates into its private build tree (the daemon builds quickly, but the full Tauri app takes several minutes). Subsequent builds are incremental within that worktree.

## Physical iPhone development

For physical iPhone dev-build launches, set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME`, then run `./kd mobile run --device` from a worktree. This is the canonical single-command flow: it starts or augments the worktree dev stack with Firebase emulators, relay, desktop, and a resilient dev-client Metro on `KANNA_MOBILE_PORT`; resolves the Mac LAN IP; prints the exact Metro URL (`http://<LAN-IP>:<KANNA_MOBILE_PORT>`); then runs `expo run:ios --device <udid> --port <KANNA_MOBILE_PORT>` with `REACT_NATIVE_PACKAGER_HOSTNAME=<LAN-IP>`. It reuses the kd-managed Metro and does not kill Metro after launch. Use `./kd mobile doctor --device` to run the same on-device preflight without building or launching.

iOS requires a one-time Local Network permission grant for the dev build: Settings -> Privacy & Security -> Local Network -> Kanna = ON. If this permission is denied or dismissed, the app can show "Could not connect to development server" even when the Metro URL is correct. Troubleshooting map: "No script URL provided" means Metro is down or the app launched against the wrong port; "Could not connect to development server" means Metro is down, the phone cannot reach the printed LAN URL, or Local Network permission is off.

Mobile native identity is keyed by `KANNA_APP_ENV` from `apps/mobile/src/mobileEnvironments.json`. The iOS bundle ids are `build.kanna.app.dev` for dev, `build.kanna.app.staging` for staging, and `build.kanna.app` for production; display names are `Kanna Dev`, `Kanna Staging`, and `Kanna`. `./kd mobile run --device` resolves the environment, then runs `expo prebuild --platform ios` with `KANNA_APP_ENV` before invoking `expo run:ios`. This is the standard Expo Continuous Native Generation path: `apps/mobile/app.config.ts` sets `ios.bundleIdentifier`, and `apps/mobile/plugins/withKannaNativeIdentity.js` applies the bundle id and display name to only the `KannaMobile` app target during prebuild. Because Expo config plugins make the Xcode changes during the same prebuild-sync path that `expo run:ios` uses before compiling, there is no runtime `project.pbxproj` patch for Expo to revert; test targets such as WebDriverAgentRunner keep their own bundle ids.

Mobile OTA runtime compatibility is keyed by the `runtimeVersion` value in `apps/mobile/src/mobileEnvironments.json`. Bump this value whenever a change touches native code, native config, the Expo SDK, native dependencies, or `apps/mobile/plugins/withKannaNativeIdentity.js`; JS-only changes keep the same runtimeVersion and are OTA-deliverable.

When targeting staging on a physical iPhone, first distinguish a dev-client launch from a standalone install. Set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME` for both workflows. Use `./kd mobile run --device --staging` for live development: it starts staging dev-client Metro with `KANNA_APP_ENV=staging`, uses staging Firebase/relay defaults (`kanna-staging`, `wss://relay-staging.kanna.build`), prebuilds the staging native identity, and runs `expo run:ios` with both `--port <KANNA_MOBILE_PORT>` and `RCT_METRO_PORT=<KANNA_MOBILE_PORT>`. The resulting app requires Metro to keep running. Use `./kd mobile run --device --staging --install` when the operator asks to install staging without Metro or wants a self-contained app: it builds, installs, and launches the bundled Release app with `--no-bundler`, and it neither starts nor requires Metro. In both cases the installed `/Applications/Kanna Staging.app` desktop/server is the desktop owner; staging must not start a worktree desktop. Use `./kd mobile up --staging` only when a staging dev-client app is already installed and you only need staging Metro running; it does not install or relaunch a physical iPhone app. To use the committed persistent Buffy the Bug Slayer test identity, a human with `kanna-staging` credentials first provisions the real staging Firebase data with:

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
