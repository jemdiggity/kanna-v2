// @vitest-environment happy-dom

import { computed, defineComponent, h, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardActions } from "./composables/useKeyboardShortcuts";
import {
  WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
} from "./windowWorkspace";

async function flushPromises() {
  await Promise.resolve();
  await nextTick();
}

async function waitForNativeCloseRequestedHandler() {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (closeRequestedHandler) return closeRequestedHandler;
    await flushPromises();
  }
  return closeRequestedHandler;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | null = null;
  let reject: Deferred<T>["reject"] | null = null;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  if (!resolve || !reject) {
    throw new Error("failed to create deferred promise");
  }
  return { promise, resolve, reject };
}

const listenHandlers = new Map<string, (event: unknown) => void | Promise<void>>();
const currentWebviewWindowListenHandlers = new Map<string, (event: unknown) => void | Promise<void>>();
let closeRequestedHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | null = null;
const cloudTasksMock = vi.hoisted(() => vi.fn(async () => ({ repos: [], items: [] })));
const reconcileDesktopTaskSnapshotsMock = vi.hoisted(() => vi.fn(async () => {}));
const scheduleStartupBackupMock = vi.hoisted(() => vi.fn(async () => {}));
const nativeSetThemeMock = vi.hoisted(() => vi.fn(async () => {}));
const nativeWindowSetThemeMock = vi.hoisted(() => vi.fn(async () => {}));
const relayAdvanceStageMock = vi.hoisted(() => vi.fn(async () => {}));
const relayCloseMock = vi.hoisted(() => vi.fn());
const dbSelectMock = vi.fn(async () => []);
const dbMock = {
  select: dbSelectMock,
  execute: vi.fn(async () => ({ rowsAffected: 0 })),
};

const store = {
  repos: [{ id: "repo-1", path: "/tmp/repo", name: "repo" }],
  items: [],
  selectedRepoId: "repo-1" as string | null,
  selectedItemId: null,
  selectedRepo: { id: "repo-1", path: "/tmp/repo", name: "repo" } as { id: string; path: string; name: string } | null,
  currentItem: null,
  sortedItemsForCurrentRepo: [],
  sortedItemsAllRepos: [],
  lastSelectedItemByRepo: {},
  getStageOrder: vi.fn(() => ["in progress", "pr", "merge"]),
  suspendAfterMinutes: 30,
  killAfterMinutes: 60,
  ideCommand: "code",
  devLingerTerminals: false,
  hideShortcutsOnStartup: true,
  appTheme: "dark",
  codeTheme: "match",
  init: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  recordIncomingTransfer: vi.fn(async () => {}),
  approveIncomingTransfer: vi.fn(async () => "task-imported"),
  rejectIncomingTransfer: vi.fn(async () => {}),
  finalizeOutgoingTransfer: vi.fn(async () => ({
    transferId: "transfer-1",
    payload: {
      target_peer_id: "peer-target",
      task: {
        source_peer_id: "peer-source",
        source_task_id: "task-source",
        resume_session_id: null,
        prompt: "Fix handoff",
        stage: "in progress",
        branch: "task-source",
        pipeline: "default",
        display_name: "Transferred task",
        base_ref: "main",
        agent_type: "pty",
        agent_provider: "claude",
      },
      repo: {
        mode: "reuse-local",
        remote_url: null,
        path: "/tmp/repo",
        name: "repo",
        default_branch: "main",
        bundle: null,
      },
      recovery: null,
      artifacts: [],
    },
    finalizedCleanly: true,
  })),
  pushTaskToPeer: vi.fn(async () => {}),
  handleOutgoingTransferCommitted: vi.fn(async () => {}),
  listBlockedByItem: vi.fn(async () => []),
  listBlockersForItem: vi.fn(async () => []),
  blockTask: vi.fn(async () => {}),
  editBlockedTask: vi.fn(async () => {}),
  createRepo: vi.fn(async () => {}),
  importRepo: vi.fn(async () => {}),
  cloneAndImportRepo: vi.fn(async () => {}),
  savePreference: vi.fn(async () => {}),
  attachWindowWorkspace: vi.fn(),
  selectRepo: vi.fn(),
  selectItem: vi.fn(),
  advanceStage: vi.fn(async () => {}),
  closeTask: vi.fn(async () => {}),
  bump: vi.fn(async () => {}),
  pinItem: vi.fn(async () => {}),
  unpinItem: vi.fn(async () => {}),
  reorderPinned: vi.fn(async () => {}),
  renameItem: vi.fn(async () => {}),
  hideRepo: vi.fn(async () => {}),
  spawnPtySession: vi.fn(async () => {}),
  loadAgent: vi.fn(async () => ({
    prompt: "Use https://schemas.kanna.build/config.schema.json when writing .kanna/config.json.",
    agent_provider: ["codex", "claude"],
    model: undefined,
    permission_mode: "default",
    allowed_tools: undefined,
  })),
};
const toastInfoMock = vi.fn();
const toastWarningMock = vi.fn();
const toastErrorMock = vi.fn();
const mockWindowWorkspace = {
  bootstrap: {
    windowId: "main",
    selectedRepoId: null,
    selectedItemId: null,
  },
  loadSnapshot: vi.fn(async () => ({ windows: [] })),
  saveSnapshot: vi.fn(async () => {}),
  openWindow: vi.fn(async () => {}),
  closeWindow: vi.fn(async () => {}),
  forgetCurrentWindow: vi.fn(async () => {}),
  persistSelection: vi.fn(async () => {}),
  persistSidebarHidden: vi.fn(async () => {}),
  persistSidebarWidth: vi.fn(async () => {}),
  invalidateSharedData: vi.fn(async () => {}),
  restoreAdditionalWindows: vi.fn(async () => {}),
};

let capturedKeyboardActions: KeyboardActions | null = null;

const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === "list_dir") return ["default.json"];
  if (command === "read_text_file") return "";
  if (command === "git_default_branch") return "main";
  if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
  if (command === "read_env_var") return "/Users/test";
  if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
  if (command === "complete_outgoing_transfer_finalization") return { transferId: args?.transferId ?? "transfer-1" };
  throw new Error(`unexpected invoke: ${command}`);
});

vi.mock("./stores/kanna", () => ({
  useKannaStore: () => store,
}));

vi.mock("./invoke", () => ({
  invoke: (command: string, args?: { name?: string; repoPath?: string }) => invokeMock(command, args),
}));

vi.mock("./tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTheme: nativeWindowSetThemeMock,
    onCloseRequested: vi.fn(async (handler: (event: { preventDefault: () => void }) => void | Promise<void>) => {
      closeRequestedHandler = handler;
      return () => {
        closeRequestedHandler = null;
      };
    }),
  }),
}));

vi.mock("@tauri-apps/api/app", () => ({
  setTheme: nativeSetThemeMock,
}));

vi.mock("./listen", () => ({
  listen: vi.fn(async (event: string, handler: (event: unknown) => void | Promise<void>) => {
    listenHandlers.set(event, handler);
    return () => {
      listenHandlers.delete(event);
    };
  }),
  listenCurrentWebviewWindow: vi.fn(async (event: string, handler: (event: unknown) => void | Promise<void>) => {
    currentWebviewWindowListenHandlers.set(event, handler);
    return () => {
      currentWebviewWindowListenHandlers.delete(event);
    };
  }),
}));

vi.mock("@kanna/core", () => ({
  NEW_CUSTOM_TASK_PROMPT: "custom",
  parseRepoConfig: vi.fn(() => ({})),
}));

vi.mock("@kanna/db", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./i18n", () => ({
  default: {
    global: {
      locale: {
        value: "en",
      },
    },
  },
}));

vi.mock("./composables/useBackup", () => ({
  scheduleStartupBackup: scheduleStartupBackupMock,
  startPeriodicBackup: vi.fn(),
}));

vi.mock("./composables/useOperatorEvents", () => ({
  useOperatorEvents: vi.fn(),
}));

vi.mock("./composables/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: vi.fn((actions: KeyboardActions) => {
    capturedKeyboardActions = actions;
  }),
}));

vi.mock("./composables/useCustomTasks", () => ({
  useCustomTasks: () => ({
    tasks: ref([]),
    scan: vi.fn(async () => []),
  }),
}));

const appUpdateStartMock = vi.fn();
const appUpdateMock = {
  status: ref<"idle" | "checking" | "available" | "downloading" | "readyToRestart" | "error">("available"),
  updateVersion: ref("0.0.39"),
  releaseNotes: ref("Notes for 0.0.39"),
  publishedAt: ref("2026-04-15T00:00:00Z"),
  dismissedVersion: ref<string | null>(null),
  downloadedBytes: ref(0),
  contentLength: ref<number | null>(null),
  errorMessage: ref<string | null>(null),
  visible: computed(() => true),
  start: appUpdateStartMock,
  checkNow: vi.fn(),
  dismiss: vi.fn(),
  install: vi.fn(),
  restartNow: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("./composables/useAppUpdate", () => ({
  useAppUpdate: () => appUpdateMock,
}));

vi.mock("./composables/useToast", () => ({
  useToast: () => ({
    error: toastErrorMock,
    info: toastInfoMock,
    warning: toastWarningMock,
  }),
}));

vi.mock("./services/desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    subscribe: vi.fn((handler: (state: unknown) => void) => {
      handler({
        status: "signedIn",
        user: { uid: "user-1", email: "upvote.sieve.7t@icloud.com" },
      });
      return () => {};
    }),
  })),
}));

vi.mock("./services/desktopCloudTaskIndex", () => ({
  listDesktopCloudTasks: cloudTasksMock,
}));

vi.mock("./services/desktopCloudPublisher", () => ({
  deleteRemoteTaskSnapshots: vi.fn(async () => {}),
  reconcileDesktopTaskSnapshots: reconcileDesktopTaskSnapshotsMock,
}));

vi.mock("./services/desktopRelayTerminal", () => ({
  createConfiguredDesktopRelayTerminalClient: vi.fn(async () => ({
    advanceStage: relayAdvanceStageMock,
    close: relayCloseMock,
  })),
}));

vi.mock("./services/desktopLanTerminal", () => ({
  createConfiguredDesktopLanTerminalClient: vi.fn(async () => ({
    advanceStage: relayAdvanceStageMock,
    close: relayCloseMock,
  })),
}));

vi.mock("./composables/useRestoreFocus", () => ({
  useRestoreFocus: vi.fn(),
}));

vi.mock("./composables/useModalZIndex", () => ({
  isTopModal: vi.fn(() => true),
  useModalZIndex: () => ({ zIndex: 1000 }),
}));

const SidebarWithRepoStub = defineComponent({
  name: "Sidebar",
  emits: ["new-task"],
  template: '<button data-testid="open-new-task" @click="$emit(\'new-task\', \'repo-1\')">open</button>',
});

const SidebarWithoutRepoStub = defineComponent({
  name: "Sidebar",
  emits: ["new-task"],
  template: '<button data-testid="open-new-task" @click="$emit(\'new-task\')">open</button>',
});

const FilePickerModalTestStub = defineComponent({
  name: "FilePickerModal",
  emits: ["close", "select"],
  template: `
    <div data-testid="file-picker-modal">
      <button data-testid="file-picker-select" @click="$emit('select', 'src/example.ts')">select</button>
      <button data-testid="file-picker-close" @click="$emit('close')">close</button>
    </div>
  `,
});

