# Context-Dependent Shortcut Help Menu

## Problem

The current `⌘/` shortcut modal shows all 18 shortcuts at once, grouped by category. Users in a specific context (diff viewer, file viewer) see shortcuts that aren't relevant and miss context-specific keys that aren't in the global list (e.g., Space to cycle diff scope). This makes it harder to learn the app incrementally.

## Solution

Make `⌘/` context-aware. When pressed, it shows only the shortcuts relevant to the current view. A toggle link switches to the full shortcut list.

## Design

### Context Tracking

A new `useShortcutContext` composable manages which context is active:

```typescript
// composables/useShortcutContext.ts
type ShortcutContext = "main" | "diff" | "file";

const activeContext = ref<ShortcutContext>("main");

function useShortcutContext(ctx: ShortcutContext) {
  onMounted(() => activeContext.value = ctx);
  onUnmounted(() => activeContext.value = "main");
}
```

- `"main"` is the default when no modal/overlay is active.
- `DiffModal` calls `useShortcutContext("diff")` on mount (modal-level, not DiffView, since DiffView is a reusable component).
- `FilePreviewModal` calls `useShortcutContext("file")` on mount.
- When those components unmount, context falls back to `"main"`.

### Shortcut Tagging

The existing `ShortcutDef` interface gains an optional `context` field:

```typescript
interface ShortcutDef {
  // ... existing fields ...
  /** Which contexts this shortcut appears in. Undefined = all contexts. */
  context?: ShortcutContext[];
}
```

**Global shortcut assignments:**

| Shortcut | Contexts |
|----------|----------|
| `⇧⌘N` New Task | `main` |
| `⌘P` File Picker | `main` |
| `⌘O` Open in IDE | `main` |
| `⌘S` Make PR | `main` |
| `⇧⌘M` Merge Queue | `main` |
| `⌘⌫` Close/Reject | `main` |
| `⌘Z` Undo Close | `main` |
| `⌥⌘↓` Next Task | `main` |
| `⌥⌘↑` Previous Task | `main` |
| `⇧⌘Z` Zen Mode | `main` |
| `⌘J` Shell Terminal | `main` |
| `⌘D` View Diff | `main` |
| `⌘/` Keyboard Shortcuts | _(all — no tag)_ |
| `⇧⌘P` Command Palette | _(all — no tag)_ |
| `⇧⌘Enter` Maximize | `diff` |
| `Escape` Dismiss | _(all — no tag)_ |

### Supplementary Context Shortcuts

Components register local shortcuts that only exist within their context:

```typescript
interface ContextShortcut {
  label: string;
  display: string;
}

function registerContextShortcuts(ctx: ShortcutContext, extras: ContextShortcut[]) {
  // Stored in a reactive map, keyed by context
  // Internally calls onUnmounted() to remove entries — must be called during component setup
}
```

`registerContextShortcuts` must be called during Vue component `setup()` so the automatic cleanup hook registers correctly.

**Supplementary shortcuts by context:**

| Shortcut | Context | Source Component |
|----------|---------|------------------|
| `Space` Cycle Scope | `diff` | DiffView.vue |
| `Space` Toggle Markdown (markdown files only) | `file` | FilePreviewModal.vue |
| `⌘O` Open in IDE | `file` | FilePreviewModal.vue (local handler opens specific file, not worktree) |

### Modal UI

The existing `KeyboardShortcutsModal` is reworked to support two modes:

**Context mode (default on open):**
- Shows only shortcuts for the active context.
- Title reflects context: "Main Shortcuts", "Diff Viewer Shortcuts", "File Viewer Shortcuts".
- Flat list, no group headers (context already narrows the set).
- Footer link: "Show all shortcuts" to toggle to full mode.

**Full mode (toggled):**
- Same as current modal — all shortcuts grouped by category.
- Footer link: "Show [context] shortcuts" to toggle back.
- "Don't show on startup" checkbox stays in full mode only.

**Interaction:**
- `⌘/` toggles the modal open/closed.
- `Escape` closes.
- Backdrop click closes.
- Defaults to context mode each time it opens.
- The modal snapshots `activeContext` at open time and does not reactively update. If the underlying context component unmounts while the shortcuts modal is visible, the modal continues showing the snapshotted context's shortcuts.

**`⌘/` while another modal is open:**
Pressing `⌘/` while another modal (e.g., command palette, file picker) is open closes the current modal first via the existing dismiss priority chain, then opens the shortcuts modal. This follows the app's single-modal-at-a-time convention.

### Data Flow

```
App starts → activeContext = "main"

User opens diff (⌘D):
  → DiffModal mounts → useShortcutContext("diff") → activeContext = "diff"
  → DiffView mounts → registerContextShortcuts("diff", [{ label: "Cycle Scope", display: "Space" }])

User presses ⌘/:
  → Handler fires "showShortcuts"
  → Modal opens, snapshots activeContext → "diff"
  → getContextShortcuts("diff") returns: { keys: string; action: string }[]
      - Global shortcuts tagged with "diff" (Maximize, Escape, ⌘/, ⇧⌘P)
      - Supplementary shortcuts from DiffView (Space)
  → Renders "Diff Viewer Shortcuts"

User clicks "Show all shortcuts":
  → Modal switches to full mode, shows all groups

User closes diff:
  → DiffView unmounts → activeContext = "main"
  → Supplementary "diff" shortcuts auto-cleared
```

## Files to Modify

- `apps/desktop/src/composables/useShortcutContext.ts` — **new** composable
- `apps/desktop/src/composables/useKeyboardShortcuts.ts` — add `context` field to `ShortcutDef`, tag shortcuts, add `getContextShortcuts()` export
- `apps/desktop/src/components/KeyboardShortcutsModal.vue` — context/full mode toggle, read active context
- `apps/desktop/src/components/DiffModal.vue` — call `useShortcutContext("diff")`
- `apps/desktop/src/components/DiffView.vue` — register Space shortcut via `registerContextShortcuts`
- `apps/desktop/src/components/FilePreviewModal.vue` — call `useShortcutContext("file")`, register Space and ⌘O shortcuts
- `apps/desktop/src/App.vue` — update `showShortcuts` action to toggle instead of just open

## Non-Goals

- No mouse-action tips, keyboard shortcuts only.
- No new shortcuts invented — only surfacing existing ones contextually.
- No changes to shortcut execution logic — only the display/help modal.
