# Release lifecycle enforcement: E2E gap

**Date:** 2026-08-13
**Area:** `tools/kd` desktop release lifecycle (staging lineage, release-branch
freeze, promotion soak gate, series abandonment)

## What shipped

The staging channel is now a state machine rather than a pointer. `kd` refuses
staging publishes that diverge from, or roll back, the candidate `desktop-staging`
already serves; requires a `release/X.Y` RC to build that branch's remote tip
exactly; freezes main staging publishes while an unpromoted release-branch
candidate is soaking; gates production promotion on lineage validity plus a
configurable soak window; and provides two explicit, audited non-linear
transitions — `kd release reset-staging` (abandon a channel lineage) and
`kd release cut --version X.Y.0 --abandon-series X.Y --reason "…"` (abandon a
release series and cut the intended next one). Details:
[`docs/specs/release-candidates.md`](specs/release-candidates.md).

## Why there is no E2E test

Kanna's E2E expectation is that behavior crossing component or system boundaries
gets at least one E2E test. These behaviors cross the boundary between `kd` and
GitHub's release API, git remotes, Bazel, and Apple's signing and notarization
services — none of which can be exercised hermetically today:

- **GitHub release state.** Every gate reads real release objects: the
  `desktop-staging` pointer release and its body, `latest-staging.json` as an
  attached asset, prerelease `targetCommitish` and `publishedAt`, and the
  prerelease listing used to find the previous candidate. Proving the gates
  end to end means creating and mutating prereleases on a real repository — a
  destructive, rate-limited, shared-state operation, and the pointer release
  under test is the one real users' staging installs update from.
- **Signed artifacts.** Any test that reaches the "and then it publishes" step
  needs a notarized DMG and a signed updater bundle for both architectures. That
  is a multi-minute Bazel build requiring a Developer ID certificate and Apple
  notarization credentials that only exist on a developer's machine
  (`~/.kanna/.env.release.local`), which is the same reason
  `tools/kd/tests/release.test.ts` has never had a full `release ship` E2E.
- **Time.** The soak gate is a wall-clock window. A real E2E would either wait
  hours or reintroduce the injected clock the unit tests already use.
- **Remote git writes.** The series-abandonment path pushes an annotated
  `abandoned/release/X.Y` tag and a new `release/X.Y` branch to origin. A real
  E2E would leave permanent refs on the repository.

## What is tested instead

Everything is covered at the command-runner seam — the boundary where `kd`
invokes `git`, `gh`, and `bazel` — which is the same seam the release tooling
itself is built on, plus pure unit tests for the decision functions:

- `tools/kd/tests/release-lineage.test.ts` — the state machine and policy file:
  every publish-gate relationship, the freeze and its lift, reset records
  (round-trip, newest-wins, audit trail, single-use matching), candidate lineage
  validity, soak arithmetic and override, promotion-gate blocker aggregation,
  release-only commit parsing, and `release-policy.json` defaults/validation.
- `tools/kd/tests/release.test.ts` — the command boundary: the .7 → .8
  divergent-history incident refused before any Bazel invocation and reported by
  `status` as mechanically promotable but lineage-invalid; same-branch
  fast-forward RCs; the main → release-branch freeze transition; a main publish
  refused during a soak and resumed after promotion; rollback refusals;
  unreadable channel metadata failing closed, with an uninitialized channel kept
  distinct from an unreachable one, a manifest that fails to download, and one
  that does not parse; branch-tip-exact RC provenance;
  soak timing, the explicit override, and dry-run parity with the real
  promotion; a cut from advancing main followed by an exact-tip branch RC and
  branch-arm promotion while main keeps moving; the post-promotion bare-main
  next-minor default; state-aware dormant-branch remedies that never suggest a
  non-fast-forward push; the reset operation's provenance record and validation;
  and the full series-transition recovery case (explicit `0.2.0` cut with trunk
  at `0.0.68`, asserting the abandonment tag lands before the branch push, no
  production tag is created, no branch is deleted, and
  `ship`/`promote`/`status` then refuse the abandoned series).
- `tools/kd/tests/cli.test.ts`, `tools/kd/tests/mcp-tools.test.ts`,
  `tools/kd/tests/release-tasks.test.ts` — the CLI and MCP surfaces, including
  that the reset tool's three fields are all required and that the soak override
  is never defaulted on.

## What would make it testable

A hermetic release backend: a fake `gh` (or a local GitHub-API stub) owning
release objects and assets, small pre-signed fixture artifacts standing in for
notarized DMGs and updater bundles, a scratch git remote for branch and tag
pushes, and an injectable clock (already present as `now` on the release inputs).
With those, the whole lifecycle — publish, freeze, reset, cut with abandonment,
soak, promote — could run against real command binaries in a temporary
repository. Until then the command-boundary tests are the regression guard, and
this note records the gap.
