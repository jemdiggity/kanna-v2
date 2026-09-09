import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";
import { waitForFile } from "../helpers/worktreeFs";

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function waitForTaskBranch(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT branch FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ branch?: string | null }>;
    const branch = rows[0]?.branch;
    if (branch) return branch;
    await sleep(200);
  }
  throw new Error(`timed out waiting for task branch: ${taskId}`);
}

async function waitForDaemonSession(
  client: WebDriverClient,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await tauriInvoke(client, "list_sessions").catch((error) => ({ error: String(error) }));
    if (
      Array.isArray(latest) &&
      latest.some((session) =>
        session &&
        typeof session === "object" &&
        (session as { session_id?: unknown }).session_id === sessionId
      )
    ) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for daemon session ${sessionId}; latest=${JSON.stringify(latest)}`);
}

async function waitForTerminalBufferSession(
  client: WebDriverClient,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await client.executeSync(
      `const hook = window.__KANNA_E2E__?.terminalBuffers;
       return hook?.sessionIds?.() ?? [];`,
    );
    if (Array.isArray(latest) && latest.includes(sessionId)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for terminal buffer ${sessionId}; latest=${JSON.stringify(latest)}`);
}

async function waitForTerminalBufferText(
  client: WebDriverClient,
  sessionId: string,
  text: string,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let latest: string[] = [];
  while (Date.now() < deadline) {
    latest = await client.executeSync<string[]>(
      `const hook = window.__KANNA_E2E__?.terminalBuffers;
       return hook?.lines?.(${JSON.stringify(sessionId)}) ?? [];`,
    );
    if (latest.some((line) => line.includes(text))) return latest;
    await sleep(100);
  }
  throw new Error(`timed out waiting for terminal buffer ${sessionId} to contain ${text}; latest=${JSON.stringify(latest.slice(-20))}`);
}

async function shellModalDiagnostics(
  client: WebDriverClient,
  sessionId: string,
): Promise<unknown> {
  return client.executeSync(
    `const hook = window.__KANNA_E2E__?.terminalBuffers;
     const ctx = window.__KANNA_E2E__?.setupState;
     let lines = [];
     try { lines = hook?.lines?.(${JSON.stringify(sessionId)})?.slice(-20) ?? []; } catch (error) { lines = ["lines-error:" + String(error?.message ?? error)]; }
     return {
       currentItemId: ctx?.store?.currentItem?.id ?? null,
       sessionIds: hook?.sessionIds?.() ?? [],
       shellModalVisible: Boolean(document.querySelector(".shell-modal")),
       shellText: document.querySelector(".shell-modal .xterm-rows")?.textContent ?? "",
       lines,
     };`,
  );
}

async function closeShellModal(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `const tabs = window.__KANNA_E2E__?.setupState?.mainTabs;
     for (const tab of [...(tabs?.tabs?.value ?? [])]) {
       if (tab.kind === "shell") tabs.closeTab(tab.id);
     }
     return true;`,
  ).catch(() => undefined);
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

describe("task shell modal", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let taskId = "";
  let repoId = "";
  const taskIds: string[] = [];

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();

    testRepoPath = await createFixtureRepo("shell-modal-prewarmed-session-real-test");
    repoId = await importTestRepo(client, testRepoPath, "shell-modal-prewarmed-session-real-test");
  });

  afterAll(async () => {
    for (const id of taskIds) {
      await tauriInvoke(client, "kill_session", { sessionId: `shell-wt-${id}` }).catch(() => undefined);
      await tauriInvoke(client, "kill_session", { sessionId: id }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("attaches the shell modal to the pre-warmed worktree PTY session", async () => {
    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      "",
      "pty",
      { agentProvider: "codex", permissionMode: "dontAsk", selectOnCreate: false },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") {
      throw new Error(`unexpected createItem result: ${JSON.stringify(createResult)}`);
    }
    taskId = createResult;
    taskIds.push(taskId);
    await waitForTaskBranch(client, taskId);
    // Worktree shells are prewarmed by startup snapshot hydration. Reload so
    // this newly created task follows that production lifecycle.
    await client.reload();

    const shellSessionId = `shell-wt-${taskId}`;
    await waitForDaemonSession(client, shellSessionId, 30_000);

    const selectResult = await callVueMethod(client, "store.selectItem", taskId);
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);

    await client.executeSync(buildGlobalKeydownScript({ key: "j", code: "KeyJ", meta: true }));
    await client.waitForElement(".shell-modal .terminal-container", 15_000);

    try {
      await waitForTerminalBufferSession(client, shellSessionId, 10_000);
      await tauriInvoke(client, "send_input", {
        sessionId: shellSessionId,
        data: utf8Bytes("printf 'SHELL_MODAL_ATTACHED\\n'\n"),
      });

      const lines = await waitForTerminalBufferText(client, shellSessionId, "SHELL_MODAL_ATTACHED", 10_000);
      expect(lines.some((line) => line.includes("SHELL_MODAL_ATTACHED"))).toBe(true);
    } catch (error) {
      const diagnostics = await shellModalDiagnostics(client, shellSessionId).catch((diagnosticError) => ({
        diagnosticError: String(diagnosticError),
      }));
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`);
    } finally {
      await closeShellModal(client);
    }
  }, 90_000);

  it("sets the task worktree shell terminal environment inside the spawned PTY process", async () => {
    const createResult = await callVueMethod(
      client,
      "store.createItem",
      repoId,
      testRepoPath,
      "",
      "pty",
      { agentProvider: "codex", permissionMode: "dontAsk", selectOnCreate: false },
    );
    if (isVueCallError(createResult)) throw new Error(createResult.__error);
    if (typeof createResult !== "string") {
      throw new Error(`unexpected createItem result: ${JSON.stringify(createResult)}`);
    }
    taskId = createResult;
    taskIds.push(taskId);

    const branch = await waitForTaskBranch(client, taskId);
    const worktreePath = join(testRepoPath, ".kanna-worktrees", branch);
    await client.reload();

    const shellSessionId = `shell-wt-${taskId}`;
    await waitForDaemonSession(client, shellSessionId, 30_000);

    const selectResult = await callVueMethod(client, "store.selectItem", taskId);
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);

    await client.executeSync(buildGlobalKeydownScript({ key: "j", code: "KeyJ", meta: true }));
    await client.waitForElement(".shell-modal .terminal-container", 15_000);

    const markerPath = join(worktreePath, ".kanna-shell-terminal-env");

    try {
      await waitForTerminalBufferSession(client, shellSessionId, 10_000);
      await tauriInvoke(client, "send_input", {
        sessionId: shellSessionId,
        data: utf8Bytes(
          `set -eu; printf 'TERM=%s\\nCOLORTERM=%s\\nTERM_PROGRAM=%s\\n' "$TERM" "$COLORTERM" "$TERM_PROGRAM" > ${shellQuote(markerPath)}\n`,
        ),
      });

      await waitForFile(markerPath, 30_000, 250);
      expect((await readFile(markerPath, "utf8")).trimEnd()).toBe(
        "TERM=xterm-256color\nCOLORTERM=truecolor\nTERM_PROGRAM=kanna",
      );
    } catch (error) {
      const diagnostics = await shellModalDiagnostics(client, shellSessionId).catch((diagnosticError) => ({
        diagnosticError: String(diagnosticError),
      }));
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`);
    } finally {
      await closeShellModal(client);
    }
  }, 90_000);
});
