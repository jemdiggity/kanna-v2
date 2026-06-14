import { describe, expect, it } from "vitest";
import { shouldPrewarmTaskShellOnCreate } from "./taskShellPrewarm";

describe("shouldPrewarmTaskShellOnCreate", () => {
  it("keeps worktree shell prewarm enabled for PTY tasks", () => {
    expect(shouldPrewarmTaskShellOnCreate("pty")).toBe(true);
  });

  it("keeps worktree shell prewarm enabled for SDK tasks", () => {
    expect(shouldPrewarmTaskShellOnCreate("agent")).toBe(true);
  });
});
