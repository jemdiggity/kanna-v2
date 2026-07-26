// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clientFactory: vi.fn(),
  dataListener: null as ((data: string) => void) | null,
  sendInput: vi.fn(),
  subscriptionListener: null as ((event: Record<string, unknown>) => void) | null,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    onData(listener: (data: string) => void) {
      harness.dataListener = listener;
      return { dispose() {} };
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
    harness.sendInput
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => second.promise);
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
    ).toBe("abc");

    second.resolve();
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
});
