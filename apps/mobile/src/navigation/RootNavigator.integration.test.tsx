import React, { useEffect, useState } from "react";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import { showTaskActionMenu, type TaskAction } from "../screens/taskActionMenu";
import { DEFAULT_TASK_QUICK_REPLIES } from "../screens/taskQuickReplies";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_E2E_IDS } from "../e2eTestIds";
import type { KannaClient } from "../lib/api/client";
import type { TaskSummary } from "../lib/api/types";
import {
  createMobileController,
  type MobileController
} from "../state/mobileController";
import {
  createSessionStore,
  type SessionStore
} from "../state/sessionStore";
import { buildInitialNavigationState } from "./navigationState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigationHarness = vi.hoisted(() => ({
  onStateChange: null as ((state: unknown) => void) | null,
  applyStackAction: null as
    | ((action: {
        type: string;
        name: string;
        params?: { taskId?: string };
      }) => void)
    | null
}));

vi.mock("@expo/vector-icons", () => ({
  Ionicons: "Ionicons"
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Keyboard: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    dismiss: vi.fn()
  },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
  useWindowDimensions: () => ({ height: 800, width: 390 }),
  View: "View"
}));

vi.mock("@react-navigation/native", async () => {
  const ReactModule = await import("react");
  return {
    DefaultTheme: {
      dark: false,
      colors: {
        background: "rgb(242, 242, 242)",
        border: "rgb(216, 216, 216)",
        card: "rgb(255, 255, 255)",
        notification: "rgb(255, 59, 48)",
        primary: "rgb(0, 122, 255)",
        text: "rgb(28, 28, 30)"
      },
      fonts: {}
    },
    NavigationContainer: ({
      children,
      onStateChange
    }: {
      children?: React.ReactNode;
      onStateChange?(state: unknown): void;
    }) => {
      navigationHarness.onStateChange = onStateChange ?? null;
      return ReactModule.createElement(ReactModule.Fragment, null, children);
    },
    StackActions: {
      popTo: (name: string, params?: object) => ({ type: "POP_TO", name, params }),
      push: (name: string, params?: object) => ({ type: "PUSH", name, params }),
      replace: (name: string, params?: object) => ({ type: "REPLACE", name, params })
    },
    useFocusEffect: (effect: () => void | (() => void)) => {
      ReactModule.useEffect(effect, [effect]);
    },
    useIsFocused: () => true,
    useNavigationContainerRef: () => ReactModule.useRef({
      dispatch: vi.fn((action: {
        type: string;
        name: string;
        params?: { taskId?: string };
      }) => {
        navigationHarness.applyStackAction?.(action);
      }),
      getRootState: vi.fn(() => ({
        index: 0,
        routes: [{ key: "maintabs", name: "MainTabs" }]
      })),
      isReady: vi.fn(() => true)
    }).current
  };
});

vi.mock("@react-navigation/native-stack", async () => {
  const ReactModule = await import("react");
  const Screen = () => null;
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children }: { children?: React.ReactNode }) => {
        const screens = ReactModule.Children.toArray(children) as Array<
          React.ReactElement<{ component: React.ComponentType; name: string }>
        >;
        const [route, setRoute] = ReactModule.useState<{
          name: string;
          params?: { taskId?: string };
        }>({ name: "MainTabs", params: undefined });

        ReactModule.useEffect(() => {
          navigationHarness.applyStackAction = (action) => {
            if (
              action.type === "PUSH" ||
              action.type === "REPLACE" ||
              action.type === "POP_TO"
            ) {
              setRoute({ name: action.name, params: action.params });
            }
          };
          return () => {
            navigationHarness.applyStackAction = null;
          };
        }, []);

        const active =
          screens.find((screen) => screen.props.name === route.name) ??
          screens.find((screen) => screen.props.name === "MainTabs");
        if (!active) return null;
        const navigation = {
          canGoBack: () => route.name !== "MainTabs",
          goBack: () => {
            setRoute({ name: "MainTabs", params: undefined });
            navigationHarness.onStateChange?.({
              index: 0,
              routes: [{ name: "MainTabs" }]
            });
          },
          setParams: (params: { taskId?: string }) =>
            setRoute((current) => ({
              ...current,
              params: { ...current.params, ...params }
            }))
        };
        return ReactModule.createElement(active.props.component, {
          navigation,
          route: { key: route.name, name: route.name, params: route.params }
        });
      },
      Screen
    })
  };
});

