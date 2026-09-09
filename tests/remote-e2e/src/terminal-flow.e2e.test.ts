import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import { createRemoteTransport } from "../../../apps/mobile/src/lib/transports/remoteTransport";
import { startRemoteHarness, type RemoteHarness } from "./harness";
import {
  collectTerminalEvents,
  connectRawRelayClient,
  createScriptedTask,
  decodedOutput,
  expectNoRelayEvent,
  pinSingleStageWorkflow,
  readPipelineItem,
  registerLegacyNotifyTarget,
  taskInputCount,
  waitForRelayEvent,
  waitForTerminalOutput
} from "./terminalFlowTestUtils";

interface KspTestFrame extends Record<string, unknown> {
  type?: unknown;
  code?: unknown;
  task_id?: unknown;
}

interface TaskEvent {
  type?: string;
  payload?: Record<string, unknown>;
}

interface TaskEventFeed {
  cursor?: string;
  events?: TaskEvent[];
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function nextKspFrame(socket: WebSocket): Promise<KspTestFrame> {
  return await new Promise<KspTestFrame>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for KSP frame")),
      5_000,
    );
    socket.once("message", (data: RawData) => {
      clearTimeout(timeout);
      const parsed = JSON.parse(rawDataToString(data)) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        reject(new Error("KSP frame was not an object"));
        return;
      }
      resolve(parsed as KspTestFrame);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("remote task terminal flow E2E", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  async function currentRunId(taskId: string): Promise<string> {
    const detail = await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "GET",
      path: `/v1/tasks/${taskId}`,
      body: null,
    }) as { latestRun?: { id?: string } };
    const runId = detail.latestRun?.id;
    if (!runId) throw new Error(`task ${taskId} has no latest run id`);
    return runId;
  }

