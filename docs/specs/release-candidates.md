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
answer is a release-candidate workflow: every candidate is an immutable, versioned
build of a known commit; a candidate that survives a soak period is promoted —
the same commit, not a fresh cut of trunk.

## The pattern

Staging prereleases already have RC mechanics, so Kanna does not add a third
channel. Instead it names the pattern and closes the loop:

- **Every staging ship is a release candidate.** `vX.Y.Z-staging.N` is an
  immutable prerelease whose `targetCommitish` records exactly which commit was
  built. `X.Y.Z` is the production version it is a candidate *for* (the base
  version on main is derived by bumping the greater of `VERSION` and the
  greatest valid production semantic version reported by GitHub, so release
  creation order and stale trunk metadata cannot create a downgrade); `N` is
  the candidate number.
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
  and the exact promote command when — and only when — every promotion gate
  passes. "How stale is production?" becomes one command instead of archaeology.

## The channel is a state machine, not a pointer

`desktop-staging` is one pointer serving one candidate, so *how* the channel
reached its current candidate is part of its state. Mechanical alignment — the
RC commit equals its promotion branch tip — says nothing about that.

The v0.1.0-staging.7 → v0.1.0-staging.8 incident is the whole argument.
`.7` targeted main at `09f4551`. `.8` targeted `release/0.1` at `bdbddb9`, a
branch cut long before: `.8` added 12 commits past the shared merge base while
dropping roughly 640 commits that `.7` had. Every mechanical check passed —
`.8`'s commit *was* `release/0.1`'s tip — and `kd release status` reported it
promotable. Promoting it would have shipped a months-old trunk to users as a
forward release.

So the lifecycle enforces four things `kd` can actually prove from git and the
GitHub release metadata, and reports the rest rather than pretending to enforce
it.

### 1. A staging publish moves the channel forward

Before anything is built, `kd release ship --staging` resolves the active
candidate (the version in `latest-staging.json` on `desktop-staging`, then that
prerelease's `targetCommitish` and `Source-Branch:` trailer) and compares it with
the commit about to be built:

| Relationship of the new commit to the active candidate | Result |
|---|---|
| same commit (a rebuild) | allowed |
| descendant | allowed |
| ancestor (a rollback) | refused — use `--rollback-to` or a reset |
| diverged, promoted release-branch RC → forward main | allowed — promotion identity and branch-point ancestry verified; provenance recorded |
| diverged (the incident) | refused — ship a descendant, or record a reset |
| unresolvable / active candidate metadata unreadable | refused — fail closed |
| channel unreadable (network, rate limit, 5xx, bad manifest) | refused — fail closed |
| no active candidate (channel uninitialized) | allowed — channel initialization |

The last two rows are the same failed command from the outside, and telling them
apart is the difference between a safe tool and one that fails open. "Empty" is
therefore only ever a *positive* answer: either the `desktop-staging` release
does not exist (a real 404), or it exists and its asset list does not contain
`latest-staging.json`. The asset list is queried first for exactly this reason —
asset presence is data, not an inference from why a download failed. Anything
else that stops kd reading the pointer — an unrecognized `gh` failure, a
download error against a manifest that *is* listed, a manifest that does not
parse, or a candidate whose prerelease metadata cannot be resolved — is an
error, because moving the pointer would then be unverifiable. The same
distinction governs `kd release status`, which reports an unreadable channel as
a blocker rather than the calm "no candidate is active", and
`kd release cut --abandon-series`, which refuses to abandon a series when it
cannot confirm whether the channel still serves it.

The gate runs for `--dry-run` too: a rehearsal exists to surface the blocker
before a signed build, not after one.

### 2. A release-branch RC builds the branch tip exactly

Shipping an RC with `--branch release/X.Y` (or from a `release/X.Y` checkout)
requires `HEAD` to *equal* the remote branch tip. Containment is not enough:
under containment a worktree could ship an RC carrying commits that were never
on the branch it names as its promotion base, so the recorded `Source-Branch:`
and the artifact disagreed. Backports therefore land on the branch first, and the
RC is built from a checkout of the pushed tip:

```sh
git fetch origin release/1.3 && git checkout --detach FETCH_HEAD
./kd release ship --staging --release --branch release/1.3
```

### 3. An active release soak freezes main staging publishes

While the channel serves an *unpromoted* `release/X.Y` candidate — its production
tag `vX.Y.Z` does not exist yet — a main staging publish is refused. It would
repoint the one staging channel away from the RC mid-soak. Main resumes
automatically after promotion only when `vX.Y.Z` is a real GitHub production
release whose remote and freshly fetched tag resolve either to the active
candidate's recorded commit or to kd's single-parent `release: vX.Y.Z` version
bump directly atop it, and the proposed main commit descends from the merge-base
of `origin/main` and the candidate's resolved source branch. (GitHub records
`targetCommitish: "main"` for the existing-tag release, so the immutable proof
comes from both git tag resolutions.) That verified hand-back records a
`Post-Promotion-Trunk-Resumption:` audit block on `desktop-staging`.
A merely present or mismatched tag does not lift the lineage gate. The explicit
reset below remains available for an actual abandonment. Shipping the release
branch itself is never frozen.

