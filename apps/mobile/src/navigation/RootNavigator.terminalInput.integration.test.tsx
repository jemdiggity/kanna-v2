// Integration coverage for the mobile alt-screen terminal scroll input path:
// the RootNavigator task-detail wiring must deliver a WebView bridge payload
// through the real mobileController subscription routing and the real LAN
// transport onto the KSP socket as a term_input frame for the desktop PTY.
// The WebView side of the same boundary (real xterm emitting these payloads
// from touch drags) is covered by tests/tui-fidelity's
// verifyMobileAltScreenScrollInput real-Chromium check.
import React, { useEffect, useState } from "react";
import {
  act,
  create,
  type ReactTestRenderer
} from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClientFrame } from "@kanna/agent-protocol";
import { DEFAULT_TASK_QUICK_REPLIES } from "../screens/taskQuickReplies";
import { createKannaClient } from "../lib/api/client";
import {
  createLanTransport,
  type FetchLike,
  type WebSocketLike
} from "../lib/transports/lanTransport";
import {
  createMobileController,
  type MobileController
} from "../state/mobileController";
import {
  createSessionStore,
  type SessionStore
} from "../state/sessionStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TASK_ID = "task-1";
const SCROLL_INPUT_B64 = "G1s8NjU7MTM7MTJN";
const ESC_INPUT_B64 = "Gw==";
const ENTER_INPUT_B64 = "DQ==";

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
    NavigationContainer: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
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

// Render the TaskDetail stack screen directly so the genuine TaskDetailRoute
// wiring (focus-driven controller.openTask plus the onSendTerminalInput
// lambda) executes against the mounted task route.
vi.mock("@react-navigation/native-stack", async () => {
  const ReactModule = await import("react");
  const Screen = () => null;
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children }: { children?: React.ReactNode }) => {
        const screens = ReactModule.Children.toArray(children) as Array<
          React.ReactElement<{ component: React.ComponentType<unknown>; name: string }>
        >;
        const taskDetail = screens.find((screen) => screen.props.name === "TaskDetail");
        if (!taskDetail) return null;
        return ReactModule.createElement(taskDetail.props.component, {
          navigation: {
            canGoBack: () => false,
            dispatch: vi.fn(),
            goBack: vi.fn()
          },
          route: {
            key: "task-detail",
            name: "TaskDetail",
            params: { taskId: TASK_ID }
          }
        });
      },
      Screen
    })
  };
});

vi.mock("@react-navigation/bottom-tabs", () => ({
  createBottomTabNavigator: () => ({
    Navigator: "BottomTabNavigator",
    Screen: "BottomTabScreen"
  })
}));

vi.mock("../components/AccountBadge", () => ({ AccountBadge: "AccountBadge" }));
vi.mock("../components/BuildInfoPanel", () => ({
  BuildInfoPanel: "BuildInfoPanel"
}));
vi.mock("../components/CreateTaskComposer", () => ({
  CreateTaskComposer: "CreateTaskComposer"
}));
vi.mock("../components/FloatingToolbar", () => ({
  FloatingToolbar: "FloatingToolbar"
}));
vi.mock("../screens/MachinesScreen", () => ({ MachinesScreen: "MachinesScreen" }));
vi.mock("../screens/MoreScreen", () => ({ MoreScreen: "MoreScreen" }));
vi.mock("../screens/SearchScreen", () => ({ SearchScreen: "SearchScreen" }));
vi.mock("../screens/TaskScreen", async () => {
  const ReactModule = await import("react");
  return {
    TaskScreen: (props: {
      onSendTerminalInput?(dataB64: string, kind: "draft" | "submission" | "control"): void;
    }) => ReactModule.createElement(
      "TaskScreen",
      props,
      ReactModule.createElement("Pressable", {
        testID: "mobile.task-terminal-key.escape",
        onPress: () => props.onSendTerminalInput?.(ESC_INPUT_B64, "draft")
      }),
      ReactModule.createElement("Pressable", {
        testID: "mobile.task-terminal-key.enter",
        onPress: () => props.onSendTerminalInput?.(ENTER_INPUT_B64, "submission")
      })
    )
  };
});
vi.mock("../screens/TasksScreen", () => ({ TasksScreen: "TasksScreen" }));
vi.mock("../screens/taskActionMenu", () => ({ showTaskActionMenu: vi.fn() }));

import { buildInitialNavigationState } from "./navigationState";

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
});

async function flushMicrotasks(iterations = 16): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

interface CapturedSocket extends WebSocketLike {
  sentFrames: ClientFrame[];
}

function createSocketHarness(): {
  sockets: CapturedSocket[];
  factory(url: string): WebSocketLike;
  openAll(): void;
} {
  const sockets: CapturedSocket[] = [];
  return {
    sockets,
    factory() {
      const socket: CapturedSocket = {
        sentFrames: [],
        send(data: string) {
          socket.sentFrames.push(JSON.parse(data) as ClientFrame);
          const frame = socket.sentFrames.at(-1);
          if (frame?.type === "auth") {
            queueMicrotask(() => {
              socket.onmessage?.({
                data: JSON.stringify({
                  type: "auth_ok",
                  capabilities: ["term_input_boundary"],
                }),
              });
            });
          }
        },
        close: vi.fn(),
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null
      };
      sockets.push(socket);
      queueMicrotask(() => {
        socket.onopen?.();
      });
      return socket;
    },
    openAll() {
      for (const socket of sockets) {
        socket.onopen?.();
      }
    }
  };
}

