import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRemoteHarness, type RemoteHarness } from "./harness";
import {
  connectRawRelayClient,
  createScriptedTask,
  waitForRelayEvent
} from "./terminalFlowTestUtils";

describe("staging remote task E2E smoke", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness({ environment: "staging" });
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  it("authenticates both sides, invokes status, and observes a terminal snapshot", async () => {
    const status = await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "GET",
      path: "/v1/status",
      body: null
    });

    expect(status).toMatchObject({
      desktopId: harness.desktopId,
      desktopName: "Remote E2E Staging Desktop",
      state: "running"
    });

    const task = await createScriptedTask(harness, {
      displayName: "Staging terminal snapshot task"
    });
    const rawClient = await connectRawRelayClient(harness);

    try {
      rawClient.send({
        type: "invoke",
        id: "observe-staging-smoke",
        desktopId: harness.desktopId,
        command: "observe_session",
        args: { session_id: task.taskId }
      });
      await rawClient.waitFor((message) => message.type === "response" && message.id === "observe-staging-smoke");

      const snapshot = await waitForRelayEvent(rawClient, "terminal_snapshot", task.taskId);
      expect(snapshot.payload).toMatchObject({
        session_id: task.taskId
      });

      rawClient.send({
        type: "invoke",
        id: "unobserve-staging-smoke",
        desktopId: harness.desktopId,
        command: "unobserve_session",
        args: { session_id: task.taskId }
      });
      await rawClient.waitFor((message) => message.type === "response" && message.id === "unobserve-staging-smoke");

      await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "POST",
        path: `/v1/tasks/${task.taskId}/input`,
        body: { input: "exit-zero" }
      });
    } finally {
      rawClient.close();
    }
  }, 60_000);
});
