import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

// A cross-machine transfer used to be completely silent: neither machine
// showed that a task was leaving, arriving, or that the move had failed, and
// the imported task's terminal gave no hint that the workspace came from
// somewhere else. These assertions run against the packaged app, so they cover
// the whole path the transfer uses — server snapshot -> store -> sidebar for
// the indicator, and store -> server spawn -> daemon PTY for the import
// summary. Unit tests on either side mock the boundary between them.

interface SidebarRow {
  taskId: string;
  transferState: string | null;
  title: string;
  titleTooltip: string;
  markerClasses: string;
  markerText: string;
}

const PUSHING_TASK_ID = "transfer-visibility-pushing";
const IMPORTING_TASK_ID = "transfer-visibility-importing";
const FAILED_TASK_ID = "transfer-visibility-failed";
const COMPLETED_TASK_ID = "transfer-visibility-completed";

const client = new WebDriverClient();

/**
 * A task's transfer state is not a column on the task: the server snapshot
 * derives it by joining the newest relevant `task_transfer` row. Seeding both
 * rows is what makes this cover the real server -> store -> sidebar path.
 */
async function insertTransferTask(
  repoId: string,
  taskId: string,
  displayName: string,
  direction: "incoming" | "outgoing",
  transferStatus: string,
  createdAt: string,
): Promise<void> {
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, prompt, display_name, stage, agent_type, activity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskId,
      repoId,
      `Transfer visibility fixture for ${displayName}`,
      displayName,
      "in progress",
      "agent",
      "idle",
      createdAt,
      createdAt,
    ],
  );
  await execDb(
    client,
    `INSERT INTO task_transfer
       (id, direction, status, source_peer_id, target_peer_id, source_task_id,
        local_task_id, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${taskId}-transfer`,
      direction,
      transferStatus,
      direction === "incoming" ? "peer-primary" : "peer-local",
      direction === "incoming" ? "peer-local" : "peer-secondary",
      `source-${taskId}`,
      taskId,
      createdAt,
    ],
  );
}

async function sidebarRows(): Promise<SidebarRow[]> {
  return client.executeSync<SidebarRow[]>(
    `return Array.from(document.querySelectorAll(".sidebar .workflow-item")).map((row) => ({
       taskId: row.getAttribute("data-task-id") || "",
       transferState: row.getAttribute("data-transfer-state"),
       title: row.querySelector(".item-title")?.textContent?.trim() || "",
       titleTooltip: row.querySelector(".item-title")?.getAttribute("title") || "",
       markerClasses: row.querySelector(".transfer-task-marker")?.className || "",
       markerText: row.querySelector(".transfer-task-marker")?.textContent?.trim() || "",
     }));`,
  );
}

async function waitForSidebarRow(
  taskId: string,
  predicate: (row: SidebarRow) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<SidebarRow> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: SidebarRow | null = null;

  while (Date.now() < deadline) {
    lastRow = (await sidebarRows()).find((row) => row.taskId === taskId) ?? null;
    if (lastRow && predicate(lastRow)) return lastRow;
    await sleep(150);
  }

  throw new Error(`timed out waiting for ${description}; last row was ${JSON.stringify(lastRow)}`);
}

