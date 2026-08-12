// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clientFactory: vi.fn(),
  clients: [] as Array<Record<string, any>>,
  fitCalls: 0,
  focusedTerminal: null as Record<string, any> | null,
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  resizeCallbacks: [] as ResizeObserverCallback[],
  selection: "",
  sendInput: vi.fn(),
  terminals: [] as Array<Record<string, any>>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    dataListener: ((data: string) => void) | null = null;
    writes: string[] = [];
    constructor() {
      harness.terminals.push(this);
    }
    getSelection() {
      return harness.selection;
    }
    attachCustomKeyEventHandler(listener: (event: KeyboardEvent) => boolean) {
      harness.keyHandler = listener;
    }
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose() {} };
    }
    loadAddon() {}
    open() {}
    reset() {}
    write(data: string) { this.writes.push(data); }
    focus() { harness.focusedTerminal = this; }
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() { harness.fitCalls += 1; }
  },
}));

vi.mock("../../services/desktopRelayTerminal", () => ({
  createConfiguredDesktopRelayTerminalClient: harness.clientFactory,
}));

vi.mock("../../services/desktopLanTerminal", () => ({
  createConfiguredDesktopLanTerminalClient: vi.fn(),
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

function terminalClient(sendInput = harness.sendInput) {
  const client: Record<string, any> = {
    close: vi.fn(),
    observeTerminal: vi.fn((options: {
      taskId: string;
      listener: (event: Record<string, unknown>) => void;
    }) => {
      client.listener = options.listener;
      queueMicrotask(() => options.listener({ type: "ready", taskId: options.taskId }));
      return { close: vi.fn() };
    }),
    sendInput,
    resize: vi.fn(async () => {}),
  };
  harness.clients.push(client);
  return client;
}

describe("CloudTerminalView remote input", () => {
  beforeEach(() => {
    harness.clientFactory.mockReset();
    harness.clients = [];
    harness.fitCalls = 0;
    harness.focusedTerminal = null;
    harness.keyHandler = null;
    harness.resizeCallbacks = [];
    harness.selection = "";
    harness.sendInput.mockReset();
    harness.sendInput.mockResolvedValue(undefined);
    harness.terminals = [];
    harness.clientFactory.mockResolvedValue(terminalClient());
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        harness.resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();
  });

  it("sends Shift+Enter as kitty CSI-u modified Enter", async () => {
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();
    const event = {
      type: "keydown",
      key: "Enter",
      shiftKey: true,
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(harness.keyHandler?.(event)).toBe(false);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.sendInput).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\x1b[13;2u",
    });
    wrapper.unmount();
  });

  it("copies selected text with Command+C", async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    harness.selection = "selected remote output";
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: { ownerDesktopId: "desktop-1", ownerTaskId: "task-1" },
    });
    await flushPromises();
    const event = {
      type: "keydown",
      key: "c",
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(harness.keyHandler?.(event)).toBe(false);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("selected remote output");
    expect(harness.sendInput).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("leaves Command+C to xterm when there is no selection", async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: { ownerDesktopId: "desktop-1", ownerTaskId: "task-1" },
    });
    await flushPromises();
    const event = {
      type: "keydown",
      key: "c",
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(harness.keyHandler?.(event)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(clipboardWriteText).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps inactive output warm, resizes on reactivation, and sends input through the selected cached terminal", async () => {
    harness.clients = [];
    const firstSendInput = vi.fn().mockResolvedValue(undefined);
    const secondSendInput = vi.fn().mockResolvedValue(undefined);
    const clients = [terminalClient(firstSendInput), terminalClient(secondSendInput)];
    harness.clients = clients;
    harness.clientFactory.mockReset();
    harness.clientFactory
      .mockResolvedValueOnce(clients[0])
      .mockResolvedValueOnce(clients[1]);
    const { default: CloudTerminalCache } = await import("../CloudTerminalCache.vue");
    const wrapper = mount(CloudTerminalCache, {
      props: {
        activeTerminal: {
          key: "task-1",
          ownerDesktopId: "desktop-1",
          ownerTaskId: "task-1",
          transport: "cloud",
        },
      },
    });
    await flushPromises();
    const firstTerminal = harness.terminals[0];
    clients[0]?.resize.mockClear();

    await wrapper.setProps({
      activeTerminal: {
        key: "task-2",
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-2",
        transport: "cloud",
      },
    });
    await flushPromises();
    expect(harness.focusedTerminal).toBe(harness.terminals[1]);
    clients[0]?.listener({ type: "output", taskId: "task-1", text: "inactive output" });
    expect(firstTerminal?.writes).toContain("inactive output");

    await wrapper.setProps({
      activeTerminal: {
        key: "task-1",
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();

    expect(harness.clientFactory).toHaveBeenCalledTimes(2);
    expect(harness.terminals[0]).toBe(firstTerminal);
    expect(clients[0]?.close).not.toHaveBeenCalled();
    expect(clients[0]?.resize).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      cols: 80,
      rows: 24,
    });
    expect(harness.focusedTerminal).toBe(firstTerminal);
    firstTerminal?.dataListener?.("selected cached input");
    await flushPromises();
    expect(firstSendInput).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "selected cached input",
    });
    expect(secondSendInput).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("reattaches an inactive exited terminal when a replacement with the same id is selected", async () => {
    harness.clients = [];
    const replacementSendInput = vi.fn().mockResolvedValue(undefined);
    const initialClient = terminalClient();
    const replacementClient = terminalClient(replacementSendInput);
    harness.clients = [initialClient, replacementClient];
    harness.clientFactory.mockReset();
    harness.clientFactory
      .mockResolvedValueOnce(initialClient)
      .mockResolvedValueOnce(replacementClient);
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        active: true,
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-reused",
      },
    });
    await flushPromises();

    await wrapper.setProps({ active: false });
    initialClient.listener({ type: "exit", taskId: "task-reused", code: 0 });
    await wrapper.setProps({ active: true });
    await flushPromises();
    replacementClient.listener({ type: "output", taskId: "task-reused", text: "replacement live" });
    harness.terminals[0]?.dataListener?.("resumed input");
    await flushPromises();

    expect(harness.clientFactory).toHaveBeenCalledTimes(2);
    expect(initialClient.close).toHaveBeenCalledOnce();
    expect(harness.terminals[0]?.writes).toContain("replacement live");
    expect(replacementSendInput).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-reused",
      data: "resumed input",
    });
    wrapper.unmount();
  });
});