### 4. Every non-linear move is narrow and recorded

Three paths may move the channel against raw commit ancestry:

- `kd release ship --staging --rollback-to X.Y.Z-staging.N` repoints the manifest
  to an existing prerelease. It builds nothing and it is already deliberate.
- The first forward-main publish after a release-branch RC was genuinely
  promoted may diverge because backports have different SHAs. It is automatic
  only after the promotion/tag and branch-point proofs above, and records the
  promoted version, RC commit, production tag commit, plus the new branch,
  commit, and timestamp.
- `kd release reset-staging` abandons the current lineage so the *next* publish
  may diverge.

Nothing else may. There is no flag on an ordinary ship that weakens the gates.

## The reset / abandon operation

Reset is exceptional abandonment, not a routine series hand-back. A normal
post-promotion transition from `release/X.Y` to forward `main` uses the verified,
recorded path above and does not require `reset-staging`.

```sh
./kd release reset-staging \
  --to main \
  --reason "0.1 soak abandoned; the fix shipped on main instead" \
  --confirm-abandon 0.1.0-staging.8
```

- **Visibly separate from shipping.** Its own command and its own MCP tool
  (`release_reset_staging`); it never runs as a fallback inside `ship`.
- **Human-shaped confirmation.** `--to`, `--reason`, and `--confirm-abandon` are
  all required with no defaults, and `--confirm-abandon` must name the exact
  active staging version — which means reading `kd release status` first. The MCP
  schema requires the same three fields, so an agent cannot satisfy it by
  omission.
- **Records provenance.** It writes a `Lineage-Reset:` block onto the
  `desktop-staging` release body naming the abandoned version, its commit and
  source branch, the destination branch, the reason, and the timestamp. Earlier
  blocks are kept below the newest as an audit trail.
- **Changes nothing else.** It builds nothing, publishes nothing, and does not
  repoint the manifest — staging users keep running the candidate they have until
  the next publish.
- **Single-use by construction.** The record authorizes exactly the next publish
  that leaves the named candidate for the named branch. Once that publish lands,
  the active candidate changes and the record no longer matches, so the
  authorization expires without any bookkeeping. It also does not authorize a
  publish to a *different* branch.

A divergence that a reset authorized is reported by `kd release status` as
`relationship: "diverged"` with `valid: true` and `authorizedByReset: true`, and
it is promotable. That is the point: the deliberate path stays open, and the
record says who decided and why.

A verified post-promotion hand-back is likewise reported with
`relationship: "diverged"`, `valid: true`, and `authorizedByPromotion: true`,
with the parsed `postPromotion` record and an explicit human-readable reason.
This is the only automatic divergent move.

## Promotion contract

`kd release promote <staging-version>` refuses to run unless all of these hold:

