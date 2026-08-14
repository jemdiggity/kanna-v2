# PR Base-Ref Validation And Duplicate-PR Reuse E2E Gap

Two `pr`-stage defects landed real damage on 2026-07-29:

- PRs #950 and #952 targeted `chore/remove-github-actions-ci` — the tasks'
  `base_ref`, an integration branch nobody was merging — were approved,
  reported mergeable, and merged into a branch that is 84 commits behind the
  default branch. A PR that merges cleanly into an abandoned branch is
  indistinguishable from a healthy one at every automated gate.
- The `pr` stage opened #940 for a commit already covered by open PR #939, and
  #951 for a head already covered by #932. The agent's rename step means the
  earlier PR sits on a branch name the new workspace no longer has, so an
  unconditional `gh pr create` cannot see it.

The fixes are agent instructions: `.kanna/agents/pr/AGENT.md` now validates the
base ref against the default branch before rebasing (existence on the remote,
an open PR of its own, containment in the default branch) and looks for an open
PR covering this work before creating one. `pr@draft-pr` carries its own copy of
the publish steps and so carried both defects; it gets the same checks, since a
draft lands through the same target once readied — its only difference is that
it keeps opening drafts and never pushes a PR someone already readied back into
draft state. `pr@push-only` is untouched: it creates no PR, so neither a
dead-end target nor a duplicate is reachable from it. `.kanna/agents/approve/AGENT.md`,
`.kanna/agents/merge/AGENT.md`, and `merge@github` refuse to ship into a target
that is neither the default branch nor carried by an open PR.

## Why there is no end-to-end test

Proving the behavior requires a real agent session driving `gh` against a real
forge: a repo with an orphaned integration branch, a live stacked base that must
keep working, and a pre-existing open PR on a renamed branch. That needs the
same deterministic live-agent harness plus disposable GitHub remote described in
`docs/2026-07-08-setup-agent-live-e2e-gap.md`, which does not exist yet.
Asserting the outcome against the production repository is not an option — the
failure mode under test is a wrong merge.

## What would make it testable

A fixture remote (local bare repo plus a `gh` stub, or a disposable GitHub org)
that can express: a base branch deleted upstream, a base with no open PR, a base
with an open PR chaining to the default branch, and an open PR whose head branch
was renamed. With that, one live-agent run per case could assert the created or
updated PR's base and number.

## Coverage added meanwhile

`packages/core/src/workflow/qa-assets.test.ts` guards the instructions
themselves, across every flavor that opens a PR — the base-ref questions and the
`--onto` retarget that keeps the dead base's commits out of the PR, the
duplicate-PR matching signals
(recorded head sha, this task's branch names, the `Kanna-Task` trailer, patch
equivalence via `git cherry`) and the force-with-lease guard, and the
`approve` / `merge` refusals. The role contracts in
`.kanna/agents/{pr,approve,merge}/CONTRACT.md` state the same requirements, and
`tests/cli-contract/tests/offline/agent-flavor-contracts.test.ts` keeps them
shipping next to the definitions.
