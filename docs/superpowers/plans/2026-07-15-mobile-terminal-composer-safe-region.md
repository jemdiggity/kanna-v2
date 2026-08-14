# Mobile Terminal Composer Safe Region Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the floating mobile composer, keep real bundled-xterm rows above it, preserve manual scrollback during output, and resume following only near the live bottom.

**Architecture:** `TaskScreen` derives a bottom inset from native layout coordinates and `TerminalWebView` coalesces it through a runtime JavaScript bridge. The generated document applies that inset at Kanna's outer viewport boundary, aligns pinned grids, and tracks follow state with xterm's public buffer API. Chromium coverage in the existing TUI-fidelity package verifies the bundled runtime rather than a simulated legacy DOM.

**Tech Stack:** React Native, React Native WebView, TypeScript, xterm.js 6.1 beta, Vitest, Playwright/Chromium

---

## File Map

- Create `apps/mobile/src/screens/terminalSafeArea.ts`: pure native layout-to-inset calculation.
- Create `apps/mobile/src/screens/terminalSafeArea.test.ts`: normal, multiline, and keyboard geometry coverage.
- Modify `apps/mobile/src/screens/TaskScreen.tsx` and `.test.tsx`: measure both native layout boundaries and pass the inset.
- Modify `apps/mobile/src/e2eTestIds.ts`: expose the measured composer chrome for component/native inspection.
- Modify `apps/mobile/src/screens/TerminalWebView.tsx` and `.test.tsx`: add and coalesce the runtime inset bridge without reloading HTML.
- Modify `apps/mobile/src/screens/buildTerminalDocument.ts` and `.test.ts`: use Kanna's viewport plus xterm's public scroll API and correct the narrow stub contract.
- Create `tests/tui-fidelity/src/terminalSafeRegion.ts` and `run-terminal-safe-region.ts`: real bundled-xterm Chromium regression.
- Modify `tests/tui-fidelity/src/render.ts`, `run.ts`, `package.json`, and `README.md`: share the instrumented document and run/document the regression.
- Modify `apps/mobile/e2e/terminal-streaming-coverage.md`: replace the stale `.xterm-viewport` contract and document the Appium gap/substitute.

This Kanna stage explicitly leaves commits to its workflow, so the steps below do not create commits.

### Task 1: Add a failing real-browser runtime regression

**Files:**
- Create: `tests/tui-fidelity/src/terminalSafeRegion.ts`
- Create: `tests/tui-fidelity/src/run-terminal-safe-region.ts`
- Modify: `tests/tui-fidelity/src/render.ts`
- Modify: `tests/tui-fidelity/src/run.ts`
- Modify: `tests/tui-fidelity/package.json`

- [x] **Step 1: Export the existing real-document helpers**

Make `buildInstrumentedMobileDocument(bottomInset)` and `waitForWrites(page)` exports from `render.ts`, pass `enableE2EInspection: false`, and declare the forthcoming runtime hook:

```ts
interface MobileDocumentModule {
  buildTerminalDocument(options: {
    bottomInset: number;
    enableE2EInspection: boolean;
  }): string;
}

interface Window {
  __setTerminalBottomInset: (state: { bottomInset: number }) => void;
}
```

- [x] **Step 2: Write the Chromium assertions**

Implement `verifyTerminalSafeRegion(browser)` to load the generated document at `390x844`, pin it to `132x43`, write at least 300 lines, and execute this geometry matrix:

```ts
const SAFE_REGION_CASES = [
  { name: "normal", bottomInset: 132 },
  { name: "multiline", bottomInset: 212 },
  { name: "keyboard", bottomInset: 446 },
  { name: "keyboard-multiline", bottomInset: 526 }
] as const;
```

For each case call `window.__setTerminalBottomInset`, wait two animation frames, and assert the real `.xterm-scrollable-element` rectangle ends no lower than `innerHeight - bottomInset`. Assert that `.xterm-screen` is inside that host and `.xterm-viewport` is not.

