import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { WebDriverClient } from "../helpers/webdriver";

/**
 * Kicking a task back from `review` to `in progress` is the one transition
 * that can move the task's workspace *backwards*, so its branch naming is
 * covered here end to end rather than in isolation: it crosses the server's
 * revision preparation, the daemon's session kill/respawn, and real git
 * worktree forking, and no one of those alone decides which branch the task
 * lands on.
 *
 * Two outcomes are correct, and which one applies is decided by whether the
 * previous `in progress` run is resumable:
 *
 *  - not resumable → fork the next `task-<id>-<n>` workspace, exactly like
 *    any other stage transition;
 *  - resumable → reopen that run's own worktree, which moves
 *    `pipeline_item.branch` back to the branch that run was on. There is no
 *    new `-<n>` in this case; that is the design, not a lost suffix.
 *
 * Like the rest of `real/`, this needs the provider CLI installed: the server
 * probes the installed Copilot CLI's `--help` for `--resume` before it will
 * resume a run, and a machine without it takes the fork path instead.
 */

interface StageRunRow {
  id: string;
  stage: string | null;
  kind: string | null;
  cwd: string | null;
  resumed_from_run_id: string | null;
}

const run = promisify(execFile);

const CARRIED_FILE = "e2e-carried.txt";

/**
 * Fixture repos live under the OS temp dir, which is a symlink on macOS
 * (`/var` → `/private/var`). Paths the server records go through
 * `canonicalize`, so compare recorded paths by their resolved form.
 */
function samePath(recorded: string | null | undefined, expected: string): boolean {
  if (!recorded) return false;
  const resolve = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return resolve(recorded) === resolve(expected);
}

/**
 * Publish the fixture's `.kanna/` definitions to `origin/main`. The server
 * resolves pipelines and agents from `origin/<default-branch>`, never from the
 * checkout's working tree, so definitions written into the fixture after
 * `createFixtureRepo` are invisible until they are committed and pushed.
 */
async function publishDefinitions(repoPath: string, message: string): Promise<void> {
  await run("git", ["add", "."], { cwd: repoPath });
  await run("git", ["commit", "-m", message], { cwd: repoPath });
  await run("git", ["push", "origin", "main"], { cwd: repoPath });
}

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

/**
 * Pull the seeded row into the store the way the app does. Splicing it into
 * `store.items` is not enough: selection resolves against `store.taskUiSlots`,
 * which only `reloadSnapshot()` builds — a hand-spliced item renders a sidebar
 * row that clicks straight through `selectItem`'s `if (!slot) return`.
 */
async function reloadUntilTaskIsSelectable(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSlotTaskIds: unknown = null;
  while (Date.now() < deadline) {
    const reloaded = await callVueMethod(client, "store.reloadSnapshot");
    if (isVueCallError(reloaded)) throw new Error(reloaded.__error);
    lastSlotTaskIds = await client.executeSync<Array<string | null>>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const slots = ctx.store?.taskUiSlots?.value ?? ctx.store?.taskUiSlots ?? [];
       return slots.map((slot) => slot.task_id ?? null);`,
    );
    if (Array.isArray(lastSlotTaskIds) && lastSlotTaskIds.includes(taskId)) return;
    await sleep(200);
  }
  throw new Error(
    `timed out waiting for ${taskId} to become selectable; slots: ${JSON.stringify(lastSlotTaskIds)}`,
  );
}

/**
 * The store reports pipeline action failures through `console.error` and a
 * toast, and its action functions resolve without surfacing them. Capture the
 * console so a timeout here reports the server's reason instead of just the
 * stage that never changed.
 */
async function installConsoleErrorCapture(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `if (!window.__KANNA_E2E_ERRORS__) {
       window.__KANNA_E2E_ERRORS__ = [];
       const original = console.error;
       console.error = function (...args) {
         try {
           window.__KANNA_E2E_ERRORS__.push(
             args.map((arg) => (arg && arg.message) ? arg.message : String(arg)).join(" "),
           );
         } catch (error) { /* never let capture break the app */ }
         original.apply(console, args);
       };
     }
     return "ok";`,
  );
}

async function capturedErrors(client: WebDriverClient): Promise<string[]> {
  const errors = await client.executeSync<string[]>(
    "return window.__KANNA_E2E_ERRORS__ ?? [];",
  );
  return Array.isArray(errors) ? errors : [];
}

/** Wait until the daemon reports a live session owned by `runId`. */
async function waitForDaemonOwnedSession(
  client: WebDriverClient,
  runId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let sessions: unknown = null;
  while (Date.now() < deadline) {
    sessions = await tauriInvoke(client, "list_sessions").catch((error) => String(error));
    if (
      Array.isArray(sessions) &&
      sessions.some((session) => (session as { run_id?: string }).run_id === runId)
    ) {
      return;
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for the daemon to own run ${runId}; sessions: ${JSON.stringify(sessions)}`,
  );
}

