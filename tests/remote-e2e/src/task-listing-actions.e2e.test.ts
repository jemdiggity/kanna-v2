import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  remoteHarnessKannaCliPath,
  startRemoteHarness,
  type RemoteHarness
} from "./harness";
import {
  collectTerminalEvents,
  createScriptedTask,
  waitForCondition,
  waitForTerminalOutput
} from "./terminalFlowTestUtils";
import { BUFFY_UID } from "./firebaseAuth";

const execFileAsync = promisify(execFile);

const LINEAR_MANUAL_WORKFLOW = JSON.stringify({
  name: "remote-linear-manual",
  stages: [
    { name: "in progress", transition: "manual", prompt: "$TASK_PROMPT" },
    { name: "review", transition: "manual", prompt: "Review $TASK_PROMPT" },
    { name: "pr", transition: "manual", prompt: "Create PR for $TASK_PROMPT" }
  ]
});

const LINEAR_AUTO_WORKFLOW = JSON.stringify({
  name: "remote-linear-auto",
  stages: [
    { name: "in progress", transition: "auto", prompt: "$TASK_PROMPT" },
    { name: "review", transition: "manual", prompt: "Review $TASK_PROMPT" }
  ]
});

const APPROVAL_POST_WORKFLOW = JSON.stringify({
  name: "remote-approval-post",
  stages: [{
    name: "pr",
    agent: "pr",
    prompt: "Create PR for $TASK_PROMPT",
    policy: { transition: "manual" },
    post: {
      name: "approve",
      agent: "approve",
      prompt: "Approve $TASK_PROMPT"
    }
  }]
});

const SINGLETON_MERGE_WORKFLOW = JSON.stringify({
  name: "singleton-merge",
  stages: [{
    name: "in progress",
    agent: "merge",
    prompt: "$TASK_PROMPT",
    policy: { transition: "manual" }
  }]
});

type SqlParam = string | number | boolean | null;
type JsonRecord = Record<string, unknown>;

interface TaskSummary {
  id: string;
  repoId: string;
  title: string;
  stage: string | null;
}

interface TaskDetail extends TaskSummary {
  branch: string | null;
  closedAt: string | null;
  worktreePath: string | null;
}

interface ActionResponse {
  taskId: string;
}

interface SqlResponse {
  rows: JsonRecord[];
  rowsAffected: number;
}

