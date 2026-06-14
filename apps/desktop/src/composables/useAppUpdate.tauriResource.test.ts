// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const tauriInvokeMock = vi.fn();
const relaunchMock = vi.fn();

vi.mock("../invoke", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
}));

vi.mock("../tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args),
}));

import { useAppUpdate } from "./useAppUpdate";

interface TauriInternals {
  invoke: (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  convertFileSrc: (filePath: string, protocol?: string) => string;
  transformCallback: (callback: unknown, once?: boolean) => number;
}

describe("useAppUpdate with Tauri updater resources", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    tauriInvokeMock.mockReset();
    relaunchMock.mockReset();

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "read_env_var" && args?.name === "KANNA_WORKTREE") return "";
      throw new Error(`unexpected invoke: ${command}`);
    });

    tauriInvokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "plugin:updater|check") {
        return {
          rid: 42,
          currentVersion: "0.0.38",
          version: "0.0.39",
          date: "2026-04-15T00:00:00Z",
          body: "Release notes",
          rawJson: {},
        };
      }
      if (command === "plugin:updater|download_and_install") {
        return undefined;
      }
      if (command === "plugin:resources|close") {
        return undefined;
      }
      throw new Error(`unexpected Tauri invoke: ${command}`);
    });

    const internals: TauriInternals = {
      invoke: tauriInvokeMock,
      convertFileSrc: (filePath) => filePath,
      transformCallback: () => 1,
    };
    (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__ = internals;
  });

  it("downloads through the real updater resource handle without Vue proxying it", async () => {
    const updater = useAppUpdate();

    await updater.checkNow();
    await updater.install();

    expect(updater.errorMessage.value).toBeNull();
    expect(updater.status.value).toBe("readyToRestart");
    expect(tauriInvokeMock).toHaveBeenCalledWith(
      "plugin:updater|download_and_install",
      expect.objectContaining({ rid: 42 }),
      undefined,
    );
  });
});