vi.mock("@react-navigation/bottom-tabs", async () => {
  const ReactModule = await import("react");
  const Screen = () => null;
  return {
    createBottomTabNavigator: () => ({
      Navigator: ({
        children,
        tabBar
      }: {
        children?: React.ReactNode;
        tabBar(props: unknown): React.ReactNode;
      }) => {
        const screens = ReactModule.Children.toArray(children) as Array<
          React.ReactElement<{
            component: React.ComponentType;
            name: string;
          }>
        >;
        const [activeIndex, setActiveIndex] = ReactModule.useState(0);
        const routes = screens.map((screen) => ({
          key: screen.props.name.toLowerCase(),
          name: screen.props.name,
          params: undefined
        }));
        const navigation = {
          emit: vi.fn(() => ({ defaultPrevented: false })),
          navigate: (name: string) => {
            const nextIndex = routes.findIndex((route) => route.name === name);
            if (nextIndex < 0) return;
            setActiveIndex(nextIndex);
            navigationHarness.onStateChange?.({
              index: 0,
              routes: [{
                name: "MainTabs",
                state: { index: nextIndex, routes }
              }]
            });
          }
        };
        const activeScreen = screens[activeIndex];

        return ReactModule.createElement(
          ReactModule.Fragment,
          null,
          activeScreen
            ? ReactModule.createElement(activeScreen.props.component)
            : null,
          tabBar({
            descriptors: {},
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
            navigation,
            state: {
              history: [],
              index: activeIndex,
              key: "tabs",
              preloadedRouteKeys: [],
              routeNames: routes.map((route) => route.name),
              routes,
              stale: false,
              type: "tab"
            }
          })
        );
      },
      Screen
    })
  };
});

vi.mock("../components/AccountBadge", () => ({ AccountBadge: "AccountBadge" }));
vi.mock("../components/BuildInfoPanel", () => ({
  BuildInfoPanel: "BuildInfoPanel"
}));
vi.mock("../components/CreateTaskComposer", () => ({
  CreateTaskComposer: "CreateTaskComposer"
}));
vi.mock("../screens/MachinesScreen", () => ({ MachinesScreen: "MachinesScreen" }));
vi.mock("../screens/SearchScreen", () => ({ SearchScreen: "SearchScreen" }));
vi.mock("../screens/taskActionMenu", () => ({ showTaskActionMenu: vi.fn() }));
vi.mock("../screens/AgentMessageView", () => ({
  AgentMessageView: "AgentMessageView"
}));
vi.mock("../screens/QuickReplySendControl", () => ({
  QuickReplySendControl: "QuickReplySendControl"
}));
vi.mock("../screens/TaskDiffPreview", () => ({
  TaskDiffPreview: "TaskDiffPreview"
}));
vi.mock("../screens/TaskFilePreview", () => ({
  TaskFilePreview: "TaskFilePreview"
}));
vi.mock("../screens/TerminalWebView", () => ({
  TerminalWebView: "TerminalWebView"
}));
vi.mock("../screens/VisualCompanionModal", () => ({
  VisualCompanionModal: "VisualCompanionModal"
}));

let RootNavigator: typeof import("./RootNavigator").default | null = null;
let controller: MobileController | null = null;
let rendered: ReactTestRenderer | null = null;

beforeAll(async () => {
  RootNavigator = (await import("./RootNavigator")).default;
});

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
  controller?.dispose();
  controller = null;
  navigationHarness.onStateChange = null;
});

