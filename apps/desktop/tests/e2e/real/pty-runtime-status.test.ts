import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { resolveAppKannaServer } from "../helpers/kannaServer";
import { appendE2ePerfSummaryLine } from "../helpers/perfOutput";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { WebDriverClient } from "../helpers/webdriver";
import { callVueMethod, execDb, getVueState, tauriInvoke } from "../helpers/vue";

const execFileAsync = promisify(execFile);

interface TaskDimensions {
  activity?: string | null;
  runtimeState?: string | null;
  readState?: string | null;
}

async function fetchTaskDetail(baseUrl: string, taskId: string): Promise<TaskDimensions> {
  const response = await fetch(`${baseUrl}/v1/tasks/${taskId}`);
  if (!response.ok) {
    throw new Error(`GET /v1/tasks/${taskId} failed with ${response.status}`);
  }
  return await response.json() as TaskDimensions;
}

async function postRuntimeStatus(
  baseUrl: string,
  taskId: string,
  status: "busy" | "idle",
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/tasks/${taskId}/actions/runtime-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, selected: false }),
  });
  if (!response.ok) {
    throw new Error(`runtime-status ${status} failed with ${response.status}`);
  }
}

async function waitForRuntimeState(
  baseUrl: string,
  taskId: string,
  runtimeState: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: TaskDimensions | null = null;
  while (Date.now() < deadline) {
    latest = await fetchTaskDetail(baseUrl, taskId);
    if (latest.runtimeState === runtimeState) return;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for ${taskId} runtimeState=${runtimeState}; latest=${JSON.stringify(latest)}`,
  );
}

const falseCodexFixture = fileURLToPath(
  new URL("../fixtures/false-codex-runtime-status.sh", import.meta.url),
);

async function invokeOrThrow(
  client: WebDriverClient,
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await tauriInvoke(client, command, args);
  if (result && typeof result === "object" && "__error" in result) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
  return result;
}

async function selectTaskAndWait(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await getVueState(client, "currentItem") as { id?: string } | null;
    if (current?.id === taskId) return;
    await callVueMethod(client, "store.selectItem", taskId);
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected task ${taskId}`);
}

async function waitForActivity(
  client: WebDriverClient,
  taskId: string,
  activity: "idle" | "working" | "unread",
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    const items = await getVueState(client, "items") as Array<{
      id?: string;
      activity?: string;
    }> | null;
    latest = items?.find((item) => item.id === taskId) ?? null;
    if ((latest as { activity?: string } | null)?.activity === activity) return;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for ${taskId} activity=${activity}; latest=${JSON.stringify(latest)}`,
  );
}

async function waitForUnselectedSidebarActivity(
  client: WebDriverClient,
  taskId: string,
  activity: "working" | "unread",
  timeoutMs = 10_000,
): Promise<void> {
  const expectedFontStyle = activity === "working" ? "italic" : "normal";
  const expectedFontWeight = activity === "unread" ? "bold" : "normal";
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await client.executeSync<{
      selected: boolean;
      fontStyle: string;
      fontWeight: string;
    } | null>(`
      const row = document.querySelector(
        '.workflow-item[data-task-id=' + ${JSON.stringify(JSON.stringify(taskId))} + ']'
      );
      const title = row?.querySelector('.item-title');
      return row && title ? {
        selected: row.classList.contains('selected'),
        fontStyle: title.style.fontStyle,
        fontWeight: title.style.fontWeight,
      } : null;
    `);
    if (
      latest
      && latest.selected === false
      && latest.fontStyle === expectedFontStyle
      && latest.fontWeight === expectedFontWeight
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for unselected sidebar ${taskId} activity=${activity}; latest=${JSON.stringify(latest)}`,
  );
}

