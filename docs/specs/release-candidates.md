# Release candidates: staging as the RC channel

## Problem

Staging and production channels made releases less buggy, but they created a
process trap: staging became an internal production. Staging ships are cheap
(`kd release ship --staging --release`), so they happen constantly; production
ships are a separate, unrelated decision (`kd release ship --release` rebuilds
whatever main currently points at), so they rarely happen. Nothing connects "this
staging build soaked fine for a week" to "ship that to users" — the validated
build and the released build are different commits, and the release step asks the
operator to re-decide everything from scratch.

This is a standard software release problem, not an agent problem. The standard
answer is a release-candidate pipeline: every candidate is an immutable, versioned
build of a known commit; a candidate that survives a soak period is promoted —
the same commit, not a fresh cut of trunk.

## The pattern

Staging prereleases already have RC mechanics, so Kanna does not add a third
channel. Instead it names the pattern and closes the loop:

- **Every staging ship is a release candidate.** `vX.Y.Z-staging.N` is an
  immutable prerelease whose `targetCommitish` records exactly which commit was
  built. `X.Y.Z` is the production version it is a candidate *for* (the base
  version is derived by bumping `VERSION`); `N` is the candidate number.
- **Soaking is using staging as a daily driver.** That is not a failure mode —
  it is the validation step. What was missing is the exit.
- **Promotion is the exit.** `kd release promote X.Y.Z-staging.N` turns the
  soaked candidate into the production release `X.Y.Z` of the *same commit*.
  Staging artifacts cannot be re-signed as production — the staging app is a
  different bundle identity (`build.kanna.staging`, "Kanna Staging.app") — so
  promotion rebuilds that exact commit with production identity, then runs the
  normal production publish: version-file commit, `vX.Y.Z` tag, GitHub release,
  `latest.json` updater manifest.
- **The gap stays visible.** `kd release status` reports the latest production
  release, the staging channel pointer, how many commits each lags `origin/main`,
  and prints the exact promote command when the staging build is promotable.
  "How stale is production?" becomes one command instead of archaeology.

## Promotion contract

`kd release promote <staging-version>` refuses to run unless all of these hold:

1. `<staging-version>` matches `X.Y.Z-staging.N` and the prerelease
   `vX.Y.Z-staging.N` exists on GitHub.
2. The production tag `vX.Y.Z` does not already exist (a candidate line is
   promoted at most once).
3. `HEAD` equals the prerelease's recorded `targetCommitish` (you release what
   you validated, from a checkout of it).
4. The RC's *promotion base* still equals that commit. The base is resolved
   from the RC's recorded provenance (`kd release status` applies the same
   rules when reporting promotability):
   - If `release/X.Y` exists on origin with its tip exactly at the RC commit,
     the RC promotes to the branch and the version bump is pushed there. This
     covers active branch stabilization and the cut-at-RC-commit escape below.
   - Otherwise, an RC recorded as built from `release/X.Y` (the
     `Source-Branch:` trailer in its prerelease notes) refuses — the branch
     advanced or was deleted. It never silently falls back to main.
   - Otherwise the RC is a main RC: `origin/main` must still equal the commit
     and the bump is pushed to main. A dormant `release/X.Y` left behind by an
     earlier release does **not** capture later main RCs in the same series.

When main has advanced past a main RC, the error offers the standard escape:
cut `release/X.Y` at the RC commit and promote again — the branch, not main,
then has to match. Do not weaken guard 3; promoting a commit nobody soaked
recreates the original problem.

`--dry-run` runs the same preflight and production-identity build without
publishing, for rehearsing a promotion.

## Release branches

Feature work and refactoring on main is what destabilizes releases, so the model
is trunk-based development with short-lived release branches: main is always open
for ambitious work, and stabilization happens on a branch that only accepts
bugfixes.

- **Cut.** `kd release cut [--major|--minor|--patch]` (default `--minor`)
  computes the next series from the `VERSION` file at `origin/main` — not the
  caller's worktree, which in a Kanna task can be stale — and pushes
  `release/X.Y` at `origin/main`'s tip, so the branch name and its tip can
  never disagree. Cutting is the feature freeze — for that branch only.
- **RCs from the branch.** Ship staging from a clean checkout of `release/X.Y`,
  or — from a Kanna task worktree, which always runs on a `task-*` branch even
  when the task is based on the release branch — pass `--branch release/X.Y`
  explicitly. Ship verifies the branch exists and its tip is contained in HEAD,
  derives the RC base version from the branch series (`X.Y.0`, or one past the
  highest released `vX.Y.Z` tag) instead of `VERSION` bump flags, and records
  the provenance as a `Source-Branch:` trailer in the prerelease notes — RC
  names and promotion bases can't drift from the branch the RC came from.