async function readTask(
  client: WebDriverClient,
  taskId: string,
): Promise<{ stage: string | null; branch: string | null }> {
  const rows = (await queryDb(
    client,
    "SELECT stage, branch FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<{ stage: string | null; branch: string | null }>;
  const row = rows[0];
  if (!row) throw new Error(`task ${taskId} was not found`);
  return row;
}

async function waitForTaskWorkspace(
  client: WebDriverClient,
  taskId: string,
  expectedStage: string,
  expectedBranch: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: { stage: string | null; branch: string | null } | undefined;
  while (Date.now() < deadline) {
    last = await readTask(client, taskId);
    if (last.stage === expectedStage && last.branch === expectedBranch) return;
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for ${taskId} at ${expectedStage}/${expectedBranch}; last: ${JSON.stringify(last)}; ` +
    `app errors: ${JSON.stringify(await capturedErrors(client))}`,
  );
}

/**
 * Advance through the store action the ⌘S handler calls. The binding itself is
 * covered by `stage-advance.test.ts`; what matters here is the transition the
 * server, daemon, and git perform underneath it.
 */
async function advanceStage(client: WebDriverClient, taskId: string): Promise<void> {
  const result = await callVueMethod(client, "store.advanceStage", taskId);
  if (isVueCallError(result)) throw new Error(result.__error);
}

async function requestRevisionToInProgress(
  client: WebDriverClient,
  taskId: string,
): Promise<void> {
  const accepted = await callVueMethod(client, "store.requestRevision", taskId, {
    targetStage: "in progress",
    summary: "needs another pass",
    prompt: "Add the missing coverage before this can advance.",
  });
  if (isVueCallError(accepted)) throw new Error(accepted.__error);
  if (accepted !== true) {
    const runs = await queryDb(
      client,
      "SELECT id, stage, kind, status, session_id, provider_session_id, run_ownership_version FROM stage_run WHERE task_id = ? ORDER BY started_at, rowid",
      [taskId],
    );
    const sessions = await queryDb(
      client,
      "SELECT id, daemon_session_id FROM terminal_session WHERE pipeline_item_id = ?",
      [taskId],
    );
    throw new Error(
      `requestRevision was refused for ${taskId}; app errors: ${JSON.stringify(await capturedErrors(client))}; ` +
      `runs: ${JSON.stringify(runs)}; sessions: ${JSON.stringify(sessions)}`,
    );
  }
}

async function listStageRuns(client: WebDriverClient, taskId: string): Promise<StageRunRow[]> {
  return (await queryDb(
    client,
    "SELECT id, stage, kind, cwd, resumed_from_run_id FROM stage_run WHERE task_id = ? ORDER BY started_at, rowid",
    [taskId],
  )) as StageRunRow[];
}

async function waitForStageRun(
  client: WebDriverClient,
  taskId: string,
  predicate: (run: StageRunRow) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<StageRunRow> {
  const deadline = Date.now() + timeoutMs;
  let runs: StageRunRow[] = [];
  while (Date.now() < deadline) {
    runs = await listStageRuns(client, taskId);
    const match = runs.find(predicate);
    if (match) return match;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}; runs: ${JSON.stringify(runs)}`);
}

async function workspaceDirs(repoPath: string, taskId: string): Promise<string[]> {
  const entries = await readdir(join(repoPath, ".kanna-worktrees"), {
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`task-${taskId}`))
    .map((entry) => entry.name)
    .sort();
}

function implementRunId(taskId: string): string {
  return `run-${taskId}-implement`;
}

async function seedTaskAtInProgress(
  client: WebDriverClient,
  repoId: string,
  repoPath: string,
  taskId: string,
  prompt: string,
): Promise<void> {
  const branch = `task-${taskId}`;
  await execDb(
    client,
    `INSERT INTO pipeline_item (
       id, repo_id, prompt, pipeline, stage, branch,
       agent_type, agent_provider, activity, display_name, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [taskId, repoId, prompt, "revision-kickback-e2e", "in progress", branch, "pty", "copilot", "idle", null],
  );
  // The finished `in progress` run the revision will target. A real implement
  // run records exactly this: the stage, the provider, and the worktree it ran
  // in. `provider_session_id` stays null here because a PTY codex run owns no
  // resumable conversation — the resume case sets one explicitly.
  await execDb(
    client,
    `INSERT INTO stage_run (
       id, task_id, stage, kind, agent, agent_provider, status, result,
       session_id, provider_session_id, cwd, completion_transition,
       run_ownership_version, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      implementRunId(taskId),
      taskId,
      "in progress",
      "main",
      "implement-e2e",
      "copilot",
      "succeeded",
      JSON.stringify({ status: "success", summary: "implemented" }),
      taskId,
      null,
      join(repoPath, ".kanna-worktrees", branch),
      "manual",
      1,
    ],
  );
  const worktreePath = join(repoPath, ".kanna-worktrees", branch);
  await tauriInvoke(client, "git_worktree_add", {
    repoPath,
    branch,
    path: worktreePath,
    startPoint: "main",
  });
  // Committed work in the creation workspace, so a later fork can be checked
  // for carrying it: only committed work crosses a workspace boundary.
  await writeFile(join(worktreePath, CARRIED_FILE), "implemented\n");
  await run("git", ["add", CARRIED_FILE], { cwd: worktreePath });
  await run("git", ["commit", "-m", "test: implement marker"], { cwd: worktreePath });
  await reloadUntilTaskIsSelectable(client, taskId);
}

describe("real revision kickback workspace", () => {
  const client = new WebDriverClient();
  const forkTaskId = "revkick-fork";
  const resumeTaskId = "revkick-resume";
  let repoId = "";
  let testRepoPath = "";
  let kannaDir = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    await installConsoleErrorCapture(client);

    // Canonicalize up front. Repo import stores the resolved path, and the
    // revision resume precondition compares a recorded run cwd against
    // `<repo.path>/.kanna-worktrees` *before* canonicalizing either side — so
    // a fixture path that still goes through the macOS `/var` symlink would
    // silently fail that check and fork instead of resuming.
    testRepoPath = realpathSync(await createFixtureRepo("revision-kickback-real-test"));
    kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "implement-e2e"), { recursive: true });

    // Both stages are manual, so the test drives every transition itself:
    // advance into review, then the desktop's revision action to come back.
    await writeFile(
      join(kannaDir, "pipelines", "revision-kickback-e2e.json"),
      JSON.stringify({
        name: "revision-kickback-e2e",
        stages: [
          {
            name: "in progress",
            agent: "implement-e2e",
            prompt: "Implement $TASK_PROMPT",
            policy: { transition: "manual" },
          },
          // Agent-less: this test is about the transition, not about what a
          // reviewer does inside the review workspace.
          { name: "review", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "implement-e2e", "AGENT.md"),
      [
        "---",
        "name: implement-e2e",
        "description: Real E2E implement stage.",
        "agent_provider: copilot",
        "---",
        "Implement stage prompt marker.",
        "",
      ].join("\n"),
    );
    await publishDefinitions(testRepoPath, "publish revision kickback definitions");

    const importResult = await callVueMethod(
      client,
      "store.importRepo",
      testRepoPath,
      "revision-kickback-real-test",
      "main",
    );
    if (isVueCallError(importResult)) throw new Error(importResult.__error);
    if (typeof importResult !== "string") {
      throw new Error(`unexpected import result: ${JSON.stringify(importResult)}`);
    }
    repoId = importResult;
  });

  afterAll(async () => {
    if (repoId) {
      const rows = (await queryDb(
        client,
        "SELECT id FROM pipeline_item WHERE repo_id = ?",
        [repoId],
      ).catch(() => [])) as Array<{ id: string }>;
      await Promise.all(
        rows.map((row) =>
          tauriInvoke(client, "kill_session", { sessionId: row.id }).catch(() => undefined),
        ),
      );
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("forks the next task-<id>-N workspace when the previous run is not resumable", async () => {
    const prompt = "exercise a revision kickback that forks";
    await seedTaskAtInProgress(client, repoId, testRepoPath, forkTaskId, prompt);

    // Forward transition: `in progress` (workspace 1) → `review` forks
    // workspace 2. This is the baseline the reported symptom is measured
    // against.
    await advanceStage(client, forkTaskId);
    await waitForTaskWorkspace(client, forkTaskId, "review", `task-${forkTaskId}-2`, 90_000);

    // The implement run recorded no provider session id, so there is no
    // conversation for the revision to reopen and it takes the fresh-fork
    // path — the same path every non-resumable kickback takes.
    const implementRun = await waitForStageRun(
      client,
      forkTaskId,
      (run) => run.stage === "in progress" && run.kind === "main",
      "the implement stage run",
    );
    const providerSessionIds = (await queryDb(
      client,
      "SELECT provider_session_id FROM stage_run WHERE id = ?",
      [implementRun.id],
    )) as Array<{ provider_session_id: string | null }>;
    expect(providerSessionIds[0]?.provider_session_id ?? null).toBeNull();

    await requestRevisionToInProgress(client, forkTaskId);

    // The kickback forks workspace 3 — the durable task id plus the next free
    // counter, exactly like a forward transition.
    await waitForTaskWorkspace(
      client,
      forkTaskId,
      "in progress",
      `task-${forkTaskId}-3`,
      90_000,
    );

    const forkedWorktree = join(testRepoPath, ".kanna-worktrees", `task-${forkTaskId}-3`);
    expect(existsSync(forkedWorktree)).toBe(true);
    // Nothing is reclaimed: earlier workspaces stay on disk for the open task.
    expect(await workspaceDirs(testRepoPath, forkTaskId)).toEqual([
      `task-${forkTaskId}`,
      `task-${forkTaskId}-2`,
      `task-${forkTaskId}-3`,
    ]);

    const worktreeRows = (await queryDb(
      client,
      "SELECT path, branch FROM worktree WHERE pipeline_item_id = ?",
      [forkTaskId],
    )) as Array<{ path: string | null; branch: string | null }>;
    expect(
      worktreeRows.some((row) =>
        row.branch === `task-${forkTaskId}-3` && samePath(row.path, forkedWorktree),
      ),
    ).toBe(true);

    const revisionRun = await waitForStageRun(
      client,
      forkTaskId,
      (run) =>
        run.stage === "in progress" && run.kind === "main" && samePath(run.cwd, forkedWorktree),
      "the revision stage run in the forked workspace",
    );
    expect(revisionRun.resumed_from_run_id).toBeNull();
    // The commit made in workspace 1 reached the fork through workspace 2:
    // only committed work travels across a workspace boundary.
    expect(existsSync(join(forkedWorktree, CARRIED_FILE))).toBe(true);
  }, 240_000);

  it("resumes the previous in-progress workspace instead of forking a new one", async () => {
    const prompt = "exercise a revision kickback that resumes";
    const implementWorktree = join(testRepoPath, ".kanna-worktrees", `task-${resumeTaskId}`);
    const reviewBranch = `task-${resumeTaskId}-2`;
    const reviewWorktree = join(testRepoPath, ".kanna-worktrees", reviewBranch);
    const reviewRunId = `run-${resumeTaskId}-review`;

    // Seed the task as it stands mid-review: two workspaces on disk, a
    // finished implement run that owns a resumable conversation, and a review
    // run that owns the task's live process. The forward transition is
    // covered by the fork case above; what this case has to reproduce is the
    // *state a reviewer kicks back from*, including a daemon session the
    // server can verify it still owns.
    await seedTaskAtInProgress(client, repoId, testRepoPath, resumeTaskId, prompt);
    await execDb(client, "UPDATE stage_run SET provider_session_id = ? WHERE id = ?", [
      "e2e-resumable-session",
      implementRunId(resumeTaskId),
    ]);
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch: reviewBranch,
      path: reviewWorktree,
      startPoint: `task-${resumeTaskId}`,
    });
    await execDb(
      client,
      "UPDATE pipeline_item SET stage = 'review', branch = ? WHERE id = ?",
      [reviewBranch, resumeTaskId],
    );
    await execDb(
      client,
      `INSERT INTO stage_run (
         id, task_id, stage, kind, agent_provider, status, session_id, cwd,
         completion_transition, run_ownership_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reviewRunId, resumeTaskId, "review", "main", "copilot", "running", reviewRunId, reviewWorktree, "manual", 1],
    );
    // The daemon session that run owns. `KANNA_STAGE_RUN_ID` is what the
    // daemon records as the session's run owner, and the server checks that
    // ownership before it will resume anything.
    await tauriInvoke(client, "spawn_session", {
      sessionId: reviewRunId,
      cwd: reviewWorktree,
      executable: "/bin/sh",
      args: ["-c", "sleep 600"],
      env: { KANNA_STAGE_RUN_ID: reviewRunId },
      cols: 80,
      rows: 24,
      agentProvider: null,
    });
    // The task's durable terminal mapping. Every real task has one, and the
    // revision path needs it: preparing a revision retires the current run
    // first, so the source session is resolved from this mapping rather than
    // from a still-running stage run.
    await execDb(
      client,
      `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`ts-${resumeTaskId}`, repoId, resumeTaskId, "agent", reviewWorktree, reviewRunId],
    );
    await waitForDaemonOwnedSession(client, reviewRunId);
    await reloadUntilTaskIsSelectable(client, resumeTaskId);

    await requestRevisionToInProgress(client, resumeTaskId);

    // The task goes back to the implement run's own workspace. Its branch
    // moves backwards and no new counter is allocated — this, not a missing
    // `-N`, is what a resumable kickback looks like.
    await waitForTaskWorkspace(
      client,
      resumeTaskId,
      "in progress",
      `task-${resumeTaskId}`,
      90_000,
    );
    expect(await workspaceDirs(testRepoPath, resumeTaskId)).toEqual([
      `task-${resumeTaskId}`,
      reviewBranch,
    ]);

    const resumedRun = await waitForStageRun(
      client,
      resumeTaskId,
      (run) => run.stage === "in progress" && run.kind === "main" && run.resumed_from_run_id !== null,
      "the resumed revision stage run",
    );
    expect(resumedRun.resumed_from_run_id).toBe(implementRunId(resumeTaskId));
    expect(samePath(resumedRun.cwd, implementWorktree)).toBe(true);
  }, 240_000);
});
