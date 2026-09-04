// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloudTerminalView from "../CloudTerminalView.vue";
import type { DesktopRemoteTerminalEvent } from "../../services/desktopRemoteTaskClient";

type LinkHandler = (event: MouseEvent, uri: string) => void;

const testState = vi.hoisted(() => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    dataHandler: ((data: string) => void) | null = null;
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    selection = "";
    loadedAddons: unknown[] = [];
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = handler;
    });
    dispose = vi.fn();
    focus = vi.fn();
    getSelection = vi.fn(() => this.selection);
    loadAddon = vi.fn((addon: unknown) => {
      this.loadedAddons.push(addon);
    });
    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
    });
    open = vi.fn();
    refresh = vi.fn();
    reset = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
      callback?.();
    });

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
    }
  }

  class FakeFitAddon {
    fit = vi.fn();
  }

  class FakeWebLinksAddon {
    constructor(readonly handler: LinkHandler) {}
  }

  return {
    relayFactory: vi.fn(),
    lanFactory: vi.fn(),
    adoptRemote: vi.fn(),
    openForClickedLink: vi.fn(),
    openCurrent: vi.fn(),
    openUrl: vi.fn(),
    toastInfo: vi.fn(),
    toastError: vi.fn(),
    clipboardWriteText: vi.fn(),
    terminalBufferUnregister: vi.fn(),
    ownershipRelease: vi.fn(),
    terminals: [] as FakeTerminal[],
    webLinksAddons: [] as FakeWebLinksAddon[],
    resizeCallbacks: [] as ResizeObserverCallback[],
    effectiveCodeTheme: null as import("vue").Ref<string> | null,
    FakeTerminal,
    FakeFitAddon,
    FakeWebLinksAddon,
  };
});

const mocks = testState;

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(function TerminalMock(options: Record<string, unknown>) {
    const terminal = new testState.FakeTerminal(options);
    testState.terminals.push(terminal);
    return terminal;
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: testState.FakeFitAddon,
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(function WebLinksAddonMock(handler: LinkHandler) {
    const addon = new testState.FakeWebLinksAddon(handler);
    testState.webLinksAddons.push(addon);
    return addon;
  }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: testState.openUrl,
}));

vi.mock("../../services/desktopRelayTerminal", () => ({
  createConfiguredDesktopRelayTerminalClient: testState.relayFactory,
}));

vi.mock("../../composables/remoteTerminalFileLinks", () => ({
  createRemoteTerminalFileLinkProvider: () => ({
    register() {},
    clearFileCache() {},
  }),
}));

vi.mock("../../services/desktopLanTerminal", () => ({
  createConfiguredDesktopLanTerminalClient: testState.lanFactory,
}));

vi.mock("../../services/desktopCompanionBridge", () => ({
  desktopCompanionRemoteKey: (desktopId: string, taskId: string) =>
    JSON.stringify([desktopId, taskId]),
  getDesktopCompanionBridgeManager: () => ({
    adoptRemote: testState.adoptRemote,
    openForClickedLink: testState.openForClickedLink,
    openCurrent: testState.openCurrent,
  }),
}));

vi.mock("../../composables/useToast", () => ({
  useToast: () => ({
    info: testState.toastInfo,
    error: testState.toastError,
  }),
}));

vi.mock("vue-i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-i18n")>();
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) =>
        ({
          "toasts.remoteCompanionStarting": "Starting visual companion…",
          "toasts.remoteCompanionOpenFailed": "Could not open visual companion.",
          "toasts.remoteTerminalFileDropUnavailable": "Files can’t be dropped into a remote terminal.",
          "visualCompanion.open": "Open visual companion",
        })[key] ?? key,
    }),
  };
});

vi.mock("../../theme/runtime", async () => {
  const { ref } = await vi.importActual<typeof import("vue")>("vue");
  testState.effectiveCodeTheme = ref("dark");
  return {
    useThemeRuntime: () => ({
      effectiveCodeTheme: testState.effectiveCodeTheme,
    }),
  };
});

