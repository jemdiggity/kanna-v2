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
 * first resume the earlier run's provider session and workspace, and fork a
 * numbered workspace only when a resume precondition fails.
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
 *   pipelines so swaps stay deterministic.
 * - "closes the source task after a fast teardown exit during stage
 *   advance": advancing never closes the source mid-pipeline anymore; the
 *   final-stage test covers the one remaining close path.
 * - "Cmd+S with a remote workspace task selected does not close a stale
 *   local fallback": covered by the keyboard-shortcuts mock suite, which
 *   injects snapshots through the App.vue setupState refs.
 */
import { join } from "node:path";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepoDirect, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { advanceStageWithShortcut, pressAdvanceStageShortcut } from "../helpers/stageAdvance";
import { resolveAppKannaServer, type AppKannaServer } from "../helpers/kannaServer";
import { buildGlobalKeydownScript } from "../helpers/keyboard";

const execFileAsync = promisify(execFile);

const TWO_STAGE_PIPELINE = "durable-two-stage-e2e";
const AUTO_PIPELINE = "durable-auto-e2e";
const REVISION_PIPELINE = "durable-revision-e2e";

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
  activity: string | null;
  display_name: string | null;
  prompt: string | null;
}

interface StageRunRow {
  id: string | null;
  stage: string | null;
  status: string | null;
  session_id: string | null;
  feedback: string | null;
  provider_session_id: string | null;
  cwd: string | null;
  resumed_from_run_id: string | null;
}

