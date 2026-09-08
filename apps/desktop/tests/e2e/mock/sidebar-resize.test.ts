import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { execDb, queryDb } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

interface WorkspaceSnapshot {
  windows?: Array<{
    windowId?: string | null;
    sidebarWidth?: number | null;
  }>;
}

const SIDEBAR_SELECTOR = '[data-testid="sidebar-shell"]';
const RESIZE_HANDLE_SELECTOR = '[data-testid="sidebar-resize-handle"]';
const LONG_TASK_TITLE = [
  "Investigate sidebar resizing with an intentionally long revision task title",
  "that should keep its full text in the DOM while the visible label clips",
  "differently as the user drags the sidebar.",
].join(" ");

interface TitleLayoutSnapshot {
  text: string;
  clientWidth: number;
  scrollWidth: number;
  rectWidth: number;
  itemRectWidth: number;
  overflow: string;
  textOverflow: string;
  whiteSpace: string;
}

async function getSidebarWidth(client: WebDriverClient): Promise<number> {
  return client.executeSync<number>(
    `const sidebar = document.querySelector(${JSON.stringify(SIDEBAR_SELECTOR)});
     return sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0;`,
  );
}

async function getTaskTitleLayout(client: WebDriverClient): Promise<TitleLayoutSnapshot> {
  const result = await client.executeSync<TitleLayoutSnapshot | { __error: string }>(
    `const expectedTitle = ${JSON.stringify(LONG_TASK_TITLE)};
     const title = Array.from(document.querySelectorAll(".sidebar .workflow-item .item-title"))
       .find((candidate) => (candidate.textContent || "") === expectedTitle);
     if (!title) return { __error: "sidebar task title not found" };
     const item = title.closest(".workflow-item");
     if (!item) return { __error: "sidebar task item not found" };
     const style = getComputedStyle(title);
     return {
       text: title.textContent || "",
       clientWidth: Math.round(title.clientWidth),
       scrollWidth: Math.round(title.scrollWidth),
       rectWidth: Math.round(title.getBoundingClientRect().width),
       itemRectWidth: Math.round(item.getBoundingClientRect().width),
       overflow: style.overflow,
       textOverflow: style.textOverflow,
       whiteSpace: style.whiteSpace,
     };`,
  );
  if (typeof result === "object" && result !== null && "__error" in result) {
    throw new Error(result.__error);
  }
  return result;
}

async function getCurrentWindowId(client: WebDriverClient): Promise<string> {
  return client.executeSync<string>(
    "return window.__KANNA_E2E__.setupState.windowWorkspace.bootstrap.windowId;",
  );
}