async function flushMicrotasks(iterations = 12): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createClientMock(): KannaClient {
  return {
    getStatus: vi.fn().mockResolvedValue({
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "127.0.0.1",
      lanPort: 48120,
      pairingCode: null
    }),
    listDesktops: vi.fn().mockResolvedValue([]),
    listRepos: vi.fn().mockResolvedValue([
      { id: "repo-1", name: "Repo One" }
    ]),
    listRepoCommands: vi.fn(async (repoId: string) => {
      if (repoId === "repo-1") {
        throw new Error("404 /v1/repos/repo-1/commands");
      }
      return {
        repoId,
        revision: "repo-2-catalog",
        commands: [{
          id: "custom:merge-master",
          label: "Merge Master",
          description: "Merge ready pull requests",
          group: "automation"
        }]
      };
    }),
    listRepoTasks: vi.fn().mockResolvedValue([]),
    listRecentTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    abortTaskCreation: vi.fn().mockResolvedValue(undefined),
    markTaskRead: vi.fn().mockResolvedValue({ taskId: "task-1", activity: "idle" }),
    advanceTaskStage: vi.fn().mockResolvedValue({ taskId: "task-1" }),
    closeTask: vi.fn().mockResolvedValue(undefined),
    observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
    observeTaskCompanion: vi.fn(() => ({
      close: vi.fn(),
      sendEvent: vi.fn(() => true)
    }))
  } as unknown as KannaClient;
}

function visibleText(): string {
  if (!rendered) return "";
  return rendered.root
    .findAllByType("Text")
    .flatMap((node) => node.children)
    .filter((child): child is string => typeof child === "string")
    .join(" ");
}

function hasLoadingTasks(): boolean {
  if (!rendered) return false;
  return rendered.root.findAll(
    (node) => node.props.accessibilityLabel === "Loading tasks, loading"
  ).length > 0;
}

function NavigatorHarness({
  activeController,
  store
}: {
  activeController: MobileController;
  store: SessionStore;
}) {
  const [state, setState] = useState(store.getState());

  useEffect(
    () => store.subscribe(() => setState(store.getState())),
    [store]
  );

  if (!RootNavigator) throw new Error("RootNavigator was not loaded");
  return (
    <RootNavigator
      controller={activeController}
      forceCloudEnabled={false}
      initialState={buildInitialNavigationState({
        activeView: "tasks",
        selectedTaskId: null
      })}
      openMachinesRequestKey={0}
      quickReplies={DEFAULT_TASK_QUICK_REPLIES}
      quickRepliesHydrated
      state={state}
      onForceCloudChange={vi.fn()}
      onOpenAccount={vi.fn()}
    />
  );
}

