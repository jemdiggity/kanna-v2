import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../appError";
import { resetDaemonReadyObservationForTests } from "./daemonReadyState";
import { bytesToBase64 } from "./terminalInputQueue";

const markTaskSwitchFirstOutputMock = vi.hoisted(() => vi.fn());
const forwardTerminalRuntimeStatusMock = vi.hoisted(() => vi.fn(async () => {}));
const invokeMock = vi.fn();
const listenMock = vi.fn();
const warningToastMock = vi.fn();
const errorToastMock = vi.fn();
const respawnedToastMessage = "The previous terminal session could not be reattached. A new session was started.";
const respawnedWithScrollbackToastMessage =
  "The previous terminal session could not be reattached. Scrollback was restored and a new session was started.";
const daemonHandoffRespawnedToastMessage =
  "The previous terminal session could not be reattached after restart. A new session was started.";
const streamClientMock = vi.hoisted(() => ({
  getSharedStreamClient: vi.fn(),
  onSharedStreamConnectionChange: vi.fn(),
  resetSharedStreamClientForTests: vi.fn(),
}));
const eventListeners = new Map<string, ((event: any) => void)[]>();
interface TerminalStreamHandlers {
  onSnapshot?: (
    cols: number,
    rows: number,
    dataB64: string,
    agentProvider?: "claude" | "codex" | "copilot" | "opencode" | "antigravity" | null,
  ) => void;
  onOutput: (dataB64: string, metadata?: { receivedAtMs: number }) => void;
  onStatus?: (status: string) => void;
  onSessionExit?: (code: number) => void;
  onError?: (code: string, message: string) => void;
}

const terminalStreamHandlers = new Map<string, TerminalStreamHandlers>();
const onWebviewDragDropEventMock = vi.fn();
const onWindowDragDropEventMock = vi.fn();
let nativeWebviewDragDropHandler: ((event: any) => void) | null = null;
let nativeWindowDragDropHandler: ((event: any) => void) | null = null;
let isTauriMock = false;

async function waitForQueuedInputFlush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.resolve();
}

function terminalKeydown(
  key: string,
  options: { isComposing?: boolean; keyCode?: number } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    isComposing: options.isComposing ?? false,
  });
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: options.keyCode });
  }
  return event;
}

function emitTerminalSnapshot(
  sessionId: string,
  vt = "restored scrollback",
) {
  terminalStreamHandlers.get(sessionId)?.onSnapshot?.(80, 24, btoa(vt));
  const listeners = eventListeners.get("terminal_snapshot") ?? [];
  for (const listener of listeners) {
    listener({
      payload: {
        session_id: sessionId,
        snapshot: {
          version: 1,
          rows: 24,
          cols: 80,
          cursor_row: 0,
          cursor_col: 0,
          cursor_visible: true,
          vt,
        },
      },
    });
  }
}

function installKspStreamClient(options: {
  onAttach?: (taskId: string, handlers: TerminalStreamHandlers) => void;
} = {}) {
  const attachTerminal = vi.fn((taskId: string, handlers: TerminalStreamHandlers) => {
    terminalStreamHandlers.set(taskId, handlers);
    options.onAttach?.(taskId, handlers);
  });
  const sendTermInput = vi.fn();
  const sendTermResize = vi.fn();
  const detach = vi.fn();
  const client = {
    attachTerminal,
    sendTermInput,
    sendTermResize,
    detach,
  };
  streamClientMock.getSharedStreamClient.mockResolvedValue(client);
  return client;
}

async function flushAsyncWork(attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface PendingWrite {
  data: string | Uint8Array;
  callback?: () => void;
}

class FakeTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  buffer = {
    active: {
      baseY: 0,
      viewportY: 0,
      length: 0,
      getLine: () => null,
    },
  };
  element: HTMLElement | null = null;
  pendingStringWrites: PendingWrite[] = [];
  reset = vi.fn();
  loadAddon = vi.fn();
  open = vi.fn((element: HTMLElement) => {
    this.element = element;
  });
  attachCustomKeyEventHandler = vi.fn();
  onData = vi.fn();
  onResize = vi.fn();
  onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
  registerLinkProvider = vi.fn();
  getSelection = vi.fn(() => "");
  scrollToLine = vi.fn();
  scrollToBottom = vi.fn();
  dispose = vi.fn();
  write = vi.fn((data: string | Uint8Array, callback?: () => void) => {
    if (typeof data === "string") {
      this.pendingStringWrites.push({ data, callback });
      return;
    }
    callback?.();
  });

  flushNextStringWrite() {
    const pending = this.pendingStringWrites.shift();
    pending?.callback?.();
  }
}

