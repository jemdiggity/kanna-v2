import { setTimeout as sleep } from "node:timers/promises";
import { WebDriverClient } from "./webdriver";

export async function clearTaskSwitchPerf(client: WebDriverClient): Promise<void> {
  await client.executeSync("window.__KANNA_E2E__.taskSwitchPerf.clear();");
}

export async function getLatestTaskSwitchPerf(client: WebDriverClient): Promise<unknown> {
  return await client.executeSync("return window.__KANNA_E2E__.taskSwitchPerf.getLatest();");
}

export async function getAllTaskSwitchPerf(client: WebDriverClient): Promise<unknown[]> {
  return await client.executeSync("return window.__KANNA_E2E__.taskSwitchPerf.getAll();");
}

export async function waitForCompletedTaskSwitchPerf(
  client: WebDriverClient,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await getLatestTaskSwitchPerf(client);
    if (
      latest &&
      typeof latest === "object" &&
      "completed" in latest &&
      latest.completed === true
    ) {
      return latest as Record<string, unknown>;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for completed task switch perf record after ${timeoutMs}ms`);
}

export async function waitForCompletedTaskSwitchPerfCount(
  client: WebDriverClient,
  count: number,
  timeoutMs = 5000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = await getAllTaskSwitchPerf(client);
    const completed = all.filter((latest) =>
      latest &&
      typeof latest === "object" &&
      "completed" in latest &&
      latest.completed === true,
    ) as Record<string, unknown>[];
    if (completed.length >= count) {
      return completed;
    }
    await sleep(100);
  }
  const all = await getAllTaskSwitchPerf(client);
  throw new Error(
    `timed out waiting for ${count} completed task switch perf records after ${timeoutMs}ms; records=${JSON.stringify(all)}`,
  );
}
