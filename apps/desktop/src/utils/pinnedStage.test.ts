import { describe, expect, it } from "vitest";
import { pinnedApproveMergePost, pinnedCurrentStage, pinnedWorkflowDefinition } from "./pinnedStage";

const DEFAULT_WITH_APPROVE = JSON.stringify({
  name: "default",
  stages: [
    { name: "in progress", policy: { transition: "manual" } },
    { name: "review", policy: { transition: "auto" } },
    {
      name: "pr",
      policy: { transition: "manual" },
      post: { name: "approve", agent: "approve", prompt: "Approve $PREV_RESULT" },
    },
  ],
});

const LEGACY_WITHOUT_POST = JSON.stringify({
  name: "custom",
  stages: [
    { name: "in progress", policy: { transition: "manual" } },
    { name: "pr", policy: { transition: "manual" } },
  ],
});

describe("pinnedWorkflowDefinition", () => {
  it("parses the pinned snapshot and returns null for missing or invalid ones", () => {
    expect(pinnedWorkflowDefinition({ pipeline_def: DEFAULT_WITH_APPROVE, stage: "pr" })?.stages).toHaveLength(3);
    expect(pinnedWorkflowDefinition({ pipeline_def: null, stage: "pr" })).toBeNull();
    expect(pinnedWorkflowDefinition({ pipeline_def: "  ", stage: "pr" })).toBeNull();
    expect(pinnedWorkflowDefinition({ pipeline_def: "not json", stage: "pr" })).toBeNull();
  });
});

describe("pinnedCurrentStage", () => {
  it("returns the snapshot stage matching the task's current stage", () => {
    const stage = pinnedCurrentStage({ pipeline_def: DEFAULT_WITH_APPROVE, stage: "pr" });
    expect(stage?.name).toBe("pr");
    expect(stage?.post?.name).toBe("approve");
    expect(pinnedCurrentStage({ pipeline_def: DEFAULT_WITH_APPROVE, stage: "unknown" })).toBeNull();
  });
});

describe("pinnedApproveMergePost", () => {
  it("is true only when the pinned current stage carries the approve post", () => {
    expect(pinnedApproveMergePost({ pipeline_def: DEFAULT_WITH_APPROVE, stage: "pr" })).toBe(true);
    // Pre-change snapshots and custom workflows without the post must not
    // present approval as a merge.
    expect(pinnedApproveMergePost({ pipeline_def: LEGACY_WITHOUT_POST, stage: "pr" })).toBe(false);
    expect(pinnedApproveMergePost({ pipeline_def: DEFAULT_WITH_APPROVE, stage: "in progress" })).toBe(false);
    expect(pinnedApproveMergePost({ pipeline_def: null, stage: "pr" })).toBe(false);
  });
});
