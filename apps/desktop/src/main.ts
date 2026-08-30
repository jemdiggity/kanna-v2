import { createApp } from "vue";
import { createPinia } from "pinia";
import i18n from "./i18n";
import "./theme/tokens.css";
import { isTauri } from "./tauri-mock";
import { loadDatabase } from "./stores/db";
import { shouldMountBaseBranchDropdownPreview } from "./previewMode";
import { formatLogArgument } from "./logForwarding";
import {
  clearTaskSwitchPerfRecords,
  getLatestTaskSwitchPerfRecord,
  getTaskSwitchPerfRecords,
} from "./perf/taskSwitchPerf";
import App from "./App.vue";
import { createWindowWorkspace, parseWindowBootstrap, resolveWindowBootstrap } from "./windowWorkspace";
import { parseModalTearOffContext } from "./modalTearOff";
import { e2eAppMetrics, e2eTerminalOutputPerf } from "./e2eAppMetrics";
import { e2eInvokeHistory } from "./e2eInvokeHistory";
import { e2eEventHistory } from "./e2eEventHistory";
import { createE2ERemoteCompanionApi } from "./e2eRemoteCompanion";
import {
  getSharedStreamClient,
  resetSharedStreamClientForTests,
} from "./composables/desktopStreamClient";

interface AppWithSetupState {
  _instance?: {
    setupState?: Record<string, unknown>;
  };
}

const FIREBASE_AUTH_DB_NAME = "firebaseLocalStorageDb";

let activeE2EServerWork: Promise<void> | null = null;
let isE2EServerWorkActive = false;

const e2eServerWork = {
  async start(durationMs: number): Promise<void> {
    if (activeE2EServerWork) {
      throw new Error("E2E server work is already active");
    }
    const client = await getSharedStreamClient();
    isE2EServerWorkActive = true;
    activeE2EServerWork = client
      .request("POST", "/v1/e2e/server-work", { durationMs })
      .then(({ status, body }) => {
        if (status !== 200) {
          throw new Error(`E2E server work failed (${status}): ${JSON.stringify(body)}`);
        }
      })
      .finally(() => {
        isE2EServerWorkActive = false;
      });
  },
  async wait(): Promise<void> {
    const work = activeE2EServerWork;
    if (!work) return;
    try {
      await work;
    } finally {
      if (activeE2EServerWork === work) {
        activeE2EServerWork = null;
      }
    }
  },
  isActive(): boolean {
    return isE2EServerWorkActive;
  },
};

const e2eTerminalStreams = {
  async detach(taskId: string): Promise<void> {
    const client = await getSharedStreamClient();
    client.detach(taskId, "terminal");
  },
};

async function resolveRootComponent() {
  if (shouldMountBaseBranchDropdownPreview(window.location.search, {
    dev: import.meta.env.DEV,
    mode: import.meta.env.MODE,
    vitest: typeof process !== "undefined" ? process.env.VITEST : undefined,
  })) {
    const previewModule = await import("./components/BaseBranchDropdownPreview.vue");
    return previewModule.default;
  }

  return App;
}

