import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_QUICK_REPLIES } from "../screens/taskQuickReplies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
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
    NavigationContainer: ReactModule.forwardRef(
      ({ children, ...props }: { children?: React.ReactNode }, _ref) =>
        ReactModule.createElement("NavigationContainer", props, children)
    ),
    StackActions: {
      popTo: vi.fn(),
      push: vi.fn(),
      replace: vi.fn()
    },
    useFocusEffect: vi.fn(),
    useIsFocused: vi.fn(() => false),
    useNavigationContainerRef: vi.fn(() => ({
      dispatch: vi.fn(),
      getRootState: vi.fn(),
      isReady: vi.fn(() => false)
    }))
  };
});

vi.mock("@react-navigation/bottom-tabs", () => ({
  createBottomTabNavigator: () => ({
    Navigator: "BottomTabNavigator",
    Screen: "BottomTabScreen"
  })
}));

vi.mock("@react-navigation/native-stack", () => ({
  createNativeStackNavigator: () => ({
    Navigator: "NativeStackNavigator",
    Screen: "NativeStackScreen"
  })
}));

vi.mock("../components/AccountBadge", () => ({ AccountBadge: "AccountBadge" }));
vi.mock("../components/CreateTaskComposer", () => ({
  CreateTaskComposer: "CreateTaskComposer"
}));
vi.mock("../components/FloatingToolbar", () => ({
  FloatingToolbar: "FloatingToolbar"
}));
vi.mock("../screens/MachinesScreen", () => ({ MachinesScreen: "MachinesScreen" }));
vi.mock("../screens/MoreScreen", () => ({ MoreScreen: "MoreScreen" }));
vi.mock("../screens/SearchScreen", () => ({ SearchScreen: "SearchScreen" }));
vi.mock("../screens/TaskScreen", () => ({ TaskScreen: "TaskScreen" }));
vi.mock("../screens/TasksScreen", () => ({ TasksScreen: "TasksScreen" }));
vi.mock("../screens/taskActionMenu", () => ({ showTaskActionMenu: vi.fn() }));

import RootNavigator from "./RootNavigator";

let rendered: ReactTestRenderer | null = null;

afterEach(async () => {
  if (rendered) {
    await act(async () => rendered?.unmount());
    rendered = null;
  }
});

describe("RootNavigator", () => {
  it("enables edge-only swipe back for task detail", async () => {
    await act(async () => {
      rendered = create(
        <RootNavigator
          controller={{
            subscribeRepoCommandTaskOpen: () => () => undefined
          } as never}
          forceCloudEnabled={false}
          initialState={{
            index: 0,
            key: "root",
            routeNames: ["MainTabs"],
            routes: [{ key: "main-tabs", name: "MainTabs" }],
            stale: false,
            type: "stack"
          } as never}
          onForceCloudChange={vi.fn()}
          onOpenAccount={vi.fn()}
          openMachinesRequestKey={0}
          quickReplies={DEFAULT_TASK_QUICK_REPLIES}
          quickRepliesHydrated
          state={{
            accountDesktops: [],
            composerAgentProvider: "claude",
            composerDesktopId: null,
            composerErrorMessage: null,
            composerPrompt: "",
            composerRepoId: null,
            isComposerOpen: false,
            isComposerOptionsExpanded: false,
            liveLanDesktops: [],
            pendingTaskCreation: null,
            repos: [],
            selectedTaskId: null,
            trustedDesktops: []
          } as never}
        />
      );
    });

    const taskDetailScreen = rendered.root
      .findAllByType("NativeStackScreen")
      .find((screen) => screen.props.name === "TaskDetail");

    expect(taskDetailScreen?.props.options).toMatchObject({
      fullScreenGestureEnabled: false,
      gestureDirection: "horizontal",
      gestureEnabled: true,
      headerShown: false
    });
  });

  it("hands the composer each machine's reported agent inventory", async () => {
    await act(async () => {
      rendered = create(
        <RootNavigator
          controller={{
            subscribeRepoCommandTaskOpen: () => () => undefined
          } as never}
          forceCloudEnabled={false}
          initialState={{
            index: 0,
            key: "root",
            routeNames: ["MainTabs"],
            routes: [{ key: "main-tabs", name: "MainTabs" }],
            stale: false,
            type: "stack"
          } as never}
          onForceCloudChange={vi.fn()}
          onOpenAccount={vi.fn()}
          openMachinesRequestKey={0}
          quickReplies={DEFAULT_TASK_QUICK_REPLIES}
          quickRepliesHydrated
          state={{
            accountDesktops: [],
            composerAgentProvider: "opencode",
            composerDesktopId: "desktop-1",
            composerErrorMessage: null,
            composerPrompt: "",
            composerRepoId: null,
            isComposerOpen: true,
            isComposerOptionsExpanded: true,
            liveLanDesktops: [
              {
                id: "desktop-1",
                name: "Studio Mac",
                online: true,
                mode: "lan",
                agentProviders: ["opencode"]
              }
            ],
            pendingTaskCreation: null,
            repos: [],
            selectedTaskId: null,
            trustedDesktops: []
          } as never}
        />
      );
    });

    const composer = rendered.root.findByType("CreateTaskComposer" as never);

    expect(composer.props.desktops).toEqual([
      expect.objectContaining({
        id: "desktop-1",
        agentProviders: ["opencode"]
      })
    ]);
    expect(composer.props.selectedAgentProvider).toBe("opencode");
  });

  it("gives navigation-managed surfaces the Kanna dark background", async () => {
    await act(async () => {
      rendered = create(
        <RootNavigator
          controller={{
            subscribeRepoCommandTaskOpen: () => () => undefined
          } as never}
          forceCloudEnabled={false}
          initialState={{
            index: 0,
            key: "root",
            routeNames: ["MainTabs"],
            routes: [{ key: "main-tabs", name: "MainTabs" }],
            stale: false,
            type: "stack"
          } as never}
          onForceCloudChange={vi.fn()}
          onOpenAccount={vi.fn()}
          openMachinesRequestKey={0}
          quickReplies={DEFAULT_TASK_QUICK_REPLIES}
          quickRepliesHydrated
          state={{
            accountDesktops: [],
            composerAgentProvider: "claude",
            composerDesktopId: null,
            composerErrorMessage: null,
            composerPrompt: "",
            composerRepoId: null,
            isComposerOpen: false,
            isComposerOptionsExpanded: false,
            liveLanDesktops: [],
            pendingTaskCreation: null,
            repos: [],
            selectedTaskId: null,
            trustedDesktops: []
          } as never}
        />
      );
    });

    const navigationContainer = rendered.root.findByType("NavigationContainer");

    expect(navigationContainer.props.theme?.colors.background).toBe("#08111E");
  });
});
