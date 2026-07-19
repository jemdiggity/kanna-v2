import React, { useEffect, useState } from "react";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  onStateChange: null as ((state: unknown) => void) | null
}));

vi.mock("@expo/vector-icons", () => ({
  Ionicons: "Ionicons"
}));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  TextInput: "TextInput",
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
      popTo: vi.fn(),
      push: vi.fn(),
      replace: vi.fn()
    },
    useFocusEffect: (effect: () => void | (() => void)) => {
      ReactModule.useEffect(effect, [effect]);
    },
    useIsFocused: () => true,
    useNavigationContainerRef: () => ReactModule.useRef({
      dispatch: vi.fn(),
      getRootState: vi.fn(() => ({ index: 0, routes: [] })),
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
        const mainTabs = screens.find((screen) => screen.props.name === "MainTabs");
        if (!mainTabs) return null;
        return ReactModule.createElement(mainTabs.props.component);
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
vi.mock("../components/CreateTaskComposer", () => ({
  CreateTaskComposer: "CreateTaskComposer"
}));
vi.mock("../screens/MachinesScreen", () => ({ MachinesScreen: "MachinesScreen" }));
vi.mock("../screens/SearchScreen", () => ({ SearchScreen: "SearchScreen" }));
vi.mock("../screens/TaskScreen", () => ({ TaskScreen: "TaskScreen" }));
vi.mock("../screens/taskActionMenu", () => ({ showTaskActionMenu: vi.fn() }));

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
    searchTasks: vi.fn().mockResolvedValue([])
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
});