const terminals: FakeTerminal[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function TerminalMock(options?: Record<string, unknown>) {
    const terminal = new FakeTerminal();
    terminal.options = { ...(options ?? {}) };
    terminals.push(terminal);
    return terminal;
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class {},
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("../perf/taskSwitchPerf", () => ({
  markTaskSwitchFirstOutput: (...args: unknown[]) => markTaskSwitchFirstOutputMock(...args),
}));

vi.mock("./terminalRuntimeStatusSink", () => ({
  forwardTerminalRuntimeStatus: (...args: unknown[]) => forwardTerminalRuntimeStatusMock(...args),
  subscribeTerminalRuntimeStatus: vi.fn(() => () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: onWebviewDragDropEventMock,
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: onWindowDragDropEventMock,
  }),
}));

vi.mock("../tauri-mock", () => ({
  get isTauri() {
    return isTauriMock;
  },
  mockInvoke: invokeMock,
  mockListen: listenMock,
}));

vi.mock("./desktopStreamClient", () => streamClientMock);

vi.mock("./useToast", () => ({
  useToast: () => ({
    warning: warningToastMock,
    error: errorToastMock,
  }),
}));

vi.mock("../i18n", () => ({
  default: {
    global: {
      t: (key: string) =>
        ({
          "toasts.sessionRespawned": respawnedToastMessage,
          "toasts.sessionRespawnedWithScrollback": respawnedWithScrollbackToastMessage,
          "toasts.daemonHandoffRespawned": daemonHandoffRespawnedToastMessage,
        })[key] ?? key,
    },
  },
}));

describe("useTerminal", () => {
  beforeEach(() => {
    if (!("SVGElement" in globalThis)) {
      // happy-dom preload does not currently expose this global.
      // Vue runtime-dom checks it during mount.
      // @ts-expect-error test shim
      globalThis.SVGElement = class SVGElement {};
    }
    if (!("Element" in globalThis)) {
      // @ts-expect-error test shim
      globalThis.Element = window.Element;
    }
    invokeMock.mockReset();
    listenMock.mockReset();
    warningToastMock.mockReset();
    errorToastMock.mockReset();
    eventListeners.clear();
    terminalStreamHandlers.clear();
    nativeWebviewDragDropHandler = null;
    nativeWindowDragDropHandler = null;
    isTauriMock = false;
    onWebviewDragDropEventMock.mockReset();
    onWindowDragDropEventMock.mockReset();
    onWebviewDragDropEventMock.mockImplementation(async (handler: (event: any) => void) => {
      nativeWebviewDragDropHandler = handler;
      return () => {
        if (nativeWebviewDragDropHandler === handler) {
          nativeWebviewDragDropHandler = null;
        }
      };
    });
    onWindowDragDropEventMock.mockImplementation(async (handler: (event: any) => void) => {
      nativeWindowDragDropHandler = handler;
      return () => {
        if (nativeWindowDragDropHandler === handler) {
          nativeWindowDragDropHandler = null;
        }
      };
    });
    terminals.length = 0;
    markTaskSwitchFirstOutputMock.mockReset();
    forwardTerminalRuntimeStatusMock.mockReset();
    resetDaemonReadyObservationForTests();
    streamClientMock.getSharedStreamClient.mockReset();
    streamClientMock.onSharedStreamConnectionChange.mockReset();
    streamClientMock.resetSharedStreamClientForTests.mockReset();
    streamClientMock.getSharedStreamClient.mockResolvedValue({
      attachTerminal: vi.fn((taskId: string, handlers: {
        onSnapshot?: (cols: number, rows: number, dataB64: string) => void;
        onOutput: (dataB64: string) => void;
        onStatus?: (status: string) => void;
        onSessionExit?: (code: number) => void;
        onError?: (code: string, message: string) => void;
      }) => {
        terminalStreamHandlers.set(taskId, handlers);
        void invokeMock("attach_session_with_snapshot", { sessionId: taskId }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          handlers.onError?.("daemon", message);
        });
        handlers.onSnapshot?.(80, 24, btoa("restored scrollback"));
      }),
      sendTermInput: vi.fn((taskId: string, dataB64: string) => {
        const binary = atob(dataB64);
        invokeMock("send_input", {
          sessionId: taskId,
          data: Array.from(binary, (char) => char.charCodeAt(0)),
        });
      }),
      sendTermResize: vi.fn((taskId: string, cols: number, rows: number) => {
        invokeMock("resize_session", { sessionId: taskId, cols, rows });
      }),
      detach: vi.fn((taskId: string) => {
        invokeMock("detach_session", { sessionId: taskId });
      }),
    });
    streamClientMock.onSharedStreamConnectionChange.mockReturnValue(() => {});
    listenMock.mockImplementation(async (eventName: string, handler: (event: any) => void) => {
      const listeners = eventListeners.get(eventName) ?? [];
      listeners.push(handler);
      eventListeners.set(eventName, listeners);
      return () => {
        const current = eventListeners.get(eventName) ?? [];
        eventListeners.set(
          eventName,
          current.filter((listener) => listener !== handler),
        );
      };
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attach_session_with_snapshot") {
        emitTerminalSnapshot("session-1");
        return null;
      }
      if (cmd === "get_session_recovery_state") {
        return {
          serialized: "restored scrollback",
          cols: 80,
          rows: 24,
          cursorRow: 1,
          cursorCol: 0,
          cursorVisible: true,
          savedAt: 1,
          sequence: 1,
        };
      }
      return null;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { resetTerminalOutputSubscriptionsForTests } = await import("./useTerminal");
    resetTerminalOutputSubscriptionsForTests();
    streamClientMock.getSharedStreamClient.mockReset();
    streamClientMock.onSharedStreamConnectionChange.mockReset();
    streamClientMock.resetSharedStreamClientForTests.mockReset();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    listenMock.mockReset();
    eventListeners.clear();
    warningToastMock.mockReset();
    errorToastMock.mockReset();
    vi.clearAllMocks();
  });

  it("attaches local PTY terminals over KSP frames and sends input and resize through the stream client", async () => {
    let terminalHandlers: {
      onSnapshot?: (cols: number, rows: number, dataB64: string) => void;
      onOutput: (dataB64: string) => void;
      onSessionExit?: (code: number) => void;
    } | null = null;
    const attachTerminal = vi.fn((_taskId: string, handlers: NonNullable<typeof terminalHandlers>) => {
      terminalHandlers = handlers;
      handlers.onSnapshot?.(80, 24, btoa("restored over ksp"));
    });
    const sendTermInput = vi.fn();
    const sendTermResize = vi.fn();
    const detach = vi.fn();
    streamClientMock.getSharedStreamClient.mockResolvedValue({
      attachTerminal,
      sendTermInput,
      sendTermResize,
      detach,
    });

    const { useTerminal } = await import("./useTerminal");
    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "claude",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();

    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    expect(attachTerminal).toHaveBeenCalledWith("session-1", expect.objectContaining({
      onOutput: expect.any(Function),
    }));
    expect(listenMock).not.toHaveBeenCalledWith("terminal_output", expect.any(Function));
    expect(invokeMock).not.toHaveBeenCalledWith("attach_session_with_snapshot", expect.anything());

    const onData = terminal.onData.mock.calls[0]?.[0];
    expect(onData).toBeDefined();
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0]?.[0] as
      | ((event: KeyboardEvent) => boolean)
      | undefined;
    expect(keyHandler).toBeDefined();
    keyHandler?.(new KeyboardEvent("keydown", { key: "x" }));
    onData("x");
    await waitForQueuedInputFlush();
    expect(sendTermInput).toHaveBeenCalledWith("session-1", btoa("x"), false, false);

    // CompositionHelper emits the committed IME text from setTimeout(0),
    // after the compositionend event and its microtask checkpoint. An Enter
    // after that completed commit is a separate submission boundary.
    terminalElement.dispatchEvent(new Event("compositionstart"));
    terminalElement.dispatchEvent(new Event("compositionend"));
    await Promise.resolve();
    onData("界");
    await waitForQueuedInputFlush();
    expect(sendTermInput).toHaveBeenLastCalledWith(
      "session-1",
      bytesToBase64(new TextEncoder().encode("界")),
      false,
      false,
    );

    keyHandler?.(terminalKeydown("Enter", { keyCode: 13 }));
    onData("\r");
    await waitForQueuedInputFlush();
    expect(sendTermInput).toHaveBeenLastCalledWith("session-1", btoa("\r"), true, false);

    // A non-process Enter (keyCode 13) while composition is active makes
    // CompositionHelper synchronously emit two onData events: committed text,
    // then CR. The Enter finalizes the draft; it does not submit it.
    terminalElement.dispatchEvent(new Event("compositionstart"));
    keyHandler?.(terminalKeydown("Enter", { keyCode: 13 }));
    onData("候補");
    onData("\r");
    await waitForQueuedInputFlush();
    expect(sendTermInput).toHaveBeenLastCalledWith(
      "session-1",
      bytesToBase64(new TextEncoder().encode("候補\r")),
      false,
      false,
    );

    // The following ordinary Enter owns the boundary.
    keyHandler?.(terminalKeydown("Enter", { keyCode: 13 }));
    onData("\r");
    await waitForQueuedInputFlush();
    expect(sendTermInput).toHaveBeenLastCalledWith("session-1", btoa("\r"), true, false);

    // A compositionend commit and the following Enter can occur in the same
    // tick. Consuming the committed text returns the lifecycle to idle before
    // the Enter is classified, so the boundary is not lost to a timer.
    terminalElement.dispatchEvent(new Event("compositionstart"));
    terminalElement.dispatchEvent(new Event("compositionend"));
    onData("即");
    keyHandler?.(terminalKeydown("Enter", { keyCode: 13 }));
    onData("\r");
    await waitForQueuedInputFlush();
    expect(sendTermInput).toHaveBeenNthCalledWith(
      sendTermInput.mock.calls.length - 1,
      "session-1",
      bytesToBase64(new TextEncoder().encode("即")),
      false,
      false,
    );
    expect(sendTermInput).toHaveBeenLastCalledWith("session-1", btoa("\r"), true, false);

    // Parser-generated terminal replies have no preceding DOM producer event.
    // They are control input, not a human composer draft that may fence later
    // logical messages such as transfer wrap-up and quit submissions.
    await Promise.resolve();
    onData("\x1b[?1;2c");
    await waitForQueuedInputFlush();
    expect(sendTermInput).toHaveBeenLastCalledWith("session-1", btoa("\x1b[?1;2c"), false, true);

    const onResize = terminal.onResize.mock.calls[0]?.[0];
    expect(onResize).toBeDefined();
    onResize({ cols: 100, rows: 32 });
    expect(sendTermResize).toHaveBeenCalledWith("session-1", 100, 32);

    terminalHandlers?.onOutput(btoa("live over ksp"));
    expect(terminal.write).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Function),
    );
    const outputWrite = terminal.write.mock.calls.find(
      ([data]) => data instanceof Uint8Array,
    );
    outputWrite?.[1]?.();

    wrapper.unmount();
    expect(detach).toHaveBeenCalledWith("session-1", "terminal");
  });

  it("re-attaches when the session is respawned even though the terminal still believes it is attached", async () => {
    // Stage transitions kill + respawn the same session id. The kill can race
    // ahead of (or never produce) an exit signal, so the SessionCreated
    // broadcast must force a rebind even while `attached` is still true —
    // otherwise the terminal freezes on the dead predecessor session.
    const attachTerminal = vi.fn((taskId: string, handlers: TerminalStreamHandlers) => {
      terminalStreamHandlers.set(taskId, handlers);
      handlers.onSnapshot?.(80, 24, btoa("stage snapshot"));
    });
    streamClientMock.getSharedStreamClient.mockResolvedValue({
      attachTerminal,
      sendTermInput: vi.fn(),
      sendTermResize: vi.fn(),
      detach: vi.fn(),
    });

    const { useTerminal } = await import("./useTerminal");
    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "claude",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();
    await flushAsyncWork();
    expect(attachTerminal).toHaveBeenCalledTimes(1);

    for (const listener of eventListeners.get("session_created") ?? []) {
      listener({ payload: { session_id: "session-1" } });
    }
    await flushAsyncWork();

    expect(attachTerminal).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it("uses the daemon-reported provider for snapshot reset behavior", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("restored scrollback"), "claude");
      },
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            // Deliberately stale task configuration: the live daemon session
            // is Claude and must own reconnect behavior.
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();

    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    expect(client.attachTerminal).toHaveBeenCalledWith("session-1", expect.objectContaining({
      onSnapshot: expect.any(Function),
      onOutput: expect.any(Function),
    }));
    expect(client.sendTermResize).toHaveBeenCalledOnce();
    expect(client.sendTermResize).toHaveBeenCalledWith("session-1", 80, 24);
    expect(invokeMock).not.toHaveBeenCalledWith("attach_session_with_snapshot", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("resume_session_stream", expect.anything());
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(terminal.pendingStringWrites.some((write) => write.data === "restored scrollback")).toBe(true);
  });

  it("preserves Codex scrollback when applying daemon snapshots", async () => {
    let terminalHandlers: {
      onSnapshot?: (
        cols: number,
        rows: number,
        dataB64: string,
        agentProvider?: "claude" | "codex" | null,
      ) => void;
      onOutput: (dataB64: string) => void;
      onSessionExit?: (code: number) => void;
    } | null = null;
    const attachTerminal = vi.fn((_taskId: string, handlers: NonNullable<typeof terminalHandlers>) => {
      terminalHandlers = handlers;
    });
    streamClientMock.getSharedStreamClient.mockResolvedValue({
      attachTerminal,
      sendTermInput: vi.fn(),
      sendTermResize: vi.fn(),
      detach: vi.fn(),
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    terminal.reset.mockClear();

    terminalHandlers?.onSnapshot?.(80, 24, btoa("codex partial redraw"), "codex");

    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledWith("codex partial redraw");
  });

  it("falls back to the configured Codex provider when a daemon snapshot omits it", async () => {
    let terminalHandlers: TerminalStreamHandlers | null = null;
    const attachTerminal = vi.fn((_taskId: string, handlers: TerminalStreamHandlers) => {
      terminalHandlers = handlers;
    });
    streamClientMock.getSharedStreamClient.mockResolvedValue({
      attachTerminal,
      sendTermInput: vi.fn(),
      sendTermResize: vi.fn(),
      detach: vi.fn(),
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    terminal.reset.mockClear();

    terminalHandlers?.onSnapshot?.(80, 24, btoa("legacy daemon partial redraw"));

    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledWith("legacy daemon partial redraw");
  });

  it("updates xterm theme when the effective code theme changes", async () => {
    const { resetThemeRuntimeForTests, setSystemPrefersDark, setThemePreferences } = await import("../theme/runtime");
    resetThemeRuntimeForTests();
    setSystemPrefersDark(false);
    setThemePreferences({ appTheme: "dark", codeTheme: "match" });

    const { useTerminal } = await import("./useTerminal");
    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal("session-1");
        return { init };
      },
      render() {
        return h("div", { ref: "host" });
      },
    });

    const wrapper = mount(TestHarness);
    const element = wrapper.element as HTMLElement;
    (wrapper.vm as unknown as { init: (el: HTMLElement) => void }).init(element);

    expect(terminals.at(-1)?.options.theme).toMatchObject({ background: "#20242d" });

    setThemePreferences({ appTheme: "light", codeTheme: "match" });
    await Promise.resolve();

    expect(terminals.at(-1)?.options.theme).toMatchObject({ background: "#f6f9ff" });

    wrapper.unmount();
    resetThemeRuntimeForTests();
  });

  it("opens ordinary terminal web links externally but dispatches image links for in-app preview", async () => {
    isTauriMock = true;
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    vi.mocked(openUrl).mockResolvedValue(undefined);
    const { useTerminal } = await import("./useTerminal");
    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal("session-1");
        return { init };
      },
      render() {
        return h("div", { ref: "host" });
      },
    });
    const imageEvents: unknown[] = [];
    document.addEventListener("image-link-activate", (event) => {
      imageEvents.push((event as CustomEvent).detail);
    });

    const wrapper = mount(TestHarness);
    const element = wrapper.element as HTMLElement;
    (wrapper.vm as unknown as { init: (el: HTMLElement) => void }).init(element);
    const activate = terminals.at(-1)?.options.linkHandler as { activate: (event: MouseEvent, uri: string) => void };

    activate.activate(new MouseEvent("click"), "https://example.com/report");
    activate.activate(new MouseEvent("click"), "https://example.com/screenshot.png");

    expect(openUrl).toHaveBeenCalledWith("https://example.com/report");
    expect(openUrl).not.toHaveBeenCalledWith("https://example.com/screenshot.png");
    expect(imageEvents).toEqual([{ url: "https://example.com/screenshot.png" }]);

    wrapper.unmount();
  });

  it("detaches the active task session stream when the terminal unmounts", async () => {
    const callOrder: string[] = [];
    const { useTerminal } = await import("./useTerminal");
    invokeMock.mockImplementation(async (cmd: string) => {
      callOrder.push(cmd);
      if (cmd === "attach_session_with_snapshot") {
        emitTerminalSnapshot("session-1");
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "claude",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;

    wrapper.unmount();

    for (let attempt = 0; attempt < 10 && !callOrder.includes("detach_session"); attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(callOrder).toEqual([
      "attach_session_with_snapshot",
      "resize_session",
      "resize_session",
      "detach_session",
    ]);
  });

  it("respawns a task terminal from a KSP missing-session error when recovery scrollback exists", async () => {
    const spawnFn = vi.fn(async () => {});
    const { useTerminal } = await import("./useTerminal");
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        if (client.attachTerminal.mock.calls.length > 1) {
          handlers.onSnapshot?.(80, 24, btoa("fresh session output"));
        }
      },
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_recovery_state") {
        return {
          serialized: "restored scrollback",
          cols: 80,
          rows: 24,
          cursorRow: 1,
          cursorCol: 0,
          cursorVisible: true,
          savedAt: 1,
          sequence: 7,
        };
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn,
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    expect(spawnFn).not.toHaveBeenCalled();
    expect(warningToastMock).not.toHaveBeenCalled();

    terminalStreamHandlers.get("session-1")?.onError?.("session_not_found", "session not found: session-1");
    await flushAsyncWork();

    expect(warningToastMock).toHaveBeenCalledWith(respawnedWithScrollbackToastMessage);
    expect(errorToastMock).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
    expect(terminal.write).toHaveBeenCalledWith("restored scrollback");
    expect(
      terminal.write.mock.calls.some(
        ([data]) =>
          typeof data === "string" &&
          data.includes("Failed to reconnect to existing session"),
      ),
    ).toBe(false);
  });

  it("does not block task respawn on recovery scrollback replay", async () => {
    const spawnFn = vi.fn(async () => {});
    const { useTerminal } = await import("./useTerminal");
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        if (client.attachTerminal.mock.calls.length > 1) {
          handlers.onSnapshot?.(80, 24, btoa("fresh session output"));
        }
      },
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_recovery_state") {
        return {
          serialized: "large restored scrollback",
          cols: 80,
          rows: 24,
          cursorRow: 1,
          cursorCol: 0,
          cursorVisible: true,
          savedAt: 1,
          sequence: 7,
        };
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn,
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();

    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    terminalStreamHandlers.get("session-1")?.onError?.("session_not_found", "session not found: session-1");
    await flushAsyncWork();

    expect(terminal.pendingStringWrites.some((write) => write.data === "large restored scrollback")).toBe(true);
    expect(terminal.pendingStringWrites.some((write) => write.data === "fresh session output")).toBe(true);
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
    expect(warningToastMock).toHaveBeenCalledWith(respawnedWithScrollbackToastMessage);
  });

  it("respawns when the KSP stream reports a missing task session after initial attach", async () => {
    const spawnFn = vi.fn(async () => {});
    const { useTerminal } = await import("./useTerminal");
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        if (client.attachTerminal.mock.calls.length === 1) {
          handlers.onSnapshot?.(80, 24, btoa("initial scrollback"));
          return;
        }
        handlers.onSnapshot?.(80, 24, btoa("fresh session output"));
      },
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_recovery_state") {
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn,
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();
    terminalStreamHandlers.get("session-1")?.onError?.("session_not_found", "session not found: session-1");
    await flushAsyncWork();

    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(warningToastMock).toHaveBeenCalledWith(respawnedToastMessage);
    expect(errorToastMock).not.toHaveBeenCalled();
    expect(
      terminal.write.mock.calls.some(
        ([data]) =>
          typeof data === "string" &&
          data.includes("Knock, knock, Neo."),
      ),
    ).toBe(false);
  });

  it("respawns a task session after a KSP handoff-lost error when the worktree still exists", async () => {
    const spawnFn = vi.fn(async () => {});
    const { useTerminal } = await import("./useTerminal");
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        if (client.attachTerminal.mock.calls.length === 1) {
          handlers.onError?.("handoff_lost", "handoff lost for session-1");
          return;
        }
        handlers.onSnapshot?.(80, 24, btoa("fresh session output"));
      },
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_recovery_state") {
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn,
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();
    await flushAsyncWork();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(warningToastMock).toHaveBeenCalledWith(daemonHandoffRespawnedToastMessage);
    expect(errorToastMock).not.toHaveBeenCalled();
    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
    expect(terminal.write.mock.calls.some(([data]) => data === "fresh session output")).toBe(true);
    expect(
      terminal.write.mock.calls.some(
        ([data]) =>
          typeof data === "string" &&
          data.includes("Knock, knock, Neo."),
      ),
    ).toBe(false);
  });

  it("attaches freshly spawned task sessions from a KSP snapshot after respawn", async () => {
    const spawnFn = vi.fn(async () => {});
    const { useTerminal } = await import("./useTerminal");
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        if (client.attachTerminal.mock.calls.length === 1) {
          handlers.onError?.("handoff_lost", "handoff lost for session-1");
          return;
        }
        handlers.onSnapshot?.(80, 24, btoa("fresh session output"));
      },
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_recovery_state") {
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn,
          },
          {
            agentProvider: "claude",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();
    await flushAsyncWork();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "resume_session_stream")).toHaveLength(0);
    expect(terminals[0]?.reset).toHaveBeenCalledTimes(1);
  });

  it("spawns a shell terminal when no pre-warmed session exists", async () => {
    const spawnFn = vi.fn(async () => {});
    const { useTerminal } = await import("./useTerminal");
    const client = installKspStreamClient();

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "shell-wt-1",
          {
            cwd: "/tmp/task",
            prompt: "",
            spawnFn,
          },
          undefined,
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith("shell-wt-1", "/tmp/task", "", 80, 24);
    expect(errorToastMock).not.toHaveBeenCalled();
    expect(client.attachTerminal).toHaveBeenCalledWith("shell-wt-1", expect.objectContaining({
      onOutput: expect.any(Function),
    }));
  });

  it("attaches a pre-warmed shell terminal when spawn reports the session already exists", async () => {
    const spawnFn = vi.fn(async () => {
      throw new AppError("session already exists: shell-wt-1", "session_already_exists");
    });
    const { useTerminal } = await import("./useTerminal");
    const client = installKspStreamClient();

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "shell-wt-1",
          {
            cwd: "/tmp/task",
            prompt: "",
            spawnFn,
          },
          undefined,
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(errorToastMock).not.toHaveBeenCalled();
    expect(client.attachTerminal).toHaveBeenCalledWith("shell-wt-1", expect.objectContaining({
      onOutput: expect.any(Function),
    }));
  });

  it("respawns once when a previously attached task session disappears from the KSP stream", async () => {
    const spawnFn = vi.fn(async () => {});
    const { useTerminal } = await import("./useTerminal");
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        const attachCount = client.attachTerminal.mock.calls.length;
        if (attachCount === 1) {
          handlers.onSnapshot?.(80, 24, btoa("initial scrollback"));
          return;
        }
        if (attachCount === 2) {
          handlers.onError?.("session_not_found", "session not found: session-1");
          return;
        }
        handlers.onSnapshot?.(80, 24, btoa("respawned scrollback"));
      },
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_recovery_state") {
        return {
          serialized: "restored scrollback",
          cols: 80,
          rows: 24,
          cursorRow: 1,
          cursorCol: 0,
          cursorVisible: true,
          savedAt: 1,
          sequence: 7,
        };
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn,
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    const streamLostListeners = eventListeners.get("session_stream_lost") ?? [];
    expect(streamLostListeners).toHaveLength(1);

    streamLostListeners[0]({ payload: { session_id: "session-1" } });
    await flushAsyncWork();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(client.attachTerminal).toHaveBeenCalledTimes(3);
    expect(warningToastMock).toHaveBeenCalledWith(respawnedWithScrollbackToastMessage);
  });

  it("attaches Copilot sessions without replaying recovery state on first mount", async () => {
    const callOrder: string[] = [];
    const { useTerminal } = await import("./useTerminal");
    invokeMock.mockImplementation(async (cmd: string) => {
      callOrder.push(cmd);
      if (cmd === "attach_session_with_snapshot") {
        emitTerminalSnapshot("session-1", "restored copilot scrollback");
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "copilot",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;

    expect(callOrder).toEqual([
      "attach_session_with_snapshot",
      "resize_session",
    ]);
    expect(terminal.reset).toHaveBeenCalledTimes(2);
  });

  it("reconnects immediately after session_stream_lost for task terminals", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("restored copilot scrollback"));
      },
    });
    const { useTerminal } = await import("./useTerminal");

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_recovery_state") {
        return {
          serialized: "restored copilot scrollback",
          cols: 80,
          rows: 24,
          cursorRow: 1,
          cursorCol: 0,
          cursorVisible: true,
          savedAt: 1,
          sequence: 10,
        };
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "copilot",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;

    expect(client.attachTerminal).toHaveBeenCalledTimes(1);

    const streamLostListeners = eventListeners.get("session_stream_lost") ?? [];
    const daemonReadyListeners = eventListeners.get("daemon_ready") ?? [];
    expect(streamLostListeners).toHaveLength(1);
    expect(daemonReadyListeners).toHaveLength(1);

    streamLostListeners[0]({ payload: { session_id: "session-1" } });
    await flushAsyncWork();

    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
    expect(client.sendTermResize).toHaveBeenCalledTimes(2);
    expect(terminal.reset).toHaveBeenCalledTimes(2);
  });

  it("rebinds to the respawned session on session_created while still attached (stage swap)", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("stage scrollback"));
      },
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;

    expect(client.attachTerminal).toHaveBeenCalledTimes(1);

    // Stage swap: the engine killed this session id and respawned it with the
    // next stage's agent. The swap's Exit may be processed after the
    // SessionCreated broadcast, so the terminal can still believe it is
    // attached — the rebind must not depend on an exit latch.
    const createdListeners = eventListeners.get("session_created") ?? [];
    expect(createdListeners).toHaveLength(1);
    createdListeners[0]({ payload: { session_id: "session-1" } });
    await flushAsyncWork();

    expect(client.attachTerminal).toHaveBeenCalledTimes(2);

    // A created event for some other session must not disturb this terminal.
    createdListeners[0]({ payload: { session_id: "session-2" } });
    await flushAsyncWork();
    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
  });

  it("rebinds after the killed session's exit followed by session_created", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("stage scrollback"));
      },
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;

    expect(client.attachTerminal).toHaveBeenCalledTimes(1);

    // The daemon now announces orchestrated kills before the respawn, so the
    // exit-then-created ordering is the common stage-swap sequence.
    const exitListeners = eventListeners.get("session_exit") ?? [];
    expect(exitListeners).toHaveLength(1);
    exitListeners[0]({ payload: { session_id: "session-1", code: -1, killed: true } });

    const createdListeners = eventListeners.get("session_created") ?? [];
    expect(createdListeners).toHaveLength(1);
    createdListeners[0]({ payload: { session_id: "session-1" } });
    await flushAsyncWork();

    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }

    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
  });

  it("reattaches on reselect after the session was killed and respawned while the view was paused", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("stage scrollback"));
      },
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_sessions") {
        return [{ session_id: "session-1" }];
      }
      return null;
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening, pause } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening, pause };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    expect(client.attachTerminal).toHaveBeenCalledTimes(1);

    // The stage engine kills the session while the view is attached; the
    // exit frame latches the exit state.
    terminalStreamHandlers.get("session-1")?.onSessionExit?.(-1);

    // The view pauses (task deselected) before the respawn, so the
    // session_created rebind for the new PTY is never delivered.
    wrapper.vm.pause();
    await flushAsyncWork();

    // Reselect: the resume probe sees the session id live again in the
    // daemon, clears the stale exit latch, and reattaches.
    const resumePromise = wrapper.vm.startListening();
    await flushAsyncWork();
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await resumePromise;

    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
    expect(warningToastMock).not.toHaveBeenCalled();
  });

  it("keeps the exit latch on resume when the daemon session is gone", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("stage scrollback"));
      },
    });
    const spawnFn = vi.fn(async () => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_sessions") {
        return [];
      }
      return null;
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening, pause } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn,
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening, pause };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    expect(client.attachTerminal).toHaveBeenCalledTimes(1);

    terminalStreamHandlers.get("session-1")?.onSessionExit?.(0);
    wrapper.vm.pause();
    await flushAsyncWork();

    await wrapper.vm.startListening();
    await flushAsyncWork();

    expect(client.attachTerminal).toHaveBeenCalledTimes(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(warningToastMock).not.toHaveBeenCalled();
  });

  it("defers a session_created that arrives during an in-flight reconnect", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("stage scrollback"));
      },
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    expect(client.attachTerminal).toHaveBeenCalledTimes(1);

    const createdListeners = eventListeners.get("session_created") ?? [];
    expect(createdListeners).toHaveLength(1);

    // First created starts a rebind (connecting flips synchronously); the
    // second lands mid-connect and must be applied after it settles instead
    // of being dropped.
    createdListeners[0]({ payload: { session_id: "session-1" } });
    createdListeners[0]({ payload: { session_id: "session-1" } });
    await flushAsyncWork();
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await flushAsyncWork();

    expect(client.attachTerminal).toHaveBeenCalledTimes(3);
  });

  it("does not fabricate an attachment when the stream connection returns after the session exited", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("stage scrollback"));
      },
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    expect(client.attachTerminal).toHaveBeenCalledTimes(1);

    terminalStreamHandlers.get("session-1")?.onSessionExit?.(0);
    const resizeCallsAfterExit = client.sendTermResize.mock.calls.length;

    const connectionListener = streamClientMock.onSharedStreamConnectionChange.mock.calls[0]?.[0] as
      | ((connected: boolean) => void)
      | undefined;
    expect(connectionListener).toBeDefined();
    connectionListener?.(true);
    await flushAsyncWork();

    // The exited session has no live attachment to resync: no resize against
    // a dead session and no new attach while the exit latch holds.
    expect(client.sendTermResize.mock.calls.length).toBe(resizeCallsAfterExit);
    expect(client.attachTerminal).toHaveBeenCalledTimes(1);
  });

  it("marks the terminal ended after session_exit so ensureConnected does not reattach", async () => {
    const callOrder: string[] = [];
    const { useTerminal } = await import("./useTerminal");
    let resizeCount = 0;

    invokeMock.mockImplementation(async (cmd: string) => {
      callOrder.push(cmd);
      if (cmd === "attach_session_with_snapshot") {
        emitTerminalSnapshot("session-1");
        return null;
      }
      if (cmd === "get_session_recovery_state") {
        return {
          serialized: "restored scrollback",
          cols: 80,
          rows: 24,
          cursorRow: 1,
          cursorCol: 0,
          cursorVisible: true,
          savedAt: 1,
          sequence: 12,
        };
      }
      if (cmd === "resize_session") {
        resizeCount += 1;
        if (resizeCount === 2) {
          throw new AppError("session not found: session-1", "session_not_found");
        }
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening, ensureConnected } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "copilot",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening, ensureConnected };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();

    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;

    const exitListeners = eventListeners.get("session_exit") ?? [];
    expect(exitListeners).toHaveLength(1);
    exitListeners[0]({ payload: { session_id: "session-1", code: 0 } });

    const ensurePromise = wrapper.vm.ensureConnected();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (terminal.pendingStringWrites.length > 0) {
        terminal.flushNextStringWrite();
        await Promise.resolve();
      }
      if (callOrder.length >= 5) break;
    }

    await ensurePromise;

    // ensureConnected probes the daemon for a stage-swap respawn before
    // honoring the exit latch; with the session gone the latch holds and no
    // reattach happens.
    expect(callOrder).toEqual([
      "attach_session_with_snapshot",
      "resize_session",
      "list_sessions",
    ]);
  });

  it("does not respawn a task terminal after the agent process exits normally", async () => {
    const spawnFn = vi.fn(async () => {});
    const { useTerminal } = await import("./useTerminal");
    let exited = false;

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attach_session_with_snapshot") {
        if (exited) {
          throw new AppError("session not found: session-1", "session_not_found");
        }
        emitTerminalSnapshot("session-1");
        return null;
      }
      if (cmd === "get_session_recovery_state") {
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn,
          },
          {
            agentProvider: "codex",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    await wrapper.vm.startListening();

    const exitListeners = eventListeners.get("session_exit") ?? [];
    const daemonReadyListeners = eventListeners.get("daemon_ready") ?? [];
    expect(exitListeners).toHaveLength(1);
    expect(daemonReadyListeners).toHaveLength(1);

    exited = true;
    exitListeners[0]({ payload: { session_id: "session-1", code: 0 } });
    daemonReadyListeners[0]({ payload: {} });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(spawnFn).not.toHaveBeenCalled();
    expect(warningToastMock).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "attach_session_with_snapshot")).toHaveLength(1);
  });

  it("re-attaches during daemon turnover without depending on snapshot replay", async () => {
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        handlers.onSnapshot?.(80, 24, btoa("restored copilot scrollback"));
      },
    });
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "copilot",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    expect(terminal.reset).toHaveBeenCalledTimes(1);

    const streamLostListeners = eventListeners.get("session_stream_lost") ?? [];
    expect(streamLostListeners).toHaveLength(1);
    streamLostListeners[0]({ payload: { session_id: "session-1" } });

    await flushAsyncWork();

    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
    expect(client.sendTermResize).toHaveBeenCalledTimes(2);
    expect(terminal.reset).toHaveBeenCalledTimes(2);
  });

  it("suppresses browser navigation and pastes dropped file paths into agent terminals", async () => {
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal(
          "session-1",
          undefined,
          {
            agentTerminal: true,
            worktreePath: "/tmp/task",
          },
        );

        return { init };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const dropEvent = new Event("drop") as Event & {
      dataTransfer: { files: Array<{ path: string; type: string }> };
      preventDefault: ReturnType<typeof vi.fn>;
      stopPropagation: ReturnType<typeof vi.fn>;
    };
    dropEvent.dataTransfer = {
      files: [{ path: "/tmp/task/screenshot one.png", type: "image/png" }],
    };
    dropEvent.preventDefault = vi.fn();
    dropEvent.stopPropagation = vi.fn();

    terminalElement.dispatchEvent(dropEvent);
    await waitForQueuedInputFlush();

    expect(dropEvent.preventDefault).toHaveBeenCalled();
    expect(dropEvent.stopPropagation).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "session-1",
      data: Array.from(new TextEncoder().encode("'/tmp/task/screenshot one.png'")),
    });
  });

  it("wraps dropped file paths in bracketed paste markers after attach snapshots enable bracketed paste", async () => {
    const { useTerminal } = await import("./useTerminal");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attach_session_with_snapshot") {
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "",
            spawnFn: async () => {},
          },
          {
            agentProvider: "claude",
            agentTerminal: true,
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    emitTerminalSnapshot("session-1", "\u001b[?2004hrestored scrollback");
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }

    invokeMock.mockClear();

    const dropEvent = new Event("drop") as Event & {
      dataTransfer: { files: Array<{ path: string; type: string }> };
      preventDefault: ReturnType<typeof vi.fn>;
      stopPropagation: ReturnType<typeof vi.fn>;
    };
    dropEvent.dataTransfer = {
      files: [{ path: "/tmp/task/screenshot one.png", type: "image/png" }],
    };
    dropEvent.preventDefault = vi.fn();
    dropEvent.stopPropagation = vi.fn();

    terminalElement.dispatchEvent(dropEvent);
    await waitForQueuedInputFlush();

    expect(invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "session-1",
      data: Array.from(new TextEncoder().encode("\u001b[200~'/tmp/task/screenshot one.png'\u001b[201~")),
    });
  });

  it("pastes native Tauri window drop paths for agent terminals when browser files do not expose path", async () => {
    isTauriMock = true;
    vi.resetModules();
    const { useTerminal } = await import("./useTerminal");

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attach_session_with_snapshot") {
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "",
            spawnFn: async () => {},
          },
          {
            agentProvider: "claude",
            agentTerminal: true,
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    terminalElement.getBoundingClientRect = vi.fn(() => ({
      x: 240,
      y: 180,
      left: 240,
      top: 180,
      right: 1040,
      bottom: 780,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    })) as typeof terminalElement.getBoundingClientRect;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    emitTerminalSnapshot("session-1", "\u001b[?2004hrestored scrollback");
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }

    invokeMock.mockClear();
    expect(nativeWindowDragDropHandler).not.toBeNull();

    nativeWindowDragDropHandler?.({
      payload: {
        type: "drop",
        paths: ["/tmp/task/screenshot one.png"],
        position: {
          x: 320,
          y: 260,
        },
      },
    });
    await waitForQueuedInputFlush();

    expect(invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "session-1",
      data: Array.from(new TextEncoder().encode("\u001b[200~'/tmp/task/screenshot one.png'\u001b[201~")),
    });
  });

  it("pastes native Tauri webview drop paths when the runtime exposes logical conversion", async () => {
    isTauriMock = true;
    vi.resetModules();
    const { useTerminal } = await import("./useTerminal");

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attach_session_with_snapshot") {
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "",
            spawnFn: async () => {},
          },
          {
            agentProvider: "claude",
            agentTerminal: true,
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    terminalElement.getBoundingClientRect = vi.fn(() => ({
      x: 240,
      y: 180,
      left: 240,
      top: 180,
      right: 1040,
      bottom: 780,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    })) as typeof terminalElement.getBoundingClientRect;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    emitTerminalSnapshot("session-1", "\u001b[?2004hrestored scrollback");
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }

    invokeMock.mockClear();
    expect(nativeWebviewDragDropHandler).not.toBeNull();

    nativeWebviewDragDropHandler?.({
      payload: {
        type: "drop",
        paths: ["/tmp/task/screenshot one.png"],
        position: {
          x: 640,
          y: 520,
          toLogical: () => ({ x: 320, y: 260 }),
        },
      },
    });
    await waitForQueuedInputFlush();

    expect(invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "session-1",
      data: Array.from(new TextEncoder().encode("\u001b[200~'/tmp/task/screenshot one.png'\u001b[201~")),
    });
  });

  it("deduplicates native Tauri drop events when window and webview listeners both fire", async () => {
    isTauriMock = true;
    vi.resetModules();
    const { useTerminal } = await import("./useTerminal");

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attach_session_with_snapshot") {
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "",
            spawnFn: async () => {},
          },
          {
            agentProvider: "codex",
            agentTerminal: true,
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    terminalElement.getBoundingClientRect = vi.fn(() => ({
      x: 240,
      y: 180,
      left: 240,
      top: 180,
      right: 1040,
      bottom: 780,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    })) as typeof terminalElement.getBoundingClientRect;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;
    emitTerminalSnapshot("session-1", "\u001b[?2004hrestored scrollback");
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }

    invokeMock.mockClear();

    const dropEvent = {
      payload: {
        type: "drop",
        paths: ["/tmp/task/screenshot one.png"],
        position: {
          x: 320,
          y: 260,
          toLogical: () => ({ x: 320, y: 260 }),
        },
      },
    };

    nativeWindowDragDropHandler?.(dropEvent);
    nativeWebviewDragDropHandler?.(dropEvent);
    await waitForQueuedInputFlush();

    const sendInputCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "send_input");
    expect(sendInputCalls).toHaveLength(1);
    expect(sendInputCalls[0]).toEqual(["send_input", {
      sessionId: "session-1",
      data: Array.from(new TextEncoder().encode("\u001b[200~'/tmp/task/screenshot one.png'\u001b[201~")),
    }]);
  });

  it("treats Copilot drops as bracketed paste even when the restored stream does not advertise bracketed mode", async () => {
    isTauriMock = true;
    vi.resetModules();
    const { useTerminal } = await import("./useTerminal");

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "attach_session_with_snapshot") {
        emitTerminalSnapshot("session-1", "restored copilot scrollback");
        return null;
      }
      return null;
    });

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "",
            spawnFn: async () => {},
          },
          {
            agentProvider: "copilot",
            agentTerminal: true,
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    terminalElement.getBoundingClientRect = vi.fn(() => ({
      x: 240,
      y: 180,
      left: 240,
      top: 180,
      right: 1040,
      bottom: 780,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    })) as typeof terminalElement.getBoundingClientRect;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    for (let attempt = 0; attempt < 10 && terminal.pendingStringWrites.length === 0; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (terminal.pendingStringWrites.length > 0) {
      terminal.flushNextStringWrite();
      await Promise.resolve();
    }
    await startPromise;

    invokeMock.mockClear();

    nativeWindowDragDropHandler?.({
      payload: {
        type: "drop",
        paths: ["/tmp/task/ChatGPT Image Feb 21, 2026, 12_59_00 AM.png"],
        position: {
          x: 320,
          y: 260,
        },
      },
    });
    await waitForQueuedInputFlush();

    expect(invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "session-1",
      data: Array.from(new TextEncoder().encode("\u001b[200~'/tmp/task/ChatGPT Image Feb 21, 2026, 12_59_00 AM.png'\u001b[201~")),
    });
  });

  it("does not install dropped-file handlers for non-agent terminals", async () => {
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal(
          "session-1",
          undefined,
          {
            agentTerminal: false,
          },
        );

        return { init };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    const addEventListenerSpy = vi.spyOn(terminalElement, "addEventListener");

    wrapper.vm.init(terminalElement);

    expect(addEventListenerSpy).not.toHaveBeenCalledWith("drop", expect.any(Function), undefined);
  });

  it("reads clipboard image data on Cmd+V for agent terminals", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_clipboard_image_png") {
        return {
          mimeType: "image/png",
          pngBase64: "aGVsbG8=",
          width: 1,
          height: 1,
        };
      }
      return null;
    });

    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal(
          "session-1",
          undefined,
          {
            agentTerminal: true,
          },
        );

        return { init };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const terminal = terminals[0];
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0] as (event: KeyboardEvent) => boolean;
    const keyboardEvent = {
      type: "keydown",
      key: "v",
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    const allowed = keyHandler(keyboardEvent);
    await waitForQueuedInputFlush();

    expect(allowed).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("read_clipboard_image_png", {});
  });

  it("does not force-push kitty keyboard mode when creating a Claude terminal", async () => {
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal(
          "session-1",
          undefined,
          {
            agentProvider: "claude",
            kittyKeyboard: true,
            agentTerminal: true,
          },
        );

        return { init };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const terminal = terminals[0];
    expect(terminal.write).not.toHaveBeenCalledWith("\x1b[>1u");
  });

  it("sends Shift+Enter as kitty CSI-u modified Enter for agent terminals", async () => {
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal(
          "session-1",
          undefined,
          {
            agentProvider: "claude",
            agentTerminal: true,
          },
        );

        return { init };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const terminal = terminals[0];
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0] as (event: KeyboardEvent) => boolean;
    const keyboardEvent = {
      type: "keydown",
      key: "Enter",
      shiftKey: true,
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    const allowed = keyHandler(keyboardEvent);
    await waitForQueuedInputFlush();

    expect(allowed).toBe(false);
    expect(keyboardEvent.preventDefault).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "session-1",
      data: Array.from(new TextEncoder().encode("\x1b[13;2u")),
    });
  });

  it("batches rapid terminal keystrokes into a single daemon write", async () => {
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init } = useTerminal(
          "session-1",
          undefined,
          {
            agentProvider: "claude",
            agentTerminal: true,
          },
        );

        return { init };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const terminal = terminals[0];
    const onData = terminal.onData.mock.calls[0][0] as (data: string) => void;
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0] as
      (event: KeyboardEvent) => boolean;

    keyHandler(new KeyboardEvent("keydown", { key: "a" }));
    onData("a");
    keyHandler(new KeyboardEvent("keydown", { key: "b" }));
    onData("b");
    keyHandler(new KeyboardEvent("keydown", { key: "c" }));
    onData("c");

    expect(invokeMock).not.toHaveBeenCalledWith("send_input", expect.anything());

    await waitForQueuedInputFlush();

    const sendInputCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "send_input");
    expect(sendInputCalls).toHaveLength(1);
    expect(sendInputCalls[0]).toEqual(["send_input", {
      sessionId: "session-1",
      data: Array.from(new TextEncoder().encode("abc")),
    }]);
  });

  it("responds to kitty clipboard image reads after an explicit paste", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "read_clipboard_image_png") {
        return {
          mimeType: "image/png",
          pngBase64: "aGVsbG8=",
          width: 1,
          height: 1,
        };
      }
      if (cmd === "attach_session_with_snapshot") {
        return null;
      }
      return null;
    });

    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "",
            spawnFn: async () => {},
          },
          {
            agentTerminal: true,
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);
    await wrapper.vm.startListening();

    const terminal = terminals[0];
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0] as (event: KeyboardEvent) => boolean;
    keyHandler({
      type: "keydown",
      key: "v",
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    await Promise.resolve();

    const kittyRequest = new TextEncoder().encode("\u001b]5522;type=read;aW1hZ2UvcG5n\u0007");
    terminalStreamHandlers.get("session-1")?.onOutput(btoa(String.fromCharCode(...kittyRequest)));

    for (let attempt = 0; attempt < 10 && !invokeMock.mock.calls.some(([cmd]) => cmd === "send_input"); attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(invokeMock).toHaveBeenCalledWith("send_input", expect.objectContaining({
      sessionId: "session-1",
      data: expect.any(Array),
    }));
  });

  it("does not force-scroll the viewport after manual scrollback during live output", async () => {
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "copilot",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    const viewport = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn((selector: string) => {
      return selector === ".xterm-viewport" ? viewport : null;
    }) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);
    await wrapper.vm.startListening();

    const terminal = terminals[0];
    expect(terminal).toBeDefined();
    terminal.buffer.active.viewportY = 12;

    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));

    const outputListener = eventListeners.get("terminal_output")?.[0];
    outputListener?.({
      payload: {
        session_id: "session-1",
        data: Array.from(new TextEncoder().encode("streaming output")),
      },
    });

    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("routes KSP terminal output to the matching mounted terminal only", async () => {
    const client = installKspStreamClient();
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      props: {
        sessionId: {
          type: String,
          required: true,
        },
      },
      setup(props) {
        const { init, startListening } = useTerminal(props.sessionId);
        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const first = mount(TestHarness, { props: { sessionId: "session-1" } });
    const second = mount(TestHarness, { props: { sessionId: "session-2" } });
    const firstElement = document.createElement("div");
    const secondElement = document.createElement("div");
    Object.defineProperty(firstElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(firstElement, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(secondElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(secondElement, "offsetHeight", { configurable: true, value: 600 });

    first.vm.init(firstElement);
    second.vm.init(secondElement);
    await first.vm.startListening();
    await second.vm.startListening();

    expect(client.attachTerminal).toHaveBeenCalledTimes(2);
    expect(listenMock.mock.calls.filter(([eventName]) => eventName === "terminal_output")).toHaveLength(0);

    terminalStreamHandlers.get("session-2")?.onOutput(btoa("streaming output"));

    expect(terminals[0]?.write.mock.calls.some(([data]) => data instanceof Uint8Array)).toBe(false);
    expect(terminals[1]?.write.mock.calls.some(([data]) => data instanceof Uint8Array)).toBe(true);

    first.unmount();
    second.unmount();
  });

  it("pauses a kept-alive terminal by detaching its KSP terminal stream", async () => {
    const client = installKspStreamClient();
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening, pause } = useTerminal("session-1");
        return { init, startListening, pause };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);
    await wrapper.vm.startListening();

    expect(client.attachTerminal).toHaveBeenCalledWith("session-1", expect.objectContaining({
      onOutput: expect.any(Function),
    }));

    wrapper.vm.pause();

    expect(client.detach).toHaveBeenCalledWith("session-1", "terminal");
    expect(eventListeners.get("terminal_output") ?? []).toHaveLength(0);

    wrapper.unmount();
  });

  it("does not attach a KSP terminal stream when startListening is paused before connect", async () => {
    const { useTerminal } = await import("./useTerminal");
    let resolveStreamClient: ((client: ReturnType<typeof installKspStreamClient>) => void) | null = null;
    const attachTerminal = vi.fn();
    const client = {
      attachTerminal,
      sendTermInput: vi.fn(),
      sendTermResize: vi.fn(),
      detach: vi.fn(),
    };
    streamClientMock.getSharedStreamClient.mockReturnValue(
      new Promise((resolve) => {
        resolveStreamClient = resolve;
      }),
    );

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening, pause } = useTerminal("session-1");
        return { init, startListening, pause };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);

    const startPromise = wrapper.vm.startListening();
    await Promise.resolve();
    wrapper.vm.pause();

    resolveStreamClient?.(client);
    await startPromise;

    expect(attachTerminal).not.toHaveBeenCalled();
    expect(eventListeners.get("terminal_output") ?? []).toHaveLength(0);

    const terminal = terminals[0];
    terminal.write.mockClear();

    expect(terminal.write).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("keeps the prompt visible when resizing from the bottom of scrollback", async () => {
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, fit } = useTerminal("session-1");
        return { init, fit };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    wrapper.vm.init(terminalElement);

    const terminal = terminals[0];
    terminal.buffer.active.baseY = 12;
    terminal.buffer.active.viewportY = 12;

    wrapper.vm.fit();

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("does not jump to the bottom when resizing after manual scrollback", async () => {
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, fit } = useTerminal("session-1");
        return { init, fit };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    wrapper.vm.init(terminalElement);

    const terminal = terminals[0];
    terminal.buffer.active.baseY = 12;
    terminal.buffer.active.viewportY = 8;

    wrapper.vm.fit();

    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("marks the first live output once per selected terminal session", async () => {
    installKspStreamClient();
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal(
          "session-1",
          {
            cwd: "/tmp/task",
            prompt: "hello",
            spawnFn: async () => {},
          },
          {
            agentProvider: "copilot",
            worktreePath: "/tmp/task",
          },
        );

        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);
    await wrapper.vm.startListening();

    terminalStreamHandlers.get("session-1")?.onOutput(btoa("streaming output"));
    terminalStreamHandlers.get("session-1")?.onOutput(btoa("more output"));

    expect(markTaskSwitchFirstOutputMock).toHaveBeenCalledTimes(2);
    expect(markTaskSwitchFirstOutputMock).toHaveBeenNthCalledWith(1, "session-1");
    expect(markTaskSwitchFirstOutputMock).toHaveBeenNthCalledWith(2, "session-1");

    wrapper.unmount();
  });

  it("forwards KSP terminal status with the daemon session id", async () => {
    installKspStreamClient();
    const { useTerminal } = await import("./useTerminal");

    const TestHarness = defineComponent({
      setup() {
        const { init, startListening } = useTerminal("session-1");
        return { init, startListening };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);
    await wrapper.vm.startListening();

    terminalStreamHandlers.get("session-1")?.onStatus?.("busy");

    expect(forwardTerminalRuntimeStatusMock).toHaveBeenCalledWith("session-1", "busy");
    wrapper.unmount();
  });
  it("backs off repeated attach refusals once per interval and resets after recovery", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { useTerminal } = await import("./useTerminal");
    const refusal = "session requires authenticated operator input: refused-session";
    let attachCount = 0;
    const client = installKspStreamClient({
      onAttach: (_taskId, handlers) => {
        attachCount += 1;
        if (attachCount <= 7) {
          throw new AppError(refusal, "input_unauthorized");
        }
      },
    });
    const TestHarness = defineComponent({
      setup() {
        const terminalApi = useTerminal("refused-session", undefined, {
          agentProvider: "codex",
          worktreePath: "/tmp/task",
        });
        return {
          ...terminalApi,
          redraw: terminalApi.redraw,
          ensureConnected: terminalApi.ensureConnected,
        };
      },
      render() { return h("div"); },
    });
    const wrapper = mount(TestHarness);
    const terminalElement = document.createElement("div");
    Object.defineProperty(terminalElement, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(terminalElement, "offsetHeight", { configurable: true, value: 600 });
    terminalElement.querySelector = vi.fn(() => null) as typeof terminalElement.querySelector;
    terminalElement.closest = vi.fn(() => null) as typeof terminalElement.closest;
    wrapper.vm.init(terminalElement);
    await wrapper.vm.startListening();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      terminalStreamHandlers.get("refused-session")?.onError?.("input_unauthorized", refusal);
      await Promise.resolve();
      await Promise.resolve();
    }

    const failureWrites = terminals[0]?.write.mock.calls.filter(
      ([data]) => typeof data === "string" && data.includes("Failed to reconnect"),
    ) ?? [];
    expect(failureWrites).toHaveLength(1);
    expect(failureWrites[0]?.[0]).toContain("Retrying in 1s");
    expect(failureWrites[0]?.[0]).toContain("reopen the task to retry now");

    const initialResizeCount = client.sendTermResize.mock.calls.length;
    expect(attachCount).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(attachCount).toBe(1);
    expect(client.sendTermResize).toHaveBeenCalledTimes(initialResizeCount);
    await vi.advanceTimersByTimeAsync(1);
    expect(attachCount).toBe(2);

    // The duplicate callbacks above produced no doomed attach or resize and
    // did not inflate this second backoff interval.
    expect(client.sendTermResize).toHaveBeenCalledTimes(initialResizeCount);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attachCount).toBe(3);
    expect(client.sendTermResize).toHaveBeenCalledTimes(initialResizeCount);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(attachCount).toBe(4);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(attachCount).toBe(5);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(attachCount).toBe(6);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attachCount).toBe(7);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attachCount).toBe(8);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual(
      expect.arrayContaining([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]),
    );
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(2);

    // Successful attach/resize clears both the visible latch and the retry
    // attempt. Ordinary redraw, explicit reconnect checks, and shared-stream
    // resize all resume after recovery.
    const resizeCountAfterRecovery = client.sendTermResize.mock.calls.length;
    await wrapper.vm.redraw();
    await wrapper.vm.ensureConnected();
    const connectionListener = streamClientMock.onSharedStreamConnectionChange.mock.calls[0]?.[0] as
      | ((connected: boolean) => void)
      | undefined;
    connectionListener?.(true);
    await Promise.resolve();
    expect(client.sendTermResize.mock.calls.length).toBeGreaterThan(resizeCountAfterRecovery);

    terminalStreamHandlers.get("refused-session")?.onError?.("input_unauthorized", refusal);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(attachCount).toBe(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(attachCount).toBe(9);
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(2);

    wrapper.vm.dispose();
    vi.useRealTimers();
  });
});
