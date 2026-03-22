import { ref, onMounted, onUnmounted } from "vue";
import { shortcuts } from "./useKeyboardShortcuts";

export type ShortcutContext = "main" | "diff" | "file";

export interface ContextShortcut {
  label: string;
  display: string;
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
  onMounted(() => {
    activeContext.value = ctx;
  });
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
  onMounted(() => {
    contextShortcuts.value.set(ctx, extras);
  });
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
 * NOTE: Until Task 1 adds `context` fields to the shortcuts array, this will
 * return all global shortcuts for every context (since !def.context is true for all).
 */
export function getContextShortcuts(ctx: ShortcutContext): { keys: string; action: string }[] {
  const result: { keys: string; action: string }[] = [];

  // Global shortcuts: include if tagged for this context, or untagged (all contexts)
  for (const def of shortcuts) {
    const defWithContext = def as typeof def & { context?: ShortcutContext[] };
    if (!defWithContext.context || defWithContext.context.includes(ctx)) {
      result.push({ keys: def.display, action: def.label });
    }
  }

  // Supplementary shortcuts from components
  const extras = contextShortcuts.value.get(ctx);
  if (extras) {
    for (const s of extras) {
      result.push({ keys: s.display, action: s.label });
    }
  }

  return result;
}

/** Human-readable context title for the modal header. */
export function getContextTitle(ctx: ShortcutContext): string {
  const titles: Record<ShortcutContext, string> = {
    main: "Main Shortcuts",
    diff: "Diff Viewer Shortcuts",
    file: "File Viewer Shortcuts",
  };
  return titles[ctx];
}
