# Latest Terminal File Link Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `⌘L` to open the newest valid file path in the selected local PTY terminal and teach it with a once-per-install info toast.

**Architecture:** Extend the existing xterm file-link provider with a newest-first buffer scan and keep activation routed through the existing file/image events. Register each provider in a session-scoped frontend registry so the centralized keyboard action can target the selected task. A small hint module owns the versioned local-storage flag while the terminal emits only a generic availability event.

**Tech Stack:** Vue 3, TypeScript, Vitest, xterm.js, Pinia, vue-i18n

**Task environment:** This Kanna stage already runs in an isolated task worktree. Leave implementation changes uncommitted because the pipeline owns the later implementation commit.

---

### Task 1: Newest-first terminal file-link scanning

**Files:**
- Modify: `apps/desktop/src/composables/terminalFileLinks.test.ts`
- Modify: `apps/desktop/src/composables/terminalFileLinks.ts`

- [ ] **Step 1: Write failing provider tests**

Extend the terminal stub to accept multiple zero-based buffer rows. Add these behaviors:

```ts
it("activates the rightmost valid file on the newest matching row", async () => {
  invokeMock.mockImplementation(async (_command: string, args: { path: string }) =>
    ["/worktree/older.ts", "/worktree/newer.ts"].includes(args.path),
  )
  const { container, provider } = createProviderForLines([
    "Changed older.ts",
    "Summary: missing.ts then newer.ts:41:7",
  ])
  const activation = waitForFileLinkActivation(container)
  await expect(provider.activateLatest()).resolves.toBe(true)
  await expect(activation).resolves.toEqual({ path: "newer.ts", line: 41 })
})

it("skips missing recent candidates and rejects traversal", async () => {
  invokeMock.mockImplementation(async (_command: string, args: { path: string }) =>
    args.path === "/worktree/safe.ts",
  )
  const { provider } = createProviderForLines([
    "Use safe.ts",
    "Ignore missing.ts and ../outside.ts",
  ])
  await expect(provider.findLatest()).resolves.toMatchObject({
    previewPath: "safe.ts",
    checkPath: "/worktree/safe.ts",
  })
})

it("activates the newest image through the image event", async () => {
  invokeMock.mockResolvedValue(true)
  const { container, provider } = createProviderForLines(["See result.png"])
  const activation = waitForImageLinkActivation(container)
  await expect(provider.activateLatest()).resolves.toBe(true)
  await expect(activation).resolves.toEqual({ url: "/worktree/result.png" })
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/terminalFileLinks.test.ts`

Expected: FAIL because `findLatest`, `activateLatest`, and the multi-row helper do not exist.

- [ ] **Step 3: Implement shared detection and newest-first scanning**

Expose:

```ts
export interface ResolvedTerminalFileLink {
  text: string
  start: number
  checkPath: string
  previewPath: string
  line?: number
  image: boolean
}

export interface TerminalFileLinkProvider {
  register(): void
  findLatest(): Promise<ResolvedTerminalFileLink | null>
  activateLatest(): Promise<boolean>
  clearFileExistsCache(): void
}
```

Extract `detectLineLinks(lineText, worktreePath)` from `provideLinks`. Reject relative paths containing a `..` segment. Implement `findLatest` with `buffer.getLine(row)` from `buffer.length - 1` to `0`, checking each row's matches right-to-left and returning the first candidate whose `checkPath` exists. Extract current event dispatch into `activateResolvedLink`; both Cmd+click and `activateLatest` call it.

- [ ] **Step 4: Run the provider tests and verify GREEN**

Run the Task 1 command again. Expected: all tests PASS.

### Task 2: Session-scoped activation registry

**Files:**
- Create: `apps/desktop/src/composables/terminalFileLinkRegistry.test.ts`
- Create: `apps/desktop/src/composables/terminalFileLinkRegistry.ts`
- Modify: `apps/desktop/src/composables/terminalView.ts`
- Modify: `apps/desktop/src/composables/terminalDisposal.ts`

- [ ] **Step 1: Write failing registry tests**