vi.mock("../../theme/theme", () => ({
  getTerminalTheme: (theme: string) => ({ theme }),
}));

vi.mock("../../e2eTerminalBuffers", () => ({
  registerE2ETerminalBuffer: vi.fn(() => testState.terminalBufferUnregister),
}));

vi.mock("../../utils/animationFrame", () => ({
  nextFrameOrTimeout: () => Promise.resolve(),
}));

interface FakeClient {
  close: ReturnType<typeof vi.fn>;
  observeCompanion: ReturnType<typeof vi.fn>;
  observeTerminal: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  closeTask: ReturnType<typeof vi.fn>;
  advanceStage: ReturnType<typeof vi.fn>;
  terminalClose: ReturnType<typeof vi.fn>;
}

function createClient(): FakeClient {
  const terminalClose = vi.fn();
  return {
    close: vi.fn(),
    observeCompanion: vi.fn(),
    observeTerminal: vi.fn(() => ({ close: terminalClose })),
    sendInput: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    closeTask: vi.fn(async () => {}),
    advanceStage: vi.fn(async () => {}),
    terminalClose,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushAsync() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function clickTerminalLink(uri: string) {
  const event = new MouseEvent("click", { cancelable: true });
  testState.webLinksAddons.at(-1)?.handler(event, uri);
  return event;
}

describe("CloudTerminalView remote visual companion links", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    testState.terminals.length = 0;
    testState.webLinksAddons.length = 0;
    testState.resizeCallbacks.length = 0;
    if (testState.effectiveCodeTheme) {
      testState.effectiveCodeTheme.value = "dark";
    }
    vi.clearAllMocks();
    mocks.adoptRemote.mockReturnValue({ release: mocks.ownershipRelease });
    mocks.openForClickedLink.mockResolvedValue({
      kind: "companion",
      bridgeId: "bridge-1",
    });
    mocks.openCurrent.mockResolvedValue({
      kind: "companion",
      bridgeId: "bridge-1",
    });
    mocks.openUrl.mockResolvedValue(undefined);
    mocks.clipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.clipboardWriteText },
    });
    globalThis.ResizeObserver = class ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        testState.resizeCallbacks.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    } as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    globalThis.cancelAnimationFrame = vi.fn();
  });

  it("focuses the remote terminal when it becomes active", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      attachTo: document.body,
      props: {
        active: false,
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    const terminal = testState.terminals[0];
    expect(terminal?.focus).not.toHaveBeenCalled();

    await wrapper.setProps({ active: true });
    await flushAsync();
    await flushAsync();

    expect(terminal?.focus).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("focuses the remote terminal when first opened active", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      attachTo: document.body,
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    expect(testState.terminals[0]?.focus).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("does not focus the remote terminal through a modal overlay", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      attachTo: document.body,
      props: {
        active: false,
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    document.body.appendChild(modal);
    await wrapper.setProps({ active: true });
    await flushAsync();

    expect(testState.terminals[0]?.focus).not.toHaveBeenCalled();
    modal.remove();
    wrapper.unmount();
  });

  it("copies the selected remote terminal text with Command+C", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    const terminal = testState.terminals[0];
    if (!terminal?.keyHandler) throw new Error("terminal key handler was not registered");
    terminal.selection = "selected remote output";
    const event = {
      type: "keydown",
      key: "c",
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(terminal.keyHandler(event)).toBe(false);
    await flushAsync();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.clipboardWriteText).toHaveBeenCalledExactlyOnceWith(
      "selected remote output",
    );
    expect(client.sendInput).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("leaves Command+C to xterm when there is no selection", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    const terminal = testState.terminals[0];
    if (!terminal?.keyHandler) throw new Error("terminal key handler was not registered");
    const event = {
      type: "keydown",
      key: "c",
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(terminal.keyHandler(event)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.clipboardWriteText).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it("adopts the relay transport and routes terminal web links through the companion manager", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);

    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    expect(testState.webLinksAddons).toHaveLength(1);
    expect(mocks.adoptRemote).toHaveBeenCalledWith({
      remoteKey: '["desktop-1","task-1"]',
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: client,
    });
    expect(client.observeTerminal).toHaveBeenCalledWith(expect.objectContaining({
      desktopId: "desktop-1",
      taskId: "task-1",
    }));
    expect(client.observeCompanion).not.toHaveBeenCalled();

    const event = clickTerminalLink("http://localhost:4173/preview");
    await flushAsync();

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.openForClickedLink).toHaveBeenCalledWith(
      '["desktop-1","task-1"]',
      "http://localhost:4173/preview",
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("opens an ordinary URL returned by the manager with the Tauri opener", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    mocks.openForClickedLink.mockResolvedValue({
      kind: "ordinary",
      url: "https://example.com/docs",
    });
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    clickTerminalLink("https://example.com/docs");
    await flushAsync();

    expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/docs");
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("provides a labeled keyboard control that opens the current companion", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    const control = wrapper.get(
      'button[aria-label="Open visual companion"]',
    );
    expect(control.element).toBeInstanceOf(HTMLButtonElement);
    expect(control.attributes("type")).toBe("button");
    await control.trigger("click");
    await flushAsync();

    expect(mocks.openCurrent).toHaveBeenCalledExactlyOnceWith(
      '["desktop-1","task-1"]',
    );
    expect(mocks.openForClickedLink).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows a localized starting toast for an unavailable companion without opening its original URL", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    mocks.openForClickedLink.mockResolvedValue({ kind: "unavailable" });
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    clickTerminalLink("http://127.0.0.1:4173/");
    await flushAsync();

    expect(mocks.toastInfo).toHaveBeenCalledWith("Starting visual companion…");
    expect(mocks.openUrl).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("ignores invalid URLs and sanitizes companion manager failures", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    mocks.openForClickedLink.mockResolvedValueOnce({ kind: "invalid" });
    clickTerminalLink("javascript:alert(1)");
    await flushAsync();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();

    mocks.openForClickedLink.mockRejectedValueOnce(
      new Error("http://secret.localhost:49152/capability"),
    );
    clickTerminalLink("http://localhost:4173/");
    await flushAsync();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Could not open visual companion.",
    );

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("keeps ordinary opener failures out of companion UI and logs no raw error detail", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    mocks.openForClickedLink.mockResolvedValue({
      kind: "ordinary",
      url: "https://example.com/",
    });
    mocks.openUrl.mockRejectedValue(new Error("sensitive opener detail"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    clickTerminalLink("https://example.com/");
    await flushAsync();

    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[cloud-terminal] Failed to open URL.",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive opener detail",
    );
    consoleError.mockRestore();
    wrapper.unmount();
  });

  it("releases manager ownership and closes only the terminal subscription on unmount", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    wrapper.unmount();

    expect(client.terminalClose).toHaveBeenCalledTimes(1);
    expect(mocks.ownershipRelease).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("closes a client when adoption fails before ownership transfers", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    mocks.adoptRemote.mockImplementationOnce(() => {
      throw new Error("adoption failed");
    });

    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.observeTerminal).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("uses the LAN client factory and preserves terminal input and resize behavior", async () => {
    const client = createClient();
    let terminalListener:
      | ((event: DesktopRemoteTerminalEvent) => void)
      | undefined;
    client.observeTerminal.mockImplementation((options) => {
      terminalListener = options.listener;
      return { close: client.terminalClose };
    });
    mocks.lanFactory.mockResolvedValue(client);

    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "peer-1",
        ownerTaskId: "task-2",
        transport: "lan",
      },
    });
    await flushAsync();
    terminalListener?.({
      type: "snapshot",
      taskId: "task-2",
      cols: 80,
      rows: 24,
      data: new TextEncoder().encode("snapshot"),
    });
    client.resize.mockClear();
    testState.resizeCallbacks[0]?.([], {} as ResizeObserver);
    testState.terminals[0]?.dataHandler?.("hello");
    await flushAsync();

    expect(mocks.lanFactory).toHaveBeenCalledTimes(1);
    expect(mocks.relayFactory).not.toHaveBeenCalled();
    expect(mocks.adoptRemote).toHaveBeenCalledWith({
      remoteKey: '["peer-1","task-2"]',
      ownerDesktopId: "peer-1",
      ownerTaskId: "task-2",
      transport: client,
    });
    expect(client.sendInput).toHaveBeenCalledWith({
      desktopId: "peer-1",
      taskId: "task-2",
      data: "hello",
      controlInput: true,
    });
    expect(client.resize).toHaveBeenCalledWith({
      desktopId: "peer-1",
      taskId: "task-2",
      cols: 80,
      rows: 24,
    });
    testState.effectiveCodeTheme!.value = "light";
    await nextTick();
    expect(testState.terminals[0]?.options.theme).toEqual({ theme: "light" });
    wrapper.unmount();
  });

  it("does not fit or resize while hidden and refits on reactivation without reconnecting", async () => {
    const client = createClient();
    let terminalListener:
      | ((event: DesktopRemoteTerminalEvent) => void)
      | undefined;
    client.observeTerminal.mockImplementation((options) => {
      terminalListener = options.listener;
      return { close: client.terminalClose };
    });
    mocks.lanFactory.mockResolvedValue(client);

    const wrapper = mount(CloudTerminalView, {
      props: {
        active: true,
        ownerDesktopId: "peer-1",
        ownerTaskId: "task-2",
        transport: "lan",
      },
    });
    await flushAsync();
    terminalListener?.({
      type: "snapshot",
      taskId: "task-2",
      cols: 80,
      rows: 24,
      data: new TextEncoder().encode("snapshot"),
    });
    await flushAsync();

    const terminal = testState.terminals[0];
    const fitAddon = terminal?.loadedAddons.find(
      (addon) => addon instanceof testState.FakeFitAddon,
    ) as InstanceType<typeof testState.FakeFitAddon> | undefined;
    if (!terminal || !fitAddon) {
      throw new Error("terminal and fit addon should be initialized");
    }
    client.resize.mockClear();
    fitAddon.fit.mockClear();

    await wrapper.setProps({ active: false });
    terminal.cols = 2;
    terminal.rows = 1;
    testState.resizeCallbacks[0]?.([], {} as ResizeObserver);
    await flushAsync();

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(client.resize).not.toHaveBeenCalled();

    fitAddon.fit.mockImplementation(() => {
      terminal.cols = 132;
      terminal.rows = 41;
    });
    await wrapper.setProps({ active: true });
    await flushAsync();

    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(client.resize).toHaveBeenCalledExactlyOnceWith({
      desktopId: "peer-1",
      taskId: "task-2",
      cols: 132,
      rows: 41,
    });
    expect(mocks.lanFactory).toHaveBeenCalledTimes(1);
    expect(client.observeTerminal).toHaveBeenCalledTimes(1);
    expect(client.terminalClose).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("closes a stale pre-adoption client without replacing the current prop generation", async () => {
    const staleClient = createClient();
    const currentClient = createClient();
    const staleFactory = deferred<FakeClient>();
    mocks.relayFactory
      .mockImplementationOnce(() => staleFactory.promise)
      .mockResolvedValueOnce(currentClient);

    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-old",
        ownerTaskId: "task-old",
      },
    });
    await flushAsync();
    await wrapper.setProps({
      ownerDesktopId: "desktop-new",
      ownerTaskId: "task-new",
    });
    await flushAsync();
    staleFactory.resolve(staleClient);
    await flushAsync();

    expect(mocks.adoptRemote).toHaveBeenCalledTimes(1);
    expect(mocks.adoptRemote).toHaveBeenCalledWith({
      remoteKey: '["desktop-new","task-new"]',
      ownerDesktopId: "desktop-new",
      ownerTaskId: "task-new",
      transport: currentClient,
    });
    expect(staleClient.close).toHaveBeenCalledTimes(1);
    expect(staleClient.observeTerminal).not.toHaveBeenCalled();
    expect(testState.webLinksAddons).toHaveLength(1);
    wrapper.unmount();
  });

  it("does not surface a stale input failure after switching remote tasks", async () => {
    const oldClient = createClient();
    const newClient = createClient();
    const oldSend = deferred<void>();
    let oldTerminalListener:
      | ((event: DesktopRemoteTerminalEvent) => void)
      | undefined;
    oldClient.observeTerminal.mockImplementation((options) => {
      oldTerminalListener = options.listener;
      return { close: oldClient.terminalClose };
    });
    oldClient.sendInput.mockReturnValue(oldSend.promise);
    mocks.relayFactory
      .mockResolvedValueOnce(oldClient)
      .mockResolvedValueOnce(newClient);

    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-old",
        ownerTaskId: "task-old",
      },
    });
    await flushAsync();
    oldTerminalListener?.({
      type: "snapshot",
      taskId: "task-old",
      cols: 80,
      rows: 24,
      data: new TextEncoder().encode("snapshot"),
    });
    testState.terminals[0]?.dataHandler?.("old input");
    await wrapper.setProps({
      ownerDesktopId: "desktop-new",
      ownerTaskId: "task-new",
    });
    await flushAsync();

    oldSend.reject(new Error("old transport failed"));
    await flushAsync();

    expect(oldClient.sendInput).toHaveBeenCalledWith({
      desktopId: "desktop-old",
      taskId: "task-old",
      data: "old input",
      controlInput: true,
    });
    expect(wrapper.attributes("data-status")).toBe("connecting");
    expect(testState.terminals[0]?.write).not.toHaveBeenCalledWith(
      expect.stringContaining("old transport failed"),
    );
    wrapper.unmount();
  });

  it("replays each authoritative snapshot at its source dimensions before fitting the owner PTY", async () => {
    const client = createClient();
    let terminalListener: ((event: DesktopRemoteTerminalEvent) => void) | undefined;
    client.observeTerminal.mockImplementation((options) => {
      terminalListener = options.listener;
      return { close: client.terminalClose };
    });
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();

    const terminal = testState.terminals[0];
    const fitAddon = terminal?.loadedAddons.find(
      (addon) => addon instanceof testState.FakeFitAddon,
    ) as InstanceType<typeof testState.FakeFitAddon> | undefined;
    if (!terminal || !fitAddon || !terminalListener) {
      throw new Error("remote terminal was not initialized");
    }
    fitAddon.fit.mockImplementation(() => {
      terminal.cols = 117;
      terminal.rows = 39;
    });
    client.resize.mockClear();
    const snapshot = new TextEncoder().encode("\u001b[?1049h\u001b[2J\u001b[24;80Hcorner");

    terminalListener({
      type: "snapshot",
      taskId: "task-1",
      cols: 80,
      rows: 24,
      data: snapshot,
    });
    await flushAsync();

    expect(terminal.options).toMatchObject({
      cursorBlink: false,
      fontFamily: '\"JetBrains Mono\", \"SF Mono\", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1,
      scrollback: 10000,
    });
    expect(terminal.options).not.toHaveProperty("convertEol");
    expect(terminal.reset).toHaveBeenCalledTimes(2);
    expect(terminal.resize).toHaveBeenCalledWith(80, 24);
    expect(terminal.write).toHaveBeenCalledWith(snapshot, expect.any(Function));
    expect(wrapper.attributes("data-status")).toBe("live");
    expect(client.resize).toHaveBeenCalledExactlyOnceWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      cols: 117,
      rows: 39,
    });
    expect(terminal.refresh).toHaveBeenCalledWith(0, 38);
    wrapper.unmount();
  });

  it("refuses viewer-local file drops with a clear message instead of typing a dead path", async () => {
    const client = createClient();
    mocks.relayFactory.mockResolvedValue(client);
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
      },
    });
    await flushAsync();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [{ path: "/Users/viewer/Desktop/screenshot.png" }] },
    });

    wrapper.get(".terminal-container").element.dispatchEvent(drop);
    await flushAsync();

    expect(drop.defaultPrevented).toBe(true);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Files can’t be dropped into a remote terminal.",
    );
    expect(client.sendInput).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
