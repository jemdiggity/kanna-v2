import { describe, expect, it } from "vitest";
import type { PipelineItem } from "@kanna/db";
import { computeTaskSnapshotFingerprint } from "./cloudTaskFingerprint";

function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    prompt: "do a thing",
    stage: "in progress",
    stage_result: null,
    active_post_action: null,
    pr_number: null,
    pr_url: null,
    branch: "task-1",
    closed_at: null,
    activity: "idle",
    activity_changed_at: null,
    display_name: null,
    base_ref: null,
    previous_stage: null,
    updated_at: "2026-06-14T00:00:00.000Z",
    ...overrides,
  } as PipelineItem;
}

describe("computeTaskSnapshotFingerprint", () => {
  it("is stable across activity and updated_at churn", () => {
    const before = computeTaskSnapshotFingerprint([makeItem({ activity: "idle" })]);
    const after = computeTaskSnapshotFingerprint([
      makeItem({ activity: "working", activity_changed_at: "later", updated_at: "2026-06-14T01:00:00.000Z" }),
    ]);
    expect(after).toBe(before);
  });

  it("changes when a structural field changes", () => {
    const base = computeTaskSnapshotFingerprint([makeItem({ stage: "in progress" })]);
    expect(computeTaskSnapshotFingerprint([makeItem({ stage: "pr" })])).not.toBe(base);
    expect(computeTaskSnapshotFingerprint([makeItem({ pr_number: 42 })])).not.toBe(base);
    expect(computeTaskSnapshotFingerprint([makeItem({ display_name: "Renamed" })])).not.toBe(base);
  });

  it("is order-independent", () => {
    const a = makeItem({ id: "a" });
    const b = makeItem({ id: "b" });
    expect(computeTaskSnapshotFingerprint([a, b])).toBe(computeTaskSnapshotFingerprint([b, a]));
  });

  it("excludes closed and done tasks", () => {
    const open = makeItem({ id: "open" });
    const withClosed = computeTaskSnapshotFingerprint([
      open,
      makeItem({ id: "closed", closed_at: "2026-06-14T00:00:00.000Z" }),
      makeItem({ id: "done", stage: "done" }),
    ]);
    expect(withClosed).toBe(computeTaskSnapshotFingerprint([open]));
  });

  it("distinguishes membership changes", () => {
    const one = computeTaskSnapshotFingerprint([makeItem({ id: "a" })]);
    const two = computeTaskSnapshotFingerprint([makeItem({ id: "a" }), makeItem({ id: "b" })]);
    expect(two).not.toBe(one);
  });
});
