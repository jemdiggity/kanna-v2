import { setTimeout as sleep } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { execDb, queryDb } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";

interface CapturedMouseEvent {
  type: string;
  defaultPrevented: boolean;
}

interface HeaderPortLayoutSnapshot {
  metaClientWidth: number;
  metaScrollWidth: number;
  metaRect: { left: number; right: number; width: number };
  portRects: Array<{ text: string; left: number; right: number; top: number; width: number }>;
  portRows: number[];
}

const TASK_BRANCH = "task-header-port-wrapping-branch";

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

async function constrainHeaderWidth(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `let style = document.getElementById("kanna-e2e-task-header-port-layout");
     if (!style) {
       style = document.createElement("style");
       style.id = "kanna-e2e-task-header-port-layout";
       document.head.appendChild(style);
     }
     style.textContent = [
       ".main-column { flex: 0 0 360px !important; width: 360px !important; max-width: 360px !important; }",
       ".task-header { width: 360px !important; max-width: 360px !important; }"
     ].join("\\n");`,
  );
}

async function removeHeaderWidthConstraint(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `document.getElementById("kanna-e2e-task-header-port-layout")?.remove();`,
  ).catch(() => undefined);
}

async function getHeaderPortLayout(client: WebDriverClient): Promise<HeaderPortLayoutSnapshot> {
  const result = await client.executeSync<HeaderPortLayoutSnapshot | { __error: string }>(
    `const meta = document.querySelector(".task-header .header-meta");
     if (!meta) return { __error: "header metadata not found" };
     const ports = Array.from(document.querySelectorAll(".task-header .meta-item.port"));
     if (ports.length < 2) return { __error: "expected multiple port badges, found " + ports.length };
     const metaRect = meta.getBoundingClientRect();
     const portRects = ports.map((port) => {
       const rect = port.getBoundingClientRect();
       return {
         text: port.textContent.trim(),
         left: Math.round(rect.left),
         right: Math.round(rect.right),
         top: Math.round(rect.top),
         width: Math.round(rect.width),
       };
     });
     return {
       metaClientWidth: Math.round(meta.clientWidth),
       metaScrollWidth: Math.round(meta.scrollWidth),
       metaRect: {
         left: Math.round(metaRect.left),
         right: Math.round(metaRect.right),
         width: Math.round(metaRect.width),
       },
       portRects,
       portRows: Array.from(new Set(portRects.map((rect) => rect.top))).sort((a, b) => a - b),
     };`,
  );
  if (typeof result === "object" && result !== null && "__error" in result) {
    throw new Error(result.__error);
  }
  return result;
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
         (id, repo_id, prompt, display_name, stage, agent_type,
          activity, port_offset, port_env, branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-header-port-task",
        repoId,
        "Open the task dev server",
        "Open the task dev server",
        "in progress",
        "agent",
        "idle",
        1,
        JSON.stringify({
          KANNA_DEV_PORT: "1421",
          KANNA_MOBILE_PORT: "19000",
          KANNA_RELAY_PORT: "48120",
          API_PORT: "3001",
          STORYBOOK_PORT: "6006",
          PREVIEW_PORT: "4173",
          DOCS_PORT: "5173",
          WEBDRIVER_PORT: "4445",
          ANALYTICS_PORT: "7555",
          ADMIN_PORT: "8081",
          MOCK_PORT: "9300",
          DEBUG_PORT: "9229",
        }),
        TASK_BRANCH,
        "2026-05-31T00:00:00.000Z",
        "2026-05-31T00:00:00.000Z",
      ],
    );
    await mkdir(`${fixtureRepoRoot}/.kanna-worktrees/${TASK_BRANCH}`, { recursive: true });

    const rows = await queryDb(
      client,
      "SELECT * FROM pipeline_item WHERE id = ?",
      ["task-header-port-task"],
    ) as Array<Record<string, unknown>>;
    const task = rows[0];
    if (!task) throw new Error("failed to seed task-header-port-task");
    const hydrateResult = await client.executeSync<string>(
      `const task = ${JSON.stringify(task)};
       const ctx = window.__KANNA_E2E__.setupState;
       const items = ctx.store?.items?.value ?? ctx.store?.items;
       if (!Array.isArray(items)) return "items-unavailable";
       const index = items.findIndex((candidate) => candidate.id === task.id);
       if (index >= 0) items.splice(index, 1, task);
       else items.unshift(task);
       const lastSelected = ctx.store?.lastSelectedItemByRepo?.value ?? ctx.store?.lastSelectedItemByRepo ?? {};
       const nextLastSelected = { ...lastSelected, [${JSON.stringify(repoId)}]: task.id };
       if (typeof ctx.store?.$patch === "function") {
         ctx.store.$patch({
           selectedRepoId: ${JSON.stringify(repoId)},
           selectedItemId: task.id,
           lastSelectedItemByRepo: nextLastSelected,
         });
       } else {
         ctx.store.selectedRepoId = ${JSON.stringify(repoId)};
         ctx.store.selectedItemId = task.id;
         ctx.store.lastSelectedItemByRepo = nextLastSelected;
       }
       return "ok";`,
    );
    if (hydrateResult !== "ok") throw new Error(`failed to hydrate task header fixture: ${hydrateResult}`);
  });

  afterAll(async () => {
    await removeHeaderWidthConstraint(client);
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("wraps many port badges inside constrained header metadata without horizontal overflow", async () => {
    await client.waitForText(".task-header", "Open the task dev server", 5_000);
    await client.waitForText(".task-header .meta-item.port", ":1421", 5_000);
    await client.waitForText(".task-header .meta-item.port", ":48120", 5_000);
    await constrainHeaderWidth(client);
    await sleep(100);
    try {
      const layout = await getHeaderPortLayout(client);
      const diagnostic = JSON.stringify(layout);
      const rightmostPort = Math.max(...layout.portRects.map((rect) => rect.right));
      const leftmostPort = Math.min(...layout.portRects.map((rect) => rect.left));

      expect(layout.portRows.length, diagnostic).toBeGreaterThan(1);
      expect(layout.metaScrollWidth, diagnostic).toBeLessThanOrEqual(layout.metaClientWidth + 1);
      expect(rightmostPort, diagnostic).toBeLessThanOrEqual(layout.metaRect.right + 1);
      expect(leftmostPort, diagnostic).toBeGreaterThanOrEqual(layout.metaRect.left - 1);
    } finally {
      await removeHeaderWidthConstraint(client);
    }
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
