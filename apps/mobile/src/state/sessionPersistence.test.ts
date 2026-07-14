import { describe, expect, it } from "vitest";
import { AGENT_PROVIDERS } from "@kanna/agent-protocol";
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

  it("preserves local repo creation profiles", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);

    await persistence.save({
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: "repo-1",
      selectedTaskId: null,
      activeView: "tasks",
      repoCreationProfiles: [
        {
          repoId: "repo-1",
          desktopId: "desktop-e2e",
          agentProvider: "copilot",
          updatedAt: "2026-07-06T00:00:00.000Z"
        }
      ],
      trustedDesktops: []
    });

    await expect(persistence.load()).resolves.toMatchObject({
      selectedRepoId: "repo-1",
      repoCreationProfiles: [
        {
          repoId: "repo-1",
          desktopId: "desktop-e2e",
          agentProvider: "copilot",
          updatedAt: "2026-07-06T00:00:00.000Z"
        }
      ]
    });
  });

  it("preserves every generated provider and discards unknown providers", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    storage.values.set("kanna.mobile.context.v1", JSON.stringify({
      selectedDesktopId: null,
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks",
      repoCreationProfiles: [
        ...AGENT_PROVIDERS.map((agentProvider, index) => ({
          repoId: `repo-${index}`,
          desktopId: "desktop-e2e",
          agentProvider,
          updatedAt: "2026-07-06T00:00:00.000Z",
        })),
        {
          repoId: "repo-unknown",
          desktopId: "desktop-e2e",
          agentProvider: "future-agent",
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      ],
    }));

    const loaded = await persistence.load();

    expect(loaded?.repoCreationProfiles?.map((profile) => profile.agentProvider)).toEqual(AGENT_PROVIDERS);
  });
});
