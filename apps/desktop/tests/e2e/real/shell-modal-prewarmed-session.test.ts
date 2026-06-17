import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { callVueMethod, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

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
  await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__?.setupState;
     Promise.resolve(ctx?.onShellClose?.())
       .then(() => cb("ok"))
       .catch((error) => cb("err:" + String(error?.message ?? error)));`,
  ).catch(() => undefined);
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

describe("task shell modal", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let taskId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    testRepoPath = await createFixtureRepo("shell-modal-prewarmed-session-real-test");
    await importTestRepo(client, testRepoPath, "shell-modal-prewarmed-session-real-test");
  });

  afterAll(async () => {
    if (taskId) {
      await tauriInvoke(client, "kill_session", { sessionId: `shell-wt-${taskId}` }).catch(() => undefined);
      await tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("attaches the shell modal to the pre-warmed worktree PTY session", async () => {
    const repoRows = (await queryDb(
      client,
      "SELECT id FROM repo WHERE path = ?",
      [testRepoPath],
    )) as Array<{ id: string }>;
    const repoId = repoRows[0]?.id;
    if (!repoId) throw new Error("fixture repo was not imported");

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
    await waitForTaskBranch(client, taskId);

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
});