Use real wheel input to move at least three buffer rows upward. Record `baseY`, `viewportY`, and the text at `viewportY`; append through `__appendTerminalChunk`; assert `baseY` grows while `viewportY` and the recorded line remain unchanged. Then call public `scrollToLine(baseY - 1)`, append again, and assert `viewportY === baseY`.

- [x] **Step 3: Add focused and full harness entry points**

Add:

```json
"test:terminal-safe-region": "tsx src/run-terminal-safe-region.ts"
```

Call `verifyTerminalSafeRegion(browser)` from the existing `run.ts` before fixture rendering so `pnpm test:tui-fidelity` always includes the regression.

- [x] **Step 4: Verify RED**

Run:

```bash
pnpm --filter @kanna/tui-fidelity test:terminal-safe-region
```

Expected: FAIL because `window.__setTerminalBottomInset` does not exist. If temporarily bypassed, the current append path also fails by moving `viewportY` to `baseY`.

### Task 2: Measure and propagate real native geometry

**Files:**
- Create: `apps/mobile/src/screens/terminalSafeArea.ts`
- Create: `apps/mobile/src/screens/terminalSafeArea.test.ts`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [x] **Step 1: Write failing geometry tests**

Specify this API:

```ts
export const DEFAULT_TERMINAL_BOTTOM_INSET = 132;

export function getTerminalBottomInset(
  screenHeight: number,
  composerTop: number | null
): number;
```

Assert fallback behavior for unavailable/invalid coordinates and the exact matrix `800/676 -> 132`, `800/596 -> 212`, `800/362 -> 446`, and `800/282 -> 526`.

- [x] **Step 2: Verify geometry RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/terminalSafeArea.test.ts
```

Expected: FAIL because `terminalSafeArea.ts` does not exist.

- [x] **Step 3: Implement the pure calculation**

Use an 8 px reading gap and finite, same-coordinate-space values:

```ts
const TERMINAL_READING_GAP = 8;

export function getTerminalBottomInset(
  screenHeight: number,
  composerTop: number | null
): number {
  if (!Number.isFinite(screenHeight) || screenHeight <= 0 ||
      composerTop === null || !Number.isFinite(composerTop)) {
    return DEFAULT_TERMINAL_BOTTOM_INSET;
  }
  return Math.max(0, Math.ceil(screenHeight - composerTop + TERMINAL_READING_GAP));
}
```

- [x] **Step 4: Write failing TaskScreen wiring coverage**

Add `MOBILE_E2E_IDS.taskComposerChrome`, execute the root and composer `onLayout` callbacks in `TaskScreen.test.tsx`, rerender, and assert each representative inset appears on the `TerminalWebView` prop. This proves plus/multiline/keyboard geometry is taken from final layout rather than duplicated style arithmetic.

- [x] **Step 5: Verify TaskScreen RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TaskScreen.test.tsx
```

Expected: FAIL because `TaskScreen` does not yet measure or pass `bottomInset`.

- [x] **Step 6: Implement TaskScreen measurement**

Store root height and composer `layout.y`, calculate `terminalBottomInset`, attach both `onLayout` callbacks, and pass `bottomInset={terminalBottomInset}` only to the fullscreen PTY `TerminalWebView`.

### Task 3: Bridge inset changes without reloading WebView

**Files:**
- Modify: `apps/mobile/src/screens/TerminalWebView.test.tsx`
- Modify: `apps/mobile/src/screens/TerminalWebView.tsx`
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`

- [x] **Step 1: Write failing bridge tests**

Add a `bottomInset` render input and assert:

- pre-ready values `132 -> 212 -> 526` inject only the latest inset after any resize and before terminal state;
- a ready WebView injects an inset update immediately; and
- changing the prop leaves `source.html` byte-for-byte unchanged.

- [x] **Step 2: Verify bridge RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/TerminalWebView.test.tsx
```

Expected: FAIL because the prop, script builder, and pending-script kind do not exist.

- [x] **Step 3: Add the script contract**