```ts
afterEach(clearTerminalFileLinkRegistryForTests)

it("opens through the provider registered for a session", async () => {
  const activateLatest = vi.fn(async () => true)
  registerTerminalFileLinkProvider("task-1", { activateLatest })
  await expect(openLatestTerminalFileLink("task-1")).resolves.toBe(true)
})

it("does not let stale cleanup remove a replacement", async () => {
  const cleanup = registerTerminalFileLinkProvider("task-1", {
    activateLatest: vi.fn(async () => false),
  })
  const replacement = vi.fn(async () => true)
  registerTerminalFileLinkProvider("task-1", { activateLatest: replacement })
  cleanup()
  await expect(openLatestTerminalFileLink("task-1")).resolves.toBe(true)
  expect(replacement).toHaveBeenCalledOnce()
})

it("returns false without a provider", async () => {
  await expect(openLatestTerminalFileLink("missing")).resolves.toBe(false)
})
```

- [ ] **Step 2: Run registry test and verify RED**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/terminalFileLinkRegistry.test.ts`

Expected: FAIL because the registry module does not exist.

- [ ] **Step 3: Implement registry and terminal lifetime integration**

Create this API backed by `Map<string, RegisteredTerminalFileLinkProvider>`:

```ts
export interface RegisteredTerminalFileLinkProvider {
  activateLatest(): Promise<boolean>
}
export function registerTerminalFileLinkProvider(
  sessionId: string,
  provider: RegisteredTerminalFileLinkProvider,
): () => void
export async function openLatestTerminalFileLink(sessionId: string): Promise<boolean>
export function clearTerminalFileLinkRegistryForTests(): void
```

Cleanup deletes only if the stored provider is the same object. In `terminalView.ts`, register local agent-terminal providers after `fileLinkProvider.register()`. Add cleanup fields to `InitializedTerminalView` and call them from `terminalDisposal.ts` before clearing the cache.

- [ ] **Step 4: Verify registry and lifecycle**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/terminalFileLinkRegistry.test.ts src/composables/useTerminal.test.ts`

Expected: all tests PASS.

### Task 3: Once-per-install discovery hint

**Files:**
- Create: `apps/desktop/src/composables/terminalFileLinkHint.test.ts`
- Create: `apps/desktop/src/composables/terminalFileLinkHint.ts`
- Modify: `apps/desktop/src/composables/terminalFileLinks.test.ts`
- Modify: `apps/desktop/src/composables/terminalFileLinks.ts`
- Modify: `apps/desktop/src/composables/terminalView.ts`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`

- [ ] **Step 1: Write failing hint-policy tests**

```ts
beforeEach(() => localStorage.clear())

it("stores the version before showing the toast", () => {
  const info = vi.fn(() => {
    expect(localStorage.getItem(FILE_LINK_HINT_STORAGE_KEY)).toBe("1")
  })
  expect(showTerminalFileLinkHintOnce(localStorage, info, "hint")).toBe(true)
  expect(info).toHaveBeenCalledWith("hint")
})

it("suppresses later availability events", () => {
  const info = vi.fn()
  showTerminalFileLinkHintOnce(localStorage, info, "hint")
  expect(showTerminalFileLinkHintOnce(localStorage, info, "hint")).toBe(false)
  expect(info).toHaveBeenCalledTimes(1)
})
```

Also extend the provider stub with an `onWriteParsed` callback and prove that `watchForFirstLink` invokes its callback once after a valid link is parsed, then ignores later parsed writes:

```ts
it("announces only the first parsed valid link", async () => {
  vi.useFakeTimers()
  invokeMock.mockResolvedValue(true)
  const { provider, fireWriteParsed } = createProviderForLines(["See result.ts"])
  const onAvailable = vi.fn()
  const cleanup = provider.watchForFirstLink(onAvailable)
  fireWriteParsed()
  await vi.runAllTimersAsync()
  expect(onAvailable).toHaveBeenCalledOnce()
  fireWriteParsed()
  await vi.runAllTimersAsync()
  expect(onAvailable).toHaveBeenCalledOnce()
  cleanup()
  vi.useRealTimers()
})
```

- [ ] **Step 2: Run hint test and verify RED**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/terminalFileLinkHint.test.ts`

Expected: FAIL because the hint module does not exist.

- [ ] **Step 3: Implement hint policy and availability event**

