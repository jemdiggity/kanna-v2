import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, getVueState, queryDb } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const NEW_WINDOW_FIXTURE_AGENT_TYPE = "test";

interface WebDriverErrorValue {
  error?: string;
  message?: string;
}

interface WebDriverResponse<T> {
  value: T | WebDriverErrorValue;
}

function getClientSessionId(client: WebDriverClient): string {
  const state = client as unknown as { sessionId?: string | null };
  if (!state.sessionId) {
    throw new Error("No WebDriver session. Call createSession() first.");
  }
  return state.sessionId;
}

async function getWindowHandles(client: WebDriverClient): Promise<string[]> {
  const sessionId = getClientSessionId(client);
  const response = await fetch(
    `${client.getBaseUrl()}/session/${sessionId}/window/handles`,
  );
  const body = await response.json() as WebDriverResponse<string[]>;
  if (
    typeof body.value === "object" &&
    body.value !== null &&
    "error" in body.value
  ) {
    throw new Error(`WebDriver error: ${body.value.message ?? "unknown error"}`);
  }
  return Array.isArray(body.value) ? body.value : [];
}

async function switchToWindow(client: WebDriverClient, handle: string): Promise<void> {
  const sessionId = getClientSessionId(client);
  const response = await fetch(`${client.getBaseUrl()}/session/${sessionId}/window`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ handle }),
  });
  const body = await response.json() as WebDriverResponse<null>;
  if (
    typeof body.value === "object" &&
    body.value !== null &&
    "error" in body.value
  ) {
    throw new Error(`WebDriver error: ${body.value.message ?? "unknown error"}`);
  }
}

async function closeFocusedWindowThroughAppAction(client: WebDriverClient): Promise<void> {
  const result = await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     setTimeout(() => {
       void Promise.resolve(ctx.keyboardActions?.closeWindow?.() ?? ctx.windowWorkspace.closeWindow())
         .catch((error) => console.error("[e2e] close focused window failed", error));
     }, 0);
     cb("scheduled");`,
  );
  if (
    typeof result === "object" &&
    result !== null &&
    "__error" in result
  ) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
}

async function waitForWindowCount(
  client: WebDriverClient,
  count: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handles = await getWindowHandles(client);
    if (handles.length === count) {
      return handles;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${count} windows.`);
}

async function setSelectedItem(client: WebDriverClient, itemId: string): Promise<void> {
  await callVueMethod(client, "store.selectItem", itemId);
}

async function waitForCurrentItemId(
  client: WebDriverClient,
  itemId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentItem = await getVueState(client, "currentItem") as { id?: string | null } | null;
    if (currentItem?.id === itemId) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for current item ${itemId}`);
}

async function waitForTaskActivity(
  client: WebDriverClient,
  itemId: string,
  activity: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastActivity: string | null = null;
  while (Date.now() < deadline) {
    const items = await getVueState(client, "items") as Array<{ id: string; activity?: string | null }>;
    lastActivity = items.find((item) => item.id === itemId)?.activity ?? null;
    if (lastActivity === activity) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for task ${itemId} activity ${activity}; last activity was ${lastActivity}`);
}

async function taskTitleFontWeight(client: WebDriverClient, title: string): Promise<string> {
  return client.executeSync<string>(
    `const title = ${JSON.stringify(title)};
     const el = Array.from(document.querySelectorAll(".pipeline-item .item-title"))
       .find((candidate) => (candidate.textContent || "").includes(title));
     return el ? window.getComputedStyle(el).fontWeight : "";`,
  );
}

async function findWindowHandleForItem(
  client: WebDriverClient,
  handles: string[],
  itemId: string,
): Promise<string> {
  for (const handle of handles) {
    await switchToWindow(client, handle);
    await client.waitForAppReady();
    const currentItem = await getVueState(client, "currentItem") as { id?: string | null } | null;
    const items = await getVueState(client, "items") as Array<{ id: string }>;
    if (currentItem?.id === itemId || items.some((item) => item.id === itemId)) {
      return handle;
    }
  }

  throw new Error(`Unable to find a window containing item ${itemId}`);
}

