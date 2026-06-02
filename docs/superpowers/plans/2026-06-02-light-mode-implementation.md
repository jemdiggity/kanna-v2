# Light Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full desktop light mode support with persisted app and terminal/code theme preferences while keeping dark mode as the default.

**Architecture:** Theme preferences stay in the existing `settings` table and store state. `App.vue` applies resolved theme attributes to the document, while a small reactive theme runtime exposes `effectiveAppTheme` and `effectiveCodeTheme` to terminals, diff rendering, file preview, and charts. Desktop component CSS migrates from hard-coded dark colors to semantic `--kn-*` tokens defined in one stylesheet.

**Tech Stack:** Vue 3, Pinia, Vitest, Tauri SQL settings table, xterm.js, `@pierre/diffs`, Shiki, Chart.js, CSS custom properties.

---

## File Structure

- Create `apps/desktop/src/theme/types.ts`: theme preference types, constants, type guards.
- Create `apps/desktop/src/theme/theme.ts`: pure helpers for validation, resolution, document attributes, terminal palettes, Shiki/diff/chart colors.
- Create `apps/desktop/src/theme/runtime.ts`: Vue refs/computed values for current preferences and OS color-scheme state.
- Create `apps/desktop/src/theme/tokens.css`: desktop semantic color tokens for dark and light themes.
- Create `apps/desktop/src/theme/theme.test.ts`: unit tests for theme helpers and runtime-independent behavior.
- Modify `apps/desktop/src/main.ts`: import `tokens.css`.
- Modify `apps/desktop/src/App.vue`: load theme preferences, apply document attributes, watch system color scheme, pass preferences to `PreferencesPanel`.
- Modify `apps/desktop/src/stores/db.ts`: add `017_theme_preferences` migration.
- Modify `apps/desktop/src/stores/db.test.ts`: assert theme defaults are inserted by migration.
- Modify `apps/desktop/src/stores/state.ts`: add `appTheme` and `codeTheme` refs.
- Modify `apps/desktop/src/stores/init.ts`: load and validate theme settings.
- Modify `apps/desktop/src/stores/init.test.ts`: cover valid and invalid theme settings.
- Modify `apps/desktop/src/stores/kanna.ts`: expose theme refs.
- Modify `apps/desktop/src/components/PreferencesPanel.vue`: render app and terminal/code theme controls.
- Modify `apps/desktop/src/components/__tests__/PreferencesPanel.account.test.ts`: include new required preference props.
- Create `apps/desktop/src/components/__tests__/PreferencesPanel.theme.test.ts`: preferences theme-control tests.
- Modify `apps/desktop/src/i18n/locales/en.json`, `ja.json`, `ko.json`: add theme labels.
- Modify `apps/desktop/src/composables/useTerminal.ts`: use and watch effective code theme.
- Modify `apps/desktop/src/composables/useTerminal.test.ts`: assert initial and live xterm theme updates.
- Modify `apps/desktop/src/components/CloudTerminalView.vue`: use and watch terminal theme helper.
- Modify `apps/desktop/src/components/DiffView.vue`: use effective code theme for `@pierre/diffs` and worker options.
- Modify `apps/desktop/src/components/__tests__/DiffView.test.ts`: assert diff and worker theme selection.
- Modify `apps/desktop/src/components/FilePreviewModal.vue`: load/render Shiki with effective code theme.
- Modify `apps/desktop/src/components/__tests__/FilePreviewModal.test.ts`: assert Shiki theme selection.
- Modify `apps/desktop/src/components/AnalyticsModal.vue`: compute chart colors from theme helper.
- Modify visible desktop component styles listed in Task 5 to use `--kn-*` tokens.
- Modify `apps/desktop/tests/e2e/mock/preferences.test.ts`: cover persisted app/code theme changes.

## Token Mapping

Use this mapping when migrating component CSS. Add new semantic tokens only when none of these accurately describes the role.

| Existing literal role | Replace with |
| --- | --- |
| app/page background `#1a1a1a` | `var(--kn-bg-app)` |
| primary sidebar background `#1e1e1e` | `var(--kn-bg-sidebar)` |
| modal/panel background `#252525` | `var(--kn-bg-panel)` |
| raised/row background `#2a2a2a` | `var(--kn-bg-panel-raised)` |
| input/editor background `#1a1a1a` | `var(--kn-bg-input)` |
| hover background `#333`, `#333333` | `var(--kn-bg-hover)` |
| selected row background | `var(--kn-bg-selected)` |
| primary text `#e0e0e0`, `#e6edf3` | `var(--kn-text-primary)` |
| secondary text `#bbb`, `#ccc`, `#cccccc` | `var(--kn-text-secondary)` |
| muted text `#888`, `#8b98a8` | `var(--kn-text-muted)` |
| subtle border `#333`, `#30363d` | `var(--kn-border-default)` |
| stronger border `#444`, `#555` | `var(--kn-border-strong)` |
| primary blue `#0066cc`, `#4a90e2` | `var(--kn-accent)` |
| primary blue hover `#0077ee` | `var(--kn-accent-hover)` |
| danger red `#b62324`, `#f85149` | `var(--kn-danger)` |
| success green `#2ea043`, `#4ade80` | `var(--kn-success)` |
| warning yellow `#d29922`, `#ffc43d` | `var(--kn-warning)` |
| modal scrim `rgba(0, 0, 0, 0.6)` | `var(--kn-overlay-scrim)` |
| modal shadow `0 8px 32px rgba(0, 0, 0, 0.5)` | `var(--kn-shadow-modal)` |

---

### Task 1: Theme Helpers And Runtime

**Files:**
- Create: `apps/desktop/src/theme/types.ts`
- Create: `apps/desktop/src/theme/theme.ts`
- Create: `apps/desktop/src/theme/runtime.ts`
- Create: `apps/desktop/src/theme/tokens.css`
- Create: `apps/desktop/src/theme/theme.test.ts`
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Write the failing theme helper tests**

Create `apps/desktop/src/theme/theme.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the theme helper tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/theme/theme.test.ts
```

