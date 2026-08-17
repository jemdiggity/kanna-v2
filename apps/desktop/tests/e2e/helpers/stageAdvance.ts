import { setTimeout as sleep } from "node:timers/promises";

import { buildGlobalKeydownScript } from "./keyboard";
import type { WebDriverClient } from "./webdriver";

async function waitForSelectedTask(
  client: WebDriverClient,
  expectedTaskId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSelectedTaskId: unknown = undefined;
  while (Date.now() < deadline) {
    const selectedTaskId = await client.executeSync<string | null>(
      `const ctx = window.__KANNA_E2E__?.setupState;
       const selected = ctx?.store?.selectedTaskId;
       return selected && selected.__v_isRef ? selected.value : selected ?? null;`,
    );
    lastSelectedTaskId = selectedTaskId;
    if (selectedTaskId === expectedTaskId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected task ${expectedTaskId}; saw ${JSON.stringify(lastSelectedTaskId)}`);
}

async function clickSidebarItemByTitle(
  client: WebDriverClient,
  title: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await client.executeSync<boolean>(
      `const title = ${JSON.stringify(title)};
       const titles = Array.from(document.querySelectorAll(".sidebar .item-title"));
       const match = titles.find((element) => element.textContent?.includes(title));
       const item = match?.closest(".workflow-item");
       if (!item) return false;
       item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
       return true;`,
    );
    if (clicked) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for sidebar item ${JSON.stringify(title)}`);
}

export async function advanceStageWithShortcut(
  client: WebDriverClient,
  taskTitle: string,
  expectedTaskId: string,
): Promise<void> {
  await clickSidebarItemByTitle(client, taskTitle);
  await waitForSelectedTask(client, expectedTaskId);
  await pressAdvanceStageShortcut(client);
}

export async function pressAdvanceStageShortcut(client: WebDriverClient): Promise<void> {
  await client.executeSync(buildGlobalKeydownScript({ key: "s", meta: true }));
}
