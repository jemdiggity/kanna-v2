import { describe, expect, it } from "vitest";
import { hostInstalledAgentProviders, serverProviderPath } from "./harness";

describe("serverProviderPath", () => {
  it("drops host directories that hold a provider CLI", () => {
    const path = serverProviderPath(
      "/fake-agent-bin",
      "/opt/homebrew/bin:/usr/bin:/Users/dev/.local/bin",
      (candidate) =>
        candidate === "/opt/homebrew/bin/claude" ||
        candidate === "/Users/dev/.local/bin/agy"
    );

    expect(path).toBe("/fake-agent-bin:/usr/bin");
  });

  it("keeps the harness stub directory first and only once", () => {
    const path = serverProviderPath(
      "/fake-agent-bin",
      "/fake-agent-bin:/usr/bin",
      () => false
    );

    expect(path).toBe("/fake-agent-bin:/usr/bin");
  });

  it("survives an empty host PATH", () => {
    expect(serverProviderPath("/fake-agent-bin", undefined, () => false)).toBe(
      "/fake-agent-bin"
    );
  });
});

describe("hostInstalledAgentProviders", () => {
  it("names the providers that resolve outside any PATH the harness controls", () => {
    expect(
      hostInstalledAgentProviders(
        (candidate) =>
          candidate === "/opt/homebrew/bin/claude" ||
          candidate === "/usr/local/bin/agy"
      )
    ).toEqual(["claude", "antigravity"]);
  });

  it("is empty on a host with no globally installed provider", () => {
    expect(hostInstalledAgentProviders(() => false)).toEqual([]);
  });
});
