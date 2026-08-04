import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  AppState: { currentState: "active" }
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    removeItem: vi.fn().mockResolvedValue(undefined),
    setItem: vi.fn().mockResolvedValue(undefined)
  }
}));

import {
  installMobileCrashHandler,
  MobileCrashDiagnosticRecorder
} from "./mobileCrashDiagnostics";

function createStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    removeItem: vi.fn(async () => {
      value = null;
    }),
    setItem: vi.fn(async (_key: string, next: string) => {
      value = next;
    })
  };
}

function createRecorder(storage = createStorage()) {
  let nowMs = Date.parse("2026-08-04T03:00:00.000Z");
  const recorder = new MobileCrashDiagnosticRecorder(storage, {
    now: () => new Date(nowMs++),
    randomId: () => "abc123",
    readBuild: () => ({
      channel: "staging",
      environment: "staging",
      nativeSummary: "0.1.0 (42)",
      runtimeVersion: "2.1.4",
      source: "ota-123"
    })
  });
  recorder.updateContext({
    appState: "active",
    connectionMode: "lan",
    connectionState: "connected",
    forceCloudEnabled: false,
    selectedTaskId: "task-1",
    terminalCols: 120,
    terminalOutputChars: 900_000,
    terminalOutputEpoch: 4,
    terminalOutputStart: 125_000,
    terminalRows: 44,
    terminalStatus: "live"
  });
  return { recorder, storage };
}

describe("MobileCrashDiagnosticRecorder", () => {
  it("persists actionable bounded context without terminal content", async () => {
    const { recorder } = createRecorder();
    recorder.addBreadcrumb("app-state", "background->active action=refresh");
    const captured = recorder.capture({
      kind: "webview-process-terminated",
      message: "Web content process exited",
      details: { bridgeReady: true, secretOutput: undefined }
    });

    const records = await recorder.read();

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(captured);
    expect(records[0]).toMatchObject({
      context: {
        connectionMode: "lan",
        selectedTaskId: "task-1",
        terminalOutputChars: 900_000,
        terminalOutputStart: 125_000
      },
      build: {
        runtimeVersion: "2.1.4",
        source: "ota-123"
      },
      details: { bridgeReady: true }
    });
    expect(JSON.stringify(records)).not.toContain("secretOutput");
  });

  it("retains only the five newest failures", async () => {
    const { recorder } = createRecorder();
    for (let index = 0; index < 7; index += 1) {
      recorder.capture({
        kind: "javascript-error",
        message: `failure-${index}`
      });
    }

    const records = await recorder.read();

    expect(records.map((record) => record.message)).toEqual([
      "failure-6",
      "failure-5",
      "failure-4",
      "failure-3",
      "failure-2"
    ]);
  });

  it("recovers from malformed retained data and supports clearing", async () => {
    const storage = createStorage("not-json");
    const { recorder } = createRecorder(storage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await recorder.read()).toEqual([]);
    recorder.capture({ kind: "react-render-error", message: "render failed" });
    expect(await recorder.read()).toHaveLength(1);

    await recorder.clear();
    expect(await recorder.read()).toEqual([]);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Stored mobile crash diagnostics could not be parsed:",
      expect.anything()
    );
    warn.mockRestore();
  });
});

describe("installMobileCrashHandler", () => {
  it("captures a fatal JS signature before delegating to React Native", () => {
    const previousHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    const diagnosticGlobal = globalThis as typeof globalThis & {
      ErrorUtils?: {
        getGlobalHandler(): typeof previousHandler;
        setGlobalHandler(
          handler: (error: unknown, isFatal?: boolean) => void
        ): void;
      };
      __kannaMobileCrashHandlerInstalled?: boolean;
    };
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    delete diagnosticGlobal.__kannaMobileCrashHandlerInstalled;
    const capture = vi.fn();

    installMobileCrashHandler(capture);
    const failure = new Error("fatal render work");
    const handler = installedHandler as
      | ((error: unknown, isFatal?: boolean) => void)
      | null;
    expect(handler).not.toBeNull();
    handler?.(failure, true);

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        fatal: true,
        kind: "javascript-error",
        message: "Error: fatal render work"
      })
    );
    expect(previousHandler).toHaveBeenCalledWith(failure, true);

    delete diagnosticGlobal.ErrorUtils;
    delete diagnosticGlobal.__kannaMobileCrashHandlerInstalled;
  });
});
