import { onMounted, onUnmounted } from "vue";
import type { ShortcutContext } from "./useShortcutContext";

export type ActionName =
  | "newTask"
  | "newWindow"
  | "openFile"
  | "makePR"
  | "mergeQueue"
  | "closeTask"
  | "undoClose"
  | "navigateUp"
  | "navigateDown"
  | "toggleZen"
  | "dismiss"
  | "openInIDE"
  | "openShell"
  | "showDiff"
  | "toggleMaximize"
  | "showShortcuts"
  | "showAllShortcuts"
  | "toggleSidebar"
  | "commandPalette"
  | "showAnalytics"
  | "goBack"
  | "goForward"
  | "createRepo"
  | "importRepo"
  | "blockTask"
  | "editBlockedTask"
  | "toggleTreeExplorer";

export type KeyboardActions = Record<ActionName, () => void>;

interface ShortcutDef {
  action: ActionName;
  /** Display label for the shortcuts modal */
  label: string;
  /** Group for the shortcuts modal */
  group: string;
  /** Key(s) that trigger this shortcut (matched against KeyboardEvent.key). Array = any match. */
  key: string | string[];
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  /** Display string for the shortcuts modal (e.g. "Cmd+Delete") */
  display: string;
  /** Which contexts this shortcut appears in. Undefined = all contexts. */
  context?: ShortcutContext[];
  /** Hide from shortcuts modal display */
  hidden?: boolean;
}

/**
 * Single source of truth for all app-level keyboard shortcuts.
 * Used by: keydown handler, terminal passthrough, shortcuts modal.
 */
export const shortcuts: ShortcutDef[] = [
  // Tasks — lifecycle operations
  { action: "newTask",    label: "New Task",          group: "Tasks",      key: ["N", "n"],                     meta: true, shift: true,  display: "⇧⌘N",     context: ["main"] },
  { action: "makePR",     label: "Make PR",           group: "Tasks",      key: "s",                            meta: true, display: "⌘S",                       context: ["main"] },
  { action: "mergeQueue", label: "Merge Queue",       group: "Tasks",      key: ["M", "m"],                     meta: true, shift: true,  display: "⇧⌘M",     context: ["main"] },
  { action: "closeTask",  label: "Close / Reject",    group: "Tasks",      key: ["Backspace", "Delete"],        meta: true,               display: "⌘⌫",       context: ["main"] },
  { action: "undoClose",  label: "Undo Close",        group: "Tasks",      key: ["Z", "z"],                     meta: true,               display: "⌘Z",       context: ["main"] },
  // Navigation — moving between tasks and finding things
  { action: "navigateUp",     label: "Previous Task",    group: "Navigation", key: "ArrowUp",                   meta: true, alt: true,    display: "⌥⌘↑",     context: ["main"] },
  { action: "navigateDown",   label: "Next Task",        group: "Navigation", key: "ArrowDown",                 meta: true, alt: true,    display: "⌥⌘↓",     context: ["main"] },
  { action: "openFile",       label: "File Picker",      group: "Navigation", key: "p",                         meta: true,               display: "⌘P",       context: ["main"] },
  { action: "commandPalette", label: "Command Palette",  group: "Navigation", key: ["P", "p"],                  meta: true, shift: true,  display: "⇧⌘P",     context: ["main", "diff", "file", "shell"] },
  // Views — panels, modes, and display
  { action: "showDiff",       label: "View Diff",        group: "Views",      key: "d",                         meta: true, display: "⌘D",                       context: ["main"] },
  { action: "openShell",      label: "Shell Terminal",   group: "Views",      key: "j",                         meta: true,               display: "⌘J",       context: ["main", "shell"] },
  { action: "openInIDE",      label: "Open in IDE",      group: "Views",      key: "o",                         meta: true,               display: "⌘O",       context: ["main"] },
  { action: "toggleZen",      label: "Zen Mode",         group: "Views",      key: ["Z", "z"],                  meta: true, shift: true,  display: "⇧⌘Z",     context: ["main"] },
  { action: "toggleMaximize", label: "Maximize",         group: "Views",      key: "Enter",                     meta: true, shift: true,  display: "⇧⌘Enter", context: ["diff", "shell"] },
  // Window — disabled until #24 (new window state sharing)
  // { action: "newWindow",  label: "New Window",     group: "Window",     key: ["N", "n"],                     meta: true, shift: true,  display: "⇧⌘N" },
  { action: "toggleSidebar", label: "Toggle Sidebar",  group: "Views",      key: "b",                            meta: true,               display: "⌘B",       context: ["main"] },
  { action: "showAnalytics", label: "Analytics",        group: "Views",      key: ["A", "a"],                     meta: true, shift: true,  display: "⇧⌘A",     context: ["main"] },
  { action: "createRepo",   label: "Create Repo",      group: "Navigation", key: ["I", "i"],                     meta: true,               display: "⌘I",       context: ["main"] },
  { action: "importRepo",   label: "Import / Clone",   group: "Navigation", key: ["I", "i"],                     meta: true, shift: true,  display: "⇧⌘I",     context: ["main"] },
  { action: "goBack",       label: "Go Back",          group: "Navigation", key: "-",                            ctrl: true,               display: "⌃-",       context: ["main"] },
  { action: "goForward",    label: "Go Forward",       group: "Navigation", key: ["_", "-"],                     ctrl: true, shift: true,  display: "⌃⇧-",     context: ["main"] },
  { action: "toggleTreeExplorer", label: "Tree Explorer", group: "Navigation", key: "e", meta: true, shift: true, display: "⇧⌘E", context: ["main", "shell"] },
  // Help — ⇧⌘/ must come before ⌘/ so the more specific shortcut matches first
  { action: "showAllShortcuts", label: "All Shortcuts",      group: "Help",   key: "/",                           meta: true, shift: true,  display: "⇧⌘/",     context: ["main", "diff", "file", "shell"], hidden: true },
  { action: "showShortcuts",  label: "Keyboard Shortcuts", group: "Help",   key: "/",                           meta: true,               display: "⌘/",       context: ["main", "diff", "file", "shell"] },
  // Escape is special — no meta required
  { action: "dismiss",    label: "Dismiss",           group: "Navigation", key: "Escape",                                                 display: "Escape",   context: ["main", "diff", "file", "shell"] },
];