Export:

```ts
export function buildTerminalBottomInsetScript(bottomInset: number): string {
  return `window.__setTerminalBottomInset(${JSON.stringify({ bottomInset })}); true;`;
}
```

Add `bottom-inset` to `PendingScriptKind`, filter older `__setTerminalBottomInset` scripts, and place the latest after resize but before terminal-state scripts. Seed reloads with resize, inset, then replace. Keep `buildTerminalDocument` memoized only by embedded/fullscreen mode so measurement updates cannot reload it.

- [x] **Step 4: Verify bridge GREEN**

Run the focused `TerminalWebView` test and confirm all cases pass.

### Task 4: Fix the real xterm layout and follow boundaries

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`

- [x] **Step 1: Correct the narrow stub and write failing behavior tests**

Model the bundled hierarchy with an empty legacy `.xterm-viewport` sibling and `.xterm-screen` inside `.xterm-scrollable-element`. Give `StubTerminal` public `buffer.active.baseY/viewportY`, `dimensions.css.cell.height`, `onScroll`, and `scrollToLine` behavior. Assert generated code uses `term.onScroll`, never binds native scroll to `.xterm-viewport`, and exposes the inset setter.

Use public stub scrolling to prove append stability and one-row near-bottom resumption. Assert the legacy viewport never receives an inline bottom style.

- [x] **Step 2: Verify generated-document RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts
```

Expected: FAIL because the current document still listens to the legacy node and has no runtime setter.

- [x] **Step 3: Implement public follow state**

Subscribe to `term.onScroll`, calculate distance with `term.buffer.active` and public `term.dimensions.css.cell.height`, and delete the `.xterm-viewport` scroll listener/style path. Retain the 24 px threshold and capture `shouldStick` before writes.

- [x] **Step 4: Implement the Kanna-owned safe region**

Keep a mutable, clamped bottom inset. `__setTerminalBottomInset` updates `#viewport.style.paddingBottom`, records `data-kanna-bottom-inset`, calls `fitTerminal`, and aligns `#viewport.scrollTop` to `scrollHeight - clientHeight`. Repeat alignment on the next animation frame so pinned-grid render completion cannot expose rows beneath the obstruction. Do not change `viewportY` while follow mode is off.

- [x] **Step 5: Verify unit and browser GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts src/screens/TerminalWebView.test.tsx src/screens/TaskScreen.test.tsx src/screens/terminalSafeArea.test.ts
pnpm --filter @kanna/tui-fidelity test:terminal-safe-region
```

Expected: all focused unit tests and the real Chromium regression pass.

### Task 5: Document the integration boundary and verify the repository

**Files:**
- Modify: `apps/mobile/e2e/terminal-streaming-coverage.md`
- Modify: `tests/tui-fidelity/README.md`
- Modify: the design and plan documents for checked completion state

- [x] **Step 1: Update coverage documentation**

Replace `.xterm-viewport.scrollTop` with the public xterm buffer contract. Document why current Appium cannot provide a deterministic controlled-PTY gesture test, what server fixture/cross-context helper would make it feasible, and how the bundled-xterm Chromium test substitutes at the risky runtime boundary.

- [x] **Step 2: Run focused mobile checks**

```bash
pnpm --dir apps/mobile test -- src/screens/buildTerminalDocument.test.ts src/screens/TerminalWebView.test.tsx src/screens/TaskScreen.test.tsx
pnpm --dir apps/mobile run typecheck
pnpm --dir apps/mobile test
```

- [x] **Step 3: Run integration and repository checks**

```bash
pnpm --filter @kanna/tui-fidelity test:terminal-safe-region
pnpm --filter @kanna/tui-fidelity typecheck
pnpm test
cd crates/daemon && cargo test -- --test-threads=1
```

- [x] **Step 4: Inspect scope**

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
git diff --stat
```

Expected: no whitespace errors, no generated/native dependency changes, and only the safe-region implementation, tests, and coverage docs are dirty relative to the revision base.