async function waitForTerminalRegistration(
  client: WebDriverClient,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const registered = await client.executeSync<boolean>(
      `return window.__KANNA_E2E__?.terminalBuffers?.sessionIds?.()
        .includes(${JSON.stringify(sessionId)}) ?? false;`,
    );
    if (registered) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for terminal registration ${sessionId}`);
}

async function startFalseAgent(client: WebDriverClient, sessionId: string): Promise<void> {
  await invokeOrThrow(client, "send_input", {
    sessionId,
    data: [10],
  });
}

async function waitForDaemonStatus(
  client: WebDriverClient,
  sessionId: string,
  status: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    const sessions = await invokeOrThrow(client, "list_sessions") as Array<{
      session_id?: string;
      status?: string;
    }>;
    latest = sessions.find((session) => session.session_id === sessionId) ?? null;
    if ((latest as { status?: string } | null)?.status === status) return;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for ${sessionId} daemon status=${status}; latest=${JSON.stringify(latest)}`,
  );
}

describe("PTY runtime status over KSP", () => {
  const client = new WebDriverClient();
  const sessionIds: string[] = [];
  let repoId = "";
  let repoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();

    repoPath = await createFixtureRepo("pty-runtime-status");
    repoId = await importTestRepo(client, repoPath, "pty-runtime-status");
  });

  afterAll(async () => {
    for (const sessionId of sessionIds) {
      await invokeOrThrow(client, "kill_session", { sessionId }).catch(() => undefined);
    }
    if (repoPath) {
      await cleanupWorktrees(client, repoPath);
      await cleanupFixtureRepos([repoPath]);
    }
    await client.deleteSession();
  });

  async function createFalseAgentTask(prompt: string): Promise<string> {
    const sessionId = `pty-status-${randomUUID()}`;
    sessionIds.push(sessionId);
    await execDb(
      client,
      `INSERT INTO pipeline_item
        (id, repo_id, prompt, stage, branch, agent_type, agent_provider, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, repoId, prompt, "in progress", sessionId, "pty", "codex", "idle"],
    );
    expect((await waitForTaskCreated(client, prompt)).agent_provider).toBe("codex");
    await invokeOrThrow(client, "spawn_session", {
      sessionId,
      cwd: repoPath,
      executable: falseCodexFixture,
      args: [],
      env: {
        TERM: "xterm-256color",
        KANNA_FALSE_AGENT_PHASE_DELAY_SECONDS: "2",
      },
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });
    // The fixture's startup prompt is itself terminal output. Wait beyond the
    // daemon's 500ms status-detection throttle before triggering the busy phase.
    await sleep(750);
    return sessionId;
  }

  it("delivers attached live busy-to-idle status without reattaching", async () => {
    const selectedTaskId = await createFalseAgentTask("Selected false Codex runtime status");
    await callVueMethod(client, "loadItems", repoId);
    await selectTaskAndWait(client, selectedTaskId);
    await waitForTerminalRegistration(client, selectedTaskId);
    await startFalseAgent(client, selectedTaskId);

    await waitForActivity(client, selectedTaskId, "working");
    await waitForDaemonStatus(client, selectedTaskId, "waiting");
    await waitForActivity(client, selectedTaskId, "idle");
    await waitForDaemonStatus(client, selectedTaskId, "idle");
    expect(await client.executeSync<boolean>(
      `return window.__KANNA_E2E__?.terminalBuffers?.sessionIds?.()
        .includes(${JSON.stringify(selectedTaskId)}) ?? false;`,
    )).toBe(true);

    const otherTaskId = `other-task-${randomUUID()}`;
    await execDb(
      client,
      `INSERT INTO pipeline_item
        (id, repo_id, prompt, stage, branch, agent_type, agent_provider, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [otherTaskId, repoId, "Selected while false agent finishes", "in progress", otherTaskId, "agent", "codex", "idle"],
    );
    await waitForTaskCreated(client, "Selected while false agent finishes");
    await callVueMethod(client, "loadItems", repoId);
    await selectTaskAndWait(client, otherTaskId);

    const unselectedTaskId = await createFalseAgentTask("Unselected false Codex runtime status");
    expect((await getVueState(client, "currentItem") as { id?: string } | null)?.id).toBe(otherTaskId);
    expect(await client.executeSync<boolean>(
      `return window.__KANNA_E2E__?.terminalBuffers?.sessionIds?.()
        .includes(${JSON.stringify(unselectedTaskId)}) ?? false;`,
    )).toBe(false);
    await startFalseAgent(client, unselectedTaskId);

    await waitForDaemonStatus(client, unselectedTaskId, "busy");
    await waitForActivity(client, unselectedTaskId, "working");
    await waitForUnselectedSidebarActivity(client, unselectedTaskId, "working");
    await waitForActivity(client, unselectedTaskId, "unread");
    await waitForUnselectedSidebarActivity(client, unselectedTaskId, "unread");
    await waitForDaemonStatus(client, unselectedTaskId, "idle");

    // The task began and finished before its terminal ever mounted. Its first
    // attach queues the current idle status and repairs watcher unread.
    await selectTaskAndWait(client, unselectedTaskId);
    await waitForTerminalRegistration(client, unselectedTaskId);
    await waitForActivity(client, unselectedTaskId, "idle");
  }, 45_000);

  // The reported defect, end to end through the real daemon: a task whose
  // agent is running while its latest output is unread reads identically to a
  // finished one through `activity`. The runtime dimension is what tells them
  // apart, and it is what a wait for the task to finish must key on.
  it("reports a running agent as busy while its output is unread, and does not finish a wait", async () => {
    const baseUrl = (await resolveAppKannaServer(client)).baseUrl;
    const kannaCliPath = await tauriInvoke(client, "which_binary", { name: "kanna-cli" });
    if (typeof kannaCliPath !== "string" || kannaCliPath.length === 0) {
      throw new Error(`unexpected kanna-cli path: ${JSON.stringify(kannaCliPath)}`);
    }

    const busyTaskId = await createFalseAgentTask("Busy false Codex with unread output");
    await callVueMethod(client, "loadItems", repoId);
    await startFalseAgent(client, busyTaskId);
    await waitForDaemonStatus(client, busyTaskId, "busy");
    await waitForRuntimeState(baseUrl, busyTaskId, "busy");

    // Several server writes flag output unread without consulting the runtime
    // dimension — a parked revision, an orphaned workspace, a cross-machine
    // transfer. Any of them leaves a working agent displaying `unread`.
    await execDb(
      client,
      "UPDATE pipeline_item SET activity = 'unread' WHERE id = ?",
      [busyTaskId],
    );

    const detail = await fetchTaskDetail(baseUrl, busyTaskId);
    expect(detail.activity).toBe("unread");
    expect(detail.readState).toBe("unread");
    expect(detail.runtimeState).toBe("busy");

    // The wait a fan-out owner blocks on runs through the shared predicate in
    // kanna-tool-catalog, so driving the real CLI proves the whole path.
    const { stdout } = await execFileAsync(kannaCliPath, [
      "task",
      "wait",
      "--task-id",
      busyTaskId,
      "--until",
      "finished",
      "--timeout-secs",
      "3",
      "--poll-secs",
      "1",
      "--server-url",
      baseUrl,
    ]);
    const waited = JSON.parse(stdout) as { waitOutcome?: string };
    expect(waited.waitOutcome).toBe("timeout");
  }, 60_000);

  it("applies a burst of task status changes without snapshot fetches or sidebar replacement", async () => {
    const baseUrl = (await resolveAppKannaServer(client)).baseUrl;
    const burstTaskId = `status-burst-${randomUUID()}`;
    const loadPrefix = `status-load-${randomUUID()}-`;
    await execDb(
      client,
      `WITH RECURSIVE task_number(value) AS (
         VALUES(1)
         UNION ALL
         SELECT value + 1 FROM task_number WHERE value < 500
       )
       INSERT INTO pipeline_item
         (id, repo_id, prompt, stage, branch, agent_type, agent_provider, activity)
       SELECT ? || value, ?, 'Scoped status load ' || value, 'in progress',
              ? || value, 'agent', 'codex', 'idle'
         FROM task_number`,
      [loadPrefix, repoId, loadPrefix],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item
        (id, repo_id, prompt, stage, branch, agent_type, agent_provider, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [burstTaskId, repoId, "Scoped status burst", "in progress", burstTaskId, "agent", "codex", "idle"],
    );
    // This file deliberately reloads the WebView in its setup. Close that
    // context's KSP socket before a second reload so only the newly mounted
    // store observes the measured frames.
    await client.executeSync("window.__KANNA_E2E__?.resetStreamClient?.();");
    await client.executeSync("window.__KANNA_E2E__.ready = false; location.reload();");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    await callVueMethod(client, "loadItems", repoId);
    // Let the new connection's mandatory catch-up snapshot settle before
    // measuring only the subsequent status burst. At this load the debug
    // build's refresh can take just over one second on a contended host.
    await sleep(2_000);
    const beforeOrder = await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll('.workflow-item[data-task-id]'))
        .map((row) => row.getAttribute('data-task-id') || '');`,
    );

    await client.executeSync(`
      const metrics = {
        snapshotFetches: 0,
        longTasks: 0,
        maxHeartbeatGapMs: 0,
        originalFetch: window.fetch.bind(window),
        observer: null,
        timer: null,
        lastHeartbeat: performance.now(),
      };
      window.__KANNA_SCOPED_STATE_METRICS__ = metrics;
      window.fetch = async (...args) => {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (url.includes('/v1/snapshot')) metrics.snapshotFetches += 1;
        return metrics.originalFetch(...args);
      };
      if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        metrics.observer = new PerformanceObserver((list) => {
          metrics.longTasks += list.getEntries().length;
        });
        metrics.observer.observe({ type: 'longtask' });
      }
      metrics.timer = setInterval(() => {
        const now = performance.now();
        const gap = now - metrics.lastHeartbeat;
        metrics.maxHeartbeatGapMs = Math.max(
          metrics.maxHeartbeatGapMs,
          gap,
        );
        if (!metrics.observer && gap > 60) metrics.longTasks += 1;
        metrics.lastHeartbeat = now;
      }, 10);
    `);

    try {
      // Measure the exact work the old StateChanged handler performed for the
      // same event count before resetting the counters for the scoped path.
      for (let index = 0; index < 20; index += 1) {
        await callVueMethod(client, "store.reloadSnapshot");
      }
      await sleep(250);
      const baseline = await client.executeSync<{
        snapshotFetches: number;
        longTasks: number;
        maxHeartbeatGapMs: number;
        longTaskSupported: boolean;
        visibilityState: string;
      }>(`
        const metrics = window.__KANNA_SCOPED_STATE_METRICS__;
        return {
          snapshotFetches: metrics.snapshotFetches,
          longTasks: metrics.longTasks,
          maxHeartbeatGapMs: metrics.maxHeartbeatGapMs,
          longTaskSupported: Boolean(metrics.observer),
          visibilityState: document.visibilityState,
        };
      `);
      await appendE2ePerfSummaryLine([
        "[e2e][snapshot-baseline]",
        `snapshotFetches=${baseline.snapshotFetches}`,
        `longTasks=${baseline.longTasks}`,
        `observer=${baseline.longTaskSupported ? "performance" : "heartbeat"}`,
        `maxHeartbeatGapMs=${baseline.maxHeartbeatGapMs.toFixed(1)}`,
        `visibility=${baseline.visibilityState}`,
        `items=${beforeOrder.length}`,
        "reloads=20",
      ].join(" "));
      expect(baseline.snapshotFetches).toBeGreaterThanOrEqual(20);
      await client.executeSync(`
        const metrics = window.__KANNA_SCOPED_STATE_METRICS__;
        metrics.snapshotFetches = 0;
        metrics.longTasks = 0;
        metrics.maxHeartbeatGapMs = 0;
        metrics.lastHeartbeat = performance.now();
      `);

      for (let index = 0; index < 20; index += 1) {
        await postRuntimeStatus(baseUrl, burstTaskId, index % 2 === 0 ? "busy" : "idle");
      }
      await waitForActivity(client, burstTaskId, "unread");
      await waitForUnselectedSidebarActivity(client, burstTaskId, "unread");
      await sleep(250);

      const measurement = await client.executeSync<{
        snapshotFetches: number;
        longTasks: number;
        maxHeartbeatGapMs: number;
        longTaskSupported: boolean;
        visibilityState: string;
      }>(`
        const metrics = window.__KANNA_SCOPED_STATE_METRICS__;
        return {
          snapshotFetches: metrics.snapshotFetches,
          longTasks: metrics.longTasks,
          maxHeartbeatGapMs: metrics.maxHeartbeatGapMs,
          longTaskSupported: Boolean(metrics.observer),
          visibilityState: document.visibilityState,
        };
      `);
      const afterOrder = await client.executeSync<string[]>(
        `return Array.from(document.querySelectorAll('.workflow-item[data-task-id]'))
          .map((row) => row.getAttribute('data-task-id') || '');`,
      );

      await appendE2ePerfSummaryLine([
        "[e2e][scoped-state]",
        `snapshotFetches=${measurement.snapshotFetches}`,
        `longTasks=${measurement.longTasks}`,
        `observer=${measurement.longTaskSupported ? "performance" : "heartbeat"}`,
        `maxHeartbeatGapMs=${measurement.maxHeartbeatGapMs.toFixed(1)}`,
        `visibility=${measurement.visibilityState}`,
        `items=${beforeOrder.length}`,
        "statusChanges=20",
      ].join(" "));
      expect(measurement.snapshotFetches).toBe(0);
      expect(afterOrder).toEqual(beforeOrder);
    } finally {
      await client.executeSync(`
        const metrics = window.__KANNA_SCOPED_STATE_METRICS__;
        if (metrics) {
          window.fetch = metrics.originalFetch;
          if (metrics.timer !== null) clearInterval(metrics.timer);
          metrics.observer?.disconnect();
          delete window.__KANNA_SCOPED_STATE_METRICS__;
        }
      `);
      await execDb(
        client,
        "DELETE FROM pipeline_item WHERE id = ? OR id LIKE ?",
        [burstTaskId, `${loadPrefix}%`],
      );
    }
  }, 60_000);

  it("replays current idle status after a dropped stream reconnects", async () => {
    const reconnectTaskId = await createFalseAgentTask("Reconnect false Codex runtime status");
    const otherTaskId = `reconnect-other-${randomUUID()}`;
    await execDb(
      client,
      `INSERT INTO pipeline_item
        (id, repo_id, prompt, stage, branch, agent_type, agent_provider, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [otherTaskId, repoId, "Reconnect gap other task", "in progress", otherTaskId, "agent", "codex", "idle"],
    );
    await waitForTaskCreated(client, "Reconnect gap other task");
    await callVueMethod(client, "loadItems", repoId);
    await selectTaskAndWait(client, reconnectTaskId);
    await waitForTerminalRegistration(client, reconnectTaskId);
    await startFalseAgent(client, reconnectTaskId);
    await waitForDaemonStatus(client, reconnectTaskId, "busy");
    await waitForActivity(client, reconnectTaskId, "working");

    // Explicitly detach the terminal stream, then close the shared KSP socket.
    // The server awaits attachment-task cancellation before handling the next
    // frame. The false agent then finishes while no terminal stream can carry
    // its idle status to the selected client.
    await client.executeSync(
      `return window.__KANNA_E2E__.terminalStreams.detach(${JSON.stringify(reconnectTaskId)});`,
    );
    await client.executeSync("window.__KANNA_E2E__.resetStreamClient?.();");
    await selectTaskAndWait(client, otherTaskId);
    await waitForDaemonStatus(client, reconnectTaskId, "idle");

    // Reloading constructs a fresh KSP client after the dropped socket.
    // AttachSnapshot's queued StatusChanged(Idle) is replayed with
    // selected=true and repairs either a missed working state or a
    // conservative watcher unread state.
    await client.executeSync(
      "window.__KANNA_E2E__.ready = false; location.reload();",
    );
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    await callVueMethod(client, "loadItems", repoId);
    await selectTaskAndWait(client, reconnectTaskId);
    await waitForTerminalRegistration(client, reconnectTaskId);
    await waitForActivity(client, reconnectTaskId, "idle");
  }, 45_000);
});
