# Mobile Terminal E2E Inspection Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent terminal inspection traversal, WebView bridge messages, and native React state updates in non-E2E mobile builds while preserving Appium diagnostics in E2E builds.

**Architecture:** Pass the E2E build flag into the generated terminal document and emit inspection-only JavaScript only when enabled. Use the same build-time flag in `TerminalWebView` to ignore inspection messages and avoid inspection state outside E2E, while leaving ready and tap bridge messages unchanged.

**Tech Stack:** React Native, Expo environment variables, `react-native-webview`, xterm.js, TypeScript, Vitest, happy-dom.

---

### Task 1: Specify generated-document inspection gating

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`

- [x] **Step 1: Write failing document tests**

Add one test that executes a document built without E2E inspection and asserts replace/append operations send no `terminal-inspection` message. Add one test that executes an E2E-enabled document and asserts replace/append operations still send inspection messages with the expected terminal metadata.

- [x] **Step 2: Verify the document tests fail for the expected reason**

Run: `pnpm --dir apps/mobile test -- buildTerminalDocument.test.ts`

Expected: the non-E2E test fails because inspection messages are currently emitted unconditionally, and/or the enabled option is not yet accepted.

- [x] **Step 3: Implement document-level gating**

Extend `BuildTerminalDocumentOptions` with an `enableE2EInspection` boolean. Generate `renderedTerminalText`, `notifyTerminalInspection`, and the `finalizeRender` notification call only when the flag is true, while preserving terminal-ready and terminal-tap messages for normal operation.

- [x] **Step 4: Verify the document tests pass**

Run: `pnpm --dir apps/mobile test -- buildTerminalDocument.test.ts`

Expected: all focused document tests pass.

### Task 2: Specify native inspection-message gating

**Files:**
- Modify: `apps/mobile/src/screens/TerminalWebView.test.tsx`
- Modify: `apps/mobile/src/screens/TerminalWebView.tsx`

- [x] **Step 1: Write a failing native non-E2E test**

Render without `EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED`, deliver a `terminal-inspection` bridge message, rerender, and assert no hidden diagnostic marker appears. Also assert the generated source does not contain terminal-inspection instrumentation.

- [x] **Step 2: Verify the native test fails for the expected reason**

Run: `pnpm --dir apps/mobile test -- TerminalWebView.test.tsx`

Expected: the new state-update assertion fails against the unconditional message handler or the generated source still contains inspection instrumentation.

- [x] **Step 3: Implement native-level gating**

Resolve the E2E flag once at module load, pass it to `buildTerminalDocument`, keep inspection state inert by rejecting inspection messages when disabled, and use the same boolean for the hidden marker.

- [x] **Step 4: Verify both native modes pass**

Run: `pnpm --dir apps/mobile test -- TerminalWebView.test.tsx`

Expected: the existing E2E marker test and the new non-E2E test both pass.

### Task 3: Verify the revision

**Files:**
- Review: `apps/mobile/src/screens/buildTerminalDocument.ts`
- Review: `apps/mobile/src/screens/TerminalWebView.tsx`
- Review: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Review: `apps/mobile/src/screens/TerminalWebView.test.tsx`

- [x] **Step 1: Run the complete mobile suite**

Run: `pnpm --dir apps/mobile test`

Expected: exit code 0 with no failed tests.

- [x] **Step 2: Run the repository-required JavaScript suite**

Run: `pnpm test`

Expected: exit code 0 with no failed tests.

- [x] **Step 3: Run daemon tests serially**

Run: `cd crates/daemon && cargo test -- --test-threads=1`

Expected: exit code 0 with no failed tests.

- [x] **Step 4: Run kanna-server tests**

Run: `cargo test -p kanna-server`

Expected: exit code 0 with no failed tests.

- [x] **Step 5: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat && git diff`

Expected: only the planned revision and plan file are changed, with no whitespace errors.
