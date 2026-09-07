import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, tauriInvoke } from "../helpers/vue";
import { localProcessFetch } from "@kanna/local-process-fetch";

async function serverBaseUrl(client: WebDriverClient): Promise<string> {
  const port = await tauriInvoke(client, "read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" })
    .catch(() => null);
  return `http://127.0.0.1:${typeof port === "string" && port.length > 0 ? port : "48120"}`;
}

async function seedAnalyticsRepo(client: WebDriverClient): Promise<void> {
  await execDb(
    client,
    `INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
     VALUES (?, ?, ?, 'main', 0, 0, '2026-04-17 08:00:00', '2026-04-17 08:00:00')`,
    ["repo-phase3", "/tmp/repo-phase3", "phase3-repo"],
  );
  await execDb(
    client,
    `INSERT INTO pipeline_item (
       id, repo_id, prompt, stage, branch, agent_type, activity, pinned,
       display_name, created_at, updated_at, closed_at, pipeline, agent_provider
     ) VALUES (?, ?, ?, 'in progress', ?, 'pty', 'idle', 0, ?, ?, ?, ?, 'default', 'claude')`,
    [
      "task-phase3-closed",
      "repo-phase3",
      "closed prompt",
      "task-phase3-closed",
      "Closed analytics task",
      "2026-04-17 08:00:00",
      "2026-04-19 08:00:00",
      "2026-04-19 08:00:00",
    ],
  );
  await execDb(
    client,
    `INSERT INTO pipeline_item (
       id, repo_id, prompt, stage, branch, agent_type, activity, pinned,
       display_name, created_at, updated_at, pipeline, agent_provider
     ) VALUES (?, ?, ?, 'in progress', ?, 'pty', 'idle', 0, ?, ?, ?, 'default', 'claude')`,
    [
      "task-phase3-open",
      "repo-phase3",
      "open prompt",
      "task-phase3-open",
      "Open analytics task",
      "2026-04-18 08:00:00",
      "2026-04-18 08:00:00",
    ],
  );
  await execDb(
    client,
    "INSERT INTO activity_log (pipeline_item_id, activity, seconds) VALUES (?, ?, ?)",
    ["task-phase3-closed", "working", 120],
  );
  await execDb(
    client,
    "INSERT INTO activity_log (pipeline_item_id, activity, seconds) VALUES (?, ?, ?)",
    ["task-phase3-closed", "idle", 60],
  );
  await execDb(
    client,
    `INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
     VALUES (?, ?, ?, ?)`,
    ["task_selected", "task-phase3-closed", "repo-phase3", "2026-04-17 08:05:00"],
  );
  await execDb(
    client,
    `INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
     VALUES (?, ?, ?, ?)`,
    ["task_selected", "task-phase3-open", "repo-phase3", "2026-04-17 08:07:00"],
  );
  await callVueMethod(client, "store.reloadSnapshot");
}

describe("desktop server phase 3 paths", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await seedAnalyticsRepo(client);
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("persists selected repo through the settings API", async () => {
    await callVueMethod(client, "store.selectRepo", "repo-phase3");
    const response = await localProcessFetch(`${await serverBaseUrl(client)}/v1/settings/selected_repo_id`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      key: "selected_repo_id",
      value: "repo-phase3",
    });
  });

  it("renders analytics from the server-backed endpoint", async () => {
    await callVueMethod(client, "store.selectRepo", "repo-phase3");
    await callVueMethod(client, "keyboardActions.showAnalytics");
    await client.waitForText(".analytics-modal", "Tasks");
    await client.waitForText(".analytics-modal", "Created");
    await client.waitForText(".analytics-modal", "Closed");

    const cardValues = await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll(".analytics-modal .card-value"))
        .map((element) => element.textContent?.trim() || "");`,
    );
    expect(cardValues).toEqual(["2", "1", "1"]);
  });
});
