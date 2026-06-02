import { createApp } from "vue";
import { createPinia } from "pinia";
import i18n from "./i18n";
import "./theme/tokens.css";
import { isTauri } from "./tauri-mock";
import { loadDatabase, runMigrations } from "./stores/db";
import { shouldMountBaseBranchDropdownPreview } from "./previewMode";
import { formatLogArgument } from "./logForwarding";
import {
  clearTaskSwitchPerfRecords,
  getLatestTaskSwitchPerfRecord,
  getTaskSwitchPerfRecords,
} from "./perf/taskSwitchPerf";
import App from "./App.vue";
import { createWindowWorkspace, parseWindowBootstrap, resolveWindowBootstrap } from "./windowWorkspace";
import { e2eAppMetrics } from "./e2eAppMetrics";

interface AppWithSetupState {
  _instance?: {
    setupState?: Record<string, unknown>;
  };
}

const FIREBASE_AUTH_DB_NAME = "firebaseLocalStorageDb";

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
  window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__ = {
    installed: true,
    openFailures: 0,
  };

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
      window.__KANNA_E2E_AUTH_INDEXEDDB_FAULT__!.openFailures += 1;
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

  function forwardLog(level: string, origFn: (...args: any[]) => void) {
    return (...args: any[]) => {
      origFn.apply(console, args);
      const msg = args.map((arg) => formatLogArgument(arg)).join(" ");
      invoke("append_log", { message: `[${level}] ${msg}` }).catch(() => {});
    };
  }

  console.log = forwardLog("LOG", console.log);
  console.warn = forwardLog("WARN", console.warn);
  console.error = forwardLog("ERROR", console.error);

  window.addEventListener("error", (e) => {
    invoke("append_log", { message: `[UNCAUGHT] ${e.message} at ${e.filename}:${e.lineno}` }).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    invoke("append_log", { message: `[UNHANDLED_REJECTION] ${e.reason}` }).catch(() => {});
  });

  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  if (import.meta.env.DEV) {
    const failFirebaseAuthIndexedDbOpen = await invoke<string>("read_env_var", {
      name: "KANNA_E2E_FIREBASE_AUTH_INDEXEDDB_OPEN_FAILURE",
    }).catch(() => "");
    if (failFirebaseAuthIndexedDbOpen === "1") {
      installFirebaseAuthIndexedDbOpenFailureForE2E();
    }
  }
} else {
  console.log("[kanna] Running in browser mode with mock Tauri APIs");
}

try {
  const { db, dbName } = await loadDatabase();
  await runMigrations(db);
  const windowBootstrap = await resolveWindowBootstrap(
    db,
    parseWindowBootstrap(window.location.search),
  );
  const windowWorkspace = createWindowWorkspace({ db, bootstrap: windowBootstrap });

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
    };
  }

  app.mount("#app");
  void windowWorkspace.restoreAdditionalWindows().catch((error) => {
    console.error("[windowWorkspace] failed to restore additional windows:", error);
  });
} catch (e) {
  console.error("[init] fatal:", e);
  const el = document.getElementById("app");
  if (el) el.textContent = `Failed to initialize: ${e}`;
}
