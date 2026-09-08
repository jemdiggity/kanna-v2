import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDatabase } from "../helpers/reset";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { callVueMethod } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

/**
 * An account-wide singleton — the repo's Merge Master or Task Manager — is one
 * task across every machine, so every machine's list pins it by default. The
 * owning machine stamps that pin on its own row when it claims the singleton;
 * a machine that only *views* the task has no row to stamp, so it derives the
 * default from the singleton identity the owner publishes.
 *
 * This exercises the viewing side end to end: injected cross-machine rows,
 * through the workspace build, into the sidebar's pinned zone — and the one
 * thing a default must always allow, an explicit unpin that sticks.
 */

const REPO_ID = "lan:singleton-repo";
const SINGLETON_ID = "lan:singleton-repo:task-merge";
const ORDINARY_ID = "lan:singleton-repo:task-ordinary";

function remoteSnapshot() {
  const defaults = {
    repo_id: REPO_ID,
    issue_number: null,
    issue_title: null,
    pipeline: "cloud",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_revision: 1,
    blocker_revision: 1,
    transition_revision: null,
    activity_changed_at: "2026-09-06T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    // The owner's own pin never crosses: pinning is per-operator, so the row
    // arrives unpinned and this machine decides for itself.
    pinned: 0,
    pin_order: null,
    base_ref: "origin/main",
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-09-06T00:00:00.000Z",
    updated_at: "2026-09-06T00:00:00.000Z",
  };
  return {
    repos: [{
      id: REPO_ID,
      path: "cloud",
      name: "Singleton Repo",
      default_branch: "main",
      remote_url: "git@github.com:owner/singleton.git",
      remote_url_hash: "singleton-remote-hash",
      hidden: 0,
      sort_order: 0,
      created_at: "2026-09-06T00:00:00.000Z",
      last_opened_at: "2026-09-06T00:00:00.000Z",
    }],
    items: [
      {
        ...defaults,
        id: SINGLETON_ID,
        prompt: "Merge ready pull requests",
        display_name: "Merge Master",
        branch: "task-merge",
        singleton_agent: "merge",
      },
      {
        ...defaults,
        id: ORDINARY_ID,
        prompt: "Ordinary remote work",
        display_name: "Ordinary remote task",
        branch: "task-ordinary",
      },
    ],
    terminalRefs: {
      [SINGLETON_ID]: {
        ownerDesktopId: "peer-owner",
        ownerLocalRepoId: "singleton-repo",
        ownerLocalTaskId: "task-merge",
        transport: "lan",
      },
      [ORDINARY_ID]: {
        ownerDesktopId: "peer-owner",
        ownerLocalRepoId: "singleton-repo",
        ownerLocalTaskId: "task-ordinary",
        transport: "lan",
      },
    },
    blockedByTaskIds: {},
    transferMachines: [],
  };
}

async function injectSnapshot(client: WebDriverClient): Promise<void> {
  const result = await client.executeSync<string>(
    `const ctx = window.__KANNA_E2E__.setupState;
     ctx.__e2eInjectRemoteSnapshot(
       "lan",
       ${JSON.stringify(remoteSnapshot())},
       { freezeLanRefresh: true },
     );
     return "ok";`,
  );
  expect(result).toBe("ok");
}

/**
 * The startup shortcuts modal can raise itself after the startup overlays
 * report settled, and it covers the sidebar this test is photographing.
 */
async function closeShortcutsModal(client: WebDriverClient): Promise<void> {
  const visible = await client.executeSync<boolean>(
    `return Boolean(document.querySelector(".shortcuts-modal"));`,
  );
  if (!visible) return;
  await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  await client.waitForNoElement(".shortcuts-modal", 5_000);
}

async function pinnedTaskIds(client: WebDriverClient): Promise<string[]> {
  return client.executeSync<string[]>(
    `return Array.from(
       document.querySelectorAll('.pinned-zone .workflow-item[data-task-id]'),
     ).map(function (row) { return row.getAttribute('data-task-id'); });`,
  );
}

async function renderedTaskIds(client: WebDriverClient): Promise<string[]> {
  return client.executeSync<string[]>(
    `return Array.from(
       document.querySelectorAll('.sidebar .workflow-item[data-task-id]'),
     ).map(function (row) { return row.getAttribute('data-task-id'); });`,
  );
}

async function waitForPinnedIds(
  client: WebDriverClient,
  expected: string[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    seen = await pinnedTaskIds(client);
    if (JSON.stringify(seen) === JSON.stringify(expected)) return;
    await sleep(100);
  }
  expect(seen).toEqual(expected);
}

describe("cross-machine singleton pin default", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("pins a cross-machine singleton by default and keeps an explicit unpin", async () => {
    // App readiness precedes the first periodic LAN refresh; let that settle
    // before freezing the source with the injected snapshot.
    await sleep(1_250);
    await injectSnapshot(client);
    await client.waitForElement(
      `.sidebar .workflow-item[data-task-id="${SINGLETON_ID}"]`,
      5_000,
    );

    // Nobody pinned it here. It is pinned because it is the account-wide
    // singleton, and the ordinary sibling from the same machine is not.
    await waitForPinnedIds(client, [SINGLETON_ID]);
    expect(await renderedTaskIds(client)).toEqual([SINGLETON_ID, ORDINARY_ID]);

    const evidenceDir = process.env.KANNA_VISUAL_EVIDENCE_DIR;
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await closeShortcutsModal(client);
      await client.screenshot(join(evidenceDir, "sidebar-singleton-pinned-by-default.png"));
    }

    const unpinned = await callVueMethod(client, "unpinSidebarTask", SINGLETON_ID);
    expect(unpinned).not.toMatchObject({ __error: expect.any(String) });

    // The default is a default, not a rule: the operator turned it off. The
    // row stays in the list, it just leaves the pinned group.
    await waitForPinnedIds(client, []);
    expect((await renderedTaskIds(client)).slice().sort()).toEqual(
      [ORDINARY_ID, SINGLETON_ID].slice().sort(),
    );

    if (evidenceDir) {
      await client.screenshot(join(evidenceDir, "sidebar-singleton-explicitly-unpinned.png"));
    }

    // A republication of the same rows must not put it back.
    await injectSnapshot(client);
    await sleep(500);
    expect(await pinnedTaskIds(client)).toEqual([]);

    // The operator can still pin it themselves, at their own position.
    const pinned = await callVueMethod(client, "pinSidebarTask", SINGLETON_ID, 0);
    expect(pinned).not.toMatchObject({ __error: expect.any(String) });
    await waitForPinnedIds(client, [SINGLETON_ID]);
  });
});
