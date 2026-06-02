# Light Mode Design

## Summary

Kanna will support a full light mode through a desktop-wide theme token system rather than a narrow override layer. Dark mode remains the default for new and existing installs. Users can choose the app theme independently from terminal and code-rendering surfaces.

The light visual direction is a crisp utility palette: neutral whites, cool grays, clear blue accent, and dense desktop-tool contrast. The design applies to visible desktop UI under `apps/desktop/src`, including app shell, modals, sidebars, terminal surfaces, diff viewer, file preview, charts, and status UI. Mobile and Tauri native window chrome are out of scope except for setting the browser `color-scheme` and document attributes.

## Goals

- Add `System / Light / Dark` app theme support.
- Keep `Dark` as the persisted default.
- Add a separate `Match app / Light / Dark` preference for terminal and code surfaces.
- Replace hard-coded desktop UI colors with semantic design tokens.
- Keep current dark mode visually close to the existing app while routing colors through tokens.
- Make light mode usable across the full desktop UI, not just the main shell.

## Non-Goals

- No mobile app theme work in this change.
- No complete redesign of layout, typography, or component structure.
- No per-repository or per-task theme preferences.
- No pixel-perfect guarantee that dark mode is unchanged; the priority is coherent theming with minimal visual drift.

## User Preferences

Two persisted settings will be added to the existing `settings` table:

| Setting | Values | Default |
| --- | --- | --- |
| `appTheme` | `dark`, `light`, `system` | `dark` |
| `codeTheme` | `match`, `dark`, `light` | `match` |

Effective theme resolution:

```ts
type AppThemePreference = "dark" | "light" | "system";
type CodeThemePreference = "match" | "dark" | "light";
type ResolvedTheme = "dark" | "light";

function resolveAppThemePreference(
  preference: AppThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

function resolveCodeThemePreference(
  preference: CodeThemePreference,
  effectiveAppTheme: ResolvedTheme,
): ResolvedTheme {
  return preference === "match" ? effectiveAppTheme : preference;
}
```

Invalid persisted values fall back to defaults: `appTheme = dark`, `codeTheme = match`.

## Preferences UI

`PreferencesPanel.vue` will add two rows in the General tab:

- `Theme`: System, Light, Dark
- `Terminal & code theme`: Match app, Light, Dark

Both controls use the existing preferences update flow:

```ts
emit("update", "appTheme", selectedValue);
emit("update", "codeTheme", selectedValue);
```

Changes apply immediately and persist through the existing store `savePreference` path.

## Theme Application

`App.vue` owns document-level theme application. It tracks:

- persisted `appTheme`
- persisted `codeTheme`
- OS color-scheme preference through `window.matchMedia("(prefers-color-scheme: dark)")`
- computed `effectiveAppTheme`
- computed `effectiveCodeTheme`

The document root gets stable attributes:

```html
<html data-theme="light" data-code-theme="dark">
```

`data-theme` drives CSS variables. `data-code-theme` is available for CSS selectors, but terminal, diff, Shiki, and chart surfaces use central JavaScript theme helpers where they need runtime objects.

The document also receives `color-scheme: dark` or `color-scheme: light` through tokens so native inputs, scrollbars, and browser-provided controls align with the effective app theme.

When `appTheme` is `system`, changes to the OS color scheme update document attributes without app restart.

## Theme Module

Create a focused theme package:

```txt
apps/desktop/src/theme/types.ts
apps/desktop/src/theme/theme.ts
apps/desktop/src/theme/tokens.css
apps/desktop/src/theme/theme.test.ts
```

`types.ts` defines preference and resolved-theme types plus constants:

```ts
export const DEFAULT_APP_THEME: AppThemePreference = "dark";
export const DEFAULT_CODE_THEME: CodeThemePreference = "match";
```

`theme.ts` exports:

- validation helpers for persisted preference values
- effective theme resolution helpers
- document application helper
- terminal theme palettes for xterm
- Shiki theme names
- diff theme names
- chart color helpers

`tokens.css` defines semantic variables under `:root[data-theme="dark"]` and `:root[data-theme="light"]`.

## CSS Tokens

Tokens should describe UI roles rather than literal colors. The initial token set should cover all existing desktop component color needs:

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