describe("remote task listing, creation, and actions E2E", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  it("lists repos and tasks from the desktop database through relay invokes", async () => {
    const alpha = await createScriptedTask(harness, {
      displayName: "Remote list alpha task"
    });
    const beta = await createScriptedTask(harness, {
      displayName: "Remote list beta task"
    });

    const repos = asRepoSummaries(await invokeDesktop(harness, "GET", "/v1/repos", null));
    expect(repos.map((repo) => repo.id)).toEqual(expect.arrayContaining([alpha.repoId, beta.repoId]));

    const alphaTasks = asTaskSummaries(await invokeDesktop(
      harness,
      "GET",
      `/v1/repos/${alpha.repoId}/tasks`,
      null
    ));
    expect(alphaTasks.map((task) => task.id)).toContain(alpha.taskId);
    expect(alphaTasks.map((task) => task.id)).not.toContain(beta.taskId);

    const recent = asTaskSummaries(await invokeDesktop(harness, "GET", "/v1/tasks/recent", null));
    expect(recent.map((task) => task.id)).toEqual(expect.arrayContaining([alpha.taskId, beta.taskId]));

    const search = asTaskSummaries(await invokeDesktop(
      harness,
      "GET",
      `/v1/tasks/search?query=${encodeURIComponent("alpha task")}`,
      null
    ));
    expect(search.map((task) => task.id)).toContain(alpha.taskId);
    expect(search.map((task) => task.id)).not.toContain(beta.taskId);

    const dbRows = await querySql(
      harness,
      "SELECT id, repo_id, display_name, closed_at FROM pipeline_item WHERE id IN (?1, ?2) ORDER BY display_name",
      [alpha.taskId, beta.taskId]
    );
    expect(dbRows).toMatchObject([
      { id: alpha.taskId, repo_id: alpha.repoId, display_name: "Remote list alpha task", closed_at: null },
      { id: beta.taskId, repo_id: beta.repoId, display_name: "Remote list beta task", closed_at: null }
    ]);
  }, 60_000);

  it("creates a task over the relay and exposes its DB, worktree, and terminal state", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Remote creation task"
    });
    const events = collectTerminalEvents(harness, task.taskId);

    try {
      await waitForTerminalOutput(events, "SCRIPT_READY");

      const detail = asTaskDetail(await invokeDesktop(harness, "GET", `/v1/tasks/${task.taskId}`, null));
      expect(detail).toMatchObject({
        id: task.taskId,
        repoId: task.repoId,
        title: "Remote creation task",
        stage: "in progress"
      });
      expect(detail.worktreePath).toBe(task.worktreePath);

      const rows = await querySql(
        harness,
        `SELECT pi.id, pi.branch, pi.agent_provider, wt.path AS worktree_path, sr.status AS run_status
           FROM pipeline_item pi
           JOIN worktree wt ON wt.pipeline_item_id = pi.id AND wt.branch = pi.branch
           JOIN stage_run sr ON sr.task_id = pi.id
          WHERE pi.id = ?1`,
        [task.taskId]
      );
      expect(rows).toMatchObject([
        {
          id: task.taskId,
          branch: `task-${task.taskId}`,
          agent_provider: "codex",
          worktree_path: task.worktreePath,
          run_status: "running"
        }
      ]);
    } finally {
      events.close();
    }
  }, 60_000);

  it("discovers closed children and parent-scoped events through a real CLI and server", async () => {
    const parent = await createScriptedTask(harness, {
      displayName: "CLI child discovery parent"
    });
    const openChildId = await createChildTask(harness, parent, "open");
    const closedChildId = await createChildTask(harness, parent, "closed");

    await invokeDesktop(harness, "POST", `/v1/tasks/${closedChildId}/actions/close`, null);

    const typedParent = asRecord(await runKannaCliJson(harness, [
      "task",
      "get",
      "--task-id",
      parent.taskId
    ]));
    expect(typedParent.childTaskIds).toHaveLength(2);
    expect(typedParent.childTaskIds).toEqual(
      expect.arrayContaining([openChildId, closedChildId])
    );

    const typedClosedChild = asRecord(await runKannaCliJson(harness, [
      "task",
      "get",
      "--task-id",
      closedChildId
    ]));
    expect(typedClosedChild.closedAt).toEqual(expect.any(String));

    const typedEvents = await runKannaCliJson(harness, [
      "task",
      "wait-events",
      "--parent-task-id",
      parent.taskId,
      "--timeout-secs",
      "0"
    ]);
    const typedEventTaskIds = eventTaskIds(typedEvents);
    expect(typedEventTaskIds).toEqual(expect.arrayContaining([openChildId, closedChildId]));
    expect(typedEventTaskIds).not.toContain(parent.taskId);
    const typedCursor = getString(asRecord(typedEvents), "cursor");
    expect(typedCursor.startsWith("p3.")).toBe(true);
    expect(typedCursor.length).toBeLessThan(128);

    await appendTaskEvent(harness, openChildId, "task.awaiting_input");
    const typedNext = await runKannaCliJson(harness, [
      "task",
      "wait-events",
      "--parent-task-id",
      parent.taskId,
      "--cursor",
      typedCursor,
      "--timeout-secs",
      "0"
    ]);
    expect(eventTaskIds(typedNext)).toEqual([openChildId]);
    expect(eventTypes(typedNext)).toEqual(["task.awaiting_input"]);
    expect(getString(asRecord(typedNext), "cursor").length).toBeLessThan(128);

    // The generic CLI call follows the same generated catalog request path as
    // kanna-mcp, so this proves the declarative casing/serialization contract
    // against the real server in addition to the typed CLI fallback above.
    const catalogParent = asRecord(await runKannaCliJson(harness, [
      "tool",
      "call",
      "kanna_get_task",
      "--json",
      JSON.stringify({ task_id: parent.taskId })
    ]));
    expect(catalogParent.childTaskIds).toHaveLength(2);
    expect(catalogParent.childTaskIds).toEqual(
      expect.arrayContaining([openChildId, closedChildId])
    );

    const catalogEvents = await runKannaCliJson(harness, [
      "tool",
      "call",
      "kanna_wait_events",
      "--json",
      JSON.stringify({ parent_task_id: parent.taskId, timeout_secs: 0 })
    ]);
    expect(eventTaskIds(catalogEvents)).toEqual(
      expect.arrayContaining([openChildId, closedChildId])
    );
    const catalogCursor = getString(asRecord(catalogEvents), "cursor");
    expect(catalogCursor.startsWith("p3.")).toBe(true);
    expect(catalogCursor.length).toBeLessThan(128);

    await appendTaskEvent(harness, openChildId, "task.revision_requested");
    const catalogNext = await runKannaCliJson(harness, [
      "tool",
      "call",
      "kanna_wait_events",
      "--json",
      JSON.stringify({
        parent_task_id: parent.taskId,
        cursor: catalogCursor,
        timeout_secs: 0
      })
    ]);
    expect(eventTaskIds(catalogNext)).toEqual([openChildId]);
    expect(eventTypes(catalogNext)).toEqual(["task.revision_requested"]);
    expect(getString(asRecord(catalogNext), "cursor").length).toBeLessThan(128);
  }, 120_000);


  it("advances stages, completes stages, requests revision, runs merge agent, and closes with current durable-task semantics", async () => {
    const advanceTask = await createScriptedTask(harness, {
      displayName: "Remote advance task"
    });
    await setWorkflowDefinition(
      harness,
      advanceTask.taskId,
      "remote-linear-manual",
      LINEAR_MANUAL_WORKFLOW,
      "manual"
    );

    const advanceResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${advanceTask.taskId}/actions/advance-stage`,
      null
    ));
    expect(advanceResponse.taskId).toBe(advanceTask.taskId);
    await waitForTaskStage(harness, advanceTask.taskId, "review");
    const advanced = await taskRow(harness, advanceTask.taskId);
    expect(advanced).toMatchObject({
      id: advanceTask.taskId,
      stage: "review",
      branch: `task-${advanceTask.taskId}-2`,
      closed_at: null
    });
    const advanceWorktrees = await querySql(
      harness,
      "SELECT branch, path FROM worktree WHERE pipeline_item_id = ?1 ORDER BY branch",
      [advanceTask.taskId]
    );
    expect(advanceWorktrees).toMatchObject([
      {
        branch: `task-${advanceTask.taskId}-2`
      }
    ]);
    expect(await git(await repoPathForTask(harness, advanceTask.taskId), [
      "show-ref",
      "--verify",
      `refs/heads/task-${advanceTask.taskId}-2`
    ])).toContain(`task-${advanceTask.taskId}-2`);

    const successTask = await createScriptedTask(harness, {
      displayName: "Remote complete success task"
    });
    const successRun = await latestRunRow(harness, successTask.taskId);
    await setWorkflowDefinition(
      harness,
      successTask.taskId,
      "remote-linear-auto",
      LINEAR_AUTO_WORKFLOW,
      "auto"
    );
    const successResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${successTask.taskId}/actions/complete-stage`,
      {
        runId: successRun.id,
        status: "success",
        summary: "implemented over relay",
        metadata: { coverage: "remote-e2e" }
      }
    ));
    expect(successResponse.taskId).toBe(successTask.taskId);
    await waitForTaskStage(harness, successTask.taskId, "review");
    expect(await latestRunRow(harness, successTask.taskId)).toMatchObject({
      stage: "review",
      kind: "main",
      status: "running"
    });

    const failureTask = await createScriptedTask(harness, {
      displayName: "Remote complete failure task"
    });
    const failureRun = await latestRunRow(harness, failureTask.taskId);
    await setWorkflowDefinition(
      harness,
      failureTask.taskId,
      "remote-linear-auto",
      LINEAR_AUTO_WORKFLOW,
      "auto"
    );
    const failureResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${failureTask.taskId}/actions/complete-stage`,
      {
        runId: failureRun.id,
        status: "failure",
        summary: "tests failed over relay",
        metadata: { failing: "remote-e2e" }
      }
    ));
    expect(failureResponse.taskId).toBe(failureTask.taskId);
    await waitForLatestRunStatus(harness, failureTask.taskId, "failed");
    expect(await taskRow(harness, failureTask.taskId)).toMatchObject({
      id: failureTask.taskId,
      stage: "in progress",
      closed_at: null
    });

    const revisionResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${advanceTask.taskId}/actions/request-revision`,
      {
        targetStage: "in progress",
        summary: "review failed over relay",
        prompt: "Address the remote action assertion gaps.",
        metadata: { reviewer: "remote-e2e" }
      }
    ));
    expect(revisionResponse.taskId).toBe(advanceTask.taskId);
    await waitForTaskStage(harness, advanceTask.taskId, "in progress");
    expect(await taskRow(harness, advanceTask.taskId)).toMatchObject({
      id: advanceTask.taskId,
      stage: "in progress",
      branch: `task-${advanceTask.taskId}-3`,
      closed_at: null
    });
    const revisionRuns = await querySql(
      harness,
      "SELECT stage, status, feedback FROM stage_run WHERE task_id = ?1 ORDER BY started_at, id",
      [advanceTask.taskId]
    );
    expect(revisionRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "review",
          status: "failed",
          feedback: "review failed over relay"
        }),
        expect.objectContaining({
          stage: "in progress",
          status: "running",
          feedback: "Address the remote action assertion gaps."
        })
      ])
    );

    const mergeResponse = asActionResponse(await invokeDesktop(
      harness,
      "POST",
      `/v1/tasks/${advanceTask.taskId}/actions/run-merge-agent`,
      null
    ));
    expect(mergeResponse.taskId).not.toBe(advanceTask.taskId);
    await waitForCondition(async () => {
      const rows = await querySql(
        harness,
        "SELECT display_name, pipeline FROM pipeline_item WHERE id = ?1",
        [mergeResponse.taskId]
      );
      return rows[0]?.display_name === "Merge Master" && rows[0]?.pipeline === "singleton-merge";
    }, 10_000, "merge agent task was not recorded");

    const closeTask = await createScriptedTask(harness, {
      displayName: "Remote close task"
    });
    const closeBefore = await taskRow(harness, closeTask.taskId);
    const closeWorktreePath = getString(closeBefore, "worktree_path");
    const closeBranch = getString(closeBefore, "branch");
    const repoPath = await repoPathForTask(harness, closeTask.taskId);
    await writeFile(`${closeWorktreePath}/dirty-close.txt`, "dirty state captured at close\n");

    await invokeDesktop(harness, "POST", `/v1/tasks/${closeTask.taskId}/actions/close`, null);
    await waitForCondition(async () => {
      const row = await taskRow(harness, closeTask.taskId);
      return typeof row.closed_at === "string";
    }, 10_000, "task did not close");
    await waitForCondition(async () => {
      const rows = await querySql(
        harness,
        "SELECT id FROM worktree WHERE pipeline_item_id = ?1",
        [closeTask.taskId]
      );
      return rows.length === 0;
    }, 10_000, "closed task worktree rows were not removed");
    await expect(stat(closeWorktreePath)).rejects.toThrow();
    expect(await git(repoPath, ["show-ref", "--verify", `refs/heads/${closeBranch}`])).toContain(closeBranch);
    expect(await git(repoPath, ["log", "-1", "--pretty=%s", closeBranch])).toContain("WIP at task close");

    const repoTasksAfterClose = asTaskSummaries(await invokeDesktop(
      harness,
      "GET",
      `/v1/repos/${closeTask.repoId}/tasks`,
      null
    ));
    expect(repoTasksAfterClose.map((task) => task.id)).not.toContain(closeTask.taskId);
  }, 120_000);
});

