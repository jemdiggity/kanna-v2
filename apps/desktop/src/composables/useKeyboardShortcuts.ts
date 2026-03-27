import { onMounted, onUnmounted } from "vue";
import type { ShortcutContext } from "./useShortcutContext";

export type ActionName =
  | "newTask"
  | "newWindow"
  | "openFile"
  | "advanceStage"
  | "closeTask"
  | "undoClose"
  | "navigateUp"
  | "navigateDown"
  | "navigateRepoUp"
  | "navigateRepoDown"
  | "dismiss"
  | "openInIDE"
  | "openShell"
  | "showDiff"
  | "showCommitGraph"
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
  | "toggleTreeExplorer"
  | "openPreferences"
  | "openShellRepoRoot"
  | "prevTab"
  | "nextTab"
  | "focusSearch"
  | "goToOldestUnread";

export type KeyboardActions = Record<ActionName, () => void>;

interface ShortcutDef {
  action: ActionName;
  /** i18n key for the display label in the shortcuts modal */
  labelKey: string;
  /** i18n key for the group heading in the shortcuts modal */
  groupKey: string;
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
  { action: "newTask",    labelKey: "shortcuts.newTask",       groupKey: "shortcuts.groupTasks",      key: ["N", "n"],                     meta: true, shift: true,  display: "⇧⌘N",     context: ["main"] },
  { action: "advanceStage", labelKey: "shortcuts.advanceStage", groupKey: "shortcuts.groupTasks",      key: "s",                            meta: true, display: "⌘S",                       context: ["main"] },
  { action: "closeTask",  labelKey: "shortcuts.closeReject",   groupKey: "shortcuts.groupTasks",      key: ["Backspace", "Delete"],        meta: true,               display: "⌘⌫",       context: ["main"] },
  { action: "undoClose",  labelKey: "shortcuts.undoClose",     groupKey: "shortcuts.groupTasks",      key: ["Z", "z"],                     meta: true,               display: "⌘Z",       context: ["main"] },
  // Navigation — moving between tasks and finding things
  { action: "navigateUp",     labelKey: "shortcuts.previousTask",   groupKey: "shortcuts.groupNavigation", key: "ArrowUp",                   meta: true, alt: true,    display: "⌥⌘↑",     context: ["main"] },
  { action: "navigateDown",   labelKey: "shortcuts.nextTask",       groupKey: "shortcuts.groupNavigation", key: "ArrowDown",                 meta: true, alt: true,    display: "⌥⌘↓",     context: ["main"] },
  { action: "navigateRepoUp",   labelKey: "shortcuts.previousRepo",   groupKey: "shortcuts.groupNavigation", key: "ArrowUp",                   meta: true, shift: true,  display: "⇧⌘↑",     context: ["main"] },
  { action: "navigateRepoDown", labelKey: "shortcuts.nextRepo",       groupKey: "shortcuts.groupNavigation", key: "ArrowDown",                 meta: true, shift: true,  display: "⇧⌘↓",     context: ["main"] },
  { action: "openFile",       labelKey: "shortcuts.filePicker",     groupKey: "shortcuts.groupNavigation", key: "p",                         meta: true,               display: "⌘P",       context: ["main"] },
  { action: "commandPalette", labelKey: "shortcuts.commandPalette", groupKey: "shortcuts.groupNavigation", key: ["P", "p"],                  meta: true, shift: true,  display: "⇧⌘P",     context: ["main"] },
  // Views — panels, modes, and display
  { action: "showDiff",       labelKey: "shortcuts.viewDiff",       groupKey: "shortcuts.groupViews",      key: "d",                         meta: true, display: "⌘D",                       context: ["main", "diff", "shell"] },
  { action: "showCommitGraph", labelKey: "shortcuts.commitGraph", groupKey: "shortcuts.groupViews", key: "g", meta: true, display: "⌘G", context: ["main"] },
  { action: "openShell",      labelKey: "shortcuts.shellTerminal",  groupKey: "shortcuts.groupViews",      key: "j",                         meta: true,               display: "⌘J",       context: ["main", "diff", "shell"] },
  { action: "openShellRepoRoot", labelKey: "shortcuts.shellRepoRoot", groupKey: "shortcuts.groupViews",   key: ["J", "j"],                  meta: true, shift: true,  display: "⇧⌘J",     context: ["main", "diff", "shell"] },
  { action: "openInIDE",      labelKey: "shortcuts.openInIDE",      groupKey: "shortcuts.groupViews",      key: "o",                         meta: true,               display: "⌘O",       context: ["main"] },
  { action: "toggleMaximize", labelKey: "shortcuts.maximize",       groupKey: "shortcuts.groupViews",      key: "Enter",                     meta: true, shift: true,  display: "⇧⌘Enter", context: ["main", "diff", "file", "shell"] },
  // Window — disabled until #24 (new window state sharing)
  // { action: "newWindow",  labelKey: "shortcuts.newWindow", groupKey: "shortcuts.groupWindow", key: ["N", "n"],                     meta: true, shift: true,  display: "⇧⌘N" },
  { action: "toggleSidebar", labelKey: "shortcuts.toggleSidebar", groupKey: "shortcuts.groupViews",      key: "b",                            meta: true,               display: "⌘B",       context: ["main"] },
  { action: "showAnalytics", labelKey: "shortcuts.analytics",      groupKey: "shortcuts.groupViews",      key: ["A", "a"],                     meta: true, shift: true,  display: "⇧⌘A",     context: ["main"] },
  { action: "createRepo",   labelKey: "shortcuts.createRepo",     groupKey: "shortcuts.groupNavigation", key: ["I", "i"],                     meta: true,               display: "⌘I",       context: ["main"] },
  { action: "importRepo",   labelKey: "shortcuts.importClone",    groupKey: "shortcuts.groupNavigation", key: ["I", "i"],                     meta: true, shift: true,  display: "⇧⌘I",     context: ["main"] },
  { action: "goBack",       labelKey: "shortcuts.goBack",         groupKey: "shortcuts.groupNavigation", key: "-",                            ctrl: true,               display: "⌃-",       context: ["main"] },
  { action: "goForward",    labelKey: "shortcuts.goForward",      groupKey: "shortcuts.groupNavigation", key: ["_", "-"],                     ctrl: true, shift: true,  display: "⌃⇧-",     context: ["main"] },
  { action: "toggleTreeExplorer", labelKey: "shortcuts.treeExplorer", groupKey: "shortcuts.groupNavigation", key: "e", meta: true, shift: true, display: "⇧⌘E", context: ["main", "diff", "shell"] },
  { action: "goToOldestUnread", labelKey: "shortcuts.oldestUnread", groupKey: "shortcuts.groupNavigation", key: "u", meta: true, display: "⌘U", context: ["main"] },
  { action: "focusSearch", labelKey: "shortcuts.focusSearch", groupKey: "shortcuts.groupNavigation", key: "f", meta: true, display: "⌘F", context: ["main"] },
  // Settings
  { action: "openPreferences", labelKey: "shortcuts.preferences", groupKey: "shortcuts.groupHelp", key: ",",                            meta: true,               display: "⌘,",       context: ["main"] },
  // Help — ⇧⌘/ must come before ⌘/ so the more specific shortcut matches first
  { action: "showAllShortcuts", labelKey: "shortcuts.allShortcuts",       groupKey: "shortcuts.groupHelp",   key: "/",                           meta: true, shift: true,  display: "⇧⌘/",     context: ["main", "file", "shell"], hidden: true },
  { action: "showShortcuts",  labelKey: "shortcuts.keyboardShortcuts",  groupKey: "shortcuts.groupHelp",   key: "/",                           meta: true,               display: "⌘/",       context: ["main", "diff", "file", "shell"] },
  // Tab cycling — used by modals with tabs (e.g. Preferences)
  { action: "prevTab",    labelKey: "shortcuts.prevTab",       groupKey: "shortcuts.groupNavigation", key: ["[", "{"],                     meta: true, shift: true,  display: "⇧⌘[",     hidden: true },
  { action: "nextTab",    labelKey: "shortcuts.nextTab",       groupKey: "shortcuts.groupNavigation", key: ["]", "}"],                     meta: true, shift: true,  display: "⇧⌘]",     hidden: true },
  // Escape is special — no meta required
  { action: "dismiss",    labelKey: "shortcuts.dismiss",       groupKey: "shortcuts.groupNavigation", key: "Escape",                                                 display: "Escape",   context: ["main", "diff", "file", "shell"] },
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
 * Accepts a `t` function to resolve i18n keys to translated strings.
 */
export function getShortcutGroups(t: (key: string) => string): { title: string; shortcuts: { keys: string; action: string }[] }[] {
  const groupOrder = ["shortcuts.groupTasks", "shortcuts.groupNavigation", "shortcuts.groupViews", "shortcuts.groupHelp"];
  const map = new Map<string, { keys: string; action: string }[]>();
  for (const def of shortcuts) {
    if (def.hidden) continue;
    if (!map.has(def.groupKey)) map.set(def.groupKey, []);
    map.get(def.groupKey)!.push({ keys: def.display, action: t(def.labelKey) });
  }
  return groupOrder.filter((g) => map.has(g)).map((g) => ({ title: t(g), shortcuts: map.get(g)! }));
}

export function useKeyboardShortcuts(actions: KeyboardActions, options?: { beforeAction?: (action: ActionName) => void; context?: () => ShortcutContext }) {
  function handler(e: KeyboardEvent) {
    const ctx = options?.context?.();
    for (const def of shortcuts) {
      if (matches(def, e)) {
        if (ctx && def.context && !def.context.includes(ctx)) continue;
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
