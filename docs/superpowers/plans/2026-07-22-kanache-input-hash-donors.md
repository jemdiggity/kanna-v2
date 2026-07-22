# Kanache Input-Hash Donors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let kd offer clean, recorded Kanache donors from different Git commits when their manifests support Rust build-input hashing, while retaining exact-HEAD fallback for legacy manifests and reporting the selected matching mode.

**Architecture:** Extend kd's parsed manifest summary and donor candidate with the optional Kanache Rust-input hash and a `head | input-hash` matching mode. Candidate discovery will continue to enforce same-repository, clean-recorded-manifest, and supported-layout gates; exact-HEAD candidates remain eligible without a hash, while different-HEAD candidates require one and rely on the pinned Kanache binary to compute and compare the destination hash. Ranking remains layout coverage then recency, with a canonical path tie-breaker, and events record the candidate matching mode for each attempted donor.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, Vitest fake-runner and real-process integration fixtures, Rust Kanache CLI, Markdown documentation.

---

### Task 1: Parse and rank hash-capable donor manifests

**Files:**
- Modify: `tools/kd/tests/rust-cache-policy.test.ts`
- Modify: `tools/kd/src/runtime/rust-cache-policy.ts`

- [x] **Step 1: Write failing policy tests**

Add assertions that `parseKanacheManifest` maps a string `rust_build_inputs_blake3` to `rustBuildInputsBlake3`, leaves the field undefined for legacy manifests, and that equal-coverage/equal-timestamp donors are ordered by canonical path.

- [x] **Step 2: Run the policy tests and verify RED**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache-policy.test.ts`

Expected: FAIL because the summary has no `rustBuildInputsBlake3` property and ranking has no explicit path tie-breaker.

- [x] **Step 3: Implement the parsed field, matching type, and deterministic tie-breaker**

Add:

```ts
export type RustCacheMatchingMode = "head" | "input-hash";

export interface KanacheManifestSummary {
  rustBuildInputsBlake3?: string;
}

export interface DonorCandidate extends WorktreeEntry {
  matchingMode: RustCacheMatchingMode;
}
```

Parse only non-empty string hashes, and append `left.path.localeCompare(right.path)` after the existing coverage and timestamp comparators.

- [x] **Step 4: Run the policy tests and verify GREEN**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache-policy.test.ts`

Expected: PASS.

### Task 2: Admit cross-HEAD hashed donors and log matching modes

**Files:**
- Modify: `tools/kd/tests/rust-cache.test.ts`
- Modify: `tools/kd/src/runtime/rust-cache.ts`

- [x] **Step 1: Write failing runtime tests**

Extend the fake-runner warm test with three donor shapes: an exact-HEAD legacy manifest, a different-HEAD manifest with `rust_build_inputs_blake3`, and a different-HEAD legacy manifest. Assert that the first two are offered according to deterministic ranking, the last is never offered, and the event for each attempt contains `matchingMode: "head"` or `matchingMode: "input-hash"`. Assert the successful result also returns its matching mode.

- [x] **Step 2: Run the runtime test and verify RED**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache.test.ts`

Expected: FAIL because kd still excludes every different-HEAD donor and events/results do not expose matching mode.

- [x] **Step 3: Implement candidate classification and event logging**

Move the HEAD compatibility check until after manifest parsing, classify with:

```ts
const matchingMode = worktree.head === fullCommit
  ? "head"
  : manifest.rustBuildInputsBlake3
    ? "input-hash"
    : undefined;
```

Skip candidates without a mode. Add optional `matchingMode` to `RustCacheEvent` for backward-compatible event reads and to hit operation results. Record the donor's mode for every Kanache attempt and include it in the warm success message.

- [x] **Step 4: Run the runtime test and verify GREEN**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache.test.ts`

Expected: PASS.

### Task 3: Cover real worktree discovery and pinned Kanache behavior

**Files:**
- Modify: `tools/kd/tests/rust-cache.integration.test.ts`
- Modify: `tools/kd/src/runtime/rust-cache-policy.ts`

- [x] **Step 1: Write integration coverage**

Teach the fixture donor writer to optionally emit `rust_build_inputs_blake3`. Update the fake integration to offer a hashed donor at `HEAD^`, exclude a legacy donor at `HEAD^`, retain a legacy exact-HEAD donor, and assert the hit/event matching modes. Update the opt-in real acceptance fixture to make a non-Rust commit in the destination worktree before warming and assert an `input-hash` hit.

- [x] **Step 2: Run the integration test with the runtime implementation**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache.integration.test.ts --maxWorkers=1`

Expected: FAIL because the cross-HEAD donor is filtered and no matching mode is reported.

- [x] **Step 3: Pin the merged blocker revision**

Pin the full immutable revision from closed blocker task `f4c62e75` that contains `rust_build_inputs_blake3` matching. Prefer its merged `main` revision; when the blocker closes before GitHub merges, consume its reviewed branch head as explicitly directed.

- [x] **Step 4: Run fake and real integration verification**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/rust-cache.integration.test.ts --maxWorkers=1
KANNA_REAL_KANACHE_ACCEPTANCE=1 pnpm --dir tools/kd exec vitest run tests/rust-cache.integration.test.ts --maxWorkers=1
```

Expected: PASS; the real smoke warms across a non-Rust-only commit using `input-hash` mode.

### Task 4: Update operator documentation and rollout evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-default-kanache-worktree-cache-design.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