1. `<staging-version>` matches `X.Y.Z-staging.N`, and GitHub identifies the
   selected object as that exact prerelease. Its release notes and versioned
   `latest-staging.json` must name the same version, its `targetCommitish` must
   be a full commit SHA, and both the remote tag and a freshly fetched tag must
   resolve to that SHA. The `Source-Branch:` trailer must be `main` or the
   matching `release/X.Y` branch.
2. The production tag `vX.Y.Z` does not already exist (a candidate line is
   promoted at most once).
3. `HEAD` equals the prerelease's recorded `targetCommitish` (you release what
   you validated, from a checkout of it).
4. **Mechanical base.** The RC's promotion base still equals that commit. The
   base is resolved from the RC's recorded provenance:
   - If `release/X.Y` exists on origin with its tip exactly at the RC commit,
     the RC promotes to the branch and the version bump is pushed there. This
     covers active branch stabilization and the cut-at-RC-commit escape below.
   - Otherwise, an RC recorded as built from `release/X.Y` (the
     `Source-Branch:` trailer in its prerelease notes) refuses — the branch
     advanced or was deleted. It never silently falls back to main.
   - Otherwise the RC is a main RC: `origin/main` must still equal the commit
     and the bump is pushed to main. A dormant `release/X.Y` left behind by an
     earlier release does **not** capture later main RCs in the same series.
5. **Lineage validity.** The candidate reached the channel legally: it is the
   first candidate, or a rebuild of, or a descendant of, the candidate published
   before it — or its divergence was authorized by a recorded reset. An
   unresolvable comparison fails closed. This is the guard the incident needed;
   it is not waivable by a flag, because the intended escape is to record the
   reset before shipping the candidate.
6. **Soak.** The prerelease has been published for at least
   `productionSoakHours` (see below). This is the only gate with an override.

Failures are reported together, not one at a time, so a blocked promotion tells
the operator everything standing between the candidate and production.

`--dry-run` runs the same preflight and production-identity build without
publishing, for rehearsing a promotion. Status, dry-run, and the real promotion
call the same decision functions (`evaluateStagingPublishGate`,
`evaluateCandidateLineage`, `evaluateSoak`, `evaluatePromotionGate` in
`tools/kd/src/runtime/release-lineage.ts`), and both paths run the same immutable
candidate identity checks, so they cannot disagree.

When main has advanced past a main RC, the error offers the standard escape:
cut `release/X.Y` at the RC commit and promote again — the branch, not main,
then has to match. Do not weaken guard 3; promoting a commit nobody soaked
recreates the original problem.

### Soak policy

The soak window is repo configuration, not a constant buried in code:

```json
{
  "$schema": "./release-policy.schema.json",
  "productionSoakHours": 24
}
```

`release-policy.json` at the repository root, validated by
`release-policy.schema.json`. A missing file means the documented default (24
hours); a present file that does not parse, or that carries an unknown key, is an
error naming the file rather than a silent fallback. `0` disables the gate.
Elapsed time is measured from the prerelease's GitHub publication time; an
unreadable publication time fails closed.

The override is explicit and reasoned:

```sh
./kd release promote 1.2.4-staging.3 --override-soak "Grace asked for the crash fix today"
```

It waives the soak window and nothing else — never the base check, never lineage
validity. `kd release status` reports `promotion.soak` (required hours, elapsed
hours, satisfied) so the wait is visible before anyone reaches for the override.

