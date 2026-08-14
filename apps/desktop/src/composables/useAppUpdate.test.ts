// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

let tauriRuntime = true;

const checkMock = vi.fn();
const relaunchMock = vi.fn();
const invokeMock = vi.fn();
const downloadAndInstallMock = vi.fn();
const closeMock = vi.fn();
const isFocusedMock = vi.fn();
const focusUnlistenMock = vi.fn();
let focusChangedHandler: ((event: { payload: boolean }) => void) | null = null;
const onFocusChangedMock = vi.fn(
  async (handler: (event: { payload: boolean }) => void) => {
    focusChangedHandler = handler;
    return focusUnlistenMock;
  },
);

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: (...args: unknown[]) => isFocusedMock(...args),
    onFocusChanged: (...args: unknown[]) => onFocusChangedMock(...args),
  }),
}));

vi.mock("../invoke", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
}));

vi.mock("../tauri-mock", () => ({
  get isTauri() {
    return tauriRuntime;
  },
}));

import { useAppUpdate } from "./useAppUpdate";

interface UpdateEvent {
  event: string;
  data: {
    chunkLength?: number;
    contentLength?: number;
  };
}

function makeUpdate(version: string) {
  return {
    version,
    currentVersion: "0.0.38",
    body: `Notes for ${version}`,
    date: "2026-04-15T00:00:00Z",
    downloadAndInstall: downloadAndInstallMock,
    close: closeMock,
  };
}

class PrivateUpdate {
  #resourceId = 1;

  currentVersion = "0.0.38";
  body: string;
  date = "2026-04-15T00:00:00Z";

  constructor(readonly version: string) {
    this.body = `Notes for ${version}`;
  }

  async downloadAndInstall(onEvent?: (event: UpdateEvent) => void) {
    if (this.#resourceId !== 1) {
      throw new Error("unexpected resource id");
    }
    onEvent?.({ event: "Started", data: { contentLength: 42 } });
    onEvent?.({ event: "Progress", data: { chunkLength: 42 } });
    onEvent?.({ event: "Finished", data: {} });
  }

