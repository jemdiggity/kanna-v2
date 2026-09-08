import { describe, expect, it } from "vitest";

import { buildDesktopMockE2eCommand, buildDesktopRealE2eCommand } from "./desktop-e2e";

describe("desktop real E2E commands", () => {
  it("builds the unattended tier command", () => {
    expect(buildDesktopRealE2eCommand("unattended")).toEqual([
      "pnpm",
      ["--dir", "apps/desktop", "test:e2e", "real-unattended"],
    ]);
  });

  it("builds the operator tier command", () => {
    expect(buildDesktopRealE2eCommand("operator")).toEqual([
      "pnpm",
      ["--dir", "apps/desktop", "test:e2e", "real-operator"],
    ]);
  });
});

describe("desktop mock E2E command", () => {
  it("runs the whole mock suite through the E2E runner", () => {
    expect(buildDesktopMockE2eCommand()).toEqual([
      "pnpm",
      ["--dir", "apps/desktop", "test:e2e", "mock/"],
    ]);
  });
});
