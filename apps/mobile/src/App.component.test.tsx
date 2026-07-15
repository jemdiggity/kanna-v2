import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppModel } from "./appModel";
import { MOBILE_E2E_IDS } from "./e2eTestIds";
import {
  TaskCreationError,
  type KannaClient
} from "./lib/api/client";
import { createMobileController } from "./state/mobileController";
import { createSessionStore } from "./state/sessionStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  appStateListener: null as ((state: string) => void) | null,
  checkAndFetchUpdate: vi.fn().mockResolvedValue({ state: "up-to-date" }),
  currentAppState: "background",
  currentModel: null as AppModel | null,
  reloadToApplyUpdate: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    ActivityIndicator: "ActivityIndicator",
    AppState: {
      get currentState() {
        return harness.currentAppState;
      },
      addEventListener: vi.fn(
        (_event: string, listener: (state: string) => void) => {
          harness.appStateListener = listener;
          return { remove: vi.fn() };
        }
      )
    },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Modal: ({
      visible,
      children,
      ...props
    }: {
      visible: boolean;
      children?: import("react").ReactNode;
      [key: string]: unknown;
    }) => visible
      ? ReactModule.createElement("Modal", props, children)
      : null,
    Platform: { OS: "ios" },
    Pressable: "Pressable",
    SafeAreaView: "SafeAreaView",
    StyleSheet: {
      absoluteFill: "absoluteFill",
      create: <T extends Record<string, unknown>>(styles: T) => styles
    },
    Text: "Text",
    TextInput: "TextInput",
    View: "View"
  };
});

vi.mock("./appModel", () => ({
  createAppModel: vi.fn(() => {
    if (!harness.currentModel) throw new Error("App component model was not set");
    return harness.currentModel;
  }),
  resolveForceCloud: vi.fn(() => false)
}));

vi.mock("./lib/updates/otaUpdates", () => ({
  checkAndFetchUpdate: (...args: unknown[]) => harness.checkAndFetchUpdate(...args),
  getCurrentUpdateInfo: vi.fn(() => ({
    enabled: false,
    updateId: null,
    runtimeVersion: null,
    channel: null
  })),
  reloadToApplyUpdate: (...args: unknown[]) => harness.reloadToApplyUpdate(...args)
}));

vi.mock("./components/AccountBadge", () => ({ AccountBadge: "AccountBadge" }));
vi.mock("./components/AccountSheet", () => ({ AccountSheet: "AccountSheet" }));
vi.mock("./components/FloatingToolbar", () => ({
  FloatingToolbar: "FloatingToolbar"
}));
vi.mock("./components/UpdateReadyBanner", () => ({
  UpdateReadyBanner: "UpdateReadyBanner"
}));
vi.mock("./screens/DesktopsScreen", () => ({ DesktopsScreen: "DesktopsScreen" }));
vi.mock("./screens/MoreScreen", () => ({ MoreScreen: "MoreScreen" }));
vi.mock("./screens/SearchScreen", () => ({ SearchScreen: "SearchScreen" }));
vi.mock("./screens/TaskScreen", () => ({ TaskScreen: "TaskScreen" }));
vi.mock("./screens/TasksScreen", () => ({ TasksScreen: "TasksScreen" }));

import App from "./App";

let mounted: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("__DEV__", false);
  harness.appStateListener = null;
  harness.checkAndFetchUpdate.mockReset().mockResolvedValue({ state: "up-to-date" });
  harness.currentAppState = "background";
  harness.currentModel = null;
  harness.reloadToApplyUpdate.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.unmount());
    mounted = null;
  }
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(iterations = 6): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createClientMock() {
  return {
    getStatus: vi.fn<KannaClient["getStatus"]>().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      pairingCode: null
    }),
    listDesktops: vi.fn<KannaClient["listDesktops"]>().mockResolvedValue([
      { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" }
    ]),
    listRepos: vi.fn<KannaClient["listRepos"]>().mockResolvedValue([
      { id: "repo-1", name: "Repo One" }
    ]),
    listRepoTasks: vi.fn<KannaClient["listRepoTasks"]>().mockResolvedValue([]),
    listRecentTasks: vi.fn<KannaClient["listRecentTasks"]>().mockResolvedValue([]),
    searchTasks: vi.fn<KannaClient["searchTasks"]>().mockResolvedValue([]),
    createTask: vi.fn<KannaClient["createTask"]>().mockResolvedValue({
      taskId: "0123456789abcdef0123456789abcdef",
      repoId: "repo-1",
      title: "Ship mobile shell",
      stage: "in progress"
    }),
    runMergeAgent: vi.fn<KannaClient["runMergeAgent"]>().mockResolvedValue({
      taskId: "merge-task"
    }),
    advanceTaskStage: vi.fn<KannaClient["advanceTaskStage"]>().mockResolvedValue({
      taskId: "advanced-task"
    }),
    markTaskRead: vi.fn<KannaClient["markTaskRead"]>().mockResolvedValue({
      taskId: "task-1",
      activity: "idle"
    }),
    closeTask: vi.fn<KannaClient["closeTask"]>().mockResolvedValue(undefined),
    sendTaskInput: vi.fn<KannaClient["sendTaskInput"]>().mockResolvedValue(undefined),
    observeTaskTerminal: vi.fn<KannaClient["observeTaskTerminal"]>(() => ({
      close: vi.fn()
    })),
    observeTaskAgent: vi.fn<KannaClient["observeTaskAgent"]>(() => ({
      close: vi.fn(),
      interrupt: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn()
    })),
    createPairingSession: vi.fn<KannaClient["createPairingSession"]>().mockResolvedValue({
      code: "ABC123",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      expiresAtUnixMs: 1
    })
  } satisfies KannaClient;
}

