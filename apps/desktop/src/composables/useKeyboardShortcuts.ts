import { onMounted, onUnmounted } from "vue";

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
  | "commandPalette";

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
  /** Display string for the shortcuts modal (e.g. "Cmd+Delete") */
  display: string;
}

/**
 * Single source of truth for all app-level keyboard shortcuts.
 * Used by: keydown handler, terminal passthrough, shortcuts modal.
 */
export const shortcuts: ShortcutDef[] = [
  // Tasks — lifecycle operations
  { action: "newTask",    label: "New Task",          group: "Tasks",      key: ["N", "n"],                     meta: true, shift: true,  display: "⇧⌘N" },
  { action: "makePR",     label: "Make PR",           group: "Tasks",      key: "s",                            meta: true, display: "⌘S" },
  { action: "mergeQueue", label: "Merge Queue",       group: "Tasks",      key: ["M", "m"],                     meta: true, shift: true,  display: "⇧⌘M" },
  { action: "closeTask",  label: "Close / Reject",    group: "Tasks",      key: ["Backspace", "Delete"],        meta: true,               display: "⌘⌫" },
  { action: "undoClose",  label: "Undo Close",        group: "Tasks",      key: ["Z", "z"],                     meta: true,               display: "⌘Z" },
  // Navigation — moving between tasks and finding things
  { action: "navigateUp",     label: "Previous Task",    group: "Navigation", key: "ArrowUp",                   meta: true, alt: true,    display: "⌥⌘↑" },
  { action: "navigateDown",   label: "Next Task",        group: "Navigation", key: "ArrowDown",                 meta: true, alt: true,    display: "⌥⌘↓" },
  { action: "openFile",       label: "File Picker",      group: "Navigation", key: "p",                         meta: true,               display: "⌘P" },
  { action: "commandPalette", label: "Command Palette",  group: "Navigation", key: ["P", "p"],                  meta: true, shift: true,  display: "⇧⌘P" },
  // Views — panels, modes, and display
  { action: "showDiff",       label: "View Diff",        group: "Views",      key: "d",                         meta: true, display: "⌘D" },
  { action: "openShell",      label: "Shell Terminal",   group: "Views",      key: "j",                         meta: true,               display: "⌘J" },
  { action: "openInIDE",      label: "Open in IDE",      group: "Views",      key: "o",                         meta: true,               display: "⌘O" },
  { action: "toggleZen",      label: "Zen Mode",         group: "Views",      key: ["Z", "z"],                  meta: true, shift: true,  display: "⇧⌘Z" },
  { action: "toggleMaximize", label: "Maximize",         group: "Views",      key: "Enter",                     meta: true, shift: true,  display: "⇧⌘Enter" },
  // Window — disabled until #24 (new window state sharing)
  // { action: "newWindow",  label: "New Window",     group: "Window",     key: ["N", "n"],                     meta: true, shift: true,  display: "⇧⌘N" },
  // Help
  { action: "showShortcuts",  label: "Keyboard Shortcuts", group: "Help",   key: "/",                           meta: true,               display: "⌘/" },
  // Escape is special — no meta required
  { action: "dismiss",    label: "Dismiss",           group: "Navigation", key: "Escape",                                                 display: "Escape" },
];

function matches(def: ShortcutDef, e: KeyboardEvent): boolean {
  // Exact modifier match — no extra modifiers allowed
  if (e.metaKey !== (def.meta ?? false)) return false;
  if (e.shiftKey !== (def.shift ?? false)) return false;
  if (e.altKey !== (def.alt ?? false)) return false;
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
    // Don't show Escape in the modal
    if (def.action === "dismiss") continue;
    if (!map.has(def.group)) map.set(def.group, []);
    map.get(def.group)!.push({ keys: def.display, action: def.label });
  }
  return groupOrder.filter((g) => map.has(g)).map((g) => ({ title: g, shortcuts: map.get(g)! }));
}

export function useKeyboardShortcuts(actions: KeyboardActions) {
  function handler(e: KeyboardEvent) {
    for (const def of shortcuts) {
      if (matches(def, e)) {
        if (def.action !== "dismiss") e.preventDefault();
        actions[def.action]();
        return;
      }
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", handler);
  });

  onUnmounted(() => {
    window.removeEventListener("keydown", handler);
  });
}
