# Kanna E2E Test Suite — Design Spec

**Date:** 2026-03-18
**Status:** Draft
**Author:** Jeremy Hale + Claude

## Overview

End-to-end test suite for the Kanna Tauri desktop app. Tests drive the real WKWebView via W3C WebDriver protocol using `tauri-plugin-webdriver` on port 4445. Two suites: a fast mock suite that runs on every change, and a real suite that spawns live Claude CLI sessions on demand.

## Constraints

- **Dev builds only.** Tests use `__vue_app__._instance.setupState` to access Vue internals, which is only available in development mode. Tests must run against `bun tauri dev`, never a release build.
- **App must be running.** Tests do not launch the app. The developer starts `KANNA_DB_NAME=kanna-test.db bun tauri dev` in a separate terminal.
- **Claude CLI required for real suite.** The `tests/e2e/real/` tests need `claude` in PATH with valid auth.

## Tech Stack

| Layer | Technology |
|---|---|
| Test runner | bun test |
| WebDriver protocol | W3C WebDriver via HTTP fetch to localhost:4445 |
| WebDriver server | tauri-plugin-webdriver (in-app, debug builds only) |
| Assertions | bun:test expect |
| Vue state access | WebDriver executeSync/executeAsync with `document.getElementById("app").__vue_app__` |

## Location

```
apps/desktop/
├── tests/
│   └── e2e/
│       ├── helpers/
│       │   ├── webdriver.ts      # W3C WebDriver HTTP client
│       │   ├── reset.ts          # DB reset, worktree cleanup
│       │   ├── vue.ts            # Vue state helpers (read/write setupState)
│       │   └── mock-agent.ts     # Inject canned agent messages
│       ├── mock/                 # Fast suite — no Claude CLI
│       │   ├── app-launch.test.ts
│       │   ├── import-repo.test.ts
│       │   ├── task-lifecycle.test.ts
│       │   ├── diff-view.test.ts
│       │   ├── action-bar.test.ts
│       │   ├── keyboard-shortcuts.test.ts
│       │   └── preferences.test.ts
│       ├── real/                 # Slow suite — live Claude CLI
│       │   ├── claude-session.test.ts
│       │   └── diff-after-claude.test.ts
│       ├── preload.ts            # Global setup: check WebDriver is ready + app initialized
│       └── bunfig.toml           # Configures preload for bun test
├── package.json                  # adds test:e2e and test:e2e:real scripts
└── ...
```

## Test Database Isolation

The app must not use the production database during tests. A separate SQLite database is used:

- **Env var:** `KANNA_DB_NAME` — defaults to `kanna-v2.db` in production.
- **Test mode:** App launched with `KANNA_DB_NAME=kanna-test.db bun tauri dev`.
- **App changes required (must be implemented before tests work):**
  1. `App.vue` reads the env var via `invoke("read_env_var", { name: "KANNA_DB_NAME" })` and passes it to `Database.load()`. Falls back to `kanna-v2.db` if unset.
  2. `tauri.conf.json` — remove the `"preload"` key from the SQL plugin config entirely. The app handles DB loading in `App.vue`'s `onMounted`, so preloading is unnecessary and causes the production DB file to be created even in test mode.
- **Reset:** Each test file's `beforeAll` resets the DB via `executeSync`. Tables are deleted in FK-safe order: `terminal_session`, `worktree`, `pipeline_item`, `agent_run`, `repo`. Then `settings` is wiped and defaults re-inserted.
- **Cleanup:** `afterAll` removes any git worktrees created during the test via `invoke("git_worktree_remove", { repoPath, path })`.
- **File cleanup:** The test DB file (`kanna-test.db`) can be deleted between full runs for a guaranteed clean slate.

## Global Preload

`tests/e2e/preload.ts` — runs before any test file via bun's preload mechanism.

```typescript
// Check WebDriver is up
const resp = await fetch("http://127.0.0.1:4445/status").catch(() => null)
if (!resp?.ok) {
  console.error("WebDriver not available on port 4445. Start the app with:")
  console.error("  KANNA_DB_NAME=kanna-test.db bun tauri dev")
  process.exit(1)
}

// Check the app has finished mounting (Vue app exists and DB is initialized)
// Create a temporary session to verify
const session = await fetch("http://127.0.0.1:4445/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ capabilities: {} }),
}).then(r => r.json())
const sid = session.value.sessionId

const vueReady = await fetch(`http://127.0.0.1:4445/session/${sid}/execute/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    script: 'return !!document.getElementById("app").__vue_app__',
    args: [],
  }),
}).then(r => r.json())

await fetch(`http://127.0.0.1:4445/session/${sid}`, { method: "DELETE" })