Note that `kd release ship --production --release` is a *direct* production ship,
not a promotion: it builds whatever the checkout points at and never touched the
staging channel, so no soak applies to it. It remains a human-authorized
operation of last resort (see the ship agent's rules).

## What `kd release status` reports

Safety state is separate from mechanics. The result carries:

- `production` — latest production release and its publication time.
- `staging` — the active candidate: version, tag, commit, `sourceBranch`,
  commits behind `origin/main`, publication time, and age in hours.
- `lineage` — `relationship` (`initial` / `same-commit` / `descendant` /
  `behind` / `diverged` / `unknown`), the `previous` candidate it is compared
  against, `valid`, `authorizedByReset`, `authorizedByPromotion`, the parsed
  `reset` / `postPromotion` audit records, and a human-readable `detail`.
- `releaseBranch` — the series branch when one exists, plus `unmergedCommits` /
  `unmergedCommitCount` (below).
- `freeze` — whether main staging publishes are currently frozen, by which
  branch, and why.
- `policy` — the resolved soak policy.
- `promotion` — `mechanicallyPromotable` and its `base`, `soak`, `allowed`, and
  the full `blockers` list.
- `promoteCommand` — only when `promotion.allowed`.

Nothing is labelled simply "promotable": the field that used to carry that name
is now `promotion.mechanicallyPromotable`, and it is explicitly only the
branch-tip alignment check.

## Release branches

Feature work and refactoring on main is what destabilizes releases, so the model
is trunk-based development with short-lived release branches: main is always open
for ambitious work, and stabilization happens on a branch that only accepts
bugfixes.

- **Cut.** `kd release cut [--major|--minor|--patch]` (default `--minor`)
  computes the next series from the `VERSION` file at `origin/main` — not the
  caller's worktree, which in a Kanna task can be stale — and pushes
  `release/X.Y` at `origin/main`'s tip, so the branch name and its tip can
  never disagree. Cutting is the feature freeze — for that branch only. Because
  the branch is cut at `origin/main`'s tip, the first RC from it is a descendant
  of the main RC the channel is already serving, so the freeze transition needs
  no reset. Only a *stale* branch — one cut long ago, like `release/0.1` in the
  incident — diverges, and that is exactly when the reset should be deliberate.
- **RCs from the branch.** Ship staging from a clean checkout of `release/X.Y`
  at its remote tip, or — from a Kanna task worktree, which always runs on a
  `task-*` branch even when the task is based on the release branch — pass
  `--branch release/X.Y` explicitly *and* have `HEAD` at the branch tip. Ship
  derives the RC base version from the branch series (`X.Y.0`, or one past the
  highest released `vX.Y.Z` tag) instead of `VERSION` bump flags, and records the
  provenance as a `Source-Branch:` trailer in the prerelease notes — RC names and
  promotion bases can't drift from the branch the RC came from.
- **Bugfixes flow forward, then back.** Fixes land on main first through the
  normal task workflow and merge master, then get cherry-picked onto
  `release/X.Y` (never fixed only on the branch, or the next release regresses).
  Each backport batch ends with a fresh RC.
- **Promote from the branch.** Guard 4 pins the branch tip instead of main, so
  main can run arbitrarily far ahead during the soak. The version bump commit
  lands on the branch; after promoting, merge `release/X.Y` back into main so
  `VERSION` and the tag history reach main. Until that merge lands, a main RC
  uses the greatest valid production semantic version reported by GitHub as its
  version floor and reports
  `versionFloor` in the ship result when that floor overrides stale `VERSION`.
- **The branch goes dormant after release.** Reuse it for `X.Y.1` hotfix RCs
  (the series versioning picks the next patch automatically); cut `release/X.(Y+1)`
  for the next feature release.

A roadmap makes the cut decision explicit: define the v1 scope (a GitHub
milestone works), and cut `release/1.0` when the last v1 feature merges.
Everything else stays guilt-free main work.

### Abandoning a series and cutting the next one

A cut series does not always ship. The 0.1 series is the worked example: trunk
still records `0.0.68` in `VERSION`, `release/0.1` exists on origin, and its RC
diverged from main badly enough that the right answer is to abandon it and
stabilize 0.2 from the *current* `origin/main` instead.

Bump inference cannot express that. `origin/main:VERSION` only advances when a
production release commits the bump, so with trunk at `0.0.68`,
`kd release cut --minor` computes `0.1.0` and aims straight back at the series
being abandoned; `--major` jumps to `1.0`. The old escapes were all bad: promote
`0.1.0` purely to advance `VERSION`, delete or force-reuse `release/0.1`, or
hand-push a branch ref outside the tooling.

So the target series can be named directly, and skipping a series is an audited
decision:

```sh
# 1. Release the staging channel from the series being abandoned.
./kd release reset-staging --to release/0.2 \
  --reason "0.1 diverged from main; stabilizing 0.2 from current main instead" \
  --confirm-abandon 0.1.0-staging.8

# 2. Cut the intended series, recording what it steps over.
./kd release cut --version 0.2.0 \
  --abandon-series 0.1 \
  --reason "0.1 diverged from main; no production release will come from it"
```

What `cut` enforces:

- **`--version X.Y.0` names the series.** It must be a series start (patch `0`)
  and strictly ahead of `origin/main`'s `VERSION`. It is mutually exclusive with
  the bump flags — a cut is inferred or named, never half of each.
- **Nothing is skipped silently.** Every `release/X.Y` on origin whose series
  sits between trunk's series and the target must be either already released (a
  production `vX.Y.Z` tag exists — prereleases do not count, and
  `ls-remote --tags origin 'vX.Y.*'` returns those too, so the check reads ref
  names rather than treating non-empty output as a release), already abandoned,
  or named in `--abandon-series` with a
  `--reason`. Otherwise the cut refuses and prints the exact command to run.
