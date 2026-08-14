import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { pauseForSlowMode } from "../helpers/slowMode";
import { tauriInvoke } from "../helpers/vue";
import {
  clearTaskSwitchPerf,
  getAllTaskSwitchPerf,
  waitForCompletedTaskSwitchPerfCount,
  waitForCompletedTaskSwitchPerf,
} from "../helpers/taskSwitchPerf";

interface DaemonSessionInfo {
  session_id?: string;
}

function getPerfLineCount(): number {
  const rawValue = process.env.KANNA_E2E_TASK_SWITCH_LINES;
  if (!rawValue) {
    return 320;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`KANNA_E2E_TASK_SWITCH_LINES must be a positive integer, got: ${rawValue}`);
  }
  return parsed;
}

function buildSetupCommand(label: string, fill: string, lineCount: number): string {
  return `for i in $(seq 1 ${lineCount}); do printf '${label} line %05d | %s\\n' "$i" '${fill}'; done; while true; do sleep 60; done`;
}

function requireCreatedTaskId(value: string, label: string): string {
  if (/^[0-9a-f]{8}$/.test(value)) {
    return value;
  }
  throw new Error(`${label} task creation failed: ${value}`);
}

async function waitForSessions(
  client: WebDriverClient,
  expectedSessionIds: string[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = await tauriInvoke(client, "list_sessions");
    if (Array.isArray(sessions)) {
      const sessionIds = new Set(
        sessions
          .map((session) =>
            typeof session === "object" && session !== null
              ? (session as DaemonSessionInfo).session_id
              : undefined,
          )
          .filter((value): value is string => typeof value === "string"),
      );
      if (expectedSessionIds.every((sessionId) => sessionIds.has(sessionId))) {
        return;
      }
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for PTY sessions: ${expectedSessionIds.join(", ")}`);
}

describe("task switch performance", () => {
  const client = new WebDriverClient();
  let repoId = "";
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await pauseForSlowMode("task-switch session created");
    await resetDatabase(client);
    await pauseForSlowMode("task-switch database reset");
    fixtureRepoRoot = await createSeedFixtureRepo("task-switch-minimal");
    testRepoPath = fixtureRepoRoot;
    repoId = await importTestRepo(client, testRepoPath, "task-switch-perf");
    await pauseForSlowMode("task-switch repo imported");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("records PTY task-switch markers and prints timings", async () => {
    const lineCount = getPerfLineCount();
    // Internal setup only: perf coverage needs deterministic PTY sessions with
    // controlled output volume, not real agent startup and model latency.
    const createTaskAResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const setupCmd = ${JSON.stringify(buildSetupCommand("Perf Task A", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", lineCount))};
       Promise.resolve(
         ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, "Perf Task A", "pty", {
           selectOnCreate: false,
           agentProvider: "claude",
           customTask: {
             executionMode: "pty",
             agentProvider: "claude",
             setup: [setupCmd],
           },
         })
       ).then((id) => cb(id)).catch((error) => cb(String(error)));`,
    );
    const taskA = {
      id: requireCreatedTaskId(createTaskAResult, "Perf Task A"),
      prompt: "Perf Task A",
    };
    await pauseForSlowMode("task-switch task A created");

    const createTaskBResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const setupCmd = ${JSON.stringify(buildSetupCommand("Perf Task B", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", lineCount))};
       Promise.resolve(
         ctx.createItem(${JSON.stringify(repoId)}, ${JSON.stringify(testRepoPath)}, "Perf Task B", "pty", {
           selectOnCreate: false,
           agentProvider: "claude",
           customTask: {
             executionMode: "pty",
             agentProvider: "claude",
             setup: [setupCmd],
           },
         })
       ).then((id) => cb(id)).catch((error) => cb(String(error)));`,
    );
    const taskB = {
      id: requireCreatedTaskId(createTaskBResult, "Perf Task B"),
      prompt: "Perf Task B",
    };
    await pauseForSlowMode("task-switch task B created");

    await waitForSessions(client, [taskA.id, taskB.id]);
    await sleep(1000);
    await pauseForSlowMode("task-switch sessions spawned");

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(ctx.store.selectItem(${JSON.stringify(taskA.id)}))
         .then(() => cb("ok"))
         .catch((error) => cb(String(error)));`,
    );
    await client.waitForText(".workflow-item.selected", "Perf Task A");

    const switchOrder = [taskB, taskA, taskB];
    const expectedLastTaskId = switchOrder.at(-1)?.id;
    if (!expectedLastTaskId) {
      throw new Error("expected task switch order to include a final target");
    }

    await clearTaskSwitchPerf(client);
    await pauseForSlowMode("task-switch perf records cleared");

    for (const [index, targetTask] of switchOrder.entries()) {
      const taskElement = await client.waitForText(".workflow-item", targetTask.prompt);
      await client.click(taskElement);
      await waitForCompletedTaskSwitchPerfCount(client, index + 1);
      await pauseForSlowMode(`task-switch selected ${targetTask.id}`);
    }

    const latest = await waitForCompletedTaskSwitchPerf(client);
    const all = await getAllTaskSwitchPerf(client);
    await pauseForSlowMode("task-switch perf record captured");

    const completed = all.filter((record) =>
      record &&
      typeof record === "object" &&
      "completed" in record &&
      record.completed === true,
    ) as Array<Record<string, unknown>>;
    const summary = completed.map((record) => ({
      lines: lineCount,
      taskId: record.taskId,
      path: record.path,
      total: (record.measures as Record<string, unknown> | undefined)?.total,
      mount: (record.measures as Record<string, unknown> | undefined)?.mount,
      ready: (record.measures as Record<string, unknown> | undefined)?.ready,
      firstOutput: (record.measures as Record<string, unknown> | undefined)?.firstOutput,
    }));

    console.log("[e2e][task-switch-perf]", JSON.stringify(summary));

    expect(Array.isArray(all)).toBe(true);
    expect(completed.length).toBeGreaterThanOrEqual(3);
    expect(latest).toEqual(expect.objectContaining({
      taskId: expectedLastTaskId,
      terminalKind: "pty",
      path: expect.stringMatching(/warm|cold|unknown/),
      completed: true,
      marks: expect.objectContaining({
        start: expect.any(Number),
        "terminal-mounted": expect.any(Number),
        "terminal-ready": expect.any(Number),
      }),
      measures: expect.objectContaining({
        total: expect.any(Number),
        mount: expect.any(Number),
        ready: expect.any(Number),
      }),
    }));
  });
});
