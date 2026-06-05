import { describe, expect, it, vi } from "vitest";
import { seedTrustedDesktopFromUrl } from "./e2eTrustSeed";
import { createSessionPersistence, type StorageAdapter } from "./state/sessionPersistence";

function createMemoryStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    }
  };
}

describe("seedTrustedDesktopFromUrl", () => {
  it("persists the E2E deep-link trust seed so reload can enable trusted Bonjour", async () => {
    // Full native Bonjour/Appium coverage requires a running signed iOS app,
    // native service discovery permissions, and a desktop LAN server. This
    // boundary test proves the deep-link seed survives the same persistence
    // reload that app bootstrap uses before trusted Bonjour resolution runs.
    const persistence = createSessionPersistence(createMemoryStorage());
    const reload = vi.fn(async () => {
      const reloaded = await persistence.load();
      expect(reloaded?.trustedDesktops).toEqual([
        {
          desktopId: "desktop-e2e",
          displayName: "E2E Mac",
          lanEndpoints: [],
          lastSeenAt: expect.any(String)
        }
      ]);
    });

    await seedTrustedDesktopFromUrl(
      "kanna://e2e-trust?desktopId=desktop-e2e&displayName=E2E%20Mac",
      {
        getPersistence: async () => persistence,
        reload
      }
    );

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
