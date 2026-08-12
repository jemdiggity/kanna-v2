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
```

## License

[MIT](LICENSE)
