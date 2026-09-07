/**
 * Stage advance E2E — durable task semantics.
 *
 * Stage transitions happen on the same pipeline_item: the task keeps its id
 * while each transition FORKS a fresh workspace — a new branch/worktree
 * named from the durable task id plus workspace counter and created from
 * the previous branch's committed tip
 * (N worktrees, N branches, one PR; the PR agent renames the final branch).
 * Only committed work crosses a stage boundary; the previous worktree stays
 * on disk until cleanup. Posts and reruns keep the current workspace.
 * Advancing past the final stage closes the task (closed_at is the sole done
 * indicator — stage is never rewritten to a "done" sentinel). Revisions
 * rerun an earlier stage on the same task in a fresh fork.
 *
 * Coverage that was deleted with the old close-and-recreate model, and why:
 * - "spawns a next-stage task / baseRef checks on a created task": advancing
 *   no longer creates tasks, so there is nothing to spawn or focus-steal.
 *   The durable counterparts below assert the SAME task id advances and that
 *   selection is only adjusted when the advanced task actually closes.
 * - post-action carriage-return tests (claude/codex/copilot input capture):
 *   `post_action` compiles into a stage `post` — tail work injected into the
 *   stage's RUNNING agent session on advance (stages swap sessions; posts
 *   continue them). The exact two-write input submission (message, then a
 *   discrete Enter) and the dead-session fallback spawn are covered at the
 *   server boundary by
 *   crates/kanna-server/src/task_creator/tests/stage.rs
 *   (dispatch_post_injects_message_into_live_session_and_records_post_run,
 *   dispatch_post_falls_back_to_fresh_session_when_session_is_dead) with a
 *   fake daemon asserting the exact Input/Spawn commands. A full desktop
 *   E2E of post injection would need a deterministic live agent session to
 *   type into under the WebDriver harness; the fixtures here use post-less
 *   workflows so swaps stay deterministic.
 * - "closes the source task after a fast teardown exit during stage
 *   advance": advancing never closes the source mid-workflow anymore; the
 *   final-stage test covers the one remaining close path.
 * - "Cmd+S with a remote workspace task selected does not close a stale
 *   local fallback": covered by the keyboard-shortcuts mock suite, which
 *   injects snapshots through the App.vue setupState refs.
 */
import { join } from "node:path";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { advanceStageWithShortcut, pressAdvanceStageShortcut } from "../helpers/stageAdvance";
import { resolveAppKannaServer, type AppKannaServer } from "../helpers/kannaServer";
import { localProcessFetch } from "@kanna/local-process-fetch";

const execFileAsync = promisify(execFile);

const TWO_STAGE_WORKFLOW = "durable-two-stage-e2e";
const AUTO_WORKFLOW = "durable-auto-e2e";
const REVISION_WORKFLOW = "durable-revision-e2e";

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

interface TaskRow {
  id: string | null;
  stage: string | null;
  closed_at: string | null;
  branch: string | null;
  agent_type: string | null;
  agent_provider: string | null;
  display_name: string | null;
  prompt: string | null;
}

interface StageRunRow {
  id: string | null;
  stage: string | null;
  status: string | null;
  session_id: string | null;
  feedback: string | null;
}

async function getTaskRow(client: WebDriverClient, taskId: string): Promise<TaskRow> {
  const rows = (await queryDb(
    client,
    `SELECT id, stage, closed_at, branch, agent_type, agent_provider, display_name, prompt
     FROM pipeline_item WHERE id = ?`,
    [taskId],
  )) as TaskRow[];
  const row = rows[0];
  if (!row) throw new Error(`task ${taskId} not found`);
  return row;
}