- **`--abandon-series` must name a series this cut actually steps over.** It
  cannot be used to abandon an unrelated or newer series.
- **The channel is released first.** If `desktop-staging` still serves a
  candidate from the series being abandoned, the cut refuses until the lineage
  reset for that exact candidate is recorded — otherwise the next publish would
  be refused by the lineage gate with no explanation. The cut never performs the
  reset itself.
- **The record is a tag, not a deletion.** Each abandonment is an annotated
  `abandoned/release/X.Y` tag at that branch's tip carrying the timestamp and
  reason, pushed *before* the new branch, so a cut that fails afterwards leaves
  an audited record rather than a missing one. The branch is kept and never
  reused; re-running the cut is idempotent, and a later cut does not have to
  re-abandon a series that already carries the tag.
- **No production release is invented.** Nothing tags `v0.1.0`, and `VERSION` on
  main is not touched. `VERSION` stays at `0.0.68` until a production release
  commits a bump — which is exactly why the series had to be named explicitly.

What the abandonment then enforces everywhere else:

- `kd release ship --staging --branch release/0.1` refuses: no candidate ships
  from an abandoned series.
- `kd release promote` refuses any candidate whose series branch is abandoned,
  ahead of every other blocker.
- `kd release status` reports `releaseBranch.abandoned` (when and why) and lists
  the abandonment first among `promotion.blockers`.

**Version coherence during the window.** Between the cut and the first 0.2
production release, three versions legitimately disagree, and each has one
owner: `origin/main:VERSION` (`0.0.68`) is what trunk last released;
`release/0.2` is what is being stabilized, and its RCs version themselves
`0.2.Z-staging.N` from the branch series rather than from `VERSION`; production
is whatever `vX.Y.Z` was last tagged. Promotion pushes the `0.2.0` version-file
bump to `release/0.2`, and merging the branch back to main is what finally moves
trunk's `VERSION` to `0.2.0`. Before promotion, the freeze rule refuses main RCs.
After promotion, a main ship compares `VERSION` with the greatest valid semantic
version across all non-prerelease GitHub releases, takes the greater version,
and applies the requested bump. Thus
stale `VERSION` at `0.0.68` with production at `v0.2.0` derives
`v0.2.1-staging.N`, never `v0.0.69-staging.N`; the returned `versionFloor`
record calls out the lag until the branch merge synchronizes the file.

### Branch hygiene: enforced vs. documented

Two different claims are easy to conflate, so they are kept apart:

- **Enforced (ancestry and provenance).** An RC's `Source-Branch:` trailer is
  written by `ship`, its commit is the branch tip exactly, and promotion pins
  that same base. A worktree cannot claim a branch it did not build.