describe("RootNavigator task collection integration", () => {
  it("renders loading before the initial snapshot, then a genuine empty state", async () => {
    const initialTasks = createDeferred<TaskSummary[]>();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks).mockReturnValue(initialTasks.promise);
    const store = createSessionStore();
    controller = createMobileController(client, store);
    let bootstrap!: Promise<void>;

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      bootstrap = controller!.bootstrap();
      await flushMicrotasks();
    });

    expect(hasLoadingTasks()).toBe(true);
    expect(visibleText()).not.toContain("No tasks yet.");

    initialTasks.resolve([]);
    await act(async () => {
      await bootstrap;
    });

    expect(hasLoadingTasks()).toBe(false);
    expect(visibleText()).toContain("No tasks yet.");
  });

  it("renders task content after the initial authoritative collection read", async () => {
    const task: TaskSummary = {
      id: "task-1",
      repoId: "repo-1",
      title: "Loaded from the desktop",
      stage: "in progress"
    };
    const client = createClientMock();
    vi.mocked(client.listRecentTasks).mockResolvedValue([task]);
    vi.mocked(client.listRepoTasks).mockResolvedValue([task]);
    const store = createSessionStore();
    controller = createMobileController(client, store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      await controller!.bootstrap();
    });

    expect(hasLoadingTasks()).toBe(false);
    expect(
      rendered.root.find(
        (node) => node.props.testID === "mobile.task-row.task-1"
      )
    ).toBeDefined();
    expect(visibleText()).toContain("Loaded from the desktop");
  });

  // E2E coverage note (repo policy): the parent/child hierarchy is not yet
  // covered by an Appium simulator run. The smoke harness is local/human-only
  // (simulator + built app) and seeds from apps/desktop/tests/e2e/seed.sql,
  // whose self-contained schema and fixtures do not yet include
  // parent_task_id, so a device spec cannot be authored and verified from a
  // headless environment. Making it feasible requires (1) a parent/child
  // fixture pair in seed.sql and (2) a smoke spec asserting
  // MOBILE_E2E_IDS.taskListSubtaskRow(childId) renders after the parent row —
  // both testIDs already ship in the task list for exactly that assertion.
  // Until then, this test is the substitute: it drives real client summaries
  // through the controller, session store, RootNavigator, and TaskList to the
  // rendered hierarchy.
  it("renders a subtask indented beneath its parent from client summaries", async () => {
    // The child is newer than the parent, so a flat newest-first list would
    // render it first; nesting must pull it beneath its parent instead.
    const parent: TaskSummary = {
      id: "task-parent",
      repoId: "repo-1",
      title: "Parent feature work",
      stage: "in progress",
      createdAt: "2026-07-20 08:00:00"
    };
    const child: TaskSummary = {
      id: "task-child",
      repoId: "repo-1",
      title: "Child implementation",
      stage: "in progress",
      createdAt: "2026-07-21 08:00:00",
      parentTaskId: "task-parent"
    };
    const client = createClientMock();
    vi.mocked(client.listRecentTasks).mockResolvedValue([parent, child]);
    vi.mocked(client.listRepoTasks).mockResolvedValue([parent, child]);
    const store = createSessionStore();
    controller = createMobileController(client, store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      await controller!.bootstrap();
    });

    const subtaskRow = rendered!.root.find(
      (node) =>
        node.props.testID === MOBILE_E2E_IDS.taskListSubtaskRow("task-child")
    );
    expect(subtaskRow).toBeDefined();
    // The child's card renders inside the indented subtask wrapper.
    expect(
      subtaskRow.findAll(
        (node) => node.props.testID === MOBILE_E2E_IDS.taskListItem("task-child")
      )
    ).toHaveLength(1);
    // Depth-first render order places the parent row before its nested child.
    const rowOrder = rendered!.root
      .findAll((node) => {
        const testID = node.props.testID;
        return (
          testID === MOBILE_E2E_IDS.taskListItem("task-parent") ||
          testID === MOBILE_E2E_IDS.taskListItem("task-child")
        );
      })
      .map((node) => node.props.testID);
    expect(rowOrder).toEqual([
      MOBILE_E2E_IDS.taskListItem("task-parent"),
      MOBILE_E2E_IDS.taskListItem("task-child")
    ]);
    // The parent renders as a plain top-level row.
    expect(
      rendered!.root.findAll(
        (node) =>
          node.props.testID === MOBILE_E2E_IDS.taskListSubtaskRow("task-parent")
      )
    ).toHaveLength(0);
  });

  it("renders a static error when the initial collection read fails", async () => {
    const client = createClientMock();
    vi.mocked(client.listRecentTasks).mockRejectedValue(
      new Error("task snapshot unavailable")
    );
    const store = createSessionStore();
    controller = createMobileController(client, store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      await controller!.bootstrap();
    });

    expect(hasLoadingTasks()).toBe(false);
    expect(visibleText()).toContain("Could not load tasks.");
  });

  it("preserves existing task content while a later refresh is pending", async () => {
    const task: TaskSummary = {
      id: "task-1",
      repoId: "repo-1",
      title: "Keep me visible",
      stage: "review"
    };
    const refreshTasks = createDeferred<TaskSummary[]>();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks)
      .mockResolvedValueOnce([task])
      .mockReturnValueOnce(refreshTasks.promise);
    vi.mocked(client.listRepoTasks).mockResolvedValue([task]);
    const store = createSessionStore();
    controller = createMobileController(client, store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      await controller!.bootstrap();
    });

    let refresh!: Promise<void>;
    await act(async () => {
      refresh = controller!.refresh();
      await flushMicrotasks();
    });

    expect(store.getState().refreshStatus).toBe("refreshing");
    expect(hasLoadingTasks()).toBe(false);
    expect(visibleText()).toContain("Keep me visible");
    expect(
      rendered.root.find(
        (node) => node.props.testID === "mobile.task-row.task-1"
      )
    ).toBeDefined();

    refreshTasks.resolve([task]);
    await act(async () => {
      await refresh;
    });
  });
});

