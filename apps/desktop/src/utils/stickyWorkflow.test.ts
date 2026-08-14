import { describe, expect, it } from "vitest";
import { resolveStickyWorkflowDefault } from "./stickyWorkflow";

describe("resolveStickyWorkflowDefault", () => {
  it("prefers the most recently used workflow over the repo's configured default", () => {
    expect(
      resolveStickyWorkflowDefault(
        ["no-review", "single-reviewer", "specialized-reviewers"],
        ["specialized-reviewers", "no-review"],
        "no-review",
      ),
    ).toBe("specialized-reviewers");
  });

  it("falls back to the configured default when the repo has no history", () => {
    expect(
      resolveStickyWorkflowDefault(["no-review", "single-reviewer"], [], "single-reviewer"),
    ).toBe("single-reviewer");
  });

  it("skips recent workflows the repo no longer offers", () => {
    expect(
      resolveStickyWorkflowDefault(
        ["no-review", "single-reviewer"],
        ["retired-workflow", "single-reviewer"],
        "no-review",
      ),
    ).toBe("single-reviewer");
  });

  it("resolves a recent name for a renamed built-in, canonicalized by the server", () => {
    // A task created before the `default` -> `no-review` rename stored
    // `default` on its durable row. `/recent-workflows` serves that row as
    // its current name (the server owns the retired-name table), so the
    // sticky choice still matches here instead of being skipped for the
    // repo's configured default.
    expect(
      resolveStickyWorkflowDefault(
        ["no-review", "single-reviewer"],
        ["no-review"],
        "single-reviewer",
      ),
    ).toBe("no-review");
  });

  it("falls back to the configured default when no recent workflow is still selectable", () => {
    expect(
      resolveStickyWorkflowDefault(["no-review"], ["retired-workflow"], "no-review"),
    ).toBe("no-review");
  });

  it("reports no default when neither history nor configuration offers one", () => {
    expect(resolveStickyWorkflowDefault([], [], undefined)).toBeUndefined();
  });
});