Expected: FAIL because `apps/desktop/src/theme/theme.ts` does not exist.

- [ ] **Step 3: Add theme types**

Create `apps/desktop/src/theme/types.ts`:

```ts
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
```

- [ ] **Step 4: Add pure theme helpers**

Create `apps/desktop/src/theme/theme.ts`:

```ts
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
```

- [ ] **Step 5: Add reactive theme runtime**

Create `apps/desktop/src/theme/runtime.ts`:

```ts
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
```

- [ ] **Step 6: Add semantic token stylesheet**

Create `apps/desktop/src/theme/tokens.css` with the tokens from the design spec, plus common utility tokens used by component migration:

```css
:root {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 400;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

:root,
:root[data-theme="dark"] {
  color-scheme: dark;
  color: #e0e0e0;
  background-color: #1a1a1a;
  --kn-bg-app: #1a1a1a;
  --kn-bg-sidebar: #1e1e1e;
  --kn-bg-panel: #252525;
  --kn-bg-panel-raised: #2a2a2a;
  --kn-bg-input: #1a1a1a;
  --kn-bg-hover: #333333;
  --kn-bg-selected: rgba(59, 142, 234, 0.28);
  --kn-bg-accent-subtle: rgba(0, 102, 204, 0.12);
  --kn-text-primary: #e0e0e0;
  --kn-text-secondary: #bbbbbb;
  --kn-text-muted: #888888;
  --kn-text-inverse: #ffffff;
  --kn-border-default: #333333;
  --kn-border-strong: #444444;
  --kn-accent: #0066cc;
  --kn-accent-hover: #0077ee;
  --kn-danger: #b62324;
  --kn-danger-bg: #2a1a1a;
  --kn-success: #2ea043;
  --kn-success-bg: rgba(74, 222, 128, 0.1);
  --kn-warning: #d29922;
  --kn-warning-bg: #2a2a1a;
  --kn-overlay-scrim: rgba(0, 0, 0, 0.6);
  --kn-shadow-modal: 0 8px 32px rgba(0, 0, 0, 0.5);
  --kn-terminal-bg: #1e1e1e;
  --kn-code-bg: #1a1a1a;
}

:root[data-theme="light"] {
  color-scheme: light;
  color: #1f2937;
  background-color: #ffffff;
  --kn-bg-app: #ffffff;
  --kn-bg-sidebar: #f4f6f8;
  --kn-bg-panel: #ffffff;
  --kn-bg-panel-raised: #f8fafc;
  --kn-bg-input: #ffffff;
  --kn-bg-hover: #edf2f7;
  --kn-bg-selected: #dcecff;
  --kn-bg-accent-subtle: rgba(11, 102, 195, 0.12);
  --kn-text-primary: #1f2937;
  --kn-text-secondary: #374151;
  --kn-text-muted: #687385;
  --kn-text-inverse: #ffffff;
  --kn-border-default: #d9dee5;
  --kn-border-strong: #c2cad4;
  --kn-accent: #0b66c3;
  --kn-accent-hover: #0a73dc;
  --kn-danger: #b42318;
  --kn-danger-bg: #fff1f0;
  --kn-success: #16803a;
  --kn-success-bg: rgba(22, 128, 58, 0.12);
  --kn-warning: #a15c07;
  --kn-warning-bg: #fff7df;
  --kn-overlay-scrim: rgba(15, 23, 42, 0.32);
  --kn-shadow-modal: 0 16px 42px rgba(20, 30, 45, 0.18);
  --kn-terminal-bg: #f8fafc;
  --kn-code-bg: #ffffff;
}
```

- [ ] **Step 7: Import tokens in the app entrypoint**

Modify `apps/desktop/src/main.ts`:

```ts
import "./theme/tokens.css";
```

Place it with the other top-level imports before `App` is mounted.

- [ ] **Step 8: Remove duplicate root theme primitives from `App.vue`**

In the global `<style>` block of `apps/desktop/src/App.vue`, remove the `:root` block or reduce it to non-theme layout reset if anything remains. The font/color/background definitions now live in `tokens.css`.

- [ ] **Step 9: Run the theme helper tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/theme/theme.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 1**

```bash
git add apps/desktop/src/theme apps/desktop/src/main.ts apps/desktop/src/App.vue
git commit -m "feat: add desktop theme helpers"
```

---

### Task 2: Settings, Store, Document Theme, Preferences UI

**Files:**
- Modify: `apps/desktop/src/stores/db.ts`
- Modify: `apps/desktop/src/stores/db.test.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/init.ts`
- Modify: `apps/desktop/src/stores/init.test.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/components/PreferencesPanel.vue`
- Modify: `apps/desktop/src/components/__tests__/PreferencesPanel.account.test.ts`
- Create: `apps/desktop/src/components/__tests__/PreferencesPanel.theme.test.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`

- [ ] **Step 1: Write failing DB migration test**

In `apps/desktop/src/stores/db.test.ts`, extend `createMigrationDb` with a `settings` array and handle `INSERT OR IGNORE INTO settings`. Add:

```ts
interface SettingRow {
  key: string;
  value: string;
}
```

Extend the returned fake DB shape:

```ts
settings: SettingRow[];
```

Inside `createMigrationDb`, add:

```ts
const settings: SettingRow[] = [];
```

In `execute`, before returning:

```ts
} else if (sql === "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)") {
  const [key, value] = bindValues as [string, string];
  if (!settings.some((setting) => setting.key === key)) {
    settings.push({ key, value });
  }
} else if (sql.startsWith("INSERT OR IGNORE INTO SETTINGS (KEY, VALUE) VALUES")) {
  const matches = [...query.matchAll(/\('([^']+)', '([^']+)'\)/g)];
  for (const [, key, value] of matches) {
    if (!settings.some((setting) => setting.key === key)) {
      settings.push({ key, value });
    }
  }
```

Add the test:

```ts
it("adds default theme preferences for existing databases", async () => {
  await runMigrations(db);

  expect(db.settings).toEqual(
    expect.arrayContaining([
      { key: "appTheme", value: "dark" },
      { key: "codeTheme", value: "match" },
    ]),
  );
  expect(db.schemaMigrations).toContainEqual({ id: "017_theme_preferences" });
});
```

