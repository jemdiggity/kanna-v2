import { computed, reactive, type ComputedRef } from "vue";

import type { ShortcutContext } from "./useShortcutContext";

/**
 * The view kinds the main content area can host.
 *
 * `agent` is the task's own session — the terminal (or agent message view, or
 * the cloud terminal for a task another machine owns). It is implicit: every
 * task scope has exactly one, it is always first, and it can never be closed.
 */
export type MainTabKind = "agent" | "diff" | "file" | "shell";

export interface MainTabDescriptor {
  kind: MainTabKind;
  /** `file` tabs: worktree-relative or absolute path of the file to show. */
  filePath?: string;
  /** `file` tabs: line to scroll to on open. */
  initialLine?: number;
  /**
   * `file` tabs: point-in-time content fetched from another machine. Present
   * only for a file that cannot be re-read locally.
   */
  remoteContent?: string | null;
}

export interface MainTab extends MainTabDescriptor {
  /** Stable within a scope, so re-opening the same view focuses it. */
  id: string;
}

interface MainTabScopeState {
  tabs: MainTab[];
  activeId: string;
}

export const AGENT_TAB_ID = "agent";

const TAB_SHORTCUT_CONTEXTS: Record<MainTabKind, ShortcutContext> = {
  agent: "main",
  diff: "diff",
  file: "file",
  shell: "shell",
};

/**
 * The id a descriptor claims. Two opens that name the same view produce the
 * same id, which is what makes "open this file" idempotent — the second one
 * focuses the tab the first one created instead of stacking a duplicate.
 */
export function mainTabId(descriptor: MainTabDescriptor): string {
  switch (descriptor.kind) {
    case "agent":
      return AGENT_TAB_ID;
    case "diff":
      return "diff";
    case "shell":
      return "shell";
    case "file":
      return `file:${descriptor.filePath ?? ""}`;
  }
}

export function mainTabShortcutContext(kind: MainTabKind): ShortcutContext {
  return TAB_SHORTCUT_CONTEXTS[kind];
}

/** The tab-set key for one task. The single spelling both sides agree on. */
export function mainTabScopeKeyForTask(taskId: string): string {
  return `item:${taskId}`;
}

interface UseMainTabsOptions {
  /**
   * Identifies the tab set. Tabs are per task: the main content area belongs
   * to the selected task, the way the sidebar selection already scopes the
   * diff and file-preview state, so switching tasks restores that task's tabs
   * instead of carrying one task's views onto another.
   *
   * `null` when no task is selected — there is nothing to tab into, and the
   * repo-scoped tools stay modal.
   */
  scopeKey: ComputedRef<string | null>;
}

export function useMainTabs({ scopeKey }: UseMainTabsOptions) {
  const scopes = reactive<Record<string, MainTabScopeState>>({});

  function agentTab(): MainTab {
    return { id: AGENT_TAB_ID, kind: "agent" };
  }

  function scopeState(key: string): MainTabScopeState {
    scopes[key] ??= { tabs: [agentTab()], activeId: AGENT_TAB_ID };
    return scopes[key];
  }

  const tabs = computed<MainTab[]>(() => {
    const key = scopeKey.value;
    if (!key) return [];
    return scopes[key]?.tabs ?? [agentTab()];
  });

  const activeTabId = computed<string>(() => {
    const key = scopeKey.value;
    if (!key) return AGENT_TAB_ID;
    return scopes[key]?.activeId ?? AGENT_TAB_ID;
  });

  const activeTab = computed<MainTab | null>(() =>
    tabs.value.find((tab) => tab.id === activeTabId.value) ?? null
  );

  const activeTabContext = computed<ShortcutContext | null>(() => {
    const tab = activeTab.value;
    return tab ? mainTabShortcutContext(tab.kind) : null;
  });

  function isOpen(id: string): boolean {
    return tabs.value.some((tab) => tab.id === id);
  }

  function activateTab(id: string): void {
    const key = scopeKey.value;
    if (!key) return;
    const state = scopeState(key);
    if (!state.tabs.some((tab) => tab.id === id)) return;
    state.activeId = id;
  }

  /** Opens the view, or focuses it when it is already open. Returns its id. */
  function openTab(descriptor: MainTabDescriptor, options?: { activate?: boolean }): string | null {
    const key = scopeKey.value;
    if (!key) return null;
    return openTabInScope(key, descriptor, options);
  }

  /**
   * Opens a view in a named task's tab set, which need not be the selected
   * one. This is what a server-driven "open this" command uses: it records the
   * view against the task it belongs to instead of pulling the operator's
   * window onto another task, so the tab is simply there when they look.
   */
  function openTabInScope(
    key: string,
    descriptor: MainTabDescriptor,
    options?: { activate?: boolean },
  ): string {
    const state = scopeState(key);
    const id = mainTabId(descriptor);
    const existing = state.tabs.findIndex((tab) => tab.id === id);
    if (existing === -1) {
      state.tabs.push({ ...descriptor, id });
    } else if (descriptor.kind !== "agent") {
      // Re-opening a file at a different line re-aims the tab that is
      // already showing it rather than leaving the reader where they were.
      state.tabs[existing] = { ...descriptor, id };
    }
    if (options?.activate !== false) state.activeId = id;
    return id;
  }

  function closeTab(id: string): void {
    const key = scopeKey.value;
    if (!key || id === AGENT_TAB_ID) return;
    const state = scopes[key];
    if (!state) return;
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    state.tabs.splice(index, 1);
    if (state.activeId !== id) return;
    // Closing the active tab moves to the tab that took its place — the one to
    // its right — and falls back to its left neighbour when it was last. The
    // agent session is leftmost, so closing the only open view lands there.
    state.activeId = (state.tabs[index] ?? state.tabs[index - 1])?.id ?? AGENT_TAB_ID;
  }

  /**
   * The keyboard-shortcut semantics the ephemeral modals had: the shortcut
   * that opened a view closes it again when that view already has focus, and
   * raises it when it is open but behind something else.
   */
  function toggleTab(descriptor: MainTabDescriptor): void {
    const id = mainTabId(descriptor);
    if (isOpen(id) && activeTabId.value === id) {
      closeTab(id);
      return;
    }
    openTab(descriptor);
  }

  function cycleTab(direction: -1 | 1): void {
    const ordered = tabs.value;
    if (ordered.length < 2) return;
    const current = ordered.findIndex((tab) => tab.id === activeTabId.value);
    const next = (current + direction + ordered.length) % ordered.length;
    activateTab(ordered[next].id);
  }

  function closeActiveTab(): boolean {
    const id = activeTabId.value;
    if (id === AGENT_TAB_ID) return false;
    closeTab(id);
    return true;
  }

  /** Drops a scope's tabs — used when its task leaves the window. */
  function dropScope(key: string): void {
    delete scopes[key];
  }

  return {
    scopeKey,
    tabs,
    activeTabId,
    activeTab,
    activeTabContext,
    isOpen,
    openTab,
    openTabInScope,
    closeTab,
    closeActiveTab,
    activateTab,
    toggleTab,
    cycleTab,
    dropScope,
  };
}

export type MainTabsController = ReturnType<typeof useMainTabs>;
