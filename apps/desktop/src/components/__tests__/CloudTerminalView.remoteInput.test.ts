// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clientFactory: vi.fn(),
  dataListener: null as ((data: string) => void) | null,
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  sendInput: vi.fn(),
  subscriptionListener: null as ((event: Record<string, unknown>) => void) | null,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    getSelection() {
      return "";
    }
    onData(listener: (data: string) => void) {
      harness.dataListener = listener;
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(listener: (event: KeyboardEvent) => boolean) {
      harness.keyHandler = listener;
    }
    loadAddon() {}
    open() {}
    reset() {}
    write() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("../../services/desktopRelayTerminal", () => ({
  createConfiguredDesktopRelayTerminalClient: harness.clientFactory,
}));

vi.mock("../../services/desktopLanTerminal", () => ({
  createConfiguredDesktopLanTerminalClient: vi.fn(),
}));

vi.mock("../../composables/useToast", () => ({
  useToast: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("../../services/desktopCompanionBridge", () => ({
  desktopCompanionRemoteKey: (desktopId: string, taskId: string) => `${desktopId}:${taskId}`,
  getDesktopCompanionBridgeManager: () => ({
    adoptRemote: () => ({ release() {} }),
    openForClickedLink: async () => ({ kind: "ordinary", url: "" }),
    openCurrent: async () => ({ kind: "opened" }),
  }),
}));

vi.mock("../../composables/remoteTerminalFileLinks", () => ({
  createRemoteTerminalFileLinkProvider: () => ({
    register() {},
    clearFileCache() {},
  }),
}));

vi.mock("../../theme/runtime", () => ({
  useThemeRuntime: () => ({ effectiveCodeTheme: { __v_isRef: true, value: "dark" } }),
}));

vi.mock("../../theme/theme", () => ({
  getTerminalTheme: () => ({}),
}));

vi.mock("../../e2eTerminalBuffers", () => ({
  registerE2ETerminalBuffer: () => () => {},
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

function terminalClient(sendInput = harness.sendInput) {
  return {
    close: vi.fn(),
    observeTerminal: vi.fn((options: {
      taskId: string;
      listener: (event: Record<string, unknown>) => void;
    }) => {
      harness.subscriptionListener = options.listener;
      queueMicrotask(() => options.listener({ type: "ready", taskId: options.taskId }));
      return { close: vi.fn() };
    }),
    sendInput,
    resize: vi.fn(async () => {}),
    readTaskFile: vi.fn(async () => ({ path: "", content: "" })),
  };
}

describe("CloudTerminalView", () => {
  beforeEach(() => {
    harness.clientFactory.mockReset();
    harness.dataListener = null;
    harness.keyHandler = null;
    harness.subscriptionListener = null;
    harness.sendInput.mockReset();
    harness.clientFactory.mockImplementation(async () => terminalClient());
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
  });

  it("keeps one terminal input request in flight and preserves FIFO bytes", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    harness.sendInput
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementation(() => third.promise);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    harness.dataListener?.("a");
    harness.dataListener?.("b");
    harness.dataListener?.("c");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledTimes(1);
    expect(harness.sendInput.mock.calls[0]?.[0]).toMatchObject({ data: "a" });

    first.resolve();
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledTimes(2);
    expect(
      harness.sendInput.mock.calls.map(([request]) => request.data).join(""),
    ).toBe("ab");

    second.resolve();
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledTimes(3);
    expect(
      harness.sendInput.mock.calls.map(([request]) => request.data).join(""),
    ).toBe("abc");

    third.resolve();
    wrapper.unmount();
  });

  it("sends Shift+Enter as kitty CSI-u modified Enter through the remote transport", async () => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();
    const keyboardEvent = {
      type: "keydown",
      key: "Enter",
      shiftKey: true,
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    const allowed = harness.keyHandler?.(keyboardEvent);
    await flushPromises();

    expect(allowed).toBe(false);
    expect(keyboardEvent.preventDefault).toHaveBeenCalledOnce();
    expect(harness.sendInput).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\x1b[13;2u",
    });
    wrapper.unmount();
  });

  it("classifies unclassified xterm data as control and keyboard data as draft", async () => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    harness.keyHandler?.(new KeyboardEvent("keydown", { key: "x" }));
    harness.dataListener?.("x");
    await flushPromises();
    expect(harness.sendInput).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "x",
    });

    harness.dataListener?.("\x1b[0n");
    await flushPromises();
    expect(harness.sendInput).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\x1b[0n",
      controlInput: true,
    });
    wrapper.unmount();
  });

  it.each([
    "beforeinput",
    "paste",
    "compositionstart",
    "compositionupdate",
  ])("classifies %s-produced xterm data as draft", async (eventName) => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    wrapper.get(".terminal-container").element.dispatchEvent(new Event(eventName));
    harness.dataListener?.("human-input");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "human-input",
    });
    wrapper.unmount();
  });

  it("keeps delayed compositionend data classified as draft", async () => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    wrapper.get(".terminal-container").element.dispatchEvent(new Event("compositionend"));
    await Promise.resolve();
    harness.dataListener?.("界");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "界",
    });
    wrapper.unmount();
  });

  it("keeps both onData emissions from a composition-finalizing Enter as draft", async () => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    wrapper.get(".terminal-container").element.dispatchEvent(new Event("compositionstart"));
    harness.keyHandler?.(terminalKeydown("Enter", { keyCode: 13 }));
    harness.dataListener?.("候補");
    harness.dataListener?.("\r");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "候補",
    });
    expect(harness.sendInput).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\r",
    });
    wrapper.unmount();
  });

  it("treats an IME process Enter as draft and boundaries only the Enter after commit", async () => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();
    const container = wrapper.get(".terminal-container").element;

    container.dispatchEvent(new Event("compositionstart"));
    harness.keyHandler?.(terminalKeydown("Enter", { isComposing: true, keyCode: 229 }));
    container.dispatchEvent(new Event("compositionend"));
    await Promise.resolve();
    harness.dataListener?.("確定");
    await flushPromises();

    harness.keyHandler?.(terminalKeydown("Enter", { keyCode: 13 }));
    harness.dataListener?.("\r");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "確定",
    });
    expect(harness.sendInput).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\r",
      submissionBoundary: true,
    });
    wrapper.unmount();
  });

  it("preserves the boundary when composition commit and Enter occur in the same tick", async () => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();
    const container = wrapper.get(".terminal-container").element;

    container.dispatchEvent(new Event("compositionstart"));
    container.dispatchEvent(new Event("compositionend"));
    harness.dataListener?.("即");
    harness.keyHandler?.(terminalKeydown("Enter", { keyCode: 13 }));
    harness.dataListener?.("\r");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "即",
    });
    expect(harness.sendInput).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\r",
      submissionBoundary: true,
    });
    wrapper.unmount();
  });

  it("declares an unmodified Enter as a submission boundary", async () => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    harness.keyHandler?.(new KeyboardEvent("keydown", { key: "Enter" }));
    harness.dataListener?.("\r");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\r",
      submissionBoundary: true,
    });
    wrapper.unmount();
  });

  it("keeps a queued draft separate from Enter in the remote input backlog", async () => {
    const first = deferred();
    const draft = deferred();
    harness.sendInput
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => draft.promise)
      .mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    harness.dataListener?.("in-flight");
    harness.keyHandler?.(new KeyboardEvent("keydown", { key: "d" }));
    harness.dataListener?.("draft");
    harness.keyHandler?.(new KeyboardEvent("keydown", { key: "Enter" }));
    harness.dataListener?.("\r");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledTimes(1);
    first.resolve();
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledTimes(2);
    expect(harness.sendInput).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "draft",
    });

    draft.resolve();
    await flushPromises();

    expect(harness.sendInput).toHaveBeenNthCalledWith(3, {
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\r",
      submissionBoundary: true,
    });
    wrapper.unmount();
  });

  it("chunks the largest accepted paste into wire-safe UTF-8 input frames", async () => {
    harness.sendInput.mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();
    const paste = "界".repeat(64 * 1024);

    wrapper.get(".terminal-container").element.dispatchEvent(new Event("paste"));
    harness.dataListener?.(paste);
    await vi.waitFor(() => {
      const sent = harness.sendInput.mock.calls
        .map(([request]) => request.data)
        .join("");
      expect(sent).toBe(paste);
    });

    expect(harness.sendInput.mock.calls.length).toBeGreaterThan(1);
    for (const [request] of harness.sendInput.mock.calls) {
      expect(new TextEncoder().encode(request.data).byteLength).toBeLessThanOrEqual(4 * 1024);
    }
    wrapper.unmount();
  });

  it("keeps a failed input queue in error through later output and rebuilds it on retry", async () => {
    harness.sendInput
      .mockRejectedValueOnce(new Error("peer frame rejected"))
      .mockResolvedValue(undefined);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    harness.keyHandler?.(new KeyboardEvent("keydown", { key: "f" }));
    harness.dataListener?.("first");
    await flushPromises();
    expect(wrapper.attributes("data-status")).toBe("error");

    harness.subscriptionListener?.({
      type: "output",
      taskId: "task-1",
      text: "late output",
    });
    await flushPromises();
    expect(wrapper.attributes("data-status")).toBe("error");

    await wrapper.setProps({ ownerTaskId: "task-2" });
    await flushPromises();
    expect(wrapper.attributes("data-status")).toBe("live");
    harness.keyHandler?.(new KeyboardEvent("keydown", { key: "r" }));
    harness.dataListener?.("retry");
    await flushPromises();

    expect(harness.sendInput).toHaveBeenCalledTimes(2);
    expect(harness.sendInput).toHaveBeenLastCalledWith({
      desktopId: "desktop-1",
      taskId: "task-2",
      data: "retry",
    });
    wrapper.unmount();
  });

  it("closes a delayed client instead of installing it after route replacement", async () => {
    const firstFactory = deferred<ReturnType<typeof terminalClient>>();
    const staleClient = terminalClient();
    const replacementClient = terminalClient();
    harness.clientFactory
      .mockImplementationOnce(() => firstFactory.promise)
      .mockResolvedValueOnce(replacementClient);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    await wrapper.setProps({ ownerTaskId: "task-2" });
    await flushPromises();
    firstFactory.resolve(staleClient);
    await flushPromises();

    expect(staleClient.close).toHaveBeenCalledOnce();
    expect(staleClient.observeTerminal).not.toHaveBeenCalled();
    expect(replacementClient.observeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ desktopId: "desktop-1", taskId: "task-2" }),
    );
    wrapper.unmount();
  });

  it("closes a delayed client instead of installing it after unmount", async () => {
    const factory = deferred<ReturnType<typeof terminalClient>>();
    const staleClient = terminalClient();
    harness.clientFactory.mockImplementationOnce(() => factory.promise);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    wrapper.unmount();
    factory.resolve(staleClient);
    await flushPromises();

    expect(staleClient.close).toHaveBeenCalledOnce();
    expect(staleClient.observeTerminal).not.toHaveBeenCalled();
  });

  it("removes remote input producer listeners on unmount", async () => {
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();
    const container = wrapper.get(".terminal-container").element;
    const removeEventListener = vi.spyOn(container, "removeEventListener");

    wrapper.unmount();

    for (const eventName of [
      "mousedown",
      "mouseup",
      "mousemove",
      "wheel",
      "focus",
      "blur",
      "beforeinput",
      "paste",
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ]) {
      expect(removeEventListener).toHaveBeenCalledWith(eventName, expect.any(Function), true);
    }
  });
});
