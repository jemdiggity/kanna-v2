/**
 * Test reset helpers — clean DB state and worktrees between test files.
 */
import { join } from "path";
import { copyFile, access, realpath } from "fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { WebDriverClient } from "./webdriver";
import { execDb, callVueMethod, getVueState, queryDb, tauriInvoke } from "./vue";
import { assertSafeE2eRepoPath } from "./fixture-repo";

interface GitWorktreeEntry {
  name?: string;
  path?: string;
}

interface OpenCleanupTask {
  id: string;
  agent_type: string | null;
}

const worktreeCleanupBaselines = new Map<string, Set<string>>();
const IMPORT_REPO_SELECTION_TIMEOUT_MS = 10_000;
const IMPORT_REPO_SELECTION_POLL_MS = 100;
const IMPORT_REPO_STORE_TIMEOUT_MS = 10_000;
const IMPORT_REPO_STORE_POLL_MS = 100;
const IMPORT_REPO_MODAL_DISMISS_TIMEOUT_MS = 30_000;
const TASK_CLOSE_TIMEOUT_MS = 20_000;
const IMPORT_REPO_MODAL_SELECTOR = ".modal-overlay";
const IMPORT_REPO_INPUT_SELECTOR = ".modal-overlay .text-input";
const IMPORT_REPO_READY_SELECTOR = ".modal-overlay .resolved-url";
const IMPORT_REPO_NAME_CHANGE_SELECTOR = ".modal-overlay .repo-name-change";
const IMPORT_REPO_SUBMIT_SELECTOR = ".modal-overlay .btn-primary:not(:disabled)";
// Only dialogs are modals now; the views a test may have left open live in
// the main content area's tabs and are cleared separately below.
const TRANSIENT_MODAL_REFS = [
  "showCommandPalette",
  "showShortcutsModal",
  "showPeerPicker",
  "showFilePickerModal",
  "filePickerHidden",
  "showNewTaskModal",
  "showAddRepoModal",
  "showBlockerSelect",
] as const;

function isVueCallError(result: unknown): result is { __error: string } {
  return Boolean(
    result &&
    typeof result === "object" &&
    "__error" in result &&
    typeof (result as { __error?: unknown }).__error === "string",
  );
}

