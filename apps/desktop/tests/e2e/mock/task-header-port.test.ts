import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { callVueMethod, execDb } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";

interface CapturedMouseEvent {
  type: string;
  defaultPrevented: boolean;
}

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function installMousedownCapture(client: WebDriverClient): Promise<void> {
  const result = await client.executeSync<string>(
    `const port = document.querySelector(".task-header .meta-item.port");
     if (!port) return "missing-port";
     window.__KANNA_E2E_MOUSE_EVENTS__ = [];
     port.addEventListener("mousedown", (event) => {
       setTimeout(() => {
         window.__KANNA_E2E_MOUSE_EVENTS__.push({
           type: "mousedown",
           defaultPrevented: event.defaultPrevented,
         });
       }, 0);
     });
     return "ok";`,
  );
  expect(result).toBe("ok");
}

async function waitForCapturedMousedown(client: WebDriverClient): Promise<CapturedMouseEvent> {
  const deadline = Date.now() + 5_000;
  let lastEvents: CapturedMouseEvent[] = [];

  while (Date.now() < deadline) {
    lastEvents = await client.executeSync<CapturedMouseEvent[]>(
      `return window.__KANNA_E2E_MOUSE_EVENTS__ || [];`,
    );
    const mousedown = lastEvents.find((event) => event.type === "mousedown");
    if (mousedown) return mousedown;
    await sleep(100);
  }

  throw new Error(`timed out waiting for pointer mousedown; captured ${JSON.stringify(lastEvents)}`);
}

describe("task header port badge", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("task-header-port-test");
    repoId = await importTestRepo(client, fixtureRepoRoot, "task-header-port-test");

    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, tags, agent_type,
          activity, port_offset, port_env, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-header-port-task",
        repoId,
        "Open the task dev server",
        "Open the task dev server",
        "in progress",
        '["in progress"]',
        "agent",
        "idle",
        1,
        '{"KANNA_DEV_PORT":"1421"}',
        "2026-05-31T00:00:00.000Z",
        "2026-05-31T00:00:00.000Z",
      ],
    );

    const loadResult = await callVueMethod(client, "loadItems");
    if (isVueCallError(loadResult)) throw new Error(loadResult.__error);
    const selectResult = await callVueMethod(client, "handleSelectItem", "task-header-port-task");
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);
    const refreshResult = await callVueMethod(client, "refreshAllItems");
    if (isVueCallError(refreshResult)) throw new Error(refreshResult.__error);
  });

  afterAll(async () => {
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("keeps browser-level port badge pointer interaction from being canceled by the header guard", async () => {
    await client.waitForText(".task-header", "Open the task dev server", 5_000);
    const portBadge = await client.waitForText(".task-header .meta-item.port", ":1421", 5_000);
    await installMousedownCapture(client);

    await client.pointerDoublePress(portBadge);
    const mousedown = await waitForCapturedMousedown(client);
    expect(mousedown.defaultPrevented).toBe(false);

    // The opener URL remains covered by src/components/__tests__/TaskHeader.test.ts.
    // In E2E, Tauri WebDriver currently emits mousedown/mouseup for pointer
    // actions but not click/dblclick, and window.__TAURI_INTERNALS__.invoke is
    // not replaceable for a safe plugin:opener|open_url capture. A dev-only
    // opener recorder or native WebDriver dblclick synthesis would make the
    // opener URL directly assertable here without launching the system browser.
  });
});
