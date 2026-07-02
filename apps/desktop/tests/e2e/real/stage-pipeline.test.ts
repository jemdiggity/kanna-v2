import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { advanceStageWithShortcut } from "../helpers/stageAdvance";
import { WebDriverClient } from "../helpers/webdriver";
import { waitForFile } from "../helpers/worktreeFs";

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

describe("real stage pipeline", () => {
  const client = new WebDriverClient();
  const taskId = "stage-pipeline-real-task";
  const branch = "task-stage-pipeline-real";
  let repoId = "";
  let testRepoPath = "";
  let worktreePath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    testRepoPath = await createFixtureRepo("stage-pipeline-real-test");
    worktreePath = join(testRepoPath, ".kanna-worktrees", branch);
    const kannaDir = join(testRepoPath, ".kanna");
    const pipelineName = "real-stage-e2e";
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "commit-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "review-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "fake-bin"), { recursive: true });

    // Durable model: every stage runs in place on the same task/worktree with
    // a fresh agent session. The auto stages bind a fake `codex` (via the
    // stage environment PATH) that records its prompt and reports completion
    // through kanna-cli, driving the server's auto-advance.
    await writeFile(
      join(kannaDir, "pipelines", `${pipelineName}.json`),
      JSON.stringify({
        name: pipelineName,
        environments: {
          "fake-bin": {
            setup: [`export PATH="${join(kannaDir, "fake-bin")}:$PATH"`],
          },
        },
        stages: [
          { name: "in progress", policy: { transition: "manual" } },
          {
            name: "commit",
            agent: "commit-e2e",
            environment: "fake-bin",
            prompt: "Commit marker for $TASK_PROMPT",
            policy: { transition: "auto" },
          },
          {
            name: "review",
            agent: "review-e2e",
            environment: "fake-bin",
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
        "agent_provider: codex",
        "---",
        "Commit stage prompt marker.",
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
    await writeFile(
      join(kannaDir, "fake-bin", "codex"),
      [
        "#!/bin/sh",
        "set -eu",
        'prompt=""',
        'for arg in "$@"; do prompt="$arg"; done',
        "printf '%s\\n---\\n' \"$prompt\" >> .kanna-stage-prompts.log",
        'case "$prompt" in',
        '  *"Commit stage prompt marker."*)',
        "    git add e2e-pipeline-marker.txt",
        "    git commit -m 'test: commit e2e pipeline marker'",
        "    kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary 'committed e2e pipeline marker'",
        "    ;;",
        '  *"Review stage prompt marker."*)',
        "    kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary 'reviewed e2e pipeline marker'",
        "    ;;",
        "esac",
        "sleep 30",
        "",
      ].join("\n"),
    );
    await chmod(join(kannaDir, "fake-bin", "codex"), 0o755);

    const importResult = await callVueMethod(client, "store.importRepo", testRepoPath, "stage-pipeline-real-test", "main");
    if (isVueCallError(importResult)) throw new Error(importResult.__error);
    if (typeof importResult !== "string") throw new Error(`unexpected import result: ${JSON.stringify(importResult)}`);
    repoId = importResult;
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
        "exercise the real stage pipeline",
        "real-stage-e2e",
        "in progress",
        branch,
        "pty",
        "codex",
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
    await writeFile(join(worktreePath, "e2e-pipeline-marker.txt"), "implemented\n");

    // One manual advance enters the auto `commit` stage; the fake agent's
    // stage completions then cascade `commit → review → pr` on the SAME task.
    await advanceStageWithShortcut(client, "exercise the real stage pipeline", taskId);

    await waitForTaskStage(client, taskId, "pr", 90_000);

    // Durable task: no next-stage tasks were created along the way.
    const openTasks = (await queryDb(
      client,
      "SELECT id FROM pipeline_item WHERE repo_id = ? AND closed_at IS NULL",
      [repoId],
    )) as Array<{ id: string }>;
    expect(openTasks.map((row) => row.id)).toEqual([taskId]);

    const promptsLogPath = join(worktreePath, ".kanna-stage-prompts.log");
    await waitForFile(promptsLogPath, 5_000, 100);
    const promptsLog = await readFile(promptsLogPath, "utf8");
    expect(promptsLog).toContain("Commit stage prompt marker.");
    expect(promptsLog).toContain("Commit marker for exercise the real stage pipeline");
    expect(promptsLog).toContain("Review stage prompt marker.");
    // $PREV_RESULT substitution carries the commit stage's recorded result.
    expect(promptsLog).toContain("committed e2e pipeline marker");

    // Full execution history is recorded as stage runs on the same task.
    const runs = (await queryDb(
      client,
      "SELECT stage, status FROM stage_run WHERE task_id = ? ORDER BY started_at, id",
      [taskId],
    )) as Array<{ stage: string | null; status: string | null }>;
    expect(runs.filter((run) => run.stage === "commit" && run.status === "succeeded")).toHaveLength(1);
    expect(runs.filter((run) => run.stage === "review" && run.status === "succeeded")).toHaveLength(1);
    expect(runs.filter((run) => run.stage === "pr" && run.status === "running")).toHaveLength(1);
  }, 120_000);
});
