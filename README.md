# Kanna

Keyboard-centric macOS app for running Claude CLI in worktrees.
Upgrade from tmux.

## Features

- Run multiple agent tasks in parallel, each in an isolated git worktree
- Real-time terminal with full Claude TUI
- Built-in diff viewer (branch, last commit, or working changes)
- One-click PR creation and merge
- PTY daemon survives app restarts
- Multi-repo support

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/jemdiggity/kanna/main/scripts/install.sh | sh
```

Requires [Claude CLI](https://docs.anthropic.com/en/docs/claude-code).

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

Release packaging remains available on top of that app graph:

```sh
bazel build -c opt //:release_apps
bazel build -c opt //:release_signed_dmgs
bazel build --config=notarize -c opt //:release
```

Release outputs land in `bazel-bin/release/`:

- `Kanna-arm64-notarized.dmg`
- `Kanna-x86_64-notarized.dmg`

The checked-in `.bazelrc` enables shared caches so Bazel work is reused across
worktrees without sharing `output_base`:

```bazelrc
build --disk_cache=~/Library/Caches/kanna-bazel/disk-cache
build --repository_cache=~/Library/Caches/kanna-bazel/repository-cache
```

That shares cacheable Bazel action results and downloaded external repositories across worktrees. It does not share the live local output tree (`output_base`, `bazel-out`, or `bazel-bin`), which remains isolated per worktree.

For notarization, export either:

- `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`
- or `APPLE_KEYCHAIN_PROFILE`

Then run the `--config=notarize` build from that shell so Bazel forwards the credentials into the notarization actions.

The release script uses the Bazel graph too:

```sh
./kd release ship --dry-run
./kd release ship --release
```

Local maintenance workflows also go through `kd`:

```sh
./kd setup --check
./kd clean --all
./kd build desktop
./kd build sidecars
./kd pages build-schema --out-dir .build/pages-schema
./kd pages publish-schema --dry-run
```

`./kd pages publish-schema` publishes `.kanna/config.schema.json` (plus its `schemas.kanna.build` `CNAME`) to <https://schemas.kanna.build/config.schema.json>. It commits the built artifact as a single orphan commit in a throwaway git worktree and force-pushes it to the `gh-pages` branch on `origin`, leaving the current worktree untouched. Run it with `--dry-run` first: that builds and reports exactly what would be committed and pushed without contacting `origin`.

Publishing has no visible effect until a human applies the one-time repository setting the command cannot: GitHub repo Settings → Pages → Source must be "Deploy from a branch", branch `gh-pages`, folder `/ (root)`.

## License

[MIT](LICENSE)