async function invokeDesktop(
  harness: RemoteHarness,
  method: "GET" | "POST",
  path: string,
  body: unknown
): Promise<unknown> {
  return await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method,
    path,
    body
  });
}

async function invokeLanJson(
  harness: RemoteHarness,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const response = await fetch(`${harness.lanBaseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: method === "GET" ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LAN ${method} ${path} failed (${response.status}): ${text}`);
  }
  return text.length > 0 ? JSON.parse(text) as unknown : null;
}

async function createChildTask(
  harness: RemoteHarness,
  parent: { repoId: string; taskId: string },
  label: string
): Promise<string> {
  const response = asRecord(await invokeDesktop(harness, "POST", "/v1/tasks", {
    repoId: parent.repoId,
    prompt: `Run deterministic child task ${label}`,
    displayName: `CLI child discovery ${label} child`,
    agentProvider: "codex",
    agentType: "pty",
    parentTaskId: parent.taskId
  }));
  return getString(response, "taskId");
}

async function runKannaCliJson(
  harness: RemoteHarness,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    remoteHarnessKannaCliPath(harness.repoRoot),
    [...args, "--server-url", harness.lanBaseUrl],
    {
      cwd: harness.repoRoot,
      env: { ...process.env, ...extraEnv },
      timeout: 30_000
    }
  );
  return JSON.parse(String(stdout)) as unknown;
}

