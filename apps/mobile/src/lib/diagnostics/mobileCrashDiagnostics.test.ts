import { afterEach, describe, expect, it, vi } from "vitest";

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
  formatMobileCrashDiagnostics,
  installMobileCrashHandler,
  MobileCrashDiagnosticRecorder
} from "./mobileCrashDiagnostics";

interface TestDiagnosticGlobal {
  ErrorUtils?: {
    getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
    setGlobalHandler(
      handler: (error: unknown, isFatal?: boolean) => void
    ): void;
  };
  __kannaMobileCrashHandlerInstalled?: boolean;
}

const diagnosticGlobal = globalThis as typeof globalThis & TestDiagnosticGlobal;

afterEach(() => {
  delete diagnosticGlobal.ErrorUtils;
  delete diagnosticGlobal.__kannaMobileCrashHandlerInstalled;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it("coalesces a burst to five pending records while storage is slow", async () => {
    let storedValue: string | null = null;
    let releaseFirstRead: (() => void) | null = null;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let readCount = 0;
    const storage = {
      getItem: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) await firstRead;
        return storedValue;
      }),
      removeItem: vi.fn(async () => {
        storedValue = null;
      }),
      setItem: vi.fn(async (_key: string, next: string) => {
        storedValue = next;
      })
    };
    const { recorder } = createRecorder(storage);

    recorder.capture({ kind: "javascript-error", message: "failure-0" });
    for (let index = 1; index < 100; index += 1) {
      recorder.capture({
        kind: "javascript-error",
        message: `failure-${index}`
      });
    }

    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
    releaseFirstRead?.();
    const records = await recorder.read();

    expect(storage.setItem).toHaveBeenCalledTimes(2);
    for (const [, serialized] of storage.setItem.mock.calls) {
      expect(JSON.parse(serialized).length).toBeLessThanOrEqual(5);
    }
    expect(records.map((record) => record.message)).toEqual([
      "failure-99",
      "failure-98",
      "failure-97",
      "failure-96",
      "failure-95"
    ]);
  });

  it("redacts credentials before persistence and clipboard formatting", async () => {
    const { recorder, storage } = createRecorder();
    recorder.capture({
      kind: "javascript-error",
      message: "request failed Authorization: Bearer message-secret",
      stack:
        "at fetch (https://alice:stack-password@example.test/run?access_token=stack-token)",
      componentStack: "Component authToken=component-secret",
      details: {
        authorization: "Bearer detail-secret",
        endpoint:
          "https://operator:url-password@example.test/api?client_secret=query-secret&safe=1",
        response: '{"refreshToken":"json-secret","status":"failed"}'
      }
    });

    const records = await recorder.read();
    const persisted = storage.setItem.mock.calls.at(-1)?.[1] ?? "";
    const formatted = formatMobileCrashDiagnostics([
      {
        ...records[0],
        message: `${records[0].message} authToken=format-message-secret`,
        stack: `${records[0].stack} password=format-stack-secret`,
        details: {
          ...records[0].details,
          apiKey: "format-detail-secret"
        }
      }
    ]);
    const secrets = [
      "message-secret",
      "stack-password",
      "stack-token",
      "component-secret",
      "detail-secret",
      "url-password",
      "query-secret",
      "json-secret",
      "format-message-secret",
      "format-stack-secret",
      "format-detail-secret"
    ];

    for (const secret of secrets) {
      expect(persisted).not.toContain(secret);
      expect(formatted).not.toContain(secret);
    }
    expect(persisted).toContain("[REDACTED]");
    expect(formatted).toContain("[REDACTED]");
    expect(formatted).toContain("status");
    expect(formatted).toContain("safe=1");
  });

  it("redacts URL credentials whose delimiter lies beyond the truncation cap", async () => {
    const { recorder, storage } = createRecorder();
    const partialCredential = `boundary-credential:${"p".repeat(4_100)}`;
    const unsafeUrl = `https://${partialCredential}@example.test/path`;

    recorder.capture({
      kind: "javascript-error",
      message: unsafeUrl
    });

    const records = await recorder.read();
    const persisted = storage.setItem.mock.calls.at(-1)?.[1] ?? "";
    const formatted = formatMobileCrashDiagnostics([
      {
        ...records[0],
        message: unsafeUrl
      }
    ]);

    for (const output of [persisted, formatted]) {
      expect(output).toContain("https://[REDACTED]");
      expect(output).not.toContain("boundary-credential");
      expect(output).not.toContain("p".repeat(100));
    }
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
  it("captures a fatal JS signature before delegating to React Native", async () => {
    const previousHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    delete diagnosticGlobal.__kannaMobileCrashHandlerInstalled;
    const { recorder } = createRecorder();
    const capture = vi.fn(recorder.captureWithPersistence.bind(recorder));

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
    await vi.waitFor(() => {
      expect(previousHandler).toHaveBeenCalledWith(failure, true);
    });
  });

  it("settles the fatal write before delegation can disable storage", async () => {
    let releaseWrite: (() => void) | null = null;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let storageAvailable = true;
    let persistedValue: string | null = null;
    const storage = {
      getItem: vi.fn(async () => {
        if (!storageAvailable) throw new Error("storage unavailable");
        return persistedValue;
      }),
      removeItem: vi.fn(async () => undefined),
      setItem: vi.fn(async (_key: string, value: string) => {
        if (!storageAvailable) throw new Error("storage unavailable");
        await writeGate;
        if (!storageAvailable) throw new Error("storage unavailable");
        persistedValue = value;
      })
    };
    const { recorder } = createRecorder(storage);
    const previousHandler = vi.fn(() => {
      storageAvailable = false;
    });
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    installMobileCrashHandler(recorder.captureWithPersistence.bind(recorder));

    const failure = new Error("fatal before runtime teardown");
    installedHandler?.(failure, true);
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
    expect(previousHandler).not.toHaveBeenCalled();

    releaseWrite?.();
    await vi.waitFor(() => expect(previousHandler).toHaveBeenCalledTimes(1));

    expect(persistedValue).toContain("fatal before runtime teardown");
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("persists the fatal record before delegation during a slow-storage burst", async () => {
    let releaseInitialRead: (() => void) | null = null;
    const initialReadGate = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    let readCount = 0;
    let storageAvailable = true;
    let persistedValue: string | null = null;
    const storage = {
      getItem: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) await initialReadGate;
        if (!storageAvailable) throw new Error("storage unavailable");
        return persistedValue;
      }),
      removeItem: vi.fn(async () => undefined),
      setItem: vi.fn(async (_key: string, value: string) => {
        if (!storageAvailable) throw new Error("storage unavailable");
        persistedValue = value;
      })
    };
    const { recorder } = createRecorder(storage);
    const previousHandler = vi.fn(() => {
      storageAvailable = false;
    });
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    installMobileCrashHandler(recorder.captureWithPersistence.bind(recorder));

    recorder.capture({ kind: "javascript-error", message: "initial write" });
    installedHandler?.(new Error("fatal retained through burst"), true);
    for (let index = 0; index < 100; index += 1) {
      recorder.capture({
        kind: "javascript-error",
        message: `later failure ${index}`
      });
    }

    releaseInitialRead?.();
    await vi.waitFor(() => expect(previousHandler).toHaveBeenCalledTimes(1));

    expect(persistedValue).toContain("fatal retained through burst");
    expect(storage.setItem.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalledWith(
      "Mobile crash diagnostic persistence failed:",
      expect.anything()
    );
  });

  it("bounds a nonfatal error burst while storage is stalled", async () => {
    let storedValue: string | null = null;
    let releaseFirstRead: (() => void) | null = null;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let readCount = 0;
    const storage = {
      getItem: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) await firstRead;
        return storedValue;
      }),
      removeItem: vi.fn(async () => undefined),
      setItem: vi.fn(async (_key: string, value: string) => {
        storedValue = value;
      })
    };
    const { recorder } = createRecorder(storage);
    const previousHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    installMobileCrashHandler(recorder.captureWithPersistence.bind(recorder));

    for (let index = 0; index < 100; index += 1) {
      installedHandler?.(new Error(`nonfatal failure ${index}`), false);
    }

    expect(previousHandler).toHaveBeenCalledTimes(100);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();

    releaseFirstRead?.();
    const records = await recorder.read();

    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(records.map((record) => record.message)).toEqual([
      "Error: nonfatal failure 99",
      "Error: nonfatal failure 98",
      "Error: nonfatal failure 97",
      "Error: nonfatal failure 96",
      "Error: nonfatal failure 95"
    ]);
  });

  it("retains a newer fatal error after older released records drain", async () => {
    let storedValue: string | null = null;
    let releaseFirstRead: (() => void) | null = null;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let readCount = 0;
    const storage = {
      getItem: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) await firstRead;
        return storedValue;
      }),
      removeItem: vi.fn(async () => undefined),
      setItem: vi.fn(async (_key: string, value: string) => {
        storedValue = value;
      })
    };
    const { recorder } = createRecorder(storage);
    const previousHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    installMobileCrashHandler(recorder.captureWithPersistence.bind(recorder));

    recorder.capture({
      kind: "javascript-error",
      message: "stalled write"
    });
    for (let index = 0; index < 5; index += 1) {
      installedHandler?.(new Error(`queued nonfatal ${index}`), false);
    }
    installedHandler?.(new Error("newer fatal"), true);

    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(previousHandler).toHaveBeenCalledTimes(5);

    releaseFirstRead?.();
    await vi.waitFor(() => expect(previousHandler).toHaveBeenCalledTimes(6));
    const records = await recorder.read();

    expect(records.map((record) => record.message)).toEqual([
      "Error: newer fatal",
      "Error: queued nonfatal 4",
      "Error: queued nonfatal 3",
      "Error: queued nonfatal 2",
      "Error: queued nonfatal 1"
    ]);
  });

  it("delegates after a fatal persistence failure", async () => {
    const storage = createStorage();
    storage.setItem.mockRejectedValue(new Error("disk unavailable"));
    const { recorder } = createRecorder(storage);
    const previousHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    installMobileCrashHandler(recorder.captureWithPersistence.bind(recorder));

    installedHandler?.(new Error("fatal storage failure"), true);

    await vi.waitFor(() => expect(previousHandler).toHaveBeenCalledTimes(1));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Mobile crash diagnostic persistence failed:",
      expect.anything()
    );
  });

  it("delegates exactly once for hostile thrown values and capture failures", () => {
    const previousHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    const capture = vi.fn(() => {
      throw new Error("capture failed");
    });
    installMobileCrashHandler(capture);

    const proxyValue = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf failed");
        }
      }
    );
    const getterError = new Error("hidden");
    Object.defineProperty(getterError, "message", {
      get() {
        throw new Error("message getter failed");
      }
    });
    const serializationValue = {
      toJSON() {
        throw new Error("toJSON failed");
      },
      toString() {
        throw new Error("toString failed");
      }
    };
    const values: unknown[] = [
      proxyValue,
      getterError,
      serializationValue,
      new Error("capture path")
    ];

    for (const value of values) installedHandler?.(value, true);

    expect(previousHandler).toHaveBeenCalledTimes(values.length);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(values.length);
  });

  it("bounds redaction work for an oversized hostile thrown value", async () => {
    const previousHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    const { recorder } = createRecorder();
    installMobileCrashHandler(recorder.captureWithPersistence.bind(recorder));

    installedHandler?.(`${"a".repeat(1_000_000)} password=tail-secret`, true);

    await vi.waitFor(() => expect(previousHandler).toHaveBeenCalledTimes(1));
    const records = await recorder.read();
    expect(records[0].message.length).toBeLessThanOrEqual(4_001);
    expect(records[0].message.endsWith("…")).toBe(true);
    expect(records[0].message).not.toContain("tail-secret");
  });

  it("delegates exactly once when persistence never settles", async () => {
    const { recorder } = createRecorder();
    const diagnostic = recorder.capture({
      kind: "javascript-error",
      message: "stalled persistence diagnostic"
    });
    await recorder.read();
    vi.useFakeTimers();
    const previousHandler = vi.fn();
    let installedHandler: ((error: unknown, isFatal?: boolean) => void) | null =
      null;
    let resolvePersistence: (() => void) | null = null;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    diagnosticGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler: (handler) => {
        installedHandler = handler;
      }
    };
    installMobileCrashHandler(() => ({
      diagnostic,
      persistence,
      releasePersistenceTracking: () => undefined
    }));

    installedHandler?.(new Error("fatal stalled storage"), true);
    expect(previousHandler).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(previousHandler).toHaveBeenCalledTimes(1);

    resolvePersistence?.();
    await Promise.resolve();
    expect(previousHandler).toHaveBeenCalledTimes(1);
  });
});
