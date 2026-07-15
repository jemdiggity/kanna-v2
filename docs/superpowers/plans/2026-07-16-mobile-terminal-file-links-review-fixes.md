# Mobile Terminal File Links Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile terminal file links persistently visible and accessible, prove the full relay-backed preview flow in the simulator, fix raw line targeting for every newline convention, and synchronize Rust/Bazel dependency metadata.

**Architecture:** Keep xterm's row-scoped link provider for direct path hit testing, and add a bounded semantic file-link strip sourced from recent real xterm buffer rows after each render. Both activation paths use one gesture-suppressed bridge function. Extend the existing relay simulator lane with a scripted task file and PTY paths so Appium taps the WebView affordance and observes the native preview plus its real WebView content. Select the newest task worktree deterministically in SQLite.

**Tech Stack:** TypeScript, React Native WebView, xterm.js, WebdriverIO/Appium, Vitest/happy-dom, Rust, SQLite/rusqlite, Cargo, Bazel.

---

### Task 1: Newline-agnostic raw line targeting

**Files:**
- Modify: `apps/mobile/src/screens/buildTaskFilePreviewDocument.test.ts`
- Modify: `apps/mobile/src/screens/buildTaskFilePreviewDocument.ts`

- [ ] **Step 1: Write failing LF/CRLF/bare-CR target tests**

Add a parameterized test that requests line 2 from `first\nsecond\nthird`, `first\r\nsecond\r\nthird`, and `first\rsecond\rthird`. Assert the single `data-line="2"` span wraps only `second`, while the original newline bytes remain outside the span.

- [ ] **Step 2: Run the focused test and confirm bare-CR/CRLF failures**

Run: `pnpm --dir apps/mobile test -- buildTaskFilePreviewDocument.test.ts`

Expected: the current LF-only `indexOf("\n")` implementation fails for bare CR and includes a CR in the CRLF target.

- [ ] **Step 3: Implement a newline-boundary scanner**

Replace the LF-only loop with a bounded scan that treats `\n`, `\r\n`, and `\r` as one line break and returns `{ start, end }` for the requested one-based line. Preserve the constant-DOM property by emitting only the requested span.

- [ ] **Step 4: Run the focused test**

Run: `pnpm --dir apps/mobile test -- buildTaskFilePreviewDocument.test.ts`

Expected: all preview-document tests pass.

### Task 2: Persistent touch-visible terminal file affordance

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`

- [ ] **Step 1: Write failing interaction tests**

Execute the generated document, feed terminal output containing `docs/spec.md:42`, query a visible semantic button under `#terminal-file-links`, dispatch a real DOM click, and assert the bridge payload. Assert the region and button have accessible labels, the button text remains underlined without hover, duplicate links are collapsed, and the list is capped. Dispatch scroll and pinch touch sequences over the link and assert no bridge activation while the existing terminal scroll/zoom assertions still hold.

- [ ] **Step 2: Run the focused test and confirm the affordance is absent**

Run: `pnpm --dir apps/mobile test -- buildTerminalDocument.test.ts`

Expected: failures because no persistent file-link region or semantic buttons exist.

- [ ] **Step 3: Implement the bounded file-link strip and gesture guard**

Add a fixed `role="region"` container above the terminal bottom inset. After each completed xterm render, scan at most the most recent 200 buffer rows, parse candidates with the same parser used by `ILinkProvider`, keep the newest six unique raw links, and render `button` elements using `textContent`, `aria-label`, and persistent underline styling. Route both button click and provider activation through a bridge helper that rejects activation for a short interval after one-finger movement or multi-touch pinch.

- [ ] **Step 4: Run the focused terminal tests**

Run: `pnpm --dir apps/mobile test -- buildTerminalDocument.test.ts`

Expected: all terminal-document tests pass, including scroll and pinch regressions.

### Task 3: Real relay/Appium file preview flow

**Files:**
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/src/screens/TaskFilePreview.tsx`
- Modify: `apps/mobile/e2e/helpers/relay-harness.test.ts`
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`

- [ ] **Step 1: Write failing harness and relay-flow tests**