async function waitForTaskClosed(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = TASK_CLOSE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await queryDb(
      client,
      "SELECT closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    ) as Array<{ closed_at?: string | null }>;
    const row = rows[0];
    if (!row) return;
    // closed_at is the sole done indicator — closing never rewrites stage.
    if (typeof row.closed_at === "string" && row.closed_at.length > 0) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for task ${taskId} to close`);
}

async function closeTaskThroughApp(
  client: WebDriverClient,
  taskId: string,
): Promise<void> {
  const result = await callVueMethod(client, "store.closeTask", taskId);
  if (isVueCallError(result)) {
    throw new Error(result.__error);
  }
  await waitForTaskClosed(client, taskId);
}

async function listOpenTaskIds(
  client: WebDriverClient,
): Promise<string[]> {
  const rows = await queryDb(
    client,
    "SELECT id FROM pipeline_item WHERE closed_at IS NULL ORDER BY created_at DESC",
  ) as Array<{ id?: string | null }>;

  return rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function recordWorktreeCleanupBaseline(
  client: WebDriverClient,
  repoPath: string
): Promise<void> {
  const result = await tauriInvoke(client, "git_worktree_list", { repoPath });
  const worktrees = Array.isArray(result) ? result as GitWorktreeEntry[] : [];
  worktreeCleanupBaselines.set(
    repoPath,
    new Set(
      worktrees
        .map((wt) => wt.path)
        .filter((path): path is string => typeof path === "string" && path.length > 0)
    )
  );
}

async function importRepoThroughUi(
  client: WebDriverClient,
  repoPath: string,
  name: string,
): Promise<void> {
  await client.executeSync(
    `const ctx = window.__KANNA_E2E__?.setupState;
     // Not every modal flag is destructured into App.vue's own scope; the
     // rest are reachable through the modals composable it exposes.
     const holder = (key) => (ctx && key in ctx) ? ctx : ctx?.appModals;
     const close = (key) => {
       const owner = holder(key);
       const value = owner?.[key];
       if (value?.__v_isRef) value.value = false;
       else if (owner && key in owner) owner[key] = false;
     };
     for (const key of ${JSON.stringify(TRANSIENT_MODAL_REFS)}) close(key);
     // Content views are tabs, not modal flags, so they are closed through
     // the tab controller rather than by clearing a ref.
     const tabs = ctx?.mainTabs;
     if (tabs) {
       for (const tab of [...(tabs.tabs?.value ?? [])]) tabs.closeTab(tab.id);
     }
     const maximizedOwner = holder("maximizedModal");
     const maximized = maximizedOwner?.maximizedModal;
     if (maximized?.__v_isRef) maximized.value = null;
     else if (maximizedOwner && "maximizedModal" in maximizedOwner) maximizedOwner.maximizedModal = null;`
  );
  await sleep(100);

  const result = await callVueMethod(client, "keyboardActions.importRepo");
  if (isVueCallError(result)) {
    throw new Error(result.__error);
  }
  await client.waitForElement(IMPORT_REPO_MODAL_SELECTOR, 2_000);
  const input = await client.waitForElement(IMPORT_REPO_INPUT_SELECTOR, 2_000);
  await client.sendKeys(input, repoPath);
  await client.waitForElement(IMPORT_REPO_READY_SELECTOR, 5_000);
  const changeName = await client.waitForElement(IMPORT_REPO_NAME_CHANGE_SELECTOR, 2_000);
  await client.click(changeName);
  const textInputs = await client.findElements(IMPORT_REPO_INPUT_SELECTOR);
  const nameInput = textInputs.at(-1);
  if (!nameInput) {
    throw new Error("repo name input did not appear in import modal");
  }
  await client.clear(nameInput);
  await client.sendKeys(nameInput, name);
  const submit = await client.waitForElement(IMPORT_REPO_SUBMIT_SELECTOR, 5_000);
  await client.click(submit);
  try {
    await client.waitForNoElement(IMPORT_REPO_MODAL_SELECTOR, IMPORT_REPO_MODAL_DISMISS_TIMEOUT_MS);
  } catch (error) {
    const modalText = await client.executeSync<string>(
      `return document.querySelector(${JSON.stringify(IMPORT_REPO_MODAL_SELECTOR)})?.textContent || "";`,
    ).catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}; modal text: ${modalText}`);
  }
}

async function waitForImportedRepoInStore(
  client: WebDriverClient,
  repoPath: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const deadline = Date.now() + IMPORT_REPO_STORE_TIMEOUT_MS;
  const canonicalRepoPath = await realpath(repoPath).catch(() => repoPath);
  const repoPaths = new Set([repoPath, canonicalRepoPath]);
  let lastState: unknown = null;

  while (Date.now() < deadline) {
    const state = await client.executeSync<{
      selectedRepoId: string | null;
      selectedRepoPath: string | null;
      repos: Array<{ id: string; name: string; path: string }>;
    }>(`const ctx = window.__KANNA_E2E__.setupState;
      const reposRef = ctx.store?.repos ?? ctx.repos ?? [];
      const repos = reposRef?.value ?? reposRef ?? [];
      const selectedRepo = ctx.store?.selectedRepo ?? null;
      const selectedRepoValue = selectedRepo?.value ?? selectedRepo;
      const selectedRepoId = ctx.store?.selectedRepoId?.value ?? ctx.store?.selectedRepoId ?? null;
      return {
        selectedRepoId,
        selectedRepoPath: selectedRepoValue?.path ?? ctx.store?.selectedRepo?.path ?? null,
        repos: Array.from(repos).map((repo) => ({ id: repo.id, name: repo.name, path: repo.path })),
      };`);
    lastState = state;
    const repos = Array.isArray(state.repos) ? state.repos : [];
    const repo = repos.find((entry) => repoPaths.has(entry.path) && entry.name === name)
      ?? repos.find((entry) => repoPaths.has(entry.path))
      ?? (
        state.selectedRepoId && state.selectedRepoPath && repoPaths.has(state.selectedRepoPath)
          ? { id: state.selectedRepoId, name }
          : null
      );
    if (repo) return repo;
    await sleep(IMPORT_REPO_STORE_POLL_MS);
  }

  throw new Error(
    `Repo "${name}" not found in store after import; last state: ${JSON.stringify(lastState)}`,
  );
}