async function getTaskRow(client: WebDriverClient, taskId: string): Promise<TaskRow> {
  const rows = (await queryDb(
    client,
    `SELECT id, stage, closed_at, branch, agent_type, agent_provider, activity, display_name, prompt
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
    `SELECT id, stage, status, session_id, feedback, provider_session_id, cwd,
            resumed_from_run_id
     FROM stage_run WHERE task_id = ? ORDER BY started_at, id`,
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
     const slots = ctx.store?.taskUiSlots?.value ?? ctx.store?.taskUiSlots;
     if (!Array.isArray(items) || !Array.isArray(slots)) return "store-state-unavailable";
     const index = items.findIndex((candidate) => candidate.id === item.id);
     if (index >= 0) items.splice(index, 1, item);
     else items.push(item);
     const readySlot = {
       slot_id: item.id,
       task_id: item.id,
       state: "ready",
       task: item,
       draft: {
         repo_id: item.repo_id,
         prompt: item.prompt ?? "",
         display_name: item.display_name ?? null,
         pipeline: item.pipeline,
         stage: item.stage,
         agent_type: item.agent_type,
         agent_provider: item.agent_provider,
         created_at: item.created_at,
       },
     };
     const slotIndex = slots.findIndex((candidate) => candidate.task_id === item.id);
     if (slotIndex >= 0) slots.splice(slotIndex, 1, readySlot);
     else slots.push(readySlot);
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
  if (await getVueState(client, "selectedItemId") !== taskId) {
    const selector = `.sidebar .pipeline-item[data-task-id="${taskId}"]`;
    await client.waitForElement(selector, 5_000);
    await client.click(await client.findElement(selector));
  }
  await waitForSelectedTaskId(client, taskId);
}

async function closeDiffModalIfOpen(client: WebDriverClient): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const isOpen = await client.executeSync<boolean>(
      `return Boolean(document.querySelector(".diff-view"));`,
    );
    if (!isOpen) return;
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await sleep(100);
  }
  await client.waitForNoElement(".diff-view", 2_000);
}

async function requestChangesThroughDiffModal(
  client: WebDriverClient,
  worktreePath: string,
  summary: string,
  note: string,
): Promise<void> {
  const headCommit = await git(worktreePath, ["rev-parse", "HEAD"]);
  const seeded = await client.executeSync<string>(
    `const ctx = window.__KANNA_E2E__.setupState;
     if (typeof ctx?.appModals?.updateCurrentDiffViewState !== "function") {
       return "diff-state-unavailable";
     }
     ctx.appModals.updateCurrentDiffViewState({
       scope: "branch",
       reviewHeadCommit: ${JSON.stringify(headCommit)},
       reviewComments: [{
         id: "stage-advance-review-comment",
         filePath: "README.md",
         startLine: 1,
         endLine: 1,
         excerpt: "# fixture",
         note: ${JSON.stringify(note)},
         headCommit: ${JSON.stringify(headCommit)},
       }],
     });
     return "ok";`,
  );
  if (seeded !== "ok") {
    throw new Error(`failed to seed DiffModal review state: ${seeded}`);
  }

  await closeDiffModalIfOpen(client);
  await client.executeSync(buildGlobalKeydownScript({ key: "d", meta: true }));
  await client.waitForElement(".diff-view", 5_000);
  await client.executeSync(
    buildGlobalKeydownScript({ key: "s", meta: true, shift: true }),
  );
  await client.waitForElement(".summary-composer", 2_000);
  const textarea = await client.findElement(".summary-composer textarea");
  await client.sendKeys(textarea, summary);
  await client.click(await client.findElement(".summary-actions .primary"));
  const outcome = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const deadline = Date.now() + 10000;
     const check = () => {
       if (!document.querySelector(".summary-composer")) { cb("ok"); return; }
       if (Date.now() >= deadline) {
         const toast = document.querySelector(".toast-container")?.textContent?.trim() || "";
         cb("timeout:" + toast);
         return;
       }
       setTimeout(check, 50);
     };
     check();`,
  );
  if (outcome !== "ok") {
    throw new Error(`DiffModal request changes failed: ${outcome}`);
  }
}

async function waitForVisibleSelectedTaskState(
  client: WebDriverClient,
  taskId: string,
  stage: string,
  branch: string,
  worktreePath: string,
  expectedActivity: "working" | null = "working",
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    last = await client.executeSync(
      `const ctx = window.__KANNA_E2E__.setupState;
       const read = (value) => value?.__v_isRef ? value.value : value;
       const sidebarRow = document.querySelector(${JSON.stringify(
         `.sidebar .pipeline-item[data-task-id="${taskId}"]`,
       )});
       const title = sidebarRow?.querySelector(".item-title");
       return {
         selectedItemId: read(ctx.store?.selectedItemId),
         stage: document.querySelector(".task-header .stage-badge")?.textContent?.trim() || "",
         branch: document.querySelector(".task-header .branch")?.textContent?.trim() || "",
         activeWorktreePath: read(ctx.appModals?.activeWorktreePath),
         sidebarSelected: sidebarRow?.classList.contains("selected") || false,
         activity: ctx.store?.currentItem?.activity || null,
         fontStyle: title instanceof HTMLElement ? getComputedStyle(title).fontStyle : "",
       };`,
    );
    const state = last as {
      selectedItemId?: string;
      stage?: string;
      branch?: string;
      activeWorktreePath?: string;
      sidebarSelected?: boolean;
      activity?: string;
      fontStyle?: string;
    };
    if (
      state.selectedItemId === taskId
      && state.stage === stage
      && state.branch?.includes(branch)
      && state.activeWorktreePath === worktreePath
      && state.sidebarSelected
      && (
        expectedActivity === null
        || (state.activity === expectedActivity && state.fontStyle === "italic")
      )
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for visible selected task state: ${JSON.stringify(last)}`);
}

async function removeOwnershiplessFixtureSessions(client: WebDriverClient): Promise<void> {
  const deadline = Date.now() + 5_000;
  let quietSince = 0;
  let lastSessionIds: string[] = [];
  while (Date.now() < deadline) {
    const sessions = await tauriInvoke(client, "list_sessions") as Array<{
      session_id?: string;
      run_id?: string | null;
    }>;
    const sessionIds = sessions
      .filter((session) => !session.session_id?.startsWith("shell-") && !session.run_id)
      .flatMap((session) => session.session_id ? [session.session_id] : []);
    if (sessionIds.length === 0) {
      if (quietSince === 0) quietSince = Date.now();
      if (Date.now() - quietSince >= 500) return;
    } else {
      quietSince = 0;
      lastSessionIds = sessionIds;
      for (const sessionId of sessionIds) {
        await tauriInvoke(client, "kill_session", { sessionId });
      }
    }
    await sleep(50);
  }
  throw new Error(`ownershipless fixture sessions were not removed: ${lastSessionIds.join(", ")}`);
}

async function waitForSidebarToExcludeTaskId(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await client.executeSync<boolean>(
      `return Boolean(document.querySelector(${JSON.stringify(`.sidebar .pipeline-item[data-task-id="${taskId}"]`)}));`,
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
    testRepoPath = await realpath(fixtureRepoRoot);

    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "revision-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "fake-bin"), { recursive: true });
    await writeFile(
      join(kannaDir, "config.json"),
      JSON.stringify({
        workspace: {
          path: {
            prepend: [".kanna/fake-bin"],
          },
        },
      }),
    );
    await writeFile(
      join(kannaDir, "pipelines", `${TWO_STAGE_PIPELINE}.json`),
      JSON.stringify({
        name: TWO_STAGE_PIPELINE,
        stages: [
          { name: "in progress", policy: { transition: "manual" } },
          { name: "pr", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "pipelines", `${AUTO_PIPELINE}.json`),
      JSON.stringify({
        name: AUTO_PIPELINE,
        stages: [
          { name: "auto-source", policy: { transition: "auto" } },
          { name: "review", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "pipelines", `${REVISION_PIPELINE}.json`),
      JSON.stringify({
        name: REVISION_PIPELINE,
        stages: [
          {
            name: "in progress",
            agent: "revision-e2e",
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
        "if [ \"${1:-}\" = \"resume\" ] && [ \"${2:-}\" = \"--help\" ]; then",
        "  echo 'Usage: codex resume [OPTIONS] [SESSION_ID]'",
        "  exit 0",
        "fi",
        "mkdir -p .kanna",
        "printf '%s\\n' \"$@\" > .kanna/revision-codex-args.txt",
        "while :; do printf '.'; sleep 1; done",
        "",
      ].join("\n"),
    );
    await chmod(join(kannaDir, "fake-bin", "codex"), 0o755);
    await git(testRepoPath, ["add", ".kanna"]);
    await git(testRepoPath, ["commit", "-m", "test: add kanna stage fixtures"]);
    await git(testRepoPath, ["push", "origin", "main"]);

    repoId = await importTestRepoDirect(client, testRepoPath, "stage-advance-test");
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
      pipeline: TWO_STAGE_PIPELINE,
      stage: "in progress",
      branch,
      displayName: "Advance in place source",
    });

    const taskCountBefore = await countRepoTasks(client, repoId);
    await withAppKannaServer(async (server) => {
      const response = await fetch(
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
    });
    expect(runs[0].session_id).toBe(runs[0].id);
  });

  it("keeps the same task selected when Cmd+S advances a non-final stage", async () => {
    const taskId = "shortcut-advance-task";
    const branch = "task-shortcut-advance";
    const title = "Shortcut advance source";
    await addTaskWorktree(taskId, branch);
    await insertTask({
      id: taskId,
      prompt: "Advance via keyboard shortcut",
      pipeline: TWO_STAGE_PIPELINE,
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
      pipeline: TWO_STAGE_PIPELINE,
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

  it("does not steal selection when a delayed final-stage response finishes after a task switch", async () => {
    const taskId = "delayed-final-stage-close";
    const branch = "task-delayed-final-stage-close";
    const fallbackTaskId = "delayed-final-fallback";
    const chosenTaskId = "delayed-final-user-choice";
    await addTaskWorktree(taskId, branch);
    await insertTask({
      id: taskId,
      prompt: "Close with a delayed response",
      pipeline: TWO_STAGE_PIPELINE,
      stage: "pr",
      branch,
      displayName: "Delayed final close source",
    });
    await insertTask({
      id: fallbackTaskId,
      prompt: "Automatic close fallback",
      pipeline: TWO_STAGE_PIPELINE,
      stage: "in progress",
      branch: null,
      agentType: "agent",
      displayName: "Delayed final fallback",
    });
    await insertTask({
      id: chosenTaskId,
      prompt: "User-selected task",
      pipeline: TWO_STAGE_PIPELINE,
      stage: "in progress",
      branch: null,
      agentType: "agent",
      displayName: "Delayed final user choice",
    });
    await execDb(
      client,
      "UPDATE pipeline_item SET pinned = 1, pin_order = CASE id WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END WHERE id IN (?, ?, ?)",
      [taskId, fallbackTaskId, taskId, fallbackTaskId, chosenTaskId],
    );
    await hydrateStoreItem(client, taskId);
    await hydrateStoreItem(client, fallbackTaskId);
    await hydrateStoreItem(client, chosenTaskId);
    await selectTask(client, taskId);

    await client.executeSync(
      `window.__KANNA_DELAYED_ADVANCE_ORIGINAL_FETCH__ = window.fetch.bind(window);
       window.fetch = async function(input, init) {
         const response = await window.__KANNA_DELAYED_ADVANCE_ORIGINAL_FETCH__(input, init);
         const url = String(input instanceof Request ? input.url : input);
         if (url.includes(${JSON.stringify(`/v1/tasks/${taskId}/actions/advance-stage`)})) {
           await new Promise((resolve) => setTimeout(resolve, 1500));
         }
         return response;
       };`,
    );
    try {
      await pressAdvanceStageShortcut(client);
      await waitForTaskRow(client, taskId, (candidate) => candidate.closed_at !== null);
      await selectTask(client, chosenTaskId);
      await sleep(2_000);
      expect(await getVueState(client, "selectedItemId")).toBe(chosenTaskId);
    } finally {
      await client.executeSync(
        `if (window.__KANNA_DELAYED_ADVANCE_ORIGINAL_FETCH__) {
           window.fetch = window.__KANNA_DELAYED_ADVANCE_ORIGINAL_FETCH__;
           delete window.__KANNA_DELAYED_ADVANCE_ORIGINAL_FETCH__;
         }`,
      );
    }
  });

  it("rejects advancing a blocked task with a toast and leaves it untouched", async () => {
    const blockerTaskId = "advance-blocker-task";
    const blockedTaskId = "advance-blocked-task";
    await insertTask({
      id: blockerTaskId,
      prompt: "Open blocker",
      pipeline: TWO_STAGE_PIPELINE,
      stage: "in progress",
      branch: null,
      agentType: "agent",
      displayName: "Open blocker",
    });
    await insertTask({
      id: blockedTaskId,
      prompt: "Blocked task",
      pipeline: TWO_STAGE_PIPELINE,
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
      pipeline: AUTO_PIPELINE,
      stage: "auto-source",
      branch: sourceBranch,
      displayName: "Auto complete source",
    });
    await insertTask({
      id: selectedTaskId,
      prompt: "Keep this task selected",
      pipeline: AUTO_PIPELINE,
      stage: "auto-source",
      branch: null,
      agentType: "agent",
      displayName: "Selected task stays put",
    });
    await insertRunningStageRun(sourceTaskId, "run-auto-complete-source-seed", "auto-source");

    await selectTask(client, selectedTaskId);

    await withAppKannaServer(async (server) => {
      const response = await fetch(
        `${server.baseUrl}/v1/tasks/${encodeURIComponent(sourceTaskId)}/actions/complete-stage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "success", summary: "ready for review" }),
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
    expect(reviewRun).toMatchObject({ status: "running" });
    expect(reviewRun?.session_id).toBe(reviewRun?.id);

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
      pipeline: TWO_STAGE_PIPELINE,
      stage: "in progress",
      branch,
      displayName: "Rerun stage source",
    });
    await insertRunningStageRun(taskId, seedRunId, "in progress");

    await withAppKannaServer(async (server) => {
      const response = await fetch(
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
    expect(freshRun).toMatchObject({ status: "running" });
    expect(freshRun?.session_id).toBe(freshRun?.id);
  });

  it("requests changes through DiffModal and forks a numbered fallback workspace", async () => {
    const taskId = "request-revision-fallback-task";
    const implementationBranch = `task-${taskId}`;
    const reviewBranch = `task-${taskId}-2`;
    const expectedBranch = `task-${taskId}-3`;
    const implementationRunId = "run-request-revision-fallback-implementation";
    const reviewRunId = "run-request-revision-fallback-review";
    const originalTitle = "Preserve reviewed task title";
    const reviewPrompt = "Original prompt that must stay on the task.";
    const revisionPrompt = "Add E2E coverage for the request-revision path.";
    const implementationCwd = join(
      testRepoPath,
      ".kanna-worktrees",
      implementationBranch,
    );
    const reviewCwd = join(testRepoPath, ".kanna-worktrees", reviewBranch);

    await addTaskWorktree(taskId, implementationBranch);
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch: reviewBranch,
      path: reviewCwd,
      startPoint: "main",
    });
    await insertTask({
      id: taskId,
      prompt: reviewPrompt,
      pipeline: REVISION_PIPELINE,
      stage: "review",
      branch: reviewBranch,
      displayName: originalTitle,
    });
    await execDb(
      client,
      `INSERT INTO stage_run (
         id, task_id, stage, kind, agent, agent_provider, status, session_id,
         provider_session_id, cwd, started_at, run_ownership_version
       ) VALUES (?, ?, 'in progress', 'main', 'revision-e2e', 'codex',
                 'succeeded', ?, NULL, ?, datetime('now', '-1 minute'), 1)`,
      [implementationRunId, taskId, taskId, implementationCwd],
    );
    await execDb(
      client,
      `INSERT INTO stage_run (
         id, task_id, stage, kind, agent_provider, status, session_id,
         started_at, run_ownership_version
       ) VALUES (?, ?, 'review', 'main', 'codex', 'running', ?,
                 datetime('now'), 1)`,
      [reviewRunId, taskId, taskId],
    );

    await selectTask(client, taskId);
    await requestChangesThroughDiffModal(
      client,
      reviewCwd,
      "needs another pass",
      revisionPrompt,
    );
    await waitForTaskRow(
      client,
      taskId,
      (candidate) =>
        candidate.stage === "in progress"
        && candidate.branch === expectedBranch,
    );

    const row = await getTaskRow(client, taskId);
    expect(row).toMatchObject({
      id: taskId,
      stage: "in progress",
      closed_at: null,
      branch: expectedBranch,
      display_name: originalTitle,
      prompt: reviewPrompt,
    });
    expect(["idle", "working"]).toContain(row.activity);
    const expectedCwd = join(testRepoPath, ".kanna-worktrees", expectedBranch);
    await waitForVisibleSelectedTaskState(
      client,
      taskId,
      "in progress",
      expectedBranch,
      expectedCwd,
      null,
    );

    const runs = await getStageRuns(client, taskId);
    expect(runs.find((run) => run.id === reviewRunId)?.status).toBe("failed");
    const revisionRun = runs.find(
      (run) => run.stage === "in progress" && run.id !== implementationRunId,
    );
    expect(revisionRun).toMatchObject({
      status: "running",
      cwd: expectedCwd,
      feedback: expect.stringContaining(revisionPrompt),
    });
    expect(revisionRun?.resumed_from_run_id).toBeNull();

    const capturedArgsPath = join(
      expectedCwd,
      ".kanna",
      "revision-codex-args.txt",
    );
    await waitForFile(capturedArgsPath, 20_000);
    const capturedArgs = await readFile(capturedArgsPath, "utf8");
    expect(capturedArgs).toContain("--yolo\n");
    expect(capturedArgs).toContain("Implement revision:");
    expect(capturedArgs).toContain(`Original task:\n${reviewPrompt}`);
    expect(capturedArgs).toContain("Reviewer feedback:\nRevision requested from review");
    expect(capturedArgs).toContain(revisionPrompt);
    await closeDiffModalIfOpen(client);
  });

  it("requests changes through DiffModal and resumes the original workspace", async () => {
    const taskId = "request-revision-resume-task";
    const implementationBranch = `task-${taskId}`;
    const reviewBranch = `task-${taskId}-2`;
    const implementationRunId = "run-request-revision-resume-implementation";
    const reviewRunId = "run-request-revision-resume-review";
    const providerSessionId = "6f7d2f7a-1b2e-4c3d-9a8b-123456789abc";
    const originalPrompt = "Implement the resumable revision journey.";
    const revisionPrompt =
      "Address the deterministic desktop resume feedback.";
    const implementationCwd = join(
      testRepoPath,
      ".kanna-worktrees",
      implementationBranch,
    );

    await addTaskWorktree(taskId, implementationBranch);
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch: reviewBranch,
      path: join(testRepoPath, ".kanna-worktrees", reviewBranch),
      startPoint: "main",
    });
    await insertTask({
      id: taskId,
      prompt: originalPrompt,
      pipeline: REVISION_PIPELINE,
      stage: "review",
      branch: reviewBranch,
      agentType: "agent",
      displayName: "Resume reviewed implementation",
    });
    await execDb(
      client,
      `INSERT INTO stage_run (
         id, task_id, stage, kind, agent, agent_provider, status, session_id,
         provider_session_id, cwd, started_at, run_ownership_version
       ) VALUES (?, ?, 'in progress', 'main', 'revision-e2e', 'codex',
                 'succeeded', ?, ?, ?, datetime('now', '-1 minute'), 1)`,
      [
        implementationRunId,
        taskId,
        taskId,
        providerSessionId,
        implementationCwd,
      ],
    );
    await execDb(
      client,
      `INSERT INTO stage_run (
         id, task_id, stage, kind, agent_provider, status, session_id,
         started_at, run_ownership_version
       ) VALUES (?, ?, 'review', 'main', 'codex', 'running', ?,
                 datetime('now'), 1)`,
      [reviewRunId, taskId, taskId],
    );
    // Earlier selection-focused fixtures intentionally synthesize tasks
    // without stage runs; their terminal fallback sessions therefore have no
    // immutable owner and would downgrade daemon-wide resume negotiation.
    await selectTask(client, taskId);
    await removeOwnershiplessFixtureSessions(client);
    // Keep selection from synthesizing an unowned PTY for the seeded review
    // fixture, while preserving the real PTY target-stage execution.
    await execDb(
      client,
      "UPDATE pipeline_item SET agent_type = 'pty' WHERE id = ?",
      [taskId],
    );
    await requestChangesThroughDiffModal(
      client,
      join(testRepoPath, ".kanna-worktrees", reviewBranch),
      "resume the implementation",
      revisionPrompt,
    );
    await waitForTaskRow(
      client,
      taskId,
      (candidate) =>
        candidate.stage === "in progress"
        && candidate.branch === implementationBranch
        && candidate.activity === "working",
    );

    const row = await getTaskRow(client, taskId);
    expect(row).toMatchObject({
      id: taskId,
      stage: "in progress",
      branch: implementationBranch,
      closed_at: null,
      activity: "working",
      prompt: originalPrompt,
    });
    await waitForVisibleSelectedTaskState(
      client,
      taskId,
      "in progress",
      implementationBranch,
      implementationCwd,
    );
    const runs = await waitForStageRuns(client, taskId, (candidateRuns) =>
      candidateRuns.some(
        (run) =>
          run.stage === "in progress" &&
          run.id !== implementationRunId &&
          run.status === "running" &&
          run.resumed_from_run_id === implementationRunId,
      ),
    );
    expect(runs.find((run) => run.id === reviewRunId)?.status).toBe("failed");
    const resumedRun = runs.find(
      (run) => run.stage === "in progress" && run.id !== implementationRunId,
    );
    expect(resumedRun).toMatchObject({
      status: "running",
      provider_session_id: providerSessionId,
      cwd: implementationCwd,
      resumed_from_run_id: implementationRunId,
      feedback: expect.stringContaining(revisionPrompt),
    });
    expect(resumedRun?.session_id).toBe(resumedRun?.id);

    const capturedArgsPath = join(
      implementationCwd,
      ".kanna",
      "revision-codex-args.txt",
    );
    await waitForFile(capturedArgsPath, 20_000);
    const capturedArgs = await readFile(capturedArgsPath, "utf8");
    expect(capturedArgs).toMatch(/^resume\n/);
    expect(capturedArgs).toContain("--yolo\n");
    expect(capturedArgs).toContain(`${providerSessionId}\n`);
    expect(capturedArgs).toContain(`Original task:\n${originalPrompt}`);
    expect(capturedArgs).toContain("Reviewer feedback:\nRevision requested from review");
    expect(capturedArgs).toContain(revisionPrompt);
    await closeDiffModalIfOpen(client);
  });
});