function eventTaskIds(value: unknown): string[] {
  const events = asRecord(value).events;
  if (!Array.isArray(events)) {
    throw new Error(`expected task event array ${JSON.stringify(value)}`);
  }
  return events.map((event) => getString(asRecord(event), "taskId"));
}

function eventTypes(value: unknown): string[] {
  const events = asRecord(value).events;
  if (!Array.isArray(events)) {
    throw new Error(`expected task event array ${JSON.stringify(value)}`);
  }
  return events.map((event) => getString(asRecord(event), "type"));
}

async function appendTaskEvent(
  harness: RemoteHarness,
  taskId: string,
  eventType: string
): Promise<void> {
  const rowsAffected = await executeSql(
    harness,
    "INSERT INTO task_event (task_id, type, payload) VALUES (?1, ?2, '{}')",
    [taskId, eventType]
  );
  expect(rowsAffected).toBe(1);
}

async function querySql(harness: RemoteHarness, sql: string, params: SqlParam[] = []): Promise<JsonRecord[]> {
  const response = asSqlResponse(await invokeDesktop(harness, "POST", "/v1/e2e/sql", {
    query: true,
    sql,
    params
  }));
  return response.rows;
}

async function executeSql(harness: RemoteHarness, sql: string, params: SqlParam[] = []): Promise<number> {
  const response = asSqlResponse(await invokeDesktop(harness, "POST", "/v1/e2e/sql", {
    query: false,
    sql,
    params
  }));
  return response.rowsAffected;
}

