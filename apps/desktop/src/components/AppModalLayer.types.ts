import type { DbHandle } from "@kanna/db";

import type { KeyboardActions } from "../composables/useKeyboardShortcuts";
import type { useAppKeyboardActions } from "../composables/useAppKeyboardActions";
import type { useAppModals } from "../composables/useAppModals";
import type { useAppPreferences } from "../composables/useAppPreferences";
import type { useAppTaskCreation } from "../composables/useAppTaskCreation";
import type { useAppTaskNavigation } from "../composables/useAppTaskNavigation";
import type { useAppTaskTransfer } from "../composables/useAppTaskTransfer";
import type { useAppUpdate } from "../composables/useAppUpdate";
import type { useKannaStore } from "../stores/kanna";

export interface AppModalLayerController {
  isMobile: boolean;
  db: DbHandle;
  store: ReturnType<typeof useKannaStore>;
  appUpdate: ReturnType<typeof useAppUpdate>;
  appKeyboardActions: ReturnType<typeof useAppKeyboardActions>;
  appModals: ReturnType<typeof useAppModals>;
  appPreferences: ReturnType<typeof useAppPreferences>;
  appTaskCreation: ReturnType<typeof useAppTaskCreation>;
  appTaskNavigation: ReturnType<typeof useAppTaskNavigation>;
  appTaskTransfer: ReturnType<typeof useAppTaskTransfer>;
  getKeyboardActions: () => KeyboardActions;
}
