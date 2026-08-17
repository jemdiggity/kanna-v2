import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo, publishFixtureChanges } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { advanceStageWithShortcut } from "../helpers/stageAdvance";
import { WebDriverClient } from "../helpers/webdriver";

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

async function waitForTaskStage(
  client: WebDriverClient,
  taskId: string,
  expectedStage: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: { stage: string | null; closed_at: string | null } | undefined;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT stage, closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ stage: string | null; closed_at: string | null }>;
    last = rows[0];
    if (last?.stage === expectedStage && last.closed_at === null) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${taskId} to reach ${expectedStage}; last: ${JSON.stringify(last)}`);
}

describe("real stage workflow", () => {
  const client = new WebDriverClient();
  const taskId = "stage-workflow-real-task";
  const branch = "task-stage-workflow-real";
  let repoId = "";
  let testRepoPath = "";
  let worktreePath = "";
  let kannaDir = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();

    testRepoPath = await createFixtureRepo("stage-workflow-real-test");
    worktreePath = join(testRepoPath, ".kanna-worktrees", branch);
    kannaDir = join(testRepoPath, ".kanna");
    const workflowName = "real-stage-e2e";
    await mkdir(join(kannaDir, "workflows"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "commit-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "review-e2e"), { recursive: true });

    // Durable model: every stage runs on the same task with a fresh workspace
    // and agent session. Live-agent real E2E is always pinned to OpenCode's
    // free model; never drive Claude or a paid provider programmatically.
    await writeFile(
      join(kannaDir, "workflows", `${workflowName}.json`),
      JSON.stringify({
        name: workflowName,
        stages: [
          { name: "in progress", policy: { transition: "manual" } },
          {
            name: "commit",
            agent: "commit-e2e",
            prompt: "Commit marker for $TASK_PROMPT",
            policy: { transition: "auto" },
          },
          {
            name: "review",
            agent: "review-e2e",
            prompt: "Review previous result: $PREV_RESULT",
            policy: { transition: "auto" },
          },
          { name: "pr", policy: { transition: "manual" } },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "commit-e2e", "AGENT.md"),
      [
        "---",
        "name: commit-e2e",
        "description: Real E2E commit stage.",
        "agent_provider: opencode",
        "model: opencode/big-pickle",
        "---",
        "Create e2e-workflow-marker.txt containing exactly `implemented` followed by a newline.",
        "Commit that file to git, then record successful stage completion as instructed.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(kannaDir, "agents", "review-e2e", "AGENT.md"),
      [
        "---",
        "name: review-e2e",
        "description: Real E2E review stage.",
        "agent_provider: opencode",
        "model: opencode/big-pickle",
        "---",
        "Verify that e2e-workflow-marker.txt is committed and contains exactly `implemented`.",
        "Do not modify the worktree. Record successful stage completion as instructed.",
        "",
      ].join("\n"),
    );
    await publishFixtureChanges(testRepoPath, "test: add real stage workflow fixture");

    repoId = await importTestRepo(client, testRepoPath, "stage-workflow-real-test");
  });

  afterAll(async () => {
    await tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined);
    if (repoId) {
      const rows = (await queryDb(
        client,
        "SELECT id FROM pipeline_item WHERE repo_id = ?",
        [repoId],
      ).catch(() => [])) as Array<{ id: string }>;
      await Promise.all(rows.map((row) => tauriInvoke(client, "kill_session", { sessionId: row.id }).catch(() => undefined)));
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([testRepoPath]).catch(() => undefined);
    }
    await client.deleteSession();
  });

  it("advances the same task in place through commit and review to pr", async () => {
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "exercise the real stage workflow",
        "real-stage-e2e",
        "in progress",
        branch,
        "pty",
        "opencode",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, taskId);
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: worktreePath,
      startPoint: "main",
    });

    // One manual advance enters the auto `commit` stage; the fake agent's
    // stage completions then cascade `commit → review → pr` on the SAME
    // task, each stage in a freshly forked branch + worktree.
    await advanceStageWithShortcut(client, "exercise the real stage workflow", taskId);

    // Each real auto transition waits for the live stage process teardown;
    // two transitions can legitimately exceed the old 90-second deadline.
    await waitForTaskStage(client, taskId, "pr", 180_000);

    // Durable task: no next-stage tasks were created along the way.
    const openTasks = (await queryDb(
      client,
      "SELECT id FROM pipeline_item WHERE repo_id = ? AND closed_at IS NULL",
      [repoId],
    )) as Array<{ id: string }>;
    expect(openTasks.map((row) => row.id)).toEqual([taskId]);

    // Each transition forked by appending the workspace counter to the
    // durable task branch rather than replacing it with a random name.
    const branchRows = (await queryDb(
      client,
      "SELECT branch FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ branch: string | null }>;
    const finalBranch = branchRows[0]?.branch ?? "";
    expect(finalBranch).not.toBe(branch);
    expect(finalBranch).toBe("task-stage-workflow-real-task-4");

    // The commit made in the commit stage's fork crossed the boundary into
    // the final stage's fork: only committed work travels between stages.
    const finalWorktree = join(testRepoPath, ".kanna-worktrees", finalBranch);
    expect(await readFile(join(finalWorktree, "e2e-workflow-marker.txt"), "utf8")).toBe("implemented\n");

    // Full execution history is recorded as stage runs on the same task.
    const runs = (await queryDb(
      client,
      "SELECT stage, status FROM stage_run WHERE task_id = ? ORDER BY started_at, id",
      [taskId],
    )) as Array<{ stage: string | null; status: string | null }>;
    expect(runs.filter((run) => run.stage === "commit" && run.status === "succeeded")).toHaveLength(1);
    expect(runs.filter((run) => run.stage === "review" && run.status === "succeeded")).toHaveLength(1);
    expect(runs.filter((run) => run.stage === "pr" && run.status === "running")).toHaveLength(1);
  }, 240_000);
});