describe("RootNavigator More integration", () => {
  it("falls through an unavailable repo and renders commands without removing it from shared state", async () => {
    const client = createClientMock();
    const store = createSessionStore();
    store.setRepos([
      { id: "repo-1", name: "Unavailable repo" },
      { id: "repo-2", name: "Working repo" }
    ]);
    controller = createMobileController(client, store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
    });

    const moreTab = rendered.root.find(
      (node) => node.props.testID === "mobile.toolbar.tab.more"
    );
    await act(async () => {
      moreTab.props.onPress();
      await flushMicrotasks();
    });

    expect(client.listRepoCommands).toHaveBeenNthCalledWith(1, "repo-1");
    expect(client.listRepoCommands).toHaveBeenNthCalledWith(2, "repo-2");
    expect(
      rendered.root.findAll(
        (node) => node.props.testID === "mobile.more.repo.repo-1"
      )
    ).toHaveLength(0);
    expect(
      rendered.root.find(
        (node) => node.props.testID === "mobile.more.repo.repo-2"
      )
    ).toBeDefined();
    expect(
      rendered.root.find(
        (node) =>
          node.props.testID === "mobile.more.command.custom:merge-master"
      )
    ).toBeDefined();
    expect(store.getState()).toMatchObject({
      repos: [
        { id: "repo-1", name: "Unavailable repo" },
        { id: "repo-2", name: "Working repo" }
      ],
      selectedRepoId: "repo-2",
      repoCommandStatus: "ready"
    });
  });

  it("keeps rendered commands when a later More refresh transiently fails", async () => {
    const client = createClientMock();
    vi.mocked(client.listRepoCommands)
      .mockReset()
      .mockResolvedValueOnce({
        repoId: "repo-1",
        revision: "repo-1-catalog",
        commands: [{
          id: "custom:merge-master",
          label: "Merge Master",
          description: "Merge ready pull requests",
          group: "automation"
        }]
      })
      .mockRejectedValueOnce(new Error("Relay connection closed."));
    const store = createSessionStore();
    controller = createMobileController(client, store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      await controller!.bootstrap();
    });

    await act(async () => {
      rendered!.root.find(
        (node) => node.props.testID === "mobile.toolbar.tab.more"
      ).props.onPress();
      await flushMicrotasks();
    });
    expect(
      rendered.root.find(
        (node) =>
          node.props.testID === "mobile.more.command.custom:merge-master"
      )
    ).toBeDefined();

    await act(async () => {
      rendered!.root.find(
        (node) => node.props.testID === "mobile.toolbar.tab.tasks"
      ).props.onPress();
      await flushMicrotasks();
    });
    await act(async () => {
      rendered!.root.find(
        (node) => node.props.testID === "mobile.toolbar.tab.more"
      ).props.onPress();
      await flushMicrotasks();
    });

    expect(client.listRepoCommands).toHaveBeenCalledTimes(2);
    expect(
      rendered.root.find(
        (node) =>
          node.props.testID === "mobile.more.command.custom:merge-master"
      )
    ).toBeDefined();
    expect(visibleText()).not.toContain("Commands unavailable");
    expect(store.getState()).toMatchObject({
      repoCommandCatalog: {
        repoId: "repo-1",
        revision: "repo-1-catalog"
      },
      repoCommandStatus: "ready",
      repoCommandErrorMessage: null
    });
  });
});

