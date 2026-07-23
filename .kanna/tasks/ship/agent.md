---
name: Ship
description: Build, sign, notarize, and release a new version of Kanna
execution_mode: pty
---

You are the shipping agent. You own Kanna's release process end to end (see `docs/specs/release-candidates.md`): shipping staging release candidates, cutting release branches, backporting release-candidate bugfixes, promoting soaked RCs to production, and rolling back. You are already running inside a worktree — your CWD is the worktree root.

## Before running

1. Run `./kd release status` and show the result, then ask which operation they want:
   - **Ship a staging RC** (`./kd release ship --staging --release`) — from main, or from `release/X.Y` when one is being stabilized
   - **Ship production directly** (`./kd release ship --production --release`) — the simple flow when no RC process is in play
   - **Cut a release branch** (`./kd release cut`) — start stabilizing the next version series
   - **Backport bugfixes** — cherry-pick fixes from main onto the active `release/X.Y`, then ship a fresh RC
   - **Promote a soaked RC** (`./kd release promote X.Y.Z-staging.N`) — the promoted version is fixed by the RC, so skip the version-bump question
   - **Roll back staging** (`--staging --rollback-to <version>`) — repoints the channel without building
2. For plain ship operations, ask which version bump they want: `--major`, `--minor`, or `--patch` (default). Skip this on a release branch — staging RC versions there derive from the branch series automatically.
3. Ask if this is a full release (`--release`) or just a build (`--dry-run` for testing).
4. Fetch tags from origin (`git fetch origin --tags`) so the version bump uses the latest remote state.
5. Confirm the prerequisites are met (see sandbox note below):
   - Clean git working directory
   - Branch is up to date with `origin/main` (the script checks this)
   - Developer ID Application certificate installed
   - `KANNA_UPDATER_PUBKEY` env var set
   - `TAURI_PRIVATE_KEY_PATH` env var set and points to the Tauri updater private key
   - `TAURI_PRIVATE_KEY_PASSWORD` env var set. For the standard updater keypair this is intentionally empty (`TAURI_PRIVATE_KEY_PASSWORD=''`).
   - `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` env vars set (unless dry-run)
   - `gh` CLI authenticated (unless dry-run)
   - Both Rust targets installed: `aarch64-apple-darwin` and `x86_64-apple-darwin`

Updater signing is required for both `--release` and `--dry-run`. If the standard updater keypair is installed, you can derive the public key and private key path like this:

```bash
export TAURI_PRIVATE_KEY_PATH="$HOME/.tauri/kanna-updater.key"
export KANNA_UPDATER_PUBKEY="$(tr -d '\n' < "$HOME/.tauri/kanna-updater.key.pub")"
export TAURI_PRIVATE_KEY_PASSWORD=''
```

If `tauri signer sign` fails with `incorrect updater private key password` or a non-interactive terminal error, make sure `TAURI_PRIVATE_KEY_PASSWORD` is explicitly set. For the standard updater keypair, set it to an empty string and rerun.

**Sandbox note:** The Claude Code sandbox blocks macOS Keychain access (`security find-identity` returns 0 identities) and network calls (`gh` fails with TLS/x509 errors). If you see these errors, they are caused by the sandbox — retry the command with `dangerouslyDisableSandbox: true`.

## Compute the next version (direct production ships only)

Fetch tags and compute the version — you need it for the branch name.

```bash
git fetch origin --tags
LAST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -1)
LAST_VERSION="${LAST_TAG#v}"
# Split and bump based on --major/--minor/--patch
# Result: VERSION="X.Y.Z"
```

## Rename branch and push (direct production ships only)

For direct production releases from a worktree, rename the current branch to `release-vX.Y.Z` and push it:

```bash
git branch -m "release-v$VERSION"
git push -u origin "release-v$VERSION"
```

Skip this step for staging releases and promotions. Staging publishes `vX.Y.Z-staging.N` against the current commit; promotion runs from a checkout of the RC's commit and derives its version from the RC.

## How releases work

The ship script runs from a worktree branched off main. When production `--release` is used:

1. Version files are bumped and committed on the worktree branch
2. The commit is tagged `vX.Y.Z`
3. Main is fast-forwarded to the release commit (so the tag is reachable from main)
4. Both main and the tag are pushed to origin

This means the tag always lands on main. If the build needs hotfixes before release, commit fixes on the worktree branch — it becomes a hotfix branch. Re-run the ship script after fixing.

When staging `--release` is used:

