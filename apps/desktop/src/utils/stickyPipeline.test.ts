import { describe, expect, it } from "vitest";
import { resolveStickyPipelineDefault } from "./stickyPipeline";

describe("resolveStickyPipelineDefault", () => {
  it("prefers the most recently used pipeline over the repo's configured default", () => {
    expect(
      resolveStickyPipelineDefault(
        ["default", "single-reviewer", "specialized-reviewers"],
        ["specialized-reviewers", "default"],
        "default",
      ),
    ).toBe("specialized-reviewers");
  });

  it("falls back to the configured default when the repo has no history", () => {
    expect(
      resolveStickyPipelineDefault(["default", "single-reviewer"], [], "single-reviewer"),
    ).toBe("single-reviewer");
  });

  it("skips recent pipelines the repo no longer offers", () => {
    expect(
      resolveStickyPipelineDefault(
        ["default", "single-reviewer"],
        ["retired-pipeline", "single-reviewer"],
        "default",
      ),
    ).toBe("single-reviewer");
  });

  it("falls back to the configured default when no recent pipeline is still selectable", () => {
    expect(
      resolveStickyPipelineDefault(["default"], ["retired-pipeline"], "default"),
    ).toBe("default");
  });

  it("reports no default when neither history nor configuration offers one", () => {
    expect(resolveStickyPipelineDefault([], [], undefined)).toBeUndefined();
  });
});
