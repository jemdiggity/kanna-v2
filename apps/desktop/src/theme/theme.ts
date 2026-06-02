import type { ITheme } from "@xterm/xterm";
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

export interface ChartTheme {
  label: string;
  grid: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipText: string;
  createdLine: string;
  createdFill: string;
  closedLine: string;
  closedFill: string;
}

const terminalThemes: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#1e1e1e",
    foreground: "#cccccc",
    cursor: "#aeafad",
    selectionBackground: "#264f78",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
  light: {
    background: "#f8fafc",
    foreground: "#253044",
    cursor: "#1f2937",
    selectionBackground: "#bfdbfe",
    black: "#1f2937",
    red: "#b42318",
    green: "#16803a",
    yellow: "#a15c07",
    blue: "#0b66c3",
    magenta: "#8b3d9b",
    cyan: "#087990",
    white: "#f8fafc",
    brightBlack: "#687385",
    brightRed: "#d92d20",
    brightGreen: "#1a9a4b",
    brightYellow: "#b7791f",
    brightBlue: "#0a73dc",
    brightMagenta: "#a855f7",
    brightCyan: "#0891b2",
    brightWhite: "#ffffff",
  },
};

const chartThemes: Record<ResolvedTheme, ChartTheme> = {
  dark: {
    label: "#888888",
    grid: "#333333",
    tooltipBackground: "#1e1e1e",
    tooltipBorder: "#444444",
    tooltipText: "#cccccc",
    createdLine: "#0066cc",
    createdFill: "rgba(0, 102, 204, 0.1)",
    closedLine: "#2ea043",
    closedFill: "rgba(46, 160, 67, 0.1)",
  },
  light: {
    label: "#687385",
    grid: "#d9dee5",
    tooltipBackground: "#ffffff",
    tooltipBorder: "#c2cad4",
    tooltipText: "#1f2937",
    createdLine: "#0b66c3",
    createdFill: "rgba(11, 102, 195, 0.12)",
    closedLine: "#16803a",
    closedFill: "rgba(22, 128, 58, 0.12)",
  },
};

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
  return terminalThemes[theme];
}

export function getShikiTheme(theme: ResolvedTheme): "github-dark" | "github-light" {
  return theme === "dark" ? "github-dark" : "github-light";
}

export function getDiffTheme(theme: ResolvedTheme): "github-dark" | "github-light" {
  return theme === "dark" ? "github-dark" : "github-light";
}

export function getChartTheme(theme: ResolvedTheme): ChartTheme {
  return chartThemes[theme];
}
