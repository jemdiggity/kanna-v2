import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepoDirect, resetDatabase } from "../helpers/reset";

const REPO_NAME = "modal-tear-off";

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

async function assertFullWindowModal(
  client: WebDriverClient,
  selector: string,
  expectedSize: { width: number; height: number },
): Promise<void> {
  const dimensions = await client.executeSync<{
    viewportWidth: number;
    viewportHeight: number;
    outerWidth: number;
    outerHeight: number;
    devicePixelRatio: number;
    modalWidth: number;
    modalHeight: number;
  }>(
    `const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
     return {
       viewportWidth: window.innerWidth,
       viewportHeight: window.innerHeight,
       outerWidth: window.outerWidth,
       outerHeight: window.outerHeight,
       devicePixelRatio: window.devicePixelRatio,
       modalWidth: rect?.width ?? 0,
       modalHeight: rect?.height ?? 0,
     };`,
  );
  const diagnostic = JSON.stringify({ dimensions, expectedSize });
  expect(Math.abs(dimensions.viewportWidth - expectedSize.width), diagnostic).toBeLessThanOrEqual(2);
  expect(Math.abs(dimensions.viewportHeight - expectedSize.height), diagnostic).toBeLessThanOrEqual(2);
  expect(Math.abs(dimensions.modalWidth - dimensions.viewportWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(dimensions.modalHeight - dimensions.viewportHeight)).toBeLessThanOrEqual(1);
}

async function assertResizeReflow(client: WebDriverClient, selector: string): Promise<void> {
  const before = await client.getWindowRect();
  await client.setWindowRect({
    width: before.width + 120,
    height: before.height + 80,
  });
  await sleep(200);
  const dimensions = await client.executeSync<{
    viewportWidth: number;
    viewportHeight: number;
    modalWidth: number;
    modalHeight: number;
  }>(
    `const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
     return {
       viewportWidth: window.innerWidth,
       viewportHeight: window.innerHeight,
       modalWidth: rect?.width ?? 0,
       modalHeight: rect?.height ?? 0,
     };`,
  );
  expect(Math.abs(dimensions.modalWidth - dimensions.viewportWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(dimensions.modalHeight - dimensions.viewportHeight)).toBeLessThanOrEqual(1);
}

async function persistedTearOffCount(client: WebDriverClient): Promise<number> {
  return await client.executeAsync<number>(
    `const cb = arguments[arguments.length - 1];
     window.__KANNA_E2E__.setupState.windowWorkspace.loadSnapshot({ authoritative: true })
       .then((snapshot) => cb(snapshot.windows.filter((entry) => entry.tearOffContext).length))
       .catch((error) => cb(-1));`,
  );
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
  let fixtureRepoPath = "";
  let sourceHandle = "";

  beforeAll(async () => {
    fixtureRepoPath = await createSeedFixtureRepo("task-switch-minimal");
    await writeFile(join(fixtureRepoPath, "tear-off-change.txt"), "untracked diff\n", "utf8");
    await client.createSession();
    await resetDatabase(client);
    await importTestRepoDirect(client, fixtureRepoPath, REPO_NAME);
    await client.waitForText(".repo-header", REPO_NAME, 10_000);
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
    await cleanupFixtureRepos(fixtureRepoPath ? [fixtureRepoPath] : []);
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
    await client.waitForElement(".modal-overlay.maximized .tree-modal", 5_000);
    await client.waitForText(".tree-modal", "README.md", 5_000);
    await assertFullWindowModal(client, ".tree-modal", modalRect);

    await client.switchToWindow(sourceHandle);
    await client.waitForNoElement(".tree-modal", 5_000);
    await client.waitForElement(".main-panel", 2_000);
    expect(await persistedTearOffCount(client)).toBe(1);
    expect(await persistedTearOffGeometry(client)).toMatchObject({
      x: Math.round((sourceScreen.x + modalRect.x + 90) * sourceScreen.scale),
      y: Math.round((sourceScreen.y + modalRect.y + 55) * sourceScreen.scale),
    });

    await client.switchToWindow(tearOffHandle ?? "");
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
    expect(await persistedTearOffCount(client)).toBe(0);
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
    await client.waitForText(".diff-view", "tear-off-change.txt", 10_000);

    await client.pointerDragBy(toolbar, { x: 100, y: 50 }, { x: 0.95, y: 0.5 });
    const handles = await waitForWindowCount(client, 2);
    const tearOffHandle = handles.find((handle) => handle !== sourceHandle);
    expect(tearOffHandle).toBeTruthy();

    await client.switchToWindow(tearOffHandle ?? "");
    await client.waitForAppReady();
    await dismissStartupShortcuts(client);
    await client.waitForElement(".app", 5_000);
    await client.waitForElement(".modal-overlay.maximized .diff-modal", 5_000);
    await client.waitForText(".diff-view", "tear-off-change.txt", 10_000);
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
    expect(await persistedTearOffCount(client)).toBe(0);
    await closeSecondaryWindow(client, sourceHandle);
  });
});
