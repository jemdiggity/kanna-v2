import { ref, onUnmounted } from "vue";
import { shortcuts } from "./useKeyboardShortcuts";

export type ShortcutContext = "main" | "diff" | "file" | "shell" | "tree" | "newTask" | "graph" | "transfer";

export interface ContextShortcut {
  label: string;
  display: string;
  groupKey?: string;
}

export interface ContextShortcutItem {
  keys: string;
  action: string;
}

export interface ContextShortcutGroup {
  key: string;
  title: string;
  shortcuts: ContextShortcutItem[];
}

/** Active context — module-level singleton. */
export const activeContext = ref<ShortcutContext>("main");

/** Supplementary shortcuts registered by components, keyed by context. */
export const contextShortcuts = ref(new Map<ShortcutContext, ContextShortcut[]>());

export function setContext(ctx: ShortcutContext) {
  activeContext.value = ctx;
}

export function resetContext() {
  activeContext.value = "main";
}

/**
 * Composable: declares the active context for the component's lifetime.
 * Must be called during component setup().
 */
export function useShortcutContext(ctx: ShortcutContext) {
  // Set immediately in setup so context is available before any user interaction
  activeContext.value = ctx;
  onUnmounted(() => {
    activeContext.value = "main";
  });
}

/**
 * Imperative setter — directly sets shortcuts in the map without lifecycle hooks.
 * Use this in tests or when not inside a Vue component setup context.
 */
export function setContextShortcuts(ctx: ShortcutContext, extras: ContextShortcut[]) {
  contextShortcuts.value.set(ctx, extras);
}

/**
 * Register supplementary shortcuts for a context via Vue lifecycle hooks.
 * Must be called during component setup() so cleanup hooks register correctly.
 */
export function registerContextShortcuts(ctx: ShortcutContext, extras: ContextShortcut[]) {
  // Set immediately in setup so shortcuts are available before any user interaction
  contextShortcuts.value.set(ctx, extras);
  onUnmounted(() => {
    contextShortcuts.value.delete(ctx);
  });
}

/** Imperative clear — for testing and manual cleanup. */
export function clearContextShortcuts(ctx?: ShortcutContext) {
  if (ctx) {
    contextShortcuts.value.delete(ctx);
  } else {
    contextShortcuts.value.clear();
  }
}

/**
 * Returns shortcuts relevant to the given context:
 * - Global shortcuts tagged with this context (or untagged = all contexts)
 * - Supplementary shortcuts registered by components for this context
 *
 * The `action` field contains an i18n key (for global shortcuts) or a
 * pre-translated label (for supplementary shortcuts registered by components).
 */
function buildContextShortcutGroups(
  ctx: ShortcutContext,
  resolveTitle: (groupKey: string) => string,
  resolveAction: (actionKey: string, translated: boolean) => string,
): ContextShortcutGroup[] {
  const result = new Map<string, ContextShortcutItem[]>();
  const previewModalActions = [
    "openFile",
    "openLatestFileLink",
    "toggleFilePreview",
    "showDiff",
    "showCommitGraph",
    "openShell",
    "openShellRepoRoot",
    "toggleTreeExplorer",
    "toggleMaximize",
    "showShortcuts",
  ];
  const hiddenGlobalActionsByContext: Partial<Record<ShortcutContext, string[]>> = {
    newTask: ["dismiss"],
  };
  const visibleGlobalActionsByContext: Partial<Record<ShortcutContext, string[]>> = {
    diff: previewModalActions,
    file: previewModalActions,
    shell: previewModalActions,
    tree: previewModalActions,
    graph: previewModalActions.filter((action) => action !== "toggleMaximize"),
    newTask: ["showShortcuts"],
    transfer: ["showShortcuts"],
  };
  const hiddenGlobalActions = hiddenGlobalActionsByContext[ctx] ?? [];
  const visibleGlobalActions = ctx === "main"
    ? null
    : (visibleGlobalActionsByContext[ctx] ?? []);
  const extraGroupKey = `context:${ctx}`;

  // Global shortcuts: include if explicitly tagged for this context.
  // Untagged shortcuts fall back to "main" context only.
  for (const def of shortcuts) {
    if (def.hidden) continue;
    if (hiddenGlobalActions.includes(def.action)) continue;
    if (visibleGlobalActions != null && !visibleGlobalActions.includes(def.action)) continue;
    const targetGroupKey = (ctx === "file" || ctx === "diff") && def.groupKey === "shortcuts.groupWorkspace"
      ? "shortcuts.groupViews"
      : def.groupKey;
    if (def.context && def.context.includes(ctx)) {
      const existing = result.get(targetGroupKey) ?? [];
      existing.push({ keys: def.display, action: resolveAction(def.labelKey, true) });
      result.set(targetGroupKey, existing);
    } else if (!def.context && ctx === "main") {
      const existing = result.get(targetGroupKey) ?? [];
      existing.push({ keys: def.display, action: resolveAction(def.labelKey, true) });
      result.set(targetGroupKey, existing);
    }
  }

  // Supplementary shortcuts from components
  const extras = contextShortcuts.value.get(ctx);
  if (extras) {
    for (const s of extras) {
      const targetGroupKey = s.groupKey ?? extraGroupKey;
      const existing = result.get(targetGroupKey) ?? [];
      existing.push({ keys: s.display, action: resolveAction(s.label, false) });
      result.set(targetGroupKey, existing);
    }
  }

  const orderedExtraGroupKeys = [
    "shortcuts.groupSearch",
    "shortcuts.groupNavigation",
    "shortcuts.groupViews",
    "shortcuts.groupActions",
    extraGroupKey,
  ].filter((groupKey) => result.has(groupKey));

  const orderedGroupKeys = [
    "shortcuts.groupCreateOrganize",
    "shortcuts.groupWorkspace",
    "shortcuts.groupAppHelp",
    "shortcuts.groupMoveAround",
    "shortcuts.groupOpenInspect",
    ...orderedExtraGroupKeys,
  ];

  return orderedGroupKeys
    .filter((groupKey) => result.has(groupKey))
    .map((groupKey) => ({
      key: groupKey,
      title: resolveTitle(groupKey),
      shortcuts: result.get(groupKey) ?? [],
    }));
}

export function getContextShortcuts(ctx: ShortcutContext): ContextShortcutItem[] {
  return buildContextShortcutGroups(
    ctx,
    (groupKey) => groupKey,
    (actionKey) => actionKey,
  ).flatMap((group) => group.shortcuts);
}

export function getContextShortcutGroups(
  t: (key: string) => string,
  ctx: ShortcutContext,
): ContextShortcutGroup[] {
  return buildContextShortcutGroups(
    ctx,
    (groupKey) => {
      if (groupKey.startsWith("context:")) {
        return getContextTitle(t, ctx);
      }
      return t(groupKey);
    },
    (actionKey, translated) => (translated ? t(actionKey) : actionKey),
  );
}

/** Human-readable context title for the modal header. */
export function getContextTitle(t: (key: string) => string, ctx: ShortcutContext): string {
  const keys: Record<ShortcutContext, string> = {
    main: "shortcutContexts.main",
    diff: "shortcutContexts.diff",
    file: "shortcutContexts.file",
    shell: "shortcutContexts.shell",
    tree: "shortcutContexts.tree",
    newTask: "shortcutContexts.newTask",
    graph: "shortcutContexts.graph",
    transfer: "shortcutContexts.transfer",
  };
  return t(keys[ctx]);
}
