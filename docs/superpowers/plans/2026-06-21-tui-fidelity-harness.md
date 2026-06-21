# TUI Fidelity Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable first-pass harness that measures Kanna mobile terminal fidelity from raw PTY bytes through the real headless terminal snapshot, KSP frames, and mobile xterm renderer.

**Architecture:** Add minimal non-behavioral serialization instrumentation to `HeadlessTerminal`, expose a test-only daemon binary that emits KSP-like JSON frames for raw fixtures, and create a workspace package under `tests/tui-fidelity` that generates fixtures, drives Playwright against the real mobile terminal document, compares rendered grids against raw xterm output, writes goldens, and captures PNGs. Keep the min-cols PTY sizing assertion as a direct Rust unit test of session sizing logic instead of requiring a full mobile render path.

**Tech Stack:** Rust daemon crate, `kanna-agent-protocol` frames, TypeScript, Playwright Chromium, `@xterm/xterm`, `@xterm/addon-serialize`, Vite for bundling the mobile terminal document.

---

### Task 1: Rust Snapshot Fallback Instrumentation

**Files:**
- Modify: `crates/daemon/src/headless_terminal.rs`
- Test: `crates/daemon/src/headless_terminal.rs`

- [ ] **Step 1: Write the failing test**

Add a unit test that calls a new `snapshot_with_metadata()` method and asserts `used_visible_text_fallback` is `false` for a simple serialized screen. Expected initial failure: method does not exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kanna-daemon snapshot_metadata_reports_no_fallback_for_serializable_screen`

- [ ] **Step 3: Implement minimal instrumentation**

Add `TerminalSnapshotWithMetadata { snapshot, used_visible_text_fallback }`, have `snapshot()` delegate to `snapshot_with_metadata()`, and set the flag only inside the existing serialize-error fallback branch. Do not change bytes or behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p kanna-daemon snapshot_metadata_reports_no_fallback_for_serializable_screen`

### Task 2: Path Emitter Binary

**Files:**
- Modify: `crates/daemon/Cargo.toml`
- Create: `crates/daemon/src/bin/tui_fidelity_emit.rs`
- Test: `crates/daemon/src/bin/tui_fidelity_emit.rs`

- [ ] **Step 1: Write failing tests**

Add unit tests for deterministic chunking and JSON frame shape: one `term_snapshot` followed by `term_output` frames with base64 payloads and a top-level fallback flag.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kanna-daemon --bin tui-fidelity-emit`

- [ ] **Step 3: Implement emitter**

Read a fixture path and optional `--cols`, `--rows`, `--chunk-pattern` flags; feed all bytes into `HeadlessTerminal`; emit JSON containing `fixture`, `cols`, `rows`, `used_visible_text_fallback`, and KSP-compatible frames. For first iteration, use deterministic chunk pattern `[7, 1, 13, 2, 31]` unless overridden, so UTF-8 and escape sequences can be split.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p kanna-daemon --bin tui-fidelity-emit`

### Task 3: TypeScript Harness Package

**Files:**
- Modify: `package.json`
- Create: `tests/tui-fidelity/package.json`
- Create: `tests/tui-fidelity/tsconfig.json`
- Create: `tests/tui-fidelity/src/types.ts`
- Create: `tests/tui-fidelity/src/fixtures.ts`
- Create: `tests/tui-fidelity/src/emitter.ts`
- Create: `tests/tui-fidelity/src/render.ts`
- Create: `tests/tui-fidelity/src/diff.ts`
- Create: `tests/tui-fidelity/src/run.ts`
- Create: `tests/tui-fidelity/src/minCols.test.ts`
- Create: `tests/tui-fidelity/fixtures/`
- Create: `tests/tui-fidelity/goldens/`
- Create: `tests/tui-fidelity/artifacts/`

- [ ] **Step 1: Write failing type-level and runner tests**

Implement the runner entry point to fail until fixture generation, emitter invocation, render extraction, diffing, and goldens exist. Add `pnpm test:tui-fidelity` to root scripts.

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `pnpm --filter @kanna/tui-fidelity exec tsc --noEmit`

- [ ] **Step 3: Implement fixture generation and emitter invocation**

Generate the initial synthetic corpus in repo: wide chars/emoji, box drawing, colors, alt screen, scroll region, cursor save/restore, spinner redraw, and split-sensitive text. Invoke `cargo run -p kanna-daemon --bin tui-fidelity-emit -- <fixture>`.

- [ ] **Step 4: Implement renderer and diff**

Use Playwright to load `buildTerminalDocument({ bottomInset: 0 })`, replay `TermSnapshot` and `TermOutput` frames through `window.__replaceTerminalState` and `window.__appendTerminalChunk`, render the raw fixture directly in a second xterm oracle, extract serialized grids and cell attributes, compare cell-by-cell, and save PNGs.

- [ ] **Step 5: Implement goldens**

Compare current JSON results against `goldens/*.json`; support `--update-goldens` to write them. Fail if the observed divergence differs from goldens or a fixture uses the fallback unexpectedly.

- [ ] **Step 6: Run typecheck and harness**

Run: `pnpm --filter @kanna/tui-fidelity exec tsc --noEmit`
Run: `pnpm test:tui-fidelity -- --update-goldens`
Run: `pnpm test:tui-fidelity`

### Task 4: Min-Cols Sizing Assertion

**Files:**
- Test: `crates/daemon/src/session.rs` or `tests/tui-fidelity/src/minCols.test.ts`

- [ ] **Step 1: Write failing test**

Add a test proving effective PTY dimensions take the minimum cols and rows across attached clients, with mobile-only 220 columns and co-attached narrow client reducing to the narrower width.

- [ ] **Step 2: Run test to verify it fails if no assertion exists**

Run the narrow target test command selected after inspecting session sizing helpers.

- [ ] **Step 3: Implement minimal assertion/helper if needed**

Prefer testing existing dimension logic directly; add only a small pure helper if the current logic is not separately testable.

- [ ] **Step 4: Run test to verify it passes**

Run the same narrow target test command.

### Task 5: Documentation and Verification

**Files:**
- Create: `tests/tui-fidelity/README.md`
- Create/modify: `tests/tui-fidelity/goldens/*.json`
- Create/modify: `tests/tui-fidelity/artifacts/*.png`

- [ ] **Step 1: Document usage**

Explain fixture generation, `pnpm test:tui-fidelity`, `--update-goldens`, fallback reporting, diff output, and where PNGs are written.

- [ ] **Step 2: Run verification**

Run `cargo fmt --all`, `cargo clippy -p kanna-daemon --all-targets`, `cargo test -p kanna-daemon`, `pnpm --filter @kanna/tui-fidelity exec tsc --noEmit`, and `pnpm test:tui-fidelity`.

- [ ] **Step 3: Report divergences**

Summarize per-fixture fallback status, divergent cell counts, and the largest observed fidelity issues in the PR body.
