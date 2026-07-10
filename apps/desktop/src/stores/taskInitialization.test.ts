import { describe, expect, it } from "vitest";
import {
  buildInitializingTaskItem,
  initializeTaskItem,
  removeInitializingTaskItem,
  toReadyTaskUiItem,
} from "./taskInitialization";

describe("task initialization UI items", () => {
  it("creates a UI item without a durable task id", () => {
    const item = buildInitializingTaskItem({
      id: "create-1",
      repoId: "repo-1",
      prompt: "ship it",
      displayName: "Ship it",
      pipelineName: "qa",
      agentType: "pty",
      requestedAgentProviders: "copilot",
      nowIso: "2026-07-10T00:00:00.000Z",
    });

    expect(item).toMatchObject({
      id: "create-1",
      state: "initializing",
      taskId: null,
      repo_id: "repo-1",
      prompt: "ship it",
      display_name: "Ship it",
      pipeline: "qa",
      stage: "in progress",
      agent_type: "pty",
      agent_provider: "copilot",
    });
    expect(item).not.toHaveProperty("branch");
  });

  it("wraps persisted tasks with an explicit durable task id", () => {
    const task = { id: "task-1" } as import("../types/kanna").PipelineItem;

    expect(toReadyTaskUiItem(task)).toEqual({
      id: "task-1",
      state: "ready",
      taskId: "task-1",
      task,
    });
  });

  it("initializes and removes items immutably", () => {
    const pending = buildInitializingTaskItem({
      id: "create-1",
      repoId: "repo-1",
      prompt: "ship it",
      agentType: "pty",
    });

    const initialized = initializeTaskItem([pending], "create-1", "task-1");

    expect(initialized[0]?.taskId).toBe("task-1");
    expect(removeInitializingTaskItem(initialized, "create-1")).toEqual([]);
  });
});
