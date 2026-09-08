import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { dragSortableTaskToTarget } from "../helpers/sidebarDrag";
import { callVueMethod, execDb, queryDb } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

interface TaskParentingRow {
  id: string;
  pinned: number;
  pin_order: number | null;
  parent_task_id: string | null;
}

interface TaskDomRow {
  id: string;
  text: string;
  isSubtask: boolean;
  inPinnedZone: boolean;
}

const PINNED_TASK_ID = "sidebar-parenting-pinned";
const TARGET_TASK_ID = "sidebar-parenting-target";
const PARENT_TASK_ID = "sidebar-parenting-parent";
const CHILD_TASK_ID = "sidebar-parenting-child";
const ALL_PINNED_FIRST_TASK_ID = "sidebar-all-pinned-first";
const ALL_PINNED_SECOND_TASK_ID = "sidebar-all-pinned-second";

async function taskRow(client: WebDriverClient, taskId: string): Promise<TaskParentingRow> {
  const rows = await queryDb(
    client,
    "SELECT id, pinned, pin_order, parent_task_id FROM pipeline_item WHERE id = ?",
    [taskId],
  ) as TaskParentingRow[];
  const row = rows[0];
  if (!row) throw new Error(`Task row not found: ${taskId}`);
  return row;
}

async function waitForTaskRow(
  client: WebDriverClient,
  taskId: string,
  predicate: (row: TaskParentingRow) => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<TaskParentingRow> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: TaskParentingRow | null = null;

  while (Date.now() < deadline) {
    lastRow = await taskRow(client, taskId);
    if (predicate(lastRow)) return lastRow;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${description}; last row was ${JSON.stringify(lastRow)}`);
}

async function sidebarRows(client: WebDriverClient): Promise<TaskDomRow[]> {
  return client.executeSync<TaskDomRow[]>(
    `return Array.from(document.querySelectorAll(".sidebar .workflow-item")).map((row) => ({
       id: row.getAttribute("data-task-id") || "",
       text: row.querySelector(".item-title")?.textContent?.trim() || "",
       isSubtask: row.classList.contains("subtask"),
       inPinnedZone: Boolean(row.closest(".pinned-zone")),
     }));`,
  );
}

async function waitForSidebarRow(
  client: WebDriverClient,
  taskId: string,
  predicate: (row: TaskDomRow) => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<TaskDomRow> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: TaskDomRow | null = null;

  while (Date.now() < deadline) {
    lastRow = (await sidebarRows(client)).find((row) => row.id === taskId) ?? null;
    if (lastRow && predicate(lastRow)) return lastRow;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${description}; last row was ${JSON.stringify(lastRow)}`);
}

