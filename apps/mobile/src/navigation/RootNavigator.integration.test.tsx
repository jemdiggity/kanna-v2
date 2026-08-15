import React, { useEffect, useState } from "react";
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
import { terminalOutputToString } from "../state/terminalOutputBuffer";
import { buildInitialNavigationState } from "./navigationState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigationHarness = vi.hoisted(() => ({
  activeScrollToTopTarget: null as {
    current: { scrollToTop(): void } | null;
  } | null,
  onStateChange: null as ((state: unknown) => void) | null,
  applyStackAction: null as
    | ((action: {
        type: string;
        name: string;
        params?: { taskId?: string };
      }) => void)
    | null,
  scrollCalls: [] as Array<{
    options: { animated: boolean; x: number; y: number };
    testID: string | undefined;
  }>
}));

const keyboardHarness = vi.hoisted(() => ({
  dismiss: vi.fn(),
  listeners: new Map<
    string,
    (event: { endCoordinates: { height: number } }) => void
  >()
}));

vi.mock("@expo/vector-icons", () => ({
  Ionicons: "Ionicons"
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Keyboard: {
    addListener: vi.fn(
      (
        eventName: string,
        listener: (event: { endCoordinates: { height: number } }) => void
      ) => {
        keyboardHarness.listeners.set(eventName, listener);
        return {
          remove: () => {
            if (keyboardHarness.listeners.get(eventName) === listener) {
              keyboardHarness.listeners.delete(eventName);
            }
          }
        };
      }
    ),
    dismiss: keyboardHarness.dismiss
  },
  Pressable: "Pressable",
  ScrollView: React.forwardRef(function ScrollView(
    props: { children?: React.ReactNode; testID?: string },
    ref: React.ForwardedRef<{
      scrollTo(options: { animated: boolean; x: number; y: number }): void;
    }>
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollTo: (options) => {
        navigationHarness.scrollCalls.push({ options, testID: props.testID });
      }
    }));
    const { children, testID: _testID, ...hostProps } = props;
    return React.createElement("ScrollView", hostProps, children);
  }),
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
    useScrollToTop: (target: {
      current: { scrollToTop(): void } | null;
    }) => {
      ReactModule.useEffect(() => {
        navigationHarness.activeScrollToTopTarget = target;
        return () => {
          if (navigationHarness.activeScrollToTopTarget === target) {
            navigationHarness.activeScrollToTopTarget = null;
          }
        };
      }, [target]);
    },
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
          emit: vi.fn((event: { target: string }) => {
            if (event.target === routes[activeIndex]?.key) {
              navigationHarness.activeScrollToTopTarget?.current?.scrollToTop();
            }
            return { defaultPrevented: false };
          }),
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
vi.mock("../screens/TaskMentionedFiles", () => ({
  TaskMentionedFiles: "TaskMentionedFiles"
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
  navigationHarness.activeScrollToTopTarget = null;
  navigationHarness.scrollCalls = [];
  keyboardHarness.dismiss.mockReset();
  keyboardHarness.listeners.clear();
  vi.useRealTimers();
});

describe("RootNavigator tab reselection integration", () => {
  it("routes only active-tab presses to every tab's outer scroll owner", async () => {
    const store = createSessionStore();
    controller = createMobileController(createClientMock(), store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
    });

    const pressTab = async (tabName: "tasks" | "recent" | "more") => {
      await act(async () => {
        rendered!.root.find(
          (node) =>
            node.props.testID === MOBILE_E2E_IDS.toolbarTab(tabName)
        ).props.onPress();
        await flushMicrotasks();
      });
    };

    await pressTab("tasks");
    expect(navigationHarness.scrollCalls).toEqual([
      {
        options: { animated: true, x: 0, y: 0 },
        testID: MOBILE_E2E_IDS.tasksScreen
      }
    ]);

    await pressTab("recent");
    expect(navigationHarness.scrollCalls).toHaveLength(1);
    await pressTab("recent");
    expect(navigationHarness.scrollCalls.at(-1)).toEqual({
      options: { animated: true, x: 0, y: 0 },
      testID: MOBILE_E2E_IDS.recentScreen
    });

    await pressTab("more");
    expect(navigationHarness.scrollCalls).toHaveLength(2);
    await pressTab("more");
    expect(navigationHarness.scrollCalls.at(-1)).toEqual({
      options: { animated: true, x: 0, y: 0 },
      testID: MOBILE_E2E_IDS.moreScreen
    });

    const searchInput = rendered!.root.find(
      (node) => node.props.testID === MOBILE_E2E_IDS.moreSearchInput
    );
    await act(async () => searchInput.props.onChangeText("preserved query"));
    await pressTab("more");

    expect(
      rendered!.root.find(
        (node) => node.props.testID === MOBILE_E2E_IDS.moreSearchInput
      ).props.value
    ).toBe("preserved query");
    expect(keyboardHarness.dismiss).toHaveBeenCalledTimes(4);
  });

  it("keeps the Tasks scroll owner through long, loading, empty, and error states", async () => {
    const store = createSessionStore();
    controller = createMobileController(createClientMock(), store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
    });

    const pressTasks = async () => {
      await act(async () => {
        rendered!.root.find(
          (node) =>
            node.props.testID === MOBILE_E2E_IDS.toolbarTab("tasks")
        ).props.onPress();
      });
    };

    await pressTasks();
    await act(async () => store.setTaskCollectionStatus("ready"));
    await pressTasks();
    await act(async () => store.setTaskCollectionStatus("error"));
    await pressTasks();
    await act(async () => {
      store.setRepoTasks(
        Array.from({ length: 100 }, (_, index): TaskSummary => ({
          id: `long-task-${index}`,
          repoId: "repo-1",
          stage: "in progress",
          title: `Long list task ${index}`
        }))
      );
      store.setTaskCollectionStatus("ready");
    });
    await pressTasks();

    expect(navigationHarness.scrollCalls).toHaveLength(4);
    expect(
      navigationHarness.scrollCalls.every(
        (call) => call.testID === MOBILE_E2E_IDS.tasksScreen
      )
    ).toBe(true);
  });

  it("keeps the More scroll owner through loading, empty, error, and long command states", async () => {
    const store = createSessionStore();
    store.setRepos([{ id: "repo-1", name: "Repo One" }]);
    store.setRepoCommandLoading("repo-1");
    controller = createMobileController(createClientMock(), store);

    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={controller!} store={store} />
      );
    });

    const pressMore = async () => {
      await act(async () => {
        rendered!.root.find(
          (node) => node.props.testID === MOBILE_E2E_IDS.toolbarTab("more")
        ).props.onPress();
      });
    };

    await pressMore();
    await pressMore();
    await act(async () =>
      store.setRepoCommandError("repo-1", "Commands unavailable")
    );
    await pressMore();
    await act(async () =>
      store.setRepoCommandCatalog({
        commands: Array.from({ length: 100 }, (_, index) => ({
          description: `Long command ${index}`,
          group: "automation" as const,
          id: `custom:long-${index}`,
          label: `Command ${index}`
        })),
        repoId: "repo-1",
        revision: "long-catalog"
      })
    );
    await pressMore();

    expect(navigationHarness.scrollCalls).toHaveLength(3);
    expect(
      navigationHarness.scrollCalls.every(
        (call) => call.testID === MOBILE_E2E_IDS.moreScreen
      )
    ).toBe(true);
  });
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
    resolveTaskFileMentions: vi.fn().mockResolvedValue({ mentions: [] }),
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
  it("renders loading before the initial snapshot, then guides a fresh install into Machines", async () => {
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
    expect(visibleText()).toContain("Connect Kanna on your Mac");
    expect(visibleText()).toContain("Cloud sign-in for remote access is separate and optional.");
    expect(visibleText()).not.toContain("No tasks yet.");

    await act(async () => {
      rendered!.root.find(
        (node) => node.props.testID === MOBILE_E2E_IDS.tasksPairMacButton
      ).props.onPress();
      await flushMicrotasks();
    });

    expect(rendered.root.findAllByType("MachinesScreen")).toHaveLength(1);
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

describe("RootNavigator task Back integration", () => {
  const task: TaskSummary = {
    id: "task-back",
    repoId: "repo-1",
    title: "Back boundary fixture",
    stage: "in progress",
    agentType: "pty"
  };

  function findAllByTestId(testID: string) {
    return rendered?.root.findAll((node) => node.props.testID === testID) ?? [];
  }

  function pressByTestId(testID: string): void {
    if (!rendered) throw new Error("navigator is not rendered");
    const node = rendered.root.find((candidate) => candidate.props.testID === testID);
    const onPress = node.props.onPress as (() => void) | undefined;
    if (!onPress) throw new Error(`${testID} does not expose onPress`);
    onPress();
  }

  it.each([
    ["while the terminal is connecting", false],
    ["with the keyboard open over long scrollback", true]
  ] as const)(
    "crosses the real navigation boundary %s",
    async (_caseName, loadLongScrollback) => {
      const closeTerminal = vi.fn();
      const client = createClientMock();
      vi.mocked(client.listRecentTasks).mockResolvedValue([task]);
      vi.mocked(client.listRepoTasks).mockResolvedValue([task]);
      vi.mocked(client.observeTaskTerminal).mockReturnValue({
        close: closeTerminal
      });
      const store = createSessionStore();
      controller = createMobileController(client, store);

      await act(async () => {
        rendered = create(
          <NavigatorHarness activeController={controller!} store={store} />
        );
        await controller!.bootstrap();
      });
      await act(async () => {
        pressByTestId(MOBILE_E2E_IDS.taskListItem(task.id));
        await flushMicrotasks();
      });

      expect(findAllByTestId(MOBILE_E2E_IDS.taskDetailScreen)).toHaveLength(1);
      if (loadLongScrollback) {
        const longScrollback = `${"scrollback line\n".repeat(20_000)}END`;
        await act(async () => {
          store.replaceTaskTerminalSnapshot(task.id, longScrollback, 80, 24);
          keyboardHarness.listeners.get("keyboardWillShow")?.({
            endCoordinates: { height: 320 }
          });
        });

        const terminalProps = rendered!.root.findByType("TerminalWebView").props;
        expect(terminalProps).toMatchObject({ status: "live" });
        expect(terminalOutputToString(terminalProps.output)).toBe(
          `${longScrollback}\n`
        );
        expect(
          findAllByTestId(MOBILE_E2E_IDS.taskComposerChrome)[0]?.props.style
        ).toContainEqual({ bottom: 328 });
      } else {
        expect(
          findAllByTestId(MOBILE_E2E_IDS.terminalOverlay)[0]?.props.pointerEvents
        ).toBe("none");
      }

      const backButton = findAllByTestId(MOBILE_E2E_IDS.taskBackButton)[0];
      expect(backButton?.props).toMatchObject({
        accessibilityLabel: "Back",
        accessibilityState: { busy: false, disabled: false },
        disabled: false,
        hitSlop: 4
      });

      await act(async () => {
        pressByTestId(MOBILE_E2E_IDS.taskBackButton);
        await flushMicrotasks();
      });

      expect(keyboardHarness.dismiss).toHaveBeenCalledOnce();
      expect(findAllByTestId(MOBILE_E2E_IDS.taskDetailScreen)).toHaveLength(0);
      expect(findAllByTestId(MOBILE_E2E_IDS.tasksScreen)).toHaveLength(1);
      expect(closeTerminal).toHaveBeenCalledOnce();
      expect(store.getState()).toMatchObject({
        selectedTaskId: null,
        taskTerminalTaskId: null
      });
      expect(terminalOutputToString(store.getState().taskTerminalOutput)).toBe("");
    }
  );
});

describe("RootNavigator More integration", () => {
  it("opens a command task that appears in a later collection refresh", async () => {
    vi.useFakeTimers();
    const client = createClientMock();
    const delayedTask: TaskSummary = {
      id: "task-command",
      repoId: "repo-1",
      title: "Delayed command task",
      stage: "in progress"
    };
    client.listRepos = vi.fn().mockResolvedValue([
      { id: "repo-1", name: "Repo One" },
      { id: "repo-2", name: "Repo Two" }
    ]);
    client.listRepoCommands = vi.fn().mockResolvedValue({
      repoId: "repo-1",
      revision: "repo-1-catalog",
      commands: [{
        id: "custom:task-manager",
        label: "Task Manager",
        description: "Launch the task manager",
        group: "automation"
      }]
    });
    client.runRepoCommand = vi.fn().mockResolvedValue({
      taskId: delayedTask.id,
      reused: false
    });
    client.listRecentTasks = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([delayedTask]);
    client.listRepoTasks = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([delayedTask]);
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
        (node) => node.props.testID === MOBILE_E2E_IDS.toolbarTab("more")
      ).props.onPress();
      await flushMicrotasks();
    });
    await act(async () => {
      rendered!.root.find(
        (node) =>
          node.props.testID ===
          MOBILE_E2E_IDS.moreCommand("custom:task-manager")
      ).props.onPress();
      await flushMicrotasks();
    });

    expect(visibleText()).toContain("Commands unavailable");
    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-1",
      selectedTaskId: null,
      pendingRepoCommandTask: { taskId: delayedTask.id },
      repoCommandStatus: "error"
    });
    expect(
      rendered!.root.findAll(
        (node) => node.props.testID === MOBILE_E2E_IDS.taskDetailScreen
      )
    ).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      await flushMicrotasks();
    });

    expect(
      rendered!.root.findAll(
        (node) => node.props.testID === MOBILE_E2E_IDS.taskDetailScreen
      )
    ).toHaveLength(1);
    expect(visibleText()).toContain("Delayed command task");
    expect(client.listRepoCommands).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-1",
      selectedTaskId: delayedTask.id,
      pendingRepoCommandTask: null,
      repoCommandStatus: "ready",
      repoCommandErrorMessage: null,
      unavailableRepoCommandIds: []
    });
  });

  it("keeps a command-unavailable repository selected and visible", async () => {
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
    expect(
      rendered.root.find(
        (node) => node.props.testID === "mobile.more.repo.repo-1"
      )
    ).toBeDefined();
    expect(
      rendered.root.find(
        (node) => node.props.testID === "mobile.more.repo.repo-2"
      )
    ).toBeDefined();
    expect(visibleText()).toContain("Commands unavailable");
    expect(store.getState()).toMatchObject({
      repos: [
        { id: "repo-1", name: "Unavailable repo" },
        { id: "repo-2", name: "Working repo" }
      ],
      selectedRepoId: "repo-1",
      repoCommandStatus: "error",
      unavailableRepoCommandIds: ["repo-1"]
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
    return vi.mocked(showTaskActionMenu).mock.calls[0][1];
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
      { mentionedFilesLabel: "Mentioned Files (0)", taskCreation: true },
      expect.any(Function)
    );
    const selectAction = vi.mocked(showTaskActionMenu).mock.calls[0]![1];

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
      vi.mocked(showTaskActionMenu).mock.calls[0]![1];
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
      vi.mocked(showTaskActionMenu).mock.calls[1]![1];
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

  it("resolves mentioned files against the durable task identity", async () => {
    const client = createClientMock();
    vi.mocked(client.listRecentTasks).mockResolvedValue([task]);
    vi.mocked(client.listRepoTasks).mockResolvedValue([task]);
    const store = createSessionStore();
    const selectAction = await openTaskDetailAndCaptureMenu(client, store);

    await act(async () => {
      selectAction("mentioned-files");
    });
    const mentionedFiles = rendered!.root.findByType("TaskMentionedFiles");
    await mentionedFiles.props.resolveMentions([
      { path: "README.md", line: 4 }
    ]);

    expect(client.resolveTaskFileMentions).toHaveBeenCalledWith("task-1", [
      { path: "README.md", line: 4 }
    ]);
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
      vi.mocked(showTaskActionMenu).mock.calls[1][1]("close-task");
      await flushMicrotasks();
    });
    expect(client.closeTask).toHaveBeenCalledTimes(2);
  });
});
