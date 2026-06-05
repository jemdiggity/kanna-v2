import { describe, expect, it } from "vitest";
import { createSessionPersistence, type StorageAdapter } from "./sessionPersistence";

function createMemoryStorage(): StorageAdapter & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    }
  };
}

describe("createSessionPersistence", () => {
  it("preserves a trusted desktop identity without cached LAN endpoints", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);

    await persistence.save({
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks",
      trustedDesktops: [
        {
          desktopId: "desktop-e2e",
          displayName: "E2E Mac",
          lanEndpoints: [],
          lastSeenAt: "2026-06-05T00:00:00.000Z"
        }
      ]
    });

    await expect(persistence.load()).resolves.toMatchObject({
      selectedDesktopId: "desktop-e2e",
      trustedDesktops: [
        {
          desktopId: "desktop-e2e",
          displayName: "E2E Mac",
          lanEndpoints: [],
          lastSeenAt: "2026-06-05T00:00:00.000Z"
        }
      ]
    });
  });
});