  async function waitForRuntimeState(
    taskId: string,
    expected: "busy" | "idle",
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let detail: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      detail = await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: `/v1/tasks/${taskId}`,
        body: null,
      }) as Record<string, unknown>;
      if (detail.runtimeState === expected) {
        return detail;
      }
      await sleep(100);
    }
    throw new Error(
      `task ${taskId} did not reach ${expected}; last detail: ${JSON.stringify(detail)}`,
    );
  }

  async function waitForTaskEvent(
    taskId: string,
    initialCursor: string,
    predicate: (event: TaskEvent) => boolean,
    timeoutMs = 20_000,
  ): Promise<TaskEvent> {
    const deadline = Date.now() + timeoutMs;
    let cursor = initialCursor;
    const observed: TaskEvent[] = [];
    while (Date.now() < deadline) {
      const feed = await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: `/v1/task-events?taskIds=${taskId}&localOnly=true&cursor=${encodeURIComponent(cursor)}&timeoutSecs=1`,
        body: null,
      }) as TaskEventFeed;
      observed.push(...(feed.events ?? []));
      const event = feed.events?.find(predicate);
      if (event) return event;
      if (feed.cursor) cursor = feed.cursor;
    }
    throw new Error(
      `task ${taskId} did not emit the expected event; observed: ${JSON.stringify(observed)}`,
    );
  }

  interface ManagerFeedResult {
    cursor: string;
    events: TaskEvent[];
    waitOutcome?: string;
  }

  async function readFeed(
    query: string,
    cursor: string | null,
    timeoutSecs: number,
  ): Promise<ManagerFeedResult> {
    const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const feed = await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "GET",
      path: `/v1/task-events?${query}&timeoutSecs=${timeoutSecs}${suffix}`,
      body: null,
    }) as TaskEventFeed & { waitOutcome?: string };
    return {
      cursor: feed.cursor ?? cursor ?? "",
      events: feed.events ?? [],
      waitOutcome: feed.waitOutcome,
    };
  }

  async function waitForFeedEvent(
    query: string,
    initialCursor: string,
    predicate: (event: TaskEvent) => boolean,
    timeoutMs: number,
  ): Promise<ManagerFeedResult> {
    const deadline = Date.now() + timeoutMs;
    let cursor = initialCursor;
    const observed: TaskEvent[] = [];
    while (Date.now() < deadline) {
      const feed = await readFeed(query, cursor, 2);
      observed.push(...feed.events);
      cursor = feed.cursor;
      if (feed.events.some(predicate)) {
        return { ...feed, cursor };
      }
    }
    throw new Error(
      `no matching event on ${query}; observed: ${JSON.stringify(observed)}`,
    );
  }

  async function invoke(
    method: "GET" | "POST",
    path: string,
    body: unknown = null,
  ): Promise<Record<string, unknown>> {
    return await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method,
      path,
      body,
    }) as Record<string, unknown>;
  }

  /**
   * The owner's rule, end to end: a task manager watches the daemon's runtime
   * dimension and the derived blocked state, and a human reading a task's
   * output — which moves only the display dimension — must not wake it.
   *
   * This deliberately drives the runtime verdicts through a real PTY and the
   * real daemon rather than writing `runtime_status` directly: the whole point
   * of the signal is that it is daemon truth.
   */
  it("wakes a runtime manager on every daemon runtime edge and on blocker changes, never on a read-state flip", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Runtime manager watch task",
      agentProvider: "claude",
    });
    await waitForRuntimeState(task.taskId, "idle");

    // What a manager asks for: the runtime dimension, without the human
    // read/unread dimension and without the deprecated settled alias.
    const managerWatch =
      `taskIds=${task.taskId}&localOnly=true&excludeEventTypes=` +
      encodeURIComponent("task.activity_changed,task.runtime_settled");
    const displayWatch = `taskIds=${task.taskId}&localOnly=true`;
    const runtimeEdge = (previous: string | null, next: string) =>
      (event: TaskEvent) =>
        event.type === "task.runtime_changed"
        && event.payload?.previousRuntimeState === previous
        && event.payload?.runtimeState === next;

    const armed = await readFeed(`${managerWatch}&from=now`, null, 0);
    let cursor = armed.cursor;
    expect(cursor).toEqual(expect.any(String));

    // busy — published immediately, because a turn shorter than the debounce
    // must not vanish. Its predecessor is whatever managers were last told,
    // which for a freshly spawned session is nothing: the task's first idle
    // never survived the debounce before work started.
    await invoke("POST", `/v1/tasks/${task.taskId}/input`, { input: "start-a-turn" });
    cursor = (await waitForFeedEvent(
      managerWatch,
      cursor,
      (event) =>
        event.type === "task.runtime_changed"
        && event.payload?.runtimeState === "busy",
      30_000,
    )).cursor;

    // idle — damped, so it arrives only after the fixed 10-second window.
    cursor = (await waitForFeedEvent(
      managerWatch,
      cursor,
      runtimeEdge("busy", "idle"),
      60_000,
    )).cursor;

    // A human opens the task. Only the display dimension moves.
    expect((await invoke("GET", `/v1/tasks/${task.taskId}`)).activity).toBe("unread");
    await invoke("POST", `/v1/tasks/${task.taskId}/actions/mark-read`, {});
    const quiet = await readFeed(managerWatch, cursor, 25);
    expect(quiet.waitOutcome).toBe("timeout");
    expect(quiet.events).toEqual([]);
    // Same cursor, no exclusions: exclusions are a filter, not a scope, so the
    // display edge was there the whole time — the manager simply never woke.
    const display = await readFeed(displayWatch, cursor, 5);
    expect(display.events.map((event) => event.type)).toContain("task.activity_changed");

    // waiting — a non-busy to non-busy edge, which the old busy-to-non-busy
    // signal could not express at all.
    await invoke("POST", `/v1/tasks/${task.taskId}/input`, { input: "ask-permission" });
    cursor = (await waitForFeedEvent(
      managerWatch,
      cursor,
      runtimeEdge("idle", "waiting"),
      60_000,
    )).cursor;

    // blocked / unblocked — derived state, published both when the task's own
    // blocker rows are rewritten and when the blocker resolves underneath it.
    const blocker = await invoke("POST", "/v1/tasks", {
      repoId: task.repoId,
      prompt: "Blocking prerequisite",
      displayName: "Runtime manager blocker",
      agentProvider: "claude",
      agentType: "pty",
    });
    const blockerTaskId = blocker.taskId as string;
    await invoke("POST", `/v1/tasks/${task.taskId}/actions/block`, {
      blockerTaskIds: [blockerTaskId],
    });
    const blocked = await waitForFeedEvent(
      managerWatch,
      cursor,
      (event) => event.type === "task.blocked",
      30_000,
    );
    expect(
      blocked.events.find((event) => event.type === "task.blocked")?.payload,
    ).toMatchObject({ blocked: true, blockerTaskIds: [blockerTaskId] });
    cursor = blocked.cursor;

    await invoke("POST", `/v1/tasks/${blockerTaskId}/actions/close`, {});
    const unblocked = await waitForFeedEvent(
      managerWatch,
      cursor,
      (event) => event.type === "task.unblocked",
      30_000,
    );
    expect(
      unblocked.events.find((event) => event.type === "task.unblocked")?.payload,
    ).toMatchObject({ blocked: false, blockerTaskIds: [] });
    cursor = unblocked.cursor;

    // exited — the session ends without being replaced.
    await invoke("POST", `/v1/tasks/${task.taskId}/input`, { input: "quit-now" });
    await waitForFeedEvent(
      managerWatch,
      cursor,
      runtimeEdge("waiting", "exited"),
      60_000,
    );
  }, 300_000);

  it("reports a Claude composer idle before and after daemon handoff", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Claude runtime handoff task",
      agentProvider: "claude",
    });

    await waitForRuntimeState(task.taskId, "idle");
    await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "POST",
      path: `/v1/tasks/${task.taskId}/input`,
      body: { input: "settle-idle" },
    });
    await waitForRuntimeState(task.taskId, "busy");
    const parked = await waitForRuntimeState(task.taskId, "idle");
    expect(parked.activity).toBe("unread");

    await harness.restartDaemon();
    expect((await waitForRuntimeState(task.taskId, "idle")).runtimeState).toBe("idle");
    const initial = await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "GET",
      path: `/v1/task-events?taskIds=${task.taskId}&localOnly=true&from=now&timeoutSecs=0`,
      body: null,
    }) as TaskEventFeed;
    expect(initial.cursor).toEqual(expect.any(String));

    await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "POST",
      path: `/v1/tasks/${task.taskId}/input`,
      body: { input: "rederive-after-handoff" },
    });
    await waitForRuntimeState(task.taskId, "busy");
    await waitForRuntimeState(task.taskId, "idle");

    const settled = await waitForTaskEvent(
      task.taskId,
      initial.cursor ?? "",
      (event) => event.type === "task.runtime_settled"
        && event.payload?.previousRuntimeState === "busy"
        && event.payload.runtimeState === "idle",
    );
    expect(settled.payload).toMatchObject({
      previousRuntimeState: "busy",
      runtimeState: "idle",
    });
  }, 90_000);

  it("streams snapshot, live output, and exit through observe_session and stops after unobserve", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Terminal streaming task"
    });
    const rawClient = await connectRawRelayClient(harness);

    try {
      rawClient.send({
        type: "invoke",
        id: "observe-stream",
        desktopId: harness.desktopId,
        command: "observe_session",
        args: { session_id: task.taskId }
      });
      await rawClient.waitFor((message) => message.type === "response" && message.id === "observe-stream");

      const snapshot = await waitForRelayEvent(rawClient, "terminal_snapshot", task.taskId);
      expect(snapshot.payload).toMatchObject({
        session_id: task.taskId
      });

      const liveOutput = await waitForRelayEvent(rawClient, "terminal_output", task.taskId, (payload) =>
        decodedOutput(payload).includes("SCRIPT_HEARTBEAT")
      );
      expect(decodedOutput(liveOutput.payload)).toContain("SCRIPT_HEARTBEAT");

      rawClient.send({
        type: "invoke",
        id: "unobserve-stream",
        desktopId: harness.desktopId,
        command: "unobserve_session",
        args: { session_id: task.taskId }
      });
      await rawClient.waitFor((message) => message.type === "response" && message.id === "unobserve-stream");

      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: "after-unobserve" }
      });
      await expectNoRelayEvent(rawClient, "terminal_output", task.taskId, (payload) =>
        decodedOutput(payload).includes("after-unobserve")
      );

      rawClient.send({
        type: "invoke",
        id: "observe-exit",
        desktopId: harness.desktopId,
        command: "observe_session",
        args: { session_id: task.taskId }
      });
      await rawClient.waitFor((message) => message.type === "response" && message.id === "observe-exit");
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: "exit-zero" }
      });

      const exit = await waitForRelayEvent(rawClient, "session_exit", task.taskId);
      expect(exit.payload).toMatchObject({
        session_id: task.taskId,
        code: 0
      });
    } finally {
      rawClient.close();
    }
  }, 45_000);

  it("shows repository setup commands and their live output in the mobile terminal stream", async () => {
    // The command text and its output are distinct strings so this proves the
    // terminal shows both the echoed `$ command` line and what it printed.
    const setupCommand = "echo setup-ran-$((6*7))";
    const setupOutput = "setup-ran-42";
    const task = await createScriptedTask(harness, {
      displayName: "Visible setup output task",
      setupCommands: [setupCommand]
    });
    // Attach immediately after the create response, exactly like the mobile
    // app does when it auto-connects to a freshly created task.
    const events = collectTerminalEvents(harness, task.taskId);

    try {
      const output = await waitForTerminalOutput(events, "SCRIPT_READY", 30_000);
      const bannerIndex = output.indexOf("Running startup...");
      const commandIndex = output.indexOf(`$ ${setupCommand}`);
      const outputIndex = output.indexOf(setupOutput, commandIndex + setupCommand.length + 2);
      const agentIndex = output.indexOf("SCRIPT_READY");
      expect(bannerIndex).toBeGreaterThanOrEqual(0);
      expect(commandIndex).toBeGreaterThan(bannerIndex);
      expect(outputIndex).toBeGreaterThan(commandIndex);
      expect(agentIndex).toBeGreaterThan(outputIndex);
    } finally {
      events.close();
    }

    // A client that attaches after setup finished (app reopened mid-task)
    // must still see the setup scrollback in the hydration snapshot.
    const lateEvents = collectTerminalEvents(harness, task.taskId);
    try {
      const snapshot = await lateEvents.waitForSnapshot({
        minEncodedChars: 0,
        sentinel: setupOutput
      });
      const decoded = Buffer.from(snapshot.dataB64, "base64").toString("utf8");
      expect(decoded).toContain("Running startup...");
      expect(decoded).toContain(`$ ${setupCommand}`);
    } finally {
      lateEvents.close();
    }
  }, 60_000);

  it("sends remote input to the agent PTY and rejects input after exit", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Terminal input task"
    });
    const events = collectTerminalEvents(harness, task.taskId);

    try {
      await waitForTerminalOutput(events, "SCRIPT_READY");
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: "hello from remote" }
      });
      await waitForTerminalOutput(events, "SCRIPT_INPUT:hello from remote");

      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: "exit-zero" }
      });
      await events.waitForExit(0);

      await expect(harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: "too late" }
      })).rejects.toThrow(/daemon|session|not found|failed/i);
    } finally {
      events.close();
    }
  }, 45_000);

  /**
   * The lines the scripted agent actually read from its stdin, NUL-delimited by
   * the agent itself.
   *
   * Rendered terminal output cannot settle a truncation question: it is what the
   * emulator drew, wrapped and repainted. This file is what the process on the
   * far side of the PTY received.
   */
  async function readInputTrace(
    worktreePath: string | null,
    traceFile: string,
    expected: number,
    timeoutMs = 20_000,
  ): Promise<string[]> {
    if (!worktreePath) throw new Error("scripted task has no worktree path");
    const path = join(worktreePath, traceFile);
    const deadline = Date.now() + timeoutMs;
    let received: string[] = [];
    while (Date.now() < deadline) {
      const raw = await readFile(path, "utf8").catch(() => "");
      received = raw.split("\0").slice(0, -1);
      if (received.length >= expected) return received;
      await sleep(100);
    }
    throw new Error(
      `scripted agent received ${received.length} of ${expected} inputs: ${JSON.stringify(received)}`,
    );
  }

  /**
   * The incident of 2026-09-06: a 1,047-byte single-line manager message was
   * accepted, recorded whole in the durable input ledger and answered `ok`,
   * while the recipient received only its last 25 bytes.
   *
   * A macOS PTY master accepts about a kilobyte per write, so a message this
   * long reaches the agent as more than one input event however the daemon
   * issues it. The daemon frames it as one bracketed paste, and that framing is
   * what has to survive the whole delivery path — MCP/HTTP, the server, the
   * daemon writer, the PTY — for the agent to read one message rather than a
   * sentence-shaped fragment.
   */
  it("delivers a long single-line logical message whole and submits it exactly once", async () => {
    const traceFile = ".kanna-e2e-inputs";
    const task = await createScriptedTask(harness, {
      displayName: "Long logical input task",
      terminalPasteSemantics: true,
      inputTraceFile: traceFile,
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const message = `HEAD ${"x".repeat(1017)}and this is the tail only`;
    expect(message).toHaveLength(1047);

    try {
      await waitForTerminalOutput(events, "SCRIPT_INPUT_READY");
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: message },
      });

      const received = await readInputTrace(task.worktreePath, traceFile, 1);
      expect(received).toEqual([message]);

      // Exactly once: nothing arrives behind it, and no fragment of it is
      // submitted as a second message.
      await sleep(500);
      expect(await readInputTrace(task.worktreePath, traceFile, 1)).toEqual([message]);
      expect(await taskInputCount(harness, task.taskId)).toBe(1);
    } finally {
      events.close();
    }
  }, 60_000);

  it("submits a multiline logical message as one bracketed terminal paste", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Multiline logical input task",
      terminalPasteSemantics: true,
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const postPrompt =
      "Commit the relevant work for this task.\n\nPrevious implementation result:";

    try {
      await waitForTerminalOutput(events, "SCRIPT_INPUT_READY");
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: postPrompt },
      });

      const output = await waitForTerminalOutput(
        events,
        "Previous implementation result:",
      );
      expect(output.replaceAll("\r", "")).toContain(`SCRIPT_INPUT:${postPrompt}\n`);
      expect(output.match(/SCRIPT_INPUT:/g)).toHaveLength(1);
    } finally {
      events.close();
    }
  }, 45_000);

  it("delivers a logical task message over a simultaneous partial raw draft", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Raw draft and manager input collision",
      tracePartialInput: true,
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const humanDraft = "human draft in progress";
    const managerMessage = "manager message stays separate";

    try {
      await waitForTerminalOutput(events, "SCRIPT_INPUT_READY");
      events.sendInput(Buffer.from(humanDraft).toString("base64"));
      await waitForTerminalOutput(events, `SCRIPT_PARTIAL:${humanDraft}`);

      // The owner's 2026-09-08 directive: a human's unsent line is a collision
      // the message lands after, never a reason to hold it. Nothing is queued,
      // and the caller is told plainly that it was delivered.
      const delivered = await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: managerMessage }
      });
      expect(delivered).toBeUndefined();

      // The message carries its own submission boundary, so the line the
      // script reads is the human's draft with the message appended.
      const output = await waitForTerminalOutput(
        events,
        `SCRIPT_INPUT:${humanDraft}${managerMessage}`,
      );
      expect(output).toContain(`SCRIPT_INPUT:${humanDraft}${managerMessage}`);

      // Delivered means recorded: a later stage reads this ledger, not the
      // terminal, and a collision must not cost the record.
      const inputs = (await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: `/v1/tasks/${task.taskId}/inputs`,
        body: null,
      })) as { inputs: Array<{ message: string }> };
      expect(inputs.inputs.at(-1)?.message).toBe(managerMessage);

      // And nothing anywhere reports a hold: the fields that carried one are
      // gone from task detail entirely.
      const detail = (await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: `/v1/tasks/${task.taskId}`,
        body: null,
      })) as Record<string, unknown>;
      expect(detail).not.toHaveProperty("inputBlocked");
      expect(detail).not.toHaveProperty("queuedInputCount");
      expect(detail).not.toHaveProperty("queuedInputReason");
      expect(detail.deliveredInputCount).toBeGreaterThan(0);
    } finally {
      events.close();
    }
  }, 45_000);

  /**
   * The failure the owner reported three times on 0.3.0-staging.12: a message
   * sent to an agent that was mid-turn had its Enter withheld because the
   * terminal never settled, sat unsent at the composer, and ten seconds later
   * locked the session against every later message.
   *
   * The scripted agent emits a heartbeat continuously, so this session's
   * terminal is never quiet. The message must still be written with its
   * submission boundary, promptly, and be recorded.
   */
  it("delivers a logical message into a continuously streaming session", async () => {
    const traceFile = ".kanna-e2e-streaming-inputs";
    const task = await createScriptedTask(harness, {
      displayName: "Streaming session input task",
      inputTraceFile: traceFile,
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const managerMessage = "answer the consultation question";

    try {
      await waitForTerminalOutput(events, "SCRIPT_INPUT_READY");
      // The heartbeat is what makes this terminal never settle.
      await waitForTerminalOutput(events, "SCRIPT_HEARTBEAT");

      const startedAt = Date.now();
      const delivered = await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: managerMessage, source: "operator" }
      });
      expect(delivered).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      // The agent's own read of its stdin is the proof its Enter was written:
      // the trace file only gains a line when the script's `read` returns.
      const received = await readInputTrace(task.worktreePath, traceFile, 1);
      expect(received).toContain(managerMessage);

      const inputs = (await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: `/v1/tasks/${task.taskId}/inputs`,
        body: null,
      })) as { inputs: Array<{ message: string; source: string }> };
      expect(inputs.inputs.at(-1)).toMatchObject({
        message: managerMessage,
        source: "operator",
      });
    } finally {
      events.close();
    }
  }, 45_000);

  it("rejects no-capability terminal drafts before logical input can be stranded", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Legacy KSP terminal boundary refusal",
      tracePartialInput: true,
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const socket = await openWebSocket(
      `${harness.lanBaseUrl.replace(/^http/, "ws")}/v1/stream`,
    );
    const rejectedDraft = "legacy client draft must be rejected";
    const managerMessage = "manager message must not be stranded";

    try {
      await waitForTerminalOutput(events, "SCRIPT_INPUT_READY");
      const authReply = nextKspFrame(socket);
      socket.send(JSON.stringify({ type: "auth", capabilities: [] }));
      expect(await authReply).toMatchObject({ type: "auth_ok" });

      const inputReply = nextKspFrame(socket);
      socket.send(JSON.stringify({
        type: "term_input",
        task_id: task.taskId,
        data_b64: Buffer.from(rejectedDraft).toString("base64"),
      }));
      expect(await inputReply).toMatchObject({
        type: "error",
        task_id: task.taskId,
        code: "term_input_boundary_required",
      });

      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: managerMessage },
      });
      const output = await waitForTerminalOutput(
        events,
        `SCRIPT_INPUT:${managerMessage}`,
      );
      expect(output).not.toContain(`SCRIPT_PARTIAL:${rejectedDraft}`);
      expect(output).not.toContain(`SCRIPT_INPUT:${rejectedDraft}`);
    } finally {
      socket.close();
      events.close();
    }
  }, 45_000);

  it("delivers a logical message over a multiline bracketed-paste continuation", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Multiline paste and manager input collision",
      tracePartialInput: true,
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const firstDraft = "human draft";
    const pasteContinuation = " continued\nsecond pasted line";
    const managerMessage = "manager message after multiline paste";

    try {
      await waitForTerminalOutput(events, "SCRIPT_INPUT_READY");
      events.sendInput(Buffer.from(firstDraft).toString("base64"));
      await waitForTerminalOutput(events, `SCRIPT_PARTIAL:${firstDraft}`);

      const bracketedPaste = `\u001b[200~${pasteContinuation}\u001b[201~`;
      events.sendInput(Buffer.from(bracketedPaste).toString("base64"));
      await waitForTerminalOutput(events, "second pasted line");

      const delivered = await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: managerMessage }
      });
      expect(delivered).toBeUndefined();

      // The paste's embedded newline is composer content rather than a
      // submission, so the pasted lines and the delivered message reach the
      // script together — the accepted collision, not a lost message.
      const output = await waitForTerminalOutput(
        events,
        `SCRIPT_INPUT:${managerMessage}`,
      );
      expect(output.replaceAll("\r", "")).toContain(managerMessage);
    } finally {
      events.close();
    }
  }, 45_000);

  it("selects menu option 1 through the mobile relay transport before its delayed Enter", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Mobile menu input task"
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [],
      getSelectedDesktopId: () => harness.desktopId,
      invokeDesktop: (request) => harness.client.invokeDesktop(request)
    });

    try {
      await waitForTerminalOutput(events, "SCRIPT_MENU_CURSOR:2");

      // This is the same KannaTransport call used by the mobile composer in
      // remote mode. The scripted PTY only emits SELECTED after receiving the
      // delayed CR, so raw terminal input of just "1" cannot pass this test.
      await transport.sendTaskInput(task.taskId, "1");
      const output = await waitForTerminalOutput(events, "SCRIPT_MENU_SELECTED:1");

      const cursor = output.indexOf("SCRIPT_MENU_CURSOR:2");
      const highlighted = output.indexOf("SCRIPT_MENU_OPTION_1_HIGHLIGHTED");
      const selected = output.indexOf("SCRIPT_MENU_SELECTED:1");
      expect(cursor).toBeGreaterThanOrEqual(0);
      expect(highlighted).toBeGreaterThan(cursor);
      expect(selected).toBeGreaterThan(highlighted);
    } finally {
      events.close();
    }
  }, 45_000);

  it("observes child completion through events without injecting a legacy notify target", async () => {
    const parent = await createScriptedTask(harness, {
      displayName: "Parent notification target"
    });
    const parentEvents = collectTerminalEvents(harness, parent.taskId);
    const child = await createScriptedTask(harness, {
      displayName: "Child completion source"
    });
    await registerLegacyNotifyTarget(harness, child.taskId, parent.taskId);
    const childEvents = collectTerminalEvents(harness, child.taskId);

    try {
      await waitForTerminalOutput(parentEvents, "SCRIPT_READY");
      await waitForTerminalOutput(childEvents, "SCRIPT_READY");
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${child.taskId}/input`,
        body: { input: "exit-zero" }
      });

      await childEvents.waitForExit(0);
      const childRow = await readPipelineItem(harness, child.taskId);
      expect(childRow.activity).toBe("unread");
      expect(childRow.notified_at).toBeNull();
      expect(await taskInputCount(harness, parent.taskId)).toBe(0);
      expect(parentEvents.outputText()).not.toContain(`TASK ${child.taskId} DONE`);

      const waited = await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: `/v1/task-events?taskIds=${child.taskId}&timeoutSecs=0`,
        body: null
      }) as { events?: Array<{ type?: string; payload?: { result?: string } }> };
      const finished = waited.events?.find((event) => event.type === "run.finished");
      expect(finished).toBeDefined();
      expect(JSON.parse(finished?.payload?.result ?? "{}")).toMatchObject({ status: "success" });
    } finally {
      parentEvents.close();
      childEvents.close();
    }
  }, 45_000);

  it("recovers invokes and active terminal observation after relay reconnect", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Relay resilience task"
    });
    const events = collectTerminalEvents(harness, task.taskId);

    try {
      await waitForTerminalOutput(events, "SCRIPT_HEARTBEAT");
      await harness.stopRelay();
      await expect(harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: "/v1/status",
        body: null
      })).rejects.toThrow(/relay|closed|offline|failed/i);

      await harness.startRelay();
      await expect(harness.waitForDesktop()).resolves.toBeUndefined();

      const status = await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: "/v1/status",
        body: null
      });
      expect(status).toMatchObject({
        desktopId: harness.desktopId,
        version: "remote-e2e",
        environment: "development",
        serverVersion: "remote-e2e"
      });

      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: "reconnected-marker" }
      });
      await waitForTerminalOutput(events, "SCRIPT_INPUT:reconnected-marker");
    } finally {
      events.close();
    }
  }, 60_000);
});