async function setWorkflowDefinition(
  harness: RemoteHarness,
  taskId: string,
  workflowName: string,
  workflowDefinition: string,
  completionTransition: "manual" | "auto"
): Promise<void> {
  const taskRowsAffected = await executeSql(
    harness,
    "UPDATE pipeline_item SET pipeline = ?1, pipeline_def = ?2 WHERE id = ?3",
    [workflowName, workflowDefinition, taskId]
  );
  expect(taskRowsAffected).toBe(1);

  const runRowsAffected = await executeSql(
    harness,
    `UPDATE stage_run
        SET completion_transition = ?1
      WHERE task_id = ?2 AND kind = 'main' AND status = 'running'`,
    [completionTransition, taskId]
  );
  expect(runRowsAffected).toBe(1);
}

async function waitForTaskStage(harness: RemoteHarness, taskId: string, stage: string): Promise<void> {
  await waitForCondition(async () => {
    const row = await taskRow(harness, taskId);
    return row.stage === stage;
  }, 15_000, `task ${taskId} did not reach stage ${stage}`);
}

async function waitForLatestRunStatus(
  harness: RemoteHarness,
  taskId: string,
  status: string
): Promise<void> {
  await waitForCondition(async () => {
    const row = await latestRunRow(harness, taskId);
    return row.status === status;
  }, 10_000, `task ${taskId} latest run did not reach ${status}`);
}