function createLanFetchFixture(): FetchLike {
  const task = {
    id: TASK_ID,
    repoId: "repo-1",
    repoName: "Repo One",
    title: "Claude alt-screen scroll",
    stage: "in progress",
    agentProvider: "claude"
  };
  const jsonResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body
  });
  const routes: Array<[RegExp, unknown]> = [
    [/^\/v1\/status$/, {
      state: "running",
      desktopId: "desktop-1",
      desktopName: "Studio Mac",
      lanHost: "127.0.0.1",
      lanPort: 48120,
      pairingCode: null
    }],
    [/^\/v1\/desktops$/, []],
    [/^\/v1\/repos$/, [{ id: "repo-1", name: "Repo One" }]],
    [/^\/v1\/repos\/repo-1\/tasks$/, [task]],
    [/^\/v1\/repos\/repo-1\/commands$/, {
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: []
    }],
    [/^\/v1\/tasks\/recent$/, [task]],
    [/^\/v1\/tasks\/search/, []],
    [/^\/v1\/tasks\/task-1\/actions\/mark-read$/, { taskId: TASK_ID, activity: "idle" }]
  ];
  return async (input) => {
    const path = new URL(input).pathname + new URL(input).search;
    const match = routes.find(([pattern]) => pattern.test(path));
    if (!match) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return jsonResponse(match[1]);
  };
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
        selectedTaskId: TASK_ID
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

describe("RootNavigator terminal scroll input integration", () => {
  it("routes a task-detail scroll control through the controller and LAN KSP as term_input_control", async () => {
    const harness = createSocketHarness();
    const client = createKannaClient(
      createLanTransport(
        "http://127.0.0.1:48120",
        createLanFetchFixture(),
        harness.factory,
        {
          deviceCredentials: {
            deviceId: "mobile-device-1",
            deviceSecret: "paired-secret"
          }
        }
      )
    );
    const store = createSessionStore();
    controller = createMobileController(client, store);

    await act(async () => {
      await controller?.bootstrap();
      await flushMicrotasks();
    });

    const activeController = controller;
    if (!activeController) throw new Error("controller was not created");
    await act(async () => {
      rendered = create(
        <NavigatorHarness activeController={activeController} store={store} />
      );
      await flushMicrotasks();
    });

    const terminalSocket = harness.sockets.find((socket) =>
      socket.sentFrames.some(
        (frame) =>
          frame.type === "attach" &&
          frame.task_id === TASK_ID &&
          frame.kind === "terminal"
      )
    );
    if (!terminalSocket) {
      throw new Error(
        "opening the task route did not attach a terminal stream over KSP; frames: " +
        JSON.stringify(harness.sockets.map((socket) => socket.sentFrames))
      );
    }

    const taskScreen = rendered?.root.findByType("TaskScreen" as never);
    if (!taskScreen) throw new Error("TaskScreen was not rendered");
    expect(taskScreen.props.terminalInputUnavailableReason).toBeNull();
    const onSendTerminalInput = taskScreen.props.onSendTerminalInput as
      | ((dataB64: string, kind: "draft" | "submission" | "control") => void)
      | undefined;
    expect(onSendTerminalInput).toBeTypeOf("function");

    await act(async () => {
      onSendTerminalInput?.(SCROLL_INPUT_B64, "control");
      await flushMicrotasks();
    });

    const frameTypes = terminalSocket.sentFrames.map((frame) => frame.type);
    expect(frameTypes.indexOf("term_input_control")).toBeGreaterThan(
      frameTypes.indexOf("attach")
    );
    expect(terminalSocket.sentFrames).toContainEqual({
      type: "term_input_control",
      task_id: TASK_ID,
      data_b64: SCROLL_INPUT_B64
    });

    const termInputCount = () =>
      terminalSocket.sentFrames.filter((frame) => frame.type === "term_input_control").length;
    const beforeEmptyPayload = termInputCount();
    await act(async () => {
      onSendTerminalInput?.("", "control");
      await flushMicrotasks();
    });
    expect(termInputCount()).toBe(beforeEmptyPayload);

    const escapeKey = rendered?.root.findByProps({
      testID: "mobile.task-terminal-key.escape"
    });
    const enterKey = rendered?.root.findByProps({
      testID: "mobile.task-terminal-key.enter"
    });
    await act(async () => {
      escapeKey?.props.onPress();
      enterKey?.props.onPress();
      await flushMicrotasks();
    });
    expect(terminalSocket.sentFrames).toContainEqual({
      type: "term_input",
      task_id: TASK_ID,
      data_b64: ESC_INPUT_B64
    });
    expect(terminalSocket.sentFrames).toContainEqual({
      type: "term_input_boundary",
      task_id: TASK_ID,
      data_b64: ENTER_INPUT_B64
    });
  });
});
