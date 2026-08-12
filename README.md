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
./kd release setup-updater-key   # one-time updater-key import
./kd release ship --dry-run      # build and sign without notarizing/publishing
./kd release ship --release      # preflight, build, notarize, and publish
```

The setup commands store notarization credentials and updater private signing
material in the user's explicit file-based Keychain. Only non-secret Keychain
selectors are written to `~/.kanna/.env.release.local`; Apple IDs, passwords,
private keys, and API private keys never belong in plaintext release config.
This owner-only machine-global file is the only release-environment file kd
reads; repository and worktree `.env.release.local` files are ignored. See
[`docs/dev/release.md`](docs/dev/release.md) for the one-time updater-key import
and offline-backup procedure.

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