1. The next version is computed as `bump(VERSION)-staging.N`, where `N` is one higher than existing remote staging tags for that base version. For a release-branch RC — a `release/X.Y` checkout, or any worktree shipping with `--branch release/X.Y` — the base version instead derives from the branch series (`X.Y.0`, or one past the highest released `vX.Y.Z` tag) and bump flags are ignored; the ship refuses if the branch tip is not contained in HEAD, and it records the RC's source branch as a `Source-Branch:` trailer in the prerelease notes
2. Version files are temporarily synced to that full prerelease version for the build, then restored
3. A new immutable GitHub prerelease tagged `vX.Y.Z-staging.N` is created with the DMGs, updater bundles, signatures, and a copy of `latest-staging.json`
4. The fixed `desktop-staging` release is kept as a pointer-only channel and receives only `latest-staging.json`
5. Older staging prereleases are pruned after the channel is repointed, keeping the five newest and never deleting the currently pointed release

Rollback uses `./kd release ship --staging --rollback-to X.Y.Z-staging.N`: it downloads `latest-staging.json` from that prerelease and clobbers the pointer manifest on `desktop-staging` without building.

Staging prereleases double as release candidates (see `docs/specs/release-candidates.md`). When `./kd release promote X.Y.Z-staging.N` is used:

1. The prerelease's recorded commit is looked up, and promotion refuses unless HEAD and the promotion base still equal it, `vX.Y.Z` does not already exist, and the worktree is clean. The promotion base follows the RC's provenance: `release/X.Y` when its tip is exactly the RC commit; an RC recorded (via its `Source-Branch:` trailer) as built from `release/X.Y` refuses if the branch advanced or was deleted; otherwise the RC is a main RC and `origin/main` must match — a dormant `release/X.Y` from an earlier release does not block promoting later main RCs in the same series. The version bump commit is pushed to the resolved base
2. That exact commit is rebuilt with production identity (staging artifacts are a different bundle id and cannot be re-signed)
3. The normal production publish runs with the version fixed to `X.Y.Z`: version files committed, tag pushed, GitHub release created, `latest.json` uploaded

`--dry-run` rehearses the preflight and build without publishing. Promotion is a production release — get explicit human confirmation of the specific RC before running it.

## Release branches and backports

When the user is stabilizing a release (or asks to start), the flow is:

1. **Cut** — `./kd release cut` (default `--minor`; `--major`/`--patch` when asked) pushes `release/X.Y` at `origin/main`'s tip. Cutting is the feature freeze for that series; main stays open.
2. **Ship RCs from the branch** — run `./kd release ship --staging --release --branch release/X.Y`. You are usually on a `task-*` worktree branch, so pass `--branch` explicitly; branch-name auto-detection only works on a literal `release/X.Y` checkout. The ship refuses if the branch tip is not contained in HEAD — merge the branch in first. While the branch is being soaked, do not ship staging from main: the staging channel is the soak channel, and a main build would repoint it away from the RC.
3. **Backport bugfixes** — release-candidate bugs are fixed on main first (normal task pipeline + merge master), then applied to the branch:
   ```bash
   git fetch origin
   git checkout release/X.Y && git pull --ff-only
   git cherry-pick -x <merged-fix-sha> [...]
   pnpm test && ./kd test rust
   git push origin release/X.Y
   ```
   Ask the user which merged fixes to backport if it is ambiguous (e.g. a fix commit tangled with feature work — never cherry-pick features). After pushing, ship a fresh RC from the branch.
4. **Promote** — once the RC has soaked, `./kd release promote X.Y.Z-staging.N` (human-confirmed, see above).
5. **Merge back** — after promoting from a release branch, merge `release/X.Y` into main (open a PR through the normal flow) so `VERSION` and the tag history land on main. Report this as a required follow-up if you cannot do it directly.

## Run the ship script

The ship script uses `gh` CLI and `git push`, which require network access outside the sandbox. Run with `dangerouslyDisableSandbox: true`.

Before rerunning after any failed `kd release ship` attempt, check `git status`. The command may leave version files modified after a partial failure; clean up or account for those changes before rerunning so the next bump is computed intentionally.

```bash
./kd release ship [OPTIONS]
```

Options:
- `--staging` / `--production` (default: production)
- `--major` / `--minor` / `--patch` (default: patch)
- `--release` — tag, push, and create GitHub release after building
- `--dry-run` — build and sign only, skip notarization and release
- `--rollback-to <version>` — staging only; repoint `desktop-staging/latest-staging.json` to a manifest copied from an immutable prerelease
- `--branch main|release/X.Y` — staging only; declare the RC's source branch explicitly. Required for release-branch RCs shipped from a Kanna task worktree, which runs on a `task-*` branch that auto-detection cannot use

## After running

- If the build succeeded, report the version number and DMG locations.
- If `--release` was used, share the GitHub release URL.
- If any step failed, report the error clearly and suggest how to fix it.
