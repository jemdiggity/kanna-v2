# Remote Companion Semantic Rebase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebase the final reviewed remote desktop visual-companion implementation onto current `origin/main`, preserve current contracts and the feature's safety invariants, verify it, and publish a pull request.

**Architecture:** Preserve the original branch under a local backup ref, consolidate its unpublished history into one semantic feature commit, and rebase that commit onto current `origin/main`. Resolve the single conflict set from shared protocol outward through KSP, transfer runtime, desktop, mobile, relay, and generated artifacts; current `main` owns present-day interfaces while the backup branch owns the reviewed remote-companion behavior.

**Tech Stack:** Git, Rust, Tokio, Tauri v2, TypeScript, Vue 3, React Native/Expo, Vitest, pnpm, Cargo, Bazel lock generation, GitHub CLI.

---

## File and Ownership Map

- `packages/visual-companion/` and `crates/visual-companion/`: shared document, discovery, event, state, and validation sources of truth.
- `packages/agent-protocol/` and `crates/kanna-agent-protocol/`: generated and Rust KSP frame contracts, capabilities, assets, origins, events, and event results.
- `packages/stream-client/src/`: attachment negotiation, companion demand, assets, event epochs, bounded history, reconnect, and compatibility behavior.
- `crates/kanna-server/src/ksp.rs` and `crates/kanna-server/src/visual_companion.rs`: server-side source observation, attachment lifecycle, asset/event transport, compatibility, and bounds.
- `crates/task-transfer/src/runtime/`: paired LAN transfer lifecycle, companion admission, retries, event publication, peer state, and recovery.
- `apps/desktop/src-tauri/src/companion_bridge.rs` and `apps/desktop/src/services/desktopCompanionBridge.ts`: local mirror and desktop client orchestration.
- `apps/desktop/src/services/desktopLanTerminal.ts`, `desktopRelayTerminal.ts`, and `desktopRemoteTaskClient.ts`: present-day transport client boundary.
- `apps/desktop/src/components/CloudTerminalView.vue`: desktop remote-companion entry point and UI lifecycle.
- `apps/mobile/src/lib/transports/`, `apps/mobile/src/state/`, and `apps/mobile/src/screens/`: shared companion document usage and LAN/relay transport integration.
- `services/relay/src/`: relay routing and backpressure behavior.
- Cargo, pnpm, and Bazel locks: derived output regenerated only after source manifests and schemas are resolved.

### Task 1: Preserve and Consolidate the Reviewed Branch

**Files:**
- Preserve: every file at the current pre-rewrite `HEAD`
- Reference: `docs/superpowers/specs/2026-08-05-remote-companion-semantic-rebase-design.md`
- Reference: `docs/superpowers/plans/2026-08-06-remote-companion-semantic-rebase.md`

- [ ] **Step 1: Confirm the exact clean starting state**

