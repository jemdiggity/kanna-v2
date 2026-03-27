# Terminal File Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cmd+clickable file path links to terminal output that open files in the preview modal, scrolled to the referenced line.

**Architecture:** Register a custom `ILinkProvider` via xterm.js `registerLinkProvider()` in the `useTerminal` composable. The provider regex-matches relative file paths, validates existence via `file_exists` Tauri command with caching, and on Cmd+click dispatches a DOM event that App.vue catches to open `FilePreviewModal`. The modal gains an `initialLine` prop for scroll-to-line + highlight animation.

**Tech Stack:** xterm.js 6.x `ILinkProvider` API, Vue 3 props/events, Tauri `file_exists` command, shiki transformer for line tagging, CSS keyframes.

**Spec:** `docs/superpowers/specs/2026-03-27-terminal-file-links-design.md`

---

### Task 1: File Link Provider in useTerminal

**Goal:** Register a custom link provider that detects relative file paths in terminal output, validates them on hover, and activates on Cmd+click.

**Files:**
- Modify: `apps/desktop/src/composables/useTerminal.ts`
- Modify: `apps/desktop/src/tauri-mock.ts:209` (verify `file_exists` mock exists — it does)

**Acceptance Criteria:**
- [ ] Relative paths with extensions and at least one `/` are detected (e.g., `src/utils/foo.ts`, `docs/spec.md:42`)
- [ ] Paths are validated via `file_exists` before being offered as links
- [ ] Validation results are cached per terminal instance
- [ ] Only Cmd+click activates the link (bare click does nothing)
- [ ] A `file-link-activate` CustomEvent with `{ path, line }` is dispatched on the terminal container
- [ ] Tooltip shows "Open preview (Cmd+click)" on hover
- [ ] Link provider is only registered when `worktreePath` is provided
- [ ] Cache is cleared on dispose

**Verify:** Start the dev server, open a task terminal, have the agent output a file path. Hover over it — should underline and show tooltip. Cmd+click should dispatch the event (check via browser devtools event listener).

**Steps:**

- [ ] **Step 1: Add `worktreePath` to `TerminalOptions`**

In `apps/desktop/src/composables/useTerminal.ts`, update the `TerminalOptions` interface:

```typescript
export interface TerminalOptions {
  kittyKeyboard?: boolean
  worktreePath?: string
}
```

Access via `options?.worktreePath` — no change to the function signature shape.

- [ ] **Step 2: Add the file path regex, parser, and validation cache**

After the existing `handleLinkActivate` function (line ~38), add:

```typescript
// --- File link provider ---
const FILE_PATH_RE = /(?:^|[\s"'`(])([a-zA-Z0-9_.\-][\w.\-/]*\/[\w.\-/]*\.[a-zA-Z0-9]+(?::\d+)?)/g
const fileExistsCache = new Map<string, boolean>()

function parseFileLink(raw: string): { path: string; line?: number } {
  const colonIdx = raw.lastIndexOf(":")
  if (colonIdx > 0) {
    const maybeLine = raw.slice(colonIdx + 1)
    if (/^\d+$/.test(maybeLine)) {
      return { path: raw.slice(0, colonIdx), line: parseInt(maybeLine, 10) }
    }
  }
  return { path: raw }
}