async function taskRow(harness: RemoteHarness, taskId: string): Promise<JsonRecord> {
  const rows = await querySql(
    harness,
    `SELECT pi.id, pi.stage, pi.branch, pi.closed_at, wt.path AS worktree_path
       FROM pipeline_item pi
       LEFT JOIN worktree wt ON wt.pipeline_item_id = pi.id AND wt.branch = pi.branch
      WHERE pi.id = ?1`,
    [taskId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected one task row for ${taskId}, got ${rows.length}`);
  }
  return rows[0]!;
}

async function latestRunRow(harness: RemoteHarness, taskId: string): Promise<JsonRecord> {
  const rows = await querySql(
    harness,
    `SELECT id, stage, kind, status, feedback
       FROM stage_run
      WHERE task_id = ?1
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
    [taskId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected one latest run row for ${taskId}, got ${rows.length}`);
  }
  return rows[0]!;
}

async function repoPathForTask(harness: RemoteHarness, taskId: string): Promise<string> {
  const rows = await querySql(
    harness,
    `SELECT r.path
       FROM repo r
       JOIN pipeline_item pi ON pi.repo_id = r.id
      WHERE pi.id = ?1`,
    [taskId]
  );
  if (rows.length !== 1) {
    throw new Error(`expected repo path for ${taskId}`);
  }
  return getString(rows[0]!, "path");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: process.env });
  return stdout;
}

function asSqlResponse(value: unknown): SqlResponse {
  if (!isRecord(value) || !Array.isArray(value.rows) || typeof value.rowsAffected !== "number") {
    throw new Error(`unexpected SQL response ${JSON.stringify(value)}`);
  }
  return {
    rows: value.rows.map(asRecord),
    rowsAffected: value.rowsAffected
  };
}

function asRepoSummaries(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) {
    throw new Error(`expected repo summaries array ${JSON.stringify(value)}`);
  }
  return value.map((item) => {
    const record = asRecord(item);
    return {
      id: getString(record, "id"),
      name: getString(record, "name")
    };
  });
}

function asTaskSummaries(value: unknown): TaskSummary[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected task summaries array ${JSON.stringify(value)}`);
  }
  return value.map((item) => {
    const record = asRecord(item);
    return {
      id: getString(record, "id"),
      repoId: getString(record, "repoId"),
      title: getString(record, "title"),
      stage: getOptionalString(record, "stage")
    };
  });
}

function asTaskDetail(value: unknown): TaskDetail {
  const record = asRecord(value);
  return {
    id: getString(record, "id"),
    repoId: getString(record, "repoId"),
    title: getString(record, "title"),
    stage: getOptionalString(record, "stage"),
    branch: getOptionalString(record, "branch"),
    closedAt: getOptionalString(record, "closedAt"),
    worktreePath: getOptionalString(record, "worktreePath")
  };
}

function asActionResponse(value: unknown): ActionResponse {
  const record = asRecord(value);
  return { taskId: getString(record, "taskId") };
}

function asRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`expected object ${JSON.stringify(value)}`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function getString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`expected string field ${key} in ${JSON.stringify(record)}`);
  }
  return value;
}

function getOptionalString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`expected optional string field ${key} in ${JSON.stringify(record)}`);
  }
  return value;
}