async function readWorkspaceWindowIds(client: WebDriverClient): Promise<string[]> {
  const rows = await queryDb(
    client,
    "SELECT value FROM settings WHERE key = ?",
    ["window_workspace_v1"],
  ) as Array<{ value?: string | null }>;
  const raw = rows[0]?.value;
  if (!raw) return [];
  const snapshot = JSON.parse(raw) as { windows?: Array<{ windowId?: string | null }> };
  return (snapshot.windows ?? [])
    .map((entry) => entry.windowId)
    .filter((windowId): windowId is string => typeof windowId === "string" && windowId.length > 0);
}

async function forgetFocusedWindowWithoutDestroyingHarness(
  client: WebDriverClient,
): Promise<void> {
  const result = await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(ctx.windowWorkspace.forgetCurrentWindow())
       .then(() => cb({ ok: true }))
       .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
  ) as { ok?: boolean; __error?: string };
  if (result.__error) {
    throw new Error(result.__error);
  }
}

describe("new window", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    fixtureRepoRoot = await createFixtureRepo("new-window-test");
    testRepoPath = fixtureRepoRoot;
  });

  afterAll(async () => {
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("opens a second window with the same repo data but independent task selection", async () => {
    const repoId = await importTestRepo(client, testRepoPath, "new-window-test");
    const taskAId = randomUUID();
    const taskBId = randomUUID();

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskAId, repoId, "Task A", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE],
    );
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskBId, repoId, "Task B", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE],
    );
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, taskAId);
    await waitForCurrentItemId(client, taskAId);

    const initialHandles = await getWindowHandles(client);
    expect(initialHandles.length).toBeGreaterThanOrEqual(1);
    const sourceHandle = await findWindowHandleForItem(client, initialHandles, taskAId);
    await switchToWindow(client, sourceHandle);

    await client.executeAsync(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(
         ctx.windowWorkspace.openWindow({
           selectedRepoId: ${JSON.stringify(repoId)},
           selectedItemId: ${JSON.stringify(taskAId)},
         })
       ).then(() => cb("ok"))
        .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
    );

    const handles = await waitForWindowCount(client, initialHandles.length + 1);
    const secondHandle = handles.find((handle) => !initialHandles.includes(handle));
    expect(secondHandle).toBeTruthy();

    await switchToWindow(client, secondHandle ?? "");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    const secondWindowRepoId = await getVueState(client, "selectedRepoId");
    const secondWindowItems = await getVueState(client, "items") as Array<{ id: string }>;
    await waitForCurrentItemId(client, taskAId);
    const secondWindowCurrentItem = await getVueState(client, "currentItem") as { id: string };

    expect(secondWindowRepoId).toBe(repoId);
    expect(secondWindowCurrentItem.id).toBe(taskAId);
    expect(secondWindowItems.map((item) => item.id)).toEqual(
      expect.arrayContaining([taskAId, taskBId]),
    );

    await setSelectedItem(client, taskBId);
    await waitForCurrentItemId(client, taskBId);

    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
    await waitForCurrentItemId(client, taskAId);

    const sourceWindowCurrentItem = await getVueState(client, "currentItem") as { id: string };
    expect(sourceWindowCurrentItem.id).toBe(taskAId);

    await switchToWindow(client, secondHandle ?? "");
    await closeFocusedWindowThroughAppAction(client);
    await waitForWindowCount(client, initialHandles.length);
    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
  });

  it("syncs unread-to-read changes across open windows", async () => {
    const repoId = await importTestRepo(client, testRepoPath, "new-window-read-sync-test");
    const idleTaskId = randomUUID();
    const unreadTaskId = randomUUID();

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type, activity, activity_changed_at, unread_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'), NULL)",
      [idleTaskId, repoId, "Read Sync Idle", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE, "idle"],
    );
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type, activity, activity_changed_at, unread_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))",
      [unreadTaskId, repoId, "Read Sync Unread", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE, "unread"],
    );
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, idleTaskId);
    await waitForCurrentItemId(client, idleTaskId);
    await waitForTaskActivity(client, unreadTaskId, "unread");
    expect(await taskTitleFontWeight(client, "Read Sync Unread")).toMatch(/^(700|bold)$/);

    const initialHandles = await getWindowHandles(client);
    const sourceHandle = await findWindowHandleForItem(client, initialHandles, idleTaskId);
    await switchToWindow(client, sourceHandle);

    await client.executeAsync(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(
         ctx.windowWorkspace.openWindow({
           selectedRepoId: ${JSON.stringify(repoId)},
           selectedItemId: ${JSON.stringify(idleTaskId)},
         })
       ).then(() => cb("ok"))
        .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
    );

    const handles = await waitForWindowCount(client, initialHandles.length + 1);
    const secondHandle = handles.find((handle) => !initialHandles.includes(handle));
    expect(secondHandle).toBeTruthy();

    await switchToWindow(client, secondHandle ?? "");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    await waitForCurrentItemId(client, idleTaskId);

    await setSelectedItem(client, unreadTaskId);
    await waitForCurrentItemId(client, unreadTaskId);
    await waitForTaskActivity(client, unreadTaskId, "idle");

    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
    await waitForTaskActivity(client, unreadTaskId, "idle");
    expect(await taskTitleFontWeight(client, "Read Sync Unread")).toMatch(/^(400|normal)$/);

    await switchToWindow(client, secondHandle ?? "");
    await closeFocusedWindowThroughAppAction(client);
    await waitForWindowCount(client, initialHandles.length);
    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
  });

  it("closes the focused secondary window without changing the remaining window selection", async () => {
    const repoId = await importTestRepo(client, testRepoPath, "new-window-close-test");
    const taskAId = randomUUID();
    const taskBId = randomUUID();

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskAId, repoId, "Task A", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE],
    );
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskBId, repoId, "Task B", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE],
    );
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, taskAId);
    await waitForCurrentItemId(client, taskAId);

    const initialHandles = await getWindowHandles(client);
    expect(initialHandles.length).toBeGreaterThanOrEqual(1);
    const sourceHandle = await findWindowHandleForItem(client, initialHandles, taskAId);
    await switchToWindow(client, sourceHandle);

    await client.executeAsync(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(
         ctx.windowWorkspace.openWindow({
           selectedRepoId: ${JSON.stringify(repoId)},
           selectedItemId: ${JSON.stringify(taskAId)},
         })
       ).then(() => cb("ok"))
        .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
    );

    const handles = await waitForWindowCount(client, initialHandles.length + 1);
    const secondHandle = handles.find((handle) => !initialHandles.includes(handle));
    expect(secondHandle).toBeTruthy();

    await switchToWindow(client, secondHandle ?? "");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    await setSelectedItem(client, taskBId);
    await waitForCurrentItemId(client, taskBId);
    const closingWindowId = await client.executeSync<string>(
      "return window.__KANNA_E2E__.setupState.windowWorkspace.bootstrap.windowId;",
    );
    expect(await readWorkspaceWindowIds(client)).toContain(closingWindowId);

    await closeFocusedWindowThroughAppAction(client);

    const remainingHandles = await waitForWindowCount(client, initialHandles.length);
    expect(remainingHandles).toContain(sourceHandle);
    expect(remainingHandles).not.toContain(secondHandle);

    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
    expect(await readWorkspaceWindowIds(client)).not.toContain(closingWindowId);
    await waitForCurrentItemId(client, taskAId);

    const sourceWindowCurrentItem = await getVueState(client, "currentItem") as { id: string };
    expect(sourceWindowCurrentItem.id).toBe(taskAId);
  });

  it("prunes stale saved secondary windows when the only live main window closes", async () => {
    const repoId = await importTestRepo(client, testRepoPath, "new-window-close-stale-snapshot-test");
    const taskId = randomUUID();

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskId, repoId, "Live Main Task", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE],
    );
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, taskId);
    await waitForCurrentItemId(client, taskId);

    const handles = await waitForWindowCount(client, 1);
    await switchToWindow(client, handles[0] ?? "");
    await client.waitForAppReady();

    const liveWindowId = await client.executeSync<string>(
      "return window.__KANNA_E2E__.setupState.windowWorkspace.bootstrap.windowId;",
    );
    expect(liveWindowId).toBe("main");

    const staleWindowId = `stale-${randomUUID()}`;
    const snapshot = {
      windows: [
        {
          windowId: "main",
          selectedRepoId: repoId,
          selectedItemId: taskId,
          order: 0,
          sidebarHidden: false,
          sidebarWidth: 260,
        },
        {
          windowId: staleWindowId,
          selectedRepoId: repoId,
          selectedItemId: taskId,
          order: 1,
          sidebarHidden: false,
          sidebarWidth: 260,
        },
      ],
    };
    await execDb(
      client,
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ["window_workspace_v1", JSON.stringify(snapshot)],
    );
    expect(await readWorkspaceWindowIds(client)).toEqual(["main", staleWindowId]);

    // The WebDriver harness has no API to relaunch the Tauri app after closing
    // the last native window, and DB helpers run through the live webview. The
    // native close path is covered by windowWorkspace.tauri.test.ts; this E2E
    // exercises live Tauri webview enumeration and settings persistence.
    await forgetFocusedWindowWithoutDestroyingHarness(client);

    expect(await readWorkspaceWindowIds(client)).toEqual([]);

    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
  });

  it("closes the source window while keeping the secondary window alive", async () => {
    const repoId = await importTestRepo(client, testRepoPath, "new-window-close-source-test");
    const taskAId = randomUUID();
    const taskBId = randomUUID();

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskAId, repoId, "Task A", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE],
    );
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskBId, repoId, "Task B", "in progress", NEW_WINDOW_FIXTURE_AGENT_TYPE],
    );
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, taskAId);
    await waitForCurrentItemId(client, taskAId);

    const initialHandles = await getWindowHandles(client);
    expect(initialHandles.length).toBeGreaterThanOrEqual(1);
    const sourceHandle = await findWindowHandleForItem(client, initialHandles, taskAId);
    await switchToWindow(client, sourceHandle);

    await client.executeAsync(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(
         ctx.windowWorkspace.openWindow({
           selectedRepoId: ${JSON.stringify(repoId)},
           selectedItemId: ${JSON.stringify(taskAId)},
         })
       ).then(() => cb("ok"))
        .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
    );

    const handles = await waitForWindowCount(client, initialHandles.length + 1);
    const secondHandle = handles.find((handle) => !initialHandles.includes(handle));
    expect(secondHandle).toBeTruthy();

    await switchToWindow(client, secondHandle ?? "");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    await waitForCurrentItemId(client, taskAId);

    await switchToWindow(client, sourceHandle);
    await closeFocusedWindowThroughAppAction(client);

    const remainingHandles = await waitForWindowCount(client, initialHandles.length);
    expect(remainingHandles).toContain(secondHandle);
    expect(remainingHandles).not.toContain(sourceHandle);

    await switchToWindow(client, secondHandle ?? "");
    await client.waitForAppReady();
    await waitForCurrentItemId(client, taskAId);

    const secondWindowItems = await getVueState(client, "items") as Array<{ id: string }>;
    expect(secondWindowItems.map((item) => item.id)).toEqual(
      expect.arrayContaining([taskAId, taskBId]),
    );
  });
});
