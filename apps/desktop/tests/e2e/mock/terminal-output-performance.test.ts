import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { tauriInvoke } from "../helpers/vue";

interface DaemonSessionInfo {
  session_id?: string;
}

interface AppMetricsSnapshot {
  invokeCounts: Record<string, number>;
  listenCounts: Record<string, number>;
  unlistenCounts: Record<string, number>;
  activeListenCounts: Record<string, number>;
}

interface PerfTask {
  id: string;
  prompt: string;
}

function buildStreamingSetupCommand(label: string): string {
  return [
    "i=1",
    "while true; do",
    `  printf '${label} live output %05d\\n' \"$i\"`,
    "  i=$((i+1))",
    "  sleep 0.05",
    "done",
  ].join("; ");
}

function requireCreatedTaskId(value: string, label: string): string {
  if (/^[0-9a-f]{8}$/.test(value)) {
    return value;
  }
  throw new Error(`${label} task creation failed: ${value}`);
}

async function createStreamingTask(
  client: WebDriverClient,
  options: {
    repoId: string;
    repoPath: string;
    prompt: string;
  },
): Promise<PerfTask> {
  const setupCmd = buildStreamingSetupCommand(options.prompt);
  const taskId = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(
       ctx.createItem(${JSON.stringify(options.repoId)}, ${JSON.stringify(options.repoPath)}, ${JSON.stringify(options.prompt)}, "pty", {
         selectOnCreate: false,
         agentProvider: "claude",
         customTask: {
           executionMode: "pty",
           agentProvider: "claude",
           setup: [${JSON.stringify(setupCmd)}],
         },
       })
     ).then((id) => cb(id)).catch((error) => cb(String(error)));`,
  );
  return {
    id: requireCreatedTaskId(taskId, options.prompt),
    prompt: options.prompt,
  };
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
              : undefined)
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

async function selectTask(client: WebDriverClient, task: PerfTask): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(ctx.store.selectItem(${JSON.stringify(task.id)}))
       .then(() => cb("ok"))
       .catch((error) => cb("__error:" + (error?.message || String(error))));`,
  );
  if (result !== "ok") {
    throw new Error(`select task failed: ${result}`);
  }
  await client.waitForText(".pipeline-item.selected", task.prompt);
}

async function readMetrics(client: WebDriverClient): Promise<AppMetricsSnapshot> {
  const snapshot = await client.executeSync(
    `const metrics = window.__KANNA_E2E__?.appMetrics;
     if (!metrics) return { __error: "missing appMetrics" };
     return metrics.snapshot();`,
  );
  if (!snapshot || typeof snapshot !== "object" || "__error" in snapshot) {
    throw new Error(String((snapshot as { __error?: string } | null)?.__error ?? "invalid appMetrics snapshot"));
  }
  return snapshot as AppMetricsSnapshot;
}

async function waitForMetrics(
  client: WebDriverClient,
  predicate: (snapshot: AppMetricsSnapshot) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<AppMetricsSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let latest: AppMetricsSnapshot | null = null;
  while (Date.now() < deadline) {
    latest = await readMetrics(client);
    if (predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error(`timed out waiting for app metrics ${label}; latest=${JSON.stringify(latest)}`);
}

async function clearMetrics(client: WebDriverClient): Promise<void> {
  const result = await client.executeSync(
    `const metrics = window.__KANNA_E2E__?.appMetrics;
     if (!metrics) return "__error:missing appMetrics";
     metrics.clear();
     return "ok";`,
  );
  if (result !== "ok") {
    throw new Error(String(result));
  }
}

async function waitForTerminalBufferText(
  client: WebDriverClient,
  sessionId: string,
  text: string,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let latest: string[] = [];
  while (Date.now() < deadline) {
    latest = await client.executeSync<string[]>(
      `const hook = window.__KANNA_E2E__?.terminalBuffers;
       if (!hook) throw new Error("terminal buffer hook unavailable");
       return hook.lines(${JSON.stringify(sessionId)}).slice(-80);`,
    );
    if (latest.some((line) => line.includes(text))) return latest;
    await sleep(100);
  }
  throw new Error(`timed out waiting for terminal buffer text "${text}" in ${sessionId}; latest=${JSON.stringify(latest)}`);
}

describe("terminal output performance", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";
  let repoId = "";
  const taskIds: string[] = [];

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createSeedFixtureRepo("task-switch-minimal");
    testRepoPath = fixtureRepoRoot;
    repoId = await importTestRepo(client, testRepoPath, "terminal-output-perf");
  });

  afterAll(async () => {
    await Promise.all(
      taskIds.map((sessionId) =>
        tauriInvoke(client, "kill_session", { sessionId }).catch(() => null),
      ),
    );
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("does not poll daemon sessions or multiply terminal output listeners while warm PTY tasks stream", async () => {
    const tasks = await Promise.all([
      createStreamingTask(client, { repoId, repoPath: testRepoPath, prompt: "Output Perf A" }),
      createStreamingTask(client, { repoId, repoPath: testRepoPath, prompt: "Output Perf B" }),
      createStreamingTask(client, { repoId, repoPath: testRepoPath, prompt: "Output Perf C" }),
    ]);
    taskIds.push(...tasks.map((task) => task.id));

    await waitForSessions(client, taskIds);

    await selectTask(client, tasks[0]);
    await waitForTerminalBufferText(client, tasks[0].id, "Output Perf A live output");
    await selectTask(client, tasks[1]);
    await waitForTerminalBufferText(client, tasks[1].id, "Output Perf B live output");
    await selectTask(client, tasks[0]);
    await waitForTerminalBufferText(client, tasks[0].id, "Output Perf A live output");
    await selectTask(client, tasks[2]);
    await waitForTerminalBufferText(client, tasks[2].id, "Output Perf C live output");

    await clearMetrics(client);
    await sleep(1250);

    const snapshot = await readMetrics(client);

    expect(snapshot.invokeCounts.list_sessions ?? 0).toBe(0);
    expect(snapshot.activeListenCounts.terminal_output ?? 0).toBe(0);
    expect(snapshot.listenCounts.terminal_output ?? 0).toBe(0);
  });

  it("does not reinstall the retired terminal_output listener when the app window loses focus", async () => {
    const task = await createStreamingTask(client, {
      repoId,
      repoPath: testRepoPath,
      prompt: "Blur Keep",
    });
    taskIds.push(task.id);

    await waitForSessions(client, [task.id]);
    await selectTask(client, task);
    await client.waitForElement(".main-panel .terminal-container", 15_000);

    await waitForMetrics(
      client,
      (snapshot) => (snapshot.activeListenCounts.terminal_output ?? 0) === 0,
      "terminal_output listener remains retired after select",
    );

    await client.executeSync("window.dispatchEvent(new Event('blur'))");
    await sleep(500);

    const afterBlur = await readMetrics(client);
    expect(afterBlur.activeListenCounts.terminal_output ?? 0).toBe(0);

    await client.executeSync("window.dispatchEvent(new Event('focus'))");
    await sleep(250);

    const afterFocus = await readMetrics(client);
    expect(afterFocus.activeListenCounts.terminal_output ?? 0).toBe(0);
  });
});
