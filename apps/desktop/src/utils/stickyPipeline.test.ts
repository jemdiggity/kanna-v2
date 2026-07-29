import { describe, expect, it } from "vitest";
import { resolveStickyPipelineDefault } from "./stickyPipeline";

describe("resolveStickyPipelineDefault", () => {
  it("prefers the most recently used pipeline over the repo's configured default", () => {
    expect(
      resolveStickyPipelineDefault(
        ["no-review", "single-reviewer", "specialized-reviewers"],
        ["specialized-reviewers", "no-review"],
        "no-review",
      ),
    ).toBe("specialized-reviewers");
  });

  it("falls back to the configured default when the repo has no history", () => {
    expect(
      resolveStickyPipelineDefault(["no-review", "single-reviewer"], [], "single-reviewer"),
    ).toBe("single-reviewer");
  });

  it("skips recent pipelines the repo no longer offers", () => {
    expect(
      resolveStickyPipelineDefault(
        ["no-review", "single-reviewer"],
        ["retired-pipeline", "single-reviewer"],
        "no-review",
      ),
    ).toBe("single-reviewer");
  });

  it("resolves a recent name for a renamed built-in, canonicalized by the server", () => {
    // A task created before the `default` -> `no-review` rename stored
    // `default` on its durable row. `/recent-pipelines` serves that row as
    // its current name (the server owns the retired-name table), so the
    // sticky choice still matches here instead of being skipped for the
    // repo's configured default.
    expect(
      resolveStickyPipelineDefault(
        ["no-review", "single-reviewer"],
        ["no-review"],
        "single-reviewer",
      ),
    ).toBe("no-review");
  });

  it("falls back to the configured default when no recent pipeline is still selectable", () => {
    expect(
      resolveStickyPipelineDefault(["no-review"], ["retired-pipeline"], "no-review"),
    ).toBe("no-review");
  });

  it("reports no default when neither history nor configuration offers one", () => {
    expect(resolveStickyPipelineDefault([], [], undefined)).toBeUndefined();
  });
});