function createModel(connectionState: "connected" | "idle" | "error" = "connected") {
  const sessionStore = createSessionStore();
  sessionStore.setConnectionState(connectionState);
  sessionStore.setDesktops([
    { id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" }
  ]);
  sessionStore.setRepos([{ id: "repo-1", name: "Repo One" }]);
  sessionStore.selectDesktop("desktop-1");
  sessionStore.selectRepo("repo-1");
  const client = createClientMock();
  const controller = createMobileController(client, sessionStore, undefined, {
    createTaskId: () => "0123456789abcdef0123456789abcdef",
    persistSessionContext: vi.fn().mockResolvedValue(undefined)
  });
  const model = {
    client,
    controller,
    initialize: vi.fn().mockResolvedValue(undefined),
    navigator: { tabs: [], utilityActions: [] } as AppModel["navigator"],
    sessionStore,
    setForceCloud: vi.fn()
  } satisfies AppModel;
  harness.currentModel = model;
  return { client, controller, model, sessionStore };
}

async function mountModel(model: AppModel): Promise<ReactTestRenderer> {
  harness.currentModel = model;
  await act(async () => {
    mounted = create(<App />);
    await flushMicrotasks();
  });
  return mounted!;
}

function hasTestId(root: ReactTestInstance, testID: string): boolean {
  return root.findAll((node) => node.props.testID === testID).length > 0;
}

function findTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  return root.find((node) => node.props.testID === testID);
}

function textContent(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((child) => textContent(child)).join("");
}

function hasText(root: ReactTestInstance, text: string): boolean {
  return root.findAll(
    (node) => node.type === "Text" && textContent(node) === text
  ).length > 0;
}

function runEffects(): void {
  const effects = [...harness.effects];
  harness.effects.length = 0;
  for (const effect of effects) effect();
}