- **Reported, machine-checkable (patch-id).** `kd release status` runs
  `git log --no-merges --cherry-pick --right-only origin/main...origin/release/X.Y`
  and reports every branch commit with no patch-equivalent on main as
  `releaseBranch.unmergedCommits`. Those are fixes that landed *only* on the
  branch — the regression the "fix on main first, then backport" rule exists to
  prevent — and they are visible before the branch is merged back. Ordinary
  cherry-picks from main do not appear, because patch-id equivalence recognizes
  them, and merge commits are excluded because a merge carries no patch of its
  own. One caveat worth knowing before reading the number as a defect count: a
  merge commit backported with `git cherry-pick -m 1` becomes a single-parent
  commit carrying the *squashed* diff of the whole PR, which matches no
  individual commit's patch id on main, so it is reported even though its
  content did land there. Treat the list as "look at these", not "these are
  bugs".
- **Not enforced (semantics).** "The branch takes bugfixes only" is a review
  policy. Git cannot decide whether a commit is a bugfix, and `kd` does not
  pretend to. Nothing in the tooling should be read as certifying it.

## Dogfooding

Kanna is developed in Kanna, and the staging build is the daily driver. That
stays true under this model — the meaning sharpens: **the staging channel serves
whatever is being stabilized next.** Between releases, staging RCs come from main
as they do today. While a release branch is active, staging ships come from the
branch, so the daily driver *is* the release candidate — daily driving is the
soak. Two rules keep the channel honest, and the first is now enforced rather
than remembered:

- While `release/X.Y` is being soaked, staging ships from main are refused; they
  would repoint the single staging channel away from the RC mid-soak. Main
  staging ships resume after promotion, or after an explicit
  `kd release reset-staging --to main`.
- Bugs found while daily-driving an RC are release bugs: fix on main, backport,
  cut the next RC. That loop is the shipping agent's backport workflow.

The cost is that main features are not dogfooded during a soak window. That is
the point — those features are next release's problem — and the dev-worktree
instance (`kd dev up`) still exercises main for day-to-day development work.

### Why there is no separate canary channel

Continuous main dogfooding through a *third installable channel* is the natural
answer to that cost, and it is deliberately not implemented here. It is not a
release-tooling change; it is a new product identity, and the blockers are
concrete:

- `DesktopCloudEnvironment` in `crates/runtime-defaults/src/lib.rs` is a
  two-variant enum, and `desktop_cloud_environment_for_bundle_identifier` is a
  closed match on `build.kanna` / `build.kanna.staging`. A third installable
  identity that does not match resolves to `None` and gets no cloud environment
  at all.
- Each variant *owns* a relay URL, a Firebase project, a mobile server port, a
  transfer port, and a daemon directory. A canary would need its own relay
  deployment and Firebase project (`tools/kd/src/runtime/environment.ts` has
  exactly `dev` / `staging` / `prod`), plus two more entries in
  `RESERVED_INTERNAL_PORTS` so it does not contend with the installed apps for
  listeners.
- The signing/notarization surface is per identity: the root `BUILD.bazel`
  carries a full per-arch chain (bundle inputs → app → signed app → updater
  bundle → dmg → signed dmg → notarized dmg) for each of production and staging,
  and `apps/desktop/src-tauri/BUILD.bazel` a config genrule, ACL prep, and
  context support dir for each. A canary triples that.

Shipping a canary that shares `build.kanna.staging` would be worse than not
having one: two channels writing one identity means one daemon directory, one
database, and one reserved port pair, so a canary install and a staging install
would fight over the user's live state. Until a canary identity, its cloud
environment, and its port reservations exist as their own change, main
dogfooding stays on the dev-worktree instance, and the RC channel is not
overloaded to fake it.

## Suggested cadence

The tooling is cadence-agnostic, but the pattern works best as a lightweight
release train: cut `release/X.Y` on a schedule (or when the milestone empties),
soak by daily-driving, backport fixes as they land, and promote when
`kd release status` shows a quiet RC that clears every gate. A release becomes a
five-minute decision about a build that already proved itself, not a project.