- **Bugfixes flow forward, then back.** Fixes land on main first through the
  normal task pipeline and merge master, then get cherry-picked onto
  `release/X.Y` (never fixed only on the branch, or the next release regresses).
  Each backport batch ends with a fresh RC.
- **Promote from the branch.** Guard 4 pins the branch tip instead of main, so
  main can run arbitrarily far ahead during the soak. The version bump commit
  lands on the branch; after promoting, merge `release/X.Y` back into main so
  `VERSION` and the tag history reach main.
- **The branch goes dormant after release.** Reuse it for `X.Y.1` hotfix RCs
  (the series versioning picks the next patch automatically); cut `release/X.(Y+1)`
  for the next feature release.

A roadmap makes the cut decision explicit: define the v1 scope (a GitHub
milestone works), and cut `release/1.0` when the last v1 feature merges.
Everything else stays guilt-free main work.

## Dogfooding

Kanna is developed in Kanna, and the staging build is the daily driver. That
stays true under this model — the meaning sharpens: **the staging channel serves
whatever is being stabilized next.** Between releases, staging RCs come from main
as they do today. While a release branch is active, staging ships come from the
branch, so the daily driver *is* the release candidate — daily driving is the
soak. Two rules keep the channel honest:

- While `release/X.Y` is being soaked, do not ship staging from main; it would
  repoint the single staging channel away from the RC mid-soak. Resume main
  staging ships after promotion.
- Bugs found while daily-driving an RC are release bugs: fix on main, backport,
  cut the next RC. That loop is the shipping agent's backport workflow.

The cost is that main features are not dogfooded during a soak window. That is
the point — those features are next release's problem — and the dev-worktree
instance (`kd dev up`) still exercises main for day-to-day development work.

## Suggested cadence

The tooling is cadence-agnostic, but the pattern works best as a lightweight
release train: cut `release/X.Y` on a schedule (or when the milestone empties),
soak by daily-driving, backport fixes as they land, and promote when
`kd release status` shows a quiet RC. A release becomes a five-minute decision
about a build that already proved itself, not a project.

## Tooling surface

- `kd release status` / MCP `release_status` — read-only channel comparison:
  production release, staging pointer, series branch (when cut), lag vs main,
  and the promote command when the RC is at its promotion base.
- `kd release cut [--major|--minor|--patch]` / MCP `release_cut` — push
  `release/X.Y` at `origin/main`.
- `kd release promote <staging-version> [--dry-run] [--arm64|--x86_64]` /
  MCP `release_promote` — implemented as a promotion preflight feeding the
  existing `shipRelease` production path (`promoteFrom` on `ReleaseShipInput`),
  so publish behavior cannot drift from `kd release ship --release`.
- `kd release ship` stays the way candidates are cut. It becomes branch-aware
  automatically on a `release/X.Y` checkout, and takes
  `--branch main|release/X.Y` to declare RC provenance explicitly from Kanna
  task worktrees (which always run on `task-*` branches).

The shipping agent (`.kanna/tasks/ship/agent.md`) owns the process end to end:
cutting branches, shipping RCs, applying release-candidate backports
(cherry-pick from main, test, push, re-RC), promoting, and merging back.
Promoting production remains a human decision: agents may cut branches, ship
staging RCs, backport, and run `release status` freely, but must not run
`kd release promote` (or `release_ship --production --release`) without an
explicit human request for that promotion, matching the mobile OTA production
rule.

## Test coverage

Runtime behavior is covered in `tools/kd/tests/release.test.ts` at the
command-runner seam (the boundary where kd invokes git/gh/bazel), including the
provenance regressions: a `task-*` worktree shipping a `release/X.Y` RC via
`--branch` (series versioning, no reliance on the local branch name, recorded
`Source-Branch:` trailer), a stale task worktree refused when the branch tip is
not contained in HEAD, a main RC that stays promotable — and pushes main — when
a dormant same-series release branch exists, a release-branch RC that still
promotes to its branch, refusals when a provenance branch advanced or was
deleted, and `release cut` deriving the series from `origin/main:VERSION`
rather than a stale local worktree. CLI/MCP wiring lives in
`tools/kd/tests/cli.test.ts` and `tools/kd/tests/mcp-tools.test.ts`. A true E2E
(real Bazel signing/notarization, GitHub releases, updater install) is not
regularly runnable for the same reasons documented at the top of
`release.test.ts` for `release ship`; it would need a hermetic release backend
with small signed fixtures and a local updater manifest server. The
command-boundary integration tests keep the regression guard at the same seam
the existing release tooling uses.
