# Mobile Terminal Snapshot Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the mobile terminal replay buffer from evicting an oversized daemon snapshot while still bounding subsequent live-output frames.

**Architecture:** Keep the existing newline-delimited `taskTerminalOutput` contract. Treat its first complete frame as the attachment snapshot, exempt that frame from the one-million-character live-output budget, and evict only whole oldest frames from the live suffix.

**Tech Stack:** TypeScript, mobile session store, Vitest, pnpm

---

## File Structure

- Modify `apps/mobile/src/state/sessionStore.test.ts`: encode the snapshot-first retention contract as focused regressions at and above the current limit.
- Modify `apps/mobile/src/state/sessionStore.ts`: replace the total-buffer cap with snapshot-aware, frame-boundary retention.
- Modify `apps/mobile/src/lib/api/client.ts`: preserve terminal snapshot identity in the mobile event contract.
- Modify `apps/mobile/src/lib/transports/lanTransport.ts` and `relayClient.ts`: forward stream-client snapshots without flattening them into output.
- Modify `apps/mobile/src/state/mobileController.ts`: replace replay state atomically for initial and reconnect snapshots.
- Modify the corresponding transport and controller tests to cover snapshot identity and reconnect replacement.
- Reference `docs/superpowers/specs/2026-07-17-mobile-terminal-snapshot-retention-design.md`: approved behavior and scope; no daemon, KSP, recovery, desktop, or native mobile files change.

### Task 1: Reproduce Oversized Snapshot Eviction

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.test.ts:264-315`
- Test: `apps/mobile/src/state/sessionStore.test.ts`

- [x] **Step 1: Strengthen the oversized snapshot regression**

Replace the existing 50,000-character snapshot test with a frame that exceeds the actual 1,000,000-character limit:

```ts
it("keeps a snapshot larger than the live-output cap", () => {
  const store = createSessionStore();
  store.beginTaskTerminal("task-1", "");

  const snapshot = "A".repeat(1_100_000);
  store.appendTaskTerminal("task-1", `${snapshot}\n`);

  expect(store.getState().taskTerminalOutput).toBe(`${snapshot}\n`);
});
```

- [x] **Step 2: Add snapshot-plus-delta and frame-eviction regressions**

Replace the old total-buffer assertion with a test that distinguishes the protected snapshot from evictable live frames:

```ts
it("evicts only whole oldest live frames while retaining the snapshot", () => {
  const store = createSessionStore();
  store.beginTaskTerminal("task-1", "");

  const snapshot = "A".repeat(300_000);
  const liveFrames = ["B", "C", "D", "E"].map((value) =>
    value.repeat(300_000)
  );
  store.appendTaskTerminal("task-1", `${snapshot}\n`);
  for (const frame of liveFrames) {
    store.appendTaskTerminal("task-1", `${frame}\n`);
  }

  const frames = store.getState().taskTerminalOutput.split("\n").filter(Boolean);
  expect(frames).toEqual([snapshot, ...liveFrames.slice(-3)]);
});
```

Add coverage for a single oversized live frame, which must be kept whole even though it exceeds the soft delta budget:

```ts
it("keeps one oversized live frame whole after the snapshot", () => {
  const store = createSessionStore();
  store.beginTaskTerminal("task-1", "");

  const snapshot = "c25hcHNob3Q=";
  const liveFrame = "B".repeat(1_100_000);
  store.appendTaskTerminal("task-1", `${snapshot}\n`);
  store.appendTaskTerminal("task-1", `${liveFrame}\n`);

  expect(store.getState().taskTerminalOutput).toBe(
    `${snapshot}\n${liveFrame}\n`
  );
});
```

- [x] **Step 3: Make the replay test cross the real threshold**

Change the existing decodability test's snapshot payload so its encoded frame exceeds one million characters, while retaining its dimension and replay assertions:

```ts
const snapshotText = "snapshot scrollback row\r\n".repeat(40_000);
const snapshotFrame = Buffer.from(snapshotText, "utf8").toString("base64");
expect(snapshotFrame.length).toBeGreaterThan(1_000_000);
```

Assert decoded replay still includes both ends of the stream:

```ts
expect(decoded).toContain("snapshot scrollback row");
expect(decoded).toContain("LIVE-APPEND-CORRECT");
```

- [x] **Step 4: Run the focused tests and verify the current implementation fails**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts
```

Expected: FAIL in the new oversized snapshot tests because the existing cap removes the first frame when its trailing newline lies after the cutoff. Existing unrelated session-store tests should remain green.

