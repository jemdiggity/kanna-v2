import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { resetDatabase } from "../helpers/reset";
import { WebDriverClient } from "../helpers/webdriver";

const repoId = "lan:remote-close-repo";
const parentTaskId = `${repoId}:task-parent`;
const childATaskId = `${repoId}:task-child-a`;
const childBTaskId = `${repoId}:task-child-b`;

function remoteSnapshot() {
  const defaults = {
    repo_id: repoId,
    issue_number: null,
    issue_title: null,
    pipeline: "default",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "codex",
    activity: "idle",
    activity_revision: 1,
    transition_revision: "run-close-selection-1",
    activity_changed_at: "2026-08-12T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: "origin/main",
    agent_session_id: null,
    teardown_started_at: null,
    notify_task_id: null,
    notified_at: null,
    updated_at: "2026-08-12T00:00:00.000Z",
  };
  return {
    repos: [{
      id: repoId,
      path: "cloud",
      name: "Remote Close Repo",
      default_branch: "main",
      remote_url: "git@github.com:owner/remote-close.git",
      remote_url_hash: "remote-close-hash",
      hidden: 0,
      sort_order: 0,
      created_at: "2026-08-12T00:00:00.000Z",
      last_opened_at: "2026-08-12T00:00:00.000Z",
    }],
    items: [
      {
        ...defaults,
        id: parentTaskId,
        prompt: "Parent remote task",
        display_name: "Remote parent",
        branch: "task-parent",
        parent_task_id: null,
        created_at: "2026-08-12T00:00:00.000Z",
      },
      {
        ...defaults,
        id: childATaskId,
        prompt: "First child remote task",
        display_name: "Remote child A",
        branch: "task-child-a",
        parent_task_id: parentTaskId,
        created_at: "2026-08-12T00:01:00.000Z",
      },
      {
        ...defaults,
        id: childBTaskId,
        prompt: "Second child remote task",
        display_name: "Remote child B",
        branch: "task-child-b",
        parent_task_id: parentTaskId,
        created_at: "2026-08-12T00:02:00.000Z",
      },
    ],
    terminalRefs: Object.fromEntries(
      [parentTaskId, childATaskId, childBTaskId].map((taskId) => [
        taskId,
        {
          ownerDesktopId: "peer-close-owner",
          ownerLocalRepoId: "remote-close-repo",
          ownerLocalTaskId: taskId.slice(repoId.length + 1),
          transport: "lan",
        },
      ]),
    ),
    blockedByTaskIds: {},
    transferMachines: [],
  };
}

async function selectedTaskId(client: WebDriverClient): Promise<string | null> {
  return client.executeSync<string | null>(
    `return document.querySelector(".sidebar .workflow-item.selected")
      ?.getAttribute("data-task-id") ?? null;`,
  );
}

describe("remote task close replacement selection", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("selects the next sibling and then the parent after remote child closes", async () => {
    await sleep(1_250);
    const result = await client.executeSync<string>(
      `window.__KANNA_E2E__.setupState.__e2eInjectRemoteSnapshot(
         "lan",
         ${JSON.stringify(remoteSnapshot())},
         { freezeLanRefresh: true },
       );
       return "ok";`,
    );
    expect(result).toBe("ok");

    const childASelector = `.sidebar .workflow-item[data-task-id="${childATaskId}"]`;
    const childBSelector = `.sidebar .workflow-item[data-task-id="${childBTaskId}"]`;
    const parentSelector = `.sidebar .workflow-item[data-task-id="${parentTaskId}"]`;
    try {
      await client.waitForElement(childASelector, 5_000);
      await client.executeSync(
        `document.querySelector(${JSON.stringify(childASelector)})?.click();`,
      );
      await client.waitForElement(`${childASelector}.selected`, 5_000);

      await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
      await client.executeSync(
        "window.__KANNA_E2E__.invokes.succeedNext('close_transfer_peer_task', null);",
      );
      await client.executeSync(buildGlobalKeydownScript({
        key: "Delete",
        meta: true,
        shift: true,
      }));

      await client.waitForNoElement(childASelector, 5_000);
      await client.waitForElement(`${childBSelector}.selected`, 5_000);
      expect(await selectedTaskId(client)).toBe(childBTaskId);
      expect(await client.executeSync(
        `return window.__KANNA_E2E__.invokes.getAll()
          .filter((call) => call.cmd === "close_transfer_peer_task");`,
      )).toEqual([{
        cmd: "close_transfer_peer_task",
        args: { peerId: "peer-close-owner", taskId: "task-child-a" },
      }]);

      await client.executeSync(
        "window.__KANNA_E2E__.invokes.succeedNext('close_transfer_peer_task', null);",
      );
      await client.executeSync(buildGlobalKeydownScript({
        key: "Delete",
        meta: true,
        shift: true,
      }));

      await client.waitForNoElement(childBSelector, 5_000);
      await client.waitForElement(`${parentSelector}.selected`, 5_000);
      expect(await selectedTaskId(client)).toBe(parentTaskId);
      expect(await client.executeSync(
        `return window.__KANNA_E2E__.invokes.getAll()
          .filter((call) => call.cmd === "close_transfer_peer_task")
          .map((call) => call.args.taskId);`,
      )).toEqual(["task-child-a", "task-child-b"]);
    } finally {
      await client.executeSync(
        `window.__KANNA_E2E__.setupState.__e2eInjectRemoteSnapshot(
           "lan",
           { repos: [], items: [], terminalRefs: {}, blockedByTaskIds: {}, transferMachines: [] },
           { freezeLanRefresh: true },
         );`,
      );
    }
  });
});