:root[data-theme="dark"] {
  color-scheme: dark;
  --kn-bg-app: #1a1a1a;
  --kn-bg-sidebar: #1e1e1e;
  --kn-bg-panel: #252525;
  --kn-bg-panel-raised: #2a2a2a;
  --kn-bg-input: #1a1a1a;
  --kn-bg-hover: #333333;
  --kn-bg-selected: rgba(59, 142, 234, 0.28);
  --kn-text-primary: #e0e0e0;
  --kn-text-secondary: #bbbbbb;
  --kn-text-muted: #888888;
  --kn-border-default: #333333;
  --kn-border-strong: #444444;
  --kn-accent: #0066cc;
  --kn-accent-hover: #0077ee;
  --kn-danger: #b62324;
  --kn-success: #2ea043;
  --kn-warning: #d29922;
  --kn-overlay-scrim: rgba(0, 0, 0, 0.6);
  --kn-shadow-modal: 0 8px 32px rgba(0, 0, 0, 0.5);
}

:root[data-theme="light"] {
  color-scheme: light;
  --kn-bg-app: #ffffff;
  --kn-bg-sidebar: #f4f6f8;
  --kn-bg-panel: #ffffff;
  --kn-bg-panel-raised: #f8fafc;
  --kn-bg-input: #ffffff;
  --kn-bg-hover: #edf2f7;
  --kn-bg-selected: #dcecff;
  --kn-text-primary: #1f2937;
  --kn-text-secondary: #374151;
  --kn-text-muted: #687385;
  --kn-border-default: #d9dee5;
  --kn-border-strong: #c2cad4;
  --kn-accent: #0b66c3;
  --kn-accent-hover: #0a73dc;
  --kn-danger: #b42318;
  --kn-success: #16803a;
  --kn-warning: #a15c07;
  --kn-overlay-scrim: rgba(15, 23, 42, 0.32);
  --kn-shadow-modal: 0 16px 42px rgba(20, 30, 45, 0.18);
}
```

The implementation can add more tokens as hard-coded colors are removed, but new tokens must remain semantic. Avoid `--kn-gray-300` style palette tokens in component CSS.

## Component Migration

Replace hard-coded colors across visible desktop UI:

- `App.vue`
- `Sidebar.vue`
- `MainPanel.vue`
- `TerminalTabs.vue`
- `TerminalView.vue`
- `ShellModal.vue`
- `DiffModal.vue`
- `DiffView.vue`
- `FilePickerModal.vue`
- `FilePreviewModal.vue`
- `TreeExplorerModal.vue`
- `NewTaskModal.vue`
- `AddRepoModal.vue`
- `PreferencesPanel.vue`
- `KeyboardShortcutsModal.vue`
- `CommandPaletteModal.vue`
- `BlockerSelectModal.vue`
- `AnalyticsModal.vue`
- `CommitGraphModal.vue`
- `CommitGraphView.vue`
- `TaskHeader.vue`
- `ToastContainer.vue`
- `AppUpdatePrompt.vue`
- `IncomingTransferModal.vue`
- `PeerPickerModal.vue`
- `MobileAccessPanel.vue`
- `AgentView.vue`
- `CloudTerminalView.vue`

Inline style assignments in rendering code should move to CSS classes or use `var(...)` values where inline styles are unavoidable. Component-specific visual states such as selected, hover, disabled, error, warning, success, active search match, and blocked task states should map to semantic tokens.

`PtyTest.vue` is test utility UI and can be handled opportunistically; it is not required for release-ready theme coverage.

## Terminal And Code Surfaces

Terminal and code surfaces follow `effectiveCodeTheme`, not necessarily `effectiveAppTheme`.

`useTerminal.ts`:

- Replace hard-coded xterm theme with `getTerminalTheme(effectiveCodeTheme)`.
- Watch effective code theme and call `terminal.setOption("theme", theme)` for live updates.
- Keep existing terminal lifecycle, reconnect, and fit behavior unchanged.

`CloudTerminalView.vue`:

- Use the same terminal theme helper.
- Update theme reactively when the setting changes.

`DiffView.vue`:

- Use `getDiffTheme(effectiveCodeTheme)` for `@pierre/diffs`.
- Initialize or refresh worker-pool highlighter options with the selected theme.
- Use CSS variables for sticky file headers and viewer chrome.
- Re-render existing diff content when code theme changes so syntax colors update.

`FilePreviewModal.vue`:

- Load both `github-dark` and `github-light` Shiki themes.
- Render raw code, fenced markdown code, and markdown preview code blocks with `getShikiTheme(effectiveCodeTheme)`.
- Re-render highlighted content when code theme changes.

`AnalyticsModal.vue`:

- Use chart colors from the central theme helper for tooltips, labels, gridlines, fills, and borders.
- Update charts when effective app theme changes.

## Store And Database Flow

`apps/desktop/src/stores/db.ts` will add a new migration after the current latest migration so existing databases receive the new defaults. The existing `001_default_settings` migration must not be edited as the only change because it has already run for existing users.

```sql
INSERT OR IGNORE INTO settings (key, value) VALUES ('appTheme', 'dark');
INSERT OR IGNORE INTO settings (key, value) VALUES ('codeTheme', 'match');
```

`apps/desktop/src/stores/state.ts` adds refs:

```ts
appTheme: Ref<AppThemePreference>;
codeTheme: Ref<CodeThemePreference>;
```

`apps/desktop/src/stores/init.ts` loads and validates both values. Invalid settings are not allowed to leak into app state.

`App.vue` includes both values in its local Preferences reactive object and handles updates alongside existing settings.

## Internationalization

Add preference labels and option labels to all desktop locales:

- `apps/desktop/src/i18n/locales/en.json`
- `apps/desktop/src/i18n/locales/ja.json`
- `apps/desktop/src/i18n/locales/ko.json`

English keys:

```json
{
  "preferences": {
    "theme": "Theme",
    "themeSystem": "System",
    "themeLight": "Light",
    "themeDark": "Dark",
    "codeTheme": "Terminal & code theme",
    "codeThemeMatch": "Match app",
    "codeThemeLight": "Light",
    "codeThemeDark": "Dark"
  }
}
```

Japanese and Korean translations should use these concise local-language labels.

Japanese labels:

```json
{
  "preferences": {
    "theme": "テーマ",
    "themeSystem": "システム",
    "themeLight": "ライト",
    "themeDark": "ダーク",
    "codeTheme": "ターミナルとコードのテーマ",
    "codeThemeMatch": "アプリに合わせる",
    "codeThemeLight": "ライト",
    "codeThemeDark": "ダーク"
  }
}
```

Korean labels:

```json
{
  "preferences": {
    "theme": "테마",
    "themeSystem": "시스템",
    "themeLight": "라이트",
    "themeDark": "다크",
    "codeTheme": "터미널 및 코드 테마",
    "codeThemeMatch": "앱에 맞춤",
    "codeThemeLight": "라이트",
    "codeThemeDark": "다크"
  }
}
```

## Testing

Unit coverage:

- Theme helper tests for defaults, validation, explicit light/dark, system resolution, code theme matching, and invalid persisted values.
- Store initialization tests for loading `appTheme` and `codeTheme`.
- Preferences component tests that both controls render and emit `appTheme` and `codeTheme`.
- Terminal tests that xterm receives the selected terminal palette and updates live.
- Diff tests that the selected diff theme reaches `FileDiff` and worker options.
- File preview tests that Shiki receives the selected theme for raw code and markdown-rendered code.
- Analytics tests where practical for chart color helper use.

E2E coverage:

- Open Preferences.
- Switch app theme to Light.
- Assert `document.documentElement.dataset.theme === "light"`.
- Switch terminal/code theme to Dark while app theme remains Light.
- Assert `document.documentElement.dataset.codeTheme === "dark"`.
- Reload or remount through the mock harness and verify settings persist.

Manual smoke:

- Main task view in dark and light.
- Sidebar task states: pinned, active, PR, merge, blocked, unread, working.
- Preferences, command palette, file picker, tree explorer, diff modal, file preview, shell modal, analytics modal.
- Mixed mode: light app with dark terminal/code.
- System mode reacts to OS color-scheme changes.

Verification commands:

```bash
pnpm --dir apps/desktop test -- theme
pnpm --dir apps/desktop test -- PreferencesPanel
pnpm --dir apps/desktop test -- useTerminal
pnpm --dir apps/desktop test -- DiffView
pnpm --dir apps/desktop test -- FilePreviewModal
pnpm --dir apps/desktop build
```

Run mock E2E preference coverage after starting the dev app with `./kd dev up`:

```bash
pnpm --dir apps/desktop test:e2e
```

## Risks

- This touches many component styles, so regressions are likely if the migration is only partially verified.
- Scoped component styles make broad CSS overrides unreliable; each hard-coded color should be intentionally replaced.
- Diff and Shiki theme changes may need re-rendering rather than only updating document attributes.
- Chart.js may retain old colors unless chart options are rebuilt or refreshed.
- Existing dark mode may drift slightly as literals are normalized into semantic tokens.

## Rollout

Implement as a single coherent theme-system change with focused tests at each layer. Keep commits grouped by behavior where possible:

1. Theme helpers and tests.
2. Settings/store/preferences wiring and tests.
3. Global tokens and component CSS migration.
4. Terminal/diff/file-preview/chart runtime theme wiring.
5. E2E coverage and verification.

The implementation should not leave a half-light state where the main shell changes but modals, terminals, and code viewers remain unintentionally dark unless the user selected dark terminal/code surfaces.
