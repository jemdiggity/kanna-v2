import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepoDirect, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb } from "../helpers/vue";

const REPO_NAME = "modal-tear-off";
const STARTUP_REPO_NAME = "modal-tear-off-startup";
const CURRENT_FILE = "selected-context.txt";
const CURRENT_FILE_CONTENT = "current selection preview\n";
const CURRENT_DIFF_FILE = "current-selection-diff.txt";
const STARTUP_TASK_ID = "modal-tear-off-startup-task";
const CURRENT_TASK_ID = "modal-tear-off-current-task";

interface VisibleSelection {
  repoId: string | null;
  repoName: string | null;
  repoPath: string | null;
  taskId: string | null;
}

async function visibleSelection(client: WebDriverClient): Promise<VisibleSelection> {
  return await client.executeSync<VisibleSelection>(
    `const ctx = window.__KANNA_E2E__.setupState;
     const selectedRepo = ctx.store?.selectedRepo?.value ?? ctx.store?.selectedRepo ?? null;
     const currentItem = ctx.store?.currentItem?.value ?? ctx.store?.currentItem ?? null;
     return {
       repoId: selectedRepo?.id ?? null,
       repoName: selectedRepo?.name ?? null,
       repoPath: selectedRepo?.path ?? null,
       taskId: currentItem?.id ?? null,
     };`,
  );
}

async function clickTreeFile(client: WebDriverClient, fileName: string): Promise<void> {
  const clicked = await client.executeSync<boolean>(
    `const item = Array.from(document.querySelectorAll(".col-current .tree-item"))
       .find((entry) => entry.querySelector(".entry-name")?.textContent?.trim() === ${JSON.stringify(fileName)});
     if (!item) return false;
     item.click();
     return true;`,
  );
  expect(clicked).toBe(true);
}

async function createAndSelectTask(
  client: WebDriverClient,
  repoId: string,
  taskId: string,
): Promise<void> {
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, prompt, stage, branch, agent_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskId,
      repoId,
      `Fixture task ${taskId}`,
      "in progress",
      null,
      "agent",
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    ],
  );
  await callVueMethod(client, "refreshAllItems");
  await callVueMethod(client, "store.selectItem", taskId);
}

