import { describe, expect, it } from "vitest";
import { shouldStartInitialInstances } from "./runPlan";

describe("shouldStartInitialInstances", () => {
  it("does not prestart an app before a real target", () => {
    expect(shouldStartInitialInstances("tests/e2e/real/auth-indexeddb-fallback.test.ts")).toBe(false);
  });

  it("prestarts an app before a mock target", () => {
    expect(shouldStartInitialInstances("tests/e2e/mock/app-launch.test.ts")).toBe(true);
  });
});