async function createTransferredTask(
  repoId: string,
  repoPath: string,
  prompt: string,
): Promise<string> {
  // Mirrors what approveIncomingTransfer passes on the receiving machine: the
  // import summary rides the same createItem options as the resumed session.
  // The hanging setup command holds the PTY open past the banner so the
  // buffer can be read; the agent itself never has to start.
  const taskId = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(
       ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(repoPath)}, ${JSON.stringify(prompt)}, "pty", {
         selectOnCreate: false,
         agentProvider: "claude",
         transferImport: {
           sourceMachine: "Primary",
           repoMode: "bundle-repo",
           sessionRestored: true,
         },
         customTask: {
           executionMode: "pty",
           agentProvider: "claude",
           setup: ["printf 'TRANSFER_IMPORT_SETUP_READY\\\\n'; while true; do sleep 60; done"],
         },
       })
     ).then((id) => cb(id)).catch((error) => cb("__error:" + (error?.message || String(error))));`,
  );
  if (!/^[0-9a-f]{8}$/.test(taskId)) {
    throw new Error(`transferred task creation failed: ${taskId}`);
  }
  return taskId;
}

async function selectTask(taskId: string): Promise<void> {
  const result = await callVueMethod(client, "store.selectItem", taskId);
  if (result && typeof result === "object" && "__error" in result) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
}

async function waitForTerminalLines(
  sessionId: string,
  requiredText: string,
  timeoutMs = 45_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let latest: string[] = [];
  while (Date.now() < deadline) {
    latest = await client.executeSync<string[]>(
      `const hook = window.__KANNA_E2E__?.terminalBuffers;
       try { return hook?.lines?.(${JSON.stringify(sessionId)}) ?? []; } catch { return []; }`,
    );
    if (latest.some((line) => line.includes(requiredText))) return latest;
    await sleep(200);
  }
  throw new Error(
    `timed out waiting for ${sessionId} terminal to contain ${requiredText}; latest=${JSON.stringify(latest.slice(-20))}`,
  );
}

describe("cross-machine transfer visibility", () => {
  let testRepoPath = "";
  let repoId = "";
  const spawnedTaskIds: string[] = [];

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    testRepoPath = await createFixtureRepo("transfer-visibility-test");
    repoId = await importTestRepo(client, testRepoPath, "transfer-visibility-test");
  });

  afterAll(async () => {
    await Promise.all(
      spawnedTaskIds.map((sessionId) =>
        tauriInvoke(client, "kill_session", { sessionId }).catch(() => null),
      ),
    );
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("marks in-flight transfers in both directions and shows a failed transfer distinctly", async () => {
    await insertTransferTask(
      repoId,
      PUSHING_TASK_ID,
      "Leaving this machine",
      "outgoing",
      "streaming",
      "2026-08-06T00:00:04.000Z",
    );
    await insertTransferTask(
      repoId,
      IMPORTING_TASK_ID,
      "Arriving on this machine",
      "incoming",
      "importing",
      "2026-08-06T00:00:03.000Z",
    );
    await insertTransferTask(
      repoId,
      FAILED_TASK_ID,
      "Transfer that broke",
      "outgoing",
      "failed",
      "2026-08-06T00:00:02.000Z",
    );
    await insertTransferTask(
      repoId,
      COMPLETED_TASK_ID,
      "Transfer that landed",
      "incoming",
      "completed",
      "2026-08-06T00:00:01.000Z",
    );
    await callVueMethod(client, "store.reloadSnapshot");

    const pushing = await waitForSidebarRow(
      PUSHING_TASK_ID,
      (row) => row.transferState === "transferring",
      "the outgoing task to show the transferring indicator",
    );
    expect(pushing.markerClasses).toContain("transfer-task-marker-transferring");
    expect(pushing.titleTooltip).toContain("Leaving this machine");

    const importing = await waitForSidebarRow(
      IMPORTING_TASK_ID,
      (row) => row.transferState === "transferring",
      "the incoming task to show the transferring indicator",
    );
    expect(importing.markerClasses).toContain("transfer-task-marker-transferring");

    const failed = await waitForSidebarRow(
      FAILED_TASK_ID,
      (row) => row.transferState === "failed",
      "the failed transfer to show the failed indicator",
    );
    expect(failed.markerClasses).toContain("transfer-task-marker-failed");
    expect(failed.titleTooltip).not.toBe("Transfer that broke");
    // The failed state must not be told apart by colour alone.
    expect(failed.markerText).not.toBe(pushing.markerText);

    const completed = await waitForSidebarRow(
      COMPLETED_TASK_ID,
      (row) => row.transferState === null,
      "the completed transfer to carry no indicator",
    );
    expect(completed.markerClasses).toBe("");
  });

  it("prints the import summary into the destination terminal before the agent starts", async () => {
    const taskId = await createTransferredTask(
      repoId,
      testRepoPath,
      "Continue the transferred work",
    );
    spawnedTaskIds.push(taskId);

    await selectTask(taskId);
    await client.waitForElement(".main-panel .terminal-container", 15_000);
    const lines = await waitForTerminalLines(taskId, "TRANSFER_IMPORT_SETUP_READY");
    // xterm reflows a long banner line into two buffer rows, so the rows are
    // rejoined without a separator before matching.
    const text = lines.join("");

    expect(text).toContain("Imported transferred task");
    expect(text).toContain("source machine: Primary");
    expect(text).toContain("repository: restored from a transferred git bundle");
    expect(text).toContain("session history: restored");
    // The import notice explains the workspace the setup commands run in, so
    // it has to land before them.
    expect(text.indexOf("Imported transferred task")).toBeLessThan(
      text.indexOf("TRANSFER_IMPORT_SETUP_READY"),
    );
  });
});