  async close() {
    if (this.#resourceId !== 1) {
      throw new Error("unexpected resource id");
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await nextTick();
}

describe("useAppUpdate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tauriRuntime = true;
    checkMock.mockReset();
    relaunchMock.mockReset();
    invokeMock.mockReset();
    downloadAndInstallMock.mockReset();
    closeMock.mockReset();
    isFocusedMock.mockReset();
    isFocusedMock.mockResolvedValue(true);
    focusUnlistenMock.mockReset();
    focusChangedHandler = null;
    onFocusChangedMock.mockClear();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_env_var" && args?.name === "KANNA_WORKTREE") return "";
      throw new Error(`unexpected invoke: ${command}`);
    });
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    Reflect.deleteProperty(window, "__KANNA_E2E__");
  });

  it("waits for the startup delay, then checks again every 6 hours", async () => {
    checkMock.mockResolvedValue(null);
    const updater = useAppUpdate();
    updater.start();

    expect(checkMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("shows an available update only while the current native window is focused", async () => {
    checkMock.mockResolvedValue(makeUpdate("0.0.39"));
    const updater = useAppUpdate();
    updater.start();
    await flush();
    await updater.checkNow();

    await vi.waitFor(() => expect(focusChangedHandler).not.toBeNull());
    expect(updater.visible.value).toBe(true);

    focusChangedHandler?.({ payload: false });
    expect(updater.visible.value).toBe(false);

    focusChangedHandler?.({ payload: true });
    expect(updater.visible.value).toBe(true);
  });

  it("stops tracking native window focus when disposed", async () => {
    const updater = useAppUpdate();
    updater.start();
    await vi.waitFor(() => expect(focusChangedHandler).not.toBeNull());

    updater.dispose();

    expect(focusUnlistenMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a dismissed version for the rest of the session but surfaces a newer one", async () => {
    checkMock
      .mockResolvedValueOnce(makeUpdate("0.0.39"))
      .mockResolvedValueOnce(makeUpdate("0.0.39"))
      .mockResolvedValueOnce(makeUpdate("0.0.40"));

    const updater = useAppUpdate();
    updater.start();

    await vi.advanceTimersByTimeAsync(15000);
    await flush();
    expect(updater.status.value).toBe("available");
    expect(updater.updateVersion.value).toBe("0.0.39");

    updater.dismiss();
    expect(updater.dismissedVersion.value).toBe("0.0.39");
    expect(updater.status.value).toBe("idle");

    await updater.checkNow();
    expect(updater.status.value).toBe("idle");

    await updater.checkNow();
    expect(updater.status.value).toBe("available");
    expect(updater.updateVersion.value).toBe("0.0.40");
  });

  it("does not start checks when updater checks are disabled", async () => {
    tauriRuntime = false;
    checkMock.mockResolvedValue(null);

    const updater = useAppUpdate();
    updater.start();

    await vi.advanceTimersByTimeAsync(15000);
    await flush();
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("does not overlap checks while one is still in flight", async () => {
    const inFlight = deferred<ReturnType<typeof makeUpdate> | null>();
    checkMock.mockReturnValue(inFlight.promise);

    const updater = useAppUpdate();
    updater.start();

    await vi.advanceTimersByTimeAsync(15000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(1);

    inFlight.resolve(null);
    await flush();

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await flush();
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("returns to idle when a scheduled check rejects", async () => {
    checkMock.mockRejectedValueOnce(new Error("updater unavailable"));

    const updater = useAppUpdate();
    updater.start();

    await vi.advanceTimersByTimeAsync(15000);
    await flush();

    expect(updater.status.value).toBe("idle");
    expect(updater.errorMessage.value).toBeNull();
  });

  it("downloads the selected update and becomes restart-ready", async () => {
    downloadAndInstallMock.mockImplementation(async (onEvent?: (event: UpdateEvent) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 42 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 10 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 32 } });
      onEvent?.({ event: "Finished", data: {} });
    });
    checkMock.mockResolvedValue(makeUpdate("0.0.39"));

    const updater = useAppUpdate();
    await updater.checkNow();
    await updater.install();

    expect(updater.status.value).toBe("readyToRestart");
    expect(updater.downloadedBytes.value).toBe(42);
  });

  it("keeps class-backed update handles raw so private resource fields remain accessible", async () => {
    checkMock.mockResolvedValue(new PrivateUpdate("0.0.39"));

    const updater = useAppUpdate();
    await updater.checkNow();
    await updater.install();

    expect(updater.status.value).toBe("readyToRestart");
    expect(updater.downloadedBytes.value).toBe(42);
    expect(updater.errorMessage.value).toBeNull();
  });

  it("allows dev e2e tests to inject a deterministic update handle", async () => {
    window.__KANNA_E2E__ = {
      ready: true,
      setupState: null,
      dbName: "test.db",
      taskSwitchPerf: {
        getLatest: () => null,
        getAll: () => [],
        clear: () => {},
      },
    };

    const updater = useAppUpdate();
    updater.__e2eInjectUpdate({
      version: "0.0.50",
      body: "E2E notes",
      contentLength: 84,
      chunks: [20, 64],
    });
    await updater.install();

    expect(updater.status.value).toBe("readyToRestart");
    expect(updater.updateVersion.value).toBe("0.0.50");
    expect(updater.releaseNotes.value).toBe("E2E notes");
    expect(updater.downloadedBytes.value).toBe(84);
    expect(updater.errorMessage.value).toBeNull();
  });

  it("closes the previous update when a newer one replaces it", async () => {
    checkMock
      .mockResolvedValueOnce(makeUpdate("0.0.39"))
      .mockResolvedValueOnce(makeUpdate("0.0.40"));

    const updater = useAppUpdate();
    await updater.checkNow();
    expect(closeMock).not.toHaveBeenCalled();

    await updater.checkNow();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("closes the active update when dismissed", async () => {
    checkMock.mockResolvedValue(makeUpdate("0.0.39"));

    const updater = useAppUpdate();
    await updater.checkNow();
    updater.dismiss();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("closes the active update when disposed", async () => {
    checkMock.mockResolvedValue(makeUpdate("0.0.39"));

    const updater = useAppUpdate();
    await updater.checkNow();
    updater.dispose();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("relaunches only after a successful install", async () => {
    downloadAndInstallMock.mockResolvedValue(undefined);
    checkMock.mockResolvedValue(makeUpdate("0.0.39"));

    const updater = useAppUpdate();
    await updater.checkNow();
    await updater.install();
    await updater.restartNow();

    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("relaunches after an update without saving global native window state", async () => {
    downloadAndInstallMock.mockResolvedValue(undefined);
    checkMock.mockResolvedValue(makeUpdate("0.0.39"));

    const updater = useAppUpdate();
    await updater.checkNow();
    await updater.install();
    await updater.restartNow();

    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });
});