- [ ] **Step 2: Run DB tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/db.test.ts
```

Expected: FAIL because `017_theme_preferences` has not been added.

- [ ] **Step 3: Add the DB migration**

In `apps/desktop/src/stores/db.ts`, after `016_task_teardown_state`, add:

```ts
  await runMigration("017_theme_preferences", async () => {
    await db.execute(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
      ["appTheme", "dark"],
    );
    await db.execute(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
      ["codeTheme", "match"],
    );
  });
```

- [ ] **Step 4: Run DB tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/db.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing store initialization tests**

In `apps/desktop/src/stores/init.test.ts`, import the mocked `getSetting`:

```ts
import { getSetting } from "@kanna/db";
```

Add this test:

```ts
it("loads valid theme preferences from settings", async () => {
  vi.mocked(getSetting).mockImplementation(async (_db, key) => {
    if (key === "appTheme") return "light";
    if (key === "codeTheme") return "dark";
    return null;
  });

  const state = createStoreState();
  const context = createStoreContext(state, {
    toasts: ref([]),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }, {});
  const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
    checkUnblocked: vi.fn(async () => {}),
    handleAgentFinished: vi.fn(),
    startBlockedTask: vi.fn(async () => {}),
    restoreUnblockedTask: vi.fn(async () => {}),
  } as unknown as Parameters<typeof createInitApi>[2]);

  await initApi.init(createDb());

  expect(state.appTheme.value).toBe("light");
  expect(state.codeTheme.value).toBe("dark");
});

it("falls back when stored theme preferences are invalid", async () => {
  vi.mocked(getSetting).mockImplementation(async (_db, key) => {
    if (key === "appTheme") return "sepia";
    if (key === "codeTheme") return "solarized";
    return null;
  });

  const state = createStoreState();
  const context = createStoreContext(state, {
    toasts: ref([]),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }, {});
  const initApi = createInitApi(context, {} as import("./ports").PortsStore, {
    checkUnblocked: vi.fn(async () => {}),
    handleAgentFinished: vi.fn(),
    startBlockedTask: vi.fn(async () => {}),
    restoreUnblockedTask: vi.fn(async () => {}),
  } as unknown as Parameters<typeof createInitApi>[2]);

  await initApi.init(createDb());

  expect(state.appTheme.value).toBe("dark");
  expect(state.codeTheme.value).toBe("match");
});
```

- [ ] **Step 6: Run store init tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/init.test.ts
```

Expected: FAIL because `state.appTheme` and `state.codeTheme` do not exist.

- [ ] **Step 7: Add theme refs to store state**

In `apps/desktop/src/stores/state.ts`, import theme types:

```ts
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  type AppThemePreference,
  type CodeThemePreference,
} from "../theme/theme";
```

Add to `StoreState`:

```ts
  appTheme: Ref<AppThemePreference>;
  codeTheme: Ref<CodeThemePreference>;
```

Add refs inside `createStoreState()`:

```ts
  const appTheme = ref<AppThemePreference>(DEFAULT_APP_THEME);
  const codeTheme = ref<CodeThemePreference>(DEFAULT_CODE_THEME);
```

Return them:

```ts
    appTheme,
    codeTheme,
```

- [ ] **Step 8: Load and expose theme preferences**

In `apps/desktop/src/stores/init.ts`, import:

```ts
import { normalizeAppThemePreference, normalizeCodeThemePreference } from "../theme/theme";
```

In `loadPreferences()`, after developer linger loading, add:

```ts
    const appTheme = await getSetting(context.requireDb(), "appTheme");
    context.state.appTheme.value = normalizeAppThemePreference(appTheme);
    const codeTheme = await getSetting(context.requireDb(), "codeTheme");
    context.state.codeTheme.value = normalizeCodeThemePreference(codeTheme);
```

In `apps/desktop/src/stores/kanna.ts`, expose:

```ts
    appTheme: state.appTheme,
    codeTheme: state.codeTheme,
```

- [ ] **Step 9: Run store init tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/init.test.ts
```

Expected: PASS.

- [ ] **Step 10: Write failing Preferences theme tests**

Create `apps/desktop/src/components/__tests__/PreferencesPanel.theme.test.ts`:

```ts
// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PreferencesPanel from "../PreferencesPanel.vue";

vi.mock("../../services/desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    subscribe: vi.fn((next) => {
      next({ status: "signedOut" });
      return () => undefined;
    }),
  })),
}));