- [x] **Step 1: Update the design and seeding guidance**

Document that different commits are candidates only when their donor manifest has `rust_build_inputs_blake3`; Kanache remains authoritative for computing the destination identity and refusing mismatches; legacy/no-hash manifests remain exact-HEAD-only. Update integration coverage and explain that one clean recorded donor from a recent main commit can serve TypeScript/mobile/docs-only branches while Rust-input changes cold-build.

- [x] **Step 2: Run the Kanna-scale manual canary**

On a clean, stopped main checkout, record a donor with `./kd test rust`. Create a fresh worktree with a TypeScript-only commit and no destination Cargo build root. Capture APFS free bytes before/after `./kd rust-cache warm`, then run `./kd rust-cache status` and confirm the recent hit reports `matchingMode: "input-hash"`.

- [x] **Step 3: Record evidence**

Append the date, donor and destination commits, warm wall time, and APFS allocation delta to the existing rollout evidence section. If the environment cannot safely run the canary, state the exact blocker without inventing measurements.

### Task 4A: Exclude Kanna's generated Tauri sidecars from Rust identity

**Files:**
- Modify: `tools/kd/tests/rust-cache-policy.test.ts`
- Modify: `tools/kd/tests/rust-cache.test.ts`
- Modify: `tools/kd/tests/rust-cache.integration.test.ts`
- Modify: `tools/kd/src/runtime/rust-cache-policy.ts`
- Modify: `tools/kd/src/runtime/rust-cache.ts`
- Modify: `docs/superpowers/specs/2026-07-20-default-kanache-worktree-cache-design.md`
- Modify: `AGENTS.md` (`CLAUDE.md` is its symlink)

- [x] **Step 1: Write and run failing exclusion-wiring tests**

Require every `warm` and `manifest record` invocation to pass `--exclude-rust-input-root apps/desktop/src-tauri/binaries`, and require the process-level fake manifest to persist the exact exclusion set.

- [x] **Step 2: Implement one shared exclusion declaration**

Declare the Kanna-generated output root once in policy and append it identically to both Kanache commands. Parse the optional manifest field so `rust-cache status` exposes the recorded contract and distinguishes new empty sets from legacy absence.

- [x] **Step 3: Verify focused tests and document legacy behavior**

Run the three rust-cache test files. Document that older manifests without the exclusions field accept only an empty request and therefore must be reseeded once Kanna consistently requests its generated sidecar root.

- [x] **Step 4: Pin the reviewed merge revision and rerun real acceptance**

After Kanache PR #3 merges, pin the resulting immutable `main` revision (not the pre-review task SHA), run the opt-in real acceptance, and rerun the Kanna-scale canary without copying generated sidecars.

### Task 5: Final verification

**Files:**
- Verify all modified files.

- [x] **Step 1: Run focused kd verification**

Run:

```bash
pnpm --dir tools/kd test
pnpm --dir tools/kd typecheck
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 2: Review the final diff and repository state**

Confirm the pinned revision is merged on Kanache `main`, legacy manifests remain exact-HEAD-only, every attempted donor event has the appropriate matching mode, docs match behavior, and no unrelated files changed.

### Task 6: Restore true legacy exact-HEAD warming

**Files:**
- Modify: `tools/kd/tests/rust-cache.test.ts`
- Modify: `tools/kd/tests/rust-cache.integration.test.ts`
- Modify: `tools/kd/src/runtime/rust-cache.ts`
- Modify: `docs/superpowers/specs/2026-07-20-default-kanache-worktree-cache-design.md`
- Modify: `AGENTS.md` (`CLAUDE.md` is its symlink)

- [x] **Step 1: Add failing legacy compatibility coverage**

Add a runtime assertion that an exact-HEAD manifest with neither
`rust_build_inputs_blake3` nor `rust_build_input_exclusions` is invoked without
`--exclude-rust-input-root`. Extend the opt-in real acceptance fixture to
record a donor with pre-exclusion Kanache revision
`6107c7b533a77a0c7c190b75c0284e7501c6edbf`, assert both fields are absent,
and warm an exact-HEAD sibling through kd's pinned Kanache process.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/rust-cache.test.ts tests/rust-cache.integration.test.ts --maxWorkers=1
KANNA_REAL_KANACHE_ACCEPTANCE=1 pnpm --dir tools/kd exec vitest run tests/rust-cache.integration.test.ts --maxWorkers=1
```

Expected: the legacy argument assertion fails and the real legacy warm is
refused because kd requests an exclusion that the manifest cannot authorize.

- [x] **Step 3: Implement the manifest-aware argument fallback**

Skip `KANACHE_RUST_INPUT_EXCLUSIONS` only when the donor uses `head` mode and
its parsed manifest has neither `rustBuildInputsBlake3` nor
`rustBuildInputExclusions`. Append the exclusions in every other case. Keep
candidate classification, ranking, event matching modes, and all
exclusion-aware input-hash behavior unchanged.

- [x] **Step 4: Update the design contract**

Document that a true legacy exact-HEAD donor is warmed with an empty requested
exclusion set, while different-HEAD donors still require a hash and modern
exclusion-aware manifests still require the exact recorded exclusion set.

- [x] **Step 5: Run the complete reviewer verification set**

Run the two focused Vitest commands above, `pnpm --dir tools/kd typecheck`,
`pnpm test`, `cd crates/daemon && cargo test -- --test-threads=1`, and
`git diff --check`.
