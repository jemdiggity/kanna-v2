import { describe, expect, it } from "vitest";
import { resolveBuildCommit, UNKNOWN_BUILD_COMMIT } from "./buildInfo.js";

describe("resolveBuildCommit", () => {
  it("reports the commit baked into the image", () => {
    expect(resolveBuildCommit({ KANNA_RELAY_COMMIT: "1f2e3d4c5b6a" })).toBe("1f2e3d4c5b6a");
    expect(resolveBuildCommit({ KANNA_RELAY_COMMIT: " 1F2E3D4C5B6A \n" })).toBe("1f2e3d4c5b6a");
  });

  it("reports unknown when the image was built without a commit", () => {
    expect(resolveBuildCommit({})).toBe(UNKNOWN_BUILD_COMMIT);
    expect(resolveBuildCommit({ KANNA_RELAY_COMMIT: "" })).toBe(UNKNOWN_BUILD_COMMIT);
    expect(resolveBuildCommit({ KANNA_RELAY_COMMIT: "unknown" })).toBe(UNKNOWN_BUILD_COMMIT);
  });

  it("refuses to echo anything that is not a bare sha", () => {
    expect(resolveBuildCommit({ KANNA_RELAY_COMMIT: "release/0.2" })).toBe(UNKNOWN_BUILD_COMMIT);
    expect(resolveBuildCommit({ KANNA_RELAY_COMMIT: "1f2e3d4" })).toBe("1f2e3d4");
    expect(resolveBuildCommit({ KANNA_RELAY_COMMIT: "1f2e3d" })).toBe(UNKNOWN_BUILD_COMMIT);
    expect(resolveBuildCommit({ KANNA_RELAY_COMMIT: "1f2e3d4c5b6a-dirty" })).toBe(UNKNOWN_BUILD_COMMIT);
  });
});
