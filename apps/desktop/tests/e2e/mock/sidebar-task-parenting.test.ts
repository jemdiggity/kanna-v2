import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
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

async function waitForRepoTask(
  client: WebDriverClient,
  repoId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await queryDb(
      client,
      "SELECT id FROM pipeline_item WHERE repo_id = ?",
      [repoId],
    ) as Array<{ id: string }>;
    if (rows.length > 0) return;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for import-created task in repo ${repoId}`);
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
    `return Array.from(document.querySelectorAll(".sidebar .pipeline-item")).map((row) => ({
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

async function dragSortableTaskToTarget(
  client: WebDriverClient,
  sourceSelector: string,
  targetSelector: string,
): Promise<void> {
  const result = await client.executeAsync<string | { __error: string }>(
    `const cb = arguments[arguments.length - 1];
     const source = document.querySelector(${JSON.stringify(sourceSelector)});
     let target = document.querySelector(${JSON.stringify(targetSelector)});
     if (!source) {
       cb({ __error: "source not found: " + ${JSON.stringify(sourceSelector)} });
       return;
     }
     if (!target) {
       cb({ __error: "target not found: " + ${JSON.stringify(targetSelector)} });
       return;
     }

     const sourceRect = source.getBoundingClientRect();
     const start = {
       x: Math.round(sourceRect.left + sourceRect.width / 2),
       y: Math.round(sourceRect.top + sourceRect.height / 2),
     };
     const activationPoint = { x: start.x, y: start.y + 18 };
     const pointerId = 33;

     function pointer(type, point, buttons) {
       const init = {
         view: window,
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
         buttons,
       };
       if (typeof PointerEvent === "function") return new PointerEvent(type, init);
       const event = new MouseEvent(type, init);
       Object.defineProperties(event, {
         pointerId: { value: pointerId },
         pointerType: { value: "mouse" },
         isPrimary: { value: true },
       });
       return event;
     }

     function mouse(type, point, buttons) {
       const event = new MouseEvent(type, {
         view: window,
         bubbles: true,
         cancelable: true,
         clientX: point.x,
         clientY: point.y,
         screenX: point.x,
         screenY: point.y,
         button: 0,
         buttons,
       });
       Object.defineProperty(event, "which", { value: buttons ? 1 : 0 });
       return event;
     }

     function dispatch(type, point, buttons, explicitTarget) {
       const element = explicitTarget || document.elementFromPoint(point.x, point.y) || document.body;
       if (type.startsWith("pointer")) {
         element.dispatchEvent(pointer(type, point, buttons));
         document.dispatchEvent(pointer(type, point, buttons));
       } else {
         element.dispatchEvent(mouse(type, point, buttons));
         document.dispatchEvent(mouse(type, point, buttons));
       }
     }

     dispatch("pointermove", start, 0, source);
     dispatch("mousemove", start, 0, source);
     dispatch("pointerdown", start, 1, source);
     dispatch("mousedown", start, 1, source);
     setTimeout(() => {
       dispatch("pointermove", activationPoint, 1);
       dispatch("mousemove", activationPoint, 1);
       setTimeout(() => {
         const targetDeadline = Date.now() + 1_000;
         const dropWhenTargetIsReady = () => {
           target = document.querySelector(${JSON.stringify(targetSelector)});
           const targetRect = target?.getBoundingClientRect();
           if (!targetRect || targetRect.width === 0 || targetRect.height === 0) {
             if (Date.now() < targetDeadline) {
               setTimeout(dropWhenTargetIsReady, 40);
               return;
             }
             dispatch("pointerup", activationPoint, 0);
             dispatch("mouseup", activationPoint, 0);
             setTimeout(() => cb({
               __error: "target has no drop area after drag activation: " + ${JSON.stringify(targetSelector)},
             }), 200);
             return;
           }
           const end = {
             x: Math.round(targetRect.left + targetRect.width / 2),
             y: Math.round(targetRect.top + targetRect.height / 2),
           };
           const points = [
             { x: Math.round((activationPoint.x + end.x) / 2), y: Math.round((activationPoint.y + end.y) / 2) },
             end,
           ];
           let index = 0;
           const tick = () => {
             if (index < points.length) {
               dispatch("pointermove", points[index], 1);
               dispatch("mousemove", points[index], 1);
               index += 1;
               setTimeout(tick, 120);
               return;
             }
             dispatch("pointerup", end, 0);
             dispatch("mouseup", end, 0);
             setTimeout(() => cb("ok"), 200);
           };
           tick();
         };
         dropWhenTargetIsReady();
       }, 180);
     }, 120);`,
  );

  if (typeof result === "object" && result !== null && "__error" in result) {
    throw new Error(result.__error);
  }
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
    await waitForRepoTask(client, allPinnedRepoId);
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
    const targetSelector = `.sidebar .type-zone .pipeline-item[data-task-id="${TARGET_TASK_ID}"]`;
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
