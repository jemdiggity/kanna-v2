import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SEED, seedDatabase } from "../helpers/seed";
import { callVueMethod, execDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const client = new WebDriverClient();
const terminalSelector = ".terminal-panel .xterm-helper-textarea";

async function waitForSelectedTask(
  taskId: string,
  timeoutMs = 15_000,
  reselect = false,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown = null;
  while (Date.now() < deadline) {
    if (reselect) {
      await callVueMethod(client, "selectSidebarItemById", taskId);
    }
    lastState = await client.executeSync(
      `const store = window.__KANNA_E2E__?.setupState?.store;
       const read = (value) => value?.__v_isRef ? value.value : value;
       return JSON.parse(JSON.stringify({
         selectedItemId: read(store?.selectedItemId) ?? null,
         selectedTaskId: read(store?.selectedTaskId) ?? null,
         itemIds: (read(store?.items) ?? []).map((item) => item.id),
         slots: (read(store?.taskUiSlots) ?? []).map((slot) => ({
           slotId: slot.slot_id,
           taskId: slot.task_id,
         })),
       }));`,
    );
    if ((lastState as { selectedTaskId?: string | null }).selectedTaskId === taskId) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for selected task ${taskId}; state=${JSON.stringify(lastState)}`);
}

async function selectTask(taskId: string): Promise<string> {
  for (const [method, ...args] of [
    ["store.reloadSnapshot"],
    ["store.selectRepo", SEED.repos.app.id],
    ["selectSidebarItemById", taskId],
  ] as const) {
    const result = await callVueMethod(client, method, ...args);
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(String((result as { __error: unknown }).__error));
    }
  }
  await waitForSelectedTask(taskId, 15_000, true);
  return client.waitForElement(terminalSelector, 20_000);
}

async function waitForTerminalOutput(taskId: string, marker: string): Promise<string> {
  let observed = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    observed = await client.executeSync<string>(
      `return window.__KANNA_E2E__?.terminalBuffers?.lines(${JSON.stringify(taskId)})?.join("\\n") || "";`,
    );
    if (observed.includes(marker)) return observed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for terminal output ${marker}; observed: ${observed}`);
}

async function waitForReplacementDaemonAuthorization(
  daemonDir: string,
  successorPid: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await tauriInvoke(client, "read_text_file", {
      path: `${daemonDir}/daemon.pid`,
    }).catch(() => null);
    const log = await tauriInvoke(client, "read_text_file", {
      path: `${daemonDir}/kanna-daemon-lifecycle.log`,
    }).catch(() => null);
    if (
      typeof pid === "string" &&
      pid.trim() === String(successorPid) &&
      typeof log === "string" &&
      log.includes(`pid=${successorPid} event=server_authorized server_pid=`)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Replacement daemon never recorded authorization for the adopted kanna-server");
}

describe("native approval control", () => {
  beforeAll(async () => {
    await client.createSession();
    await seedDatabase(client);
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("delivers merge-policy terminal input across daemon replacement without native authority", async () => {
    const taskId = `e2e-merge-terminal-${randomUUID()}`;
    const continuityMarker = `retained-terminal-${randomUUID()}`;
    const beforeMarker = `merge-before-${randomUUID()}`;
    const afterMarker = `merge-after-${randomUUID()}`;
    const runId = `run-${taskId}`;
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity)
       VALUES (?, ?, ?, 'specialized-reviewers', 'in progress', ?, 'pty', 'codex', 'working')`,
      [taskId, SEED.repos.app.id, "Merge policy terminal E2E", taskId],
    );
    await execDb(
      client,
      `INSERT INTO stage_run
       (id, task_id, stage, kind, agent, agent_provider, status, session_id, cwd)
       VALUES (?, ?, 'in progress', 'main', 'merge', 'codex', 'running', ?, '/tmp')`,
      [runId, taskId, taskId],
    );
    await execDb(
      client,
      `INSERT INTO terminal_session
         (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
       VALUES (?, ?, ?, 'merge', '/tmp', ?)`,
      [`terminal-${taskId}`, SEED.repos.app.id, taskId, taskId],
    );

    try {
      await tauriInvoke(client, "spawn_session", {
        sessionId: taskId,
        cwd: "/tmp",
        executable: "/bin/sh",
        args: ["-c", "printf 'merge-ready\\n'; while IFS= read -r line; do printf 'merge-input:%s\\n' \"$line\"; done"],
        env: {},
        cols: 80,
        rows: 24,
        agentProvider: "codex",
        operatorInputOnly: false,
      });
      const textarea = await selectTask(taskId);
      await client.executeSync<void>(`
        window.__KANNA_E2E__?.invokes?.clear();
        const terminal = document.querySelector(${JSON.stringify(terminalSelector)});
        if (terminal) {
          terminal.dataset.continuityMarker = ${JSON.stringify(continuityMarker)};
          terminal.focus();
        }
      `);
      await client.sendKeys(textarea, `${beforeMarker}\n`);
      await waitForTerminalOutput(taskId, `merge-input:${beforeMarker}`);
      let invokes = await client.executeSync<Array<{ cmd: string; args?: unknown }>>(
        "return window.__KANNA_E2E__?.invokes?.getAll() ?? [];",
      );
      expect(invokes.some((record) => record.cmd === "send_operator_input")).toBe(false);
      const daemonDir = await tauriInvoke(client, "read_env_var", {
        name: "KANNA_DAEMON_DIR",
      });
      if (typeof daemonDir !== "string" || daemonDir.length === 0) {
        throw new Error(`Invalid daemon directory: ${String(daemonDir)}`);
      }
      const successorPid = await tauriInvoke(client, "spawn_replacement_daemon_for_e2e");
      if (
        typeof successorPid !== "number" ||
        !Number.isSafeInteger(successorPid) ||
        successorPid <= 0
      ) {
        throw new Error(`Invalid replacement daemon pid: ${String(successorPid)}`);
      }

      await waitForReplacementDaemonAuthorization(daemonDir, successorPid);
      const replacementTextarea = await selectTask(taskId);
      await client.executeSync<void>(`
        window.__KANNA_E2E__?.invokes?.clear();
        document.querySelector(${JSON.stringify(terminalSelector)})?.focus();
      `);
      await client.sendKeys(replacementTextarea, `${afterMarker}\n`);

      await callVueMethod(client, "store.reloadSnapshot");
      await waitForSelectedTask(taskId);
      const continuity = await client.executeSync<{ marker: string | null; focused: boolean }>(`
        const terminal = document.querySelector(${JSON.stringify(terminalSelector)});
        return {
          marker: terminal?.dataset?.continuityMarker ?? null,
          focused: document.activeElement === terminal,
        };
      `);
      expect(continuity).toEqual({ marker: continuityMarker, focused: true });

      await waitForTerminalOutput(taskId, `merge-input:${afterMarker}`);
      invokes = await client.executeSync<Array<{ cmd: string; args?: unknown }>>(
        "return window.__KANNA_E2E__?.invokes?.getAll() ?? [];",
      );
      expect(invokes.some((record) => record.cmd === "send_operator_input")).toBe(false);
    } finally {
      await tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined);
      await execDb(client, "DELETE FROM terminal_session WHERE pipeline_item_id = ?", [taskId]);
      await execDb(client, "DELETE FROM stage_run WHERE task_id = ?", [taskId]);
      await execDb(client, "DELETE FROM pipeline_item WHERE id = ?", [taskId]);
    }
  }, 120_000);
});