function installFirebaseAuthIndexedDbOpenFailureForE2E(): void {
  if (!import.meta.env.DEV || window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__) return;

  const indexedDb = globalThis.indexedDB;
  if (!indexedDb) return;

  const originalOpen = indexedDb.open.bind(indexedDb);
  const authIndexedDbFault = {
    installed: true,
    openFailures: 0,
  };
  window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__ = authIndexedDbFault;

  const failOrOpen: IDBFactory["open"] = ((name: string, version?: number) => {
    if (name !== FIREBASE_AUTH_DB_NAME) {
      return version === undefined ? originalOpen(name) : originalOpen(name, version);
    }

    const request = {
      error: new DOMException("The operation was aborted.", "AbortError"),
      result: undefined,
      readyState: "done",
      source: null,
      transaction: null,
      onblocked: null,
      onerror: null,
      onsuccess: null,
      onupgradeneeded: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    } as unknown as IDBOpenDBRequest;

    queueMicrotask(() => {
      authIndexedDbFault.openFailures += 1;
      request.onerror?.(new Event("error"));
    });

    return request;
  }) as IDBFactory["open"];

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new Proxy(indexedDb, {
      get(target, property, receiver) {
        if (property === "open") return failOrOpen;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
}

if (isTauri) {
  const { invoke } = await import("@tauri-apps/api/core");
  const originalConsoleDebug = console.debug;
  const originalConsoleLog = console.log;
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  function appendFrontendLog(message: string, onFailure: (error: unknown) => void) {
    invoke("append_log", { message }).catch(onFailure);
  }

  function forwardLog(level: string, origFn: (...args: unknown[]) => void) {
    return (...args: unknown[]) => {
      origFn.apply(console, args);
      const msg = args.map((arg) => formatLogArgument(arg)).join(" ");
      appendFrontendLog(`[${level}] ${msg}`, (error) => {
        originalConsoleWarn("[log-forwarding] failed to append frontend log:", error);
      });
    };
  }

  console.debug = forwardLog("DEBUG", originalConsoleDebug);
  console.log = forwardLog("LOG", originalConsoleLog);
  console.info = forwardLog("INFO", originalConsoleInfo);
  console.warn = forwardLog("WARN", originalConsoleWarn);
  console.error = forwardLog("ERROR", originalConsoleError);

  window.addEventListener("error", (e) => {
    appendFrontendLog(`[UNCAUGHT] ${e.message} at ${e.filename}:${e.lineno}`, (error) => {
      originalConsoleWarn("[log-forwarding] failed to append uncaught error:", error);
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    appendFrontendLog(`[UNHANDLED_REJECTION] ${e.reason}`, (error) => {
      originalConsoleWarn("[log-forwarding] failed to append unhandled rejection:", error);
    });
  });

  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  if (import.meta.env.DEV) {
    const failFirebaseAuthIndexedDbOpen = await invoke<string>("read_env_var", {
      name: "KANNA_E2E_FIREBASE_AUTH_INDEXEDDB_OPEN_FAILURE",
    }).catch((error) => {
      console.debug("[main] E2E Firebase auth IndexedDB fault flag not set:", error);
      return "";
    });
    if (failFirebaseAuthIndexedDbOpen === "1") {
      installFirebaseAuthIndexedDbOpenFailureForE2E();
    }
  }
} else {
  console.debug("[kanna] Running in browser mode with mock Tauri APIs");
}

try {
  const { db, dbName } = await loadDatabase();
  const parsedWindowBootstrap = parseWindowBootstrap(window.location.search);
  const windowBootstrap = await resolveWindowBootstrap(db, parsedWindowBootstrap);
  const tearOffContext = parseModalTearOffContext(window.location.search)
    ?? windowBootstrap.tearOffContext
    ?? null;
  const windowWorkspace = createWindowWorkspace({ db, bootstrap: windowBootstrap });
  try {
    await windowWorkspace.restoreCurrentWindowGeometry();
  } catch (error: unknown) {
    console.warn("[windowWorkspace] failed to restore current window geometry:", error);
  }

  const RootComponent = await resolveRootComponent();
  const app = createApp(RootComponent);
  app.use(createPinia());
  app.use(i18n);
  app.provide("db", db);
  app.provide("dbName", dbName);
  app.provide("windowWorkspace", windowWorkspace);

  if (import.meta.env.DEV) {
    const appWithSetupState = app as typeof app & AppWithSetupState;
    window.__KANNA_E2E__ = {
      ready: false,
      startupOverlaysSettled: false,
      get setupState() {
        const setupState = appWithSetupState._instance?.setupState;
        if (!setupState) return null;
        setupState.db ??= db;
        setupState.dbName ??= dbName;
        setupState.windowWorkspace ??= windowWorkspace;
        const storeState = setupState.store as Record<string, unknown> | undefined;
        if (storeState) {
          setupState.selectedRepoId ??= storeState.selectedRepoId;
          setupState.selectedItemId ??= storeState.selectedItemId;
          setupState.items ??= storeState.items;
          setupState.repos ??= storeState.repos;
          setupState.createItem ??= storeState.createItem;
          setupState.handleSelectRepo ??= storeState.selectRepo;
          setupState.refreshRepos ??= async () => {
            const init = storeState.init;
            if (typeof init === "function") {
              return await (init as (dbArg: unknown) => Promise<unknown>)(db);
            }
            return null;
          };
          setupState.loadItems ??= async () => {
            const init = storeState.init;
            if (typeof init === "function") {
              await (init as (dbArg: unknown) => Promise<unknown>)(db);
            }
            return storeState.items ?? null;
          };
          setupState.refreshAllItems ??= async () => {
            const init = storeState.init;
            if (typeof init === "function") {
              await (init as (dbArg: unknown) => Promise<unknown>)(db);
            }
            return storeState.items ?? null;
          };
          setupState.selectedItem ??= () => {
            const currentItem = storeState.currentItem as { value?: unknown } | undefined;
            return currentItem && "value" in currentItem ? currentItem.value ?? null : currentItem ?? null;
          };
        }
        return setupState;
      },
      get dbName() {
        return dbName;
      },
      taskSwitchPerf: {
        getLatest: () => getLatestTaskSwitchPerfRecord(),
        getAll: () => getTaskSwitchPerfRecords(),
        clear: () => clearTaskSwitchPerfRecords(),
      },
      appMetrics: e2eAppMetrics,
      terminalOutputPerf: e2eTerminalOutputPerf,
      invokes: e2eInvokeHistory,
      events: e2eEventHistory,
      remoteCompanion: createE2ERemoteCompanionApi(),
      resetStreamClient: resetSharedStreamClientForTests,
      serverWork: e2eServerWork,
      terminalStreams: e2eTerminalStreams,
    };
  }

  app.mount("#app");
  if (!tearOffContext) {
    void windowWorkspace.restoreAdditionalWindows().catch((error) => {
      console.error("[windowWorkspace] failed to restore additional windows:", error);
    });
  }
} catch (e) {
  console.error("[init] fatal:", e);
  const el = document.getElementById("app");
  if (el) el.textContent = `Failed to initialize: ${e}`;
}