async function waitForWindowCount(
  client: WebDriverClient,
  count: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handles = await client.getWindowHandles();
    if (handles.length === count) return handles;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${count} windows`);
}

async function closeSecondaryWindow(
  client: WebDriverClient,
  sourceHandle: string,
): Promise<void> {
  await client.executeSync<boolean>(
    `void window.__KANNA_E2E__.setupState.windowWorkspace.closeWindow()
       .catch((error) => console.error("[modal-tear-off.e2e] close failed", error));
     return true;`,
  );
  await waitForWindowCount(client, 1);
  await client.switchToWindow(sourceHandle);
  await client.waitForAppReady();
}

async function dismissStartupShortcuts(client: WebDriverClient): Promise<void> {
  const visible = await client.executeSync<boolean>(
    `return document.querySelector(".shortcuts-modal") !== null;`,
  );
  if (!visible) return;
  await client.pressShortcut(["Escape"]);
  await client.waitForNoElement(".shortcuts-modal", 5_000);
}

/**
 * A torn-off window gives its whole main content area to the view it was
 * dragged out with: the sidebar stands down and the view fills the panel. It
 * is not stretched to the raw viewport any more — the tab bar it belongs to
 * is part of that window now.
 */
async function assertFullWindowModal(
  client: WebDriverClient,
  selector: string,
  expectedSize: { width: number; height: number },
): Promise<void> {
  const dimensions = await client.executeSync<{
    viewportWidth: number;
    viewportHeight: number;
    sidebarPresent: boolean;
    panelWidth: number;
    panelHeight: number;
    modalWidth: number;
    modalHeight: number;
  }>(
    `const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
     const panel = document.querySelector(".main-panel")?.getBoundingClientRect();
     return {
       viewportWidth: window.innerWidth,
       viewportHeight: window.innerHeight,
       sidebarPresent: Boolean(document.querySelector('[data-testid="sidebar-shell"]')),
       panelWidth: panel?.width ?? 0,
       panelHeight: panel?.height ?? 0,
       modalWidth: rect?.width ?? 0,
       modalHeight: rect?.height ?? 0,
     };`,
  );
  const diagnostic = JSON.stringify({ dimensions, expectedSize });
  expect(Math.abs(dimensions.viewportWidth - expectedSize.width), diagnostic).toBeLessThanOrEqual(2);
  expect(Math.abs(dimensions.viewportHeight - expectedSize.height), diagnostic).toBeLessThanOrEqual(2);
  expect(dimensions.sidebarPresent, diagnostic).toBe(false);
  expect(Math.abs(dimensions.panelWidth - dimensions.viewportWidth), diagnostic).toBeLessThanOrEqual(1);
  // The view owns the window's main area, minus the chrome that area keeps —
  // its tab bar and the command hint — so it dominates rather than matching
  // the raw viewport the way a modal stretched to a fresh window used to.
  expect(dimensions.modalWidth, diagnostic).toBeGreaterThan(dimensions.viewportWidth * 0.85);
  expect(dimensions.modalHeight, diagnostic).toBeGreaterThan(dimensions.viewportHeight * 0.6);
}

/**
 * The torn-off window's view must follow a window resize. It fills its main
 * content area rather than the raw viewport — that area also carries the tab
 * bar the view belongs to.
 */
async function assertResizeReflow(client: WebDriverClient, selector: string): Promise<void> {
  const before = await client.getWindowRect();
  await client.setWindowRect({
    width: before.width + 120,
    height: before.height + 80,
  });
  await sleep(200);
  const dimensions = await client.executeSync<{
    panelWidth: number;
    panelHeight: number;
    modalWidth: number;
    modalHeight: number;
  }>(
    `const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
     const panel = document.querySelector(".main-panel")?.getBoundingClientRect();
     return {
       panelWidth: panel?.width ?? 0,
       panelHeight: panel?.height ?? 0,
       modalWidth: rect?.width ?? 0,
       modalHeight: rect?.height ?? 0,
     };`,
  );
  const diagnostic = JSON.stringify(dimensions);
  expect(Math.abs(dimensions.modalWidth - dimensions.panelWidth), diagnostic).toBeLessThanOrEqual(1);
  expect(dimensions.modalHeight, diagnostic).toBeGreaterThan(dimensions.panelHeight * 0.6);
}

async function persistedTearOffCount(client: WebDriverClient): Promise<number> {
  return await client.executeAsync<number>(
    `const cb = arguments[arguments.length - 1];
     window.__KANNA_E2E__.setupState.windowWorkspace.loadSnapshot({ authoritative: true })
       .then((snapshot) => cb(snapshot.windows.filter((entry) => entry.tearOffContext).length))
       .catch((error) => cb(-1));`,
  );
}

async function waitForPersistedTearOffCount(
  client: WebDriverClient,
  expected: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await persistedTearOffCount(client) === expected) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${expected} persisted tear-off windows`);
}

