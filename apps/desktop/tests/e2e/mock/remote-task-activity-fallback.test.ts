import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDatabase } from "../helpers/reset";
import { WebDriverClient } from "../helpers/webdriver";

/**
 * Remote projection of the sidebar's two dimensions.
 *
 * A task owned by another desktop reaches this window through the LAN or cloud
 * projection, which carries the blended `activity` and nothing else — there is
 * no `runtime_state` and no `read_state` for a session this machine does not
 * run. The sidebar reads the two dimensions when they exist and must fall back
 * to `activity` when they do not, or every remote row would render as settled
 * and read.
 *
 * The local counterpart of this is proved against a real PTY in
 * `real/pty-runtime-status.test.ts`.
 */

type RemoteSource = "lan" | "cloud";

function taskIds(source: RemoteSource) {
  return {
    working: `${source}:remote-repo:task-remote-working`,
    unread: `${source}:remote-repo:task-remote-unread`,
    idle: `${source}:remote-repo:task-remote-idle`,
    dimensioned: `${source}:remote-repo:task-remote-dimensioned`,
  };
}

function remoteSnapshot(source: RemoteSource, updatedAt: string) {
  const ids = taskIds(source);
  // Deliberately carries no `runtime_state` and no `read_state`: that absence
  // is the thing under test.
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
    blocker_revision: 2,
    transition_revision: "run-remote-1",
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
    created_at: "2026-09-07T00:00:00.000Z",
    updated_at: updatedAt,
  };
  const terminalRef = (ownerLocalTaskId: string) => ({
    ownerDesktopId: "peer-remote-activity",
    ownerLocalRepoId: "remote-repo",
    ownerLocalTaskId,
    transport: source,
  });
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
      created_at: "2026-09-07T00:00:00.000Z",
      last_opened_at: "2026-09-07T00:00:00.000Z",
    }],
    items: [
      {
        ...defaults,
        id: ids.working,
        prompt: "Remote task that is working",
        display_name: "Remote working",
        branch: "task-remote-working",
        activity: "working",
      },
      {
        ...defaults,
        id: ids.unread,
        prompt: "Remote task with unread output",
        display_name: "Remote unread",
        branch: "task-remote-unread",
        activity: "unread",
      },
      {
        ...defaults,
        id: ids.idle,
        prompt: "Remote task that is settled and read",
        display_name: "Remote idle",
        branch: "task-remote-idle",
        activity: "idle",
      },
      {
        // The contrast row: this one does carry dimensions, and they disagree
        // with `activity`. It is what makes the three rows above a genuine
        // fallback rather than the only path the sidebar has.
        ...defaults,
        id: ids.dimensioned,
        prompt: "Remote task whose dimensions disagree with activity",
        display_name: "Remote dimensioned",
        branch: "task-remote-dimensioned",
        activity: "working",
        runtime_state: "idle",
        read_state: "unread",
      },
    ],
    terminalRefs: {
      [ids.working]: terminalRef("task-remote-working"),
      [ids.unread]: terminalRef("task-remote-unread"),
      [ids.idle]: terminalRef("task-remote-idle"),
      [ids.dimensioned]: terminalRef("task-remote-dimensioned"),
    },
    blockedByTaskIds: {},
    transferMachines: [],
  };
}

async function injectSnapshot(
  client: WebDriverClient,
  source: RemoteSource,
  updatedAt: string,
): Promise<void> {
  const result = await client.executeSync<string>(
    `const ctx = window.__KANNA_E2E__.setupState;
     ctx.__e2eInjectRemoteSnapshot(
       ${JSON.stringify(source)},
       ${JSON.stringify(remoteSnapshot(source, updatedAt))},
       { freezeLanRefresh: true },
     );
     return "ok";`,
  );
  expect(result).toBe("ok");
}

interface RemoteRowRender {
  selected: boolean;
  fontStyle: string;
  fontWeight: string;
}

async function readRow(
  client: WebDriverClient,
  taskId: string,
): Promise<RemoteRowRender | null> {
  return await client.executeSync<RemoteRowRender | null>(`
    const row = document.querySelector(
      '.sidebar .workflow-item[data-task-id=' + ${JSON.stringify(JSON.stringify(taskId))} + ']'
    );
    const title = row?.querySelector('.item-title');
    return row && title ? {
      selected: row.classList.contains('selected'),
      fontStyle: title.style.fontStyle,
      fontWeight: title.style.fontWeight,
    } : null;
  `);
}

describe("remote task sidebar activity fallback", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  for (const source of ["lan", "cloud"] as const) {
    it(`renders ${source} remote rows from activity when no dimensions are projected`, async () => {
      // App readiness precedes the first periodic LAN refresh; let that settle
      // before freezing the source with the injected snapshot.
      await sleep(1_250);
      await injectSnapshot(
        client,
        source,
        `2026-09-07T01:0${source === "lan" ? "0" : "2"}:00.000Z`,
      );

      const ids = taskIds(source);
      await client.waitForElement(
        `.sidebar .workflow-item[data-task-id="${ids.working}"]`,
        5_000,
      );

      // The three rows below are projected with no dimensions at all, which is
      // what makes them the fallback path.
      const projected = remoteSnapshot(source, "unused").items;
      for (const id of [ids.working, ids.unread, ids.idle]) {
        const item = projected.find((entry) => entry.id === id);
        expect(item).toBeDefined();
        expect(item).not.toHaveProperty("runtime_state");
        expect(item).not.toHaveProperty("read_state");
      }

      const working = await readRow(client, ids.working);
      expect(working?.selected).toBe(false);
      expect(working?.fontStyle).toBe("italic");
      expect(working?.fontWeight).toBe("normal");

      const unread = await readRow(client, ids.unread);
      expect(unread?.selected).toBe(false);
      expect(unread?.fontStyle).toBe("normal");
      expect(unread?.fontWeight).toBe("bold");

      const idle = await readRow(client, ids.idle);
      expect(idle?.selected).toBe(false);
      expect(idle?.fontStyle).toBe("normal");
      expect(idle?.fontWeight).toBe("normal");

      // And where a remote projection does carry dimensions, they outrank the
      // blended value: `activity` says working, the runtime dimension says the
      // session settled, and the row draws settled-and-unread.
      const dimensioned = await readRow(client, ids.dimensioned);
      expect(dimensioned?.selected).toBe(false);
      expect(dimensioned?.fontStyle).toBe("normal");
      expect(dimensioned?.fontWeight).toBe("bold");
    });
  }
});
