import { computed, readonly, ref } from "vue";
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  applyDocumentTheme,
  resolveAppThemePreference,
  resolveCodeThemePreference,
  type AppThemePreference,
  type CodeThemePreference,
} from "./theme";

const appThemePreference = ref<AppThemePreference>(DEFAULT_APP_THEME);
const codeThemePreference = ref<CodeThemePreference>(DEFAULT_CODE_THEME);
const systemPrefersDark = ref(false);

const effectiveAppTheme = computed(() =>
  resolveAppThemePreference(appThemePreference.value, systemPrefersDark.value)
);
const effectiveCodeTheme = computed(() =>
  resolveCodeThemePreference(codeThemePreference.value, effectiveAppTheme.value)
);

export function setThemePreferences(input: {
  appTheme: AppThemePreference;
  codeTheme: CodeThemePreference;
}): void {
  appThemePreference.value = input.appTheme;
  codeThemePreference.value = input.codeTheme;
}

export function setSystemPrefersDark(prefersDark: boolean): void {
  systemPrefersDark.value = prefersDark;
}

export function applyCurrentDocumentTheme(root = document.documentElement): void {
  applyDocumentTheme(root, {
    appTheme: effectiveAppTheme.value,
    codeTheme: effectiveCodeTheme.value,
  });
}

export function resetThemeRuntimeForTests(): void {
  appThemePreference.value = DEFAULT_APP_THEME;
  codeThemePreference.value = DEFAULT_CODE_THEME;
  systemPrefersDark.value = false;
}

export function useThemeRuntime() {
  return {
    appThemePreference: readonly(appThemePreference),
    codeThemePreference: readonly(codeThemePreference),
    systemPrefersDark: readonly(systemPrefersDark),
    effectiveAppTheme,
    effectiveCodeTheme,
  };
}
