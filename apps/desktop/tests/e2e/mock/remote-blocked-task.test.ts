import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildGlobalKeydownScript,
  buildHandledGlobalKeydownScript,
} from "../helpers/keyboard";
import { resetDatabase } from "../helpers/reset";
import { WebDriverClient } from "../helpers/webdriver";

type RemoteSource = "lan" | "cloud";

function taskIds(source: RemoteSource) {
  return {
    blocked: `${source}:remote-repo:task-blocked`,
    blocker: `${source}:remote-repo:task-blocker`,
  };
}

function remoteSnapshot(source: RemoteSource, blocked: boolean, updatedAt: string) {
  const ids = taskIds(source);
  const defaults = {
    repo_id: "lan:remote-repo",
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
    blocker_revision: blocked ? 1 : 2,
    transition_revision: "run-blocked-1",
    activity_changed_at: updatedAt,
    unread_at: null,
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: "origin/main",
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: updatedAt,
  };
  return {
    repos: [{
      id: "lan:remote-repo",
      path: "cloud",
      name: "Remote Repo",
      default_branch: "main",
      remote_url: "git@github.com:owner/remote.git",
      remote_url_hash: "remote-hash",
      hidden: 0,
      sort_order: 0,
      created_at: "2026-07-26T00:00:00.000Z",
      last_opened_at: "2026-07-26T00:00:00.000Z",
    }],
    items: [
      {
        ...defaults,
        id: ids.blocked,
        prompt: "Advance the remote task",
        display_name: "Blocked remote task",
        branch: "task-blocked",
      },
      {
        ...defaults,
        id: ids.blocker,
        prompt: "Resolve the remote blocker",
        display_name: "Remote blocker",
        branch: "task-blocker",
      },
    ],
    terminalRefs: {
      [ids.blocked]: {
        ownerDesktopId: "peer-review-missing",
        ownerLocalRepoId: "remote-repo",
        ownerLocalTaskId: "task-blocked",
        transport: source,
      },
      [ids.blocker]: {
        ownerDesktopId: "peer-review-missing",
        ownerLocalRepoId: "remote-repo",
        ownerLocalTaskId: "task-blocker",
        transport: source,
      },
    },
    blockedByTaskIds: blocked ? { [ids.blocked]: ["task-blocker"] } : {},
    transferMachines: [],
  };
}

async function injectSnapshot(
  client: WebDriverClient,
  source: RemoteSource,
  blocked: boolean,
  updatedAt: string,
): Promise<void> {
  const result = await client.executeSync<string>(
    `const ctx = window.__KANNA_E2E__.setupState;
     ctx.__e2eInjectRemoteSnapshot(
       ${JSON.stringify(source)},
       ${JSON.stringify(remoteSnapshot(source, blocked, updatedAt))},
       { freezeLanRefresh: true },
     );
     return "ok";`,
  );
  expect(result).toBe("ok");
}

describe("remote blocked task journey", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  for (const source of ["lan", "cloud"] as const) {
    it(`guards Cmd+S and surfaces an owner action failure from ${source} snapshots`, async () => {
      // App readiness precedes the first periodic LAN refresh; let that initial
      // refresh settle before freezing the source with the injected snapshot.
      await sleep(1_250);
      await injectSnapshot(
        client,
        source,
        true,
        `2026-07-26T01:0${source === "lan" ? "0" : "2"}:00.000Z`,
      );

      const ids = taskIds(source);
      const blockedRowSelector = `.sidebar .workflow-item[data-task-id="${ids.blocked}"]`;
      await client.waitForElement(blockedRowSelector, 5_000);
      const blockedRowText = await client.executeSync<string>(
        `return document.querySelector(${JSON.stringify(blockedRowSelector)})?.textContent || "";`,
      );
      expect(blockedRowText).toContain("Blocked remote task");
      expect(blockedRowText).toContain("Remote blocker");
      expect(await client.executeSync<string>(
        `const row = document.querySelector(${JSON.stringify(blockedRowSelector)});
         return row?.parentElement?.previousElementSibling?.textContent || "";`,
      )).toContain("Blocked");

      await client.executeSync(
        `document.querySelector(${JSON.stringify(blockedRowSelector)})?.click();`,
      );
      await client.waitForText(".main-panel .blocked-placeholder", "Blocked", 5_000);
      await client.waitForText(".main-panel .blocker-name", "Remote blocker", 5_000);

      await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
      const blockedShortcutHandled = await client.executeSync<boolean>(
        buildHandledGlobalKeydownScript({ key: "s", meta: true }),
      );
      expect(blockedShortcutHandled).toBe(true);
      await client.waitForText(".toast.warning", "Task Blocked", 5_000);
      expect(await client.executeSync<number>(
        `return window.__KANNA_E2E__.invokes.getAll()
          .filter((call) => call.cmd === "advance_transfer_peer_task_stage").length;`,
      )).toBe(0);

      await injectSnapshot(
        client,
        source,
        false,
        `2026-07-26T01:0${source === "lan" ? "1" : "3"}:00.000Z`,
      );
      await client.waitForNoElement(".main-panel .blocked-placeholder", 5_000);
      if (source === "lan") {
        await client.executeSync(
          `window.__KANNA_E2E__.invokes.failNext(
            "advance_transfer_peer_task_stage",
            "peer-review-missing rejected the lifecycle action",
          );`,
        );
      } else {
        await client.executeSync(
          `window.__KANNA_E2E__.setupState.__e2eFailNextRemoteAction(
            "relay rejected the cloud lifecycle action",
          );`,
        );
      }
      await client.executeSync(buildGlobalKeydownScript({ key: "s", meta: true }));
      await client.waitForText(
        ".toast.error",
        source === "lan" ? "peer-review-missing" : "relay rejected",
        10_000,
      );
      expect(await client.executeSync<number>(
        `return window.__KANNA_E2E__.invokes.getAll()
          .filter((call) => call.cmd === "advance_transfer_peer_task_stage").length;`,
      )).toBe(source === "lan" ? 1 : 0);

      await sleep(50);
    });
  }
});
