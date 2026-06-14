import { describe, expect, it, afterAll, beforeAll } from "vitest";

import { WebDriverClient } from "../helpers/webdriver";

describe("startup window size", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("opens at the configured default size instead of restoring stale tiny native state", async () => {
    const rect = await client.getWindowRect();

    expect(rect.width).toBeGreaterThanOrEqual(1100);
    expect(rect.height).toBeGreaterThanOrEqual(760);
    expect(rect.width).not.toBe(180);
    expect(rect.height).not.toBe(120);
  });
});
