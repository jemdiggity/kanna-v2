import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { submitTaskFromUi } from "../helpers/newTaskFlow";
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

async function captureOpenCodeDiagnostics(client: WebDriverClient, taskId: string) {
  return client.executeAsync<{
    bodyText: string;
    daemonSessions: unknown;
    initializingTaskItems: Array<{
      id: string;
      taskId: string | null;
      repo_id: string;
      state: string;
      prompt: string;
    }>;
    lastAgentSpawnError: unknown;
    selectedItemId: string | null;
    selectedItemIdForPersistence: string | null;
    taskRows: unknown;
    terminalText: string;
    terminalBufferText: string;
    sessionIds: string[];
    toastMessages: string[];
  }>(`const cb = arguments[arguments.length - 1];
      const ctx = window.__KANNA_E2E__?.setupState;
      const store = ctx?.store;
      const hook = window.__KANNA_E2E__?.terminalBuffers;
      const unwrap = (value) => value?.__v_isRef ? value.value : value;
      const initializingTaskItems = Array.from(unwrap(store?.initializingTaskItems) ?? []);
      const terminalBufferText = (() => {
        try {
          return hook?.lines?.(${JSON.stringify(taskId)})?.join("\\n") ?? "";
        } catch (error) {
          return "[terminal buffer unavailable: "
            + (error instanceof Error ? error.message : String(error))
            + "]";
        }
      })();
      const db = ctx?.db?.value || ctx?.db;
      const invoke = window.__TAURI__?.core?.invoke;
      Promise.all([
        invoke ? invoke("list_sessions").catch((error) => ({ error: String(error) })) : Promise.resolve({ error: "invoke unavailable" }),
        db ? db.select("SELECT id, agent_provider, activity, agent_session_id, branch, port_env FROM pipeline_item WHERE id = ?", [${JSON.stringify(taskId)}]).catch((error) => ({ error: String(error) })) : Promise.resolve({ error: "db unavailable" }),
      ]).then(([daemonSessions, taskRows]) => cb({
          bodyText: document.body?.innerText ?? "",
          daemonSessions,
          initializingTaskItems: initializingTaskItems.map((item) => ({
            id: item.id,
            taskId: item.taskId ?? null,
            repo_id: item.repo_id,
            state: item.state,
            prompt: item.prompt,
          })),
          lastAgentSpawnError: window.__KANNA_E2E_LAST_AGENT_SPAWN_ERROR__ ?? null,
          selectedItemId: unwrap(store?.selectedItemId) ?? null,
          selectedItemIdForPersistence: unwrap(store?.selectedItemIdForPersistence) ?? null,
          taskRows,
          terminalText: document.querySelector(".terminal-container")?.textContent ?? "",
          terminalBufferText,
          sessionIds: hook?.sessionIds?.() ?? [],
          toastMessages: Array.from(document.querySelectorAll(".toast-message"))
            .map((node) => node.textContent ?? "")
            .filter((text) => text.length > 0),
      })).catch((error) => cb({ error: String(error) }));`);
}

describe("opencode agent writes file (real CLI)", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    testRepoPath = await createFixtureRepo("opencode-agent-writes-file-real-test");
    await importTestRepo(client, testRepoPath, "opencode-agent-writes-file-real-test");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("creates a task with OpenCode pickle that writes the expected file", async () => {
    const prompt = [
      "Create a file called opencode-e2e-test-output.txt containing exactly: OpenCode E2E content.",
      "Do not ask questions. Stop after writing the file.",
    ].join(" ");
    const worktreeBaseline = new Set(await readTaskWorktreeNames(testRepoPath));

    await submitTaskFromUi(client, prompt);
    const task = await waitForTaskCreated(client, prompt, 20_000);
    expect(task.agent_provider).toBe("opencode");

    const worktreePath = await waitForNewTaskWorktree(testRepoPath, worktreeBaseline, 60_000);
    await nudgeTerminalTrustPrompt(client, {
      initialDelayMs: 5_000,
      attempts: 4,
      intervalMs: 5_000,
    });

    const filePath = join(worktreePath, "opencode-e2e-test-output.txt");
    try {
      await waitForFile(filePath, 180_000, 1_000);
    } catch (error) {
      const diagnostics = await captureOpenCodeDiagnostics(client, task.id);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
        `diagnostics=${JSON.stringify(diagnostics)}`,
      );
    }
    expect((await readFile(filePath, "utf8")).trimEnd()).toBe("OpenCode E2E content.");
  }, 240_000);
});
