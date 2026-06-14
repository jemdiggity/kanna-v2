import { describe, expect, it } from "vitest";
import { runCloudTaskFlow } from "./cloud-task-flow.e2e";

describe("runCloudTaskFlow", () => {
  it("requires explicit cloud test credentials", async () => {
    await expect(
      runCloudTaskFlow({} as Parameters<typeof runCloudTaskFlow>[0], {})
    ).rejects.toThrow("KANNA_E2E_CLOUD_EMAIL");
  });
});