describe("App component wiring", () => {
  it("creates tasks with geometry derived from the measured task-detail surface", async () => {
    const { controller, model } = createModel("connected");
    controller.openComposer();
    controller.updateComposerPrompt("Measure the initial terminal");
    const createTask = vi.spyOn(controller, "createTask");
    const renderer = await mountModel(model);
    const shell = renderer.root.find(
      (node) => typeof node.props.onLayout === "function"
    );

    await act(async () => {
      shell.props.onLayout({
        nativeEvent: {
          layout: { width: 1024, height: 1366, x: 0, y: 0 }
        }
      });
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskSubmitButton)
        .props.onPress();
    });

    expect(createTask).toHaveBeenCalledWith({ cols: 128, rows: 72 });
  });

  it("exposes the accepted task snapshot to detail-only E2E synchronization", async () => {
    const previous = process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED;
    process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED = "1";
    try {
      const { model, sessionStore } = createModel();
      sessionStore.setRecentTasks([
        {
          id: "cloud-only",
          repoId: "repo-cloud",
          title: "Cloud task refreshed",
          stage: "in progress"
        },
        {
          id: "lan-only",
          repoId: "repo-lan",
          title: "LAN-only task",
          stage: "review"
        }
      ]);
      sessionStore.setSelectedTask("lan-only");

      const renderer = await mountModel(model);
      const taskScreen = renderer.root.findByType("TaskScreen");

      expect(taskScreen.props.e2eTaskSnapshotMarker).toContain(
        "cloud-only:Cloud task refreshed"
      );
    } finally {
      if (previous === undefined) {
        delete process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED;
      } else {
        process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED = previous;
      }
    }
  });

  it.each(["connected", "idle", "error"] as const)(
    "keeps shell controls visible for an unresolved selection while %s",
    async (connectionState) => {
      const { model, sessionStore } = createModel(connectionState);
      sessionStore.setSelectedTask("missing-persisted-task");

      const renderer = await mountModel(model);

      expect(renderer.root.findAllByType("TasksScreen")).toHaveLength(1);
      expect(renderer.root.findAllByType("AccountBadge")).toHaveLength(1);
      expect(renderer.root.findAllByType("FloatingToolbar")).toHaveLength(1);
      expect(renderer.root.findAllByType("TaskScreen")).toHaveLength(0);
    }
  );

  it.each(["idle", "error"] as const)(
    "refreshes from %s when the app returns to the foreground",
    async (connectionState) => {
      const { controller, model } = createModel(connectionState);
      const refresh = vi.spyOn(controller, "refresh").mockResolvedValue(undefined);
      await mountModel(model);

      await act(async () => {
        harness.appStateListener?.("active");
        await flushMicrotasks();
      });

      expect(refresh).toHaveBeenCalledOnce();
    }
  );

  it("reloads a downloaded OTA on foreground without starting recovery", async () => {
    const { controller, model } = createModel("error");
    const refresh = vi.spyOn(controller, "refresh").mockResolvedValue(undefined);
    harness.checkAndFetchUpdate.mockResolvedValue({ state: "downloaded" });
    await mountModel(model);

    await act(async () => {
      harness.appStateListener?.("active");
      await flushMicrotasks();
    });

    expect(harness.reloadToApplyUpdate).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("App task provisioning integration", () => {
  it("shows frozen provisioning, backgrounds safely, then opens the created task", async () => {
    const pendingCreate = deferred<Awaited<ReturnType<KannaClient["createTask"]>>>();
    const { client, controller, model } = createModel();
    client.createTask.mockReturnValueOnce(pendingCreate.promise);
    const renderer = await mountModel(model);

    await act(async () => controller.openComposer());
    await act(async () => {
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskPromptInput)
        .props.onChangeText("Ship mobile shell");
    });
    await act(async () => {
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskSubmitButton)
        .props.onPress();
      await flushMicrotasks();
    });

    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskProvisioning)).toBe(true);
    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskPromptInput)).toBe(false);
    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskSubmitButton)).toBe(false);
    expect(hasText(renderer.root, "Cancel")).toBe(false);
    expect(client.createTask).toHaveBeenCalledWith({
      taskId: "0123456789abcdef0123456789abcdef",
      repoId: "repo-1",
      prompt: "Ship mobile shell",
      desktopId: "desktop-1",
      agentProvider: "claude",
      agentType: "pty",
      terminalCols: 80,
      terminalRows: 48
    });

    await act(async () => {
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskProvisioningBackground)
        .props.onPress();
    });
    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskProvisioning)).toBe(false);

    await act(async () => controller.openComposer());
    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskProvisioning)).toBe(true);
    expect(client.createTask).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingCreate.resolve({
        taskId: "0123456789abcdef0123456789abcdef",
        repoId: "repo-1",
        title: "Ship mobile shell",
        stage: "in progress"
      });
      await flushMicrotasks();
    });

    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskProvisioning)).toBe(false);
    const taskScreen = renderer.root.findByType("TaskScreen");
    expect(taskScreen.props.task).toMatchObject({
      id: "0123456789abcdef0123456789abcdef",
      title: "Ship mobile shell"
    });
  });

  it("keeps an ambiguous result non-editable and recovers the same durable identity", async () => {
    const firstCreate = deferred<Awaited<ReturnType<KannaClient["createTask"]>>>();
    const { client, controller, model } = createModel();
    client.createTask
      .mockReturnValueOnce(firstCreate.promise)
      .mockResolvedValueOnce({
        taskId: "0123456789abcdef0123456789abcdef",
        repoId: "repo-1",
        title: "Recovered task",
        stage: "in progress"
      });
    const renderer = await mountModel(model);

    await act(async () => controller.openComposer());
    await act(async () => {
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskPromptInput)
        .props.onChangeText("Recover this task");
    });
    await act(async () => {
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskSubmitButton)
        .props.onPress();
      await flushMicrotasks();
    });
    await act(async () => {
      firstCreate.reject(new Error("Relay response was lost"));
      await flushMicrotasks();
    });

    expect(hasText(renderer.root, "Task result unknown")).toBe(true);
    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskPromptInput)).toBe(false);
    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskSubmitButton)).toBe(false);

    await act(async () => {
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskProvisioningRecover)
        .props.onPress();
      await flushMicrotasks();
    });

    expect(client.createTask).toHaveBeenCalledTimes(2);
    const taskIds = client.createTask.mock.calls.map(([request]) => request.taskId);
    expect(taskIds).toEqual([
      "0123456789abcdef0123456789abcdef",
      "0123456789abcdef0123456789abcdef"
    ]);
    expect(renderer.root.findByType("TaskScreen").props.task).toMatchObject({
      id: "0123456789abcdef0123456789abcdef",
      title: "Recovered task"
    });
  });

  it("restores the exact editable draft after a definite pre-creation failure", async () => {
    const { client, controller, model } = createModel();
    client.createTask.mockRejectedValueOnce(
      new TaskCreationError("not-created", "Desktop rejected the request")
    );
    const renderer = await mountModel(model);

    await act(async () => controller.openComposer());
    await act(async () => {
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskPromptInput)
        .props.onChangeText("Fix and retry");
    });
    await act(async () => {
      findTestId(renderer.root, MOBILE_E2E_IDS.createTaskSubmitButton)
        .props.onPress();
      await flushMicrotasks();
    });

    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskProvisioning)).toBe(false);
    expect(findTestId(renderer.root, MOBILE_E2E_IDS.createTaskPromptInput).props.value)
      .toBe("Fix and retry");
    expect(hasTestId(renderer.root, MOBILE_E2E_IDS.createTaskSubmitButton)).toBe(true);
    expect(hasText(renderer.root, "Desktop rejected the request")).toBe(true);
    expect(client.createTask).toHaveBeenCalledTimes(1);
  });
});