### Task 2: Protect the Snapshot and Cap Live Frames

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.ts:16-32`
- Test: `apps/mobile/src/state/sessionStore.test.ts`

- [x] **Step 1: Rename the limit to describe its new scope**

Replace the total-output constant and comment with:

```ts
// Terminal output is accumulated as newline-delimited base64 frames and replayed
// into xterm.js on WebView (re)mount. The first frame is the full attachment
// snapshot and must survive intact; only subsequent live frames are bounded.
// Always evict at frame boundaries so replay never receives partial base64.
const MAX_TERMINAL_LIVE_OUTPUT_CHARS = 1_000_000;
```

- [x] **Step 2: Implement snapshot-aware frame retention**

Replace `capTerminalOutput` with:

```ts
function capTerminalOutput(output: string): string {
  const snapshotEnd = output.indexOf("\n") + 1;
  if (snapshotEnd === 0) {
    return output;
  }

  const liveOutput = output.slice(snapshotEnd);
  if (liveOutput.length <= MAX_TERMINAL_LIVE_OUTPUT_CHARS) {
    return output;
  }

  const cut = liveOutput.length - MAX_TERMINAL_LIVE_OUTPUT_CHARS;
  let retainedLiveStart: number;
  if (cut === 0 || liveOutput[cut - 1] === "\n") {
    retainedLiveStart = cut;
  } else {
    const nextFrameEnd = liveOutput.indexOf("\n", cut);
    if (nextFrameEnd >= 0 && nextFrameEnd + 1 < liveOutput.length) {
      retainedLiveStart = nextFrameEnd + 1;
    } else {
      // The newest frame alone crosses the soft limit (or is incomplete).
      // Keep it whole, starting after the preceding complete frame.
      retainedLiveStart = liveOutput.lastIndexOf("\n", cut - 1) + 1;
    }
  }

  return `${output.slice(0, snapshotEnd)}${liveOutput.slice(retainedLiveStart)}`;
}
```

This keeps an incomplete first frame unchanged, never evicts the snapshot, removes only complete old live frames, and permits one newest frame to exceed the soft budget rather than corrupting or dropping it.

- [x] **Step 3: Run the focused store tests and verify they pass**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts
```

Expected: all tests in `sessionStore.test.ts` PASS, including the oversized snapshot, bounded live suffix, oversized live frame, and decoded replay cases.

### Task 3: Verify the Mobile Change

**Files:**
- Verify: `apps/mobile/src/state/sessionStore.ts`
- Verify: `apps/mobile/src/state/sessionStore.test.ts`
- Verify: `docs/superpowers/specs/2026-07-17-mobile-terminal-snapshot-retention-design.md`

- [x] **Step 1: Run the mobile TypeScript check**

Run:

```bash
pnpm --dir apps/mobile typecheck
```

Expected: command exits 0 with no TypeScript errors.

- [x] **Step 2: Run the mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: all mobile Vitest suites PASS.

- [x] **Step 3: Inspect the final diff and whitespace checks**

Run:

```bash
git diff --check
git diff -- apps/mobile/src/state/sessionStore.ts apps/mobile/src/state/sessionStore.test.ts docs/superpowers/specs/2026-07-17-mobile-terminal-snapshot-retention-design.md docs/superpowers/plans/2026-07-17-mobile-terminal-snapshot-retention.md
```

Expected: `git diff --check` produces no output. The diff changes only the
mobile terminal event contract, its LAN/relay adapters, controller/store replay
logic, their tests, and the approved design/plan documents. Per this Kanna
stage's instructions, leave the work uncommitted for the workflow to commit
after manual advancement.

### Task 4: Preserve Authoritative Snapshot Identity on Reconnect