async function waitForTaskRow(
  client: WebDriverClient,
  taskId: string,
  predicate: (row: TaskRow) => boolean,
  timeoutMs = 20_000,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskRow | null = null;
  while (Date.now() < deadline) {
    last = await getTaskRow(client, taskId);
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for task ${taskId}; last row: ${JSON.stringify(last)}`);
}

async function getStageRuns(client: WebDriverClient, taskId: string): Promise<StageRunRow[]> {
  return (await queryDb(
    client,
    "SELECT id, stage, status, session_id, feedback FROM stage_run WHERE task_id = ? ORDER BY started_at, id",
    [taskId],
  )) as StageRunRow[];
}

async function waitForStageRuns(
  client: WebDriverClient,
  taskId: string,
  predicate: (runs: StageRunRow[]) => boolean,
  timeoutMs = 20_000,
): Promise<StageRunRow[]> {
  const deadline = Date.now() + timeoutMs;
  let last: StageRunRow[] = [];
  while (Date.now() < deadline) {
    last = await getStageRuns(client, taskId);
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for stage runs for ${taskId}; last rows: ${JSON.stringify(last)}`);
}

async function countRepoTasks(client: WebDriverClient, repoId: string): Promise<number> {
  const rows = (await queryDb(
    client,
    "SELECT COUNT(*) AS task_count FROM pipeline_item WHERE repo_id = ?",
    [repoId],
  )) as Array<{ task_count: number }>;
  return rows[0]?.task_count ?? 0;
}