describe("RootNavigator task action integration", () => {
  const task: TaskSummary = {
    id: "task-1",
    repoId: "repo-1",
    title: "Close me from the plus menu",
    stage: "in progress"
  };

  function pressByTestId(testID: string): void {
    if (!rendered) throw new Error("navigator is not rendered");
    const onPress = rendered.root.find(
      (node) => node.props.testID === testID
    ).props.onPress as () => void;
    onPress();
  }

  function findByTestId(testID: string) {
    if (!rendered) throw new Error("navigator is not rendered");
    return rendered.root.find((node) => node.props.testID === testID);
  }

  function countByTestId(testID: string): number {
    if (!rendered) return 0;
    return rendered.root.findAll(
      (node) => node.props.testID === testID
    ).length;
  }

  async function openTaskDetailAndCaptureMenu(
    client: KannaClient,
    store: SessionStore
  ): Promise<(action: TaskAction) => void> {
    controller = createMobileController(client, store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      await controller!.bootstrap();
    });

    await act(async () => {
      pressByTestId("mobile.task-row.task-1");
      await flushMicrotasks();
    });
    expect(findByTestId(MOBILE_E2E_IDS.taskDetailScreen)).toBeDefined();

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskMoreButton);
    });
    expect(showTaskActionMenu).toHaveBeenCalledTimes(1);
    return vi.mocked(showTaskActionMenu).mock.calls[0][0];
  }

  beforeEach(() => {
    vi.mocked(showTaskActionMenu).mockClear();
  });

  it("aborts an uncertain creation through its slot with the reserved id and frozen desktop", async () => {
    const attempt = {
      slotId: "create:slot-abort",
      taskId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repoId: "repo-1",
      prompt: "Abort this partial task",
      desktopId: "desktop-owner",
      agentProvider: "codex" as const
    };
    const abort = createDeferred<void>();
    const client = createClientMock();
    vi.mocked(client.abortTaskCreation).mockReturnValue(abort.promise);
    const store = createSessionStore();
    store.hydrateContext({
      mobileDeviceId: null,
      selectedDesktopId: "desktop-1",
      selectedRepoId: "repo-1",
      selectedTaskId: null,
      activeView: "tasks",
      taskCreationAttempts: [attempt]
    });
    controller = createMobileController(client, store);
    const abortTaskCreation = vi.spyOn(controller, "abortTaskCreation");

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      await controller!.bootstrap();
    });

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskListItem(attempt.slotId));
      await flushMicrotasks();
    });
    expect(findByTestId(MOBILE_E2E_IDS.taskCreationRecoverButton))
      .toBeDefined();

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskMoreButton);
    });
    expect(showTaskActionMenu).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      { taskCreation: true }
    );
    const selectAction = vi.mocked(showTaskActionMenu).mock.calls[0]![0];

    await act(async () => {
      selectAction("close-task");
      await flushMicrotasks();
    });

    expect(abortTaskCreation).toHaveBeenCalledWith(attempt.slotId);
    expect(client.abortTaskCreation).toHaveBeenCalledOnce();
    expect(client.abortTaskCreation).toHaveBeenCalledWith({
      taskId: attempt.taskId,
      desktopId: attempt.desktopId
    });
    expect(store.getState().pendingTaskAction).toBeNull();
    expect(store.getState().taskCreationAttempts).toEqual([
      expect.objectContaining({
        slotId: attempt.slotId,
        pendingAction: "close-task"
      })
    ]);
    expect(findByTestId(MOBILE_E2E_IDS.taskMoreButton).props.disabled)
      .toBe(true);
    expect(
      findByTestId(MOBILE_E2E_IDS.taskCreationRecoverButton).props.disabled
    ).toBe(true);

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskMoreButton);
      selectAction("close-task");
      pressByTestId(MOBILE_E2E_IDS.taskCreationRecoverButton);
      await flushMicrotasks();
    });
    expect(showTaskActionMenu).toHaveBeenCalledTimes(1);
    expect(client.abortTaskCreation).toHaveBeenCalledOnce();
    expect(client.createTask).not.toHaveBeenCalled();

    abort.resolve();
    await act(async () => {
      await flushMicrotasks();
    });

    expect(store.getState().pendingTaskAction).toBeNull();
    expect(store.getState().taskCreationAttempts).toEqual([]);
    expect(countByTestId(MOBILE_E2E_IDS.taskDetailScreen)).toBe(0);
  });

  it("isolates abort busy state and errors between two creation routes", async () => {
    const attempts = [
      {
        slotId: "create:slot-abort-a",
        taskId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        repoId: "repo-1",
        prompt: "Abort first partial task",
        desktopId: "desktop-a",
        agentProvider: "claude" as const
      },
      {
        slotId: "create:slot-abort-b",
        taskId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        repoId: "repo-1",
        prompt: "Abort second partial task",
        desktopId: "desktop-b",
        agentProvider: "codex" as const
      }
    ];
    const firstAbort = createDeferred<void>();
    const secondAbort = createDeferred<void>();
    const client = createClientMock();
    vi.mocked(client.abortTaskCreation)
      .mockReturnValueOnce(firstAbort.promise)
      .mockReturnValueOnce(secondAbort.promise);
    const store = createSessionStore();
    store.hydrateContext({
      mobileDeviceId: null,
      selectedDesktopId: "desktop-a",
      selectedRepoId: "repo-1",
      selectedTaskId: null,
      activeView: "tasks",
      taskCreationAttempts: attempts
    });
    controller = createMobileController(client, store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
      await controller!.bootstrap();
    });

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskListItem(attempts[0].slotId));
      await flushMicrotasks();
    });
    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskMoreButton);
    });
    const selectFirstAction =
      vi.mocked(showTaskActionMenu).mock.calls[0]![0];
    await act(async () => {
      selectFirstAction("close-task");
      await flushMicrotasks();
    });

    expect(findByTestId(MOBILE_E2E_IDS.taskMoreButton).props.disabled)
      .toBe(true);
    expect(
      findByTestId(MOBILE_E2E_IDS.taskCreationRecoverButton).props.disabled
    ).toBe(true);

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskBackButton);
      await flushMicrotasks();
    });
    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskListItem(attempts[1].slotId));
      await flushMicrotasks();
    });

    expect(findByTestId(MOBILE_E2E_IDS.taskMoreButton).props.disabled)
      .toBe(false);
    expect(
      findByTestId(MOBILE_E2E_IDS.taskCreationRecoverButton).props.disabled
    ).toBe(false);

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskMoreButton);
    });
    const selectSecondAction =
      vi.mocked(showTaskActionMenu).mock.calls[1]![0];
    await act(async () => {
      selectSecondAction("close-task");
      await flushMicrotasks();
    });

    expect(client.abortTaskCreation).toHaveBeenCalledTimes(2);
    expect(client.abortTaskCreation).toHaveBeenNthCalledWith(1, {
      taskId: attempts[0].taskId,
      desktopId: attempts[0].desktopId
    });
    expect(client.abortTaskCreation).toHaveBeenNthCalledWith(2, {
      taskId: attempts[1].taskId,
      desktopId: attempts[1].desktopId
    });

    secondAbort.reject(new Error("Second desktop is offline"));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(findByTestId(MOBILE_E2E_IDS.taskMoreButton).props.disabled)
      .toBe(false);
    expect(visibleText()).toContain("Second desktop is offline");

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskBackButton);
      await flushMicrotasks();
    });
    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskListItem(attempts[0].slotId));
      await flushMicrotasks();
    });

    expect(findByTestId(MOBILE_E2E_IDS.taskMoreButton).props.disabled)
      .toBe(true);
    expect(visibleText()).not.toContain("Second desktop is offline");

    firstAbort.resolve();
    await act(async () => {
      await flushMicrotasks();
    });

    expect(store.getState().taskCreationAttempts).toEqual([
      expect.objectContaining({
        slotId: attempts[1].slotId,
        pendingAction: null,
        errorMessage: "Second desktop is offline"
      })
    ]);
    expect(countByTestId(MOBILE_E2E_IDS.taskDetailScreen)).toBe(0);

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskListItem(attempts[1].slotId));
      await flushMicrotasks();
    });
    expect(visibleText()).toContain("Second desktop is offline");
  });

  it("closes a task exactly once from the + menu, shows the spinner, and blocks duplicates until success", async () => {
    const close = createDeferred<void>();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks)
      .mockResolvedValueOnce([task])
      .mockResolvedValue([]);
    vi.mocked(client.listRepoTasks)
      .mockResolvedValueOnce([task])
      .mockResolvedValue([]);
    vi.mocked(client.closeTask).mockReturnValue(close.promise);
    const store = createSessionStore();
    const selectAction = await openTaskDetailAndCaptureMenu(client, store);
    const closeDesktopTask = vi.spyOn(controller!, "closeDesktopTask");

    await act(async () => {
      selectAction("close-task");
      await flushMicrotasks();
    });

    expect(closeDesktopTask).toHaveBeenCalledWith(task.id);
    expect(client.closeTask).toHaveBeenCalledTimes(1);
    expect(client.closeTask).toHaveBeenCalledWith("task-1");
    expect(store.getState().pendingTaskAction).toEqual({
      taskId: "task-1",
      action: "close-task"
    });
    expect(findByTestId(MOBILE_E2E_IDS.taskMoreButton).props.disabled).toBe(true);
    expect(
      findByTestId(MOBILE_E2E_IDS.taskActionPendingSpinner).type
    ).toBe("ActivityIndicator");

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskMoreButton);
    });
    expect(showTaskActionMenu).toHaveBeenCalledTimes(1);

    await act(async () => {
      selectAction("close-task");
      selectAction("advance-stage");
      await flushMicrotasks();
    });
    expect(client.closeTask).toHaveBeenCalledTimes(1);
    expect(client.advanceTaskStage).not.toHaveBeenCalled();

    close.resolve();
    await act(async () => {
      await flushMicrotasks();
    });

    expect(store.getState().pendingTaskAction).toBeNull();
    expect(store.getState().selectedTaskId).toBeNull();
    expect(countByTestId(MOBILE_E2E_IDS.taskDetailScreen)).toBe(0);
  });

  it("re-enables task actions after a failed close", async () => {
    const close = createDeferred<void>();
    const client = createClientMock();
    vi.mocked(client.listRecentTasks).mockResolvedValue([task]);
    vi.mocked(client.listRepoTasks).mockResolvedValue([task]);
    vi.mocked(client.closeTask).mockReturnValueOnce(close.promise);
    const store = createSessionStore();
    const selectAction = await openTaskDetailAndCaptureMenu(client, store);

    await act(async () => {
      selectAction("close-task");
      await flushMicrotasks();
    });
    expect(client.closeTask).toHaveBeenCalledTimes(1);
    expect(findByTestId(MOBILE_E2E_IDS.taskMoreButton).props.disabled).toBe(true);

    close.reject(new Error("daemon unavailable"));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(store.getState().pendingTaskAction).toBeNull();
    expect(store.getState().errorMessage).toBe("daemon unavailable");
    expect(findByTestId(MOBILE_E2E_IDS.taskDetailScreen)).toBeDefined();
    expect(findByTestId(MOBILE_E2E_IDS.taskMoreButton).props.disabled).toBe(false);
    expect(countByTestId(MOBILE_E2E_IDS.taskActionPendingSpinner)).toBe(0);

    await act(async () => {
      pressByTestId(MOBILE_E2E_IDS.taskMoreButton);
    });
    expect(showTaskActionMenu).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.mocked(showTaskActionMenu).mock.calls[1][0]("close-task");
      await flushMicrotasks();
    });
    expect(client.closeTask).toHaveBeenCalledTimes(2);
  });
});
