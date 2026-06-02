export const APP_THEME_PREFERENCES = ["dark", "light", "system"] as const;
export const CODE_THEME_PREFERENCES = ["match", "dark", "light"] as const;
export const RESOLVED_THEMES = ["dark", "light"] as const;

export type AppThemePreference = (typeof APP_THEME_PREFERENCES)[number];
export type CodeThemePreference = (typeof CODE_THEME_PREFERENCES)[number];
export type ResolvedTheme = (typeof RESOLVED_THEMES)[number];

export const DEFAULT_APP_THEME: AppThemePreference = "dark";
export const DEFAULT_CODE_THEME: CodeThemePreference = "match";

export function isAppThemePreference(value: unknown): value is AppThemePreference {
  return typeof value === "string" && APP_THEME_PREFERENCES.includes(value as AppThemePreference);
}

export function isCodeThemePreference(value: unknown): value is CodeThemePreference {
  return typeof value === "string" && CODE_THEME_PREFERENCES.includes(value as CodeThemePreference);
}

export function isResolvedTheme(value: unknown): value is ResolvedTheme {
  return typeof value === "string" && RESOLVED_THEMES.includes(value as ResolvedTheme);
}
