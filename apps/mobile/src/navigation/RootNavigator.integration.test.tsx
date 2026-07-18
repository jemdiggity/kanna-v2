import React, { useEffect, useState } from "react";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KannaClient } from "../lib/api/client";
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
vi.mock("../screens/TasksScreen", () => ({ TasksScreen: "TasksScreen" }));
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

function createClientMock(): KannaClient {
  return {
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
    listRepoTasks: vi.fn().mockResolvedValue([])
  } as unknown as KannaClient;
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
