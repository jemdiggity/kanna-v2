import { onMounted, onUnmounted } from "vue";
import { isTauri } from "../tauri-mock";
import type { ShortcutContext } from "./useShortcutContext";

export type ActionName =
  | "newTask"
  | "newWindow"
  | "closeWindow"
  | "openFile"
  | "openLatestFileLink"
  | "toggleFilePreview"
  | "advanceStage"
  | "requestChanges"
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
  | "goToOldestUnread"
  | "goToOldestUnreadAllRepos"
  | "goToOldestRead"
  | "goToOldestReadAllRepos";

export type KeyboardActions = Record<ActionName, () => void | boolean | Promise<void>>;

interface ShortcutDef {
  action: ActionName;
  /** i18n key for the display label in the shortcuts modal */
  labelKey: string;
  /** i18n key for the group heading in the shortcuts modal */
  groupKey: string;
  /** Key(s) that trigger this shortcut (matched against KeyboardEvent.key). Array = any match. */
  key: string | string[];
  /** Physical key code(s), useful when Option changes KeyboardEvent.key on macOS. */
  code?: string | string[];
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
  /**
   * Hide from the command palette. Only for shortcuts whose action is the
   * palette itself: opening it (commandPalette) or closing it (dismiss).
   * Modal-scoped shortcuts still belong here — the palette stacks on top of
   * other modals rather than replacing them, so e.g. tab cycling dispatches
   * to the Preferences panel underneath.
   */
  paletteHidden?: boolean;
}

const PREVIEW_MODAL_CONTEXTS: ShortcutContext[] = ["main", "diff", "file", "shell", "tree", "graph"];

/**
 * Single source of truth for all app-level keyboard shortcuts.
 * Used by: keydown handler, terminal passthrough, shortcuts modal.
 */
