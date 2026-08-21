import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppModel } from "./appModel";
import type { KannaClient } from "./lib/api/client";
import { createMobileController } from "./state/mobileController";
import { createSessionStore } from "./state/sessionStore";
import { MOBILE_E2E_IDS } from "./e2eTestIds";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));

const harness = vi.hoisted(() => ({
  alert: vi.fn(),
  appStateListener: null as ((state: string) => void) | null,
  addMobileCrashBreadcrumb: vi.fn(),
  checkAndFetchUpdate: vi.fn().mockResolvedValue({ state: "up-to-date" }),
  captureMobileCrashDiagnostic: vi.fn(() => ({ id: "diagnostic-test" })),
  currentAppState: "background",
  currentModel: null as AppModel | null,
  quickReplyPreferences: {
    load: vi.fn(),
    save: vi.fn()
  },
  reloadToApplyUpdate: vi.fn().mockResolvedValue(undefined),
  updateMobileCrashContext: vi.fn(),
  requestMobileAccountDeletion: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    Alert: { alert: harness.alert },
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
    Modal: ({
      visible,
      children,
      ...props
    }: {
      visible: boolean;
      children?: import("react").ReactNode;
      [key: string]: unknown;
    }) => visible ? ReactModule.createElement("Modal", props, children) : null,
    Platform: { OS: "ios" },
    Pressable: "Pressable",
    SafeAreaView: "SafeAreaView",
    StyleSheet: {
      absoluteFill: "absoluteFill",
      create: <T extends Record<string, unknown>>(styles: T) => styles
    },
    Text: "Text",
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
  reloadToApplyUpdate: (...args: unknown[]) => harness.reloadToApplyUpdate(...args)
}));

vi.mock("./lib/firebase/accountDeletion", () => ({
  requestMobileAccountDeletion: harness.requestMobileAccountDeletion
}));

vi.mock("./lib/diagnostics/mobileCrashDiagnostics", () => ({
  addMobileCrashBreadcrumb: harness.addMobileCrashBreadcrumb,
  captureMobileCrashDiagnostic: harness.captureMobileCrashDiagnostic,
  formatMobileCrashDiagnostics: (diagnostics: unknown) =>
    JSON.stringify(diagnostics),
  updateMobileCrashContext: harness.updateMobileCrashContext
}));

vi.mock("./state/taskQuickReplyPreferences", () => ({
  createDefaultTaskQuickReplyPreferences: vi.fn(async () =>
    harness.quickReplyPreferences
  )
}));