```ts
export const FILE_LINK_HINT_STORAGE_KEY = "kanna:terminal-file-link-shortcut-hint:v1"

export function showTerminalFileLinkHintOnce(
  storage: Storage,
  info: (message: string) => void,
  message: string,
): boolean {
  if (storage.getItem(FILE_LINK_HINT_STORAGE_KEY) === "1") return false
  storage.setItem(FILE_LINK_HINT_STORAGE_KEY, "1")
  info(message)
  return true
}
```

Implement `watchForFirstLink` with `term.onWriteParsed`, a short debounce, `findLatest`, and disposal guards. It stops permanently after the first valid candidate. `terminalView.ts` dispatches `terminal-file-link-available` from the container and owns the watcher cleanup. `useAppLifecycle.ts` listens on `document`, calls `showTerminalFileLinkHintOnce(window.localStorage, toast.info, i18n.global.t("toasts.latestAgentFileHint"))`, and removes the listener on unmount.

Add `watchForFirstLink(onAvailable: () => void): () => void` to `TerminalFileLinkProvider` in this task.

- [ ] **Step 4: Verify hint flow**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/terminalFileLinkHint.test.ts src/composables/terminalFileLinks.test.ts src/App.test.ts`

Expected: all selected tests PASS.

### Task 4: `⌘L`, command palette, help, and messages

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.test.ts`
- Modify: `apps/desktop/src/composables/useShortcutContext.test.ts`
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts`
- Modify: `apps/desktop/src/composables/useShortcutContext.ts`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`

- [ ] **Step 1: Write failing shortcut and action tests**

```ts
it("maps Command+L to the latest agent file action", () => {
  const shortcut = shortcuts.find((entry) => entry.action === "openLatestFileLink")
  expect(shortcut).toMatchObject({ key: "l", meta: true, display: "⌘L" })
})
```

Include `openLatestFileLink` in expected action/context lists. In `App.test.ts`, mock `openLatestTerminalFileLink`, call `capturedKeyboardActions?.openLatestFileLink()`, verify it receives the selected task id, and add a false-result case expecting the translated no-link info toast.

- [ ] **Step 2: Run shortcut/App tests and verify RED**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/useKeyboardShortcuts.test.ts src/composables/useShortcutContext.test.ts src/App.test.ts`

Expected: FAIL because the action is not defined.

- [ ] **Step 3: Implement shortcut and app action**

Add `"openLatestFileLink"` to `ActionName` and this shortcut beside the picker:

```ts
{
  action: "openLatestFileLink",
  labelKey: "shortcuts.openLatestAgentFile",
  groupKey: "shortcuts.groupOpenInspect",
  key: "l",
  meta: true,
  display: "⌘L",
  context: PREVIEW_MODAL_CONTEXTS,
}
```

Add it to preview-context shortcut help. Implement in `useAppKeyboardActions.ts`:

```ts
openLatestFileLink: async () => {
  const sessionId = store.currentItem?.id
  const opened = sessionId ? await openLatestTerminalFileLink(sessionId) : false
  if (!opened) toast.info(t("toasts.noTerminalFileLink"))
},
```

The command palette picks up the static shortcut automatically.

- [ ] **Step 4: Add localized strings**

Add English plus equivalent Japanese/Korean values:

```json
{
  "shortcuts": { "openLatestAgentFile": "Open Latest Agent File" },
  "toasts": {
    "latestAgentFileHint": "Tip: Press ⌘L to open the latest file mentioned by the agent.",
    "noTerminalFileLink": "No file link found in this terminal."
  }
}
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/composables/terminalFileLinks.test.ts src/composables/terminalFileLinkRegistry.test.ts src/composables/terminalFileLinkHint.test.ts src/composables/useKeyboardShortcuts.test.ts src/composables/useShortcutContext.test.ts src/App.test.ts
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: all selected tests PASS and typecheck exits 0.

### Task 5: Final regression verification

**Files:**
- Review all files changed by Tasks 1–4

- [ ] **Step 1: Run complete desktop tests**

Run: `pnpm --dir apps/desktop test`

Expected: the desktop Vitest suite exits 0 with no failing tests.

- [ ] **Step 2: Review whitespace and scope**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: `git diff --check` is silent and the diff contains only the approved feature, tests, locales, spec, and plan.

- [ ] **Step 3: Leave implementation for pipeline commit**

Do not push, create a PR, advance the task, or record stage completion. Report behavior and fresh verification results.