function shouldPreKillTaskSession(task: OpenCleanupTask): boolean {
  return task.agent_type === "agent" || task.agent_type === "sdk";
}

async function listOpenTasksForRepo(
  client: WebDriverClient,
  repoPath: string
): Promise<OpenCleanupTask[]> {
  const canonicalRepoPath = await realpath(repoPath).catch(() => repoPath);
  const repoPaths = [...new Set([repoPath, canonicalRepoPath])];
  const placeholders = repoPaths.map(() => "?").join(", ");
  const rows = await queryDb(
    client,
    `SELECT p.id, p.agent_type
       FROM pipeline_item p
       JOIN repo r ON r.id = p.repo_id
      WHERE r.path IN (${placeholders})
        AND p.closed_at IS NULL
      ORDER BY p.created_at DESC`,
    repoPaths,
  ) as Array<{ id?: string | null; agent_type?: string | null }>;

  return rows
    .filter((row): row is { id: string; agent_type?: string | null } => typeof row.id === "string" && row.id.length > 0)
    .map((row) => ({
      id: row.id,
      agent_type: row.agent_type ?? null,
    }));
}

/** Back up the SQLite DB file before wiping. Best-effort — logs but never throws. */
async function getAppDataDir(client: WebDriverClient): Promise<string> {
  const appDataDir = await tauriInvoke(client, "get_app_data_dir");
  if (typeof appDataDir !== "string") {
    throw new Error(`Unexpected app data dir: ${JSON.stringify(appDataDir)}`);
  }
  return appDataDir;
}

