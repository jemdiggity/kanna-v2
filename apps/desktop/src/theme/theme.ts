import type { ITheme } from "@xterm/xterm";
import { themePalettes, type ChartPalette } from "./palette";
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  isAppThemePreference,
  isCodeThemePreference,
  type AppThemePreference,
  type CodeThemePreference,
  type ResolvedTheme,
} from "./types";

export {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  isAppThemePreference,
  isCodeThemePreference,
};
export type { AppThemePreference, CodeThemePreference, ResolvedTheme };

interface DocumentThemeInput {
  appTheme: ResolvedTheme;
  codeTheme: ResolvedTheme;
}

export type ChartTheme = ChartPalette;

export function normalizeAppThemePreference(value: unknown): AppThemePreference {
  return isAppThemePreference(value) ? value : DEFAULT_APP_THEME;
}

export function normalizeCodeThemePreference(value: unknown): CodeThemePreference {
  return isCodeThemePreference(value) ? value : DEFAULT_CODE_THEME;
}

export function resolveAppThemePreference(
  preference: AppThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function resolveCodeThemePreference(
  preference: CodeThemePreference,
  effectiveAppTheme: ResolvedTheme,
): ResolvedTheme {
  return preference === "match" ? effectiveAppTheme : preference;
}

export function applyDocumentTheme(root: HTMLElement, theme: DocumentThemeInput): void {
  root.dataset.theme = theme.appTheme;
  root.dataset.codeTheme = theme.codeTheme;
}

export function getTerminalTheme(theme: ResolvedTheme): ITheme {
  return themePalettes[theme].terminal;
}

export function getShikiTheme(theme: ResolvedTheme): "github-dark" | "github-light" {
  return theme === "dark" ? "github-dark" : "github-light";
}

export function getDiffTheme(theme: ResolvedTheme): "github-dark" | "github-light" {
  return theme === "dark" ? "github-dark" : "github-light";
}

export function getChartTheme(theme: ResolvedTheme): ChartTheme {
  return themePalettes[theme].chart;
}
