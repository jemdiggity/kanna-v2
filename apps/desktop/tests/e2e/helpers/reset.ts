/**
 * Test reset helpers — clean DB state and worktrees between test files.
 */
import { join } from "path";
import { homedir } from "os";
import { copyFile, access } from "fs/promises";
import { WebDriverClient } from "./webdriver";
import { execDb, callVueMethod, getVueState, tauriInvoke } from "./vue";

const APP_DATA_DIR = join(homedir(), "Library", "Application Support", "com.kanna.app");

/** Back up the SQLite DB file before wiping. Best-effort — logs but never throws. */
async function backupDatabase(dbFileName: string): Promise<void> {
  const src = join(APP_DATA_DIR, dbFileName);
  try {
    await access(src);
  } catch {
    return; // DB file doesn't exist yet — nothing to back up
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(APP_DATA_DIR, `${dbFileName}.backup-${timestamp}`);
  try {
    await copyFile(src, dest);
    console.log(`[reset] backed up ${dbFileName} → ${dest}`);
  } catch (err) {
    console.error(`[reset] WARNING: failed to back up ${dbFileName}:`, err);
  }
}

/** Reset all DB tables to a clean state with default settings. */
export async function resetDatabase(client: WebDriverClient): Promise<void> {
  // Safety: refuse to wipe a non-test database
  const currentDb = await getVueState(client, "dbName") as string;
  if (!currentDb || !currentDb.includes("test")) {
    throw new Error(
      `REFUSING to wipe database "${currentDb}" — not a test DB!\n` +
      `Start the app with: KANNA_DB_NAME=kanna-test.db bun tauri dev`
    );
  }

  // Back up the DB file before wiping
  await backupDatabase(currentDb);

  // Delete in FK-safe order (children before parents)
  await execDb(client, "DELETE FROM terminal_session");
  await execDb(client, "DELETE FROM worktree");
  await execDb(client, "DELETE FROM agent_run");
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

  // Refresh the Vue state so the UI reflects the empty DB
  await callVueMethod(client, "refreshRepos");
}

/** Clean up test-created git worktrees for a repo. Best-effort — never throws. */
export async function cleanupWorktrees(
  client: WebDriverClient,
  repoPath: string
): Promise<void> {
  try {
    const result = await tauriInvoke(client, "git_worktree_list", { repoPath });
    const worktrees = Array.isArray(result) ? result : [];

    for (const wt of worktrees) {
      if (wt.name?.startsWith("task-")) {
        try {
          await tauriInvoke(client, "git_worktree_remove", { repoPath, path: wt.path });
        } catch {
          // Worktree may already be removed
        }
      }
    }
  } catch {
    // Cleanup is best-effort — don't fail tests
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
  branch = "main"
): Promise<string> {
  await callVueMethod(client, "handleImportRepo", repoPath, name, branch);
  // Get the repo ID from Vue state
  const repos = (await client.executeSync(
    `const ctx = document.getElementById("app").__vue_app__._instance.setupState;
     const r = ctx.repos; return (r.value || r).map(r => ({ id: r.id, name: r.name }));`
  )) as Array<{ id: string; name: string }>;
  const repo = repos.find((r) => r.name === name);
  if (!repo) throw new Error(`Repo "${name}" not found after import`);

  // Select it
  await callVueMethod(client, "handleSelectRepo", repo.id);
  return repo.id;
}
