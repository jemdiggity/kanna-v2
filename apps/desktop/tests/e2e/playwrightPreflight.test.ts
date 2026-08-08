import { describe, expect, it, vi } from "vitest";
import {
  assertPlaywrightChromiumAvailable,
  PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND,
} from "./playwrightPreflight";

describe("Playwright Chromium E2E preflight", () => {
  it("accepts an executable already provisioned by Playwright", async () => {
    const isExecutable = vi.fn().mockResolvedValue(true);

    await expect(assertPlaywrightChromiumAvailable({
      executablePath: "/cache/chromium",
      isExecutable,
    })).resolves.toBeUndefined();
    expect(isExecutable).toHaveBeenCalledWith("/cache/chromium");
  });

  it("fails before heavy startup with an exact local install remediation", async () => {
    await expect(assertPlaywrightChromiumAvailable({
      executablePath: "/missing/chromium",
      isExecutable: vi.fn().mockResolvedValue(false),
    })).rejects.toThrow(
      `Playwright Chromium is not installed or executable at /missing/chromium. ` +
      `Run: ${PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND}`,
    );
    expect(PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND).toBe(
      "pnpm --dir apps/desktop exec playwright install chromium",
    );
  });
});