async function readWorkspaceSnapshotFromDb(client: WebDriverClient): Promise<WorkspaceSnapshot> {
  const rows = await queryDb(
    client,
    "SELECT value FROM settings WHERE key = ?",
    ["window_workspace_v1"],
  ) as Array<{ value?: string | null }>;
  const raw = rows[0]?.value;
  if (!raw) return { windows: [] };

  try {
    const parsed = JSON.parse(raw) as WorkspaceSnapshot;
    return {
      windows: Array.isArray(parsed.windows) ? parsed.windows : [],
    };
  } catch (error) {
    throw new Error(
      `Failed to parse window_workspace_v1: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Callers use this after a page reload, which has to re-run app startup before
// the E2E DB handle exists again — until then every probe throws.
async function waitForWorkspaceSetting(client: WebDriverClient, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const rows = await queryDb(
        client,
        "SELECT key FROM settings WHERE key = ?",
        ["window_workspace_v1"],
      );
      if (rows.length > 0) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for window_workspace_v1 setting; last error was ${String(lastError)}`);
}

async function getPersistedSidebarWidth(
  client: WebDriverClient,
  windowId: string,
): Promise<number | undefined> {
  const snapshot = await readWorkspaceSnapshotFromDb(client);
  const windowState = snapshot.windows?.find((entry) => entry.windowId === windowId);
  return typeof windowState?.sidebarWidth === "number" ? windowState.sidebarWidth : undefined;
}

async function waitForSidebarWidth(
  client: WebDriverClient,
  expected: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastWidth = 0;
  while (Date.now() < deadline) {
    lastWidth = await getSidebarWidth(client);
    if (lastWidth === expected) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for sidebar width ${expected}; last width was ${lastWidth}`);
}

async function waitForPersistedSidebarWidth(
  client: WebDriverClient,
  windowId: string,
  expected: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastWidth: number | undefined;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      lastWidth = await getPersistedSidebarWidth(client, windowId);
      if (lastWidth === expected) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for persisted sidebar width ${expected}; last width was ${lastWidth}; last error was ${String(lastError)}`,
  );
}

async function dragSidebarHandleToWidth(
  client: WebDriverClient,
  targetWidth: number,
): Promise<void> {
  const result = await client.executeSync<string | { __error: string }>(
    `const sidebar = document.querySelector(${JSON.stringify(SIDEBAR_SELECTOR)});
     let handle = document.querySelector(${JSON.stringify(RESIZE_HANDLE_SELECTOR)});
     if (!sidebar) return { __error: "sidebar shell not found" };
     const sidebarRect = sidebar.getBoundingClientRect();
     handle = handle || document.elementFromPoint(
       Math.round(sidebarRect.right),
       Math.round(sidebarRect.top + sidebarRect.height / 2),
     );
     if (!handle) return { __error: "sidebar resize handle not found" };
     const handleRect = handle.getBoundingClientRect();
     const start = {
       x: Math.round(handleRect.left + handleRect.width / 2),
       y: Math.round(handleRect.top + handleRect.height / 2),
     };
     const end = {
       x: Math.round(sidebarRect.left + ${targetWidth}),
       y: Math.round(handleRect.top + handleRect.height / 2),
     };
     const pointerId = 42;
     const buildPointerDown = (point) => {
       const init = {
         bubbles: true,
         cancelable: true,
         pointerId,
         pointerType: "mouse",
         isPrimary: true,
         clientX: point.x,
         clientY: point.y,
         screenX: point.x,
         screenY: point.y,
         button: 0,
         buttons: 1,
       };
       if (typeof PointerEvent === "function") return new PointerEvent("pointerdown", init);
       const event = new MouseEvent("pointerdown", init);
       Object.defineProperties(event, {
         pointerId: { value: pointerId },
         pointerType: { value: "mouse" },
         isPrimary: { value: true },
       });
       return event;
     };
     const buildMousePointerEvent = (type, point, buttons) => {
       const event = new MouseEvent(type, {
         bubbles: true,
         cancelable: true,
         clientX: point.x,
         clientY: point.y,
         screenX: point.x,
         screenY: point.y,
         button: 0,
         buttons,
       });
       Object.defineProperties(event, {
         pointerId: { value: pointerId },
         pointerType: { value: "mouse" },
         isPrimary: { value: true },
       });
       return event;
     };
     const originalSetPointerCapture = handle.setPointerCapture;
     // Synthetic pointer events in WKWebView are not active pointers, so capture
     // can throw even though the app's resize listeners are wired correctly.
     handle.setPointerCapture = () => {};
     try {
       handle.dispatchEvent(buildPointerDown(start));
       document.dispatchEvent(buildMousePointerEvent("pointermove", end, 1));
       document.dispatchEvent(buildMousePointerEvent("pointerup", end, 0));
       return "ok";
     } catch (error) {
       return { __error: error && error.message ? error.message : String(error) };
     } finally {
       handle.setPointerCapture = originalSetPointerCapture;
     }`,
  );
  if (typeof result === "object" && result !== null && "__error" in result) {
    throw new Error(result.__error);
  }
}

describe("sidebar resize", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    testRepoPath = await createFixtureRepo("sidebar-resize-test");
    repoId = await importTestRepo(client, testRepoPath, "sidebar-resize-test");
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      ["sidebar-resize-task", repoId, LONG_TASK_TITLE, "in progress", "agent"],
    );
    // `client.reload()` clears the readiness flags before navigating; a bare
    // location.reload() lets waitForAppReady() see the outgoing page's flag
    // and return while the old DOM is still up, so setupState is gone by the
    // time the test asks for it.
    await client.reload();
    await client.waitForText(".sidebar", "Investigate sidebar resizing");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
      await cleanupFixtureRepos([testRepoPath]);
    }
    await client.deleteSession();
  });

  it("drags, clamps, persists, and restores the desktop sidebar width", async () => {
    const windowId = await getCurrentWindowId(client);
    await client.waitForElement(RESIZE_HANDLE_SELECTOR, 2_000);
    await waitForSidebarWidth(client, 260);

    await dragSidebarHandleToWidth(client, 360);
    await waitForSidebarWidth(client, 360);
    await waitForPersistedSidebarWidth(client, windowId, 360);

    await dragSidebarHandleToWidth(client, 50);
    await waitForSidebarWidth(client, 220);
    await waitForPersistedSidebarWidth(client, windowId, 220);

    await dragSidebarHandleToWidth(client, 600);
    await waitForSidebarWidth(client, 420);
    await waitForPersistedSidebarWidth(client, windowId, 420);

    await client.reload();
    await waitForWorkspaceSetting(client);
    await waitForSidebarWidth(client, 420);
    await waitForPersistedSidebarWidth(client, windowId, 420);
  });

  it("clips long task titles with ellipsis according to the resized sidebar width", async () => {
    await client.waitForElement(RESIZE_HANDLE_SELECTOR, 2_000);
    await client.waitForText(".sidebar", "Investigate sidebar resizing");

    await dragSidebarHandleToWidth(client, 50);
    await waitForSidebarWidth(client, 220);
    const narrow = await getTaskTitleLayout(client);

    await dragSidebarHandleToWidth(client, 600);
    await waitForSidebarWidth(client, 420);
    const wide = await getTaskTitleLayout(client);

    expect(narrow.text).toBe(LONG_TASK_TITLE);
    expect(wide.text).toBe(LONG_TASK_TITLE);
    expect(narrow.text.length).toBeGreaterThan(40);
    expect(narrow.textOverflow).toBe("ellipsis");
    expect(wide.textOverflow).toBe("ellipsis");
    expect(narrow.overflow).toBe("hidden");
    expect(wide.overflow).toBe("hidden");
    expect(narrow.whiteSpace).toBe("nowrap");
    expect(wide.whiteSpace).toBe("nowrap");
    expect(narrow.scrollWidth).toBeGreaterThan(narrow.clientWidth);
    expect(wide.scrollWidth).toBeGreaterThan(wide.clientWidth);
    expect(narrow.rectWidth).toBeLessThanOrEqual(narrow.itemRectWidth);
    expect(wide.rectWidth).toBeLessThanOrEqual(wide.itemRectWidth);
    expect(wide.clientWidth).toBeGreaterThan(narrow.clientWidth + 150);
    expect(wide.scrollWidth).toBe(narrow.scrollWidth);
    expect(wide.scrollWidth - wide.clientWidth).toBeLessThan(narrow.scrollWidth - narrow.clientWidth);
  });
});
