// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  applyDocumentTheme,
  getChartTheme,
  getDiffTheme,
  getShikiTheme,
  getTerminalTheme,
  normalizeAppThemePreference,
  normalizeCodeThemePreference,
  resolveAppThemePreference,
  resolveCodeThemePreference,
} from "./theme";

describe("theme helpers", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-code-theme");
  });

  it("uses dark app theme and matching code theme defaults", () => {
    expect(DEFAULT_APP_THEME).toBe("dark");
    expect(DEFAULT_CODE_THEME).toBe("match");
  });

  it("normalizes invalid persisted preferences to defaults", () => {
    expect(normalizeAppThemePreference("light")).toBe("light");
    expect(normalizeAppThemePreference("system")).toBe("system");
    expect(normalizeAppThemePreference("sepia")).toBe("dark");
    expect(normalizeAppThemePreference(null)).toBe("dark");

    expect(normalizeCodeThemePreference("light")).toBe("light");
    expect(normalizeCodeThemePreference("match")).toBe("match");
    expect(normalizeCodeThemePreference("solarized")).toBe("match");
    expect(normalizeCodeThemePreference(undefined)).toBe("match");
  });

  it("resolves system app theme from the OS dark preference", () => {
    expect(resolveAppThemePreference("dark", false)).toBe("dark");
    expect(resolveAppThemePreference("light", true)).toBe("light");
    expect(resolveAppThemePreference("system", true)).toBe("dark");
    expect(resolveAppThemePreference("system", false)).toBe("light");
  });

  it("resolves code theme from the app theme when matching", () => {
    expect(resolveCodeThemePreference("match", "light")).toBe("light");
    expect(resolveCodeThemePreference("match", "dark")).toBe("dark");
    expect(resolveCodeThemePreference("light", "dark")).toBe("light");
    expect(resolveCodeThemePreference("dark", "light")).toBe("dark");
  });

  it("applies resolved theme attributes to the document root", () => {
    applyDocumentTheme(document.documentElement, {
      appTheme: "light",
      codeTheme: "dark",
    });

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.codeTheme).toBe("dark");
  });

  it("returns runtime themes for terminal, diff, shiki, and charts", () => {
    expect(getTerminalTheme("dark")).toMatchObject({
      background: "#1e1e1e",
      foreground: "#cccccc",
    });
    expect(getTerminalTheme("light")).toMatchObject({
      background: "#f8fafc",
      foreground: "#253044",
    });
    expect(getShikiTheme("dark")).toBe("github-dark");
    expect(getShikiTheme("light")).toBe("github-light");
    expect(getDiffTheme("dark")).toBe("github-dark");
    expect(getDiffTheme("light")).toBe("github-light");
    expect(getChartTheme("light").grid).toBe("#d9dee5");
    expect(getChartTheme("dark").tooltipBackground).toBe("#1e1e1e");
  });
});
