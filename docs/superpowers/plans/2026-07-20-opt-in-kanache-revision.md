# Opt-in Kanache Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Kanache proof of concept explicitly opt-in until Kanna-scale acceptance gates pass, and prove its cross-process Git-worktree behavior with integration tests.

**Architecture:** Preserve private per-worktree Cargo build trees and the pinned Kanache experiment, but require `KANNA_RUST_CACHE=on` or `kanache` before any bootstrap, warm, or record action. Add a macOS integration suite that drives real Git repositories/worktrees through `nodeCommandRunner` and substitutes only a deterministic fake Kanache executable. Keep donor eligibility bounded to the documented `kd build sidecars`, `kd dev up`, and `kd test rust` lifecycle, and document direct Cargo commands as outside donor publication.

**Tech Stack:** TypeScript, Vitest, Node child processes/filesystem APIs, Git worktrees, shell-script test fixture, Cargo/Rust documentation.

---

### Task 1: Make the proof of concept default-off

**Files:**
- Modify: `tools/kd/tests/rust-cache-policy.test.ts`
- Modify: `tools/kd/tests/kanna-config.test.ts`
- Modify: `tools/kd/src/runtime/rust-cache-policy.ts`
- Modify: `.kanna/config.json`

- [ ] **Step 1: Write failing default-off policy and setup tests**

Change the policy expectation so `parseRustCacheMode(undefined)` and `off` are disabled while only `on` and `kanache` enable the cache. Change the repository setup expectation to `pnpm install` followed by `./kd env sync`, with no `rust-cache warm` command.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --dir tools/kd test -- rust-cache-policy.test.ts kanna-config.test.ts`

Expected: FAIL because the current parser enables an unset value and setup still warms every worktree.

- [ ] **Step 3: Implement the minimal default-off behavior**

Make `parseRustCacheMode` return `{ enabled: false }` for an unset or blank value; retain explicit `on`, `kanache`, and `off` handling and fail closed for unknown values. Remove `./kd rust-cache warm` from `.kanna/config.json`.

- [ ] **Step 4: Re-run the focused tests**

Run: `pnpm --dir tools/kd test -- rust-cache-policy.test.ts kanna-config.test.ts`

Expected: PASS.

### Task 2: Add real Git-worktree/process integration coverage

**Files:**
- Create: `tools/kd/tests/rust-cache.integration.test.ts`

- [ ] **Step 1: Build a real-repository integration fixture**

Create a temporary Git repository with committed `.gitignore`, donor files, and multiple real `git worktree add --detach` worktrees. Install a fake executable at `resolveKanachePaths(home).binary`; have it append JSON calls to a log, refuse configured donors, publish only into an absent destination, and implement `manifest begin`/`manifest record` marker behavior. Execute all Git, fake Kanache, and fake build commands through `nodeCommandRunner`.

- [ ] **Step 2: Write exact-HEAD, repository-filtering, and refusal-fallback tests**

Test that a different-HEAD donor is ignored, a registered candidate whose `.git` file resolves to a foreign repository is ignored, the first exact-HEAD same-repository donor can refuse, and the next compatible donor publishes the destination.

- [ ] **Step 3: Run the integration suite and verify the new behavior fails where the fixture exposes gaps**

Run: `pnpm --dir tools/kd test -- rust-cache.integration.test.ts`

Expected: tests fail until the fixture and any required runtime boundary are complete; failures must come from the asserted integration behavior rather than syntax or fixture setup.

- [ ] **Step 4: Add publication/non-deletion and lifecycle tests**

Test that an existing destination is preserved without invoking Kanache. Test `withRustCacheBuild` with a real process callback and assert the fake executable observes `manifest begin`, then the build, then `manifest record`, with the resulting manifest/success marker present only after success.

- [ ] **Step 5: Make the smallest runtime corrections required by the integration tests**

Keep donor discovery based on full `HEAD`, Git common-directory equality, and Kanache refusal fallback. Do not add a shared Cargo build directory or production default.

- [ ] **Step 6: Re-run integration and unit tests**

Run: `pnpm --dir tools/kd test -- rust-cache.integration.test.ts rust-cache.test.ts rust-cache-policy.test.ts`

Expected: PASS on macOS; non-macOS should report a deliberate skip for APFS/Kanache acceptance behavior while the unit contract remains covered.

### Task 3: Align lifecycle documentation and the canary contract

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-default-kanache-worktree-cache-design.md`
- Delete: `docs/superpowers/plans/2026-07-20-default-kanache-worktree-cache.md` (superseded default-on plan)
- Modify: `AGENTS.md`

- [ ] **Step 1: Rewrite rollout language as an opt-in technical spike**

State that unset and `off` disable Kanache; users opt in with `KANNA_RUST_CACHE=on`. Remove claims that setup automatically warms new worktrees or that default rollout precedes the representative canary.

- [ ] **Step 2: Document integration and real-tool acceptance coverage**

Describe the fake-executable/real-worktree automated substitute. Document that the real pinned-Kanache canary is manual because it requires macOS/APFS, the pinned Rust toolchain, multiple clean exact-HEAD Kanna worktrees, roughly 20 GiB free disk, and stable process load. List the warm-time, physical-growth, invalidation, and relocation gates and exact opt-in commands.

- [ ] **Step 3: Reconcile every supported Cargo-mutating workflow**

Document `kd build sidecars` as begin/build/record for the explicit target, `kd dev up` as using that sidecar boundary before unrecorded Tauri host mutation, and `kd test rust` as an outer begin/build/record for both layouts with nested sidecar lifecycle. State that direct Cargo/Tauri commands never publish donors and require removing `.kanache-success` before mutation if the checkout was previously used as an opt-in donor.

- [ ] **Step 4: Check documentation for contradictory default-on text**

Run: `rg -n "default-on|by default|Unset,|setup.*warm|KANNA_RUST_CACHE=off" docs/superpowers/specs/2026-07-20-default-kanache-worktree-cache-design.md docs/superpowers/plans/2026-07-20-opt-in-kanache-revision.md AGENTS.md`

Expected: no surviving claim that the technical spike is enabled when the environment variable is unset.

### Task 4: Verify the complete revision

**Files:**
- Review all modified files.

- [ ] **Step 1: Run kd typechecking and focused tests**

Run: `pnpm --dir tools/kd typecheck`

Run: `pnpm --dir tools/kd test -- rust-cache.integration.test.ts rust-cache.test.ts rust-cache-policy.test.ts kanna-config.test.ts rust-test.test.ts sidecars.test.ts`

Expected: PASS.

- [ ] **Step 2: Run the repository baseline**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 3: Run the required serialized daemon suite**

Run: `cd crates/daemon && cargo test -- --test-threads=1`

Expected: PASS.

- [ ] **Step 4: Inspect the final diff and status**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors; only revision-scoped source, tests, configuration, and documentation changes.