if (!vueReady.value) {
  console.error("Vue app not mounted. Is the app fully loaded?")
  process.exit(1)
}
```

Configured via `bunfig.toml`:
```toml
[test]
preload = ["./tests/e2e/preload.ts"]
```

## WebDriver Client Helper

`helpers/webdriver.ts` — thin typed wrapper around W3C WebDriver HTTP API.

```typescript
class WebDriverClient {
  private baseUrl: string
  private sessionId: string | null

  constructor(port = 4445)

  // Session lifecycle
  async createSession(): Promise<string>
  async deleteSession(): Promise<void>

  // Element interaction
  async findElement(css: string): Promise<string>  // returns element ID
  async findElements(css: string): Promise<string[]>
  async click(elementId: string): Promise<void>
  async getText(elementId: string): Promise<string>
  async sendKeys(elementId: string, text: string): Promise<void>

  // JavaScript execution
  async executeSync<T>(script: string, args?: unknown[]): Promise<T>
  async executeAsync<T>(script: string, args?: unknown[]): Promise<T>

  // Utilities
  async screenshot(path?: string): Promise<Buffer>
  async getTitle(): Promise<string>
  async waitForElement(css: string, timeoutMs?: number): Promise<string>
  async waitForText(css: string, text: string, timeoutMs?: number): Promise<string>
}
```

All methods throw on WebDriver errors. `waitForElement` polls every 200ms until the element exists or timeout (default 10s). `waitForText` polls until an element matching the selector contains the expected text.

## Vue State Helpers

`helpers/vue.ts` — access Vue component state via WebDriver JS execution.

```typescript
// Read a setupState property (auto-unwraps Vue refs)
async function getVueState(client: WebDriverClient, prop: string): Promise<unknown>
// Implementation: executeSync returns:
//   const val = ctx[prop]; return val && val.__v_isRef ? val.value : val;

// Call a setupState method
async function callVueMethod(client: WebDriverClient, method: string, ...args: unknown[]): Promise<unknown>

// Execute SQL through the Vue DB handle (unwraps the db ref)
async function queryDb(client: WebDriverClient, sql: string, params?: unknown[]): Promise<unknown[]>
// Implementation: executeAsync that calls ctx.db.value.select(sql, params) or ctx.db.value.execute(sql, params)