**Files:**
- Modify: `apps/mobile/src/lib/api/client.ts:20-24`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts:137-147`
- Modify: `apps/mobile/src/lib/transports/relayClient.ts:352-362`
- Modify: `apps/mobile/src/state/mobileController.ts:680-700`
- Modify: `apps/mobile/src/state/sessionStore.ts:153-154,579-590`
- Test: `apps/mobile/src/state/mobileController.test.ts`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Test: `apps/mobile/src/lib/transports/relayClient.test.ts`

- [x] **Step 1: Add a failing reconnect replacement regression**

Emit an initial snapshot and delta, then a second snapshot over 1,000,000
characters and another delta. Assert the store contains only the second snapshot
and the final delta. Run the controller test and confirm it fails because
`TaskTerminalStreamEvent` does not yet distinguish snapshots.

- [x] **Step 2: Add a store operation for authoritative snapshots**

Add `setTaskTerminalSnapshot(taskId, snapshot, cols, rows)` to `SessionStore`.
For the active task it atomically replaces `taskTerminalOutput` and dimensions,
sets status to `live`, clears the terminal error, and publishes once.

- [x] **Step 3: Preserve snapshot events through both transports**

Replace terminal `ready` with:

```ts
| { type: "snapshot"; taskId: string; cols: number; rows: number; dataB64: string }
```

Have LAN and relay `onSnapshot` callbacks emit exactly one `snapshot` event,
including empty snapshot payloads. Keep `onOutput` behavior unchanged. Update
their unit expectations to prove snapshot and output remain distinct.

- [x] **Step 4: Replace replay state in the controller**

Handle `snapshot` by calling `setTaskTerminalSnapshot` with the dimensions and
`dataB64 ? `${dataB64}\n` : ""`. Remove the obsolete `ready` branch. Update
existing controller tests to emit snapshots.

- [x] **Step 5: Run focused and full verification**

Run the controller, LAN transport, relay transport, and session-store tests,
then `pnpm --dir apps/mobile typecheck`, `pnpm --dir apps/mobile test`, and
`git diff --check`. All commands must exit zero before handoff.

### Task 5: Exercise Oversized Snapshot Replay Through Relay and Appium

**Files:**
- Modify: `tests/remote-e2e/src/scriptedAgent.ts`
- Modify: `tests/remote-e2e/src/scriptedAgent.test.ts`
- Modify: `tests/remote-e2e/src/terminalFlowTestUtils.ts`
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Modify: `apps/mobile/e2e/helpers/relay-harness.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Test: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`

- [x] **Step 1: Add failing fixture and revisit-journey tests**

Require the deterministic relay fixture to declare an encoded snapshot boundary
strictly greater than 1,000,000 characters. Add a relay-flow helper test that
expects this sequence: open task, wait for the terminal to become live, assert
the WebView snapshot, return to the list, reopen the same task, and assert the
WebView snapshot again.

Run:

```bash
pnpm --dir apps/mobile test -- e2e/helpers/relay-harness.test.ts e2e/specs/relay/relay-task-flow.test.ts
```

Expected: FAIL because the oversized fixture and revisit helper do not exist.

- [x] **Step 2: Make the scripted PTY produce retained oversized history**

Add an opt-in `snapshotHistory` setting to the shared scripted-agent fixture.
Before `SCRIPT_READY`, emit 10,050 79-column terminal lines followed by a unique
sentinel. At 80 columns the daemon retains roughly 10,000 complete history rows,
so its serialized snapshot remains over 750,000 decoded bytes and therefore over
1,000,000 base64 characters. Keep this opt-in so unrelated remote E2E tasks stay
small.

- [x] **Step 3: Observe and validate the authoritative snapshot**

Teach `TerminalEventCollector` to preserve `snapshot` identity, replace its
accumulated view on a fresh snapshot, and wait for snapshot dimensions, sentinel
content, and encoded length. In the mobile relay harness, wait for the history
sentinel, detach, reattach, then reject the fixture unless the new authoritative
snapshot has more than 1,000,000 encoded characters. Use its decoded size and
daemon dimensions as the Appium expectation.

- [x] **Step 4: Revisit the task through the real mobile relay path**

Add the Appium helper exercised by `runRelayTaskFlow`: open the exact relay task,
wait for `TerminalWebView` to report nonblank sentinel text, decoded bytes, and
daemon dimensions; navigate back; reopen the same task; repeat the same WebView
assertion. Continue the existing file-preview and quick-reply journey from the
reopened task.

- [x] **Step 5: Run focused and requested verification**

Run the focused mobile and scripted-agent tests, mobile typecheck, then:

```bash
pnpm --dir apps/mobile run test:e2e:preflight
pnpm --dir apps/mobile run test:e2e:relay
pnpm test
cd crates/daemon && cargo test -- --test-threads=1
```

Record any genuine environmental blocker with the exact failing prerequisite;
do not substitute the unit tests silently. Finish with `git diff --check` and an
inspection of the scoped diff.

Verification notes:

- The generic Appium preflight could not run because
  `KANNA_E2E_DESKTOP_SERVER_URL` was unset and no kd-managed desktop fixture was
  running. Supplying that URL for a live fixture would make the generic smoke
  path feasible; the reviewer-approved deterministic relay path was used here.
- The relay harness observed an authoritative 1,085,488-character base64
  snapshot (814,116 decoded bytes, 80x24) before launching Appium. The initial
  run completed both `TerminalWebView` assertions, then exposed an ordering
  defect introduced by the revisit journey: that journey ended on task detail,
  and the immediately following marked-read journey polled for a task-list row.
  Reruns reporting `rendered task row ids were []` confirmed the app was still
  on detail rather than revealing a pre-existing task-activity flake.
- The revision runs the marked-read journey while the task list is rendered,
  then performs the initial-open/reopen snapshot journey. The reopen leaves task
  detail visible for file preview and quick reply. A unit-level orchestration
  regression models those list/detail preconditions in addition to the focused
  revisit helper sequence.
- After rebasing onto `origin/main`, the relay run again captured the
  1,085,488-character snapshot and completed the reordered marked-read,
  initial-open/reopen, and task-action-menu journeys. The remaining failure was
  in the subsequent file-preview WebView inspection: Appium selected both
  preview WebViews, but the iOS remote debugger returned `Runtime domain was not
  found` for both `execute/sync` attempts, so the runner could not inspect the
  rendered syntax-highlight color. This is separate from the introduced
  task-list/detail ordering defect; the dev simulator client was regenerated
  with the `build.kanna.app.dev` identity and the new `ExpoClipboard` native
  module before this run.
- Focused mobile and scripted-agent tests, both relevant typechecks, `pnpm test`,
  the serial daemon suite, and `git diff --check` completed successfully.