vi.mock("../../invoke", () => ({
  invoke: vi.fn(async () => ({ state: "stopped" })),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function mountPreferences() {
  return mount(PreferencesPanel, {
    props: {
      preferences: {
        suspendAfterMinutes: 5,
        killAfterMinutes: 30,
        ideCommand: "code",
        locale: "en",
        devLingerTerminals: false,
        defaultAgentProvider: "claude",
        appTheme: "dark",
        codeTheme: "match",
      },
    },
    global: {
      mocks: {
        $t: (key: string) => key,
      },
    },
  });
}

describe("PreferencesPanel theme controls", () => {
  it("renders app and terminal/code theme selectors", () => {
    const wrapper = mountPreferences();

    const appTheme = wrapper.get('[data-testid="app-theme-select"]');
    const codeTheme = wrapper.get('[data-testid="code-theme-select"]');

    expect(appTheme.element).toHaveProperty("value", "dark");
    expect(codeTheme.element).toHaveProperty("value", "match");
    expect(wrapper.text()).toContain("preferences.theme");
    expect(wrapper.text()).toContain("preferences.codeTheme");
  });

  it("emits theme preference updates", async () => {
    const wrapper = mountPreferences();

    await wrapper.get('[data-testid="app-theme-select"]').setValue("light");
    await wrapper.get('[data-testid="code-theme-select"]').setValue("dark");

    expect(wrapper.emitted("update")).toContainEqual(["appTheme", "light"]);
    expect(wrapper.emitted("update")).toContainEqual(["codeTheme", "dark"]);
  });
});
```

- [ ] **Step 11: Run Preferences tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/PreferencesPanel.theme.test.ts
```

Expected: FAIL because `appTheme` and `codeTheme` props/selectors do not exist.

- [ ] **Step 12: Add Preferences props and controls**

In `apps/desktop/src/components/PreferencesPanel.vue`, import types:

```ts
import type { AppThemePreference, CodeThemePreference } from "../theme/theme";
```

Add to the `preferences` prop shape:

```ts
    appTheme: AppThemePreference
    codeTheme: CodeThemePreference
```

In the General tab, after the Language row, add:

```vue
        <div class="pref-row">
          <label>{{ $t('preferences.theme') }}</label>
          <select
            data-testid="app-theme-select"
            :value="preferences.appTheme"
            @change="emit('update', 'appTheme', ($event.target as HTMLSelectElement).value)"
          >
            <option value="system">{{ $t('preferences.themeSystem') }}</option>
            <option value="light">{{ $t('preferences.themeLight') }}</option>
            <option value="dark">{{ $t('preferences.themeDark') }}</option>
          </select>
        </div>

        <div class="pref-row">
          <label>{{ $t('preferences.codeTheme') }}</label>
          <select
            data-testid="code-theme-select"
            :value="preferences.codeTheme"
            @change="emit('update', 'codeTheme', ($event.target as HTMLSelectElement).value)"
          >
            <option value="match">{{ $t('preferences.codeThemeMatch') }}</option>
            <option value="light">{{ $t('preferences.codeThemeLight') }}</option>
            <option value="dark">{{ $t('preferences.codeThemeDark') }}</option>
          </select>
        </div>
```

In `apps/desktop/src/components/__tests__/PreferencesPanel.account.test.ts`, update `mountPreferences()` props:

```ts
        appTheme: "dark",
        codeTheme: "match",
```

- [ ] **Step 13: Add i18n labels**

In `apps/desktop/src/i18n/locales/en.json` under `preferences`, add:

```json
    "theme": "Theme",
    "themeSystem": "System",
    "themeLight": "Light",
    "themeDark": "Dark",
    "codeTheme": "Terminal & code theme",
    "codeThemeMatch": "Match app",
    "codeThemeLight": "Light",
    "codeThemeDark": "Dark"
```

In `apps/desktop/src/i18n/locales/ja.json` under `preferences`, add:

```json
    "theme": "テーマ",
    "themeSystem": "システム",
    "themeLight": "ライト",
    "themeDark": "ダーク",
    "codeTheme": "ターミナルとコードのテーマ",
    "codeThemeMatch": "アプリに合わせる",
    "codeThemeLight": "ライト",
    "codeThemeDark": "ダーク"
```

In `apps/desktop/src/i18n/locales/ko.json` under `preferences`, add:

```json
    "theme": "테마",
    "themeSystem": "시스템",
    "themeLight": "라이트",
    "themeDark": "다크",
    "codeTheme": "터미널 및 코드 테마",
    "codeThemeMatch": "앱에 맞춤",
    "codeThemeLight": "라이트",
    "codeThemeDark": "다크"
```

- [ ] **Step 14: Run Preferences tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/PreferencesPanel.theme.test.ts src/components/__tests__/PreferencesPanel.account.test.ts
```

Expected: PASS.

- [ ] **Step 15: Write failing App document-theme test**

In `apps/desktop/src/App.test.ts`, add `appTheme` and `codeTheme` to the `store` mock:

```ts
  appTheme: "dark",
  codeTheme: "match",
```

Add test:

```ts
  it("applies persisted light app theme and explicit dark code theme to the document", async () => {
    store.appTheme = "light";
    store.codeTheme = "dark";

    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.codeTheme).toBe("dark");

    wrapper.unmount();
    store.appTheme = "dark";
    store.codeTheme = "match";
  });
```

- [ ] **Step 16: Run App test and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/App.test.ts -t "applies persisted light app theme"
```

Expected: FAIL because App does not yet apply theme runtime/document attributes.

- [ ] **Step 17: Wire App theme state and OS system mode**

In `apps/desktop/src/App.vue`, import:

```ts
import {
  applyCurrentDocumentTheme,
  setSystemPrefersDark,
  setThemePreferences,
} from "./theme/runtime";
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  normalizeAppThemePreference,
  normalizeCodeThemePreference,
  resolveAppThemePreference,
  resolveCodeThemePreference,
  type AppThemePreference,
  type CodeThemePreference,
} from "./theme/theme";
```

Update local preferences:

```ts
const preferences = reactive({
  suspendAfterMinutes: 30,
  killAfterMinutes: 60,
  ideCommand: "code",
  locale: "en",
  devLingerTerminals: false,
  defaultAgentProvider: "claude" as AgentProvider,
  appTheme: DEFAULT_APP_THEME,
  codeTheme: DEFAULT_CODE_THEME,
});
```

Add helpers near the preferences handler:

```ts
let colorSchemeQuery: MediaQueryList | null = null;

function syncThemeRuntime() {
  setThemePreferences({
    appTheme: preferences.appTheme,
    codeTheme: preferences.codeTheme,
  });
  applyCurrentDocumentTheme();
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
  colorSchemeQuery.addEventListener("change", handleSystemThemeChange);
  syncThemeRuntime();
}

function stopSystemThemeListener() {
  colorSchemeQuery?.removeEventListener("change", handleSystemThemeChange);
  colorSchemeQuery = null;
}
```

In `handlePreferenceUpdate`, add:

```ts
  } else if (key === "appTheme") {
    preferences.appTheme = normalizeAppThemePreference(value);
    syncThemeRuntime();
  } else if (key === "codeTheme") {
    preferences.codeTheme = normalizeCodeThemePreference(value);
    syncThemeRuntime();
```

In `onMounted`, after store init/preference sync:

```ts
  preferences.appTheme = normalizeAppThemePreference(store.appTheme);
  preferences.codeTheme = normalizeCodeThemePreference(store.codeTheme);
  startSystemThemeListener();
```

In `onBeforeUnmount` or existing unmount cleanup, call:

```ts
  stopSystemThemeListener();
```

If no `onBeforeUnmount` is imported yet, add it to the Vue import and register the cleanup.

- [ ] **Step 18: Run App test and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/App.test.ts -t "applies persisted light app theme"
```

Expected: PASS.

- [ ] **Step 19: Run Task 2 focused tests**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/db.test.ts src/stores/init.test.ts src/components/__tests__/PreferencesPanel.theme.test.ts src/components/__tests__/PreferencesPanel.account.test.ts src/App.test.ts -t "theme|applies persisted light app theme|PreferencesPanel theme controls|account sign-in|runMigrations|createInitApi"
```

Expected: PASS.

- [ ] **Step 20: Commit Task 2**

```bash
git add apps/desktop/src/stores/db.ts apps/desktop/src/stores/db.test.ts apps/desktop/src/stores/state.ts apps/desktop/src/stores/init.ts apps/desktop/src/stores/init.test.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/App.vue apps/desktop/src/App.test.ts apps/desktop/src/components/PreferencesPanel.vue apps/desktop/src/components/__tests__/PreferencesPanel.account.test.ts apps/desktop/src/components/__tests__/PreferencesPanel.theme.test.ts apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/ja.json apps/desktop/src/i18n/locales/ko.json
git commit -m "feat: add theme preferences"
```

---

### Task 3: Terminal, Diff, File Preview, And Analytics Runtime Themes

**Files:**
- Modify: `apps/desktop/src/composables/useTerminal.ts`
- Modify: `apps/desktop/src/composables/useTerminal.test.ts`
- Modify: `apps/desktop/src/components/CloudTerminalView.vue`
- Modify: `apps/desktop/src/components/DiffView.vue`
- Modify: `apps/desktop/src/components/__tests__/DiffView.test.ts`
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`
- Modify: `apps/desktop/src/components/__tests__/FilePreviewModal.test.ts`
- Modify: `apps/desktop/src/components/AnalyticsModal.vue`

- [ ] **Step 1: Write failing useTerminal theme update test**

In `apps/desktop/src/composables/useTerminal.test.ts`, add `setOption` to `FakeTerminal`:

```ts
  setOption = vi.fn();
```

Add the test:

```ts
  it("updates xterm theme when the effective code theme changes", async () => {
    const { resetThemeRuntimeForTests, setSystemPrefersDark, setThemePreferences } = await import("../theme/runtime");
    resetThemeRuntimeForTests();
    setSystemPrefersDark(false);
    setThemePreferences({ appTheme: "dark", codeTheme: "match" });

    const { useTerminal } = await import("./useTerminal");
    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal("session-1");
        return { init };
      },
      render() {
        return h("div", { ref: "host" });
      },
    });

    const wrapper = mount(TestHarness);
    const element = wrapper.element as HTMLElement;
    (wrapper.vm as unknown as { init: (el: HTMLElement) => void }).init(element);

    expect(terminals.at(-1)?.setOption).not.toHaveBeenCalled();

    setThemePreferences({ appTheme: "light", codeTheme: "match" });
    await Promise.resolve();

    expect(terminals.at(-1)?.setOption).toHaveBeenCalledWith(
      "theme",
      expect.objectContaining({ background: "#f8fafc" }),
    );

    wrapper.unmount();
    resetThemeRuntimeForTests();
  });
