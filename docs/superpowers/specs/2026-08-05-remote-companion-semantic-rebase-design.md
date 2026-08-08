# Remote Companion Semantic Rebase Design

## Context

Task `ba58e56d` contains 46 committed changes implementing remote desktop visual companions across the shared protocol, KSP server, task-transfer runtime, desktop and mobile clients, relay, and end-to-end coverage. The branch is clean and unpushed, but current `origin/main` is 417 commits ahead of the common base. Seventy-one files changed on both sides, and a final-tree merge analysis reports conflicts across the transport runtime, KSP, desktop and mobile integrations, relay, tests, and generated lockfiles.

Replaying the 46 commits individually would repeatedly resolve the same evolving invariants. The branch history is not published, so the integration will preserve the original tip under a local backup ref and consolidate the reviewed feature into one semantic commit before rebasing it onto current `origin/main`.

## Goal

Produce a clean, verified branch based on current `origin/main` that preserves the final reviewed remote-companion behavior and current `main` contracts, then publish it as a GitHub pull request.

## History Strategy

Before rewriting history, create a local backup ref pointing to `157933b9`. The active task branch will then be consolidated into one feature commit representing the final reviewed tree relative to its original merge base. Rebasing that single commit onto `origin/main` yields one conflict set instead of conflicts repeated across 46 historical revisions.

The backup ref is the recovery boundary. If the integration becomes ambiguous or verification exposes an architectural mismatch, abort the rebase and retain both the original backup and the task branch for diagnosis. Do not force a resolution based only on textual conflict position.

## Semantic Resolution Rules

Current `main` owns contracts and architecture introduced after the task branch split. The remote-companion branch owns the intended feature behavior and its reviewed safety properties. Conflict resolutions must therefore:

1. Preserve current `main` APIs, authentication boundaries, task lifecycle behavior, and unrelated functionality.
2. Port remote-companion capabilities into those current boundaries instead of restoring obsolete branch-era abstractions.
3. Preserve the branch's attachment identity, generation and epoch fencing, bounded queues and history, demand-driven asset delivery, compatibility negotiation, reconnect behavior, and stale-result rejection.
4. Prefer shared source-of-truth modules over duplicated compatibility implementations.
5. Regenerate derived lockfiles and generated protocol artifacts from the resolved manifests and schemas rather than hand-merging generated output when a canonical generator exists.
6. Keep final binaries and staged sidecars private to the current build, consistent with repository build-isolation rules.

## Resolution Order

Resolve dependencies from the inside out:

1. Shared TypeScript and Rust companion models, generated protocol frames, and stream-client contracts.
2. KSP server capability negotiation, companion attachment/event flow, authentication, and bounded state.
3. Task-transfer protocol and runtime lifecycle, listener, peer, recovery, state, and tests.
4. Desktop Tauri bridge, transfer sidecar, relay/LAN clients, frame decoder, companion bridge, and UI.
5. Mobile transport and shared visual-companion integration.
6. Relay routing and integration tests.
7. Cargo, pnpm, and Bazel-derived lockfiles and manifests.

At each boundary, compare the common-base, current-main, and final-feature versions. Resolve according to data ownership and invariants, then run the narrowest relevant tests before proceeding.

## Verification

Verification proceeds in layers so failures remain attributable:

- Protocol and shared visual-companion unit tests.
- Stream-client tests.
- KSP server and task-transfer focused Rust tests.
- Desktop service, bridge, and component tests plus typecheck.
- Mobile transport, state, screen tests, and typecheck.
- Relay tests.
- Repository canonical suites: `pnpm test` and `./kd test rust`.
- Formatting and consistency checks required by the affected generators and manifests.

The branch is publishable only when the worktree is clean, no conflict markers remain, the final diff contains only the remote-companion feature plus necessary integration adaptations, and canonical verification passes. Process-heavy live suites may be run when their required installed services and credentials are available; any unavailable live evidence must be reported precisely rather than represented as passing.

## Publication

After verification, rename the branch to a meaningful remote-companion name, push it without force, and create a PR against `main`. The PR description will summarize the architecture, compatibility and concurrency safeguards, semantic rebase, and exact verification evidence. Record the PR URL through Kanna stage completion metadata.

## Non-Goals

- Removing visual companions.
- Redesigning the reviewed remote-companion feature.
- Preserving the unpublished 46-commit review history on the active branch.
- Refactoring unrelated current-main code.
- Weakening current authentication, lifecycle, release, or build-isolation guarantees to make the port easier.
