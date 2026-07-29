import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { advanceStageWithShortcut } from "../helpers/stageAdvance";
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
 */

interface StageRunRow {
  id: string;
  stage: string | null;
  kind: string | null;
  cwd: string | null;
  resumed_from_run_id: string | null;
}

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function hydrateStoreItem(client: WebDriverClient, taskId: string): Promise<void> {
  const rows = (await queryDb(
    client,
    "SELECT * FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<Record<string, unknown>>;
  const item = rows[0];
  if (!item) throw new Error(`task ${taskId} was not found`);

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
  if (result !== "ok") throw new Error(`failed to hydrate store item: ${result}`);
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
    `timed out waiting for ${taskId} at ${expectedStage}/${expectedBranch}; last: ${JSON.stringify(last)}`,
  );
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
    [taskId, repoId, prompt, "revision-kickback-e2e", "in progress", branch, "pty", "codex", "idle", null],
  );
  await hydrateStoreItem(client, taskId);
  await tauriInvoke(client, "git_worktree_add", {
    repoPath,
    branch,
    path: join(repoPath, ".kanna-worktrees", branch),
    startPoint: "main",
  });
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

    testRepoPath = await createFixtureRepo("revision-kickback-real-test");
    kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "implement-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "review-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "fake-bin"), { recursive: true });

    // Both stages are manual so the test drives every transition itself:
    // ⌘S to enter review, then the desktop's revision action to come back.
    await writeFile(
      join(kannaDir, "pipelines", "revision-kickback-e2e.json"),
      JSON.stringify({
        name: "revision-kickback-e2e",
        environments: {
          "fake-bin": {
            setup: [`export PATH="${join(kannaDir, "fake-bin")}:$PATH"`],
          },
        },
        stages: [
          {
            name: "in progress",
            agent: "implement-e2e",
            environment: "fake-bin",
            prompt: "Implement $TASK_PROMPT",
            policy: { transition: "manual" },
          },
          {
            name: "review",
            agent: "review-e2e",
            environment: "fake-bin",
            prompt: "Review $BRANCH",
            policy: { transition: "manual" },
          },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "implement-e2e", "AGENT.md"),
      [
        "---",
        "name: implement-e2e",
        "description: Real E2E implement stage.",
        "agent_provider: codex",
        "---",
        "Implement stage prompt marker.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(kannaDir, "agents", "review-e2e", "AGENT.md"),
      [
        "---",
        "name: review-e2e",
        "description: Real E2E review stage.",
        "agent_provider: codex",
        "---",
        "Review stage prompt marker.",
        "",
      ].join("\n"),
    );
    // The fake agent commits from whichever worktree it was spawned in, so
    // each stage fork carries the previous stage's committed work. It also
    // answers `codex resume --help` so the server's provider resume probe
    // treats it as resume-capable.
    await writeFile(
      join(kannaDir, "fake-bin", "codex"),
      [
        "#!/bin/sh",
        "set -eu",
        'if [ "${1:-}" = "resume" ]; then exit 0; fi',
        'prompt=""',
        'for arg in "$@"; do prompt="$arg"; done',
        `printf '%s\\n---\\n' "$prompt" >> "${join(kannaDir, "revision-prompts.log")}"`,
        'case "$prompt" in',
        '  *"Implement stage prompt marker."*)',
        '    marker="e2e-${KANNA_STAGE_RUN_ID:-unknown}.txt"',
        '    printf \'implemented\\n\' > "$marker"',
        '    git add "$marker"',
        "    git commit -m 'test: implement marker'",
        "    ;;",
        "esac",
        "sleep 30",
        "",
      ].join("\n"),
    );
    await chmod(join(kannaDir, "fake-bin", "codex"), 0o755);

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
    await advanceStageWithShortcut(client, prompt, forkTaskId);
    await waitForTaskWorkspace(client, forkTaskId, "review", `task-${forkTaskId}-2`, 90_000);

    // A PTY codex run records no provider session id, so the revision cannot
    // resume the implement conversation and takes the fresh-fork path.
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

    const revisionAccepted = await callVueMethod(client, "store.requestRevision", forkTaskId, {
      targetStage: "in progress",
      summary: "needs another pass",
      prompt: "Add the missing coverage before this can advance.",
    });
    if (isVueCallError(revisionAccepted)) throw new Error(revisionAccepted.__error);
    expect(revisionAccepted).toBe(true);

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
    expect(worktreeRows.some((row) => row.branch === `task-${forkTaskId}-3` && row.path === forkedWorktree)).toBe(true);

    const revisionRun = await waitForStageRun(
      client,
      forkTaskId,
      (run) => run.stage === "in progress" && run.kind === "main" && run.cwd === forkedWorktree,
      "the revision stage run in the forked workspace",
    );
    expect(revisionRun.resumed_from_run_id).toBeNull();
    // The commit made in workspace 1 crossed into the fork: only committed
    // work travels across a workspace boundary.
    const carried = await readdir(forkedWorktree);
    expect(carried.some((name) => name.startsWith("e2e-") && name.endsWith(".txt"))).toBe(true);
  }, 240_000);

  it("resumes the previous in-progress workspace instead of forking a new one", async () => {
    const prompt = "exercise a revision kickback that resumes";
    await seedTaskAtInProgress(client, repoId, testRepoPath, resumeTaskId, prompt);

    await advanceStageWithShortcut(client, prompt, resumeTaskId);
    await waitForTaskWorkspace(client, resumeTaskId, "review", `task-${resumeTaskId}-2`, 90_000);

    const implementRun = await waitForStageRun(
      client,
      resumeTaskId,
      (run) => run.stage === "in progress" && run.kind === "main",
      "the implement stage run",
    );
    const implementWorktree = join(testRepoPath, ".kanna-worktrees", `task-${resumeTaskId}`);
    expect(implementRun.cwd).toBe(implementWorktree);

    // Providers that own a resumable conversation record its id on the run.
    // A PTY codex run does not, so stand one in: everything the resume path
    // then verifies — worktree identity and registration, the committed tip,
    // the installed CLI's resume feature, and daemon run ownership — is real.
    await execDb(client, "UPDATE stage_run SET provider_session_id = ? WHERE id = ?", [
      "e2e-resumable-session",
      implementRun.id,
    ]);

    const revisionAccepted = await callVueMethod(client, "store.requestRevision", resumeTaskId, {
      targetStage: "in progress",
      summary: "needs another pass",
      prompt: "Add the missing coverage before this can advance.",
    });
    if (isVueCallError(revisionAccepted)) throw new Error(revisionAccepted.__error);
    expect(revisionAccepted).toBe(true);

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
      `task-${resumeTaskId}-2`,
    ]);

    const resumedRun = await waitForStageRun(
      client,
      resumeTaskId,
      (run) => run.stage === "in progress" && run.kind === "main" && run.resumed_from_run_id !== null,
      "the resumed revision stage run",
    );
    expect(resumedRun.resumed_from_run_id).toBe(implementRun.id);
    expect(resumedRun.cwd).toBe(implementWorktree);
  }, 240_000);
});
