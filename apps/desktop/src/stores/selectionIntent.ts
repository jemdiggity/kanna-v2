import type { StoreState } from "./state";

export function recordSelectionIntent(state: StoreState): void {
  state.selectionIntentVersion.value += 1;
}