async function hydrateStoreItem(client: WebDriverClient, taskId: string): Promise<void> {
  const rows = (await queryDb(
    client,
    "SELECT * FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<Record<string, unknown>>;
  const item = rows[0];
  if (!item) {
    throw new Error(`seeded task ${taskId} was not found`);
  }

  const result = await client.executeSync<string>(
    `const item = ${JSON.stringify(item)};
     const ctx = window.__KANNA_E2E__.setupState;
     const items = ctx.store?.items?.value ?? ctx.store?.items;
     if (!Array.isArray(items)) return "items-unavailable";
     const index = items.findIndex((candidate) => candidate.id === item.id);
     if (index >= 0) items.splice(index, 1, item);
     else items.push(item);
     return "ok";`,
  );
  if (result !== "ok") {
    throw new Error(`failed to hydrate store item: ${result}`);
  }
}

async function waitForSelectedTaskId(
  client: WebDriverClient,
  expectedTaskId: string | null,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSelectedTaskId: unknown = undefined;
  while (Date.now() < deadline) {
    const selectedTaskId = await getVueState(client, "selectedItemId");
    lastSelectedTaskId = selectedTaskId;
    if (selectedTaskId === expectedTaskId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected task ${expectedTaskId}; saw ${JSON.stringify(lastSelectedTaskId)}`);
}

async function waitForSelectedTaskNotId(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSelectedTaskId: unknown = undefined;
  while (Date.now() < deadline) {
    const selectedTaskId = await getVueState(client, "selectedItemId");
    lastSelectedTaskId = selectedTaskId;
    if (selectedTaskId !== taskId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected task to leave ${taskId}; saw ${JSON.stringify(lastSelectedTaskId)}`);
}

async function selectTask(client: WebDriverClient, taskId: string): Promise<void> {
  const result = await callVueMethod(client, "store.selectItem", taskId);
  if (isVueCallError(result)) throw new Error(result.__error);
  await waitForSelectedTaskId(client, taskId);
}

async function waitForSidebarToExcludeTaskId(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await client.executeSync<boolean>(
      `return Boolean(document.querySelector(${JSON.stringify(`.sidebar .workflow-item[data-task-id="${taskId}"]`)}));`,
    );
    if (!visible) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for sidebar to remove task ${JSON.stringify(taskId)}`);
}

async function waitForToastContaining(
  client: WebDriverClient,
  text: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastToastText = "";
  while (Date.now() < deadline) {
    lastToastText = await client.executeSync<string>(
      `return document.querySelector(".toast-container")?.textContent || "";`,
    );
    if (lastToastText.includes(text)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for toast ${JSON.stringify(text)}; saw ${JSON.stringify(lastToastText)}`);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await stat(path).then((stats) => stats.isFile()).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function emitExternalSharedInvalidation(client: WebDriverClient, reason: string): Promise<void> {
  const result = await client.executeAsync<string | { __error: string }>(
    `const cb = arguments[arguments.length - 1];
     import("/src/emit.ts")
       .then(({ emit }) => emit("kanna://window-workspace-invalidated", {
         reason: ${JSON.stringify(reason)},
         sourceWindowId: "e2e-peer-window",
       }))
       .then(() => cb("ok"))
       .catch((error) => cb({ __error: error?.message || String(error) }));`,
  );
  if (isVueCallError(result)) {
    throw new Error(`failed to emit shared invalidation: ${result.__error}`);
  }
}

describe("stage advance", () => {
  const client = new WebDriverClient();
  let repoId = "";
  let fixtureRepoRoot = "";
  let testRepoPath = "";
  const spawnedSessionIds = new Set<string>();

  async function insertTask(options: {
    id: string;
    prompt: string;
    pipeline: string;
    stage: string;
    branch: string | null;
    agentType?: string;
    agentProvider?: string;
    displayName?: string | null;
  }): Promise<void> {
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, display_name, pipeline, stage, branch,
         agent_type, agent_provider, activity, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))`,
      [
        options.id,
        repoId,
        options.prompt,
        options.displayName ?? null,
        options.pipeline,
        options.stage,
        options.branch,
        options.agentType ?? "pty",
        options.agentProvider ?? "codex",
      ],
    );
    await hydrateStoreItem(client, options.id);
  }

  async function insertRunningStageRun(taskId: string, runId: string, stage: string): Promise<void> {
    await execDb(
      client,
      `INSERT INTO stage_run (id, task_id, stage, agent, agent_provider, model, status, session_id)
       VALUES (?, ?, ?, NULL, 'codex', NULL, 'running', ?)`,
      [runId, taskId, stage, taskId],
    );
  }

  async function addTaskWorktree(taskId: string, branch: string): Promise<void> {
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: join(testRepoPath, ".kanna-worktrees", branch),
      startPoint: "main",
    });
    spawnedSessionIds.add(taskId);
  }

  async function withAppKannaServer<T>(run: (server: AppKannaServer) => Promise<T>): Promise<T> {
    return await run(await resolveAppKannaServer(client));
  }

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("stage-advance-test");
    testRepoPath = fixtureRepoRoot;

    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "workflows"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "revision-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "fake-bin"), { recursive: true });
    await writeFile(
      join(kannaDir, "workflows", `${TWO_STAGE_WORKFLOW}.json`),
      JSON.stringify({
        name: TWO_STAGE_WORKFLOW,
        stages: [
          { name: "in progress", policy: { transition: "manual" } },
          { name: "pr", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "workflows", `${AUTO_WORKFLOW}.json`),
      JSON.stringify({
        name: AUTO_WORKFLOW,
        stages: [
          { name: "auto-source", policy: { transition: "auto" } },
          { name: "review", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "workflows", `${REVISION_WORKFLOW}.json`),
      JSON.stringify({
        name: REVISION_WORKFLOW,
        environments: {
          "fake-bin": {
            setup: ["export PATH=\"$PWD/.kanna/fake-bin:$PATH\""],
          },
        },
        stages: [
          {
            name: "in progress",
            agent: "revision-e2e",
            environment: "fake-bin",
            policy: { transition: "manual" },
          },
          { name: "review", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "revision-e2e", "AGENT.md"),
      [
        "---",
        "name: Revision E2E",
        "description: Captures request-revision prompts.",
        "agent_provider: codex",
        "---",
        "Implement revision:",
        "$TASK_PROMPT",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(kannaDir, "fake-bin", "codex"),
      [
        "#!/bin/sh",
        "mkdir -p .kanna",
        "printf '%s\\n' \"$@\" > .kanna/revision-codex-args.txt",
        "",
      ].join("\n"),
    );
    await chmod(join(kannaDir, "fake-bin", "codex"), 0o755);
    await git(testRepoPath, ["add", ".kanna"]);
    await git(testRepoPath, ["commit", "-m", "test: add kanna stage fixtures"]);

    repoId = await importTestRepo(client, testRepoPath, "stage-advance-test");
  });

  afterAll(async () => {
    for (const sessionId of spawnedSessionIds) {
      await tauriInvoke(client, "kill_session", { sessionId }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("advances the stage in place through the server API, keeping the same task", async () => {
    const taskId = "advance-in-place-task";
    const branch = "task-advance-in-place";
    await addTaskWorktree(taskId, branch);
    await insertTask({
      id: taskId,
      prompt: "Advance this task in place",
      pipeline: TWO_STAGE_WORKFLOW,
      stage: "in progress",
      branch,
      displayName: "Advance in place source",
    });

    const taskCountBefore = await countRepoTasks(client, repoId);
    await withAppKannaServer(async (server) => {
      const response = await localProcessFetch(
        `${server.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/advance-stage`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(`advance-stage failed: ${response.status} ${await response.text()}`);
      }
      expect(await response.json()).toEqual({ taskId });

      // The SAME pipeline_item transitions: same id, still open, no
      // next-stage task created — but the workspace forked: a fresh
      // randomly-named branch cut from the previous branch's committed tip.
      await waitForTaskRow(client, taskId, (candidate) => candidate.stage === "pr");
    });

    // The SAME pipeline_item transitions: same id, still open, no
    // next-stage task created — but the workspace forked: a fresh
    // counter-suffixed branch cut from the previous branch's committed tip.
    const row = await waitForTaskRow(client, taskId, (candidate) => candidate.stage === "pr");
    expect(row).toMatchObject({
      id: taskId,
      stage: "pr",
      closed_at: null,
      agent_type: "pty",
      agent_provider: "codex",
    });
    expect(row.branch).not.toBe(branch);
    expect(row.branch).toBe(`task-${taskId}-2`);
    const forkWorktree = join(testRepoPath, ".kanna-worktrees", row.branch as string);
    expect((await stat(forkWorktree)).isDirectory()).toBe(true);
    expect(await countRepoTasks(client, repoId)).toBe(taskCountBefore);

    const runs = await getStageRuns(client, taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      stage: "pr",
      status: "running",
      session_id: taskId,
    });
  });

  it("keeps the same task selected when Cmd+S advances a non-final stage", async () => {
    const taskId = "shortcut-advance-task";
    const branch = "task-shortcut-advance";
    const title = "Shortcut advance source";
    await addTaskWorktree(taskId, branch);
    await insertTask({
      id: taskId,
      prompt: "Advance via keyboard shortcut",
      pipeline: TWO_STAGE_WORKFLOW,
      stage: "in progress",
      branch,
      displayName: title,
    });

    await advanceStageWithShortcut(client, title, taskId);

    const row = await waitForTaskRow(client, taskId, (candidate) => candidate.stage === "pr");
    expect(row.closed_at).toBeNull();

    // Durable advance keeps the user's selection on the same (still-open) task.
    await sleep(500);
    expect(await getVueState(client, "selectedItemId")).toBe(taskId);
    const sidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    expect(sidebarText).toContain(title);
  });

  it("closes the task when Cmd+S advances past the final stage", async () => {
    const taskId = "final-stage-close-task";
    const branch = "task-final-stage-close";
    const title = "Final stage close source";
    await addTaskWorktree(taskId, branch);
    await insertTask({
      id: taskId,
      prompt: "Close from the final stage",
      pipeline: TWO_STAGE_WORKFLOW,
      stage: "pr",
      branch,
      displayName: title,
    });

    await advanceStageWithShortcut(client, title, taskId);

    const row = await waitForTaskRow(client, taskId, (candidate) => candidate.closed_at !== null);
    // closed_at is the sole done indicator; the stage keeps its last real value.
    expect(row.stage).toBe("pr");
    await waitForSidebarToExcludeTaskId(client, taskId);
    await waitForSelectedTaskNotId(client, taskId);
  });

  it("rejects advancing a blocked task with a toast and leaves it untouched", async () => {
    const blockerTaskId = "advance-blocker-task";
    const blockedTaskId = "advance-blocked-task";
    await insertTask({
      id: blockerTaskId,
      prompt: "Open blocker",
      pipeline: TWO_STAGE_WORKFLOW,
      stage: "in progress",
      branch: null,
      agentType: "agent",
      displayName: "Open blocker",
    });
    await insertTask({
      id: blockedTaskId,
      prompt: "Blocked task",
      pipeline: TWO_STAGE_WORKFLOW,
      stage: "in progress",
      branch: "task-advance-blocked",
      displayName: "Blocked advance source",
    });
    await execDb(
      client,
      "INSERT INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)",
      [blockedTaskId, blockerTaskId],
    );

    await selectTask(client, blockedTaskId);
    await pressAdvanceStageShortcut(client);

    await waitForToastContaining(client, "Task Blocked");
    const row = await getTaskRow(client, blockedTaskId);
    expect(row).toMatchObject({ stage: "in progress", closed_at: null });
    expect(await getStageRuns(client, blockedTaskId)).toHaveLength(0);
  });

  it("auto-advances an auto-transition stage in place on completion without stealing selection", async () => {
    const sourceTaskId = "auto-complete-source";
    const sourceBranch = "task-auto-complete-source";
    const selectedTaskId = "auto-complete-selected";
    await addTaskWorktree(sourceTaskId, sourceBranch);
    await insertTask({
      id: sourceTaskId,
      prompt: "Complete the auto stage",
      pipeline: AUTO_WORKFLOW,
      stage: "auto-source",
      branch: sourceBranch,
      displayName: "Auto complete source",
    });
    await insertTask({
      id: selectedTaskId,
      prompt: "Keep this task selected",
      pipeline: AUTO_WORKFLOW,
      stage: "auto-source",
      branch: null,
      agentType: "agent",
      displayName: "Selected task stays put",
    });
    await insertRunningStageRun(sourceTaskId, "run-auto-complete-source-seed", "auto-source");

    await selectTask(client, selectedTaskId);

    await withAppKannaServer(async (server) => {
      const response = await localProcessFetch(
        `${server.baseUrl}/v1/tasks/${encodeURIComponent(sourceTaskId)}/actions/complete-stage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: "run-auto-complete-source-seed",
            status: "success",
            summary: "ready for review",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`complete-stage failed: ${response.status} ${await response.text()}`);
      }
      expect((await response.json() as { taskId: string }).taskId).toBe(sourceTaskId);

      await waitForTaskRow(client, sourceTaskId, (candidate) => candidate.stage === "review");
    });

    const row = await getTaskRow(client, sourceTaskId);
    expect(row).toMatchObject({ id: sourceTaskId, closed_at: null });
    expect(row.branch).not.toBe(sourceBranch);
    expect(row.branch).toBe(`task-${sourceTaskId}-2`);

    const runs = await getStageRuns(client, sourceTaskId);
    const seededRun = runs.find((run) => run.id === "run-auto-complete-source-seed");
    expect(seededRun?.status).toBe("succeeded");
    const reviewRun = runs.find((run) => run.stage === "review");
    expect(reviewRun).toMatchObject({ status: "running", session_id: sourceTaskId });

    // A refresh triggered by the external transition must not move selection —
    // nothing closed, so the user's chosen task stays selected.
    await emitExternalSharedInvalidation(client, "completeStage");
    await sleep(500);
    expect(await getVueState(client, "selectedItemId")).toBe(selectedTaskId);
  });

  it("reruns the current stage on the same task", async () => {
    const taskId = "rerun-stage-task";
    const branch = "task-rerun-stage";
    const seedRunId = "run-rerun-stage-task-seed";
    await addTaskWorktree(taskId, branch);
    await insertTask({
      id: taskId,
      prompt: "Rerun this stage",
      pipeline: TWO_STAGE_WORKFLOW,
      stage: "in progress",
      branch,
      displayName: "Rerun stage source",
    });
    await insertRunningStageRun(taskId, seedRunId, "in progress");

    await withAppKannaServer(async (server) => {
      const response = await localProcessFetch(
        `${server.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/rerun-stage`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(`rerun-stage failed: ${response.status} ${await response.text()}`);
      }
      expect(await response.json()).toEqual({ taskId });

      await waitForStageRuns(client, taskId, (runs) => {
        const seededRun = runs.find((run) => run.id === seedRunId);
        return seededRun?.status === "cancelled"
          && runs.some((run) => run.id !== seedRunId && run.stage === "in progress");
      });
    });

    const row = await getTaskRow(client, taskId);
    expect(row).toMatchObject({ stage: "in progress", closed_at: null, branch });

    const runs = await waitForStageRuns(client, taskId, (candidateRuns) => {
      const seeded = candidateRuns.find((run) => run.id === seedRunId);
      const fresh = candidateRuns.find((run) => run.id !== seedRunId && run.stage === "in progress");
      return seeded?.status === "cancelled" && fresh?.status === "running";
    });
    const seededRun = runs.find((run) => run.id === seedRunId);
    expect(seededRun?.status).toBe("cancelled");
    const freshRun = runs.find((run) => run.id !== seedRunId && run.stage === "in progress");
    expect(freshRun).toMatchObject({ status: "running", session_id: taskId });
  });

  it("requests a revision that reruns an earlier stage on the same task", async () => {
    const taskId = "request-revision-task";
    const branch = "task-request-revision";
    const seedRunId = "run-request-revision-task-seed";
    const originalTitle = "Preserve reviewed task title";
    const reviewPrompt = "Original prompt that must stay on the task.";
    const revisionPrompt = "Add E2E coverage for the request-revision path.";
    await addTaskWorktree(taskId, branch);
    await insertTask({
      id: taskId,
      prompt: reviewPrompt,
      pipeline: REVISION_WORKFLOW,
      stage: "review",
      branch,
      displayName: originalTitle,
    });
    await insertRunningStageRun(taskId, seedRunId, "review");

    await withAppKannaServer(async (server) => {
      const response = await localProcessFetch(
        `${server.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/request-revision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetStage: "in progress",
            summary: "needs another pass",
            prompt: revisionPrompt,
            metadata: { source: "e2e" },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`request-revision failed: ${response.status} ${await response.text()}`);
      }
      // The revision reruns an earlier stage on the SAME durable task.
      expect((await response.json() as { taskId: string }).taskId).toBe(taskId);

      await waitForTaskRow(client, taskId, (candidate) => candidate.stage === "in progress");
    });

    const row = await getTaskRow(client, taskId);
    expect(row).toMatchObject({
      id: taskId,
      stage: "in progress",
      closed_at: null,
      display_name: originalTitle,
      prompt: reviewPrompt,
    });
    // The revision forked a fresh workspace from the reviewed branch's tip.
    expect(row.branch).not.toBe(branch);
    expect(row.branch).toBe(`task-${taskId}-2`);

    const runs = await getStageRuns(client, taskId);
    const seededRun = runs.find((run) => run.id === seedRunId);
    expect(seededRun?.status).toBe("failed");
    const revisionRun = runs.find((run) => run.stage === "in progress");
    expect(revisionRun).toMatchObject({ status: "running", feedback: revisionPrompt });

    // The revision agent runs inside the freshly forked worktree: the fake
    // `codex` (committed into the repo, so present in the fork's checkout)
    // records its argv there.
    const capturedArgsPath = join(
      testRepoPath,
      ".kanna-worktrees",
      row.branch as string,
      ".kanna",
      "revision-codex-args.txt",
    );
    await waitForFile(capturedArgsPath, 20_000);
    const capturedArgs = await readFile(capturedArgsPath, "utf8");
    expect(capturedArgs).toContain("--yolo\n");
    expect(capturedArgs).toContain("Implement revision:");
    expect(capturedArgs).toContain(`Original task:\n${reviewPrompt}`);
    expect(capturedArgs).toContain(`Reviewer feedback:\n${revisionPrompt}`);
  });
});
