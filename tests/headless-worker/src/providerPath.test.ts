import { describe, expect, it } from "vitest";
import { AGENT_PROVIDER_EXECUTABLES, providerPath } from "./worker.ts";

describe("providerPath", () => {
  /**
   * The gate spends no model turns, and this is what guarantees it: if a
   * developer's real `claude` were still ahead of the scripted one on PATH,
   * `kanna-server` would resolve and spawn it.
   */
  it("puts the scripted providers ahead of everything else", () => {
    const path = providerPath("/fixture/bin", "/usr/bin:/bin", () => false);
    expect(path.split(":")[0]).toBe("/fixture/bin");
  });

  it("drops directories that hold a real provider CLI", () => {
    const path = providerPath(
      "/fixture/bin",
      "/opt/homebrew/bin:/usr/bin:/home/dev/.local/bin",
      (directory) => directory !== "/usr/bin",
    );

    expect(path.split(":")).toEqual(["/fixture/bin", "/usr/bin"]);
  });

  it("keeps ordinary tooling and never repeats the fixture directory", () => {
    const path = providerPath("/fixture/bin", "/fixture/bin:/usr/bin::", () => false);
    expect(path.split(":")).toEqual(["/fixture/bin", "/usr/bin"]);
  });

  it("works with no inherited PATH at all", () => {
    expect(providerPath("/fixture/bin", undefined, () => false)).toBe("/fixture/bin");
  });

  /** Every executable the server probes has to be shadowed, not just claude. */
  it("covers every provider executable the server resolves", () => {
    expect([...AGENT_PROVIDER_EXECUTABLES].sort()).toEqual([
      "agy",
      "claude",
      "codex",
      "copilot",
      "opencode",
    ]);
  });
});