const FilePreviewModalTestStub = defineComponent({
  name: "FilePreviewModal",
  emits: ["close"],
  setup(_props, { emit, expose }) {
    function dismiss() {
      emit("close");
      return true;
    }

    expose({ dismiss });

    return {};
  },
  template: `
    <div data-testid="file-preview-modal">
      <button data-testid="file-preview-close" @click="$emit('close')">close</button>
    </div>
  `,
});

const TreeExplorerModalTestStub = defineComponent({
  name: "TreeExplorerModal",
  props: {
    maximized: Boolean,
    suspended: Boolean,
    worktreePath: {
      type: String,
      required: true,
    },
  },
  emits: ["open-file"],
  template: `
    <div
      data-testid="tree-explorer-modal"
      :data-maximized="String(maximized)"
      :data-suspended="String(suspended)"
      :data-worktree-path="worktreePath"
    >
      <button data-testid="tree-open-file" @click="$emit('open-file', 'src/example.ts')">open</button>
    </div>
  `,
});

const PreferencesPanelThemeUpdateStub = defineComponent({
  name: "PreferencesPanel",
  emits: ["update"],
  template: `
    <button data-testid="set-app-light" @click="$emit('update', 'appTheme', 'light')">
      light
    </button>
  `,
});

const PreferencesPanelSystemThemeUpdateStub = defineComponent({
  name: "PreferencesPanel",
  emits: ["update"],
  template: `
    <button data-testid="set-app-system" @click="$emit('update', 'appTheme', 'system')">
      system
    </button>
  `,
});

function buildIncomingTransferEvent() {
  return {
    payload: {
      type: "incoming_transfer_request",
      transfer_id: "transfer-1",
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      source_name: "Primary",
      payload: {
        target_peer_id: "peer-target",
        task: {
          source_peer_id: "peer-source",
          source_task_id: "task-source",
          prompt: "Fix handoff",
          stage: "in progress",
          branch: "task-source",
          pipeline: "default",
          display_name: "Transferred task",
          base_ref: "main",
          agent_type: "agent",
          agent_provider: "claude",
        },
        repo: {
          mode: "reuse-local",
          remote_url: "git@github.com:jemdiggity/kanna.git",
          path: "/tmp/repo",
          name: "repo",
          default_branch: "main",
        },
        recovery: null,
      },
    },
  };
}

function buildPendingIncomingTransferRow() {
  return {
    id: "transfer-1",
    source_peer_id: "peer-source",
    source_task_id: "task-source",
    payload_json: JSON.stringify(buildIncomingTransferEvent().payload.payload),
  };
}

function buildOutgoingTransferCommittedEvent() {
  return {
    payload: {
      type: "outgoing_transfer_committed",
      transfer_id: "transfer-1",
      source_task_id: "task-source",
      destination_local_task_id: "task-imported",
    },
  };
}

function buildOutgoingTransferFinalizationRequestedEvent() {
  return {
    payload: {
      type: "outgoing_transfer_finalization_requested",
      transfer_id: "transfer-1",
    },
  };
}
async function mountApp(sidebarStub: typeof SidebarWithRepoStub | typeof SidebarWithoutRepoStub) {
  vi.stubGlobal("__KANNA_MOBILE__", false);
  const { default: App } = await import("./App.vue");
  const wrapper = mount(App, {
    global: {
      provide: {
        db: dbMock,
        dbName: "test.db",
        windowWorkspace: mockWindowWorkspace,
      },
      mocks: {
        $t: (key: string) => key,
      },
      stubs: {
        Sidebar: sidebarStub,
        MainPanel: true,
        AddRepoModal: true,
        KeyboardShortcutsModal: true,
        FilePickerModal: true,
        FilePreviewModal: true,
        TreeExplorerModal: true,
        DiffModal: true,
        CommitGraphModal: true,
        ShellModal: true,
        CommandPaletteModal: true,
        AnalyticsModal: true,
        BlockerSelectModal: true,
        PreferencesPanel: true,
        ToastContainer: true,
        KeepAlive: false,
      },
    },
  });
  await flushPromises();
  await flushPromises();
  await flushPromises();
  return wrapper;
}

async function mountAppWithOverrides(
  sidebarStub: typeof SidebarWithRepoStub | typeof SidebarWithoutRepoStub,
  stubs: Record<string, unknown>,
) {
  vi.stubGlobal("__KANNA_MOBILE__", false);
  const { default: App } = await import("./App.vue");
  const wrapper = mount(App, {
    global: {
      provide: {
        db: dbMock,
        dbName: "test.db",
        windowWorkspace: mockWindowWorkspace,
      },
      mocks: {
        $t: (key: string) => key,
      },
      stubs: {
        Sidebar: sidebarStub,
        MainPanel: true,
        AddRepoModal: true,
        KeyboardShortcutsModal: true,
        FilePickerModal: true,
        FilePreviewModal: true,
        TreeExplorerModal: true,
        DiffModal: true,
        CommitGraphModal: true,
        ShellModal: true,
        CommandPaletteModal: true,
        AnalyticsModal: true,
        BlockerSelectModal: true,
        PreferencesPanel: true,
        ToastContainer: true,
        KeepAlive: false,
        ...stubs,
      },
    },
  });
  await flushPromises();
  await flushPromises();
  await flushPromises();
  return wrapper;
}

