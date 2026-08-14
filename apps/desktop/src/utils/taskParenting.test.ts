import { describe, expect, it } from "vitest";
import type { PipelineItem } from "../types/kanna";

import { hasOpenSubtasks, validateParentAssignment } from "./taskParenting";

function item(overrides: Partial<PipelineItem>): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: null,
    workflow: "default",
    stage: "in progress",
    stage_result: null,
    active_post_action: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: null,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: null,
    unread_at: null,
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    parent_task_id: null,
    created_at: "2026-05-31T00:00:00.000Z",
    updated_at: "2026-05-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("hasOpenSubtasks", () => {
  it("is true while a subtask is open and false once all subtasks are closed", () => {
    const open = [
      item({ id: "parent" }),
      item({ id: "child", parent_task_id: "parent" }),
    ];
    expect(hasOpenSubtasks(open, "parent")).toBe(true);

    const closed = [
      item({ id: "parent" }),
      item({ id: "child", parent_task_id: "parent", closed_at: "2026-05-31 10:00:00" }),
      item({ id: "child-2", parent_task_id: "parent", closed_at: "2026-05-31 10:05:00" }),
    ];
    expect(hasOpenSubtasks(closed, "parent")).toBe(false);
  });

  it("is false for a leaf task with no subtasks", () => {
    expect(hasOpenSubtasks([item({ id: "solo" })], "solo")).toBe(false);
  });
});

describe("validateParentAssignment", () => {
  it("allows nesting under an unrelated task in the same repo", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    expect(validateParentAssignment(items, "a", "b")).toBeNull();
  });

  it("rejects self-parenting", () => {
    expect(validateParentAssignment([item({ id: "a" })], "a", "a")).toBe("same-task");
  });

  it("rejects parents in a different repo", () => {
    const items = [item({ id: "a", repo_id: "repo-1" }), item({ id: "b", repo_id: "repo-2" })];
    expect(validateParentAssignment(items, "a", "b")).toBe("different-repo");
  });

  it("rejects assignments that would create a cycle", () => {
    // a -> b -> c (c is a descendant of a). Nesting a under c would loop.
    const items = [
      item({ id: "a" }),
      item({ id: "b", parent_task_id: "a" }),
      item({ id: "c", parent_task_id: "b" }),
    ];
    expect(validateParentAssignment(items, "a", "c")).toBe("cycle");
  });

  it("treats a missing referenced task as a no-op (null)", () => {
    expect(validateParentAssignment([item({ id: "a" })], "a", "missing")).toBeNull();
  });
});