function matches(def: ShortcutDef, e: KeyboardEvent): boolean {
  // Exact modifier match — no extra modifiers allowed
  if (e.metaKey !== (def.meta ?? false)) return false;
  if (e.shiftKey !== (def.shift ?? false)) return false;
  if (e.altKey !== (def.alt ?? false)) return false;
  if (e.ctrlKey !== (def.ctrl ?? false)) return false;
  const keys = Array.isArray(def.key) ? def.key : [def.key];
  return keys.includes(e.key);
}

/**
 * Returns true if the event matches any app-level shortcut.
 * Used by terminal to decide which keys to let bubble up.
 */
export function isAppShortcut(e: KeyboardEvent): boolean {
  return shortcuts.some((def) => matches(def, e));
}

/**
 * Returns shortcut definitions grouped for display in the shortcuts modal.
 */
export function getShortcutGroups(): { title: string; shortcuts: { keys: string; action: string }[] }[] {
  const groupOrder = ["Tasks", "Navigation", "Views", "Help"];
  const map = new Map<string, { keys: string; action: string }[]>();
  for (const def of shortcuts) {
    if (def.hidden) continue;
    if (!map.has(def.group)) map.set(def.group, []);
    map.get(def.group)!.push({ keys: def.display, action: def.label });
  }
  return groupOrder.filter((g) => map.has(g)).map((g) => ({ title: g, shortcuts: map.get(g)! }));
}

export function useKeyboardShortcuts(actions: KeyboardActions, options?: { beforeAction?: (action: ActionName) => void }) {
  function handler(e: KeyboardEvent) {
    for (const def of shortcuts) {
      if (matches(def, e)) {
        if (def.action !== "dismiss") e.preventDefault();
        options?.beforeAction?.(def.action);
        actions[def.action]();
        return;
      }
    }
  }

  onMounted(() => {
    // Capture phase so the centralized dismiss handler fires before
    // per-modal Escape handlers (e.g. DiffModal) and before xterm.
    window.addEventListener("keydown", handler, true);
  });

  onUnmounted(() => {
    window.removeEventListener("keydown", handler, true);
  });
}