Specify fixture metadata for a real Markdown file, its line-target link, a missing-file link, and expected content. Specify a WebView-context helper that finds the terminal link region, uses WebDriver element tap rather than invoking bridge callbacks, returns to native context, waits for preview path/mode/error controls, inspects the preview WebView document, and closes the modal.

- [ ] **Step 2: Run the focused E2E helper tests**

Run: `pnpm --dir apps/mobile test -- e2e/helpers/relay-harness.test.ts e2e/specs/relay/relay-task-flow.test.ts`

Expected: failures because fixture file/path metadata and preview flow helpers do not exist.

- [ ] **Step 3: Seed real task file and PTY links through the owner**

In `startMobileRelayHarness`, write `docs/mobile-file-preview.md` inside the scripted task worktree, then post a line containing the rendered link, `:3` raw link, and missing-file link to the running PTY through `/v1/tasks/{id}/input`. Wait for that output before returning the fixture.

- [ ] **Step 4: Drive the real simulator UI**

Extend `runRelayTaskFlow` to switch into the terminal WebView, verify the accessible visible link, perform a swipe and two-pointer zoom without opening the preview, tap the button, and return to native context. Assert the normalized path, rendered Markdown content, raw line target, close behavior, and routed missing-file error. Use stable test IDs for preview path, mode, close, and error title.

- [ ] **Step 5: Run unit tests and the simulator relay lane**

Run: `pnpm --dir apps/mobile test -- e2e/helpers/relay-harness.test.ts e2e/specs/relay/relay-task-flow.test.ts`

Run: `pnpm --dir apps/mobile test:e2e:relay`

Expected: helper tests and the real simulator relay/Appium flow pass without physical-device automation.

### Task 4: Deterministic current worktree selection

**Files:**
- Modify: `crates/kanna-server/src/db/worktrees.rs`
- Modify: `crates/kanna-server/src/task_files.rs`

- [ ] **Step 1: Write a failing multi-worktree server test**

Insert two worktree rows for one task in immediate succession, put different `docs/spec.md` content in each, and assert `read_task_file` returns the second/newest workspace content even when SQLite's second-resolution `created_at` values tie.

- [ ] **Step 2: Run the focused Rust test**

Run: `cargo test -p kanna-server task_files::tests::reads_from_newest_task_worktree -- --exact`

Expected: failure because `ORDER BY created_at DESC` does not deterministically break ties.

- [ ] **Step 3: Add a stable newest-row tie-break**

Change `get_task_worktree_path` to order by `created_at DESC, rowid DESC`, matching insertion recency even when timestamps tie.

- [ ] **Step 4: Run task-file and server tests**

Run: `cargo test -p kanna-server task_files::tests`

Expected: all task-file tests pass.

### Task 5: Dependency locks and full verification

**Files:**
- Modify: `crates/kanna-server/Cargo.lock`
- Modify: `MODULE.bazel.lock`

- [ ] **Step 1: Regenerate the dedicated Cargo lock**

Run: `cargo generate-lockfile --manifest-path crates/kanna-server/Cargo.toml`

Expected: the `kanna-server` package dependency list includes direct `libc`.

- [ ] **Step 2: Regenerate Bazel module metadata**

Run: `bazel build //crates/kanna-server:kanna_server --noshow_progress`

Expected: the target builds and `MODULE.bazel.lock` records the regenerated crate graph.

- [ ] **Step 3: Run requested verification**

Run, in order:

```sh
pnpm --dir apps/mobile test
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile test:e2e:relay
pnpm test
(cd crates/daemon && cargo test -- --test-threads=1)
cargo test -p kanna-server
bazel build //crates/kanna-server:kanna_server --noshow_progress
```

Expected: every command exits zero.

- [ ] **Step 4: Prove the Bazel build is reproducible**

Capture `git status --short`, run the Bazel build once more, and compare `git status --short` afterward.

Expected: the second build introduces no additional changes. The worktree remains intentionally dirty only with this revision's source, test, plan, and regenerated lock changes because the Kanna pipeline commits later.
