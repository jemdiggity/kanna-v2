# Kanna

Kanna runs multiple coding agents across multiple machines. Give each stage of
a workflow its own agent and choose where a person must advance the task and
where the next stage starts automatically. A task-manager agent can create and
advance tasks through Kanna's MCP tools or CLI, then notify your iPhone when a
decision really needs you. Kanna Mobile puts the agents' terminal UIs on your
phone, and task transfer lets you push or pull work between machines.

Kanna is open source and built for small teams and solo founders. It probably
isn't the right fit for a big-corp development process.

## Bring your own model

Kanna supports the installed CLIs for **Claude**, **Codex**, **Copilot**,
**OpenCode**, and **Antigravity**. Install and authenticate at least one of
them, then Kanna spawns that CLI for each task. Authentication stays with the
provider's CLI; Kanna does not ask for or manage model-provider API keys.

Providers can be selected per task, per workflow stage, per agent, or by
repository defaults. That makes it practical to use one agent to manage work,
another to implement it, and specialist agents or local models through
OpenCode to review it.

## How it works

A Kanna task is a prompt, git worktree, branch, agent session, and current
workflow stage. Each task starts isolated from the others. Advancing a stage
forks a fresh workspace from its committed tip and starts the next stage's
agent, so only committed work crosses a stage boundary. The standalone PTY
daemon keeps sessions alive when the desktop app restarts or upgrades.

Kanna ships three public workflows:

| Workflow | Stages |
| --- | --- |
| `no-review` | Implementation, then pull request |
| `single-reviewer` | Implementation → one review → pull request |
| `specialized-reviewers` | Implementation → dispatched specialist reviews → pull request |

Every stage declares a manual or automatic transition policy. The built-ins
pause after implementation for a person to inspect the work; review stages can
advance automatically when they pass. Repositories can define their own
workflows too.

Per-repository configuration lives in [`.kanna/config.json`](.kanna/config.json):
setup and teardown commands, tests, reserved ports, the default workflow, and
agent-provider selection. See the
[published JSON Schema](https://schemas.kanna.build/config.schema.json) for the
full surface. Repository definitions in
`.kanna/agents/<name>/AGENT.md` override built-in agents by name, while an
`EXTEND.md` layers repository-specific instructions onto the resolved agent.

For implementation detail, start with the [developer docs](docs/dev/README.md)
and [feature specs](docs/specs/).

## Kanna Mobile

On the same network, Kanna Mobile connects directly to a paired machine, so
task and terminal traffic stays on the LAN. Off-network notifications still
work for free. Off-network remote terminal access uses Kanna's cloud relay and
costs **$5/month**; it is free for beta testers.

The iPhone app provides a remote terminal for agent TUIs, task and activity
views, task input with native speech-to-text, diffs, and machine pairing. From
the desktop app, tasks can be pushed to another machine or pulled back while
preserving their task history and agent session data.

## Screenshots

![Kanna desktop showing the task list, an agent terminal, and the Push to Machine command](docs/readme-assets/desktop-push-to-machine.webp)

| Mobile task list and workflow stages | Task-manager terminal on Kanna Mobile | Kanna notifications on the iOS lock screen |
| --- | --- | --- |
| ![Kanna Mobile task list showing tasks in progress and review](docs/readme-assets/mobile-workflow-stages.webp) | ![Kanna Mobile remote terminal connected to the task-manager agent](docs/readme-assets/mobile-task-manager-terminal.webp) | ![iOS lock screen showing Kanna task-manager notifications](docs/readme-assets/ios-task-notifications.webp) |

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/tampopogk/kanna/main/scripts/install.sh | sh
```

Kanna supports macOS on Apple Silicon and Intel. You need at least one
supported agent CLI installed and authenticated.

Kanna is currently looking for beta testers. Learn more at
[kanna.build](https://kanna.build).

## Developing Kanna

Developer documentation — getting started, architecture, workflow, testing,
and release — lives in [docs/dev/](docs/dev/README.md).

## Build Paths

Development uses the normal Tauri path:

```sh
./kd dev up
```

Use that for:

- local UI iteration
- worktree-aware dev environment startup
- WebDriver-backed E2E runs
- Tauri/Vite development behavior

Release packaging uses the Bazel path:

- deterministic frontend dist
- deterministic Rust/Tauri binary builds
- unsigned `.app` assembly
- signing, DMG creation, and notarization

The two paths are intentionally separate. `./kd dev up` is the dev entry point, and Bazel is the release entry point.

## Bazel Build

Unsigned desktop app:

```sh
bazel build //:kanna_app_arm64
```

Optional release-shaped unsigned app:

```sh
bazel build //:kanna_app_release_arm64
```

Optional x86_64 release app:

```sh
bazel build //:kanna_app_release_x86_64
```

This path now follows the `rules_tauri` Tauri + Vite + Vue example shape:

- Bazel builds the frontend dist at `//apps/desktop:dist`
- Bazel builds the Rust/Tauri binary at `//apps/desktop/src-tauri:kanna_desktop`
- `rules_tauri` assembles the unsigned macOS `.app`

This is the release path. It is not intended to replace `./kd dev up` for local development.

Release packaging, notarization, and publishing are owned by `kd`; do not run
the release Bazel targets directly:

```sh
./kd release setup-notarization  # one-time machine setup
./kd release ship --dry-run      # build and sign without notarizing/publishing
./kd release ship --release      # preflight, build, notarize, and publish
```

Notarization credentials live in the user's explicit file-based Keychain. The
updater private key stays in a separate owner-only file whose absolute path,
along with the public key, is configured in `~/.kanna/.env.release.local`.
This owner-only machine-global file is the only release-environment file kd
reads; repository and worktree `.env.release.local` files are ignored. See
[`docs/dev/release.md`](docs/dev/release.md) for the updater-key validation and
offline-backup requirements.

The checked-in `.bazelrc` enables shared caches so Bazel work is reused across
worktrees without sharing `output_base`:

```bazelrc
build --disk_cache=~/Library/Caches/kanna-bazel/disk-cache
build --repository_cache=~/Library/Caches/kanna-bazel/repository-cache
```

That shares cacheable Bazel action results and downloaded external repositories across worktrees. It does not share the live local output tree (`output_base`, `bazel-out`, or `bazel-bin`), which remains isolated per worktree.

Local maintenance workflows also go through `kd`:

```sh
./kd setup --check
./kd clean --all
./kd build desktop
./kd build sidecars
./kd pages build-schema --out-dir .build/pages-schema
```

`.kanna/config.schema.json` (plus its `schemas.kanna.build` `CNAME`) is published to <https://schemas.kanna.build/config.schema.json> by CI, not by hand: `.github/workflows/config-schema-pages.yml` runs on pushes to `main` that touch the schema, the workflow, or `tools/kd/**`, builds the artifact with `./kd pages build-schema`, and deploys it with `actions/upload-pages-artifact` + `actions/deploy-pages`. Merging a schema change is all it takes.

The repository's Pages source is "GitHub Actions" with a `schemas.kanna.build` custom domain, which is what makes that artifact deploy work. To republish without a schema change, re-run the workflow (`gh workflow run config-schema-pages.yml`). `./kd pages build-schema --out-dir <dir>` runs locally to inspect exactly what CI uploads.

## License

[MIT](LICENSE)