Run:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git merge-base origin/main HEAD
```

Expected: no status output, branch `task-ba58e56d-45`, tip containing this plan, and merge base `f279bb28f9310125cdc5a9859fc9e568af8e5e64`. Save the printed tip as `ORIGINAL_TIP` for Step 2.

- [ ] **Step 2: Preserve the full original history**

Run:

```bash
ORIGINAL_TIP=$(git rev-parse HEAD)
git branch backup/remote-companion-pre-semantic-rebase "$ORIGINAL_TIP"
git show-ref --verify refs/heads/backup/remote-companion-pre-semantic-rebase
test "$(git rev-parse backup/remote-companion-pre-semantic-rebase)" = "$ORIGINAL_TIP"
```

Expected: the backup ref resolves to the pre-rewrite tip and no branch switch occurs.

- [ ] **Step 3: Consolidate the unpublished commits**

Run:

```bash
git reset --soft f279bb28f9310125cdc5a9859fc9e568af8e5e64
git commit -m "feat: add remote desktop visual companions"
git rev-list --count f279bb28f9310125cdc5a9859fc9e568af8e5e64..HEAD
```

Expected: one commit ahead of the original base containing the final reviewed tree, including the approved rebase design and this plan.

- [ ] **Step 4: Confirm consolidation preserved the final tree**

Run:

```bash
git diff --exit-code backup/remote-companion-pre-semantic-rebase HEAD
```

Expected: exit 0 and no output.

### Task 2: Start the Single-Commit Rebase and Inventory Conflicts

**Files:**
- Inspect: all unmerged paths reported by `git status --short`
- Reference: `docs/superpowers/specs/2026-08-05-remote-companion-semantic-rebase-design.md`

- [ ] **Step 1: Refresh and start the rebase**

Run:

```bash
git fetch origin
git rebase origin/main
```

Expected: the one semantic commit stops on a conflict set; `HEAD` is current `origin/main`, and `REBASE_HEAD` is the consolidated feature commit.

- [ ] **Step 2: Record the exact conflict inventory**

Run:

```bash
git status --short
git diff --name-only --diff-filter=U
git diff --check
```

Expected: only paths changed by both current `main` and the remote-companion feature are unmerged. Conflict-marker errors are expected until each path is resolved; unrelated dirty files are not expected.

- [ ] **Step 3: Establish the three-way comparison convention**

For every conflicted path `$path`, use:

```bash
git show :1:"$path"   # common base
git show :2:"$path"   # current origin/main
git show :3:"$path"   # final reviewed feature tree
```

Expected: each resolution can be justified by a current-main contract and a feature invariant before the path is staged.

### Task 3: Resolve Shared Companion and Protocol Contracts

**Files:**
- Modify: `packages/agent-protocol/src/generated/ClientFrame.ts`
- Modify: `packages/agent-protocol/src/generated/CompanionAsset.ts`
- Modify: `packages/agent-protocol/src/generated/CompanionEvent.ts`
- Modify: `packages/agent-protocol/src/generated/KspCapability.ts`
- Modify: `packages/agent-protocol/src/generated/ServerFrame.ts`
- Modify: `packages/agent-protocol/src/index.ts`
- Modify: `crates/kanna-agent-protocol/src/frames.rs`
- Modify: `crates/kanna-agent-protocol/src/lib.rs`
- Modify: `packages/stream-client/src/index.ts`
- Test: `packages/stream-client/src/stream-client.test.ts`
- Preserve/Create: `packages/visual-companion/`
- Preserve/Create: `crates/visual-companion/`

- [ ] **Step 1: Resolve protocol types against current generated conventions**

Keep current-main naming and serialization conventions while preserving these feature contracts: companion origin and asset descriptors, companion stream capability negotiation, attachment identifiers, demand modes, event epochs, event results, and legacy compatibility fields. Do not duplicate a generated type in handwritten code.

- [ ] **Step 2: Resolve stream-client attachment behavior**

Preserve the reviewed invariants encoded by the branch tests:

```text
one attachment identity per task/stream
explicit companion demand before asset publication
bounded pending asset/event/result history
event epoch negotiation with legacy peers
stale attachment and stale event-result rejection
terminal traffic remains independent of companion backpressure
```

Stage only the resolved shared/protocol paths:

```bash
git add packages/agent-protocol packages/stream-client crates/kanna-agent-protocol packages/visual-companion crates/visual-companion
```

- [ ] **Step 3: Run shared TypeScript tests**

Run:

```bash
pnpm --filter @kanna/visual-companion test
pnpm --filter @kanna/visual-companion typecheck
pnpm --filter @kanna/stream-client test
pnpm --filter @kanna/stream-client typecheck
```

Expected: all visual-companion and stream-client tests pass with no TypeScript errors.

- [ ] **Step 4: Run shared Rust tests**

Run:

```bash
cargo test -p kanna-agent-protocol
cargo test -p kanna-visual-companion
```

Expected: both crate suites pass.

### Task 4: Resolve KSP Server Semantics

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `crates/kanna-server/src/visual_companion.rs`
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Modify: `crates/kanna-server/src/http_api/lan_trust.rs`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/relay.rs`
- Modify: `crates/kanna-server/src/pairing.rs`
- Modify: `crates/kanna-server/Cargo.toml`
- Modify: `crates/kanna-server/BUILD.bazel`

- [ ] **Step 1: Preserve current authentication and request dispatch**

