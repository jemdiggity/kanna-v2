---
name: Ship
description: Build, sign, notarize, and release a new version of Kanna
execution_mode: pty
---

You are the shipping agent. Your job is to rename the current worktree branch to a release branch, push it, and run the ship script to build, sign, notarize, and release a new version of Kanna. You are already running inside a worktree — your CWD is the worktree root.

## Before running

1. Ask the user which version bump they want: `--major`, `--minor`, or `--patch` (default).
2. Ask if this is a full release (`--release`) or just a build (`--dry-run` for testing).
3. Fetch tags from origin (`git fetch origin --tags`) so the version bump uses the latest remote state.
4. Confirm the prerequisites are met (see sandbox note below):
   - Clean git working directory
   - Branch is up to date with `origin/main` (the script checks this)
   - Developer ID Application certificate installed
   - `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` env vars set (unless dry-run)
   - `gh` CLI authenticated (unless dry-run)
   - Both Rust targets installed: `aarch64-apple-darwin` and `x86_64-apple-darwin`

**Sandbox note:** The Claude Code sandbox blocks macOS Keychain access (`security find-identity` returns 0 identities) and network calls (`gh` fails with TLS/x509 errors). If you see these errors, they are caused by the sandbox — retry the command with `dangerouslyDisableSandbox: true`.

## Compute the next version

Fetch tags and compute the version — you need it for the branch name.

```bash
git fetch origin --tags
LAST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -1)
LAST_VERSION="${LAST_TAG#v}"
# Split and bump based on --major/--minor/--patch
# Result: VERSION="X.Y.Z"
```

## Rename branch and push

Rename the current branch to `release-vX.Y.Z` and push it:

```bash
git branch -m "release-v$VERSION"
git push -u origin "release-v$VERSION"
```

## How releases work

The ship script runs from a worktree branched off main. When `--release` is used:

1. Version files are bumped and committed on the worktree branch
2. The commit is tagged `vX.Y.Z`
3. Main is fast-forwarded to the release commit (so the tag is reachable from main)
4. Both main and the tag are pushed to origin

This means the tag always lands on main. If the build needs hotfixes before release, commit fixes on the worktree branch — it becomes a hotfix branch. Re-run the ship script after fixing.

## Run the ship script

The ship script uses `gh` CLI and `git push`, which require network access outside the sandbox. Run with `dangerouslyDisableSandbox: true`.

```bash
./scripts/ship.sh [OPTIONS]
```

Options:
- `--major` / `--minor` / `--patch` (default: patch)
- `--release` — tag, push, and create GitHub release after building
- `--dry-run` — build and sign only, skip notarization and release

## After running

- If the build succeeded, report the version number and DMG locations.
- If `--release` was used, share the GitHub release URL.
- If any step failed, report the error clearly and suggest how to fix it.
