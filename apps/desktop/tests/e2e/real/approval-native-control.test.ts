import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SEED, seedDatabase } from "../helpers/seed";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const client = new WebDriverClient();

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

  it("types through MainPanel into a protected merge PTY via native daemon authority", async () => {
    const taskId = `e2e-merge-terminal-${randomUUID()}`;
    const marker = `native-operator-${randomUUID()}`;
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
        args: ["-c", "printf 'merge-native-ready\\n'; IFS= read -r line; printf 'merge-native-input:%s\\n' \"$line\"; sleep 30"],
        env: {},
        cols: 80,
        rows: 24,
        agentProvider: "codex",
        operatorInputOnly: true,
      });
      await callVueMethod(client, "loadItems", SEED.repos.app.id);
      await callVueMethod(client, "store.selectItem", taskId);
      const textarea = await client.waitForElement(
        '.terminal-panel[data-operator-terminal-input="true"] .xterm-helper-textarea',
        15_000,
      );
      await client.sendKeys(textarea, `${marker}\n`);

      let observed = "";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        observed = await client.executeSync<string>(
          `return window.__KANNA_E2E__?.terminalBuffers?.lines(${JSON.stringify(taskId)})?.join("\\n") || "";`,
        );
        if (observed.includes(`merge-native-input:${marker}`)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(observed).toContain(`merge-native-input:${marker}`);
    } finally {
      await tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined);
      await execDb(client, "DELETE FROM terminal_session WHERE pipeline_item_id = ?", [taskId]);
      await execDb(client, "DELETE FROM stage_run WHERE task_id = ?", [taskId]);
      await execDb(client, "DELETE FROM pipeline_item WHERE id = ?", [taskId]);
    }
  }, 30_000);
});
