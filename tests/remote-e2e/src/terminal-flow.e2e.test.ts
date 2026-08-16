import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { createRemoteTransport } from "../../../apps/mobile/src/lib/transports/remoteTransport";
import { startRemoteHarness, type RemoteHarness } from "./harness";
import {
  collectTerminalEvents,
  connectRawRelayClient,
  createScriptedTask,
  decodedOutput,
  expectNoRelayEvent,
  pinSingleStagePipeline,
  readPipelineItem,
  waitForRelayEvent,
  waitForTerminalOutput
} from "./terminalFlowTestUtils";

interface KspTestFrame extends Record<string, unknown> {
  type?: unknown;
  code?: unknown;
  task_id?: unknown;
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

  it("keeps a partial raw draft separate from a simultaneous logical task message", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Raw draft and manager input isolation",
      tracePartialInput: true,
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const humanDraft = "human draft in progress";
    const managerMessage = "manager message stays separate";

    try {
      await waitForTerminalOutput(events, "SCRIPT_INPUT_READY");
      events.sendInput(Buffer.from(humanDraft).toString("base64"));
      await waitForTerminalOutput(events, `SCRIPT_PARTIAL:${humanDraft}`);

      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: managerMessage }
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events.outputText()).not.toContain(`SCRIPT_INPUT:${humanDraft}`);
      expect(events.outputText()).not.toContain(`SCRIPT_INPUT:${managerMessage}`);

      events.sendInput(Buffer.from("\r").toString("base64"), true);
      const output = await waitForTerminalOutput(
        events,
        `SCRIPT_INPUT:${managerMessage}`,
      );
      const humanIndex = output.indexOf(`SCRIPT_INPUT:${humanDraft}`);
      const managerIndex = output.indexOf(`SCRIPT_INPUT:${managerMessage}`);
      expect(humanIndex).toBeGreaterThanOrEqual(0);
      expect(managerIndex).toBeGreaterThan(humanIndex);
      expect(output).not.toContain(`${humanDraft}${managerMessage}`);
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