Current-main authenticated HTTP/KSP dispatch, paired-device verification, relay authentication, and task-action authorization remain authoritative. Integrate companion frames only after the current authentication gate succeeds; legacy companion capability support must never restore empty-auth privileged task actions.

- [ ] **Step 2: Port the final companion state machine**

Preserve source observation, revision fencing, demand aggregation, bounded history, asset selection, event epochs, attachment generation, reconnect, and stale-result behavior from the feature tree. Keep terminal and request lanes responsive when companion work is blocked or absent.

- [ ] **Step 3: Stage the resolved server paths**

Run:

```bash
git add crates/kanna-server/src crates/kanna-server/Cargo.toml crates/kanna-server/BUILD.bazel
```

- [ ] **Step 4: Run focused KSP and companion server tests**

Run:

```bash
cargo test -p kanna-server ksp -- --test-threads=1
cargo test -p kanna-server visual_companion -- --test-threads=1
```

Expected: focused KSP and companion tests pass, including compatibility, demand, epoch, bounds, auth, and backpressure cases.

### Task 5: Resolve Paired Transfer Runtime and Sidecar

**Files:**
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Preserve/Create: `crates/task-transfer/src/runtime/companion.rs`
- Modify: `crates/task-transfer/src/runtime/daemon.rs`
- Modify: `crates/task-transfer/src/runtime/discovery.rs`
- Modify: `crates/task-transfer/src/runtime/events.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/mod.rs`
- Modify: `crates/task-transfer/src/runtime/pairing.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/tests.rs`
- Modify: `crates/task-transfer/src/runtime/transfers.rs`
- Modify: `crates/task-transfer/src/runtime/utils.rs`
- Test: `crates/task-transfer/tests/protocol.rs`
- Test: `crates/task-transfer/tests/runtime.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Preserve current transfer lifecycle ownership**

Current-main sidecar incarnation, ownership transfer, authenticated peer, replay, recovery, and teardown semantics remain authoritative. Companion subscriptions must attach to the current incarnation and must not resurrect retired listeners, peers, tasks, or sidecars.

- [ ] **Step 2: Port companion admission and recovery invariants**

Preserve generation-scoped subscriptions, bounded retry and queue state, demand publication, event delivery, stale-incarnation fencing, handoff safety, and cleanup from the final feature tree. Keep companion work isolated from terminal and ordinary task-transfer lanes.

- [ ] **Step 3: Stage transfer and sidecar paths**

Run:

```bash
git add crates/task-transfer apps/desktop/src-tauri/src/transfer_sidecar.rs apps/desktop/src-tauri/src/commands/transfer.rs apps/desktop/src-tauri/src/lib.rs
```

- [ ] **Step 4: Run transfer runtime tests**

Run:

```bash
cargo test -p kanna-task-transfer --lib -- --test-threads=1
cargo test -p kanna-task-transfer --test protocol -- --test-threads=1
cargo test -p kanna-task-transfer --test runtime -- --test-threads=1
```

Expected: library, protocol, and runtime suites pass, including companion lifecycle and existing ownership-transfer regressions.

### Task 6: Resolve Desktop Bridge, Transport, and UI

**Files:**
- Preserve/Create: `apps/desktop/src-tauri/src/commands/companion.rs`
- Preserve/Create: `apps/desktop/src-tauri/src/companion_bridge.rs`
- Preserve/Create: `apps/desktop/src/services/desktopCompanionBridge.ts`
- Preserve/Create: `apps/desktop/src/services/desktopCompanionBridge.test.ts`
- Preserve/Create: `apps/desktop/src/services/desktopRemoteTaskClient.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.test.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.test.ts`
- Modify: `apps/desktop/src/components/CloudTerminalView.vue`
- Modify: `apps/desktop/src/components/__tests__/CloudTerminalView.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/tests/e2e/run.ts`
- Preserve/Create: `apps/desktop/tests/e2e/real/remote-visual-companion.test.ts`

- [ ] **Step 1: Resolve the current remote-task client boundary**

Keep current-main task operations, file reads, mark-read revision guards, authentication refresh, and terminal lifecycle. Add companion observation and event delivery through `DesktopRemoteTaskClient` without moving current task methods back into obsolete branch-local interfaces.

- [ ] **Step 2: Resolve the native and TypeScript companion bridges**

Preserve local mirror isolation, loopback-origin validation, bounded resource serving, attachment/generation fencing, worker decode isolation, shutdown behavior, and redaction. Tauri commands must use current app-state and sidecar lifecycle conventions.

- [ ] **Step 3: Resolve desktop UI lifecycle**

Keep current `CloudTerminalView.vue` navigation, file preview, activity, and terminal behavior. Add the remote companion entry point, unread/update state, event delivery, reconnect/error states, and cleanup without allowing stale task or transport callbacks to affect the selected task.

- [ ] **Step 4: Stage desktop paths**

Run:

```bash
git add apps/desktop/src-tauri/src/commands/companion.rs apps/desktop/src-tauri/src/companion_bridge.rs apps/desktop/src/services apps/desktop/src/components apps/desktop/src/composables apps/desktop/src/main.ts apps/desktop/tests/e2e
```

- [ ] **Step 5: Run focused desktop tests and typecheck**

Run:

```bash
pnpm --dir apps/desktop test -- desktopCompanionBridge desktopLanTerminal desktopRelayTerminal CloudTerminalView desktopStreamFrameDecoder remoteCompanionLink
pnpm --dir apps/desktop exec vue-tsc --noEmit
pnpm --dir apps/desktop test:e2e -- mock/
```

Expected: focused unit/component suites, desktop typecheck, and mock E2E pass.

### Task 7: Resolve Mobile and Relay Integration

**Files:**
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Modify: `apps/mobile/src/lib/transports/relayClient.ts`
- Modify: `apps/mobile/src/lib/transports/relayClient.test.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/sessionStore.test.ts`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/screens/VisualCompanionModal.tsx`
- Modify: `apps/mobile/src/screens/VisualCompanionModal.test.tsx`
- Modify: `apps/mobile/src/screens/buildVisualCompanionDocument.ts`
- Modify: `apps/mobile/src/screens/buildVisualCompanionDocument.test.ts`
- Modify: `services/relay/src/index.ts`
- Modify: `services/relay/src/router.ts`
- Test: `services/relay/test/integration.test.ts`
- Test: `services/relay/test/router.test.ts`

