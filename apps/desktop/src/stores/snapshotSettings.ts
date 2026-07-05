import type { StoreState } from "./state";
import { normalizeAppThemePreference, normalizeCodeThemePreference } from "../theme/theme";

export function applySnapshotSettingsToState(
  state: Pick<
    StoreState,
    | "suspendAfterMinutes"
    | "killAfterMinutes"
    | "ideCommand"
    | "hideShortcutsOnStartup"
    | "devLingerTerminals"
    | "appTheme"
    | "codeTheme"
    | "agentMessageAppearance"
  >,
  settings: Record<string, string>,
): void {
  if (settings.suspendAfterMinutes) {
    state.suspendAfterMinutes.value = parseInt(settings.suspendAfterMinutes, 10) || 30;
  }
  if (settings.killAfterMinutes) {
    state.killAfterMinutes.value = parseInt(settings.killAfterMinutes, 10) || 60;
  }
  if (settings.ideCommand) state.ideCommand.value = settings.ideCommand;
  state.hideShortcutsOnStartup.value = settings.hideShortcutsOnStartup === "true";
  state.devLingerTerminals.value = settings["dev.lingerTerminals"] === "true";
  state.appTheme.value = normalizeAppThemePreference(settings.appTheme ?? null);
  state.codeTheme.value = normalizeCodeThemePreference(settings.codeTheme ?? null);
  const agentMessageAppearance = settings.agentMessageAppearance ?? settings.agentMessageStyle ?? null;
  state.agentMessageAppearance.value =
    agentMessageAppearance === "log" || agentMessageAppearance === "terminal"
      ? agentMessageAppearance
      : "chat";
}
