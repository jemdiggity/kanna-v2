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
  it("round-trips a valid pending task creation attempt", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    const pendingTaskCreation = {
      taskId: "a1b2c3d4",
      repoId: "repo-1",
      prompt: "Add durable mobile task recovery",
      desktopId: "desktop-e2e",
      agentProvider: "codex" as const,
      terminalCols: 120,
      terminalRows: 70
    };

    await persistence.save({
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: "repo-1",
      selectedTaskId: null,
      activeView: "tasks",
      pendingTaskCreation
    });

    await expect(persistence.load()).resolves.toMatchObject({
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: "repo-1",
      pendingTaskCreation
    });
  });

  it.each([
    ["missing", undefined],
    ["non-object", "pending"],
    ["short task id", {
      taskId: "abcdef0",
      repoId: "repo-1",
      prompt: "Build it",
      desktopId: "desktop-e2e",
      agentProvider: "claude"
    }],
    ["uppercase task id", {
      taskId: "ABCDEF12",
      repoId: "repo-1",
      prompt: "Build it",
      desktopId: "desktop-e2e",
      agentProvider: "claude"
    }],
    ["overlong task id", {
      taskId: "a".repeat(65),
      repoId: "repo-1",
      prompt: "Build it",
      desktopId: "desktop-e2e",
      agentProvider: "claude"
    }],
    ["blank repo", {
      taskId: "abcdef12",
      repoId: "   ",
      prompt: "Build it",
      desktopId: "desktop-e2e",
      agentProvider: "claude"
    }],
    ["blank prompt", {
      taskId: "abcdef12",
      repoId: "repo-1",
      prompt: "\n\t",
      desktopId: "desktop-e2e",
      agentProvider: "claude"
    }],
    ["blank desktop", {
      taskId: "abcdef12",
      repoId: "repo-1",
      prompt: "Build it",
      desktopId: " ",
      agentProvider: "claude"
    }],
    ["unknown provider", {
      taskId: "abcdef12",
      repoId: "repo-1",
      prompt: "Build it",
      desktopId: "desktop-e2e",
      agentProvider: "future-agent"
    }]
  ])("loads a %s pending attempt as null without discarding context", async (_label, pendingTaskCreation) => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    storage.values.set("kanna.mobile.context.v1", JSON.stringify({
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: "repo-1",
      selectedTaskId: "task-existing",
      activeView: "recent",
      pendingTaskCreation
    }));

    await expect(persistence.load()).resolves.toMatchObject({
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: "repo-1",
      selectedTaskId: "task-existing",
      activeView: "recent",
      pendingTaskCreation: null
    });
  });

  it("accepts a 64-character lowercase hexadecimal task id", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    storage.values.set("kanna.mobile.context.v1", JSON.stringify({
      selectedDesktopId: null,
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks",
      pendingTaskCreation: {
        taskId: "f".repeat(64),
        repoId: "repo-1",
        prompt: "Build it",
        desktopId: "desktop-e2e",
        agentProvider: "opencode"
      }
    }));

    expect((await persistence.load())?.pendingTaskCreation?.taskId).toBe("f".repeat(64));
  });

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
