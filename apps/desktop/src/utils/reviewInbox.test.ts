import { describe, expect, it } from "vitest";
import type { PipelineItem } from "../types/kanna";
import { reviewAwaitingVerdictStage } from "./reviewInbox";

function pipelineDef(stages: Array<{ name: string; transition: "manual" | "auto" }>): string {
  return JSON.stringify({
    name: "default",
    stages: stages.map((stage) => ({
      name: stage.name,
      policy: { transition: stage.transition },
    })),
  });
}

function item(overrides: Partial<PipelineItem> = {}): Pick<
  PipelineItem,
  "activity" | "closed_at" | "has_running_post" | "pipeline_def" | "stage"
> {
  return {
    activity: "idle",
    closed_at: null,
    has_running_post: 0,
    pipeline_def: pipelineDef([
      { name: "in progress", transition: "manual" },
      { name: "review", transition: "auto" },
      { name: "pr", transition: "manual" },
    ]),
    stage: "pr",
    ...overrides,
  };
}

describe("reviewAwaitingVerdictStage", () => {
  it("returns the current manual stage when a parked task awaits a human verdict", () => {
    expect(reviewAwaitingVerdictStage(item({ stage: "pr", activity: "unread" }))).toBe("pr");
  });

  it("supports custom manual review stages from the task pipeline snapshot", () => {
    expect(
      reviewAwaitingVerdictStage(item({
        pipeline_def: pipelineDef([
          { name: "in progress", transition: "auto" },
          { name: "review", transition: "manual" },
        ]),
        stage: "review",
      })),
    ).toBe("review");
  });

  it("does not mark auto stages as awaiting a human verdict", () => {
    expect(reviewAwaitingVerdictStage(item({ stage: "review" }))).toBeNull();
  });

  it("does not mark running tasks or running posts as parked", () => {
    expect(reviewAwaitingVerdictStage(item({ activity: "working" }))).toBeNull();
    expect(reviewAwaitingVerdictStage(item({ has_running_post: 1 }))).toBeNull();
  });

  it("ignores closed tasks and invalid pipeline snapshots", () => {
    expect(reviewAwaitingVerdictStage(item({ closed_at: "2026-07-09T00:00:00.000Z" }))).toBeNull();
    expect(reviewAwaitingVerdictStage(item({ pipeline_def: null }))).toBeNull();
    expect(reviewAwaitingVerdictStage(item({ pipeline_def: "not json" }))).toBeNull();
  });
});
