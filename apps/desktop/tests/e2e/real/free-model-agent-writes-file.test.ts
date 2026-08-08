import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { submitTaskFromUi } from "../helpers/newTaskFlow";
import { nudgeTerminalTrustPrompt } from "../helpers/terminalInput";
import { queryDb } from "../helpers/vue";
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
    creatingTaskSlots: Array<{
      slotId: string;
      taskId: string | null;
      prompt: string;
    }>;
    daemonSessions: unknown;
    lastAgentSpawnError: unknown;
    taskRows: unknown;
    terminalText: string;
    terminalBufferText: string;
    sessionIds: string[];
    toastMessages: string[];
  }>(`const cb = arguments[arguments.length - 1];
      const ctx = window.__KANNA_E2E__?.setupState;
      const hook = window.__KANNA_E2E__?.terminalBuffers;
      const db = ctx?.db?.value || ctx?.db;
      const invoke = window.__TAURI__?.core?.invoke;
      const taskUiSlots = ctx?.store?.taskUiSlots?.value ?? ctx?.store?.taskUiSlots ?? [];
      Promise.all([
        invoke ? invoke("list_sessions").catch((error) => ({ error: String(error) })) : Promise.resolve({ error: "invoke unavailable" }),
        db ? db.select("SELECT id, agent_provider, activity, agent_session_id, branch, port_env FROM pipeline_item WHERE id = ?", [${JSON.stringify(taskId)}]).catch((error) => ({ error: String(error) })) : Promise.resolve({ error: "db unavailable" }),
      ]).then(([daemonSessions, taskRows]) => cb({
          bodyText: document.body?.innerText ?? "",
          creatingTaskSlots: taskUiSlots
            .filter((slot) => slot.state === "creating")
            .map((slot) => ({
              slotId: slot.slot_id,
              taskId: slot.task_id,
              prompt: slot.draft.prompt,
            })),
          daemonSessions,
          lastAgentSpawnError: window.__KANNA_E2E_LAST_AGENT_SPAWN_ERROR__ ?? null,
          taskRows,
          terminalText: document.querySelector(".terminal-container")?.textContent ?? "",
          terminalBufferText: hook?.getText?.(${JSON.stringify(taskId)}) ?? "",
          sessionIds: hook?.sessionIds?.() ?? [],
          toastMessages: Array.from(document.querySelectorAll(".toast-message"))
            .map((node) => node.textContent ?? "")
            .filter((text) => text.length > 0),
      })).catch((error) => cb({ error: String(error) }));`);
}

interface RuntimeStatusRow {
  runtime_status: string | null;
}

/**
 * Poll `pipeline_item.runtime_status` — the column `terminal_watcher` writes
 * from the daemon's status broadcast — until it reaches `expected`.
 */
async function waitForRuntimeStatus(
  client: WebDriverClient,
  taskId: string,
  expected: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT runtime_status FROM pipeline_item WHERE id = ?",
      [taskId],
    ).catch(() => [])) as RuntimeStatusRow[];
    last = rows[0]?.runtime_status ?? null;
    if (last === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return last;
}

describe("opencode agent writes file (real CLI)", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
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
    // The expected content goes last and carries no trailing punctuation: with
    // "…exactly: OpenCode E2E content." the free model cannot tell the sentence
    // period from the content, and drops it about half the time.
    const prompt = [
      "Do not ask questions and stop after writing the file.",
      "Create a file called opencode-e2e-test-output.txt containing exactly: OpenCode E2E content",
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
    expect((await readFile(filePath, "utf8")).trimEnd()).toBe("OpenCode E2E content");

    // The daemon's OpenCode status matcher, end to end.
    //
    // This assertion was written once before and withdrawn: while Kanna spawned
    // `opencode run --interactive` the session drew no TUI at all, so nothing
    // the matcher reads was ever rendered
    // (docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md). It is
    // meaningful now because the spawn draws a real TUI and the process stays
    // alive after its turn, so reaching `idle` requires the daemon to have
    // positively recognised chrome OpenCode rendered — rather than, as before,
    // reporting a one-shot process's exit.
    //
    // A/B'd against the pre-fix behaviour — `opencode_status_from_lines`
    // returning `None` for every frame, which is what it did before this
    // investigation. The assertion then never leaves `busy` and fails on the
    // timeout ("expected 'busy' to be 'idle'"), exactly the state the gap doc
    // records. With the matcher as shipped, it passes.
    //
    // The control has to be the *whole* matcher, not the composer rule alone.
    // Two things would otherwise mask the difference:
    //   - `detect_headless_terminal_status_if_due`
    //     (crates/daemon/src/session.rs) falls back to Idle once any status has
    //     been observed and the matcher stops matching, so disabling only the
    //     composer rule still reaches `idle` off the working footer's
    //     disappearance;
    //   - the old `›` idle rule false-positives on OpenCode's echoed user
    //     message, so it reports Idle for the wrong reason.
    // What this therefore pins is that the daemon positively recognised
    // OpenCode's chrome on a live TUI at all — which is what the pre-fix
    // matcher could not do, and what the old one-shot spawn never rendered.
    const status = await waitForRuntimeStatus(client, task.id, "idle", 120_000);
    expect(status).toBe("idle");
  }, 300_000);
});