  it("keeps a queued logical message behind a multiline bracketed-paste continuation", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Multiline paste and manager input isolation",
      tracePartialInput: true,
    });
    const events = collectTerminalEvents(harness, task.taskId);
    const firstDraft = "human draft";
    const pasteContinuation = " continued\nsecond pasted line";
    const completeDraft = `${firstDraft}${pasteContinuation}`;
    const managerMessage = "manager message after multiline paste";

    try {
      await waitForTerminalOutput(events, "SCRIPT_INPUT_READY");
      events.sendInput(Buffer.from(firstDraft).toString("base64"));
      await waitForTerminalOutput(events, `SCRIPT_PARTIAL:${firstDraft}`);

      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: managerMessage }
      });

      const bracketedPaste = `\u001b[200~${pasteContinuation}\u001b[201~`;
      events.sendInput(Buffer.from(bracketedPaste).toString("base64"));
      await waitForTerminalOutput(events, "second pasted line");
      expect(events.outputText()).not.toContain(`SCRIPT_INPUT:${managerMessage}`);

      events.sendInput(Buffer.from("\r").toString("base64"), true);
      const output = await waitForTerminalOutput(
        events,
        `SCRIPT_INPUT:${managerMessage}`,
      );
      const normalizedOutput = output.replaceAll("\r", "");
      const humanIndex = normalizedOutput.indexOf(`SCRIPT_INPUT:${completeDraft}`);
      const managerIndex = normalizedOutput.indexOf(`SCRIPT_INPUT:${managerMessage}`);
      expect(humanIndex).toBeGreaterThanOrEqual(0);
      expect(managerIndex).toBeGreaterThan(humanIndex);
      expect(normalizedOutput).not.toContain(`${completeDraft}${managerMessage}`);
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

  it("notifies a waiting task once when a remote-observed child session exits", async () => {
    const parent = await createScriptedTask(harness, {
      displayName: "Parent notification target"
    });
    const parentEvents = collectTerminalEvents(harness, parent.taskId);
    const child = await createScriptedTask(harness, {
      displayName: "Child notification source",
      notifyTaskId: parent.taskId
    });
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
      await waitForTerminalOutput(parentEvents, `TASK ${child.taskId} DONE [success]`);

      const childRow = await readPipelineItem(harness, child.taskId);
      expect(childRow.activity).toBe("unread");
      expect(childRow.notified_at).toEqual(expect.any(String));

      await new Promise((resolve) => setTimeout(resolve, 500));
      const notificationCount = parentEvents
        .outputText()
        .split(`SCRIPT_INPUT:TASK ${child.taskId} DONE [success]`).length - 1;
      expect(notificationCount).toBe(1);

      const secondRead = await readPipelineItem(harness, child.taskId);
      expect(secondRead.notified_at).toBe(childRow.notified_at);
    } finally {
      parentEvents.close();
      childEvents.close();
    }
  }, 45_000);

  // `TASK <id> DONE [<status>]` is acted on by the receiving agent without
  // re-reading task state, so each way a task can end has to be tellable from
  // the payload alone. Daemon Exit cannot do that on its own — a clean finish,
  // a direct close, and a real failure all end the same PTY the same way — so
  // these drive the three endings through the real server, daemon, and PTY.
  it("reports a normal pipeline completion as DONE [success]", async () => {
    const parent = await createScriptedTask(harness, {
      displayName: "Completion notification parent"
    });
    const parentEvents = collectTerminalEvents(harness, parent.taskId);
    const child = await createScriptedTask(harness, {
      displayName: "Cleanly completed child",
      notifyTaskId: parent.taskId
    });
    const childEvents = collectTerminalEvents(harness, child.taskId);

    try {
      await waitForTerminalOutput(parentEvents, "SCRIPT_READY");
      await waitForTerminalOutput(childEvents, "SCRIPT_READY");
      await pinSingleStagePipeline(harness, child.taskId);
      const childRunId = await currentRunId(child.taskId);
      // The agent succeeds on its only stage, then the stage is advanced —
      // which, past the final stage, closes the task. That close used to
      // hardcode [failure] no matter how the run finished.
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${child.taskId}/actions/complete-stage`,
        body: { runId: childRunId, status: "success", summary: "Approved PR and signaled merge master" }
      });
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${child.taskId}/actions/advance-stage`,
        body: null
      });

      await waitForTerminalOutput(parentEvents, `TASK ${child.taskId} DONE [success]`, 20_000);
      expect(parentEvents.outputText()).not.toContain(`TASK ${child.taskId} DONE [failure]`);
    } finally {
      parentEvents.close();
      childEvents.close();
    }
  }, 60_000);

  it("reports a direct close as DONE [closed], not as a failure", async () => {
    const parent = await createScriptedTask(harness, {
      displayName: "Close notification parent"
    });
    const parentEvents = collectTerminalEvents(harness, parent.taskId);
    const child = await createScriptedTask(harness, {
      displayName: "Directly closed child",
      notifyTaskId: parent.taskId
    });
    const childEvents = collectTerminalEvents(harness, child.taskId);

    try {
      await waitForTerminalOutput(parentEvents, "SCRIPT_READY");
      await waitForTerminalOutput(childEvents, "SCRIPT_READY");
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${child.taskId}/actions/close`,
        body: null
      });

      await waitForTerminalOutput(parentEvents, `TASK ${child.taskId} DONE [closed]`, 20_000);
      expect(parentEvents.outputText()).not.toContain(`TASK ${child.taskId} DONE [failure]`);
    } finally {
      parentEvents.close();
      childEvents.close();
    }
  }, 60_000);

  it("reports a failing verdict as DONE [failure] even when the session exits 0", async () => {
    const parent = await createScriptedTask(harness, {
      displayName: "Failure notification parent"
    });
    const parentEvents = collectTerminalEvents(harness, parent.taskId);
    const child = await createScriptedTask(harness, {
      displayName: "Genuinely failed child",
      notifyTaskId: parent.taskId
    });
    const childEvents = collectTerminalEvents(harness, child.taskId);

    try {
      await waitForTerminalOutput(parentEvents, "SCRIPT_READY");
      await waitForTerminalOutput(childEvents, "SCRIPT_READY");
      const childRunId = await currentRunId(child.taskId);
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${child.taskId}/actions/complete-stage`,
        body: { runId: childRunId, status: "failure", summary: "could not build the feed" }
      });
      // The agent then quits cleanly. The exit code says 0; the verdict on
      // record says failed, and the verdict is what the payload must report.
      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${child.taskId}/input`,
        body: { input: "exit-zero" }
      });
      await childEvents.waitForExit(0);

      await waitForTerminalOutput(parentEvents, `TASK ${child.taskId} DONE [failure]`, 20_000);
      expect(parentEvents.outputText()).not.toContain(`TASK ${child.taskId} DONE [success]`);
    } finally {
      parentEvents.close();
      childEvents.close();
    }
  }, 60_000);

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