export const shortcuts: ShortcutDef[] = [
  // Tasks — create work and change task state
  { action: "createRepo",   labelKey: "shortcuts.createRepo",     groupKey: "shortcuts.groupCreateOrganize", key: ["I", "i"],                     meta: true,               display: "⌘I",       context: ["main"] },
  { action: "importRepo",   labelKey: "shortcuts.importClone",    groupKey: "shortcuts.groupCreateOrganize", key: ["I", "i"],                     meta: true, shift: true,  display: "⇧⌘I",     context: ["main"] },
  { action: "newTask",    labelKey: "shortcuts.newTask",       groupKey: "shortcuts.groupCreateOrganize", key: ["N", "n"],                     meta: true, shift: true,  display: "⇧⌘N",     context: ["main"] },
  { action: "focusSearch", labelKey: "shortcuts.focusSearch", groupKey: "shortcuts.groupCreateOrganize", key: "f", meta: true, display: "⌘F", context: ["main"] },
  { action: "advanceStage", labelKey: "shortcuts.advanceStage", groupKey: "shortcuts.groupCreateOrganize", key: "s",                            meta: true, display: "⌘S",                       context: ["main", "diff"] },
  { action: "requestChanges", labelKey: "shortcuts.requestChanges", groupKey: "shortcuts.groupCreateOrganize", key: "s", meta: true, shift: true, display: "⇧⌘S", context: ["diff"] },
  { action: "closeTask",  labelKey: "shortcuts.closeReject",   groupKey: "shortcuts.groupCreateOrganize", key: ["Backspace", "Delete"],        meta: true, shift: true,  display: "⇧⌘⌫",     context: ["main"] },
  // Navigation — move between tasks, repos, and history
  { action: "navigateUp",     labelKey: "shortcuts.previousTask",   groupKey: "shortcuts.groupMoveAround", key: "ArrowUp",                   meta: true, alt: true,    display: "⌥⌘↑",     context: ["main"] },
  { action: "navigateDown",   labelKey: "shortcuts.nextTask",       groupKey: "shortcuts.groupMoveAround", key: "ArrowDown",                 meta: true, alt: true,    display: "⌥⌘↓",     context: ["main"] },
  { action: "navigateRepoUp",   labelKey: "shortcuts.previousRepo",   groupKey: "shortcuts.groupMoveAround", key: "ArrowUp",                   meta: true, shift: true,  display: "⇧⌘↑",     context: ["main"] },
  { action: "navigateRepoDown", labelKey: "shortcuts.nextRepo",       groupKey: "shortcuts.groupMoveAround", key: "ArrowDown",                 meta: true, shift: true,  display: "⇧⌘↓",     context: ["main"] },
  // Tools — open task and repo tools
  { action: "openFile",       labelKey: "shortcuts.filePicker",     groupKey: "shortcuts.groupOpenInspect", key: "p",                         meta: true,               display: "⌘P",       context: PREVIEW_MODAL_CONTEXTS },
  { action: "openLatestFileLink", labelKey: "shortcuts.openLatestAgentFile", groupKey: "shortcuts.groupOpenInspect", key: "l", meta: true, display: "⌘L", context: PREVIEW_MODAL_CONTEXTS },
  { action: "toggleFilePreview", labelKey: "shortcuts.filePreview", groupKey: "shortcuts.groupOpenInspect", key: "p", code: "KeyP",            meta: true, alt: true,    display: "⌥⌘P",      context: ["main", "file"] },
  { action: "commandPalette", labelKey: "shortcuts.commandPalette", groupKey: "shortcuts.groupOpenInspect", key: ["P", "p"],                  meta: true, shift: true,  display: "⇧⌘P",     context: ["main"], paletteHidden: true },
  { action: "showDiff",       labelKey: "shortcuts.viewDiff",       groupKey: "shortcuts.groupOpenInspect", key: "d",                         meta: true, display: "⌘D",                       context: PREVIEW_MODAL_CONTEXTS },
  { action: "showCommitGraph", labelKey: "shortcuts.commitGraph", groupKey: "shortcuts.groupOpenInspect", key: "g", meta: true, display: "⌘G", context: PREVIEW_MODAL_CONTEXTS },
  { action: "openShell",      labelKey: "shortcuts.shellTerminal",  groupKey: "shortcuts.groupOpenInspect", key: "j",                         meta: true,               display: "⌘J",       context: PREVIEW_MODAL_CONTEXTS },
  { action: "openShellRepoRoot", labelKey: "shortcuts.shellRepoRoot", groupKey: "shortcuts.groupOpenInspect", key: ["J", "j"],                  meta: true, shift: true,  display: "⇧⌘J",     context: PREVIEW_MODAL_CONTEXTS },
  { action: "openInIDE",      labelKey: "shortcuts.openInIDE",      groupKey: "shortcuts.groupOpenInspect", key: "o",                         meta: true,               display: "⌘O",       context: ["main"] },
  { action: "newWindow",    labelKey: "shortcuts.newWindow",    groupKey: "shortcuts.groupWorkspace", key: "n",                            meta: true,               display: "⌘N",       context: ["main"] },
  { action: "closeWindow",  labelKey: "shortcuts.closeWindow",  groupKey: "shortcuts.groupWorkspace", key: "w",                            meta: true,               display: "⌘W",       context: ["main", "diff", "file", "shell", "tree", "graph", "newTask", "transfer"] },
  // Views — layout and framing controls
  { action: "toggleSidebar", labelKey: "shortcuts.toggleSidebar", groupKey: "shortcuts.groupWorkspace", key: "b",                            meta: true,               display: "⌘B",       context: ["main"] },
  { action: "toggleMaximize", labelKey: "shortcuts.maximize",       groupKey: "shortcuts.groupWorkspace", key: "Enter",                     meta: true, shift: true,  display: "⇧⌘Enter", context: ["main", "diff", "file", "shell", "tree"] },
  { action: "goBack",       labelKey: "shortcuts.goBack",         groupKey: "shortcuts.groupMoveAround", key: "-",                            ctrl: true,               display: "⌃-",       context: ["main"] },
  { action: "goForward",    labelKey: "shortcuts.goForward",      groupKey: "shortcuts.groupMoveAround", key: ["_", "-"],                     ctrl: true, shift: true,  display: "⌃⇧-",     context: ["main"] },
  { action: "toggleTreeExplorer", labelKey: "shortcuts.treeExplorer", groupKey: "shortcuts.groupOpenInspect", key: ["E", "e"], meta: true, shift: true, display: "⇧⌘E", context: PREVIEW_MODAL_CONTEXTS },
  { action: "showAnalytics", labelKey: "shortcuts.analytics",      groupKey: "shortcuts.groupOpenInspect", key: ["A", "a"],                     meta: true, shift: true,  display: "⇧⌘A",     context: ["main"] },
  { action: "goToOldestUnread", labelKey: "shortcuts.oldestUnread", groupKey: "shortcuts.groupMoveAround", key: "u", meta: true, display: "⌘U", context: ["main"] },
  { action: "goToOldestUnreadAllRepos", labelKey: "shortcuts.oldestUnreadAllRepos", groupKey: "shortcuts.groupMoveAround", key: ["U", "u"], meta: true, shift: true, display: "⇧⌘U", context: ["main"] },
  { action: "goToOldestRead", labelKey: "shortcuts.oldestRead", groupKey: "shortcuts.groupMoveAround", key: "r", meta: true, display: "⌘R", context: ["main"] },
  { action: "goToOldestReadAllRepos", labelKey: "shortcuts.oldestReadAllRepos", groupKey: "shortcuts.groupMoveAround", key: ["R", "r"], meta: true, shift: true, display: "⇧⌘R", context: ["main"] },
  // Help — global app controls and help entry points
  { action: "openPreferences", labelKey: "shortcuts.preferences", groupKey: "shortcuts.groupAppHelp", key: ",",                            meta: true,               display: "⌘,",       context: ["main"] },
  // Help — ⇧⌘/ must come before ⌘/ so the more specific shortcut matches first
  { action: "showAllShortcuts", labelKey: "shortcuts.allShortcuts",       groupKey: "shortcuts.groupAppHelp",   key: "/",                           meta: true, shift: true,  display: "⇧⌘/",     context: ["main", "file", "shell", "tree", "newTask"], hidden: true },
  { action: "showShortcuts",  labelKey: "shortcuts.keyboardShortcuts",  groupKey: "shortcuts.groupAppHelp",   key: "/",                           meta: true,               display: "⌘/",       context: ["main", "diff", "file", "shell", "tree", "graph", "newTask", "transfer"] },
  // Tab cycling — used by modals with tabs (e.g. Preferences)
  { action: "prevTab",    labelKey: "shortcuts.prevTab",       groupKey: "shortcuts.groupMoveAround", key: ["[", "{"],                     meta: true, shift: true,  display: "⇧⌘[",     hidden: true },
  { action: "nextTab",    labelKey: "shortcuts.nextTab",       groupKey: "shortcuts.groupMoveAround", key: ["]", "}"],                     meta: true, shift: true,  display: "⇧⌘]",     hidden: true },
  // Escape is special — no meta required
  { action: "dismiss",    labelKey: "shortcuts.dismiss",       groupKey: "shortcuts.groupAppHelp", key: "Escape",                                                 display: "Escape",   context: ["main", "diff", "file", "tree", "graph", "newTask", "transfer"], hidden: true, paletteHidden: true },
];

