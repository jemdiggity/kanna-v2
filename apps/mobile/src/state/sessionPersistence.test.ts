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
  it("loads old contexts without inventing a device id during parsing", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    storage.values.set("kanna.mobile.context.v1", JSON.stringify({
      selectedDesktopId: null,
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks"
    }));

    await expect(persistence.load()).resolves.toMatchObject({ mobileDeviceId: null });
  });

  it("roundtrips the stable mobile device id", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);

    await persistence.save({
      selectedDesktopId: null,
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks",
      mobileDeviceId: "mobile-a1b2"
    });

    await expect(persistence.load()).resolves.toMatchObject({
      mobileDeviceId: "mobile-a1b2"
    });
  });

  it("round-trips a valid pending task creation attempt", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    const pendingTaskCreation = {
      slotId: "create:slot-a1b2c3d4",
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

  it("round-trips multiple task creation attempts and ignores duplicate identities", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    const attempts = [
      {
        slotId: "create:slot-a",
        taskId: "11111111",
        repoId: "repo-1",
        prompt: "First task",
        desktopId: "desktop-a",
        agentProvider: "claude" as const
      },
      {
        slotId: "create:slot-b",
        taskId: "22222222",
        repoId: "repo-2",
        prompt: "Second task",
        desktopId: "desktop-b",
        agentProvider: "codex" as const
      }
    ];

    await persistence.save({
      mobileDeviceId: null,
      selectedDesktopId: "desktop-a",
      selectedRepoId: "repo-1",
      selectedTaskId: attempts[0].slotId,
      activeView: "tasks",
      taskCreationAttempts: [
        ...attempts,
        { ...attempts[0], slotId: "create:duplicate-task" },
        { ...attempts[1], taskId: "33333333" }
      ]
    });

    await expect(persistence.load()).resolves.toMatchObject({
      taskCreationAttempts: attempts
    });
  });

  it("derives a deterministic UI slot for a legacy pending attempt", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    storage.values.set("kanna.mobile.context.v1", JSON.stringify({
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: "repo-1",
      selectedTaskId: "a1b2c3d4",
      activeView: "tasks",
      pendingTaskCreation: {
        taskId: "a1b2c3d4",
        repoId: "repo-1",
        prompt: "Recover an older attempt",
        desktopId: "desktop-e2e",
        agentProvider: "claude"
      }
    }));

    await expect(persistence.load()).resolves.toMatchObject({
      pendingTaskCreation: {
        slotId: "create:a1b2c3d4",
        taskId: "a1b2c3d4"
      }
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
    ["non-creation slot id", {
      slotId: "task-existing",
      taskId: "abcdef12",
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

  it("round-trips the paired device secret on trusted desktops", async () => {
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
          lastSeenAt: "2026-06-05T00:00:00.000Z",
          deviceSecret: "persisted-lan-secret"
        }
      ]
    });

    const loaded = await persistence.load();
    expect(loaded?.trustedDesktops?.[0]?.deviceSecret).toBe(
      "persisted-lan-secret"
    );
  });

  it("round-trips coherent anonymous push pairing material", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    const desktopPushIdentity = {
      publicKey: "desktop-ed25519-public-key",
      relayUrl: "wss://relay.example",
      environment: "development"
    };
    const pushPairingCert = {
      deviceId: "mobile-device-1",
      issuedAt: 1_784_246_400_000,
      expiresAt: 1_847_318_400_000,
      signature: "desktop-signature"
    };

    await persistence.save({
      mobileDeviceId: "mobile-device-1",
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks",
      trustedDesktops: [{
        desktopId: "desktop-e2e",
        displayName: "E2E Mac",
        lanEndpoints: [],
        lastSeenAt: "2026-08-24T00:00:00.000Z",
        desktopPushIdentity,
        pushPairingCert
      }]
    });

    await expect(persistence.load()).resolves.toMatchObject({
      trustedDesktops: [{ desktopPushIdentity, pushPairingCert }]
    });
  });

  it("drops incomplete anonymous push pairing material", async () => {
    const storage = createMemoryStorage();
    const persistence = createSessionPersistence(storage);
    await storage.setItem("kanna.mobile.context.v1", JSON.stringify({
      mobileDeviceId: "mobile-device-1",
      selectedDesktopId: "desktop-e2e",
      selectedRepoId: null,
      selectedTaskId: null,
      activeView: "tasks",
      trustedDesktops: [{
        desktopId: "desktop-e2e",
        displayName: "E2E Mac",
        lanEndpoints: [],
        lastSeenAt: "2026-08-24T00:00:00.000Z",
        desktopPushIdentity: {
          publicKey: "desktop-ed25519-public-key",
          relayUrl: "wss://relay.example",
          environment: "development"
        }
      }]
    }));

    const loaded = await persistence.load();
    expect(loaded?.trustedDesktops?.[0]).not.toHaveProperty("desktopPushIdentity");
    expect(loaded?.trustedDesktops?.[0]).not.toHaveProperty("pushPairingCert");
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
