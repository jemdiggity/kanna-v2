import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SEED, seedDatabase } from "../helpers/seed";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const client = new WebDriverClient();
function terminalSelector(operatorTerminalInput: boolean): string {
  return `.terminal-panel[data-operator-terminal-input="${operatorTerminalInput}"] .xterm-helper-textarea`;
}

async function waitForSelectedTask(taskId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const selected = await client.executeSync<string | null>(
      "return window.__KANNA_E2E__?.setupState?.store?.selectedItemId ?? null;",
    );
    if (selected === taskId) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for selected task ${taskId}`);
}

async function selectTaskWithPolicy(
  taskId: string,
  operatorTerminalInput: boolean,
): Promise<string> {
  await callVueMethod(client, "loadItems");
  await callVueMethod(client, "store.selectRepo", SEED.repos.app.id);
  await callVueMethod(client, "store.selectItem", taskId);
  await waitForSelectedTask(taskId);
  return client.waitForElement(terminalSelector(operatorTerminalInput), 20_000);
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

  it("persists a webview-requested override through Tauri and the authenticated Unix socket", async () => {
    const taskId = SEED.tasks.authRefactor.id;
    const stage = "in progress";
    const runId = `e2e-native-override-${randomUUID()}`;
    const reason = "E2E operator explicitly reviewed and accepted the held lineage.";
    await execDb(
      client,
      `INSERT INTO stage_run
         (id, task_id, stage, kind, agent, status, result, feedback, finished_at)
       VALUES (?, ?, ?, 'main', 'implement', 'failed', ?, ?, datetime('now'))`,
      [runId, taskId, stage, "Needs human input", "Not a merge candidate"],
    );

    try {
      const response = await tauriInvoke(client, "override_approval_hold", {
        taskId,
        reason,
      }) as { state?: string; overrideRecord?: { channel?: string; reason?: string } };
      expect(response).toMatchObject({
        state: "overridden",
        overrideRecord: {
          channel: "native_desktop_process",
          reason,
        },
      });
      const rows = await queryDb(
        client,
        `SELECT actor, channel, reason
         FROM task_approval_override
         WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
        [taskId],
      ) as Array<{ actor: string; channel: string; reason: string }>;
      expect(rows[0]).toMatchObject({
        channel: "native_desktop_process",
        reason,
      });
    } finally {
      await execDb(client, "DELETE FROM task_approval_hold WHERE run_id = ?", [runId]);
      await execDb(client, "DELETE FROM task_approval_override WHERE task_id = ?", [taskId]);
      await execDb(client, "DELETE FROM stage_run WHERE id = ?", [runId]);
    }
  });

  it("retains MainPanel terminal state while switching generic input to protected native authority and back", async () => {
    const taskId = `e2e-merge-terminal-${randomUUID()}`;
    const continuityMarker = `retained-terminal-${randomUUID()}`;
    const genericMarker = `generic-before-${randomUUID()}`;
    const protectedMarker = `native-operator-${randomUUID()}`;
    const genericAfterMarker = `generic-after-${randomUUID()}`;
    const runId = `run-${taskId}`;
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity)
       VALUES (?, ?, ?, 'specialized-reviewers', 'in progress', ?, 'pty', 'codex', 'working')`,
      [taskId, SEED.repos.app.id, "Protected merge terminal E2E", taskId],
    );
    await execDb(
      client,
      `INSERT INTO stage_run
       (id, task_id, stage, kind, agent, agent_provider, status, session_id, cwd)
       VALUES (?, ?, 'in progress', 'main', 'implement', 'codex', 'running', ?, '/tmp')`,
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
        args: ["-c", "printf 'generic-ready\\n'; IFS= read -r line; printf 'generic-input:%s\\n' \"$line\"; sleep 30"],
        env: {},
        cols: 80,
        rows: 24,
        agentProvider: "codex",
        operatorInputOnly: false,
      });
      const genericTextarea = await selectTaskWithPolicy(taskId, false);
      await client.executeSync<void>(`
        window.__KANNA_E2E__?.invokes?.clear();
        const terminal = document.querySelector(${JSON.stringify(terminalSelector(false))});
        if (terminal) {
          terminal.dataset.continuityMarker = ${JSON.stringify(continuityMarker)};
          terminal.focus();
        }
      `);
      await client.sendKeys(genericTextarea, `${genericMarker}\n`);
      await waitForTerminalOutput(taskId, `generic-input:${genericMarker}`);
      let invokes = await client.executeSync<Array<{ cmd: string; args?: unknown }>>(
        "return window.__KANNA_E2E__?.invokes?.getAll() ?? [];",
      );
      expect(invokes.some((record) => record.cmd === "send_operator_input")).toBe(false);

      await tauriInvoke(client, "kill_session", { sessionId: taskId });
      await tauriInvoke(client, "spawn_session", {
        sessionId: taskId,
        cwd: "/tmp",
        executable: "/bin/sh",
        args: ["-c", "printf 'merge-native-ready\\n'; IFS= read -r line; printf 'merge-native-input:%s\\n' \"$line\"; sleep 30"],
        env: {},
        cols: 80,
        rows: 24,
        agentProvider: "codex",
        operatorInputOnly: true,
      });
      await execDb(
        client,
        "UPDATE stage_run SET agent = 'merge' WHERE id = ?",
        [runId],
      );
      await execDb(
        client,
        "UPDATE pipeline_item SET activity_revision = activity_revision + 1 WHERE id = ?",
        [taskId],
      );
      await selectTaskWithPolicy(taskId, true);
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
      const textarea = await selectTaskWithPolicy(taskId, true);
      await client.executeSync<void>(`
        window.__KANNA_E2E__?.invokes?.clear();
        document.querySelector(${JSON.stringify(terminalSelector(true))})?.focus();
      `);
      await client.sendKeys(textarea, `${protectedMarker}\n`);

      await callVueMethod(client, "loadItems");
      await waitForSelectedTask(taskId);
      const continuity = await client.executeSync<{ marker: string | null; focused: boolean }>(`
        const terminal = document.querySelector(${JSON.stringify(terminalSelector(true))});
        return {
          marker: terminal?.dataset?.continuityMarker ?? null,
          focused: document.activeElement === terminal,
        };
      `);
      expect(continuity).toEqual({ marker: continuityMarker, focused: true });

      await waitForTerminalOutput(taskId, `merge-native-input:${protectedMarker}`);
      invokes = await client.executeSync<Array<{ cmd: string; args?: unknown }>>(
        "return window.__KANNA_E2E__?.invokes?.getAll() ?? [];",
      );
      expect(invokes.some((record) => record.cmd === "send_operator_input")).toBe(true);
      expect(invokes.some((record) => record.cmd === "send_input")).toBe(false);

      await tauriInvoke(client, "kill_session", { sessionId: taskId });
      await tauriInvoke(client, "spawn_session", {
        sessionId: taskId,
        cwd: "/tmp",
        executable: "/bin/sh",
        args: ["-c", "printf 'generic-after-ready\\n'; IFS= read -r line; printf 'generic-after-input:%s\\n' \"$line\"; sleep 30"],
        env: {},
        cols: 80,
        rows: 24,
        agentProvider: "codex",
        operatorInputOnly: false,
      });
      await execDb(
        client,
        "UPDATE stage_run SET agent = 'implement' WHERE id = ?",
        [runId],
      );
      await execDb(
        client,
        "UPDATE pipeline_item SET activity_revision = activity_revision + 1 WHERE id = ?",
        [taskId],
      );
      const genericAfterTextarea = await selectTaskWithPolicy(taskId, false);
      const reverseContinuity = await client.executeSync<{ marker: string | null; focused: boolean }>(`
        const terminal = document.querySelector(${JSON.stringify(terminalSelector(false))});
        terminal?.focus();
        return {
          marker: terminal?.dataset?.continuityMarker ?? null,
          focused: document.activeElement === terminal,
        };
      `);
      expect(reverseContinuity).toEqual({ marker: continuityMarker, focused: true });
      await client.executeSync<void>("window.__KANNA_E2E__?.invokes?.clear();");
      await client.sendKeys(genericAfterTextarea, `${genericAfterMarker}\n`);
      await waitForTerminalOutput(taskId, `generic-after-input:${genericAfterMarker}`);
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