```

- [ ] **Step 2: Run useTerminal test and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/composables/useTerminal.test.ts -t "updates xterm theme"
```

Expected: FAIL because `useTerminal` does not watch the runtime theme.

- [ ] **Step 3: Wire useTerminal to theme runtime**

In `apps/desktop/src/composables/useTerminal.ts`, import:

```ts
import { watch } from "vue";
import { getTerminalTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
```

If `watch` is already imported, merge it into the existing Vue import.

Inside `useTerminal`, before `init`, add:

```ts
  const { effectiveCodeTheme } = useThemeRuntime();
  let stopThemeWatch: (() => void) | null = null;
```

Change the `new Terminal` theme option to:

```ts
      theme: getTerminalTheme(effectiveCodeTheme.value),
```

After the terminal is created in `init`, add:

```ts
    stopThemeWatch?.();
    stopThemeWatch = watch(effectiveCodeTheme, (theme) => {
      terminal.value?.setOption("theme", getTerminalTheme(theme));
    });
```

In `dispose`, add:

```ts
    stopThemeWatch?.();
    stopThemeWatch = null;
```

- [ ] **Step 4: Run useTerminal test and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/composables/useTerminal.test.ts -t "updates xterm theme"
```

Expected: PASS.

- [ ] **Step 5: Write failing DiffView theme tests**

In `apps/desktop/src/components/__tests__/DiffView.test.ts`, extend the worker mock:

```ts
const workerPoolOptionsMock = vi.fn();
vi.mock("@pierre/diffs/worker", () => ({
  getOrCreateWorkerPoolSingleton: vi.fn((options) => {
    workerPoolOptionsMock(options);
    return {
      setRenderOptions: vi.fn(async () => {}),
    };
  }),
}));
```

If the existing mock returns `null`, replace it with this object and adjust expectations that assume `pool` can be null.

Add:

```ts
  it("uses the effective light code theme for diff rendering and worker highlighting", async () => {
    const { resetThemeRuntimeForTests, setSystemPrefersDark, setThemePreferences } = await import("../../theme/runtime");
    resetThemeRuntimeForTests();
    setSystemPrefersDark(false);
    setThemePreferences({ appTheme: "light", codeTheme: "match" });
    invokeMock.mockImplementation(async (command) => {
      if (command === "git_diff") return "diff --git a/example.ts b/example.ts";
      return "";
    });

    const wrapper = mount(DiffView, {
      props: {
        repoPath: "/repo",
        initialScope: "working",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(workerPoolOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        highlighterOptions: expect.objectContaining({ theme: "github-light" }),
      }),
    );
    expect(renderMock.mock.calls.at(-1)?.[0]).toBeDefined();

    wrapper.unmount();
    resetThemeRuntimeForTests();
  });
```

- [ ] **Step 6: Run DiffView test and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/DiffView.test.ts -t "effective light code theme"
```

Expected: FAIL because `DiffView` still passes `github-dark`.

- [ ] **Step 7: Wire DiffView to code theme**

In `apps/desktop/src/components/DiffView.vue`, import:

```ts
import { getDiffTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
```

Add:

```ts
const { effectiveCodeTheme } = useThemeRuntime();
const diffTheme = computed(() => getDiffTheme(effectiveCodeTheme.value));
```

Replace hard-coded `theme: "github-dark"` in worker options and `new FileDiff` with:

```ts
theme: diffTheme.value,
```

Update `initWorkerPool()` so if a worker pool already exists, it updates render options:

```ts
  if (workerPool) {
    await workerPool.setRenderOptions?.({
      theme: diffTheme.value,
      lineDiffType: "word",
    });
    return workerPool;
  }
```

Add a watcher:

```ts
watch(effectiveCodeTheme, () => {
  void initWorkerPool().then(() => {
    if (diffContent.value.trim()) {
      return loadDiff({ preserveCurrentScroll: true });
    }
  });
});
```

- [ ] **Step 8: Run DiffView test and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/DiffView.test.ts -t "effective light code theme"
```

Expected: PASS.

- [ ] **Step 9: Write failing FilePreview theme test**

In `apps/desktop/src/components/__tests__/FilePreviewModal.test.ts`, add:

```ts
  it("uses the effective light code theme for Shiki rendering", async () => {
    const { resetThemeRuntimeForTests, setSystemPrefersDark, setThemePreferences } = await import("../../theme/runtime");
    resetThemeRuntimeForTests();
    setSystemPrefersDark(false);
    setThemePreferences({ appTheme: "light", codeTheme: "match" });
    invokeMock.mockImplementation(async (command) => {
      if (command === "read_text_file") {
        return "const answer = 42;\n";
      }
      if (command === "run_script") {
        return "";
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = mount(FilePreviewModal, {
      props: {
        filePath: "example.ts",
        worktreePath: "/repo",
      },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(codeToHtmlMock).toHaveBeenCalledWith(
      "const answer = 42;\n",
      expect.objectContaining({ theme: "github-light" }),
    );

    wrapper.unmount();
    resetThemeRuntimeForTests();
  });
```

- [ ] **Step 10: Run FilePreview test and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/FilePreviewModal.test.ts -t "effective light code theme"
```

Expected: FAIL because FilePreview still passes `github-dark`.

- [ ] **Step 11: Wire FilePreviewModal to code theme**

In `apps/desktop/src/components/FilePreviewModal.vue`, import:

```ts
import { getShikiTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
```

Add:

```ts
const { effectiveCodeTheme } = useThemeRuntime();
const shikiTheme = computed(() => getShikiTheme(effectiveCodeTheme.value));
```

Change highlighter creation:

```ts
  highlighter = await createHighlighter({
    themes: ["github-dark", "github-light"],
    langs: [],
  });
```

Replace every `theme: "github-dark"` in the component with:

```ts
theme: shikiTheme.value
```

Add `effectiveCodeTheme` to the highlighted content watcher:

```ts
watch([content, currentLang, searchDecorations, effectiveCodeTheme], ([raw, lang, decos]) => {
```

Ensure decoration-only debounce still compares only raw/lang:

```ts
  if (raw !== prevContent || lang !== prevLang) {
```

- [ ] **Step 12: Run FilePreview test and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/FilePreviewModal.test.ts -t "effective light code theme"
```

Expected: PASS.

- [ ] **Step 13: Wire CloudTerminalView and AnalyticsModal**

In `apps/desktop/src/components/CloudTerminalView.vue`, import:

```ts
import { getTerminalTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
```

Add:

```ts
const { effectiveCodeTheme } = useThemeRuntime();
```

Replace the hard-coded terminal theme with:

```ts
    theme: getTerminalTheme(effectiveCodeTheme.value),
```

Add:

```ts
watch(effectiveCodeTheme, (theme) => {
  terminal?.setOption("theme", getTerminalTheme(theme));
});
```

In `apps/desktop/src/components/AnalyticsModal.vue`, import:

```ts
import { getChartTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
```

Add:

```ts
const { effectiveAppTheme } = useThemeRuntime();
const chartTheme = computed(() => getChartTheme(effectiveAppTheme.value));
```

Change `lineChartOptions` to computed:

```ts
const lineChartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    intersect: false,
    mode: "index" as const,
  },
  plugins: {
    legend: { labels: { color: chartTheme.value.label } },
    tooltip: {
      backgroundColor: chartTheme.value.tooltipBackground,
      borderColor: chartTheme.value.tooltipBorder,
      borderWidth: 1,
      titleColor: chartTheme.value.tooltipText,
      bodyColor: chartTheme.value.tooltipText,
    },
  },
  scales: {
    x: { ticks: { color: chartTheme.value.label }, grid: { color: chartTheme.value.grid } },
    y: { ticks: { color: chartTheme.value.label, stepSize: 1 }, grid: { color: chartTheme.value.grid }, beginAtZero: true },
  },
}));
```

In chart data inline bindings, replace literals:

```ts
borderColor: chartTheme.createdLine
backgroundColor: chartTheme.createdFill
borderColor: chartTheme.closedLine
backgroundColor: chartTheme.closedFill
```

Template refs unwrap computed values, so `chartTheme.createdLine` is valid in the template.

- [ ] **Step 14: Run focused runtime tests**

Run:

```bash
pnpm --dir apps/desktop test -- src/composables/useTerminal.test.ts src/components/__tests__/DiffView.test.ts src/components/__tests__/FilePreviewModal.test.ts -t "theme|effective light code theme|updates xterm theme"
```

Expected: PASS.

- [ ] **Step 15: Commit Task 3**

```bash
git add apps/desktop/src/composables/useTerminal.ts apps/desktop/src/composables/useTerminal.test.ts apps/desktop/src/components/CloudTerminalView.vue apps/desktop/src/components/DiffView.vue apps/desktop/src/components/__tests__/DiffView.test.ts apps/desktop/src/components/FilePreviewModal.vue apps/desktop/src/components/__tests__/FilePreviewModal.test.ts apps/desktop/src/components/AnalyticsModal.vue
git commit -m "feat: theme terminal and code surfaces"
```

---

### Task 4: Full Desktop CSS Token Migration

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/components/AddRepoModal.vue`
- Modify: `apps/desktop/src/components/AgentView.vue`
- Modify: `apps/desktop/src/components/AnalyticsModal.vue`
- Modify: `apps/desktop/src/components/AppUpdatePrompt.vue`
- Modify: `apps/desktop/src/components/BaseBranchDropdownPreview.vue`
- Modify: `apps/desktop/src/components/BlockerSelectModal.vue`
- Modify: `apps/desktop/src/components/CloudTerminalView.vue`
- Modify: `apps/desktop/src/components/CommandPaletteModal.vue`
- Modify: `apps/desktop/src/components/CommitGraphModal.vue`
- Modify: `apps/desktop/src/components/CommitGraphView.vue`
- Modify: `apps/desktop/src/components/DiffModal.vue`
- Modify: `apps/desktop/src/components/DiffView.vue`
- Modify: `apps/desktop/src/components/FilePickerModal.vue`
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`
- Modify: `apps/desktop/src/components/IncomingTransferModal.vue`
- Modify: `apps/desktop/src/components/KeyboardShortcutsModal.vue`
- Modify: `apps/desktop/src/components/MainPanel.vue`
- Modify: `apps/desktop/src/components/MobileAccessPanel.vue`
- Modify: `apps/desktop/src/components/NewTaskModal.vue`
- Modify: `apps/desktop/src/components/PeerPickerModal.vue`
- Modify: `apps/desktop/src/components/PreferencesPanel.vue`
- Modify: `apps/desktop/src/components/ShellModal.vue`
- Modify: `apps/desktop/src/components/Sidebar.vue`
- Modify: `apps/desktop/src/components/TaskHeader.vue`
- Modify: `apps/desktop/src/components/TerminalTabs.vue`
- Modify: `apps/desktop/src/components/TerminalView.vue`
- Modify: `apps/desktop/src/components/ToastContainer.vue`
- Modify: `apps/desktop/src/components/TreeExplorerModal.vue`

- [ ] **Step 1: Capture the remaining color literal inventory**

Run:

```bash
rg -n "#[0-9a-fA-F]{3,8}|rgba?\\(|hsla?\\(|github-dark|background:|color:|border.*#|box-shadow" apps/desktop/src --glob '!**/*.test.ts' --glob '!**/__tests__/**' > /tmp/kanna-theme-color-inventory.txt
```

Expected: file contains the current inventory. Use it as the migration checklist.

- [ ] **Step 2: Migrate shell, sidebar, and main panel styles**

Use the token mapping table to replace hard-coded colors in:

```txt
apps/desktop/src/App.vue
apps/desktop/src/components/Sidebar.vue
apps/desktop/src/components/MainPanel.vue
apps/desktop/src/components/TerminalTabs.vue
apps/desktop/src/components/TerminalView.vue
apps/desktop/src/components/TaskHeader.vue
```

Required replacements include:

```css
background: var(--kn-bg-app);
background: var(--kn-bg-sidebar);
background: var(--kn-bg-panel);
background: var(--kn-bg-panel-raised);
background: var(--kn-bg-hover);
background: var(--kn-bg-selected);
color: var(--kn-text-primary);
color: var(--kn-text-secondary);
color: var(--kn-text-muted);
border-color: var(--kn-border-default);
border-color: var(--kn-border-strong);
background: var(--kn-accent);
background: var(--kn-accent-hover);
```

For terminal wrappers, use:

```css
background: var(--kn-terminal-bg);
```

- [ ] **Step 3: Migrate modal and picker styles**

Use the token mapping table in:

```txt
apps/desktop/src/components/AddRepoModal.vue
apps/desktop/src/components/BlockerSelectModal.vue
apps/desktop/src/components/CommandPaletteModal.vue
apps/desktop/src/components/DiffModal.vue
apps/desktop/src/components/FilePickerModal.vue
apps/desktop/src/components/FilePreviewModal.vue
apps/desktop/src/components/IncomingTransferModal.vue
apps/desktop/src/components/KeyboardShortcutsModal.vue
apps/desktop/src/components/NewTaskModal.vue
apps/desktop/src/components/PeerPickerModal.vue
apps/desktop/src/components/PreferencesPanel.vue
apps/desktop/src/components/ShellModal.vue
apps/desktop/src/components/TreeExplorerModal.vue
```

Required modal shell pattern:

```css
.modal-overlay {
  background: var(--kn-overlay-scrim);
}

.modal,
.prefs-panel,
.preview-modal,
.command-palette,
.file-picker,
.tree-explorer {
  background: var(--kn-bg-panel);
  border-color: var(--kn-border-strong);
  color: var(--kn-text-primary);
  box-shadow: var(--kn-shadow-modal);
}
```

Inputs/selects use:

```css
background: var(--kn-bg-input);
border-color: var(--kn-border-strong);
color: var(--kn-text-primary);
```

- [ ] **Step 4: Migrate specialized surfaces**

Use semantic tokens in:

```txt
apps/desktop/src/components/AgentView.vue
apps/desktop/src/components/AnalyticsModal.vue
apps/desktop/src/components/AppUpdatePrompt.vue
apps/desktop/src/components/BaseBranchDropdownPreview.vue
apps/desktop/src/components/CloudTerminalView.vue
apps/desktop/src/components/CommitGraphModal.vue
apps/desktop/src/components/CommitGraphView.vue
apps/desktop/src/components/DiffView.vue
apps/desktop/src/components/MobileAccessPanel.vue
apps/desktop/src/components/ToastContainer.vue
```

Status backgrounds should use:

```css
background: var(--kn-success-bg);
background: var(--kn-danger-bg);
background: var(--kn-warning-bg);
color: var(--kn-success);
color: var(--kn-danger);
color: var(--kn-warning);
```

Code/file preview backgrounds should use:

```css
background: var(--kn-code-bg);
```

- [ ] **Step 5: Remove dark-only inline styles where possible**

In `apps/desktop/src/components/DiffView.vue`, replace `header.style.*` color assignments with CSS classes:

```ts
  header.className = "diff-file-header";
```

Add scoped CSS:

```css
.diff-file-header {
  position: sticky;
  top: -1px;
  z-index: 2;
  padding: 7px 12px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-panel);
  color: var(--kn-text-primary);
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
```

- [ ] **Step 6: Scan for remaining dark literals**

Run:

```bash
rg -n "#1a1a1a|#1e1e1e|#252525|#2a2a2a|#333|#444|#555|#888|#bbb|#ccc|#e0e0e0|#0066cc|#0077ee|rgba\\(0, 0, 0, 0\\.6\\)|github-dark" apps/desktop/src --glob '!**/*.test.ts' --glob '!**/__tests__/**'
```

Expected: remaining matches are only acceptable runtime palette definitions in `apps/desktop/src/theme/theme.ts`, token definitions in `apps/desktop/src/theme/tokens.css`, Shiki theme loading in `FilePreviewModal.vue`, or test utility `PtyTest.vue`. Any component style match in the listed migration files must be converted.

- [ ] **Step 7: Run component tests likely affected by class/style changes**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/DiffView.test.ts src/components/__tests__/FilePreviewModal.test.ts src/components/__tests__/Sidebar.test.ts src/components/__tests__/MainPanel.test.ts src/components/__tests__/KeyboardShortcutsModal.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/components
git commit -m "feat: migrate desktop styles to theme tokens"
```

---

### Task 5: E2E Preferences Coverage

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/preferences.test.ts`

- [ ] **Step 1: Write failing E2E preference test**

In `apps/desktop/tests/e2e/mock/preferences.test.ts`, add:

```ts
  it("persists app and terminal code theme preferences", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);

    await client.executeSync(`
      const appTheme = document.querySelector('[data-testid="app-theme-select"]');
      const codeTheme = document.querySelector('[data-testid="code-theme-select"]');
      appTheme.value = "light";
      appTheme.dispatchEvent(new Event("change", { bubbles: true }));
      codeTheme.value = "dark";
      codeTheme.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        theme: document.documentElement.dataset.theme,
        codeTheme: document.documentElement.dataset.codeTheme,
      };
    `);

    const attrs = await client.executeSync<{ theme?: string; codeTheme?: string }>(`
      return {
        theme: document.documentElement.dataset.theme,
        codeTheme: document.documentElement.dataset.codeTheme,
      };
    `);
    expect(attrs).toEqual({ theme: "light", codeTheme: "dark" });

    await client.executeSync(buildSelectorKeydownScript(".modal-overlay", { key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);
    await client.deleteSession();
    await client.createSession();

    const persisted = await client.executeSync<{ appTheme?: string; codeTheme?: string }>(`
      return window.__KANNA_E2E__?.setupState
        ? {
            appTheme: window.__KANNA_E2E__.setupState.store?.appTheme,
            codeTheme: window.__KANNA_E2E__.setupState.store?.codeTheme,
          }
        : {};
    `);
    expect(persisted).toEqual({ appTheme: "light", codeTheme: "dark" });
  });
```

- [ ] **Step 2: Run mock preferences E2E and verify RED**

Start the app if needed:

```bash
./kd dev up
```

Run:

```bash
pnpm --dir apps/desktop test:e2e -- preferences.test.ts
```

Expected before implementation: FAIL because theme selectors/attributes do not exist. Expected after Tasks 1-4: PASS. If the `test:e2e` runner does not accept a filename argument, run:

```bash
pnpm --dir apps/desktop test:e2e
```

and inspect the preferences test result.

- [ ] **Step 3: Adjust E2E access if setupState unwraps refs differently**

If the persistence assertion returns refs instead of strings, use this exact helper inside the E2E script:

```js
const unwrap = (value) => value && value.__v_isRef ? value.value : value;
return {
  appTheme: unwrap(window.__KANNA_E2E__.setupState.store?.appTheme),
  codeTheme: unwrap(window.__KANNA_E2E__.setupState.store?.codeTheme),
};
```

- [ ] **Step 4: Run E2E and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test:e2e
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add apps/desktop/tests/e2e/mock/preferences.test.ts
git commit -m "test: cover theme preferences e2e"
```

---

### Task 6: Full Verification And Visual Smoke

**Files:**
- No new files unless verification reveals a defect.

- [ ] **Step 1: Run focused unit suites**

```bash
pnpm --dir apps/desktop test -- src/theme/theme.test.ts src/stores/db.test.ts src/stores/init.test.ts src/components/__tests__/PreferencesPanel.theme.test.ts src/components/__tests__/PreferencesPanel.account.test.ts src/composables/useTerminal.test.ts src/components/__tests__/DiffView.test.ts src/components/__tests__/FilePreviewModal.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run desktop build**

```bash
pnpm --dir apps/desktop build
```

Expected: PASS.

- [ ] **Step 3: Start the dev app through kd**

```bash
./kd dev up
```

Expected: tmux dev session starts or is already running. Do not use `pnpm run dev` directly.

- [ ] **Step 4: Run mock E2E**

```bash
pnpm --dir apps/desktop test:e2e
```

Expected: PASS.

- [ ] **Step 5: Manually smoke the theme combinations**

Use Preferences in the running app:

1. Set `Theme = Dark`, `Terminal & code theme = Match app`.
2. Set `Theme = Light`, `Terminal & code theme = Match app`.
3. Set `Theme = Light`, `Terminal & code theme = Dark`.
4. Open sidebar, main task view, Preferences, command palette, file picker, tree explorer, diff modal, file preview, shell modal, analytics modal.
5. Confirm text remains legible, selected rows are clear, and terminal/code surfaces follow the selected code theme.

- [ ] **Step 6: Final status**

Run:

```bash
git status --short
```

Expected: clean worktree after commits, or only intentional uncommitted fixes if verification found issues.
