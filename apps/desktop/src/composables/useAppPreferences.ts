import { reactive, ref, type ComputedRef } from "vue";
import { isAgentProvider } from "@kanna/agent-protocol";
import type { AgentProvider, DbHandle } from "../types/kanna";

import i18n from "../i18n";
import { putDesktopSetting } from "../services/desktopServerClient";
import {
  applyCurrentDocumentTheme,
  setSystemPrefersDark,
  setThemePreferences,
} from "../theme/runtime";
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  normalizeAppThemePreference,
  normalizeCodeThemePreference,
  type ResolvedTheme,
} from "../theme/theme";
import { syncNativeAppTheme } from "../theme/native";
import type { useKannaStore } from "../stores/kanna";
import { normalizeAgentExecutionType, type AgentExecutionType } from "../stores/agentExecutionType";
import {
  parseRecentAgentChoices,
  promoteRecentAgentChoice,
  type RecentAgentChoice,
} from "../utils/agentChoiceUsage";

interface UseAppPreferencesOptions {
  db: DbHandle;
  store: ReturnType<typeof useKannaStore>;
  effectiveAppTheme: ComputedRef<ResolvedTheme>;
}

export function useAppPreferences({
  store,
  effectiveAppTheme,
}: UseAppPreferencesOptions) {
  const commandUsageCounts = ref<Record<string, number>>({});
  const preferences = reactive({
    suspendAfterMinutes: 30,
    killAfterMinutes: 60,
    ideCommand: "code",
    locale: "en",
    devLingerTerminals: false,
    defaultAgentProvider: "claude" as AgentProvider,
    defaultAgentType: "pty" as AgentExecutionType,
    recentAgentChoices: [] as RecentAgentChoice[],
    appTheme: DEFAULT_APP_THEME,
    codeTheme: DEFAULT_CODE_THEME,
    agentMessageAppearance: "chat" as import("../stores/state").AgentMessageAppearance,
  });

  let colorSchemeQuery: MediaQueryList | null = null;
  let themeSyncRevision = 0;

  function readSystemPrefersDark(): boolean {
    if (colorSchemeQuery) return colorSchemeQuery.matches;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function syncThemeRuntime() {
    const revision = ++themeSyncRevision;
    setThemePreferences({
      appTheme: preferences.appTheme,
      codeTheme: preferences.codeTheme,
    });

    if (preferences.appTheme === "system") {
      void syncNativeAppTheme(null)
        .catch((error: unknown) => {
          console.error("[App] failed to sync native theme:", error);
        })
        .then(() => {
          if (revision !== themeSyncRevision) return;
          setSystemPrefersDark(readSystemPrefersDark());
          applyCurrentDocumentTheme();
        });
      return;
    }

    applyCurrentDocumentTheme();
    void syncNativeAppTheme(effectiveAppTheme.value).catch((error: unknown) => {
      console.error("[App] failed to sync native theme:", error);
    });
  }

  function handleSystemThemeChange(event: MediaQueryListEvent) {
    setSystemPrefersDark(event.matches);
    syncThemeRuntime();
  }

  function startSystemThemeListener() {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setSystemPrefersDark(false);
      syncThemeRuntime();
      return;
    }

    colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemPrefersDark(colorSchemeQuery.matches);
    if (typeof colorSchemeQuery.addEventListener === "function") {
      colorSchemeQuery.addEventListener("change", handleSystemThemeChange);
    } else {
      colorSchemeQuery.addListener?.(handleSystemThemeChange);
    }
    syncThemeRuntime();
  }

  function stopSystemThemeListener() {
    if (typeof colorSchemeQuery?.removeEventListener === "function") {
      colorSchemeQuery.removeEventListener("change", handleSystemThemeChange);
    } else {
      colorSchemeQuery?.removeListener?.(handleSystemThemeChange);
    }
    colorSchemeQuery = null;
  }

  async function trackCommandUsage(commandId: string) {
    const counts = { ...commandUsageCounts.value };
    counts[commandId] = (counts[commandId] || 0) + 1;
    commandUsageCounts.value = counts;
    await putDesktopSetting("commandPaletteUsage", JSON.stringify(counts));
  }

  async function trackAgentChoiceUsage(choice: { provider: AgentProvider; executionType: AgentExecutionType }) {
    const choices = promoteRecentAgentChoice(preferences.recentAgentChoices, choice);
    preferences.recentAgentChoices = choices;
    await putDesktopSetting("recentAgentChoices", JSON.stringify(choices));
  }

  function applyPreferenceUpdate(key: string, value: string) {
    if (key === "locale" && ["en", "ja", "ko"].includes(value)) {
      i18n.global.locale.value = value as "en" | "ja" | "ko";
      preferences.locale = value;
    } else if (key === "suspendAfterMinutes") {
      preferences.suspendAfterMinutes = parseInt(value, 10) || 30;
    } else if (key === "killAfterMinutes") {
      preferences.killAfterMinutes = parseInt(value, 10) || 60;
    } else if (key === "ideCommand") {
      preferences.ideCommand = value;
    } else if (key === "dev.lingerTerminals") {
      preferences.devLingerTerminals = value === "true";
    } else if (key === "defaultAgentProvider") {
      preferences.defaultAgentProvider = isAgentProvider(value) ? value : "claude";
    } else if (key === "defaultAgentType") {
      preferences.defaultAgentType = normalizeAgentExecutionType(value);
    } else if (key === "recentAgentChoices") {
      preferences.recentAgentChoices = parseRecentAgentChoices(value);
    } else if (key === "appTheme") {
      preferences.appTheme = normalizeAppThemePreference(value);
      syncThemeRuntime();
    } else if (key === "codeTheme") {
      preferences.codeTheme = normalizeCodeThemePreference(value);
      syncThemeRuntime();
    } else if (key === "agentMessageAppearance") {
      preferences.agentMessageAppearance =
        value === "log" || value === "terminal" ? value : "chat";
    }
  }

  // Preferences update handler
  async function handlePreferenceUpdate(key: string, value: string) {
    applyPreferenceUpdate(key, value);
    await store.savePreference(key, value);
  }

  return {
    preferences,
    commandUsageCounts,
    startSystemThemeListener,
    stopSystemThemeListener,
    trackCommandUsage,
    trackAgentChoiceUsage,
    handlePreferenceUpdate,
  };
}
