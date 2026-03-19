# Maximize Toggle (Shift+Cmd+Enter)

## Overview

Add a keyboard shortcut (Shift+Cmd+Enter) that toggles full-window maximization of the currently focused content: the agent terminal, shell terminal, or diff view.

## Behavior

### Shortcut

- **Key**: Shift+Cmd+Enter
- **Action**: `toggleMaximize`
- **Group**: Window
- Registered in `useKeyboardShortcuts.ts` alongside existing shortcuts

### What Gets Maximized

The shortcut operates on the **topmost visible layer**, checked in this order:

1. If the diff modal is open → toggle `diffMaximized`
2. Else if the shell modal is open → toggle `shellMaximized`
3. Else → toggle `agentMaximized`

### Per-Context State

Three independent booleans in App.vue:

- `agentMaximized` — for the inline agent terminal in MainPanel
- `shellMaximized` — for the shell modal
- `diffMaximized` — for the diff modal

Each resets to `false` when its corresponding view closes.

### Visual Effect

**Agent terminal maximized (`agentMaximized: true`):**
- Sidebar: hidden (`display: none`)
- TaskHeader: hidden
- ActionBar: hidden
- TerminalTabs fills the entire app window

**Shell modal maximized (`shellMaximized: true`):**
- Modal goes from 90vw x 80vh centered with border-radius to full-bleed (`inset: 0; width: 100vw; height: 100vh; border-radius: 0`)

**Diff modal maximized (`diffMaximized: true`):**
- Same as shell modal — full-bleed, no chrome

### Layering

Maximize state is per-layer, not global. The agent terminal can remain maximized underneath while a modal opens at normal size on top.

Example flow:
1. Agent terminal maximized
2. User presses Cmd+D → diff opens at **normal** size over the maximized agent
3. User presses Shift+Cmd+Enter → diff becomes maximized
4. User presses Shift+Cmd+Enter → diff returns to normal size (agent still maximized)
5. User closes diff → back to maximized agent terminal

### Un-maximize

- **Only** Shift+Cmd+Enter toggles maximize off
- Escape does **not** interact with maximize state
- Closing a modal (e.g., Cmd+D to toggle diff off) resets that modal's maximized boolean

### Edge Cases

- **Zen mode**: Independent of maximize. Both can be true simultaneously — maximize is a visual superset of zen mode (hides sidebar + header + action bar vs just sidebar). No conflict.
- **Terminal refit**: The existing ResizeObserver + FitAddon in TerminalView.vue automatically calls `fit()` when container size changes. No extra work needed.
- **Existing shortcuts unaffected**: Cmd+D, Cmd+J, Escape, etc. all work normally regardless of maximize state.

## Files to Modify

1. **`apps/desktop/src/composables/useKeyboardShortcuts.ts`** — Add `toggleMaximize` shortcut definition
2. **`apps/desktop/src/App.vue`** — Add three maximize refs, shortcut handler, pass state to children, CSS for `agentMaximized` hiding sidebar
3. **`apps/desktop/src/components/MainPanel.vue`** — Accept `agentMaximized` prop, hide TaskHeader and ActionBar when true
4. **`apps/desktop/src/components/DiffModal.vue`** — Accept `maximized` prop, apply full-bleed CSS when true
5. **`apps/desktop/src/components/ShellModal.vue`** — Accept `maximized` prop, apply full-bleed CSS when true

## Approach

CSS class-based approach mirroring existing zen mode pattern. One reactive boolean per context, CSS classes toggle visibility of chrome elements. No DOM restructuring, no teleportation, no new components.