function matches(def: ShortcutDef, e: KeyboardEvent): boolean {
  // Exact modifier match — no extra modifiers allowed
  if (e.metaKey !== (def.meta ?? false)) return false;
  if (e.shiftKey !== (def.shift ?? false)) return false;
  if (e.altKey !== (def.alt ?? false)) return false;
  if (e.ctrlKey !== (def.ctrl ?? false)) return false;
  const keys = Array.isArray(def.key) ? def.key : [def.key];
  const codes = def.code ? (Array.isArray(def.code) ? def.code : [def.code]) : [];
  return keys.includes(e.key) || codes.includes(e.code);
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
export function getShortcutGroups(t: (key: string) => string): { key: string; title: string; shortcuts: { keys: string; action: string }[] }[] {
  const groupOrder = [
    "shortcuts.groupCreateOrganize",
    "shortcuts.groupMoveAround",
    "shortcuts.groupOpenInspect",
    "shortcuts.groupWorkspace",
    "shortcuts.groupAppHelp",
  ];
  const map = new Map<string, { keys: string; action: string }[]>();
  for (const def of shortcuts) {
    if (def.hidden) continue;
    if (!map.has(def.groupKey)) map.set(def.groupKey, []);
    map.get(def.groupKey)!.push({ keys: def.display, action: t(def.labelKey) });
  }
  const groups = groupOrder.filter((g) => map.has(g)).map((g) => ({ key: g, title: t(g), shortcuts: map.get(g)! }));
  return groups.map((group) => ({
    key: group.key,
    title: group.title,
    shortcuts: group.key === "shortcuts.groupOpenInspect"
      ? [...group.shortcuts].sort((a, b) => a.action.localeCompare(b.action))
      : group.shortcuts,
  }));
}

export function useKeyboardShortcuts(actions: KeyboardActions, options?: { beforeAction?: (action: ActionName) => void; context?: () => ShortcutContext }) {
  function handler(e: KeyboardEvent) {
    const ctx = options?.context?.();
    for (const def of shortcuts) {
      if (matches(def, e)) {
        if (isTauri && (def.action === "newWindow" || def.action === "closeWindow")) continue;
        if (ctx && !(def.context ?? ["main"]).includes(ctx)) continue;
        e.preventDefault();
        options?.beforeAction?.(def.action);
        const handled = actions[def.action]();
        if (def.action === "dismiss" && handled) e.stopPropagation();
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
