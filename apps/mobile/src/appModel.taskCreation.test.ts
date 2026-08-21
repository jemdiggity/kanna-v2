import { describe, expect, it, vi } from "vitest";
import { createAppModel } from "./appModel";
import { TaskCreationError } from "./lib/api/client";
import { createStaticBonjourBrowser } from "./lib/discovery/bonjour";
import type { MobileAuthSession } from "./lib/firebase/auth";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(iterations = 5): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createSignedOutAuthSession(): MobileAuthSession {
  return {
    getState: vi.fn(() => ({ status: "signedOut" })),
    subscribe: vi.fn((listener) => {
      listener({ status: "signedOut" });
      return vi.fn();
    }),
    initialize: vi.fn().mockResolvedValue(undefined),
    signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue(null),
    notifyAuthExpired: vi.fn()
  };
}

describe("createAppModel task creation persistence", () => {
  it("classifies disconnected creation as definitely not created", async () => {
    const app = createAppModel({
      authSession: createSignedOutAuthSession(),
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        bonjourBrowser: createStaticBonjourBrowser([]),
        forceCloud: false,
        relayUrl: null
      }
    });

    const error = await app.client.createTask({
      taskId: "77777777777777777777777777777777",
      repoId: "repo-1",
      prompt: "Cannot dispatch",
      desktopId: "desktop-1"
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(TaskCreationError);
    expect(error).toMatchObject({
      outcome: "not-created",
      message: "No trusted desktop is available. Sign in or pair a desktop."
    });
  });

  it("serializes session writes so a newer snapshot cannot overtake an older one", async () => {
    const firstSave = deferred<void>();
    const save = vi
      .fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValue(undefined);
    const app = createAppModel({
      authSession: createSignedOutAuthSession(),
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save
      },
      options: {
        bonjourBrowser: createStaticBonjourBrowser([]),
        forceCloud: false,
        relayUrl: null
      }
    });

    app.sessionStore.selectRepo("repo-first");
    app.sessionStore.setActiveView("recent");
    await flushMicrotasks();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      selectedRepoId: "repo-first",
      activeView: "tasks"
    });

    firstSave.resolve();
    await flushMicrotasks();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toMatchObject({
      selectedRepoId: "repo-first",
      activeView: "recent"
    });
  });

  it("awaits the exact pending-attempt save before dispatching the LAN create", async () => {
    const pendingAttemptSave = deferred<void>();
    const persistence = {
      load: vi.fn().mockResolvedValue({
        selectedDesktopId: "desktop-lan",
        selectedRepoId: "repo-lan",
        selectedTaskId: null,
        activeView: "tasks" as const,
        trustedDesktops: [
          {
            desktopId: "desktop-lan",
            displayName: "LAN Mac",
            lanEndpoints: [],
            lastSeenAt: "2026-07-15T00:00:00.000Z"
          }
        ]
      }),
      save: vi.fn((context) =>
        context.taskCreationAttempts?.length
          ? pendingAttemptSave.promise
          : Promise.resolve()
      )
    };
    const requests: Array<{
      method: string;
      url: string;
      body: string | undefined;
    }> = [];
    const fetchImpl = vi.fn(async (input: string, init?: {
      method?: string;
      body?: string;
    }) => {
      const url = input.toString();
      requests.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body
      });
      if (url.endsWith("/v1/status")) {
        return response({
          state: "running",
          desktopId: "desktop-lan",
          desktopName: "LAN Mac",
          lanHost: "0.0.0.0",
          lanPort: 48120,
          pairingCode: null
        });
      }
      if (url.endsWith("/v1/desktops")) {
        return response([
          {
            id: "desktop-lan",
            name: "LAN Mac",
            connectionMode: "local"
          }
        ]);
      }
      if (url.endsWith("/v1/repos")) {
        return response([{ id: "repo-lan", name: "LAN Repo" }]);
      }
      if (
        url.endsWith("/v1/tasks/recent") ||
        url.endsWith("/v1/repos/repo-lan/tasks")
      ) {
        return response([]);
      }
      const createMatch = url.match(/\/v1\/tasks\/([0-9a-f]{8})$/);
      if (createMatch && init?.method === "PUT") {
        return response({
          taskId: createMatch[1],
          repoId: "repo-lan",
          title: "Persist this identity",
          stage: "in progress"
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    const app = createAppModel({
      authSession: createSignedOutAuthSession(),
      fetchImpl,
      persistence,
      options: {
        bonjourBrowser: createStaticBonjourBrowser([
          {
            name: "LAN Mac",
            type: "_kanna-mobile._tcp.",
            host: "desktop.lan",
            port: 48120,
            txt: { desktopId: "desktop-lan" }
          }
        ]),
        forceCloud: false,
        relayUrl: null
      }
    });
    await app.initialize();
    app.controller.openComposer();
    app.controller.updateComposerPrompt("Persist this identity");

    const createPromise = app.controller.createTask();
    app.controller.closeTask();
    await flushMicrotasks();

    expect(persistence.save).toHaveBeenCalledWith(
      expect.objectContaining({
        taskCreationAttempts: [
          expect.objectContaining({
            taskId: expect.stringMatching(/^[0-9a-f]{8}$/),
            repoId: "repo-lan",
            prompt: "Persist this identity",
            desktopId: "desktop-lan",
            agentProvider: "claude"
          })
        ]
      })
    );
    expect(
      requests.filter(({ method, url }) =>
        method === "PUT" && /\/v1\/tasks\/[0-9a-f]{8}$/.test(url)
      )
    ).toHaveLength(0);

    pendingAttemptSave.resolve();
    await createPromise;

    const createRequests = requests.filter(({ method, url }) =>
      method === "PUT" && /\/v1\/tasks\/[0-9a-f]{8}$/.test(url)
    );
    expect(createRequests).toHaveLength(1);
    expect(JSON.parse(createRequests[0]!.body ?? "null")).toMatchObject({
      repoId: "repo-lan",
      prompt: "Persist this identity",
      agentProvider: "claude",
      agentType: "pty"
    });
  });

  it("retries a failed prospective manual-removal snapshot", async () => {
    let removalAttempts = 0;
    const persistence = {
      load: vi.fn().mockResolvedValue({
        mobileDeviceId: "mobile-e2e",
        selectedDesktopId: "desktop-lan",
        selectedRepoId: null,
        selectedTaskId: null,
        activeView: "desktops" as const,
        trustedDesktops: [{
          desktopId: "desktop-lan",
          displayName: "LAN Mac",
          lanEndpoints: [],
          lastSeenAt: "2026-07-17T00:00:00.000Z"
        }]
      }),
      save: vi.fn(async (context) => {
        if (context.trustedDesktops?.length === 0) {
          removalAttempts += 1;
          if (removalAttempts === 1) throw new Error("storage unavailable");
        }
      })
    };
    const app = createAppModel({
      authSession: createSignedOutAuthSession(),
      persistence,
      options: {
        bonjourBrowser: createStaticBonjourBrowser([]),
        forceCloud: false,
        relayUrl: null
      }
    });
    await app.initialize();

    await expect(
      app.controller.removeManualMachine("desktop-lan")
    ).rejects.toThrow("storage unavailable");
    expect(app.sessionStore.getState().trustedDesktops).toHaveLength(1);

    await expect(
      app.controller.removeManualMachine("desktop-lan")
    ).resolves.toBeUndefined();
    expect(removalAttempts).toBeGreaterThanOrEqual(2);
    expect(app.sessionStore.getState().trustedDesktops).toEqual([]);
  });
});

function response(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => value
  } as Response;
}
