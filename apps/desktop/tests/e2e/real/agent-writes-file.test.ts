import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { submitTaskFromUi } from "../helpers/newTaskFlow";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { nudgeTerminalTrustPrompt } from "../helpers/terminalInput";
import { WebDriverClient } from "../helpers/webdriver";
import { waitForFile, waitForNewTaskWorktree } from "../helpers/worktreeFs";

function readTaskWorktreeNames(repoPath: string): Promise<string[]> {
  return readdir(join(repoPath, ".kanna-worktrees"), { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("task-"))
        .map((entry) => entry.name),
    )
    .catch(() => []);
}

async function nudgeTrustPromptViaUi(client: WebDriverClient): Promise<void> {
  await nudgeTerminalTrustPrompt(client, {
    initialDelayMs: 5_000,
    attempts: 4,
    intervalMs: 5_000,
  });
}

async function captureTaskCreateDiagnostics(client: WebDriverClient) {
  // Diagnostics only: this internal snapshot is used after a failed UI task
  // creation flow to explain what state the visible UI got stuck in.
  const ui = await client.executeSync<{
    pendingSetupIds: string[];
    selectedRepoId: string | null;
    selectedRepoPath: string | null;
    showNewTaskModal: boolean;
    toastMessages: string[];
  }>(`const ctx = window.__KANNA_E2E__.setupState;
      const toastMessages = Array.from(document.querySelectorAll(".toast-message"))
        .map((node) => node.textContent ?? "")
        .filter((text) => text.length > 0);
      return {
        pendingSetupIds: ctx.store?.pendingSetupIds?.value ?? [],
        selectedRepoId: ctx.store?.selectedRepoId?.value ?? null,
        selectedRepoPath: ctx.store?.selectedRepo?.path ?? null,
        showNewTaskModal: Boolean(ctx.showNewTaskModal?.value ?? ctx.showNewTaskModal),
        toastMessages,
      };`);
  const db = await client.executeAsync<{
    repos: Array<{ id: string; path: string }>;
    items: Array<{ id: string; prompt: string | null; repo_id: string; agent_provider: string | null }>;
  }>(`const cb = arguments[arguments.length - 1];
      const ctx = window.__KANNA_E2E__.setupState;
      const db = ctx.db.value || ctx.db;
      Promise.all([
        db.select("SELECT id, path FROM repo ORDER BY created_at DESC"),
        db.select("SELECT id, prompt, repo_id, agent_provider FROM pipeline_item ORDER BY created_at DESC LIMIT 5"),
      ])
        .then(([repos, items]) => cb({ repos, items }))
        .catch((error) => cb({ repos: [], items: [], error: error.message || String(error) }));`);
  return { ...ui, ...db };
}

describe("agent writes file (real CLI)", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    testRepoPath = await createFixtureRepo("agent-writes-file-real-test");
    await importTestRepo(client, testRepoPath, "agent-writes-file-real-test");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("creates a task that writes the expected file", async () => {
    const prompt = "Create a file called e2e-test-output.txt containing exactly: E2E test content";
    const worktreeBaseline = new Set(await readTaskWorktreeNames(testRepoPath));

    await submitTaskFromUi(client, prompt);
    let task;
    try {
      task = await waitForTaskCreated(client, prompt, 20_000);
    } catch (error) {
      const diagnostics = await captureTaskCreateDiagnostics(client);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
        `diagnostics=${JSON.stringify(diagnostics)}`,
      );
    }
    expect(task.agent_provider).toBe("opencode");

    const worktreePath = await waitForNewTaskWorktree(testRepoPath, worktreeBaseline, 60_000);

    await nudgeTrustPromptViaUi(client);

    const filePath = join(worktreePath, "e2e-test-output.txt");
    await waitForFile(filePath, 120_000, 500);
    expect((await readFile(filePath, "utf8")).trimEnd()).toBe("E2E test content");
  }, 180_000);
});