async function persistedTearOffGeometry(client: WebDriverClient): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  return await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     window.__KANNA_E2E__.setupState.windowWorkspace.loadSnapshot({ authoritative: true })
       .then((snapshot) => cb(snapshot.windows.find((entry) => entry.tearOffContext)?.geometry ?? null))
       .catch(() => cb(null));`,
  );
}

describe("modal tear-off", () => {
  const client = new WebDriverClient();
  let startupRepoPath = "";
  let fixtureRepoPath = "";
  let sourceHandle = "";
  let startupSelection: VisibleSelection = {
    repoId: null,
    repoName: null,
    repoPath: null,
    taskId: null,
  };
  let selectedAtDrag: VisibleSelection = {
    repoId: null,
    repoName: null,
    repoPath: null,
    taskId: null,
  };

  beforeAll(async () => {
    startupRepoPath = await createSeedFixtureRepo("task-switch-minimal");
    fixtureRepoPath = await createSeedFixtureRepo("task-switch-minimal");
    await writeFile(join(fixtureRepoPath, CURRENT_FILE), CURRENT_FILE_CONTENT, "utf8");
    await writeFile(join(fixtureRepoPath, CURRENT_DIFF_FILE), "current selection diff\n", "utf8");
    await client.createSession();
    await resetDatabase(client);
    const startupRepoId = await importTestRepoDirect(client, startupRepoPath, STARTUP_REPO_NAME);
    await createAndSelectTask(client, startupRepoId, STARTUP_TASK_ID);
    await client.waitForText(".repo-header", STARTUP_REPO_NAME, 10_000);
    await client.reload();
    startupSelection = await visibleSelection(client);
    const currentRepoId = await importTestRepoDirect(client, fixtureRepoPath, REPO_NAME);
    await createAndSelectTask(client, currentRepoId, CURRENT_TASK_ID);
    await client.waitForText(".repo-header", REPO_NAME, 10_000);
    selectedAtDrag = await visibleSelection(client);
    expect(selectedAtDrag.repoName).toBe(REPO_NAME);
    expect(selectedAtDrag.repoId).not.toBe(startupSelection.repoId);
    expect(selectedAtDrag.taskId).not.toBe(startupSelection.taskId);
    expect(selectedAtDrag.taskId).not.toBeNull();
    [sourceHandle] = await client.getWindowHandles();
  });

  afterEach(async () => {
    const handles = await client.getWindowHandles();
    for (const handle of handles) {
      if (handle === sourceHandle) continue;
      await client.switchToWindow(handle);
      await client.executeSync<boolean>(
        `void window.__KANNA_E2E__.setupState.windowWorkspace.closeWindow()
           .catch((error) => console.error("[modal-tear-off.e2e] cleanup close failed", error));
         return true;`,
      );
    }
    await waitForWindowCount(client, 1);
    await client.switchToWindow(sourceHandle);
    await client.waitForAppReady();
  });

  afterAll(async () => {
    try {
      const handles = await client.getWindowHandles();
      for (const handle of handles) {
        if (handle === sourceHandle) continue;
        await client.switchToWindow(handle);
        await client.pressShortcut(["Meta", "w"]);
      }
      if (sourceHandle) await client.switchToWindow(sourceHandle);
    } catch (error) {
      // The WebDriver session cleanup below also closes surviving windows.
      console.warn("[modal-tear-off.e2e] explicit tear-off cleanup failed:", error);
    }
    if (fixtureRepoPath) await cleanupWorktrees(client, fixtureRepoPath);
    if (startupRepoPath) await cleanupWorktrees(client, startupRepoPath);
    await cleanupFixtureRepos([startupRepoPath, fixtureRepoPath].filter(Boolean));
    await client.deleteSession();
  });

  it("starts a normal window with a maximized file explorer at the drag threshold", async () => {
    await client.pressShortcut(["Meta", "Shift", "e"]);
    const modal = await client.waitForElement(".tree-modal", 5_000);
    const header = await client.waitForElement(".breadcrumb-bar", 5_000);
    const modalRect = await client.getElementRect(modal);
    const sourceScreen = await client.executeSync<{
      x: number;
      y: number;
      scale: number;
    }>("return { x: window.screenX, y: window.screenY, scale: window.devicePixelRatio };");

    await client.pointerDragBy(header, { x: 4, y: 3 });
    expect(await client.getWindowHandles()).toHaveLength(1);
    await client.waitForElement(".tree-modal", 2_000);

    await client.pointerDragBy(header, { x: 90, y: 55 });
    const handles = await waitForWindowCount(client, 2);
    const tearOffHandle = handles.find((handle) => handle !== sourceHandle);
    expect(tearOffHandle).toBeTruthy();

    await client.switchToWindow(tearOffHandle ?? "");
    await client.waitForAppReady();
    await dismissStartupShortcuts(client);
    await client.waitForElement(".app", 5_000);
    await client.waitForElement(".modal-overlay.embedded .tree-modal", 5_000);
    await client.waitForText(".tree-modal", "README.md", 5_000);
    await client.waitForText(".tree-modal", CURRENT_FILE, 5_000);
    expect(await visibleSelection(client)).toEqual(selectedAtDrag);
    await assertFullWindowModal(client, ".tree-modal", modalRect);

    // The file the tree opens becomes a tab in the task's main area, and the
    // tree stays where it is — a modal above the tabs — so the next file can
    // be opened without reopening it.
    await clickTreeFile(client, CURRENT_FILE);
    await client.waitForText(".preview-modal .file-path", CURRENT_FILE, 5_000);
    await client.waitForText(".preview-modal", CURRENT_FILE_CONTENT.trim(), 5_000);
    await client.waitForElement(".tree-modal", 5_000);

    await client.switchToWindow(sourceHandle);
    await client.waitForNoElement(".tree-modal", 5_000);
    await client.waitForElement(".main-panel", 2_000);
    expect(await persistedTearOffCount(client)).toBe(1);
    expect(await persistedTearOffGeometry(client)).toMatchObject({
      x: Math.round((sourceScreen.x + modalRect.x + 90) * sourceScreen.scale),
      y: Math.round((sourceScreen.y + modalRect.y + 55) * sourceScreen.scale),
    });

    await client.switchToWindow(tearOffHandle ?? "");
    // The file it opened is the tab in front now, so bring the tree back
    // before measuring it.
    await client.executeSync(
      `document.querySelector('[data-testid="main-tab-tree"]')?.click(); return true;`,
    );
    await sleep(200);
    await assertResizeReflow(client, ".tree-modal");
    await client.executeSync(`window.__KannaTearOffAppIdentity = "tree-window";`);
    await client.executeSync(
      `document.querySelector(".tree-modal")?.focus();`,
    );
    await client.pressShortcut(["Escape"]);
    await client.waitForNoElement(".tree-modal", 10_000);
    await client.waitForElement(".main-panel", 10_000);
    expect(await client.executeSync<string>(
      `return window.__KannaTearOffAppIdentity ?? "reloaded";`,
    )).toBe("tree-window");
    expect(await client.getWindowHandles()).toHaveLength(2);
    await waitForPersistedTearOffCount(client, 0);
    await closeSecondaryWindow(client, sourceHandle);
  });

  it("starts a normal window with a maximized diff during the drag", async () => {
    await client.pressShortcut(["Meta", "d"]);
    const modal = await client.waitForElement(".diff-modal", 5_000);
    const toolbar = await client.waitForElement(".diff-toolbar", 5_000);
    const modalRect = await client.getElementRect(modal);
    const sourceScreen = await client.executeSync<{
      x: number;
      y: number;
      scale: number;
    }>("return { x: window.screenX, y: window.screenY, scale: window.devicePixelRatio };");
    await client.waitForText(".diff-view", CURRENT_DIFF_FILE, 10_000);

    await client.pointerDragBy(toolbar, { x: 100, y: 50 }, { x: 0.95, y: 0.5 });
    const handles = await waitForWindowCount(client, 2);
    const tearOffHandle = handles.find((handle) => handle !== sourceHandle);
    expect(tearOffHandle).toBeTruthy();

    await client.switchToWindow(tearOffHandle ?? "");
    await client.waitForAppReady();
    await dismissStartupShortcuts(client);
    await client.waitForElement(".app", 5_000);
    await client.waitForElement(".modal-overlay.embedded .diff-modal", 5_000);
    await client.waitForText(".diff-view", CURRENT_DIFF_FILE, 10_000);
    expect(await visibleSelection(client)).toEqual(selectedAtDrag);
    await assertFullWindowModal(client, ".diff-modal", modalRect);

    await client.switchToWindow(sourceHandle);
    await client.waitForNoElement(".diff-modal", 5_000);
    await client.waitForElement(".main-panel", 2_000);
    expect(await persistedTearOffCount(client)).toBe(1);
    expect(await persistedTearOffGeometry(client)).toMatchObject({
      x: Math.round((sourceScreen.x + modalRect.x + 100) * sourceScreen.scale),
      y: Math.round((sourceScreen.y + modalRect.y + 50) * sourceScreen.scale),
    });
    await client.switchToWindow(tearOffHandle ?? "");
    await assertResizeReflow(client, ".diff-modal");
    await client.executeSync(`window.__KannaTearOffAppIdentity = "diff-window";`);
    await client.pressShortcut(["q"]);
    await client.waitForNoElement(".diff-modal", 10_000);
    await client.waitForElement(".main-panel", 10_000);
    expect(await client.executeSync<string>(
      `return window.__KannaTearOffAppIdentity ?? "reloaded";`,
    )).toBe("diff-window");
    expect(await client.getWindowHandles()).toHaveLength(2);
    await waitForPersistedTearOffCount(client, 0);
    await closeSecondaryWindow(client, sourceHandle);
  });
});