describe("sidebar task parenting", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let allPinnedRepoPath = "";
  let allPinnedRepoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    testRepoPath = await createFixtureRepo("sidebar-task-parenting-test");
    const repoId = await importTestRepo(client, testRepoPath, "sidebar-task-parenting-test");

    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, agent_type, activity, pinned, pin_order, parent_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        PINNED_TASK_ID,
        repoId,
        "Drag this pinned task into the unpinned area",
        "Pinned drag source",
        "in progress",
        "agent",
        "idle",
        1,
        0,
        null,
        "2026-05-01T00:00:03.000Z",
        "2026-05-01T00:00:03.000Z",
      ],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, agent_type, activity, pinned, pin_order, parent_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        TARGET_TASK_ID,
        repoId,
        "Drop over this unpinned task",
        "Unpinned drop target",
        "in progress",
        "agent",
        "idle",
        0,
        null,
        null,
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:02.000Z",
      ],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, agent_type, activity, pinned, pin_order, parent_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        PARENT_TASK_ID,
        repoId,
        "Existing parent task",
        "Existing parent",
        "review",
        "agent",
        "idle",
        0,
        null,
        null,
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:01.000Z",
      ],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, agent_type, activity, pinned, pin_order, parent_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        CHILD_TASK_ID,
        repoId,
        "Existing child task",
        "Existing child",
        "pr",
        "agent",
        "idle",
        0,
        null,
        PARENT_TASK_ID,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
      ],
    );

    allPinnedRepoPath = await createFixtureRepo("sidebar-all-pinned-test");
    allPinnedRepoId = await importTestRepo(client, allPinnedRepoPath, "sidebar-all-pinned-test");
    // The fixture repo ships `.kanna`, so the import launches no setup task —
    // this repo's rows are exactly the ones seeded below.
    await execDb(client, "DELETE FROM pipeline_item WHERE repo_id = ?", [allPinnedRepoId]);
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, agent_type, activity, pinned, pin_order, parent_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ALL_PINNED_FIRST_TASK_ID,
        allPinnedRepoId,
        "First task in an all-pinned repository",
        "First all-pinned task",
        "in progress",
        "agent",
        "idle",
        1,
        0,
        null,
        "2026-05-02T00:00:01.000Z",
        "2026-05-02T00:00:01.000Z",
      ],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, agent_type, activity, pinned, pin_order, parent_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ALL_PINNED_SECOND_TASK_ID,
        allPinnedRepoId,
        "Second task in an all-pinned repository",
        "Second all-pinned task",
        "in progress",
        "agent",
        "idle",
        1,
        1,
        null,
        "2026-05-02T00:00:00.000Z",
        "2026-05-02T00:00:00.000Z",
      ],
    );

    await callVueMethod(client, "loadItems");
    await client.waitForText(".sidebar", "Pinned drag source", 5_000);
    await client.waitForText(".sidebar", "Unpinned drop target", 5_000);
    await client.waitForText(".sidebar", "Existing child", 5_000);
    await client.waitForText(".sidebar", "First all-pinned task", 5_000);
    await client.waitForText(".sidebar", "Second all-pinned task", 5_000);
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    if (allPinnedRepoPath) await cleanupWorktrees(client, allPinnedRepoPath);
    await cleanupFixtureRepos([testRepoPath, allPinnedRepoPath].filter(Boolean));
    await client.deleteSession();
  });

  it("unpins a pinned task dropped over an unpinned task without assigning a parent", async () => {
    const sourceSelector = `.sidebar .pinned-zone .task-subtree[data-task-id="${PINNED_TASK_ID}"]`;
    const targetSelector = `.sidebar .type-zone .workflow-item[data-task-id="${TARGET_TASK_ID}"]`;
    await client.waitForElement(sourceSelector, 5_000);
    await client.waitForElement(targetSelector, 5_000);

    await dragSortableTaskToTarget(client, sourceSelector, targetSelector);

    const row = await waitForTaskRow(
      client,
      PINNED_TASK_ID,
      (current) => current.pinned === 0 && current.pin_order == null && current.parent_task_id == null,
      "dragged task to be unpinned without a parent",
    );
    expect(row).toMatchObject({
      pinned: 0,
      pin_order: null,
      parent_task_id: null,
    });

    const domRow = await waitForSidebarRow(
      client,
      PINNED_TASK_ID,
      (current) => !current.inPinnedZone && !current.isSubtask,
      "dragged task to render as a top-level unpinned task",
    );
    expect(domRow.text).toBe("Pinned drag source");
  });

  it("unpins into the empty receiver when a repository has multiple pinned tasks and no unpinned tasks", async () => {
    const repoSelector = `.sidebar .repo-section[data-repo-id="${allPinnedRepoId}"]`;
    const sourceSelector = `${repoSelector} .pinned-zone .task-subtree[data-task-id="${ALL_PINNED_FIRST_TASK_ID}"]`;
    const receiverSelector = `${repoSelector} .empty-unpin-zone`;

    await client.waitForElement(sourceSelector, 5_000);
    await client.waitForElement(receiverSelector, 5_000);

    const initialDbRows = await queryDb(
      client,
      "SELECT id, pinned, pin_order, parent_task_id FROM pipeline_item WHERE repo_id = ? ORDER BY pin_order, id",
      [allPinnedRepoId],
    ) as TaskParentingRow[];
    expect(initialDbRows).toEqual([
      { id: ALL_PINNED_FIRST_TASK_ID, pinned: 1, pin_order: 0, parent_task_id: null },
      { id: ALL_PINNED_SECOND_TASK_ID, pinned: 1, pin_order: 1, parent_task_id: null },
    ]);

    const initialRows = (await sidebarRows(client))
      .filter((row) => row.id === ALL_PINNED_FIRST_TASK_ID || row.id === ALL_PINNED_SECOND_TASK_ID);
    expect(initialRows.map((row) => ({ id: row.id, inPinnedZone: row.inPinnedZone }))).toEqual([
      { id: ALL_PINNED_FIRST_TASK_ID, inPinnedZone: true },
      { id: ALL_PINNED_SECOND_TASK_ID, inPinnedZone: true },
    ]);

    await dragSortableTaskToTarget(client, sourceSelector, receiverSelector);

    const unpinnedRow = await waitForTaskRow(
      client,
      ALL_PINNED_FIRST_TASK_ID,
      (current) => current.pinned === 0 && current.pin_order == null && current.parent_task_id == null,
      "task dropped into the empty receiver to be persisted as unpinned",
    );
    expect(unpinnedRow).toMatchObject({
      pinned: 0,
      pin_order: null,
      parent_task_id: null,
    });

    const remainingPinnedRow = await waitForTaskRow(
      client,
      ALL_PINNED_SECOND_TASK_ID,
      (current) => current.pinned === 1 && current.pin_order === 0,
      "remaining pinned task order to be persisted",
    );
    expect(remainingPinnedRow).toMatchObject({
      pinned: 1,
      pin_order: 0,
      parent_task_id: null,
    });

    await waitForSidebarRow(
      client,
      ALL_PINNED_FIRST_TASK_ID,
      (current) => !current.inPinnedZone && !current.isSubtask,
      "dragged task to render in the unpinned area",
    );
    const finalRows = (await sidebarRows(client))
      .filter((row) => row.id === ALL_PINNED_FIRST_TASK_ID || row.id === ALL_PINNED_SECOND_TASK_ID);
    expect(finalRows.map((row) => ({ id: row.id, inPinnedZone: row.inPinnedZone }))).toEqual([
      { id: ALL_PINNED_SECOND_TASK_ID, inPinnedZone: true },
      { id: ALL_PINNED_FIRST_TASK_ID, inPinnedZone: false },
    ]);
  });

  it("removes an existing parent-child relationship from the sidebar", async () => {
    const initial = await waitForSidebarRow(
      client,
      CHILD_TASK_ID,
      (current) => current.isSubtask,
      "child task to render nested before detaching",
    );
    expect(initial.text).toBe("Existing child");

    const detach = await client.waitForElement(`[data-testid="detach-subtask-${CHILD_TASK_ID}"]`, 5_000);
    await client.click(detach);

    const row = await waitForTaskRow(
      client,
      CHILD_TASK_ID,
      (current) => current.parent_task_id == null,
      "child task parent to be cleared",
    );
    expect(row.parent_task_id).toBeNull();

    const domRow = await waitForSidebarRow(
      client,
      CHILD_TASK_ID,
      (current) => !current.isSubtask,
      "detached child task to render as a top-level task",
    );
    expect(domRow.text).toBe("Existing child");
  });
});