## Tooling surface

- `kd release status` / MCP `release_status` — read-only channel state: the
  production release, the staging pointer and its lineage, the series branch and
  its un-backported commits, the soak policy and elapsed soak, the freeze state,
  and every promotion blocker.
- `kd release cut [--major|--minor|--patch] [--version X.Y.0]
  [--abandon-series X.Y[,X.Y]] [--reason <why>]` / MCP `release_cut` — push
  `release/X.Y` at `origin/main`, naming the target series explicitly when a
  series is being abandoned rather than released.
- `kd release promote <staging-version> [--dry-run] [--arm64|--x86_64]
  [--override-soak <reason>]` / MCP `release_promote` — implemented as a
  promotion preflight feeding the existing `shipRelease` production path
  (`promoteFrom` on `ReleaseShipInput`), so publish behavior cannot drift from
  `kd release ship --release`.
- `kd release reset-staging --to main|release/X.Y --reason <why>
  --confirm-abandon <staging-version> [--dry-run]` / MCP
  `release_reset_staging` — explicitly abandon lineage for an exceptional
  non-linear transition; routine post-promotion return to main does not use it.
- `kd release ship` stays the way candidates are cut. It becomes branch-aware
  automatically on a `release/X.Y` checkout, and takes
  `--branch main|release/X.Y` to declare RC provenance explicitly from Kanna
  task worktrees (which always run on `task-*` branches).

The shipping agent (`.kanna/agents/ship/AGENT.md`) owns the process end to end;
the command-palette task is only an interactive wrapper around that definition:
cutting branches, shipping RCs, applying release-candidate backports
(cherry-pick from main, test, push, re-RC), promoting, and merging back.
Promoting production remains a human decision: agents may cut branches, ship
staging RCs, and push backports only after explicit authorization; an
unauthorized programmatic launch is limited to status plus a staging dry-run.
They must not run `kd release promote` (or
`release_ship --production --release`), `--override-soak`, or
`kd release reset-staging` without a named human request. Abandoning a release
series (`kd release cut --abandon-series`) is the same class of decision and
needs the same explicit authorization.

## Test coverage

Runtime behavior is covered in `tools/kd/tests/release.test.ts` at the
command-runner seam (the boundary where kd invokes git/gh/bazel), and the pure
state machine plus the policy file in `tools/kd/tests/release-lineage.test.ts`.
Together they cover: the .7 → .8 divergent-history incident refused before any
build and reported by status as mechanically promotable but lineage-invalid;
same-branch fast-forward RCs; the main → release-branch freeze transition; a main
publish refused during a release soak and resumed after promotion; rollback
refusals; unreadable channel metadata failing closed — separately for an
uninitialized channel, an unreachable one, a manifest that fails to download,
and one that does not parse; the released-vs-prerelease series check that
makes an abandonment actually record; soak timing, the explicit
override, and dry-run parity with the real promotion; the reset operation's
provenance record, audit trail, confirmation and argument validation, and its
single-use authorization (including that it does not license a different
destination); the branch-tip-exact RC provenance rule; release-only commit
detection; the series-transition recovery case (an explicitly named `0.2.0` cut
with trunk still at `0.0.68` and `release/0.1` abandoned — asserting no
production tag, no branch deletion, no manual push, the abandonment record
landing before the branch, refusals when the series is unnamed, unreasoned, not
stepped over, or when the channel still serves it, idempotent re-cuts, and
ship/promote/status refusing the abandoned series); and the release-policy
file's defaults and error reporting. CLI/MCP
wiring lives in `tools/kd/tests/cli.test.ts` and
`tools/kd/tests/mcp-tools.test.ts`. A true E2E (real Bazel signing/notarization,
GitHub releases, updater install) is not regularly runnable for the reasons
recorded in `docs/2026-08-13-release-lifecycle-e2e-gap.md` and at the top of
`release.test.ts`; the command-boundary integration tests keep the regression
guard at the same seam the release tooling itself uses.