vi.mock("./navigation/RootNavigator", () => ({
  default: "RootNavigator"
}));
vi.mock("./components/AccountBadge", () => ({ AccountBadge: "AccountBadge" }));
vi.mock("./components/AccountSheet", () => ({ AccountSheet: "AccountSheet" }));
vi.mock("./components/QuickReplyEditorModal", () => ({
  QuickReplyEditorModal: "QuickReplyEditorModal"
}));
vi.mock("./components/CreateTaskComposer", () => ({
  CreateTaskComposer: "CreateTaskComposer"
}));
vi.mock("./components/FloatingToolbar", () => ({
  FloatingToolbar: "FloatingToolbar"
}));
vi.mock("./components/LoadingText", () => ({
  LoadingText: "LoadingText"
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
  harness.alert.mockReset();
  harness.appStateListener = null;
  harness.addMobileCrashBreadcrumb.mockReset();
  harness.checkAndFetchUpdate.mockReset().mockResolvedValue({ state: "up-to-date" });
  harness.currentAppState = "background";
  harness.currentModel = null;
  harness.quickReplyPreferences.load
    .mockReset()
    .mockResolvedValue({
      status: "loaded",
      replies: [{ id: "sgtm-proceed", text: "SGTM. Proceed." }]
    });
  harness.quickReplyPreferences.save.mockReset().mockImplementation(
    async (replies: Array<{ id: string; text: string }>) => replies
  );
  harness.reloadToApplyUpdate.mockReset().mockResolvedValue(undefined);
  harness.requestMobileAccountDeletion.mockReset().mockResolvedValue(undefined);
  harness.updateMobileCrashContext.mockReset();
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

function createClientMock(): KannaClient {
  return {
    getStatus: vi.fn().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      pairingCode: null
    }),
    listDesktops: vi.fn().mockResolvedValue([]),
    listRepos: vi.fn().mockResolvedValue([]),
    listRepoTasks: vi.fn().mockResolvedValue([]),
    listRecentTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    runMergeAgent: vi.fn(),
    advanceTaskStage: vi.fn(),
    markTaskRead: vi.fn(),
    closeTask: vi.fn(),
    sendTaskInput: vi.fn(),
    readTaskFile: vi.fn(),
    resolveTaskFileMentions: vi.fn(),
    readTaskDiff: vi.fn(),
    observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
    observeTaskAgent: vi.fn(() => ({
      close: vi.fn(),
      interrupt: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn()
    })),
    createPairingSession: vi.fn()
  } as KannaClient;
}

function createModel() {
  const sessionStore = createSessionStore();
  const controller = createMobileController(createClientMock(), sessionStore);
  const model = {
    client: createClientMock(),
    controller,
    getAuthIdToken: vi.fn().mockResolvedValue(null),
    initialize: vi.fn().mockResolvedValue(undefined),
    navigator: { tabs: [], utilityActions: [] },
    sessionStore,
    setForceCloud: vi.fn(),
    setForeground: vi.fn()
  } as unknown as AppModel;
  harness.currentModel = model;
  return { controller, model, sessionStore };
}

async function mountModel(model: AppModel): Promise<ReactTestRenderer> {
  harness.currentModel = model;
  await act(async () => {
    mounted = create(<App />);
    await flushMicrotasks();
  });
  return mounted!;
}

describe("App component wiring", () => {
  it("deletes through the callable and signs out locally", async () => {
    const { model, controller } = createModel();
    const signOut = vi.spyOn(controller, "signOut").mockResolvedValue(undefined);
    const renderer = await mountModel(model);
    const accountSheet = renderer.root.findByType("AccountSheet");

    await act(async () => accountSheet.props.onDeleteAccount());

    expect(harness.requestMobileAccountDeletion).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("mounts navigation only after hydration and restores Activity beneath task detail", async () => {
    const initialized = deferred<void>();
    const { model, sessionStore } = createModel();
    sessionStore.setActiveView("recent");
    sessionStore.setSelectedTask("task-activity");
    model.initialize.mockReturnValueOnce(initialized.promise);

    const renderer = await mountModel(model);
    expect(renderer.root.findAllByType("RootNavigator")).toHaveLength(0);
    expect(renderer.root.findByType("LoadingText").props).toMatchObject({
      label: "Starting Kanna",
      testID: MOBILE_E2E_IDS.appStartupLoading
    });

    await act(async () => {
      initialized.resolve();
      await flushMicrotasks();
    });

    const navigator = renderer.root.findByType("RootNavigator");
    expect(renderer.root.findAllByType("LoadingText")).toHaveLength(0);
    expect(navigator.props.initialState.routes.map((route: { name: string }) => route.name))
      .toEqual(["MainTabs", "TaskDetail"]);
    expect(navigator.props.initialState.routes[0].state.routes[1].name)
      .toBe("Activity");
    expect(navigator.props.initialState.routes[0].state.index).toBe(1);
  });

  it("mounts safe navigation state when initialization rejects", async () => {
    const initialized = deferred<void>();
    const { model } = createModel();
    model.initialize.mockReturnValueOnce(initialized.promise);

    const renderer = await mountModel(model);
    expect(renderer.root.findAllByType("RootNavigator")).toHaveLength(0);

    await act(async () => {
      initialized.reject(new Error("storage unavailable"));
      await flushMicrotasks();
    });

    expect(renderer.root.findByType("RootNavigator").props.initialState.routes)
      .toEqual([
        {
          name: "MainTabs",
          state: {
            index: 0,
            routes: [
              { name: "Tasks" },
              { name: "Activity" },
              { name: "More" }
            ]
          }
        }
      ]);
  });

  it("forwards accepted task snapshots for detail synchronization", async () => {
    const previous = process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED;
    process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED = "1";
    try {
      const { model, sessionStore } = createModel();
      sessionStore.setRecentTasks([
        {
          id: "task-1",
          repoId: "repo-1",
          title: "Accepted task",
          stage: "review"
        }
      ]);

      const renderer = await mountModel(model);
      expect(renderer.root.findByType("RootNavigator").props.e2eTaskSnapshotMarker)
        .toContain("task-1:Accepted task");
    } finally {
      if (previous === undefined) {
        delete process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED;
      } else {
        process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED = previous;
      }
    }
  });

  it("opens the canonical Machines route from the deduplicated profile summary", async () => {
    const { model, sessionStore } = createModel();
    sessionStore.setMachineSourceDesktops({
      account: [{ id: "desktop-1", name: "Studio Mac", online: true, mode: "remote" }],
      local: [{ id: "desktop-1", name: "Studio Mac", online: true, mode: "lan" }]
    });
    sessionStore.setTrustedDesktops([{
      desktopId: "desktop-1",
      displayName: "Studio Mac",
      sharedSecret: "secret",
      lanEndpoints: [],
      lastSeenAt: "2026-07-17T00:00:00.000Z"
    }]);

    const renderer = await mountModel(model);
    const accountSheet = renderer.root.findByType("AccountSheet");
    expect(accountSheet.props.machineCount).toBe(1);
    expect(accountSheet.props.availableMachineCount).toBe(1);

    await act(async () => accountSheet.props.onOpenMachines());

    expect(renderer.root.findByType("RootNavigator").props.openMachinesRequestKey)
      .toBe(1);
  });

  it("keeps quick replies gated until device preferences hydrate", async () => {
    const loaded = deferred<{
      status: "loaded";
      replies: Array<{ id: string; text: string }>;
    }>();
    harness.quickReplyPreferences.load.mockReturnValueOnce(loaded.promise);
    const { model } = createModel();
    const renderer = await mountModel(model);

    expect(renderer.root.findByType("RootNavigator").props).toMatchObject({
      quickReplies: [{ id: "sgtm-proceed", text: "SGTM. Proceed." }],
      quickRepliesHydrated: false
    });
    expect(renderer.root.findByType("AccountSheet").props.quickRepliesReady)
      .toBe(false);

    await act(async () => {
      loaded.resolve({
        status: "loaded",
        replies: [{ id: "custom", text: "Ship it." }]
      });
      await flushMicrotasks();
    });

    expect(renderer.root.findByType("RootNavigator").props).toMatchObject({
      quickReplies: [{ id: "custom", text: "Ship it." }],
      quickRepliesHydrated: true
    });
    expect(renderer.root.findByType("AccountSheet").props.quickRepliesReady)
      .toBe(true);
  });

  it("opens the editor from Account and publishes replies only after save", async () => {
    const { model } = createModel();
    const renderer = await mountModel(model);
    const navigator = renderer.root.findByType("RootNavigator");

    await act(async () => navigator.props.onOpenAccount());
    let accountSheet = renderer.root.findByType("AccountSheet");
    expect(accountSheet.props.visible).toBe(true);

    await act(async () => accountSheet.props.onOpenQuickReplies());
    accountSheet = renderer.root.findByType("AccountSheet");
    const editor = renderer.root.findByType("QuickReplyEditorModal");
    expect(accountSheet.props.visible).toBe(false);
    expect(editor.props.visible).toBe(true);

    const editedReplies = [{ id: "custom", text: "Ship it." }];
    await act(async () => {
      await editor.props.onSave(editedReplies);
      await flushMicrotasks();
    });

    expect(harness.quickReplyPreferences.save).toHaveBeenCalledWith(
      editedReplies,
      { confirmReplacement: false }
    );
    expect(renderer.root.findByType("RootNavigator").props.quickReplies).toEqual(
      editedReplies
    );
  });

  it("saves the complete loaded quick-reply list without narrowing it", async () => {
    const loadedReplies = [
      { id: "first", text: "First" },
      { id: "second", text: "Second" },
      { id: "third", text: "Third" }
    ];
    harness.quickReplyPreferences.load.mockResolvedValueOnce({
      status: "loaded",
      replies: loadedReplies
    });
    const { model } = createModel();
    const renderer = await mountModel(model);
    const editor = renderer.root.findByType("QuickReplyEditorModal");

    expect(editor.props.replies).toEqual(loadedReplies);
    await act(async () => {
      await editor.props.onSave(loadedReplies);
      await flushMicrotasks();
    });

    expect(harness.quickReplyPreferences.save).toHaveBeenCalledWith(
      loadedReplies,
      { confirmReplacement: false }
    );
    expect(renderer.root.findByType("RootNavigator").props.quickReplies).toEqual(
      loadedReplies
    );
  });

  it("refuses to save before preference hydration resolves", async () => {
    const loaded = deferred<{
      status: "loaded";
      replies: Array<{ id: string; text: string }>;
    }>();
    harness.quickReplyPreferences.load.mockReturnValueOnce(loaded.promise);
    const { model } = createModel();
    const renderer = await mountModel(model);
    const editor = renderer.root.findByType("QuickReplyEditorModal");
    const editedReplies = [{ id: "custom", text: "Ship it." }];

    await expect(editor.props.onSave(editedReplies)).rejects.toThrow(
      /before preferences finish loading/i
    );
    expect(harness.quickReplyPreferences.save).not.toHaveBeenCalled();
    await act(async () => {
      loaded.resolve({
        status: "loaded",
        replies: [{ id: "old", text: "Old stored reply" }]
      });
      await flushMicrotasks();
    });

    expect(renderer.root.findByType("RootNavigator").props.quickReplies).toEqual(
      [{ id: "old", text: "Old stored reply" }]
    );
    expect(renderer.root.findByType("RootNavigator").props.quickRepliesHydrated)
      .toBe(true);
  });

  it("shows a non-blocking notice when preference hydration rejects", async () => {
    harness.quickReplyPreferences.load.mockRejectedValueOnce(
      new Error("storage unavailable")
    );
    const { model } = createModel();
    const renderer = await mountModel(model);

    expect(renderer.root.findByType("RootNavigator").props).toMatchObject({
      quickReplies: [{ id: "sgtm-proceed", text: "SGTM. Proceed." }],
      quickRepliesHydrated: true
    });
    expect(
      renderer.root.findByProps({
        testID: "mobile.quick-replies.load-notice"
      }).props.children.props.children
    ).toBe("Quick replies could not be loaded; defaults shown.");
    expect(
      renderer.root.findByType("QuickReplyEditorModal").props
        .replacementConfirmationRequired
    ).toBe(true);
  });

  it("requires confirmation after a failed load and clears the notice after replacement", async () => {
    harness.quickReplyPreferences.load.mockResolvedValueOnce({
      status: "failed",
      replies: [{ id: "sgtm-proceed", text: "SGTM. Proceed." }]
    });
    const { model } = createModel();
    const renderer = await mountModel(model);
    const editor = renderer.root.findByType("QuickReplyEditorModal");
    const editedReplies = [{ id: "custom", text: "Ship it." }];

    await expect(editor.props.onSave(editedReplies)).rejects.toThrow(
      /without confirmation/i
    );
    expect(harness.quickReplyPreferences.save).not.toHaveBeenCalled();

    await act(async () => {
      await editor.props.onSave(editedReplies, true);
      await flushMicrotasks();
    });

    expect(harness.quickReplyPreferences.save).toHaveBeenCalledWith(
      editedReplies,
      { confirmReplacement: true }
    );
    expect(
      renderer.root.findAllByProps({
        testID: "mobile.quick-replies.load-notice"
      })
    ).toHaveLength(0);
  });

  it("keeps the live list unchanged when preference save rejects", async () => {
    harness.quickReplyPreferences.save.mockRejectedValueOnce(
      new Error("disk full")
    );
    const { model } = createModel();
    const renderer = await mountModel(model);
    const editor = renderer.root.findByType("QuickReplyEditorModal");

    await expect(
      editor.props.onSave([{ id: "custom", text: "Ship it." }])
    ).rejects.toThrow("disk full");
    expect(renderer.root.findByType("RootNavigator").props.quickReplies).toEqual(
      [{ id: "sgtm-proceed", text: "SGTM. Proceed." }]
    );
  });

  it("routes the canonical More diagnostics toggle through the app model", async () => {
    const { controller, model } = createModel();
    const refresh = vi.spyOn(controller, "refresh").mockResolvedValue(undefined);
    const renderer = await mountModel(model);

    await act(async () => {
      renderer.root.findByType("RootNavigator").props.onForceCloudChange(true);
      await flushMicrotasks();
    });

    expect(model.setForceCloud).toHaveBeenCalledWith(true);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["idle", "error"] as const)(
    "refreshes from %s when the app returns to the foreground",
    async (connectionState) => {
      const { controller, model, sessionStore } = createModel();
      sessionStore.setConnectionState(connectionState);
      const refresh = vi.spyOn(controller, "refresh").mockResolvedValue(undefined);
      await mountModel(model);

      await act(async () => {
        harness.appStateListener?.("active");
        await flushMicrotasks();
      });

      expect(refresh).toHaveBeenCalledOnce();
      expect(model.setForeground).toHaveBeenNthCalledWith(1, false);
      expect(model.setForeground).toHaveBeenLastCalledWith(true);
      expect(harness.addMobileCrashBreadcrumb).toHaveBeenCalledWith(
        "app-state",
        "background->active action=refresh"
      );
      expect(harness.updateMobileCrashContext).toHaveBeenCalledWith(
        expect.objectContaining({
          appState: "background",
          connectionState,
          forceCloudEnabled: false,
          terminalOutputChars: 0
        })
      );
    }
  );

  it("reloads a downloaded OTA on foreground without starting recovery", async () => {
    const { controller, model, sessionStore } = createModel();
    sessionStore.setConnectionState("error");
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
