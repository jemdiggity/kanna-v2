/**
 * Test reset helpers — clean DB state and worktrees between test files.
 */
import { WebDriverClient } from "./webdriver";
import { execDb, callVueMethod, tauriInvoke } from "./vue";

/** Reset all DB tables to a clean state with default settings. */
export async function resetDatabase(client: WebDriverClient): Promise<void> {
  // Delete in FK-safe order (children before parents)
  await execDb(client, "DELETE FROM terminal_session");
  await execDb(client, "DELETE FROM worktree");
  await execDb(client, "DELETE FROM agent_run");
  await execDb(client, "DELETE FROM pipeline_item");
  await execDb(client, "DELETE FROM repo");
  await execDb(client, "DELETE FROM settings");

  // Re-insert default settings
  const defaults = [
    ["terminal_font_family", "SF Mono"],
    ["terminal_font_size", "13"],
    ["suspend_after_minutes", "5"],
    ["kill_after_minutes", "30"],
    ["appearance_mode", "system"],
    ["ide_command", "code"],
  ];
  for (const [key, value] of defaults) {
    await execDb(client, "INSERT INTO settings (key, value) VALUES (?, ?)", [key, value]);
  }

  // Refresh the Vue state so the UI reflects the empty DB
  await callVueMethod(client, "refreshRepos");
}

/** Clean up test-created git worktrees for a repo. */
export async function cleanupWorktrees(
  client: WebDriverClient,
  repoPath: string
): Promise<void> {
  let worktrees: Array<{ name: string; path: string }>;
  try {
    const result = await tauriInvoke(client, "git_worktree_list", { repoPath });
    worktrees = Array.isArray(result) ? result : [];
  } catch {
    return; // Can't list worktrees — skip cleanup
  }

  for (const wt of worktrees) {
    // Only remove task- worktrees (not the main worktree)
    if (wt.name.startsWith("task-")) {
      try {
        await tauriInvoke(client, "git_worktree_remove", {
          repoPath,
          path: wt.path,
        });
      } catch {
        // Worktree may already be removed
      }
    }
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
