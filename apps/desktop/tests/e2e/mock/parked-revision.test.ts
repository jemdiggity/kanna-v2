import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const execFileAsync = promisify(execFile);

interface TaskRow {
  stage: string | null;
  branch: string | null;
  closed_at: string | null;
  revision_rounds: number;
}

interface StageRunRow {
  stage: string;
  status: string;
}

interface TaskEventRow {
  payload: string | null;
}

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value
    && typeof value === "object"
    && "__error" in value
    && typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, ...args]);
}

async function waitForTaskStage(
  client: WebDriverClient,
  taskId: string,
  expectedStage: string,
  timeoutMs = 20_000,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskRow | null = null;
  while (Date.now() < deadline) {
    const rows = await queryDb(
      client,
      "SELECT stage, branch, closed_at, revision_rounds FROM pipeline_item WHERE id = ?",
      [taskId],
    ) as TaskRow[];
    last = rows[0] ?? null;
    if (last?.stage === expectedStage) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${taskId} at ${expectedStage}; last row: ${JSON.stringify(last)}`);
}

describe("parked task human revision recovery", () => {
  const client = new WebDriverClient();
  const taskId = "parked-human-revision-task";
  const childTaskId = "closed-specialty-review-child";
  const branch = "task-parked-human-revision";
  let fixtureRepoRoot = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("parked-revision-test");
    const kannaDir = join(fixtureRepoRoot, ".kanna");
    await mkdir(join(kannaDir, "agents", "revision-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "fake-bin"), { recursive: true });
    await writeFile(
      join(kannaDir, "agents", "revision-e2e", "AGENT.md"),
      [
        "---",
        "name: Revision E2E",
        "description: Captures parked human revision prompts.",
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
        "printf '%s\\n' \"$@\" > .kanna/parked-revision-codex-args.txt",
        "",
      ].join("\n"),
    );
    await chmod(join(kannaDir, "fake-bin", "codex"), 0o755);
    await git(fixtureRepoRoot, ["add", ".kanna"]);
    await git(fixtureRepoRoot, ["commit", "-m", "test: add parked revision fixtures"]);
    await git(fixtureRepoRoot, ["push", "origin", "main"]);
    repoId = await importTestRepo(client, fixtureRepoRoot, "parked-revision-test");
  });

  afterAll(async () => {
    await tauriInvoke(client, "kill_session", { sessionId: taskId }).catch(() => undefined);
    if (fixtureRepoRoot) await cleanupWorktrees(client, fixtureRepoRoot);
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("starts a human revision from the normal task UI and resets the exhausted budget", async () => {
    const workflowDefinition = JSON.stringify({
      name: "parked-revision-e2e",
      revision_limit: 3,
      environments: {
        "fake-bin": { setup: ["export PATH=\"$PWD/.kanna/fake-bin:$PATH\""] },
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
    });
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: fixtureRepoRoot,
      branch,
      path: join(fixtureRepoRoot, ".kanna-worktrees", branch),
      startPoint: "main",
    });
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, display_name, pipeline, pipeline_def, stage, branch,
         agent_type, agent_provider, agent_session_id, activity, revision_rounds,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'parked-revision-e2e', ?, 'review', ?,
         'pty', 'codex', NULL, 'unread', 3, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "Make notarization Keychain lookup deterministic",
        "Parked exhausted revision",
        workflowDefinition,
        branch,
      ],
    );
    await execDb(
      client,
      `INSERT INTO stage_run (
         id, task_id, stage, kind, agent_provider, status, result, feedback, finished_at
       ) VALUES (?, ?, 'review', 'main', 'codex', 'failed', ?, ?, datetime('now'))`,
      [
        "run-parked-human-revision-review",
        taskId,
        JSON.stringify({
          status: "failure",
          summary: "Parked for human review: this task's automatic revision budget (3 rounds) is spent.",
        }),
        "The automatic reviewer requested another implementation pass.",
      ],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, display_name, pipeline, pipeline_def, stage,
         agent_type, agent_provider, agent_session_id, activity, parent_task_id,
         closed_at, created_at, updated_at
       ) VALUES (?, ?, 'Review release security', 'Closed security specialty review',
         'parked-revision-e2e', ?, 'review', 'pty', 'codex', NULL, 'idle', ?,
         datetime('now'), datetime('now'), datetime('now'))`,
      [childTaskId, repoId, workflowDefinition, taskId],
    );

    const loadResult = await callVueMethod(client, "loadItems", repoId);
    if (isVueCallError(loadResult)) throw new Error(loadResult.__error);
    const refreshResult = await callVueMethod(client, "refreshAllItems");
    if (isVueCallError(refreshResult)) throw new Error(refreshResult.__error);
    const sidebarTask = await client.waitForText(
      ".sidebar .item-title",
      "Parked exhausted revision",
      10_000,
    );
    await client.click(sidebarTask);

    await client.waitForElement('[data-testid="revision-recovery"]', 10_000);
    await client.click(await client.findElement('[data-testid="open-revision-composer"]'));
    await client.waitForElement('[data-testid="revision-composer"]', 2_000);
    const submit = await client.findElement('[data-testid="submit-revision"]');
    const submitEnabled = async () => await client.executeSync<boolean>(
      `const button = document.querySelector('[data-testid="submit-revision"]');
       return button instanceof HTMLButtonElement && !button.disabled;`,
    );
    expect(await submitEnabled()).toBe(false);
    const summary = "Apply the operator-approved recovery pass";
    const prompt = "Make Keychain lookup deterministic and retain focused regression coverage.";
    await client.sendKeys(await client.findElement('[data-testid="revision-summary"]'), summary);
    expect(await submitEnabled()).toBe(false);
    await client.sendKeys(await client.findElement('[data-testid="revision-prompt"]'), prompt);
    expect(await submitEnabled()).toBe(true);
    await client.click(submit);

    const task = await waitForTaskStage(client, taskId, "in progress");
    expect(task.closed_at).toBeNull();
    expect(task.branch).toBe(`task-${taskId}-2`);
    expect(task.revision_rounds).toBe(0);

    const eventRows = await queryDb(
      client,
      `SELECT payload FROM task_event
       WHERE task_id = ? AND type = 'task.revision_requested'
       ORDER BY seq DESC LIMIT 1`,
      [taskId],
    ) as TaskEventRow[];
    expect(JSON.parse(eventRows[0]?.payload ?? "null")).toMatchObject({
      targetStage: "in progress",
      summary,
      origin: "human",
      rounds: 0,
      limit: 3,
      exhausted: false,
    });
    await client.waitForNoElement('[data-testid="revision-recovery"]', 10_000);
    expect(await client.executeSync<string>(
      `return document.querySelector(".task-header")?.textContent || "";`,
    )).toContain("in progress");

    const runs = await queryDb(
      client,
      "SELECT stage, status FROM stage_run WHERE task_id = ? ORDER BY started_at, id",
      [taskId],
    ) as StageRunRow[];
    expect(runs.some((run) => run.stage === "in progress" && run.status === "running")).toBe(true);
    const childRows = await queryDb(
      client,
      "SELECT closed_at, agent_session_id FROM pipeline_item WHERE id = ?",
      [childTaskId],
    ) as Array<{ closed_at: string | null; agent_session_id: string | null }>;
    expect(childRows[0]).toMatchObject({ agent_session_id: null });
    expect(childRows[0]?.closed_at).not.toBeNull();
  });
});