async function backupDatabase(client: WebDriverClient, dbFileName: string): Promise<void> {
  const appDataDir = await getAppDataDir(client);
  const src = join(appDataDir, dbFileName);
  try {
    await access(src);
  } catch {
    return; // DB file doesn't exist yet — nothing to back up
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(appDataDir, `${dbFileName}.backup-${timestamp}`);
  try {
    await copyFile(src, dest);
    console.log(`[reset] backed up ${dbFileName} → ${dest}`);
  } catch (err) {
    console.error(`[reset] WARNING: failed to back up ${dbFileName}:`, err);
  }
}

/** Reset all DB tables to a clean state with default settings. */
export async function resetDatabase(client: WebDriverClient): Promise<void> {
  // Safety: refuse to wipe the production database
  const currentDb = await getVueState(client, "dbName") as string;
  if (!currentDb || currentDb === "kanna-v2.db") {
    throw new Error(
      `REFUSING to wipe database "${currentDb}" — production DB is not allowed.\n` +
      `Start the app from a worktree with: ./kd dev up --attach`
    );
  }

  // Back up the DB file before wiping
  await backupDatabase(client, currentDb);

  const openTaskIds = await listOpenTaskIds(client).catch(() => [] as string[]);
  for (const taskId of openTaskIds) {
    await closeTaskThroughApp(client, taskId).catch(() => undefined);
  }

  // Delete in FK-safe order (children before parents)
  await execDb(client, "DELETE FROM terminal_session");
  await execDb(client, "DELETE FROM worktree");
  await execDb(client, "DELETE FROM agent_run");
  await execDb(client, "DELETE FROM stage_run");
  await execDb(client, "DELETE FROM pipeline_item");
  await execDb(client, "DELETE FROM repo");
  await execDb(client, "DELETE FROM settings");

  // Re-insert default settings
  const defaults = [
    ["suspendAfterMinutes", "5"],
    ["killAfterMinutes", "30"],
    ["ideCommand", "code"],
  ];
  for (const [key, value] of defaults) {
    await execDb(client, "INSERT INTO settings (key, value) VALUES (?, ?)", [key, value]);
  }

  // The app stays mounted while the E2E database is reset. Deleting settings
  // removes this window's workspace membership, so restore it through the same
  // initialization path used at startup before selection persistence resumes.
  const membershipResult = await callVueMethod(client, "windowWorkspace.initialize");
  if (isVueCallError(membershipResult)) {
    throw new Error(membershipResult.__error);
  }

  // Several files freeze LAN refreshes while they drive an injected remote
  // snapshot, and the freeze is per app instance — it outlives the file that
  // set it and silently stops the next one from publishing anything.
  try {
    await client.executeSync(
      `const ctx = window.__KANNA_E2E__.setupState;
       ctx.__e2eInjectRemoteSnapshot?.(
         "lan",
         { repos: [], items: [], terminalRefs: {}, blockedByTaskIds: {} },
         { freezeLanRefresh: false },
       );
       return true;`,
    );
  } catch (error) {
    console.debug("[reset] could not clear the LAN refresh freeze:", error);
  }

  // Refresh the Vue state so the UI reflects the empty DB
  await callVueMethod(client, "refreshRepos");
}

export async function cleanupWorktrees(
  client: WebDriverClient,
  repoPath: string
): Promise<void> {
  assertSafeE2eRepoPath(repoPath);
  const baseline = worktreeCleanupBaselines.get(repoPath);
  if (!baseline) return;

  try {
    const tasks = await listOpenTasksForRepo(client, repoPath);
    for (const task of tasks) {
      try {
        if (shouldPreKillTaskSession(task)) {
          await tauriInvoke(client, "kill_session", { sessionId: task.id }).catch(() => undefined);
        }
        await closeTaskThroughApp(client, task.id);
      } catch {
        // Cleanup is best-effort — don't fail tests
      }
    }
  } catch {
    // Cleanup is best-effort — don't fail tests
  } finally {
    worktreeCleanupBaselines.delete(repoPath);
  }
}

/**
 * Import a test repo and select it.
 * Returns the repo ID.
 */
export async function importTestRepo(
  client: WebDriverClient,
  repoPath: string,
  name = "test-repo",
  _branch = "main"
): Promise<string> {
  assertSafeE2eRepoPath(repoPath);
  await recordWorktreeCleanupBaseline(client, repoPath);
  await importRepoThroughUi(client, repoPath, name);
  const repo = await waitForImportedRepoInStore(client, repoPath, name);

  const selectResult = await callVueMethod(client, "store.selectRepo", repo.id);
  if (isVueCallError(selectResult)) {
    throw new Error(selectResult.__error);
  }
  const deadline = Date.now() + IMPORT_REPO_SELECTION_TIMEOUT_MS;
  const canonicalRepoPath = await realpath(repoPath).catch(() => repoPath);
  const repoPaths = new Set([repoPath, canonicalRepoPath]);
  while (Date.now() < deadline) {
    const selected = await client.executeSync<{
      selectedRepoId: string | null;
      selectedRepoPath: string | null;
    }>(`const ctx = window.__KANNA_E2E__.setupState;
      const selectedRepoId = ctx.store?.selectedRepoId?.value ?? ctx.store?.selectedRepoId ?? null;
      return {
        selectedRepoId,
        selectedRepoPath: ctx.store?.selectedRepo?.path ?? null,
      };`);
    if (selected.selectedRepoId === repo.id && selected.selectedRepoPath && repoPaths.has(selected.selectedRepoPath)) {
      return repo.id;
    }
    await sleep(IMPORT_REPO_SELECTION_POLL_MS);
  }

  throw new Error(`Repo "${name}" was imported but never became selected.`);
}

export async function importTestRepoDirect(
  client: WebDriverClient,
  repoPath: string,
  name = "test-repo",
  branch = "main",
): Promise<string> {
  assertSafeE2eRepoPath(repoPath);
  await recordWorktreeCleanupBaseline(client, repoPath);

  const importResult = await callVueMethod(client, "store.importRepo", repoPath, name, branch);
  if (isVueCallError(importResult)) {
    throw new Error(importResult.__error);
  }

  const repo = await waitForImportedRepoInStore(client, repoPath, name);

  const selectResult = await callVueMethod(client, "store.selectRepo", repo.id);
  if (isVueCallError(selectResult)) {
    throw new Error(selectResult.__error);
  }
  return repo.id;
}