describe("App", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    store.init.mockClear();
    store.createItem.mockClear();
    store.recordIncomingTransfer.mockClear();
    store.approveIncomingTransfer.mockClear();
    store.rejectIncomingTransfer.mockClear();
    store.handleOutgoingTransferCommitted.mockClear();
    store.pushTaskToPeer.mockClear();
    store.loadAgent.mockClear();
    store.selectItem.mockClear();
    store.advanceStage.mockClear();
    relayAdvanceStageMock.mockClear();
    relayCloseMock.mockClear();
    store.repos = [{ id: "repo-1", path: "/tmp/repo", name: "repo" }];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = null;
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo", name: "repo" };
    store.currentItem = null;
    store.items = [];
    store.sortedItemsForCurrentRepo = [];
    store.sortedItemsAllRepos = [];
    store.getStageOrder.mockReturnValue(["in progress", "pr", "merge"]);
    store.appTheme = "dark";
    store.codeTheme = "match";
    nativeSetThemeMock.mockClear();
    listenHandlers.clear();
    currentWebviewWindowListenHandlers.clear();
    closeRequestedHandler = null;
    capturedKeyboardActions = null;
    mockWindowWorkspace.loadSnapshot.mockClear();
    mockWindowWorkspace.saveSnapshot.mockClear();
    mockWindowWorkspace.openWindow.mockClear();
    mockWindowWorkspace.closeWindow.mockClear();
    mockWindowWorkspace.forgetCurrentWindow.mockClear();
    mockWindowWorkspace.persistSelection.mockClear();
    mockWindowWorkspace.persistSidebarHidden.mockClear();
    mockWindowWorkspace.persistSidebarWidth.mockClear();
    mockWindowWorkspace.invalidateSharedData.mockClear();
    mockWindowWorkspace.restoreAdditionalWindows.mockClear();
    mockWindowWorkspace.bootstrap.windowId = "main";
    dbSelectMock.mockReset();
    dbSelectMock.mockResolvedValue([]);
    dbMock.execute.mockReset();
    dbMock.execute.mockResolvedValue({ rowsAffected: 0 });
    invokeMock.mockClear();
    toastInfoMock.mockClear();
    toastWarningMock.mockClear();
    toastErrorMock.mockClear();
    cloudTasksMock.mockReset();
    cloudTasksMock.mockResolvedValue({ repos: [], items: [] });
    reconcileDesktopTaskSnapshotsMock.mockReset();
    reconcileDesktopTaskSnapshotsMock.mockResolvedValue(undefined);
    appUpdateStartMock.mockClear();
    appUpdateMock.dispose.mockClear();
    appUpdateMock.dismiss.mockClear();
    appUpdateMock.install.mockClear();
    appUpdateMock.status.value = "available";
    appUpdateMock.visible = computed(() => true);
    scheduleStartupBackupMock.mockClear();
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      throw new Error(`unexpected invoke: ${command}`);
    });
  });

  it("schedules startup backup only after the main window initial data is loaded", async () => {
    const initDeferred = createDeferred<void>();
    store.init.mockImplementationOnce(async () => initDeferred.promise);

    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(scheduleStartupBackupMock).not.toHaveBeenCalled();

    initDeferred.resolve();
    await flushPromises();
    await flushPromises();

    expect(scheduleStartupBackupMock).toHaveBeenCalledTimes(1);
    expect(scheduleStartupBackupMock).toHaveBeenCalledWith("test.db");

    wrapper.unmount();
  });

  it("does not schedule startup backup from restored secondary windows", async () => {
    mockWindowWorkspace.bootstrap.windowId = "window-2";

    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(scheduleStartupBackupMock).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("reconciles cloud task snapshots during periodic cloud sync", async () => {
    vi.useFakeTimers();

    const wrapper = await mountApp(SidebarWithRepoStub);
    reconcileDesktopTaskSnapshotsMock.mockClear();
    cloudTasksMock.mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(reconcileDesktopTaskSnapshotsMock).toHaveBeenCalledWith(dbMock);
    expect(cloudTasksMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it("shows one toast when periodic cloud reconciliation fails", async () => {
    vi.useFakeTimers();

    const wrapper = await mountApp(SidebarWithRepoStub);
    reconcileDesktopTaskSnapshotsMock.mockClear();
    toastErrorMock.mockClear();
    reconcileDesktopTaskSnapshotsMock.mockRejectedValue(
      Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("Cloud sync failed: permission-denied");

    wrapper.unmount();
  });

  it("shows one toast when periodic cloud task refresh fails", async () => {
    vi.useFakeTimers();

    const wrapper = await mountApp(SidebarWithRepoStub);
    cloudTasksMock.mockClear();
    toastErrorMock.mockClear();
    cloudTasksMock.mockRejectedValue(
      Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("Cloud sync failed: permission-denied");

    wrapper.unmount();
  });

  it("applies persisted light app theme and explicit dark code theme to the document", async () => {
    store.appTheme = "light";
    store.codeTheme = "dark";

    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.codeTheme).toBe("dark");
    expect(nativeSetThemeMock).toHaveBeenCalledWith("light");
    expect(nativeWindowSetThemeMock).toHaveBeenCalledWith("light");

    wrapper.unmount();
  });

  it("syncs app theme preference changes to the native title bar", async () => {
    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      PreferencesPanel: PreferencesPanelThemeUpdateStub,
    });
    nativeSetThemeMock.mockClear();

    capturedKeyboardActions?.openPreferences();
    await nextTick();
    await wrapper.get('[data-testid="set-app-light"]').trigger("click");
    await flushPromises();

    expect(store.savePreference).toHaveBeenCalledWith("appTheme", "light");
    expect(nativeSetThemeMock).toHaveBeenCalledWith("light");
    expect(nativeWindowSetThemeMock).toHaveBeenCalledWith("light");

    wrapper.unmount();
  });

  it("re-reads the system color scheme after clearing a forced native theme", async () => {
    let prefersDark = true;
    const originalMatchMedia = window.matchMedia;
    const mediaQuery = {
      get matches() {
        return prefersDark;
      },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    };
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => mediaQuery),
    });
    nativeSetThemeMock.mockImplementation(async (theme: "dark" | "light" | null) => {
      if (theme === null) prefersDark = false;
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      PreferencesPanel: PreferencesPanelSystemThemeUpdateStub,
    });
    nativeSetThemeMock.mockClear();

    capturedKeyboardActions?.openPreferences();
    await nextTick();
    await wrapper.get('[data-testid="set-app-system"]').trigger("click");
    await flushPromises();

    expect(store.savePreference).toHaveBeenCalledWith("appTheme", "system");
    expect(nativeSetThemeMock).toHaveBeenCalledWith(null);
    expect(nativeWindowSetThemeMock).toHaveBeenCalledWith(null);
    expect(document.documentElement.dataset.theme).toBe("light");

    wrapper.unmount();
    nativeSetThemeMock.mockReset();
    nativeSetThemeMock.mockImplementation(async () => {});
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("prevents browser navigation when files are dragged over or dropped on the app shell", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();
    await flushPromises();
    await flushPromises();

    const dragOverEvent = new DragEvent("dragover", { cancelable: true });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: {
        files: [{ path: "/tmp/image.png", type: "image/png" }],
        types: ["Files"],
      },
    });

    const dropEvent = new DragEvent("drop", { cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        files: [{ path: "/tmp/image.png", type: "image/png" }],
        types: ["Files"],
      },
    });

    window.dispatchEvent(dragOverEvent);
    window.dispatchEvent(dropEvent);

    expect(dragOverEvent.defaultPrevented).toBe(true);
    expect(dropEvent.defaultPrevented).toBe(true);

    wrapper.unmount();
  });

  it("toggles preferences with the preferences shortcut action", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(capturedKeyboardActions).not.toBeNull();
    expect(wrapper.findComponent({ name: "PreferencesPanel" }).exists()).toBe(false);

    capturedKeyboardActions?.openPreferences();
    await flushPromises();

    expect(wrapper.findComponent({ name: "PreferencesPanel" }).exists()).toBe(true);

    capturedKeyboardActions?.openPreferences();
    await flushPromises();

    expect(wrapper.findComponent({ name: "PreferencesPanel" }).exists()).toBe(false);

    wrapper.unmount();
  });

  it("restores the saved sidebar width for the current window", async () => {
    mockWindowWorkspace.loadSnapshot.mockResolvedValueOnce({
      windows: [
        {
          windowId: "main",
          selectedRepoId: "repo-1",
          selectedItemId: null,
          order: 0,
          sidebarHidden: false,
          sidebarWidth: 340,
        },
      ],
    });

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(wrapper.get('[data-testid="sidebar-shell"]').attributes("style")).toContain("width: 340px");

    wrapper.unmount();
  });

  it("resizes the sidebar by dragging the desktop handle and persists the final width", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    await wrapper.get('[data-testid="sidebar-resize-handle"]').trigger("pointerdown", {
      clientX: 260,
      pointerId: 1,
    });
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 320 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 320 }));
    await flushPromises();

    expect(wrapper.get('[data-testid="sidebar-shell"]').attributes("style")).toContain("width: 320px");
    expect(mockWindowWorkspace.persistSidebarWidth).toHaveBeenCalledWith(320);

    wrapper.unmount();
  });

  it("clamps the resized sidebar width before persisting", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    await wrapper.get('[data-testid="sidebar-resize-handle"]').trigger("pointerdown", {
      clientX: 260,
      pointerId: 1,
    });
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 80 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 80 }));
    await flushPromises();

    expect(wrapper.get('[data-testid="sidebar-shell"]').attributes("style")).toContain("width: 220px");
    expect(mockWindowWorkspace.persistSidebarWidth).toHaveBeenLastCalledWith(220);

    await wrapper.get('[data-testid="sidebar-resize-handle"]').trigger("pointerdown", {
      clientX: 220,
      pointerId: 2,
    });
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 900 }));
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 900 }));
    await flushPromises();

    expect(wrapper.get('[data-testid="sidebar-shell"]').attributes("style")).toContain("width: 420px");
    expect(mockWindowWorkspace.persistSidebarWidth).toHaveBeenLastCalledWith(420);

    wrapper.unmount();
  });

  it("does not suppress non-file drags on the app shell", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();
    await flushPromises();
    await flushPromises();

    const dragOverEvent = new DragEvent("dragover", { cancelable: true });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: {
        files: [],
        types: ["text/plain"],
      },
    });

    window.dispatchEvent(dragOverEvent);

    expect(dragOverEvent.defaultPrevented).toBe(false);

    wrapper.unmount();
  });

  it("selects cloud sidebar tasks into the main panel", async () => {
    cloudTasksMock.mockResolvedValue({
      repos: [{
        id: "cloud:repo-remote",
        path: "cloud",
        name: "Remote Repo",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-05-18T00:00:00.000Z",
        last_opened_at: "2026-05-18T00:00:00.000Z",
      }],
      items: [{
        id: "cloud:repo-remote:task-remote",
        repo_id: "cloud:repo-remote",
        prompt: "Remote task",
        pipeline: "cloud",
        stage: "in progress",
        tags: "[]",
        pr_number: null,
        pr_url: null,
        branch: "task-remote",
        activity: "idle",
        activity_changed_at: "2026-05-18T00:00:00.000Z",
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Remote task",
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "codex",
        agent_type: "pty",
        previous_stage: null,
        stage_result: null,
        teardown_started_at: null,
        last_output_preview: null,
        active_post_action: null,
        created_at: "2026-05-18T00:00:00.000Z",
        updated_at: "2026-05-18T00:00:00.000Z",
      }],
    });

    const SidebarCloudStub = defineComponent({
      name: "Sidebar",
      props: {
        repos: { type: Array, default: () => [] },
        pipelineItems: { type: Array, default: () => [] },
      },
      emits: ["select-repo", "select-item"],
      template: `
        <div data-testid="sidebar">
          <button
            v-for="item in pipelineItems"
            :key="item.id"
            data-testid="cloud-task"
            type="button"
            @click="$emit('select-repo', item.repo_id); $emit('select-item', item.id)"
          >
            {{ item.display_name }}
          </button>
        </div>
      `,
    });

    const MainPanelCloudStub = defineComponent({
      name: "MainPanel",
      props: {
        item: Object,
        repoPath: String,
      },
      template: `
        <div data-testid="main-panel">
          <span data-testid="main-item-id">{{ item?.id || "" }}</span>
          <span data-testid="main-repo-path">{{ repoPath || "" }}</span>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarCloudStub, {
      MainPanel: MainPanelCloudStub,
    });
    await flushPromises();
    await flushPromises();

    await wrapper.get('[data-testid="cloud-task"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="main-item-id"]').text()).toBe("cloud:repo-remote:task-remote");
    expect(wrapper.get('[data-testid="main-repo-path"]').text()).toBe("cloud");

    wrapper.unmount();
  });

  it("navigates to cloud tasks with keyboard task shortcuts", async () => {
    store.repos = [];
    store.selectedRepoId = null;
    store.selectedItemId = null;
    store.selectedRepo = null;
    cloudTasksMock.mockResolvedValue({
      repos: [{
        id: "cloud:repo-remote",
        path: "cloud",
        name: "Remote Repo",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-05-18T00:00:00.000Z",
        last_opened_at: "2026-05-18T00:00:00.000Z",
      }],
      items: [{
        id: "cloud:repo-remote:task-remote",
        repo_id: "cloud:repo-remote",
        prompt: "Remote task",
        pipeline: "cloud",
        stage: "in progress",
        tags: "[]",
        pr_number: null,
        pr_url: null,
        branch: "task-remote",
        activity: "idle",
        activity_changed_at: "2026-05-18T00:00:00.000Z",
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Remote task",
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "codex",
        agent_type: "pty",
        previous_stage: null,
        stage_result: null,
        teardown_started_at: null,
        last_output_preview: null,
        active_post_action: null,
        created_at: "2026-05-18T00:00:00.000Z",
        updated_at: "2026-05-18T00:00:00.000Z",
      }],
    });

    const MainPanelCloudStub = defineComponent({
      name: "MainPanel",
      props: {
        item: Object,
        repoPath: String,
      },
      template: `
        <div data-testid="main-panel">
          <span data-testid="main-item-id">{{ item?.id || "" }}</span>
          <span data-testid="main-repo-path">{{ repoPath || "" }}</span>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithoutRepoStub, {
      MainPanel: MainPanelCloudStub,
    });
    await flushPromises();
    await flushPromises();

    capturedKeyboardActions?.navigateDown();
    await flushPromises();

    expect(wrapper.get('[data-testid="main-item-id"]').text()).toBe("cloud:repo-remote:task-remote");
    expect(wrapper.get('[data-testid="main-repo-path"]').text()).toBe("cloud");
    expect(store.selectItem).not.toHaveBeenCalledWith("cloud:repo-remote:task-remote", expect.anything());

    wrapper.unmount();
  });

  it("navigates to cloud repos with keyboard repo shortcuts", async () => {
    store.repos = [];
    store.selectedRepoId = null;
    store.selectedItemId = null;
    store.selectedRepo = null;
    cloudTasksMock.mockResolvedValue({
      repos: [{
        id: "cloud:repo-remote",
        path: "cloud",
        name: "Remote Repo",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-05-18T00:00:00.000Z",
        last_opened_at: "2026-05-18T00:00:00.000Z",
      }],
      items: [{
        id: "cloud:repo-remote:task-remote",
        repo_id: "cloud:repo-remote",
        prompt: "Remote task",
        pipeline: "cloud",
        stage: "in progress",
        tags: "[]",
        pr_number: null,
        pr_url: null,
        branch: "task-remote",
        activity: "idle",
        activity_changed_at: "2026-05-18T00:00:00.000Z",
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Remote task",
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "codex",
        agent_type: "pty",
        previous_stage: null,
        stage_result: null,
        teardown_started_at: null,
        last_output_preview: null,
        active_post_action: null,
        created_at: "2026-05-18T00:00:00.000Z",
        updated_at: "2026-05-18T00:00:00.000Z",
      }],
    });

    const MainPanelCloudStub = defineComponent({
      name: "MainPanel",
      props: {
        item: Object,
        repoPath: String,
      },
      template: `
        <div data-testid="main-panel">
          <span data-testid="main-item-id">{{ item?.id || "" }}</span>
          <span data-testid="main-repo-path">{{ repoPath || "" }}</span>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithoutRepoStub, {
      MainPanel: MainPanelCloudStub,
    });
    await flushPromises();
    await flushPromises();

    capturedKeyboardActions?.navigateRepoDown();
    await flushPromises();

    expect(wrapper.get('[data-testid="main-item-id"]').text()).toBe("cloud:repo-remote:task-remote");
    expect(wrapper.get('[data-testid="main-repo-path"]').text()).toBe("cloud");
    expect(store.selectRepo).not.toHaveBeenCalledWith("cloud:repo-remote");

    wrapper.unmount();
  });

  it("routes Cmd+S to the owner when a reachable remote workspace task is selected", async () => {
    const localFallbackItem = {
      id: "task-local",
      repo_id: "repo-1",
      prompt: "Local fallback",
      pipeline: "default",
      stage: "in progress",
      tags: "[]",
      pr_number: null,
      pr_url: null,
      branch: "task-local",
      activity: "idle",
      activity_changed_at: "2026-05-18T00:00:00.000Z",
      unread_at: null,
      port_offset: null,
      port_env: null,
      pinned: 0,
      pin_order: null,
      display_name: "Local fallback",
      issue_number: null,
      issue_title: null,
      closed_at: null,
      agent_session_id: null,
      base_ref: "origin/main",
      agent_provider: "codex",
      agent_type: "pty",
      previous_stage: null,
      stage_result: null,
      teardown_started_at: null,
      last_output_preview: null,
      active_post_action: null,
      created_at: "2026-05-18T00:00:00.000Z",
      updated_at: "2026-05-18T00:00:00.000Z",
    };
    store.items = [localFallbackItem];
    store.currentItem = localFallbackItem;
    store.sortedItemsForCurrentRepo = [localFallbackItem];
    store.sortedItemsAllRepos = [localFallbackItem];

    cloudTasksMock.mockResolvedValue({
      repos: [{
        id: "repo-1",
        path: "cloud",
        name: "repo",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-05-18T00:00:00.000Z",
        last_opened_at: "2026-05-18T00:00:00.000Z",
      }],
      items: [{
        id: "cloud:repo-1:task-remote",
        repo_id: "repo-1",
        prompt: "Remote task",
        pipeline: "cloud",
        stage: "in progress",
        tags: "[]",
        pr_number: null,
        pr_url: null,
        branch: "task-remote",
        activity: "idle",
        activity_changed_at: "2026-05-18T00:00:00.000Z",
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Remote task",
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "codex",
        agent_type: "pty",
        previous_stage: null,
        stage_result: null,
        teardown_started_at: null,
        last_output_preview: null,
        active_post_action: null,
        created_at: "2026-05-18T00:00:00.000Z",
        updated_at: "2026-05-18T00:00:00.000Z",
      }],
      terminalRefs: {
        "cloud:repo-1:task-remote": {
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "task-owner",
          transport: "cloud",
        },
      },
    });

    const SidebarMixedStub = defineComponent({
      name: "Sidebar",
      props: {
        pipelineItems: { type: Array, default: () => [] },
      },
      emits: ["select-item"],
      template: `
        <div data-testid="sidebar">
          <button
            v-for="item in pipelineItems"
            :key="item.id"
            :data-testid="\`task-\${item.id}\`"
            type="button"
            @click="$emit('select-item', item.id)"
          >
            {{ item.display_name }}
          </button>
        </div>
      `,
    });

    const MainPanelTaskStub = defineComponent({
      name: "MainPanel",
      props: {
        item: Object,
      },
      template: '<div data-testid="main-item-id">{{ item?.id || "" }}</div>',
    });

    const wrapper = await mountAppWithOverrides(SidebarMixedStub, {
      MainPanel: MainPanelTaskStub,
    });
    await flushPromises();
    await flushPromises();

    await wrapper.get('[data-testid="task-cloud:repo-1:task-remote"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="main-item-id"]').text()).toBe("cloud:repo-1:task-remote");

    capturedKeyboardActions?.advanceStage();
    await flushPromises();

    expect(store.advanceStage).not.toHaveBeenCalled();
    expect(relayAdvanceStageMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-owner",
    });
    expect(relayCloseMock).toHaveBeenCalled();

    wrapper.unmount();
  });

  it("renders the modal with the preferred existing base branch selected", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);

    await flushPromises();
    await wrapper.get('[data-testid="open-new-task"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("origin/main");
  });

  it("warns when Cmd+Shift+N is pressed without any repositories loaded", async () => {
    store.repos = [];
    store.selectedRepoId = null;
    store.selectedRepo = null;

    const wrapper = await mountApp(SidebarWithoutRepoStub);

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.newTask();
    await flushPromises();
    await flushPromises();

    expect(toastWarningMock).toHaveBeenCalledWith("toasts.noReposLoaded");
    expect(wrapper.find("textarea").exists()).toBe(false);

    wrapper.unmount();
  });

  it("opens New Task when only cloud tasks make a repo visible", async () => {
    store.repos = [];
    store.selectedRepoId = null;
    store.selectedRepo = null;
    cloudTasksMock.mockResolvedValue({
      repos: [{
        id: "cloud:repo-remote",
        path: "cloud",
        name: "Remote Repo",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-05-18T00:00:00.000Z",
        last_opened_at: "2026-05-18T00:00:00.000Z",
      }],
      items: [{
        id: "cloud:repo-remote:task-remote",
        repo_id: "cloud:repo-remote",
        prompt: "Remote task",
        pipeline: "cloud",
        stage: "in progress",
        tags: "[]",
        pr_number: null,
        pr_url: null,
        branch: "task-remote",
        activity: "idle",
        activity_changed_at: "2026-05-18T00:00:00.000Z",
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Remote task",
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "codex",
        agent_type: "pty",
        previous_stage: null,
        stage_result: null,
        teardown_started_at: null,
        last_output_preview: null,
        active_post_action: null,
        created_at: "2026-05-18T00:00:00.000Z",
        updated_at: "2026-05-18T00:00:00.000Z",
      }],
    });

    const wrapper = await mountApp(SidebarWithoutRepoStub);

    await flushPromises();
    await flushPromises();
    capturedKeyboardActions?.newTask();
    await flushPromises();

    expect(toastWarningMock).not.toHaveBeenCalledWith("toasts.noReposLoaded");
    expect(wrapper.find("textarea").exists()).toBe(true);

    wrapper.unmount();
  });

  it("loads remote base branches when opening New Task for a cloud-only repo", async () => {
    store.repos = [];
    store.selectedRepoId = null;
    store.selectedRepo = null;
    cloudTasksMock.mockResolvedValue({
      repos: [{
        id: "cloud:repo-remote",
        path: "cloud",
        name: "Remote Repo",
        remote_url: "git@github.com:jemdiggity/remote-repo.git",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-05-18T00:00:00.000Z",
        last_opened_at: "2026-05-18T00:00:00.000Z",
      }],
      items: [],
    });
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; remoteUrl?: string }) => {
      if (command === "git_list_remote_base_branches") return ["origin/main", "origin/release/x"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = await mountApp(SidebarWithoutRepoStub);

    await flushPromises();
    await flushPromises();
    capturedKeyboardActions?.newTask();
    await flushPromises();
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("git_list_remote_base_branches", {
      remoteUrl: "git@github.com:jemdiggity/remote-repo.git",
    });
    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("origin/main");

    wrapper.unmount();
  });

  it("clones and imports a cloud-only repo before creating a task", async () => {
    store.repos = [];
    store.selectedRepoId = null;
    store.selectedRepo = null;
    store.cloneAndImportRepo.mockImplementation(async (_url: string, destination: string) => {
      store.repos = [{ id: "repo-imported", path: destination, name: "remote-repo" }];
      store.selectedRepoId = "repo-imported";
      store.selectedRepo = { id: "repo-imported", path: destination, name: "remote-repo" };
    });
    cloudTasksMock.mockResolvedValue({
      repos: [{
        id: "cloud:repo-remote",
        path: "cloud",
        name: "Remote Repo",
        remote_url: "git@github.com:jemdiggity/remote-repo.git",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-05-18T00:00:00.000Z",
        last_opened_at: "2026-05-18T00:00:00.000Z",
      }],
      items: [],
    });
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; path?: string; remoteUrl?: string }) => {
      if (command === "git_list_remote_base_branches") return ["origin/main", "origin/release/x"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "file_exists") return false;
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = await mountApp(SidebarWithoutRepoStub);

    await flushPromises();
    await flushPromises();
    capturedKeyboardActions?.newTask();
    await flushPromises();
    await flushPromises();

    await wrapper.get("textarea").setValue("Create task from remote repo");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(store.cloneAndImportRepo).toHaveBeenCalledWith(
      "git@github.com:jemdiggity/remote-repo.git",
      "/Users/test/.kanna/repos/remote-repo",
    );
    expect(store.createItem).toHaveBeenCalledWith(
      "repo-imported",
      "/Users/test/.kanna/repos/remote-repo",
      "Create task from remote repo",
      "agent",
      expect.objectContaining({
        baseBranch: "origin/main",
      }),
    );

    wrapper.unmount();
  });

  it("submits the visible baseBranch when the resolved default branch was never explicitly changed", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);

    await flushPromises();
    await wrapper.get('[data-testid="open-new-task"]').trigger("click");
    await flushPromises();
    await flushPromises();

    await wrapper.get("textarea").setValue("Create default-base task");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(store.createItem).toHaveBeenCalledWith(
      "repo-1",
      "/tmp/repo",
      "Create default-base task",
      "agent",
      expect.objectContaining({
        agentProvider: "claude",
        pipelineName: "default",
        baseBranch: "origin/main",
      }),
    );
  });

  it("does not create a task when repo branch data was unresolved", async () => {
    store.selectedRepoId = null;
    store.selectedRepo = null;
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return [];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = await mountApp(SidebarWithoutRepoStub);

    await flushPromises();
    await wrapper.get('[data-testid="open-new-task"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("tasks.baseBranchRequired");

    await wrapper.get("textarea").setValue("Create unresolved task");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(store.createItem).not.toHaveBeenCalled();
  });

  it("does not auto-select an arbitrary feature branch when default refs are missing", async () => {
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = await mountApp(SidebarWithRepoStub);

    await flushPromises();
    await wrapper.get('[data-testid="open-new-task"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("tasks.baseBranchRequired");

    await wrapper.get("textarea").setValue("Create arbitrary branch task");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(store.createItem).not.toHaveBeenCalled();
  });

  it("uses the local default branch when the origin default is missing", async () => {
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = await mountApp(SidebarWithRepoStub);

    await flushPromises();
    await wrapper.get('[data-testid="open-new-task"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("main");

    await wrapper.get("textarea").setValue("Create local default task");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });
    await flushPromises();

    expect(store.createItem).toHaveBeenCalledWith(
      "repo-1",
      "/tmp/repo",
      "Create local default task",
      "agent",
      expect.objectContaining({
        baseBranch: "main",
      }),
    );
  });
  it("skips blocked tasks when navigating to the oldest and newest read task", async () => {
    store.sortedItemsForCurrentRepo = [
      { id: "blocked-oldest", activity: "idle", created_at: "2026-03-31T00:00:00.000Z", tags: '["blocked"]' },
      { id: "read-oldest", activity: "idle", created_at: "2026-03-31T01:00:00.000Z", tags: "[]" },
      { id: "read-newest", activity: "idle", created_at: "2026-03-31T03:00:00.000Z", tags: "[]" },
      { id: "blocked-newest", activity: "idle", created_at: "2026-03-31T04:00:00.000Z", tags: '["blocked"]' },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestRead();
    expect(store.selectItem).toHaveBeenCalledWith("read-oldest");

    store.selectItem.mockClear();
    capturedKeyboardActions?.goToNewestRead();
    expect(store.selectItem).toHaveBeenCalledWith("read-newest");
  });

  it("navigates to the closest read task relative to the selected task", async () => {
    store.currentItem = { id: "current", created_at: "2026-03-31T03:00:00.000Z" };
    store.sortedItemsForCurrentRepo = [
      { id: "read-oldest", activity: "idle", created_at: "2026-03-31T00:00:00.000Z", tags: "[]" },
      { id: "read-near-older", activity: "idle", created_at: "2026-03-31T02:00:00.000Z", tags: "[]" },
      { id: "current", activity: "working", created_at: "2026-03-31T03:00:00.000Z", tags: "[]" },
      { id: "read-near-newer", activity: "idle", created_at: "2026-03-31T04:00:00.000Z", tags: "[]" },
      { id: "read-newest", activity: "idle", created_at: "2026-03-31T05:00:00.000Z", tags: "[]" },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestRead();
    expect(store.selectItem).toHaveBeenCalledWith("read-near-older");

    store.selectItem.mockClear();
    capturedKeyboardActions?.goToNewestRead();
    expect(store.selectItem).toHaveBeenCalledWith("read-near-newer");
  });

  it("opens a new window through the workspace controller using the current selection", async () => {
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-1";

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.newWindow();

    expect(mockWindowWorkspace.openWindow).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
    });
  });

  it("closes the focused window through the workspace controller", async () => {
    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.closeWindow();

    expect(mockWindowWorkspace.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("opens a new window when the native window-open event arrives", async () => {
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-1";

    await mountApp(SidebarWithRepoStub);
    expect(listenHandlers.has(WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT)).toBe(false);
    const handler = currentWebviewWindowListenHandlers.get(WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT);
    expect(handler).toBeTypeOf("function");

    await handler?.({});

    expect(mockWindowWorkspace.openWindow).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
    });
  });

  it("closes the current window when the native window-close event arrives", async () => {
    await mountApp(SidebarWithRepoStub);
    expect(listenHandlers.has(WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT)).toBe(false);
    const handler = currentWebviewWindowListenHandlers.get(WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT);
    expect(handler).toBeTypeOf("function");

    await handler?.({});

    expect(mockWindowWorkspace.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("persists workspace closure and lets Tauri finish a native window close request", async () => {
    await mountApp(SidebarWithRepoStub);
    const handler = await waitForNativeCloseRequestedHandler();
    expect(handler).toBeTypeOf("function");
    const event = { preventDefault: vi.fn() };

    await handler?.(event);

    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.closeWindow).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps the native window open if workspace closure persistence fails", async () => {
    mockWindowWorkspace.forgetCurrentWindow.mockRejectedValueOnce(new Error("write failed"));
    await mountApp(SidebarWithRepoStub);
    const handler = await waitForNativeCloseRequestedHandler();
    expect(handler).toBeTypeOf("function");
    const event = { preventDefault: vi.fn() };

    await handler?.(event);

    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("navigates tasks when the native task-navigation event arrives", async () => {
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-new";
    store.sortedItemsAllRepos = [
      { id: "task-new", repo_id: "repo-1" },
      { id: "task-old", repo_id: "repo-1" },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(listenHandlers.has(WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT)).toBe(false);
    const handler = currentWebviewWindowListenHandlers.get(WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT);
    expect(handler).toBeTypeOf("function");

    await handler?.({});

    expect(store.selectItem).toHaveBeenCalledWith("task-old", { previousItemId: "task-new" });
  });

  it("navigates task shortcuts in the same order the sidebar renders stage groups", async () => {
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-progress";
    store.items = [
      {
        id: "task-pr",
        repo_id: "repo-1",
        prompt: "PR task",
        stage: "pr",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T10:01:00.000Z",
        updated_at: "2026-04-17T10:01:00.000Z",
      },
      {
        id: "task-progress",
        repo_id: "repo-1",
        prompt: "In progress task",
        stage: "in progress",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T10:00:00.000Z",
        updated_at: "2026-04-17T10:00:00.000Z",
      },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.navigateDown();

    expect(store.selectItem).toHaveBeenCalledWith("task-pr", { previousItemId: "task-progress" });
  });

  it("navigates task shortcuts across repo boundaries in sidebar order", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-one";
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" };
    store.items = [
      {
        id: "task-one",
        repo_id: "repo-1",
        prompt: "Repo one task",
        stage: "in progress",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T10:00:00.000Z",
        updated_at: "2026-04-17T10:00:00.000Z",
      },
      {
        id: "task-two",
        repo_id: "repo-2",
        prompt: "Repo two task",
        stage: "in progress",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T10:01:00.000Z",
        updated_at: "2026-04-17T10:01:00.000Z",
      },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.navigateDown();
    await flushPromises();

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2");
    expect(store.selectItem).toHaveBeenCalledWith("task-two", { previousItemId: "task-one" });
  });

  it("navigates unread task shortcuts across repo boundaries before falling back to read tasks", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-read";
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" };
    store.currentItem = {
      id: "task-read",
      repo_id: "repo-1",
      activity: "idle",
      created_at: "2026-04-17T10:00:00.000Z",
      tags: "[]",
      stage: "in progress",
    };
    store.items = [
      {
        id: "task-read",
        repo_id: "repo-1",
        prompt: "Repo one read task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T10:00:00.000Z",
        updated_at: "2026-04-17T10:00:00.000Z",
      },
      {
        id: "task-unread-other-repo",
        repo_id: "repo-2",
        prompt: "Repo two unread task",
        stage: "in progress",
        activity: "unread",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T10:01:00.000Z",
        updated_at: "2026-04-17T10:01:00.000Z",
      },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.goToOldestUnread();
    await flushPromises();

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2");
    expect(store.selectItem).toHaveBeenCalledWith("task-unread-other-repo", { previousItemId: "task-read" });
  });

  it("navigates repos when the native repo-navigation event arrives", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-one";
    store.items = [
      { id: "task-two", repo_id: "repo-2", stage: "in progress" },
    ];
    store.sortedItemsAllRepos = [
      { id: "task-one", repo_id: "repo-1" },
      { id: "task-two", repo_id: "repo-2" },
    ];
    store.lastSelectedItemByRepo = {};

    await mountApp(SidebarWithRepoStub);
    expect(listenHandlers.has(WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT)).toBe(false);
    const handler = currentWebviewWindowListenHandlers.get(WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT);
    expect(handler).toBeTypeOf("function");

    await handler?.({});

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2");
    expect(store.selectItem).toHaveBeenCalledWith("task-two", { previousItemId: "task-one" });
  });

  it("skips teardown tasks when navigating to unread tasks", async () => {
    store.sortedItemsForCurrentRepo = [
      { id: "teardown-unread", activity: "unread", created_at: "2026-03-31T00:00:00.000Z", tags: "[]", stage: "pr", teardown_started_at: "2026-05-08T00:00:00.000Z" },
      { id: "normal-unread", activity: "unread", created_at: "2026-03-31T01:00:00.000Z", tags: "[]", stage: "in progress" },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestUnread();
    expect(store.selectItem).toHaveBeenCalledWith("normal-unread");
  });

  it("navigates to the closest unread task relative to the selected task", async () => {
    store.currentItem = { id: "current", created_at: "2026-03-31T03:00:00.000Z" };
    store.sortedItemsForCurrentRepo = [
      { id: "unread-oldest", activity: "unread", created_at: "2026-03-31T00:00:00.000Z", tags: "[]" },
      { id: "unread-near-older", activity: "unread", created_at: "2026-03-31T02:00:00.000Z", tags: "[]" },
      { id: "current", activity: "idle", created_at: "2026-03-31T03:00:00.000Z", tags: "[]" },
      { id: "unread-near-newer", activity: "unread", created_at: "2026-03-31T04:00:00.000Z", tags: "[]" },
      { id: "unread-newest", activity: "unread", created_at: "2026-03-31T05:00:00.000Z", tags: "[]" },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestUnread();
    expect(store.selectItem).toHaveBeenCalledWith("unread-near-older");

    store.selectItem.mockClear();
    capturedKeyboardActions?.goToNewestUnread();
    expect(store.selectItem).toHaveBeenCalledWith("unread-near-newer");
  });

  it("falls back to relative read tasks when unread shortcut navigation has no unread task", async () => {
    store.currentItem = { id: "current", created_at: "2026-03-31T02:30:00.000Z" };
    store.sortedItemsForCurrentRepo = [
      { id: "blocked-oldest", activity: "idle", created_at: "2026-03-31T00:00:00.000Z", tags: '["blocked"]' },
      { id: "read-oldest", activity: "idle", created_at: "2026-03-31T01:00:00.000Z", tags: "[]" },
      { id: "read-near-older", activity: "idle", created_at: "2026-03-31T02:00:00.000Z", tags: "[]" },
      { id: "current", activity: "idle", created_at: "2026-03-31T02:30:00.000Z", tags: "[]" },
      { id: "read-near-newer", activity: "idle", created_at: "2026-03-31T02:45:00.000Z", tags: "[]" },
      { id: "read-newest", activity: "idle", created_at: "2026-03-31T03:00:00.000Z", tags: "[]" },
      { id: "blocked-newest", activity: "idle", created_at: "2026-03-31T04:00:00.000Z", tags: '["blocked"]' },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestUnread();
    expect(store.selectItem).toHaveBeenCalledWith("read-near-older");

    store.selectItem.mockClear();
    capturedKeyboardActions?.goToNewestUnread();
    expect(store.selectItem).toHaveBeenCalledWith("read-near-newer");
  });

  it("reopens the diff modal with the last saved diff view state", async () => {
    const DiffModalStub = defineComponent({
      name: "DiffModal",
      props: {
        initialScope: String,
        initialScrollPositions: Object,
        initialBranchInclude: String,
      },
      emits: ["scope-change", "scroll-state-change", "branch-include-change", "close"],
      template: `
        <div data-testid="diff-modal">
          <span data-testid="diff-scope">{{ initialScope ?? '' }}</span>
          <span data-testid="diff-working-scroll">{{ initialScrollPositions?.working ?? '' }}</span>
          <span data-testid="diff-branch-include">{{ initialBranchInclude ?? '' }}</span>
          <button
            data-testid="remember-diff-state"
            @click="$emit('scope-change', 'branch'); $emit('scroll-state-change', { working: 240, branch: 520 }); $emit('branch-include-change', 'all')"
          >
            remember
          </button>
          <button data-testid="close-diff" @click="$emit('close')">close</button>
        </div>
      `,
    });

    vi.stubGlobal("__KANNA_MOBILE__", false);
    const { default: App } = await import("./App.vue");
    const wrapper = mount(App, {
      global: {
        provide: {
          db: dbMock,
          dbName: "test.db",
        },
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          Sidebar: SidebarWithRepoStub,
          MainPanel: true,
          AddRepoModal: true,
          KeyboardShortcutsModal: true,
          FilePickerModal: true,
          FilePreviewModal: true,
          TreeExplorerModal: true,
          DiffModal: DiffModalStub,
          CommitGraphModal: true,
          ShellModal: true,
          CommandPaletteModal: true,
          AnalyticsModal: true,
          BlockerSelectModal: true,
          PreferencesPanel: true,
          ToastContainer: true,
          KeepAlive: false,
        },
      },
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.showDiff();
    await flushPromises();

    expect(wrapper.get('[data-testid="diff-scope"]').text()).toBe("");

    await wrapper.get('[data-testid="remember-diff-state"]').trigger("click");
    await flushPromises();

    capturedKeyboardActions?.showDiff();
    await flushPromises();
    expect(wrapper.find('[data-testid="diff-modal"]').exists()).toBe(false);

    capturedKeyboardActions?.showDiff();
    await flushPromises();

    expect(wrapper.get('[data-testid="diff-scope"]').text()).toBe("branch");
    expect(wrapper.get('[data-testid="diff-working-scroll"]').text()).toBe("240");
    expect(wrapper.get('[data-testid="diff-branch-include"]').text()).toBe("all");
  });
  it("starts the updater controller and renders the global update prompt", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);

    await flushPromises();

    expect(appUpdateStartMock).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="update-install"]').text()).toBe("app.update.install");
    await wrapper.get('[data-testid="update-install"]').trigger("click");
    expect(appUpdateMock.install).toHaveBeenCalledTimes(1);
    await wrapper.get('[data-testid="update-dismiss"]').trigger("click");
    expect(appUpdateMock.dismiss).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(appUpdateMock.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the updater controller when the app unmounts", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);

    await flushPromises();
    wrapper.unmount();

    expect(appUpdateMock.dispose).toHaveBeenCalledTimes(1);
  });
  it("auto-imports an incoming transfer as soon as it is received", async () => {
    dbSelectMock.mockResolvedValue([]);
    const wrapper = await mountApp(SidebarWithRepoStub);

    await flushPromises();
    const handler = listenHandlers.get("transfer-request");
    expect(handler).toBeTypeOf("function");

    await handler?.(buildIncomingTransferEvent());
    await flushPromises();

    expect(store.recordIncomingTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "transfer-1",
        sourcePeerId: "peer-source",
      }),
    );
    expect(store.approveIncomingTransfer).toHaveBeenCalledWith("transfer-1");
    expect(wrapper.text()).not.toContain("peer-source");
  });

  it("auto-imports any pending incoming transfer on mount", async () => {
    dbSelectMock.mockResolvedValue([
      {
        ...buildPendingIncomingTransferRow(),
        id: "transfer-db-1",
      },
    ]);
    dbMock.execute.mockResolvedValueOnce({ rowsAffected: 1 });

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(store.approveIncomingTransfer).toHaveBeenCalledWith("transfer-db-1");
    expect(dbMock.execute).toHaveBeenCalledWith(
      expect.stringContaining("status = 'streaming'"),
      ["transfer-db-1"],
    );
    expect(wrapper.text()).not.toContain("peer-source");
  });

  it("does not auto-import the same pending transfer twice across restored windows", async () => {
    dbSelectMock.mockResolvedValue([
      {
        ...buildPendingIncomingTransferRow(),
        id: "transfer-db-1",
      },
    ]);
    dbMock.execute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({ rowsAffected: 0 });

    const first = await mountApp(SidebarWithRepoStub);
    const second = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(store.approveIncomingTransfer).toHaveBeenCalledTimes(1);
    expect(store.approveIncomingTransfer).toHaveBeenCalledWith("transfer-db-1");

    first.unmount();
    second.unmount();
  });

  it("marks malformed pending incoming transfers failed instead of retrying on startup", async () => {
    dbSelectMock.mockResolvedValue([
      {
        id: "transfer-bad",
        source_peer_id: null,
        source_task_id: "task-source",
        payload_json: JSON.stringify(buildIncomingTransferEvent().payload.payload),
      },
    ]);
    dbMock.execute.mockResolvedValueOnce({ rowsAffected: 1 });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(store.approveIncomingTransfer).not.toHaveBeenCalled();
    expect(dbMock.execute).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      [expect.stringContaining("missing source_peer_id"), "transfer-bad"],
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[App] disabled malformed pending incoming transfer:",
      expect.objectContaining({
        transferId: "transfer-bad",
        reason: expect.stringContaining("missing source_peer_id"),
      }),
    );

    warnSpy.mockRestore();
    wrapper.unmount();
  });

  it("marks stale pending incoming transfers failed when sidecar finalization cannot resume", async () => {
    dbSelectMock.mockResolvedValue([
      {
        ...buildPendingIncomingTransferRow(),
        id: "transfer-stale",
      },
    ]);
    dbMock.execute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({ rowsAffected: 1 });
    store.approveIncomingTransfer.mockRejectedValueOnce(
      new Error("protocol error: missing source peer for outgoing transfer finalization transfer-stale"),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(store.approveIncomingTransfer).toHaveBeenCalledWith("transfer-stale");
    expect(dbMock.execute).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      [
        "protocol error: missing source peer for outgoing transfer finalization transfer-stale",
        "transfer-stale",
      ],
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[App] failed to auto-import pending incoming transfer; marked failed:",
      expect.objectContaining({
        transferId: "transfer-stale",
        reason: expect.stringContaining("missing source peer"),
      }),
    );

    warnSpy.mockRestore();
    wrapper.unmount();
  });

  it("forwards outgoing transfer commit events to the store", async () => {
    await mountApp(SidebarWithRepoStub);
    await flushPromises();
    await flushPromises();

    const handler = listenHandlers.get("outgoing-transfer-committed");
    expect(handler).toBeTypeOf("function");

    await handler?.(buildOutgoingTransferCommittedEvent());
    await flushPromises();

    expect(store.handleOutgoingTransferCommitted).toHaveBeenCalledWith({
      transferId: "transfer-1",
      sourceTaskId: "task-source",
      destinationLocalTaskId: "task-imported",
    });
  });

  it("forwards outgoing transfer finalization requests to the store and completes them", async () => {
    await mountApp(SidebarWithRepoStub);
    await flushPromises();
    await flushPromises();

    const handler = listenHandlers.get("outgoing-transfer-finalization-requested");
    expect(handler).toBeTypeOf("function");

    await handler?.(buildOutgoingTransferFinalizationRequestedEvent());
    await flushPromises();

    expect(store.finalizeOutgoingTransfer).toHaveBeenCalledWith("transfer-1");
    expect(invokeMock).toHaveBeenCalledWith("complete_outgoing_transfer_finalization", {
      transferId: "transfer-1",
      payload: expect.any(Object),
      finalizedCleanly: true,
      error: null,
    });
  });

  it("shows the pairing verification code when another machine pairs with this one", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    const handler = listenHandlers.get("pairing-completed");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      type: "pairing_completed",
      peer_id: "peer-1",
      display_name: "Peer 1",
      verification_code: "654321",
    });
    await flushPromises();

    expect(toastInfoMock).toHaveBeenCalledWith(expect.stringContaining("654321"));
    wrapper.unmount();
  });

  it("shows the pairing code on the initiating machine while the target approves", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    const handler = listenHandlers.get("pairing-started");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      type: "pairing_started",
      peer_id: "peer-1",
      display_name: "Peer 1",
      verification_code: "654321",
    });
    await flushPromises();

    expect(toastInfoMock).toHaveBeenCalledWith("Enter code 654321 on Peer 1.");
    wrapper.unmount();
  });

  it("requests the pairing code on the target machine before accepting pairing", async () => {
    const promptMock = vi.fn().mockReturnValue("654321");
    Object.defineProperty(window, "prompt", {
      configurable: true,
      value: promptMock,
    });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "accept_peer_pairing") {
        return { pairingRequestId: args?.pairingRequestId };
      }
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    const handler = listenHandlers.get("pairing-requested");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      type: "pairing_requested",
      request_id: "incoming-pair-1",
      peer_id: "peer-1",
      display_name: "Peer 1",
      verification_code: "654321",
    });
    await flushPromises();

    expect(promptMock).toHaveBeenCalledWith("Enter pairing code for Peer 1");
    expect(invokeMock).toHaveBeenCalledWith("accept_peer_pairing", {
      pairingRequestId: "incoming-pair-1",
      verificationCode: "654321",
    });
    expect(invokeMock.mock.calls.some(([command]) => command === "reject_peer_pairing")).toBe(false);
    expect(toastInfoMock).toHaveBeenCalledWith(expect.stringContaining("654321"));
    Reflect.deleteProperty(window, "prompt");
    wrapper.unmount();
  });

  it("rejects an incoming pairing request when the target enters the wrong code", async () => {
    const promptMock = vi.fn().mockReturnValue("000000");
    Object.defineProperty(window, "prompt", {
      configurable: true,
      value: promptMock,
    });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "reject_peer_pairing") {
        return { pairingRequestId: args?.pairingRequestId };
      }
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    const handler = listenHandlers.get("pairing-requested");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      type: "pairing_requested",
      request_id: "incoming-pair-2",
      peer_id: "peer-2",
      display_name: "Peer 2",
      verification_code: "654321",
    });
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("reject_peer_pairing", {
      pairingRequestId: "incoming-pair-2",
    });
    expect(invokeMock.mock.calls.some(([command]) => command === "accept_peer_pairing")).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("Pairing code did not match.");
    Reflect.deleteProperty(window, "prompt");
    wrapper.unmount();
  });

  it("adds Push to Machine to command palette commands for active tasks", async () => {
    store.currentItem = {
      id: "task-1",
      stage: "in progress",
      branch: "task-1",
      prompt: "Fix handoff",
      tags: "[]",
    };

    const CommandPaletteModalStub = defineComponent({
      name: "CommandPaletteModal",
      props: {
        dynamicCommands: {
          type: Array,
          default: () => [],
        },
      },
      setup(props) {
        const labels = computed(() =>
          (props.dynamicCommands as Array<{ label: string }>).map((command) => command.label).join("|"),
        );
        return { labels };
      },
      template: `
        <div data-testid="command-palette">
          {{ labels }}
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      CommandPaletteModal: CommandPaletteModalStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.commandPalette();
    await flushPromises();

    expect(wrapper.get('[data-testid="command-palette"]').text()).toContain("taskTransfer.pushToMachine");
  });

  it("warns instead of silently ignoring Cmd+J for remote tasks", async () => {
    store.repos = [];
    store.selectedRepoId = "cloud:repo-remote";
    store.selectedItemId = "cloud:repo-remote:task-1";
    store.selectedRepo = null;
    store.currentItem = null;
    cloudTasksMock.mockResolvedValue({
      repos: [{
        id: "cloud:repo-remote",
        path: "cloud",
        name: "remote-repo",
        remote_url: "git@github.com:owner/remote-repo.git",
        remoteUrlHash: "remote-hash",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: "2026-05-01T00:00:00.000Z",
        last_opened_at: "2026-05-01T00:00:00.000Z",
      }],
      items: [{
        id: "cloud:repo-remote:task-1",
        repo_id: "cloud:repo-remote",
        issue_number: null,
        issue_title: null,
        prompt: "Fix remote shell",
        pipeline: "cloud",
        stage: "in progress",
        stage_result: null,
        active_post_action: null,
        tags: JSON.stringify(["in progress"]),
        pr_number: null,
        pr_url: null,
        branch: "task-1",
        closed_at: null,
        agent_type: "pty",
        agent_provider: "claude",
        activity: "idle",
        activity_changed_at: "2026-05-01T00:00:00.000Z",
        unread_at: null,
        port_offset: null,
        display_name: "Remote task",
        last_output_preview: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        base_ref: "main",
        agent_session_id: null,
        previous_stage: null,
        teardown_started_at: null,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      }],
      terminalRefs: {
        "cloud:repo-remote:task-1": {
          ownerDesktopId: "peer-primary",
          ownerLocalTaskId: "task-1",
          transport: "cloud",
        },
      },
    });

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();
    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.openShell();
    await flushPromises();

    expect(toastWarningMock).toHaveBeenCalledWith("toasts.remoteShellUnavailable");
    expect(wrapper.findComponent({ name: "ShellModal" }).exists()).toBe(false);
  });

  it("adds Pair Machine to command palette commands independently of task transfer", async () => {
    store.currentItem = null;

    const CommandPaletteModalStub = defineComponent({
      name: "CommandPaletteModal",
      props: {
        dynamicCommands: {
          type: Array,
          default: () => [],
        },
      },
      setup(props) {
        const labels = computed(() =>
          (props.dynamicCommands as Array<{ label: string }>).map((command) => command.label).join("|"),
        );
        return { labels };
      },
      template: `
        <div data-testid="command-palette">
          {{ labels }}
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      CommandPaletteModal: CommandPaletteModalStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.commandPalette();
    await flushPromises();

    expect(wrapper.get('[data-testid="command-palette"]').text()).toContain("taskTransfer.pairPeer");
  });

  it("adds Create Config to command palette commands and launches a config-factory task", async () => {
    store.currentItem = null;

    const CommandPaletteModalStub = defineComponent({
      name: "CommandPaletteModal",
      props: {
        dynamicCommands: {
          type: Array,
          default: () => [],
        },
      },
      template: `
        <div data-testid="command-palette">
          <button
            v-for="command in dynamicCommands"
            :key="command.id"
            type="button"
            :data-command-id="command.id"
            :data-command-description="command.description"
            @click="command.execute()"
          >
            {{ command.label }}
          </button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      CommandPaletteModal: CommandPaletteModalStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.commandPalette();
    await flushPromises();

    const createConfigButton = wrapper.get('[data-command-id="create-config"]');
    expect(createConfigButton.text()).toBe("Create Config");
    expect(createConfigButton.attributes("data-command-description")).toBe("Create or update .kanna/config.json");

    await createConfigButton.trigger("click");
    await flushPromises();

    expect(store.loadAgent).toHaveBeenCalledWith("/tmp/repo", "config-factory");
    expect(store.createItem).toHaveBeenCalledWith(
      "repo-1",
      "/tmp/repo",
      "Help me create or update the .kanna/config.json for this repository.",
      "pty",
      expect.objectContaining({
        agentProvider: "codex",
        customTask: expect.objectContaining({
          agent: "config-factory",
          name: "Create Config",
          prompt: expect.stringContaining("https://schemas.kanna.build/config.schema.json"),
        }),
      }),
    );
  });

  it("keeps loading transfer peers until discovery has had time to warm up", async () => {
    vi.useFakeTimers();
    let listTransferPeersCalls = 0;
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      if (command === "list_transfer_peers") {
        listTransferPeersCalls += 1;
        if (listTransferPeersCalls < 9) return [];
        return [{
          peer_id: "peer-remote",
          display_name: "Desk",
          trusted: false,
          accepting_transfers: true,
        }];
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const CommandPaletteModalStub = defineComponent({
      name: "CommandPaletteModal",
      props: {
        dynamicCommands: {
          type: Array,
          default: () => [],
        },
      },
      template: `
        <div data-testid="command-palette">
          <button
            v-for="command in dynamicCommands"
            :key="command.id"
            type="button"
            @click="command.execute()"
          >
            {{ command.label }}
          </button>
        </div>
      `,
    });

    const PeerPickerModalStub = defineComponent({
      name: "PeerPickerModal",
      props: {
        peers: {
          type: Array,
          default: () => [],
        },
        loading: Boolean,
      },
      template: `
        <div data-testid="peer-picker">
          <span data-testid="peer-picker-loading">{{ loading }}</span>
          <span data-testid="peer-picker-peers">{{ peers.map((peer) => peer.name).join("|") }}</span>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      CommandPaletteModal: CommandPaletteModalStub,
      PeerPickerModal: PeerPickerModalStub,
    });

    await flushPromises();
    capturedKeyboardActions?.commandPalette();
    await flushPromises();

    const pairButton = wrapper.findAll('[data-testid="command-palette"] button')
      .find((button) => button.text() === "taskTransfer.pairPeer");
    if (!pairButton) {
      throw new Error("Pair Machine command was not rendered");
    }

    await pairButton.trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="peer-picker-loading"]').text()).toBe("true");
    expect(wrapper.get('[data-testid="peer-picker-peers"]').text()).toBe("");

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(wrapper.get('[data-testid="peer-picker-loading"]').text()).toBe("true");
    expect(wrapper.get('[data-testid="peer-picker-peers"]').text()).toBe("");

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(wrapper.get('[data-testid="peer-picker-loading"]').text()).toBe("false");
    expect(wrapper.get('[data-testid="peer-picker-peers"]').text()).toContain("Desk");

    vi.useRealTimers();
  });

  it("keeps Pair Machine pending while the pairing request is in flight and ignores duplicate selections", async () => {
    store.currentItem = null;
    const pairing = createDeferred<unknown>();
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      if (command === "list_transfer_peers") {
        return [{
          peer_id: "peer-remote",
          display_name: "Desk",
          trusted: false,
          accepting_transfers: true,
        }];
      }
      if (command === "start_peer_pairing") return pairing.promise;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const CommandPaletteModalStub = defineComponent({
      name: "CommandPaletteModal",
      props: {
        dynamicCommands: {
          type: Array,
          default: () => [],
        },
      },
      template: `
        <div data-testid="command-palette">
          <button
            v-for="command in dynamicCommands"
            :key="command.id"
            type="button"
            @click="command.execute()"
          >
            {{ command.label }}
          </button>
        </div>
      `,
    });

    const PeerPickerModalStub = defineComponent({
      name: "PeerPickerModal",
      props: {
        actionPending: Boolean,
      },
      emits: ["select"],
      template: `
        <div data-testid="peer-picker">
          <span data-testid="peer-picker-pending">{{ actionPending }}</span>
          <button
            data-testid="peer-picker-select-twice"
            type="button"
            @click="$emit('select', 'peer-remote'); $emit('select', 'peer-remote')"
          >
            select twice
          </button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      CommandPaletteModal: CommandPaletteModalStub,
      PeerPickerModal: PeerPickerModalStub,
    });

    await flushPromises();
    capturedKeyboardActions?.commandPalette();
    await flushPromises();

    const pairButton = wrapper.findAll('[data-testid="command-palette"] button')
      .find((button) => button.text() === "taskTransfer.pairPeer");
    if (!pairButton) {
      throw new Error("Pair Machine command was not rendered");
    }

    await pairButton.trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="peer-picker-pending"]').text()).toBe("false");

    await wrapper.get('[data-testid="peer-picker-select-twice"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="peer-picker-pending"]').text()).toBe("true");
    expect(invokeMock.mock.calls.filter(([command]) => command === "start_peer_pairing")).toHaveLength(1);

    pairing.resolve({
      peer: {
        peer_id: "peer-remote",
        display_name: "Desk",
        trusted: true,
        accepting_transfers: true,
      },
      verification_code: "ABC123",
    });
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('[data-testid="peer-picker"]').exists()).toBe(false);
  });

  it("keeps Push to Machine pending while transfer push is in flight and ignores duplicate selections", async () => {
    store.currentItem = {
      id: "task-1",
      stage: "in progress",
      branch: "task-1",
      prompt: "Fix handoff",
      tags: "[]",
    };
    const push = createDeferred<void>();
    store.pushTaskToPeer.mockImplementation(() => push.promise);
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return true;
      if (command === "list_transfer_peers") {
        return [{
          peer_id: "peer-remote",
          display_name: "Desk",
          trusted: true,
          accepting_transfers: true,
        }];
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const CommandPaletteModalStub = defineComponent({
      name: "CommandPaletteModal",
      props: {
        dynamicCommands: {
          type: Array,
          default: () => [],
        },
      },
      template: `
        <div data-testid="command-palette">
          <button
            v-for="command in dynamicCommands"
            :key="command.id"
            type="button"
            @click="command.execute()"
          >
            {{ command.label }}
          </button>
        </div>
      `,
    });

    const PeerPickerModalStub = defineComponent({
      name: "PeerPickerModal",
      props: {
        actionPending: Boolean,
      },
      emits: ["select"],
      template: `
        <div data-testid="peer-picker">
          <span data-testid="peer-picker-pending">{{ actionPending }}</span>
          <button
            data-testid="peer-picker-select-twice"
            type="button"
            @click="$emit('select', 'peer-remote'); $emit('select', 'peer-remote')"
          >
            select twice
          </button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      CommandPaletteModal: CommandPaletteModalStub,
      PeerPickerModal: PeerPickerModalStub,
    });

    await flushPromises();
    capturedKeyboardActions?.commandPalette();
    await flushPromises();

    const pushButton = wrapper.findAll('[data-testid="command-palette"] button')
      .find((button) => button.text() === "taskTransfer.pushToMachine");
    if (!pushButton) {
      throw new Error("Push to Machine command was not rendered");
    }

    await pushButton.trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="peer-picker-pending"]').text()).toBe("false");

    await wrapper.get('[data-testid="peer-picker-select-twice"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="peer-picker-pending"]').text()).toBe("true");
    expect(store.pushTaskToPeer).toHaveBeenCalledTimes(1);
    expect(store.pushTaskToPeer).toHaveBeenCalledWith("task-1", "peer-remote");

    push.resolve();
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('[data-testid="peer-picker"]').exists()).toBe(false);
  });

  it("does not render the footer action bar for the current task view", async () => {
    store.currentItem = {
      id: "task-1",
      stage: "in progress",
      branch: "task-1",
      prompt: "Fix handoff",
      tags: "[]",
    };

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(wrapper.find(".action-bar").exists()).toBe(false);
  });

  it("dismiss closes the entire file flow after preview-local dismiss is exhausted", async () => {
    vi.stubGlobal("__KANNA_MOBILE__", false);
    const { default: App } = await import("./App.vue");
    const wrapper = mount(App, {
      global: {
        provide: {
          db: dbMock,
          dbName: "test.db",
        },
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          Sidebar: SidebarWithRepoStub,
          MainPanel: true,
          AddRepoModal: true,
          KeyboardShortcutsModal: true,
          FilePickerModal: FilePickerModalTestStub,
          FilePreviewModal: FilePreviewModalTestStub,
          TreeExplorerModal: true,
          DiffModal: true,
          CommitGraphModal: true,
          ShellModal: true,
          CommandPaletteModal: true,
          AnalyticsModal: true,
          BlockerSelectModal: true,
          PreferencesPanel: true,
          ToastContainer: true,
          KeepAlive: false,
        },
      },
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.openFile();
    await flushPromises();
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(true);

    await wrapper.get('[data-testid="file-picker-select"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(true);

    const handled = capturedKeyboardActions?.dismiss();
    await flushPromises();

    expect(handled).toBe(true);
    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(false);
  });

  it("recalls the last previewed file with the file preview shortcut after dismissal", async () => {
    vi.stubGlobal("__KANNA_MOBILE__", false);
    const { default: App } = await import("./App.vue");
    const wrapper = mount(App, {
      global: {
        provide: {
          db: dbMock,
          dbName: "test.db",
        },
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          Sidebar: SidebarWithRepoStub,
          MainPanel: true,
          AddRepoModal: true,
          KeyboardShortcutsModal: true,
          FilePickerModal: FilePickerModalTestStub,
          FilePreviewModal: FilePreviewModalTestStub,
          TreeExplorerModal: true,
          DiffModal: true,
          CommitGraphModal: true,
          ShellModal: true,
          CommandPaletteModal: true,
          AnalyticsModal: true,
          BlockerSelectModal: true,
          PreferencesPanel: true,
          ToastContainer: true,
          KeepAlive: false,
        },
      },
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.openFile();
    await flushPromises();
    await wrapper.get('[data-testid="file-picker-select"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);

    capturedKeyboardActions?.dismiss();
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(false);

    capturedKeyboardActions?.toggleFilePreview();
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(false);
  });

  it("keeps recalled file previews scoped to the selected task", async () => {
    store.currentItem = {
      id: "task-a",
      stage: "in progress",
      branch: "task-a",
      prompt: "Task A",
      tags: "[]",
    };
    store.selectedItemId = "task-a";

    const TaskAwareFilePickerModalTestStub = defineComponent({
      name: "FilePickerModal",
      emits: ["select"],
      template: `
        <div data-testid="file-picker-modal">
          <button data-testid="file-picker-select-a" @click="$emit('select', 'src/task-a.ts')">task a</button>
          <button data-testid="file-picker-select-b" @click="$emit('select', 'src/task-b.ts')">task b</button>
        </div>
      `,
    });

    const FilePathPreviewModalTestStub = defineComponent({
      name: "FilePreviewModal",
      props: {
        filePath: {
          type: String,
          required: true,
        },
      },
      emits: ["close"],
      setup(_props, { emit, expose }) {
        function dismiss() {
          emit("close");
          return true;
        }

        expose({ dismiss, zIndex: 1000, bringToFront: vi.fn() });

        return {};
      },
      template: `
        <div data-testid="file-preview-modal" :data-file-path="filePath">
          <button data-testid="file-preview-close" @click="$emit('close')">close</button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      FilePickerModal: TaskAwareFilePickerModalTestStub,
      FilePreviewModal: FilePathPreviewModalTestStub,
    });

    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.openFile();
    await flushPromises();
    await wrapper.get('[data-testid="file-picker-select-a"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="file-preview-modal"]').attributes("data-file-path")).toBe("src/task-a.ts");

    capturedKeyboardActions?.dismiss();
    await flushPromises();

    store.currentItem = {
      id: "task-b",
      stage: "in progress",
      branch: "task-b",
      prompt: "Task B",
      tags: "[]",
    };
    store.selectedItemId = "task-b";

    capturedKeyboardActions?.toggleFilePreview();
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(true);

    await wrapper.get('[data-testid="file-picker-select-b"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="file-preview-modal"]').attributes("data-file-path")).toBe("src/task-b.ts");

    capturedKeyboardActions?.dismiss();
    await flushPromises();

    store.currentItem = {
      id: "task-a",
      stage: "in progress",
      branch: "task-a",
      prompt: "Task A",
      tags: "[]",
    };
    store.selectedItemId = "task-a";

    capturedKeyboardActions?.toggleFilePreview();
    await flushPromises();

    expect(wrapper.get('[data-testid="file-preview-modal"]').attributes("data-file-path")).toBe("src/task-a.ts");
  });

  it("preserves file preview component state when hiding and showing the last preview", async () => {
    const MarkdownFilePickerModalTestStub = defineComponent({
      name: "FilePickerModal",
      emits: ["select"],
      template: `
        <div data-testid="file-picker-modal">
          <button data-testid="file-picker-select" @click="$emit('select', 'docs/example.md')">select</button>
        </div>
      `,
    });

    const StatefulFilePreviewModalTestStub = defineComponent({
      name: "FilePreviewModal",
      emits: ["close"],
      setup(_props, { emit, expose }) {
        const mode = ref("raw");

        function dismiss() {
          emit("close");
          return true;
        }

        expose({ dismiss, zIndex: 1000, bringToFront: vi.fn() });

        return { mode };
      },
      template: `
        <div data-testid="file-preview-modal" :data-mode="mode">
          <button data-testid="toggle-markdown-render" @click="mode = 'rendered'">rendered</button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      FilePickerModal: MarkdownFilePickerModalTestStub,
      FilePreviewModal: StatefulFilePreviewModalTestStub,
    });

    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.openFile();
    await flushPromises();
    await wrapper.get('[data-testid="file-picker-select"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-testid="toggle-markdown-render"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="file-preview-modal"]').attributes("data-mode")).toBe("rendered");

    capturedKeyboardActions?.toggleFilePreview();
    await flushPromises();
    capturedKeyboardActions?.toggleFilePreview();
    await flushPromises();

    expect(wrapper.get('[data-testid="file-preview-modal"]').attributes("data-mode")).toBe("rendered");
  });

  it("remembers markdown render mode when reopening a preview window", async () => {
    const MarkdownFilePickerModalTestStub = defineComponent({
      name: "FilePickerModal",
      emits: ["select"],
      template: `
        <div data-testid="file-picker-modal">
          <button data-testid="file-picker-select" @click="$emit('select', 'docs/example.md')">select</button>
        </div>
      `,
    });

    const MarkdownModeFilePreviewModalTestStub = defineComponent({
      name: "FilePreviewModal",
      props: {
        initialMarkdownMode: {
          type: String,
          default: "raw",
        },
      },
      emits: ["close", "update-markdown-mode"],
      setup(_props, { emit, expose }) {
        function dismiss() {
          emit("close");
          return true;
        }

        expose({ dismiss, zIndex: 1000, bringToFront: vi.fn() });

        return { emit };
      },
      template: `
        <div data-testid="file-preview-modal" :data-mode="initialMarkdownMode">
          <button data-testid="toggle-markdown-render" @click="emit('update-markdown-mode', 'rendered')">rendered</button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      FilePickerModal: MarkdownFilePickerModalTestStub,
      FilePreviewModal: MarkdownModeFilePreviewModalTestStub,
    });

    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.openFile();
    await flushPromises();
    await wrapper.get('[data-testid="file-picker-select"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="file-preview-modal"]').attributes("data-mode")).toBe("raw");

    await wrapper.get('[data-testid="toggle-markdown-render"]').trigger("click");
    await flushPromises();

    capturedKeyboardActions?.dismiss();
    await flushPromises();
    capturedKeyboardActions?.toggleFilePreview();
    await flushPromises();

    expect(wrapper.get('[data-testid="file-preview-modal"]').attributes("data-mode")).toBe("rendered");
  });

  it("preserves file picker scroll state when preview hides and resumes the picker", async () => {
    const StatefulFilePickerModalTestStub = defineComponent({
      name: "FilePickerModal",
      emits: ["select"],
      setup(_props, { emit }) {
        const scrollTop = ref(0);

        return { emit, scrollTop };
      },
      template: `
        <div data-testid="file-picker-modal" :data-scroll-top="String(scrollTop)">
          <button data-testid="file-picker-scroll" @click="scrollTop = 320">scroll</button>
          <button data-testid="file-picker-select" @click="emit('select', 'docs/example.md')">select</button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      FilePickerModal: StatefulFilePickerModalTestStub,
      FilePreviewModal: FilePreviewModalTestStub,
    });

    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.openFile();
    await flushPromises();
    await wrapper.get('[data-testid="file-picker-scroll"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="file-picker-modal"]').attributes("data-scroll-top")).toBe("320");

    await wrapper.get('[data-testid="file-picker-select"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(true);

    await wrapper.get('[data-testid="file-preview-close"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="file-picker-modal"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-testid="file-picker-modal"]').attributes("data-scroll-top")).toBe("320");
  });

  it("opens the file picker over the file preview and dismisses the picker first", async () => {
    vi.stubGlobal("__KANNA_MOBILE__", false);
    const { default: App } = await import("./App.vue");
    const wrapper = mount(App, {
      global: {
        provide: {
          db: dbMock,
          dbName: "test.db",
        },
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          Sidebar: SidebarWithRepoStub,
          MainPanel: true,
          AddRepoModal: true,
          KeyboardShortcutsModal: true,
          FilePickerModal: FilePickerModalTestStub,
          FilePreviewModal: FilePreviewModalTestStub,
          TreeExplorerModal: true,
          DiffModal: true,
          CommitGraphModal: true,
          ShellModal: true,
          CommandPaletteModal: true,
          AnalyticsModal: true,
          BlockerSelectModal: true,
          PreferencesPanel: true,
          ToastContainer: true,
          KeepAlive: false,
        },
      },
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.openFile();
    await flushPromises();
    await wrapper.get('[data-testid="file-picker-select"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(true);

    capturedKeyboardActions?.openFile();
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(true);

    const handled = capturedKeyboardActions?.dismiss();
    await flushPromises();

    expect(handled).toBe(true);
    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="file-picker-modal"]').exists()).toBe(false);
  });

  it("dismiss closes commit graph search before closing the commit graph modal", async () => {
    const dismissMock = vi.fn(() => false);
    const CommitGraphModalTestStub = defineComponent({
      setup(_props, { expose }) {
        expose({
          dismiss: dismissMock,
          zIndex: 1,
          bringToFront: vi.fn(),
        });
        return () => h("div", { "data-testid": "commit-graph-modal" });
      },
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      CommitGraphModal: CommitGraphModalTestStub,
    });
    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.showCommitGraph();
    await flushPromises();

    expect(wrapper.find('[data-testid="commit-graph-modal"]').exists()).toBe(true);

    const handled = capturedKeyboardActions?.dismiss();
    await flushPromises();

    expect(handled).toBe(true);
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="commit-graph-modal"]').exists()).toBe(true);
  });

  it("passes maximize state through to the tree explorer modal", async () => {
    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      TreeExplorerModal: TreeExplorerModalTestStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.toggleTreeExplorer();
    await flushPromises();

    expect(wrapper.get('[data-testid="tree-explorer-modal"]').attributes("data-maximized")).toBe("false");

    capturedKeyboardActions?.toggleMaximize();
    await flushPromises();

    expect(wrapper.get('[data-testid="tree-explorer-modal"]').attributes("data-maximized")).toBe("true");
  });

  it("suspends and resumes the tree explorer while a file preview opened from it is active", async () => {
    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      TreeExplorerModal: TreeExplorerModalTestStub,
      FilePreviewModal: FilePreviewModalTestStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.toggleTreeExplorer();
    await flushPromises();

    expect(wrapper.get('[data-testid="tree-explorer-modal"]').attributes("data-suspended")).toBe("false");

    await wrapper.get('[data-testid="tree-open-file"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="tree-explorer-modal"]').attributes("data-suspended")).toBe("true");

    await wrapper.get('[data-testid="file-preview-close"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="tree-explorer-modal"]').attributes("data-suspended")).toBe("false");
  });

  it("keeps the tree explorer available while a file preview opened from the picker is active", async () => {
    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      TreeExplorerModal: TreeExplorerModalTestStub,
      FilePickerModal: FilePickerModalTestStub,
      FilePreviewModal: FilePreviewModalTestStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.toggleTreeExplorer();
    await flushPromises();

    capturedKeyboardActions?.openFile();
    await flushPromises();
    await wrapper.get('[data-testid="file-picker-select"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="file-preview-modal"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="tree-explorer-modal"]').attributes("data-suspended")).toBe("false");
  });

  it("clears tree explorer maximize state when the modal closes", async () => {
    const TreeExplorerClosableStub = defineComponent({
      name: "TreeExplorerModal",
      props: {
        maximized: Boolean,
      },
      emits: ["close"],
      template: `
        <div data-testid="tree-explorer-modal" :data-maximized="String(maximized)">
          <button data-testid="close-tree-explorer" @click="$emit('close')">close</button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      TreeExplorerModal: TreeExplorerClosableStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.toggleTreeExplorer();
    await flushPromises();
    capturedKeyboardActions?.toggleMaximize();
    await flushPromises();

    expect(wrapper.get('[data-testid="tree-explorer-modal"]').attributes("data-maximized")).toBe("true");

    await wrapper.get('[data-testid="close-tree-explorer"]').trigger("click");
    await flushPromises();
    capturedKeyboardActions?.toggleTreeExplorer();
    await flushPromises();

    expect(wrapper.get('[data-testid="tree-explorer-modal"]').attributes("data-maximized")).toBe("false");
  });

  it("lets the tree explorer consume dismiss before closing it", async () => {
    const treeDismissMock = vi.fn(() => false);
    const TreeExplorerDismissStub = defineComponent({
      name: "TreeExplorerModal",
      setup(_props, { expose }) {
        expose({
          dismiss: treeDismissMock,
          zIndex: 1,
          bringToFront: vi.fn(),
        });
        return () => h("div", { "data-testid": "tree-explorer-modal" });
      },
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      TreeExplorerModal: TreeExplorerDismissStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.toggleTreeExplorer();
    await flushPromises();

    const handled = capturedKeyboardActions?.dismiss();
    await flushPromises();

    expect(handled).toBe(true);
    expect(treeDismissMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="tree-explorer-modal"]').exists()).toBe(true);
  });
});
