import { describe, expect, it, vi } from "vitest";
import { seedTrustedDesktopThroughDeepLink } from "./trust-seed";

describe("mobile E2E trust seed helper", () => {
  it("includes the persisted LAN endpoint and unresolved selection in the deep link", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await seedTrustedDesktopThroughDeepLink({
      bundleId: "build.kanna.app.dev",
      driver: { execute } as never,
      desktop: {
        desktopId: "desktop-hybrid",
        displayName: "Hybrid LAN Desktop",
        lanBaseUrl: "http://127.0.0.1:48120"
      },
      selectedRepoId: "repo-restored",
      selectedTaskId: "task-unresolved"
    });

    expect(execute).toHaveBeenCalledWith("mobile: deepLink", {
      bundleId: "build.kanna.app.dev",
      url:
        "kanna://e2e-trust?desktopId=desktop-hybrid" +
        "&displayName=Hybrid%20LAN%20Desktop" +
        "&lanBaseUrl=http%3A%2F%2F127.0.0.1%3A48120" +
        "&selectedRepoId=repo-restored" +
        "&selectedTaskId=task-unresolved"
    });
  });
});
