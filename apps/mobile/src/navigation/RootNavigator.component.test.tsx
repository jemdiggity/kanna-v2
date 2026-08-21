import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_QUICK_REPLIES } from "../screens/taskQuickReplies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const alertMock = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Alert: {
    alert: alertMock
  },
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: {
    OS: "ios"
  },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    absoluteFill: "absoluteFill",
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
  alertMock.mockReset();
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

    expect(
      rendered.root.findByProps({
        testID: "mobile.create-task.agent.opencode"
      })
    ).toBeDefined();
    expect(
      rendered.root.findByProps({
        testID: "mobile.create-task.machine.desktop-1"
      })
    ).toBeDefined();
  });

  it("selects a missing-repo machine and completes the checkout confirmation flow", async () => {
    let checkoutCompleted: (() => void) | null = null;
    const checkoutCompletion = new Promise<void>((resolve) => {
      checkoutCompleted = resolve;
    });
    const createTask = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("task-after-checkout");
    const controller = {
      confirmRepoCheckout: vi.fn(async () => {
        await checkoutCompletion;
        return createTask();
      }),
      createTask,
      selectComposerAgentProvider: vi.fn(),
      selectComposerDesktop: vi.fn(),
      setComposerOptionsExpanded: vi.fn(),
      subscribeRepoCommandTaskOpen: () => () => undefined,
      updateComposerPrompt: vi.fn(),
      closeComposer: vi.fn()
    } as never;
    const baseState = {
      accountDesktops: [],
      composerAgentProvider: "claude",
      composerDesktopId: "desktop-1",
      composerErrorMessage: null,
      composerPrompt: "Study kanji",
      composerRepoId: "git:hash-kanji",
      isComposerOpen: true,
      isComposerOptionsExpanded: true,
      liveLanDesktops: [
        {
          id: "desktop-1",
          name: "MacBook Pro",
          online: true,
          mode: "lan"
        },
        {
          id: "desktop-2",
          name: "Mac Studio",
          online: true,
          mode: "lan"
        }
      ],
      pendingTaskCreation: null,
      repoCheckoutOffer: null,
      repos: [
        {
          id: "git:hash-kanji",
          name: "kanji-kongbu",
          remoteUrl: "file:///tmp/kanji-kongbu.git",
          remoteUrlHash: "hash-kanji",
          registeredDesktopIds: ["desktop-1"]
        }
      ],
      selectedTaskId: null,
      trustedDesktops: []
    } as const;
    const initialState = {
      index: 0,
      key: "root",
      routeNames: ["MainTabs"],
      routes: [{ key: "main-tabs", name: "MainTabs" }],
      stale: false,
      type: "stack"
    } as never;
    const renderRoot = (state: unknown) => (
      <RootNavigator
        controller={controller}
        forceCloudEnabled={false}
        initialState={initialState}
        onForceCloudChange={vi.fn()}
        onOpenAccount={vi.fn()}
        openMachinesRequestKey={0}
        quickReplies={DEFAULT_TASK_QUICK_REPLIES}
        quickRepliesHydrated
        state={state as never}
      />
    );

    await act(async () => {
      rendered = create(renderRoot(baseState));
    });

    const studioOption = rendered.root.findByProps({
      testID: "mobile.create-task.machine.desktop-2"
    });
    await act(async () => studioOption.props.onPress());
    expect(controller.selectComposerDesktop).toHaveBeenCalledWith("desktop-2");

    await act(async () => {
      rendered?.update(
        renderRoot({ ...baseState, composerDesktopId: "desktop-2" })
      );
    });
    const initialSubmit = rendered.root.findByProps({
      testID: "mobile.create-task.submit"
    });
    expect(initialSubmit.props.disabled).toBe(false);
    await act(async () => initialSubmit.props.onPress());
    expect(createTask).toHaveBeenCalledOnce();

    const offeredCheckout = {
      action: "create-task" as const,
      status: "offered" as const,
      repoId: "git:hash-kanji",
      repoName: "kanji-kongbu",
      desktopId: "desktop-2",
      desktopName: "Mac Studio"
    };
    await act(async () => {
      rendered?.update(
        renderRoot({
          ...baseState,
          composerDesktopId: "desktop-2",
          composerErrorMessage:
            "kanji-kongbu is not registered on Mac Studio.",
          repoCheckoutOffer: offeredCheckout
        })
      );
    });
    expect(
      rendered.root.findByProps({ testID: "mobile.create-task.submit" }).props
        .disabled
    ).toBe(true);
    const checkoutButton = rendered.root.findByProps({
      testID: "mobile.create-task.checkout"
    });
    await act(async () => checkoutButton.props.onPress());
    expect(alertMock).toHaveBeenCalledWith(
      "Check out kanji-kongbu on Mac Studio?",
      expect.stringContaining("Mac Studio"),
      expect.any(Array)
    );

    const confirmationButtons = alertMock.mock.calls[0]?.[2] as
      | Array<{ text: string; onPress?: () => void }>
      | undefined;
    const confirmButton = confirmationButtons?.find(
      (button) => button.text === "Check Out"
    );
    await act(async () => confirmButton?.onPress?.());
    expect(controller.confirmRepoCheckout).toHaveBeenCalledOnce();

    await act(async () => {
      rendered?.update(
        renderRoot({
          ...baseState,
          composerDesktopId: "desktop-2",
          composerErrorMessage: "Checking out kanji-kongbu on Mac Studio…",
          repoCheckoutOffer: { ...offeredCheckout, status: "running" as const }
        })
      );
    });
    const runningCheckout = rendered.root.findByProps({
      testID: "mobile.create-task.checkout"
    });
    expect(runningCheckout.props.disabled).toBe(true);
    expect(
      rendered.root
        .findAllByType("Text")
        .some((node) =>
          node.children.includes("Checking out on Mac Studio…")
        )
    ).toBe(true);

    await act(async () => {
      checkoutCompleted?.();
      await checkoutCompletion;
    });
    expect(createTask).toHaveBeenCalledTimes(2);
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
