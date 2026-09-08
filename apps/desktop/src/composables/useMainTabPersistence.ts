import { getCurrentInstance, onBeforeUnmount, watch, type Ref } from "vue";

import {
  mainTabScopeKeyForApp,
  mainTabScopeKeyForRepo,
  mainTabScopeKeyForTask,
  parsePersistedMainTabs,
  type MainTabsController,
} from "./useMainTabs";

/** The default storage key the main area's tab sets are stored under. */
export const MAIN_TABS_STORAGE_KEY = "kanna.mainTabs";

/**
 * How long the tab state must hold still before it is written.
 *
 * Opening a view, switching tabs and closing one again are single keystrokes,
 * and each one changes this state; without a pause the app would write once
 * per keystroke to record something nobody reads until the next launch.
 */
const SAVE_DEBOUNCE_MS = 500;

interface UseMainTabPersistenceOptions {
  tabs: MainTabsController;
  /** Ids of the tasks the latest snapshot reported, read once at startup. */
  openTaskIds: Ref<string[]>;
  /** Ids of the repositories the latest snapshot reported, likewise. */
  openRepoIds: Ref<string[]>;
  readStorage: (key: string) => string | null | Promise<string | null>;
  writeStorage: (key: string, value: string) => Promise<unknown>;
  /** Where to store them; defaults to {@link MAIN_TABS_STORAGE_KEY}. */
  storageKey?: string;
}

/**
 * Carries the main area's tab sets across restarts, leaving behind the ones
 * whose subject is gone.
 *
 * Tab state is UI convenience, so it is written on a debounce and every
 * failure is logged rather than raised: a write that does not land must never
 * take the window down with it, and the worst case is a launch that opens on
 * the agent session, which is where it opened before any of this.
 */
export function useMainTabPersistence({
  tabs,
  openTaskIds,
  openRepoIds,
  readStorage,
  writeStorage,
  storageKey = MAIN_TABS_STORAGE_KEY,
}: UseMainTabPersistenceOptions) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWritten = "";
  let hydrated = false;

  async function flush(): Promise<void> {
    saveTimer = null;
    const value = JSON.stringify(tabs.snapshotScopes());
    if (value === lastWritten) return;
    lastWritten = value;
    try {
      await writeStorage(storageKey, value);
    } catch (error: unknown) {
      // Keep the next change eligible to retry rather than latching the
      // failed value in as though it had been stored.
      lastWritten = "";
      console.error("[main-tabs] failed to persist open tabs:", error);
    }
  }

  function scheduleSave(): void {
    if (!hydrated) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void flush(); }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Restores the stored tab sets, and is the only place a departed subject's
   * scope is left behind.
   *
   * It runs once, after `store.init` has loaded this desktop's tasks and
   * repositories, which is the one moment the snapshot can be read as the
   * whole picture. Nothing prunes after that. `store.items` is replaced whole
   * by every refresh and only ever carries the tasks of the repositories that
   * refresh returned, and a task is absent from it while an optimistic close
   * is in flight as well — so a task missing from one snapshot is not a task
   * that left the desktop, and treating it as one emptied a live tab set for
   * good and then persisted the deletion. A scope whose task really did close
   * mid-session is unreachable anyway, since the task is gone from the
   * sidebar; it costs a few objects until the next launch drops it here.
   */
  async function hydrate(): Promise<void> {
    if (hydrated) return;
    try {
      const raw = await readStorage(storageKey);
      const persisted = parsePersistedMainTabs(raw);
      const liveKeys = new Set([
        ...openTaskIds.value.map(mainTabScopeKeyForTask),
        ...openRepoIds.value.map(mainTabScopeKeyForRepo),
      ]);
      // The app scope belongs to the window itself and always survives; a task
      // or repository scope only survives while its subject does.
      liveKeys.add(mainTabScopeKeyForApp());
      tabs.restoreScopes(persisted, (key) => liveKeys.has(key));
      lastWritten = raw ?? "";
    } catch (error: unknown) {
      console.error("[main-tabs] failed to restore open tabs:", error);
    } finally {
      hydrated = true;
    }
  }

  const stopSaving = watch(() => tabs.snapshotScopes(), scheduleSave, { deep: true });

  function dispose(): void {
    stopSaving();
    if (!saveTimer) return;
    // A change made in the last half-second is still worth storing: the window
    // closing is exactly when the reader expects their tabs to be remembered.
    clearTimeout(saveTimer);
    void flush();
  }

  // A window closing is exactly when someone expects their tabs to be
  // remembered, so the last debounced change is flushed on the way out.
  if (getCurrentInstance()) onBeforeUnmount(dispose);

  return { hydrate, dispose, flush };
}