async function checkFileExists(relativePath: string): Promise<boolean> {
  const worktreePath = options?.worktreePath
  if (!worktreePath) return false
  if (fileExistsCache.has(relativePath)) return fileExistsCache.get(relativePath)!
  try {
    const exists = await invoke<boolean>("file_exists", { path: `${worktreePath}/${relativePath}` })
    fileExistsCache.set(relativePath, exists)
    return exists
  } catch {
    fileExistsCache.set(relativePath, false)
    return false
  }
}
```

- [ ] **Step 3: Add the `ILink` import**

At the top of the file, update the xterm import:

```typescript
import { Terminal, type ILink } from "@xterm/xterm"
```

- [ ] **Step 4: Register the link provider in `init()`**

After `term.loadAddon(new ImageAddon())` (line ~85), add the link provider registration. Only register when `worktreePath` is provided:

```typescript
if (options?.worktreePath) {
  let tooltipEl: HTMLElement | null = null

  term.registerLinkProvider({
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const line = term.buffer.active.getLine(bufferLineNumber)
      if (!line) { callback(undefined); return }
      const lineText = line.translateToString(true)

      const matches: { text: string; start: number; path: string }[] = []
      FILE_PATH_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FILE_PATH_RE.exec(lineText)) !== null) {
        const fullMatch = m[0]
        const pathMatch = m[1]
        const startOffset = m.index + (fullMatch.length - pathMatch.length)
        const { path } = parseFileLink(pathMatch)
        matches.push({ text: pathMatch, start: startOffset, path })
      }

      if (matches.length === 0) { callback(undefined); return }

      Promise.all(matches.map(async (match) => {
        const exists = await checkFileExists(match.path)
        if (!exists) return null
        const link: ILink = {
          range: {
            start: { x: match.start + 1, y: bufferLineNumber },
            end: { x: match.start + match.text.length + 1, y: bufferLineNumber },
          },
          text: match.text,
          activate(event: MouseEvent) {
            if (!event.metaKey) return
            const { path, line } = parseFileLink(match.text)
            container?.dispatchEvent(new CustomEvent("file-link-activate", {
              bubbles: true,
              detail: { path, line },
            }))
          },
          hover(event: MouseEvent) {
            if (!term.element) return
            tooltipEl = document.createElement("div")
            tooltipEl.className = "xterm-hover"
            tooltipEl.textContent = "Open preview (\u2318+click)"
            tooltipEl.style.cssText = `
              position: fixed;
              left: ${event.clientX + 8}px;
              top: ${event.clientY - 28}px;
              background: #252525;
              color: #ccc;
              font-size: 11px;
              padding: 2px 6px;
              border-radius: 3px;
              border: 1px solid #444;
              pointer-events: none;
              z-index: 10000;
              font-family: "SF Mono", Menlo, monospace;
            `
            term.element.appendChild(tooltipEl)
          },
          leave() {
            tooltipEl?.remove()
            tooltipEl = null
          },
        }
        return link
      })).then((links) => {
        const valid = links.filter((l): l is ILink => l !== null)
        callback(valid.length > 0 ? valid : undefined)
      })
    },
  })
}
```

- [ ] **Step 5: Clear cache on dispose**

In the `dispose()` function, add `fileExistsCache.clear()` as the first line after `attached = false`:

```typescript
function dispose() {
  attached = false
  fileExistsCache.clear()
  if (fitRafId) cancelAnimationFrame(fitRafId)
  if (unlistenOutput) unlistenOutput()
  if (unlistenExit) unlistenExit()
  terminal.value?.dispose()
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/composables/useTerminal.ts
git commit -m "feat: add file link provider to terminal composable"
```

---

### Task 2: Thread worktreePath Through Components

**Goal:** Pass `worktreePath` from TerminalTabs through TerminalView to `useTerminal` so the file link provider has context.

**Files:**
- Modify: `apps/desktop/src/components/TerminalView.vue`
- Modify: `apps/desktop/src/components/TerminalTabs.vue`

**Acceptance Criteria:**
- [ ] TerminalView accepts a `worktreePath` prop
- [ ] TerminalView passes it to `useTerminal` via `options.worktreePath`
- [ ] TerminalTabs passes `worktreePath` from the session config to TerminalView

**Verify:** `cd apps/desktop && bun tsc --noEmit` passes with no type errors.

**Steps:**

- [ ] **Step 1: Add `worktreePath` prop to TerminalView**

In `apps/desktop/src/components/TerminalView.vue`, update the props:

```typescript
const props = defineProps<{
  sessionId: string
  spawnOptions?: SpawnOptions
  kittyKeyboard?: boolean
  worktreePath?: string
}>()
```

Update the `useTerminal` call to pass it through options:

```typescript
const { terminal, init, startListening, fit, fitDeferred, redraw, dispose } = useTerminal(
  props.sessionId,
  props.spawnOptions,
  { kittyKeyboard: props.kittyKeyboard, worktreePath: props.worktreePath },
)
```

- [ ] **Step 2: Pass `worktreePath` in TerminalTabs template**

In `apps/desktop/src/components/TerminalTabs.vue`, add the `:worktree-path` binding to the `TerminalView` component:

```html
<TerminalView
  v-for="[sid, config] of visitedPtySessions"
  v-show="sid === sessionId"
  :key="sid"
  :ref="(el: any) => setTermRef(sid, el)"
  :session-id="sid"
  :worktree-path="config.worktreePath"
  :spawn-options="spawnPtySession && config.worktreePath && config.prompt ? {
    cwd: config.worktreePath,
    prompt: config.prompt,
    spawnFn: spawnPtySession,
  } : undefined"
  :kitty-keyboard="!!(spawnPtySession && config.worktreePath && config.prompt)"
/>
```

This works because `PtySessionConfig` already stores `worktreePath` (set on line 37 of TerminalTabs.vue when the session is first visited).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/TerminalView.vue apps/desktop/src/components/TerminalTabs.vue
git commit -m "feat: thread worktreePath to terminal for file link resolution"
```

---

### Task 3: Wire Up App.vue to Open File Preview from Terminal Links

**Goal:** Catch the `file-link-activate` event from the terminal and open the file preview modal at the indicated line.

**Files:**
- Modify: `apps/desktop/src/App.vue`

**Acceptance Criteria:**
- [ ] `file-link-activate` event opens the file preview modal with the correct path
- [ ] `previewInitialLine` is set from the event's line number (or undefined)
- [ ] `initialLine` prop is passed to FilePreviewModal
- [ ] Opening preview from file picker or tree explorer clears `initialLine`

**Verify:** Start the dev server, Cmd+click a file path in the terminal — file preview modal opens.

**Steps:**

- [ ] **Step 1: Add `previewInitialLine` ref**

In `apps/desktop/src/App.vue`, after the `previewFilePath` ref (line ~58), add:

```typescript
const previewInitialLine = ref<number | undefined>(undefined);
```

