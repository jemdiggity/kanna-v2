import type { useAppModals } from "../composables/useAppModals";
import type { useAppPreferences } from "../composables/useAppPreferences";
import type { MainTabsController } from "../composables/useMainTabs";
import type { useKannaStore } from "../stores/kanna";

/**
 * Everything the main content area needs to host a task's views as tabs.
 *
 * It is one object for the same reason `AppModalLayerController` is: the tab
 * host renders the same view components the modal layer used to, and those
 * take their repo, worktree, remote-loader and remembered-view-state inputs
 * from `useAppModals`. Threading a dozen individual props through `MainPanel`
 * would say less and drift faster.
 */
export interface MainTabViewsController {
  tabs: MainTabsController;
  modals: ReturnType<typeof useAppModals>;
  preferences: ReturnType<typeof useAppPreferences>;
  store: ReturnType<typeof useKannaStore>;
}
