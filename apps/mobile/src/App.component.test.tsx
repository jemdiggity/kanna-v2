import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppModel } from "./appModel";
import { createSessionStore } from "./state/sessionStore";

interface ElementNode {
  type: unknown;
  props?: { children?: unknown };
}

const harness = vi.hoisted(() => ({
  appStateListener: null as ((state: string) => void) | null,
  checkAndFetchUpdate: vi.fn().mockResolvedValue({ state: "up-to-date" }),
  currentAppState: "background",
  currentModel: null as AppModel | null,
  effects: [] as Array<() => void | (() => void)>,
  hookIndex: 0,
  refs: [] as Array<{ current: unknown }>,
  reloadToApplyUpdate: vi.fn().mockResolvedValue(undefined),
  stateSetters: [] as Array<ReturnType<typeof vi.fn>>
}));

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return {
    ...actual,
    useCallback: vi.fn((callback: unknown) => callback),
    useEffect: vi.fn((callback: () => void | (() => void)) => {
      harness.effects.push(callback);
    }),
    useRef: vi.fn((initialValue: unknown) => {
      const index = harness.hookIndex++;
      harness.refs[index] ??= { current: initialValue };
      return harness.refs[index];
    }),
    useState: vi.fn((initialValue: unknown) => {
      const value = typeof initialValue === "function"
        ? (initialValue as () => unknown)()
        : initialValue;
      const setter = vi.fn();
      harness.stateSetters.push(setter);
      return [value, setter];
    }),
    useSyncExternalStore: vi.fn(
      (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot()
    )
  };
});

vi.mock("react-native", () => ({
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
  SafeAreaView: "SafeAreaView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

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
vi.mock("./components/CreateTaskComposer", () => ({
  CreateTaskComposer: "CreateTaskComposer"
}));
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

let App: typeof import("./App").default;

beforeAll(async () => {
  App = (await import("./App")).default;
});

beforeEach(() => {
  vi.stubGlobal("__DEV__", false);
  harness.appStateListener = null;
  harness.checkAndFetchUpdate.mockReset().mockResolvedValue({ state: "up-to-date" });
  harness.currentAppState = "background";
  harness.effects.length = 0;
  harness.hookIndex = 0;
  harness.refs.length = 0;
  harness.reloadToApplyUpdate.mockReset().mockResolvedValue(undefined);
  harness.stateSetters.length = 0;
});

function createModel(connectionState: "connected" | "idle" | "error") {
  const sessionStore = createSessionStore();
  sessionStore.setConnectionState(connectionState);
  sessionStore.setSelectedTask("missing-persisted-task");
  const controller = {
    refresh: vi.fn().mockResolvedValue(undefined),
    closeTask: vi.fn(),
    showView: vi.fn(),
    selectRepo: vi.fn(),
    openTask: vi.fn(),
    sendTaskInput: vi.fn(),
    interruptTaskAgent: vi.fn(),
    sendTaskAgentPermission: vi.fn(),
    selectDesktop: vi.fn(),
    connectLocal: vi.fn(),
    openComposer: vi.fn(),
    advanceDesktopTaskStage: vi.fn(),
    runMergeAgent: vi.fn(),
    closeDesktopTask: vi.fn(),
    selectComposerDesktop: vi.fn(),
    selectComposerAgentProvider: vi.fn(),
    setComposerOptionsExpanded: vi.fn(),
    updateComposerPrompt: vi.fn(),
    createTask: vi.fn(),
    signInWithEmailPassword: vi.fn(),
    signOut: vi.fn()
  };
  const model = {
    client: {} as AppModel["client"],
    controller: controller as unknown as AppModel["controller"],
    initialize: vi.fn().mockResolvedValue(undefined),
    navigator: {
      tabs: [],
      utilityActions: []
    } as unknown as AppModel["navigator"],
    sessionStore,
    setForceCloud: vi.fn()
  } satisfies AppModel;
  harness.currentModel = model;
  return { controller, model };
}

function renderApp(): ElementNode {
  harness.hookIndex = 0;
  harness.effects.length = 0;
  return App() as ElementNode;
}

function renderedTypes(node: unknown): unknown[] {
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<{ children?: unknown }>;
  return [
    element.type,
    ...React.Children.toArray(element.props.children).flatMap(renderedTypes)
  ];
}

function renderedElementByType(
  node: unknown,
  type: unknown
): React.ReactElement<Record<string, unknown>> | null {
  if (!React.isValidElement(node)) return null;
  const element = node as React.ReactElement<{
    children?: unknown;
    [key: string]: unknown;
  }>;
  if (element.type === type) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const match = renderedElementByType(child, type);
    if (match) return match;
  }
  return null;
}

function runEffects(): void {
  const effects = [...harness.effects];
  harness.effects.length = 0;
  for (const effect of effects) effect();
}

describe("App component wiring", () => {
  it("exposes the accepted task snapshot to detail-only E2E synchronization", () => {
    const previous = process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED;
    process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED = "1";
    try {
      const { model } = createModel("connected");
      model.sessionStore.setRecentTasks([
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
      model.sessionStore.setSelectedTask("lan-only");

      const taskScreen = renderedElementByType(renderApp(), "TaskScreen");

      expect(taskScreen?.props.e2eTaskSnapshotMarker).toContain(
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
    (connectionState) => {
      createModel(connectionState);

      const types = renderedTypes(renderApp());

      expect(types).toContain("TasksScreen");
      expect(types).toContain("AccountBadge");
      expect(types).toContain("FloatingToolbar");
      expect(types).not.toContain("TaskScreen");
    }
  );

  it.each(["idle", "error"] as const)(
    "refreshes from %s when the app returns to the foreground",
    async (connectionState) => {
      const { controller } = createModel(connectionState);
      renderApp();
      runEffects();
      await Promise.resolve();

      harness.appStateListener?.("active");

      expect(controller.refresh).toHaveBeenCalledOnce();
    }
  );

  it("reloads a downloaded OTA on foreground without starting recovery", async () => {
    const { controller } = createModel("error");
    harness.checkAndFetchUpdate.mockResolvedValue({ state: "downloaded" });
    renderApp();
    runEffects();
    await Promise.resolve();
    await Promise.resolve();

    harness.appStateListener?.("active");

    expect(harness.reloadToApplyUpdate).toHaveBeenCalledOnce();
    expect(controller.refresh).not.toHaveBeenCalled();
  });
});