// Invoke a Tauri command from the webview
async function tauriInvoke(client: WebDriverClient, cmd: string, args?: Record<string, unknown>): Promise<unknown>
// Implementation: executeAsync that calls window.__TAURI_INTERNALS__.invoke(cmd, args)
```

These use `document.getElementById("app").__vue_app__._instance.setupState` to access the Vue app's reactive state. The `getVueState` helper auto-unwraps Vue `Ref` objects by checking `__v_isRef`.

## Mock Agent Helper

`helpers/mock-agent.ts` — provides agent messages for the fast suite without waiting for real Claude CLI.

The mock suite uses `create_agent_session` with a trivial prompt (`"Say OK"`) and `max_turns: 1`, which makes Claude respond in ~2-3s. This is fast enough for mock tests since Claude only produces a single text response.

For tests that need specific message shapes (e.g., verifying tool call rendering), inject directly into the AgentView component's `messages` array via `executeSync` on the component's element:

```typescript
async function injectMessages(
  client: WebDriverClient,
  messages: Array<{ type: string; [key: string]: unknown }>
): Promise<void>
// Implementation: find .agent-view element's __vueParentComponent,
// push messages into its setupState.messages ref
```

Note: Direct DashMap injection from JS is not possible. All mock approaches work through the Vue/JS layer.

## Test Reset Helper

`helpers/reset.ts` — clean state before each test file.

```typescript
async function resetDatabase(client: WebDriverClient): Promise<void>
```

Executes via the Vue DB handle in FK-safe order:
```sql
PRAGMA foreign_keys = OFF;
DELETE FROM terminal_session;
DELETE FROM worktree;
DELETE FROM agent_run;
DELETE FROM pipeline_item;
DELETE FROM repo;
DELETE FROM settings;
-- Re-insert default settings
INSERT INTO settings (key, value) VALUES ('terminal_font_family', 'SF Mono');
INSERT INTO settings (key, value) VALUES ('terminal_font_size', '13');
INSERT INTO settings (key, value) VALUES ('suspend_after_minutes', '5');
INSERT INTO settings (key, value) VALUES ('kill_after_minutes', '30');
INSERT INTO settings (key, value) VALUES ('appearance_mode', 'system');
INSERT INTO settings (key, value) VALUES ('ide_command', 'code');
PRAGMA foreign_keys = ON;
```

After reset, calls `refreshRepos()` on the Vue state so the UI reflects the empty DB.

```typescript
async function cleanupWorktrees(client: WebDriverClient, repoPath: string): Promise<void>
```

Calls `tauriInvoke(client, "git_worktree_list", { repoPath })`, filters to test-created worktrees (branch names starting with `task-`), and removes each via `tauriInvoke(client, "git_worktree_remove", { repoPath, path })`.

## Mock Test Suite

### app-launch.test.ts
- App renders with title "Kanna"
- Sidebar shows "No repos imported yet."
- Main panel shows "No task selected"
- Import Repo button exists
- Settings button exists

### import-repo.test.ts
- Call `handleImportRepo(path, name, branch)` via `callVueMethod`
- Repo appears in sidebar with name and task count
- "No tasks" text shown under repo
- Import second repo — both appear
- Call `handleSelectRepo(id)` — verify `selectedRepoId` updates via `getVueState`

### task-lifecycle.test.ts
- Import repo, select it
- Create task via `callVueMethod("handleNewTaskSubmit", prompt)`
- Task appears in sidebar with "In Progress" badge
- Main panel shows TaskHeader with prompt text
- Agent tab is active
- Wait for result block to appear (uses trivial prompt, ~3s)
- Result block shows "Completed"
- Click Close button
- Stage updates to "Closed" in sidebar badge

### diff-view.test.ts
- Import repo, create task (to get a worktree)
- Wait for task to appear, get its branch name via `getVueState("selectedItem")` (returns the pipeline item with branch field)
- Write a file into the worktree via `tauriInvoke(client, "run_script", { script: "echo test > test-file.txt", cwd: worktreePath, env: {} })`
- Click Diff tab
- Wait for diff content to appear (not "No changes")
- Verify the diff container has content

### action-bar.test.ts
- Create task (stage: in_progress, pr_number: null)
- Verify Make PR button visible
- Verify Close button visible
- Click Close — stage changes to "closed"
- Verify Make PR button no longer visible
- Verify Close button no longer visible

### keyboard-shortcuts.test.ts
- Dispatch Cmd+N keydown event — verify New Task modal appears
- Dispatch Escape — verify modal closes
- Import repo, select it, create two tasks
- Dispatch Cmd+Down — verify selectedItemId changes
- Dispatch Cmd+Up — verify selectedItemId changes back
- Dispatch Cmd+Z — verify zen mode (sidebar hidden)
- Dispatch Escape — verify zen mode exits (sidebar visible)

### preferences.test.ts
- Click settings button — preferences panel appears
- Panel shows font family, font size, appearance mode fields
- Close preferences — panel disappears
- Settings values persist in DB (query via `queryDb`)

## Real Test Suite

### claude-session.test.ts
- Import repo, select it
- Create task with prompt: "Respond with exactly: E2E_TEST_OK"
- Wait (up to 60s) for result block to appear in Agent tab via `waitForElement(".result-block")`
- Verify result block contains "Completed"
- Verify at least one `.text-block` element rendered before result (assistant message)
- Verify no `.running-indicator` element (session finished)

### diff-after-claude.test.ts
- Import repo, select it
- Create task with prompt: "Create a file called e2e-test-output.txt containing exactly: E2E test content"
- Wait (up to 120s) for result block
- Click Diff tab
- Wait for `.diff-container` to have child elements (not empty)
- Verify diff content contains "e2e-test-output" (partial match — robust to Claude's exact output)
- Cleanup: remove the worktree in `afterAll`

## Scripts

`apps/desktop/package.json` adds:
```json
{
  "test:e2e": "bun test tests/e2e/mock/",
  "test:e2e:real": "bun test tests/e2e/real/",
  "test:e2e:all": "bun test tests/e2e/"
}
```

**Prerequisite:** Start the app in test mode in a separate terminal:
```bash
KANNA_DB_NAME=kanna-test.db bun tauri dev
```

Wait for the Tauri window to appear before running tests.

## App Changes Required

These must be implemented before the E2E tests can run:

1. **`App.vue`** — read `KANNA_DB_NAME` env var for the database name:
   ```typescript
   let dbName = "kanna-v2.db";
   try {
     const envDb = await invoke<string>("read_env_var", { name: "KANNA_DB_NAME" });
     if (envDb) dbName = envDb;
   } catch {}
   const database = await Database.load(`sqlite:${dbName}`);
   ```

2. **`tauri.conf.json`** — remove the `"preload"` key from the SQL plugin config. The app handles DB loading in `App.vue`'s `onMounted`, so preloading is unnecessary. Remove:
   ```json
   "sql": {
     "preload": ["sqlite:kanna-v2.db"]
   }
   ```
   Replace with:
   ```json
   "sql": {}
   ```

## Success Criteria

- `bun test:e2e` passes in <10s with the app running (mock suite)
- `bun test:e2e:real` passes in <120s with Claude CLI available
- Tests are independent — any single test file can run in isolation
- Test DB is never the production DB
- No manual cleanup needed between runs
