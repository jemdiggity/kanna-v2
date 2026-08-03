import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SEED, seedDatabase } from "../helpers/seed";
import { execDb, queryDb, tauriInvoke } from "../helpers/vue";
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
});