- [ ] **Step 2: Add event listener in `onMounted`**

In the `onMounted` block, add the DOM event listener:

```typescript
document.addEventListener("file-link-activate", (e: Event) => {
  const detail = (e as CustomEvent).detail as { path: string; line?: number };
  previewFilePath.value = detail.path;
  previewInitialLine.value = detail.line;
  showFilePreviewModal.value = true;
});
```

- [ ] **Step 3: Clear initialLine when preview is opened from other sources**

Update the file picker `@select` handler (line ~714):

```typescript
@select="(f: string) => { showFilePickerModal = false; previewFilePath = f; previewInitialLine = undefined; showFilePreviewModal = true; }"
```

Update the tree explorer `@open-file` handler (line ~723):

```typescript
@open-file="(f: string) => { previewFilePath = f; previewInitialLine = undefined; showFilePreviewModal = true; }"
```

- [ ] **Step 4: Pass `initialLine` to FilePreviewModal**

Update the FilePreviewModal usage (line ~725):

```html
<FilePreviewModal
  ref="filePreviewRef"
  v-if="showFilePreviewModal && store.selectedRepo?.path"
  :file-path="previewFilePath"
  :worktree-path="activeWorktreePath"
  :ide-command="store.ideCommand"
  :initial-line="previewInitialLine"
  :maximized="maximizedModal === 'file'"
  @close="showFilePreviewModal = false; maximizedModal = null"
/>
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat: wire file-link-activate event to file preview modal"
```

---

### Task 4: Scroll-to-Line and Highlight in FilePreviewModal

**Goal:** When `initialLine` is provided, scroll the file preview to that line and briefly highlight it.

**Files:**
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`

**Acceptance Criteria:**
- [ ] `initialLine` prop is accepted
- [ ] After content loads, view scrolls to center the target line
- [ ] Target line gets a highlight animation (fade from yellow-ish to transparent over 1.5s)
- [ ] Lines are tagged with `data-line` attributes via shiki transformer
- [ ] When `initialLine` is not provided, behavior is unchanged
- [ ] Line numbers are auto-enabled when `initialLine` is provided

**Verify:** Open file preview with `initialLine=42` — view scrolls to line 42, which flashes briefly.

**Steps:**

- [ ] **Step 1: Add `initialLine` prop**

In `apps/desktop/src/components/FilePreviewModal.vue`, update the props interface:

```typescript
const props = defineProps<{
  filePath: string;
  worktreePath: string;
  ideCommand?: string;
  initialLine?: number;
}>();
```

- [ ] **Step 2: Add shiki transformer to tag lines with `data-line`**

In the `loadFile()` function, update the shiki `codeToHtml` transformers array (around line 156). Add a `line` transformer alongside the existing `pre` transformer:

```typescript
highlighted.value = hl.codeToHtml(content.value, {
  lang: useLang,
  theme: "github-dark",
  transformers: [{
    pre(node: any) {
      node.properties.style = "white-space:pre-wrap;word-wrap:break-word;";
    },
    line(node: any, lineNumber: number) {
      node.properties["data-line"] = lineNumber;
    },
  }],
});
```

- [ ] **Step 3: Add scroll-to-line watcher**

After the `loadFile` function, add a watcher that fires once content is loaded:

```typescript
let scrolledToLine = false;

watch([loading, highlighted], async ([isLoading]) => {
  if (isLoading || !props.initialLine || scrolledToLine) return;
  scrolledToLine = true;

  showLineNumbers.value = true;

  await nextTick();
  const el = contentRef.value?.querySelector(`[data-line="${props.initialLine}"]`) as HTMLElement | null;
  if (!el) return;

  const scrollContainer = contentRef.value!;
  const lineTop = el.offsetTop;
  const containerHeight = scrollContainer.clientHeight;
  scrollContainer.scrollTop = lineTop - containerHeight / 2;

  el.classList.add("line-highlight-flash");
});
```

- [ ] **Step 4: Add CSS for the highlight animation**

In the `<style scoped>` section, add:

```css
:deep(.line-highlight-flash) {
  animation: line-flash 1.5s ease-out;
}

@keyframes line-flash {
  0% { background-color: rgba(255, 255, 150, 0.15); }
  100% { background-color: transparent; }
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/FilePreviewModal.vue
git commit -m "feat: scroll to initial line with highlight in file preview"
```

---

### Task 5: Type Check and Final Verification

**Goal:** Run type checks and fix any issues across all changed files.

**Files:**
- No new files — fix any type errors in previously modified files

**Acceptance Criteria:**
- [ ] `bun tsc --noEmit` passes with no errors in `apps/desktop`
- [ ] HTTP/HTTPS links still work as before (WebLinksAddon untouched)
- [ ] Shell modal terminals are unaffected (no `worktreePath` passed)

**Verify:** `cd apps/desktop && bun tsc --noEmit`

**Steps:**

- [ ] **Step 1: Run type check**

```bash
cd apps/desktop && bun tsc --noEmit
```

Fix any type errors.

- [ ] **Step 2: Commit fixes if needed**

```bash
git add -u
git commit -m "fix: address type errors for terminal file links"
```
