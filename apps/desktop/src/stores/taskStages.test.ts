import { describe, expect, it } from "vitest";
import { TEARDOWN_STAGE, isTaskTearingDown, isTeardownStage, normalizeWorkflowStage } from "./taskStages";

describe("taskStages", () => {
  it("uses teardown as the canonical stage name", () => {
    expect(TEARDOWN_STAGE).toBe("teardown");
  });

  it("normalizes legacy torndown rows to teardown", () => {
    expect(isTeardownStage("teardown")).toBe(true);
    expect(isTeardownStage("torndown")).toBe(true);
    expect(normalizeWorkflowStage("teardown")).toBe("teardown");
    expect(normalizeWorkflowStage("torndown")).toBe("teardown");
    expect(normalizeWorkflowStage("in progress")).toBe("in progress");
  });

  it("treats teardown_started_at as teardown state without requiring a teardown stage", () => {
    expect(isTaskTearingDown({ stage: "pr", teardown_started_at: "2026-05-08T00:00:00.000Z" })).toBe(true);
    expect(isTaskTearingDown({ stage: "pr", teardown_started_at: null })).toBe(false);
    expect(isTaskTearingDown({ stage: "teardown", teardown_started_at: null })).toBe(true);
  });
});
