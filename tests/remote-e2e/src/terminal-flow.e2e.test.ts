import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRemoteHarness, type RemoteHarness } from "./harness";
import {
  collectTerminalEvents,
  connectRawRelayClient,
  createScriptedTask,
  decodedOutput,
  expectNoRelayEvent,
  readPipelineItem,
  waitForRelayEvent,
  waitForTerminalOutput
} from "./terminalFlowTestUtils";

describe("remote task terminal flow E2E", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

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
      expect(status).toMatchObject({ desktopId: harness.desktopId });

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