- [ ] **Step 1: Preserve current mobile state and transport contracts**

Keep current-main terminal state, file mentions, task activity, authentication, and transport APIs. Use the shared visual-companion package for document and event semantics, and retain branch compatibility for legacy snapshots/events without duplicating the shared parser.

- [ ] **Step 2: Preserve relay isolation and backpressure**

Companion routing remains authenticated and desktop/task scoped. Preserve bounded relay behavior and ensure blocked companion traffic cannot head-of-line block terminal or request traffic.

- [ ] **Step 3: Stage mobile and relay paths**

Run:

```bash
git add apps/mobile services/relay
```

- [ ] **Step 4: Run focused mobile and relay tests**

Run:

```bash
pnpm --dir apps/mobile test -- src/lib/transports/lanTransport.test.ts src/lib/transports/relayClient.test.ts src/state/sessionStore.test.ts src/screens/TaskScreen.test.tsx src/screens/VisualCompanionModal.test.tsx src/screens/buildVisualCompanionDocument.test.ts
pnpm --dir apps/mobile typecheck
pnpm --dir services/relay test
pnpm --dir services/relay build
```

Expected: focused mobile suites, mobile typecheck, relay tests, and relay TypeScript build pass.

### Task 8: Regenerate Derived Manifests and Finish the Rebase

**Files:**
- Modify/Regenerate: `pnpm-lock.yaml`
- Modify/Regenerate: `Cargo.lock`
- Modify/Regenerate: `Cargo.desktop.lock`
- Modify/Regenerate: `crates/kanna-server/Cargo.lock`
- Modify/Regenerate: `crates/task-transfer/Cargo.lock`
- Modify/Regenerate: `MODULE.bazel.lock`
- Modify: root and package Cargo manifests already resolved in Tasks 3–7

- [ ] **Step 1: Resolve source manifests before locks**

Run:

```bash
git diff --name-only --diff-filter=U
```

Expected: only generated locks remain unmerged. If a source file remains, return to its owning task before regenerating anything.

- [ ] **Step 2: Regenerate pnpm state**

Run:

```bash
pnpm install --lockfile-only
git add pnpm-lock.yaml
```

Expected: the lock contains current-main dependencies plus `@kanna/visual-companion` workspace wiring, with no conflict markers.

- [ ] **Step 3: Regenerate Cargo lock state through repository workflows**

Run:

```bash
./kd build sidecars
```

Expected: workspace and release-sidecar Cargo locks are synchronized through the canonical build surface. Stage only the resulting lock and manifest outputs:

```bash
git add Cargo.lock Cargo.desktop.lock crates/kanna-server/Cargo.lock crates/task-transfer/Cargo.lock Cargo.server.toml Cargo.task-transfer.toml Cargo.toml
```

- [ ] **Step 4: Refresh the Bazel module lock**

Run Bazel repository evaluation; do not hand-edit `MODULE.bazel.lock`:

```bash
bazel query '@kanna_npm//...'
git add MODULE.bazel.lock
```

Expected: Bazel resolves the current pnpm workspace, updates `MODULE.bazel.lock`, and prints the `@kanna_npm` target set.

- [ ] **Step 5: Verify all conflicts are resolved and continue**

Run:

```bash
test -z "$(git diff --name-only --diff-filter=U)"
git diff --check
rg -n '^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)' --glob '!docs/superpowers/**' .
GIT_EDITOR=true git rebase --continue
```

Expected: rebase completes with one feature commit on current `origin/main`; the marker scan has no output.

### Task 9: Canonical Verification and Diff Audit

**Files:**
- Inspect: all paths in `git diff --name-status origin/main...HEAD`
- Test: repository-wide TypeScript and Rust suites

- [ ] **Step 1: Run formatting checks**

Run:

```bash
cargo fmt --all -- --check
git diff --check
```

Expected: both commands pass.

- [ ] **Step 2: Run the canonical TypeScript suite**

Run:

```bash
pnpm test
```

Expected: all Turbo-managed tests pass.

- [ ] **Step 3: Run the canonical Rust suite**

Run:

```bash
./kd test rust
```

Expected: all canonical Rust checks and tests pass.

- [ ] **Step 4: Run static checks for affected frontends and relay**

Run:

```bash
pnpm --dir apps/desktop exec vue-tsc --noEmit
pnpm --dir apps/mobile typecheck
pnpm --dir services/relay build
```

Expected: all static checks pass.

- [ ] **Step 5: Audit final history and diff**

Run:

```bash
git status --short
git rev-list --left-right --count origin/main...HEAD
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
```

Expected: clean worktree, zero commits behind current `origin/main`, one semantic feature commit ahead, and no unrelated current-main reversions.

### Task 10: Publish and Record the PR

**Files:**
- No source changes expected

- [ ] **Step 1: Rename the branch**

Run:

```bash
git branch -m feat/remote-desktop-visual-companions
```

Expected: the current branch has the meaningful feature name.

- [ ] **Step 2: Push without force**

Run:

```bash
git push -u origin HEAD
```

Expected: a new remote branch is created successfully.

- [ ] **Step 3: Create the PR**

Run:

Run:

```bash
gh pr create --base main --title "Add remote desktop visual companions" --body $'## Summary\n\n- add remote desktop visual companions across KSP, paired LAN transfer, relay, desktop, and mobile\n- preserve attachment, generation, event-epoch, demand, bounded-history, reconnect, and stale-result safety\n- serve isolated loopback companion mirrors and resolve remote companion links locally\n- semantically rebase the final reviewed feature tree onto current main\n\n## Verification\n\n- `pnpm test`\n- `./kd test rust`\n- `cargo fmt --all -- --check`\n- desktop and mobile typechecks\n- relay TypeScript build'
```

Expected: GitHub returns a full PR URL. Include only commands that actually passed; if Task 9 required a documented exception, edit the `--body` argument to state that exact exception instead of listing the command as successful.

- [ ] **Step 4: Record Kanna success**

Call `kanna_complete_stage` with task id `ba58e56d`, status `success`, summary `Created PR <full URL>`, and metadata `{ "pr_url": "<full URL>" }`.

Expected: Kanna records the PR URL and the PR-stage result succeeds.
