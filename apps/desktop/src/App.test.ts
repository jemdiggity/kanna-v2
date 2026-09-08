// @vitest-environment happy-dom

import { computed, defineComponent, h, nextTick, reactive, ref } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardActions } from "./composables/useKeyboardShortcuts";
import type { ModalTearOffContext } from "./modalTearOff";
import type { PipelineItem } from "./types/kanna";
import type { TaskUiSlot } from "./types/taskUi";
import {
  WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
} from "./windowWorkspace";
import type { DesktopCloudSnapshot } from "./services/desktopCloudTaskIndex";
import { DesktopCloudCredentialConflictError } from "./services/desktopCloudCredentialConflict";
import { updateDesktopServerClientHandlersForTests } from "./services/desktopServerClient";

async function flushPromises() {
  await Promise.resolve();
  await nextTick();
}

async function waitForNativeCloseRequestedHandler() {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (closeRequestedHandler) return closeRequestedHandler;
    await flushPromises();
  }
  return closeRequestedHandler;
}

async function waitForCondition(predicate: () => boolean, attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await flushPromises();
  }
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

function readyTaskSlot(slotId: string, task: { id: string; repo_id: string; [key: string]: unknown }): TaskUiSlot {
  const workflowTask = task as unknown as PipelineItem;
  return {
    slot_id: slotId,
    task_id: task.id,
    state: "ready",
    task: workflowTask,
    draft: {
      repo_id: task.repo_id,
      prompt: workflowTask.prompt ?? "",
      display_name: workflowTask.display_name ?? null,
      workflow: workflowTask.pipeline ?? "default",
      stage: workflowTask.stage ?? "in progress",
      agent_type: workflowTask.agent_type === "agent" || workflowTask.agent_type === "sdk" ? "agent" : "pty",
      agent_provider: workflowTask.agent_provider ?? "claude",
      created_at: workflowTask.created_at ?? "2026-01-01T00:00:00.000Z",
    },
  };
}

const listenHandlers = new Map<string, (event: unknown) => void | Promise<void>>();
const currentWebviewWindowListenHandlers = new Map<string, (event: unknown) => void | Promise<void>>();
let closeRequestedHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | null = null;
const nativeCloseRegistrationHarness = {
  error: null as Error | null,
};
const nativeWindowDestroyMock = vi.fn(async () => {});

function dispatchNativeCloseRequest() {
  const event = { preventDefault: vi.fn() };
  const handler = closeRequestedHandler;
  const completion = (async () => {
    if (handler) await handler(event);
    if (!handler || event.preventDefault.mock.calls.length === 0) {
      await nativeWindowDestroyMock();
    }
  })();
  return { completion, event };
}
const cloudTasksMock = vi.hoisted(() => vi.fn(async () => ({ repos: [], items: [] })));
const desktopCloudTaskSnapshotListeners = vi.hoisted(
  () => new Set<(snapshot: DesktopCloudSnapshot) => void>(),
);
const subscribeDesktopCloudTasksMock = vi.hoisted(() =>
  vi.fn((_uid: string, onSnapshot: (snapshot: DesktopCloudSnapshot) => void) => {
    desktopCloudTaskSnapshotListeners.add(onSnapshot);
    onSnapshot({
      repos: [],
      items: [],
      terminalRefs: {},
      blockedByTaskIds: {},
      transferMachines: [],
    });
    return () => desktopCloudTaskSnapshotListeners.delete(onSnapshot);
  }),
);
const associateDesktopCloudCredentialMock = vi.hoisted(() => vi.fn(async () => {}));
const desktopAuthStateListeners = vi.hoisted(() => new Set<(state: unknown) => void>());
const scheduleStartupBackupMock = vi.hoisted(() => vi.fn(async () => {}));
const nativeSetThemeMock = vi.hoisted(() => vi.fn(async () => {}));
const nativeWindowSetThemeMock = vi.hoisted(() => vi.fn(async () => {}));
const relayAdvanceStageMock = vi.hoisted(() => vi.fn(async () => {}));
const relayCloseTaskMock = vi.hoisted(() => vi.fn(async () => {}));
const relayMarkTaskReadMock = vi.hoisted(() => vi.fn(async () => {}));
const relayCloseMock = vi.hoisted(() => vi.fn());
const lanAdvanceStageMock = vi.hoisted(() => vi.fn(async () => {}));
const lanMarkTaskReadMock = vi.hoisted(() => vi.fn(async () => {}));
const lanCloseMock = vi.hoisted(() => vi.fn());
const relayTerminalClientFactoryMock = vi.hoisted(() => vi.fn());
const lanTerminalClientFactoryMock = vi.hoisted(() => vi.fn());
const lanTasksMock = vi.hoisted(() =>
  vi.fn(async () => ({ repos: [], items: [], terminalRefs: {}, transferMachines: [] })),
);
const openLatestTerminalFileLinkMock = vi.hoisted(() => vi.fn(async () => true));
const dbSelectMock = vi.fn(async () => []);
const dbMock = {
  select: dbSelectMock,
  execute: vi.fn(async () => ({ rowsAffected: 0 })),
};

const store = {
  repos: [{ id: "repo-1", path: "/tmp/repo", name: "repo" }],
  items: [],
  taskUiSlots: [] as TaskUiSlot[],
  selectedRepoId: "repo-1" as string | null,
  selectedItemId: null,
  selectedTaskId: null as string | null,
  selectedRepo: { id: "repo-1", path: "/tmp/repo", name: "repo" } as { id: string; path: string; name: string } | null,
  currentItem: null,
  currentTaskSlot: null as TaskUiSlot | null,
  sortedItemsForCurrentRepo: [],
  sortedItemsAllRepos: [],
  taskBlockers: [] as Array<{ blocked_item_id: string; blocker_item_id: string }>,
  repoSidebarOrder: {} as Record<string, number>,
  lastSelectedItemByRepo: {},
  getStageOrder: vi.fn(() => ["in progress", "pr", "merge"]),
  suspendAfterMinutes: 30,
  killAfterMinutes: 60,
  ideCommand: "code",
  devLingerTerminals: false,
  hideShortcutsOnStartup: true,
  appTheme: "dark",
  codeTheme: "match",
  agentMessageAppearance: "chat",
  markdownPreviewMode: "rendered" as "raw" | "rendered",
  init: vi.fn(async () => {}),
  reloadSnapshot: vi.fn(async () => {}),
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
        workflow: "default",
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
  recordSelectionIntent: vi.fn(),
  recordNavigation: vi.fn(),
  takeBackTarget: vi.fn(),
  takeForwardTarget: vi.fn(),
  advanceStage: vi.fn(async () => {}),
  closeTask: vi.fn(async () => true),
  bump: vi.fn(async () => {}),
  pinItem: vi.fn(async () => {}),
  unpinItem: vi.fn(async () => {}),
  reorderPinned: vi.fn(async () => {}),
  reorderRepos: vi.fn(async () => {}),
  renameItem: vi.fn(async () => {}),
  hideRepo: vi.fn(async () => {}),
  spawnPtySession: vi.fn(async () => {}),
  loadAgent: vi.fn(async (_repoId: string, agentName: string) => ({
    prompt: agentName === "setup"
      ? "Configure the GitHub flow by composing stock flavors instead of writing agents from scratch."
      : "Use https://schemas.kanna.build/config.schema.json when writing .kanna/config.json.",
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
    tearOffContext: undefined as ModalTearOffContext | undefined,
  },
  initialize: vi.fn(async () => {}),
  loadSnapshot: vi.fn(async () => ({ windows: [] })),
  saveSnapshot: vi.fn(async () => {}),
  openWindow: vi.fn(async () => {}),
  closeWindow: vi.fn(async () => {}),
  destroyNativeWindow: vi.fn(async () => {}),
  forgetCurrentWindow: vi.fn(async () => null as {
    windowId: string;
    selectedRepoId: string | null;
    selectedItemId: string | null;
    sidebarHidden: boolean;
    sidebarWidth: number;
    order: number;
  } | null),
  restoreCurrentWindow: vi.fn(async () => {}),
  notifyWindowMembershipChanged: vi.fn(async () => {}),
  persistSelection: vi.fn(async () => {}),
  persistSidebarHidden: vi.fn(async () => {}),
  persistSidebarWidth: vi.fn(async () => {}),
  restoreCurrentWindowGeometry: vi.fn(async () => {}),
  startGeometryTracking: vi.fn(async () => vi.fn()),
  invalidateSharedData: vi.fn(async () => {}),
  restoreAdditionalWindows: vi.fn(async () => {}),
  onSharedInvalidation: vi.fn(async () => vi.fn()),
};

let capturedKeyboardActions: KeyboardActions | null = null;

const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === "list_dir") return ["default.json"];
  if (command === "read_text_file") return "";
  if (command === "git_default_branch") return "main";
  if (command === "git_repository_has_commits") return true;
  if (command === "git_repository_state") {
    return { defaultBranch: "main", hasCommits: true };
  }
  if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
  if (command === "read_env_var") return "/Users/test";
  if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      if (nativeCloseRegistrationHarness.error) {
        throw nativeCloseRegistrationHarness.error;
      }
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

vi.mock("@kanna/" + "db", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  listRepos: vi.fn(async () => []),
  listPipelineItems: vi.fn(async () => []),
  listTaskBlockers: vi.fn(async () => []),
  listBlockersForItem: vi.fn(async () => []),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "commandPalette.createAgent": "エージェントを作成",
      "commandPalette.createAgentDesc": "新しいエージェント定義を作成",
      "commandPalette.createWorkflow": "パイプラインを作成",
      "commandPalette.createWorkflowDesc": "新しいパイプライン定義を作成",
      "commandPalette.createConfig": "設定を作成",
      "commandPalette.createConfigDesc": ".kanna/config.json を作成または更新",
      "commandPalette.setupRepo": "リポジトリをセットアップ",
      "commandPalette.setupRepoDesc": ".kanna のパイプラインとエージェントフレーバーを構成",
    }[key] ?? key),
  }),
}));

vi.mock("./i18n", () => ({
  default: {
    global: {
      locale: {
        value: "en",
      },
      t: (key: string) => key,
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

vi.mock("./composables/terminalFileLinkRegistry", () => ({
  openLatestTerminalFileLink: openLatestTerminalFileLinkMock,
}));

vi.mock("./services/desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    getIdToken: vi.fn(async () => "desktop-id-token"),
    subscribe: vi.fn((handler: (state: unknown) => void) => {
      desktopAuthStateListeners.add(handler);
      handler({
        status: "signedIn",
        user: { uid: "user-1", email: "upvote.sieve.7t@icloud.com" },
      });
      return () => desktopAuthStateListeners.delete(handler);
    }),
  })),
}));

vi.mock("./services/desktopCloudTaskIndex", () => ({
  listDesktopCloudTasks: cloudTasksMock,
  mapDesktopCloudTasks: vi.fn((tasks: unknown[]) => ({
    repos: [],
    items: tasks,
    terminalRefs: {},
    blockedByTaskIds: {},
    transferMachines: [],
  })),
  subscribeDesktopCloudTasks: subscribeDesktopCloudTasksMock,
}));

vi.mock("./services/desktopCloudAssociation", () => ({
  associateDesktopCloudCredential: associateDesktopCloudCredentialMock,
}));

vi.mock("./services/desktopLanTaskIndex", () => ({
  listDesktopLanTasks: lanTasksMock,
  publishDesktopLanTaskSnapshot: vi.fn(async () => {}),
}));

vi.mock("./services/desktopRelayTerminal", () => ({
  createConfiguredDesktopRelayTerminalClient: relayTerminalClientFactoryMock,
  createConfiguredDesktopRemoteTaskViewClient: relayTerminalClientFactoryMock,
}));

vi.mock("./services/desktopLanTerminal", () => ({
  createConfiguredDesktopLanTerminalClient: lanTerminalClientFactoryMock,
}));

vi.mock("./composables/useRestoreFocus", () => ({
  useRestoreFocus: vi.fn(),
}));

vi.mock("./composables/useModalZIndex", () => ({
  isTopModal: vi.fn(() => true),
  useModalZIndex: () => ({ zIndex: 1000 }),
}));

const sidebarSearchQuery = ref("");

const SidebarWithRepoStub = defineComponent({
  name: "Sidebar",
  emits: ["new-task"],
  setup(_props, { expose }) {
    expose({ searchQuery: sidebarSearchQuery });
    return {};
  },
  template: '<button data-testid="open-new-task" @click="$emit(\'new-task\', \'repo-1\')">open</button>',
});

const SidebarWithoutRepoStub = defineComponent({
  name: "Sidebar",
  emits: ["new-task"],
  template: '<button data-testid="open-new-task" @click="$emit(\'new-task\')">open</button>',
});

const RemoteTaskSelectionStub = defineComponent({
  name: "Sidebar",
  props: {
    taskSlots: { type: Array, default: () => [] },
  },
  emits: ["select-item"],
  template: `
    <div>
      <button
        v-for="item in taskSlots"
        :key="item.slot_id"
        data-testid="remote-task"
        :data-task-id="item.task_id"
        type="button"
        @click="$emit('select-item', item.slot_id)"
      >
        <span data-testid="remote-task-activity">{{ item.activity }}</span>
      </button>
    </div>
  `,
});

function remoteTaskSnapshot(
  transport: "cloud" | "lan",
  ownerDesktopId: string,
  ownerLocalTaskId: string,
): DesktopCloudSnapshot {
  const repoId = `${transport}:repo-remote`;
  const taskId = `${transport}:repo-remote:task-remote`;
  return {
    repos: [{
      id: repoId,
      path: "cloud",
      name: "Remote Repo",
      default_branch: "main",
      remote_url: null,
      remote_url_hash: null,
      hidden: 0,
      sort_order: 0,
      created_at: "2026-07-24T00:00:00.000Z",
      last_opened_at: "2026-07-24T00:00:00.000Z",
    }],
    items: [{
      id: taskId,
      repo_id: repoId,
      prompt: "Unread remote task",
      workflow: "default",
      pipeline_def: null,
      stage: "in progress",
      pr_number: null,
      pr_url: null,
      branch: "task-remote",
      activity: "unread" as const,
      activity_revision: 7,
      activity_changed_at: "2026-07-24T00:00:00.000Z",
      unread_at: "2026-07-24T00:00:00.000Z",
      port_offset: null,
      port_env: null,
      pinned: 0,
      pin_order: null,
      display_name: "Unread remote task",
      issue_number: null,
      issue_title: null,
      closed_at: null,
      agent_session_id: null,
      base_ref: "origin/main",
      agent_provider: "codex",
      agent_type: "pty",
      teardown_started_at: null,
      last_output_preview: null,
      active_post_action: null,
      parent_task_id: null,
      notify_task_id: null,
      notified_at: null,
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z",
    }],
    terminalRefs: {
      [taskId]: {
        ownerDesktopId,
        ownerLocalRepoId: "owner-repo",
        ownerLocalTaskId,
        transport,
      },
    },
    transferMachines: [],
  };
}

function remoteChildCloseSnapshot(): DesktopCloudSnapshot {
  const snapshot = remoteTaskSnapshot("cloud", "desktop-owner", "task-parent");
  const parent = {
    ...snapshot.items[0],
    id: "cloud:repo-remote:task-parent",
    display_name: "Remote parent",
    created_at: "2026-07-24T00:00:00.000Z",
  };
  const childA = {
    ...snapshot.items[0],
    id: "cloud:repo-remote:task-child-a",
    display_name: "Remote child A",
    parent_task_id: parent.id,
    created_at: "2026-07-24T00:01:00.000Z",
  };
  const childB = {
    ...snapshot.items[0],
    id: "cloud:repo-remote:task-child-b",
    display_name: "Remote child B",
    parent_task_id: parent.id,
    created_at: "2026-07-24T00:02:00.000Z",
  };
  const unrelated = {
    ...snapshot.items[0],
    id: "cloud:repo-remote:task-unrelated",
    display_name: "Unrelated remote task",
    created_at: "2026-07-23T23:59:00.000Z",
  };
  snapshot.items = [parent, childA, childB, unrelated];
  snapshot.terminalRefs = Object.fromEntries(
    [parent, childA, childB, unrelated].map((item) => [
      item.id,
      {
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "owner-repo",
        ownerLocalTaskId: item.id.slice("cloud:repo-remote:".length),
        transport: "cloud" as const,
      },
    ]),
  );
  return snapshot;
}

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
          workflow: "default",
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
    status: "pending" as const,
    source_peer_id: "peer-source",
    source_task_id: "task-source",
    local_task_id: null,
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
      __kannaLifecycleDeliveryId: "lifecycle-commit-1",
      __kannaLifecycleConsumerIncarnation: "consumer-incarnation-test",
    },
  };
}

function buildOutgoingTransferFinalizationRequestedEvent() {
  return {
    payload: {
      type: "outgoing_transfer_finalization_requested",
      transfer_id: "transfer-1",
      __kannaLifecycleDeliveryId: "lifecycle-finalization-1",
      __kannaLifecycleConsumerIncarnation: "consumer-incarnation-test",
    },
  };
}

function buildTaskPullRequestedEvent() {
  return {
    payload: {
      type: "task_pull_requested",
      request_id: "pull-failover-1",
      requester_peer_id: "peer-requester",
      source_task_id: "task-source",
      __kannaLifecycleDeliveryId: "lifecycle-pull-failover-1",
      __kannaLifecycleConsumerIncarnation: "consumer-incarnation-test",
      __kannaLifecycleRecovery: true,
    },
  };
}

function emitDesktopCloudSnapshot(snapshot: DesktopCloudSnapshot): void {
  for (const listener of desktopCloudTaskSnapshotListeners) {
    listener(snapshot);
  }
}

function buildRemoteBlockedWorkflowSnapshot({
  blocked,
  hasRunningPost = false,
  transport = "cloud",
  transitionRevision = "run-blocked-1",
  updatedAt,
}: {
  blocked: boolean;
  hasRunningPost?: boolean;
  transport?: "cloud" | "lan";
  transitionRevision?: string | null;
  updatedAt: string;
}): DesktopCloudSnapshot {
  const repoId = "cloud:repo-remote";
  const blockedTaskId = "cloud:repo-remote:task-blocked";
  const blockerTaskId = "cloud:repo-remote:task-blocker";
  const taskDefaults = {
    repo_id: repoId,
    issue_number: null,
    issue_title: null,
    workflow: "cloud",
    pipeline_def: null,
    stage: "in progress",
    stage_result: null,
    active_post_action: null,
    tags: JSON.stringify(["in progress"]),
    pr_number: null,
    pr_url: null,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "codex",
    activity: "idle",
    activity_changed_at: updatedAt,
    unread_at: null,
    port_offset: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: "origin/main",
    agent_session_id: null,
    previous_stage: null,
    transition_revision: transitionRevision,
    has_running_post: hasRunningPost ? 1 : 0,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: updatedAt,
  } satisfies Partial<PipelineItem>;

  return {
    repos: [{
      id: repoId,
      path: "cloud",
      name: "Remote Repo",
      remote_url: "git@github.com:owner/remote-repo.git",
      remoteUrlHash: "remote-repo-hash",
      default_branch: "main",
      hidden: 0,
      sort_order: 0,
      created_at: "2026-07-25T00:00:00.000Z",
      last_opened_at: "2026-07-25T00:00:00.000Z",
    }],
    items: [
      {
        ...taskDefaults,
        id: blockedTaskId,
        prompt: "Advance the remote task",
        display_name: "Blocked remote task",
        branch: "task-blocked",
      } as PipelineItem,
      {
        ...taskDefaults,
        id: blockerTaskId,
        prompt: "Resolve the remote blocker",
        display_name: "Remote blocker",
        branch: "task-blocker",
      } as PipelineItem,
    ],
    terminalRefs: {
      [blockedTaskId]: {
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "repo-owner",
        ownerLocalTaskId: "task-blocked",
        transport,
      },
      [blockerTaskId]: {
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "repo-owner",
        ownerLocalTaskId: "task-blocker",
        transport,
      },
    },
    blockedByTaskIds: blocked
      ? { [blockedTaskId]: ["task-blocker"] }
      : {},
  };
}

function buildCrossRepoCollidingBlockerSnapshot(): DesktopCloudSnapshot {
  const snapshot = buildRemoteBlockedWorkflowSnapshot({
    blocked: true,
    updatedAt: "2026-07-27T00:00:00.000Z",
  });
  const blockedTask = snapshot.items[0];
  const collidingTask = {
    ...snapshot.items[1],
    id: "cloud:repo-collision:task-blocker",
    repo_id: "cloud:repo-collision",
    display_name: "Resolved task from another repo",
    stage: "pr",
    pr_number: 999,
    pr_url: "https://github.com/kanna/kanna/pull/999",
  };
  return {
    ...snapshot,
    repos: [
      ...snapshot.repos,
      {
        ...snapshot.repos[0],
        id: "cloud:repo-collision",
        name: "Collision Repo",
        remote_url: "git@github.com:owner/collision-repo.git",
        remoteUrlHash: "collision-repo-hash",
      },
    ],
    items: [blockedTask, collidingTask],
    terminalRefs: {
      [blockedTask.id]: {
        ownerDesktopId: "desktop-owner",
        ownerLocalRepoId: "repo-owner",
        ownerLocalTaskId: "task-blocked",
        transport: "cloud",
      },
      [collidingTask.id]: {
        ownerDesktopId: "desktop-collision",
        ownerLocalRepoId: "repo-collision",
        ownerLocalTaskId: "task-blocker",
        transport: "cloud",
      },
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
  for (let attempt = 0; attempt < 20; attempt++) {
    await flushPromises();
  }
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
  for (let attempt = 0; attempt < 10; attempt++) {
    await flushPromises();
  }
  return wrapper;
}

describe("App", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    sidebarSearchQuery.value = "";
    store.init.mockClear();
    store.createItem.mockClear();
    store.createRepo.mockClear();
    store.importRepo.mockClear();
    store.cloneAndImportRepo.mockClear();
    store.recordIncomingTransfer.mockClear();
    store.approveIncomingTransfer.mockClear();
    store.rejectIncomingTransfer.mockClear();
    store.handleOutgoingTransferCommitted.mockClear();
    store.pushTaskToPeer.mockClear();
    store.loadAgent.mockClear();
    store.selectRepo.mockClear();
    store.reloadSnapshot.mockClear();
    store.selectItem.mockClear();
    store.recordNavigation.mockClear();
    store.recordSelectionIntent.mockClear();
    store.takeBackTarget.mockReset();
    store.takeForwardTarget.mockReset();
    store.advanceStage.mockClear();
    relayAdvanceStageMock.mockClear();
    relayCloseTaskMock.mockClear();
    relayMarkTaskReadMock.mockReset();
    relayMarkTaskReadMock.mockResolvedValue(undefined);
    relayCloseMock.mockReset();
    relayCloseMock.mockImplementation(() => {});
    lanMarkTaskReadMock.mockReset();
    lanMarkTaskReadMock.mockResolvedValue(undefined);
    lanAdvanceStageMock.mockReset();
    lanAdvanceStageMock.mockResolvedValue(undefined);
    lanCloseMock.mockReset();
    lanCloseMock.mockImplementation(() => {});
    relayTerminalClientFactoryMock.mockReset();
    relayTerminalClientFactoryMock.mockResolvedValue({
      advanceStage: relayAdvanceStageMock,
      closeTask: relayCloseTaskMock,
      markTaskRead: relayMarkTaskReadMock,
      close: relayCloseMock,
    });
    lanTerminalClientFactoryMock.mockReset();
    lanTerminalClientFactoryMock.mockResolvedValue({
      advanceStage: lanAdvanceStageMock,
      closeTask: relayCloseTaskMock,
      markTaskRead: lanMarkTaskReadMock,
      close: lanCloseMock,
    });
    lanTasksMock.mockReset();
    lanTasksMock.mockResolvedValue({
      repos: [],
      items: [],
      terminalRefs: {},
      transferMachines: [],
    });
    openLatestTerminalFileLinkMock.mockReset();
    openLatestTerminalFileLinkMock.mockResolvedValue(true);
    store.repos = [{ id: "repo-1", path: "/tmp/repo", name: "repo" }];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = null;
    store.lastSelectedItemByRepo = {};
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo", name: "repo" };
    store.currentItem = null;
    store.currentTaskSlot = null;
    store.selectedTaskId = null;
    store.items = [];
    store.taskUiSlots = [];
    store.sortedItemsForCurrentRepo = [];
    store.sortedItemsAllRepos = [];
    store.taskBlockers = [];
    store.repoSidebarOrder = {};
    store.getStageOrder.mockReturnValue(["in progress", "pr", "merge"]);
    store.appTheme = "dark";
    store.codeTheme = "match";
    store.markdownPreviewMode = "rendered";
    store.hideShortcutsOnStartup = true;
    store.savePreference.mockClear();
    nativeSetThemeMock.mockClear();
    listenHandlers.clear();
    currentWebviewWindowListenHandlers.clear();
    closeRequestedHandler = null;
    nativeCloseRegistrationHarness.error = null;
    nativeWindowDestroyMock.mockClear();
    capturedKeyboardActions = null;
    mockWindowWorkspace.loadSnapshot.mockClear();
    mockWindowWorkspace.saveSnapshot.mockClear();
    mockWindowWorkspace.openWindow.mockClear();
    mockWindowWorkspace.closeWindow.mockClear();
    mockWindowWorkspace.initialize.mockClear();
    mockWindowWorkspace.destroyNativeWindow.mockReset();
    mockWindowWorkspace.destroyNativeWindow.mockImplementation(async () => {
      await nativeWindowDestroyMock();
    });
    mockWindowWorkspace.forgetCurrentWindow.mockClear();
    mockWindowWorkspace.forgetCurrentWindow.mockResolvedValue(null);
    mockWindowWorkspace.restoreCurrentWindow.mockClear();
    mockWindowWorkspace.notifyWindowMembershipChanged.mockClear();
    mockWindowWorkspace.persistSelection.mockClear();
    mockWindowWorkspace.persistSidebarHidden.mockClear();
    mockWindowWorkspace.persistSidebarWidth.mockClear();
    mockWindowWorkspace.restoreCurrentWindowGeometry.mockClear();
    mockWindowWorkspace.startGeometryTracking.mockReset();
    mockWindowWorkspace.startGeometryTracking.mockResolvedValue(vi.fn());
    mockWindowWorkspace.invalidateSharedData.mockClear();
    mockWindowWorkspace.restoreAdditionalWindows.mockClear();
    mockWindowWorkspace.bootstrap.windowId = "main";
    mockWindowWorkspace.bootstrap.tearOffContext = undefined;
    dbSelectMock.mockReset();
    dbSelectMock.mockResolvedValue([]);
    dbMock.execute.mockReset();
    dbMock.execute.mockResolvedValue({ rowsAffected: 0 });
    updateDesktopServerClientHandlersForTests({
      ensureMobileServer: async () => {},
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default"],
      }),
      fetchRepoRecentWorkflows: async () => [],
      fetchRepoCommands: async (repoId) => ({
        repoId,
        revision: "catalog-v1",
        commands: [
          { id: "factory:create-agent", label: "Create Agent", description: "Create a new agent definition", group: "configure" },
          { id: "factory:create-workflow", label: "Create Workflow", description: "Create a new workflow definition", group: "configure" },
          { id: "factory:setup-repo", label: "Set Up Repository", description: "Configure .kanna workflow and agent flavors", group: "configure" },
          { id: "factory:create-config", label: "Create Config", description: "Create or update .kanna/config.json", group: "configure" },
        ],
      }),
      runRepoCommand: async () => ({ taskId: "repo-command-task", reused: false }),
      fetchIncomingTransferCleanupCandidates: async () => [],
      markIncomingTransferSidecarCleanupCompleted: async (transferId) => {
        await dbMock.execute(
          "UPDATE task_transfer SET sidecar_cleanup_completed_at = datetime('now') WHERE id = ?",
          [transferId],
        );
        return true;
      },
      fetchPendingIncomingTransfers: async () => await dbSelectMock(),
      getTaskTransfer: async () => null,
      claimPendingIncomingTransfer: async (transferId, ownerToken, recovery) => {
        const result = await dbMock.execute(
          "UPDATE task_transfer SET status = 'claimed', claim_owner_token = ? WHERE id = ? AND (status = 'pending' OR ? = 1)",
          [ownerToken, transferId, recovery ? 1 : 0],
        );
        return result.rowsAffected > 0;
      },
      renewIncomingTransferClaim: async () => true,
      failPendingIncomingTransfer: async (transferId, reason) => {
        await dbMock.execute(
          "UPDATE task_transfer SET status = 'failed', error = ? WHERE id = ?",
          [reason, transferId],
        );
        return true;
      },
    });
    invokeMock.mockClear();
    toastInfoMock.mockClear();
    toastWarningMock.mockClear();
    toastErrorMock.mockClear();
    cloudTasksMock.mockReset();
    cloudTasksMock.mockResolvedValue({ repos: [], items: [] });
    subscribeDesktopCloudTasksMock.mockClear();
    desktopCloudTaskSnapshotListeners.clear();
    desktopAuthStateListeners.clear();
    associateDesktopCloudCredentialMock.mockReset();
    associateDesktopCloudCredentialMock.mockResolvedValue(undefined);
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
      if (command === "git_repository_has_commits") return true;
      if (command === "git_repository_state") {
        return { defaultBranch: "main", hasCommits: true };
      }
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
      if (command === "mark_incoming_transfer_ack_completed") return null;
      if (command === "mark_incoming_transfer_event_recorded") return null;
      if (command === "claim_transfer_event_consumer") {
        return { authoritative: true, consumerIncarnation: "consumer-incarnation-test" };
      }
      if (command === "release_transfer_event_consumer") return null;
      if (command === "renew_transfer_lifecycle_event") return true;
      if (command === "claim_transfer_lifecycle_phase") return true;
      if (command === "acknowledge_transfer_lifecycle_event") return true;
      if (command === "nack_transfer_lifecycle_event") return true;
      if (command === "nack_outgoing_transfer_commit") return null;
      if (command === "complete_outgoing_transfer_finalization") {
        return { transferId: (args as Record<string, unknown> | undefined)?.transferId ?? "transfer-1" };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
  });

  it("initializes the cloud workspace with an empty durable repo order", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(store.repoSidebarOrder).toEqual({});
    expect(wrapper.findComponent(SidebarWithRepoStub).exists()).toBe(true);

    wrapper.unmount();
  });

  it("schedules startup backup only after the main window initial data is loaded", async () => {
    const initDeferred = createDeferred<void>();
    store.init.mockImplementationOnce(async () => initDeferred.promise);

    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(scheduleStartupBackupMock).not.toHaveBeenCalled();

    initDeferred.resolve();
    await waitForCondition(() => scheduleStartupBackupMock.mock.calls.length > 0);

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

  it("does not cover a transferred modal with the startup shortcuts prompt", async () => {
    store.hideShortcutsOnStartup = false;
    mockWindowWorkspace.bootstrap.windowId = "window-2";
    mockWindowWorkspace.bootstrap.tearOffContext = {
      surface: "tree",
      worktreePath: "/tmp/repo/.kanna-worktrees/task-a",
      repoRoot: "/tmp/repo",
    };

    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(wrapper.find("tree-explorer-modal-stub").exists()).toBe(true);
    expect(wrapper.find("keyboard-shortcuts-modal-stub").exists()).toBe(false);

    wrapper.unmount();
  });

  it("still shows the startup shortcuts prompt in an ordinary window", async () => {
    store.hideShortcutsOnStartup = false;

    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(wrapper.find("keyboard-shortcuts-modal-stub").exists()).toBe(true);

    wrapper.unmount();
  });

  it("tracks native geometry after workspace initialization and disposes on unmount", async () => {
    const disposeGeometryTracking = vi.fn();
    mockWindowWorkspace.startGeometryTracking.mockResolvedValueOnce(disposeGeometryTracking);

    const wrapper = await mountApp(SidebarWithRepoStub);

    expect(mockWindowWorkspace.initialize).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.startGeometryTracking).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      mockWindowWorkspace.startGeometryTracking.mock.invocationCallOrder[0] ?? 0,
    );

    wrapper.unmount();
    expect(disposeGeometryTracking).toHaveBeenCalledTimes(1);
  });

  it("associates the desktop credential on sign-in without renderer task publication", async () => {
    vi.useFakeTimers();

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(associateDesktopCloudCredentialMock).toHaveBeenCalledTimes(1);

    associateDesktopCloudCredentialMock.mockClear();
    cloudTasksMock.mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(associateDesktopCloudCredentialMock).not.toHaveBeenCalled();
    expect(cloudTasksMock).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("initializes cloud association and read subscriptions in a restored secondary window", async () => {
    mockWindowWorkspace.bootstrap.windowId = "window-2";

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(associateDesktopCloudCredentialMock).toHaveBeenCalledTimes(1);
    expect(subscribeDesktopCloudTasksMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it("shows a fatal startup state when native close protection cannot register", async () => {
    nativeCloseRegistrationHarness.error = new Error("listener unavailable");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(wrapper.get('[data-testid="fatal-initialization-error"]').text()).toContain(
      "Native window-close protection is unavailable",
    );
    expect(mockWindowWorkspace.initialize).not.toHaveBeenCalled();
    expect(store.init).not.toHaveBeenCalled();
    expect(associateDesktopCloudCredentialMock).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    wrapper.unmount();
  });

  it("shows one toast when desktop credential association fails", async () => {
    vi.useFakeTimers();
    associateDesktopCloudCredentialMock.mockRejectedValueOnce(
      Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }),
    );

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("Cloud sync failed: permission-denied");

    wrapper.unmount();
  });

  it("explains a desktop credential conflict once instead of the generic backend toast", async () => {
    associateDesktopCloudCredentialMock.mockRejectedValue(
      new DesktopCloudCredentialConflictError("desktop-1"),
    );

    const wrapper = await mountApp(SidebarWithRepoStub);
    await waitForCondition(() => associateDesktopCloudCredentialMock.mock.calls.length === 1);
    await flushPromises();

    for (const listener of desktopAuthStateListeners) {
      listener({
        status: "signedIn",
        user: { uid: "user-1", email: "upvote.sieve.7t@icloud.com" },
      });
    }
    await waitForCondition(() => associateDesktopCloudCredentialMock.mock.calls.length === 2);
    await flushPromises();

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Cloud sync is off: this desktop is registered to a different Kanna account. "
      + "Sign in as that account and sign out to release it.",
    );

    wrapper.unmount();
  });

  it("retries desktop credential association after a transient failure", async () => {
    associateDesktopCloudCredentialMock
      .mockRejectedValueOnce(new Error("temporary association failure"))
      .mockResolvedValueOnce(undefined);

    const wrapper = await mountApp(SidebarWithRepoStub);
    await waitForCondition(() => associateDesktopCloudCredentialMock.mock.calls.length === 1);

    for (const listener of desktopAuthStateListeners) {
      listener({
        status: "signedIn",
        user: { uid: "user-1", email: "upvote.sieve.7t@icloud.com" },
      });
    }
    await waitForCondition(() => associateDesktopCloudCredentialMock.mock.calls.length === 2);

    expect(associateDesktopCloudCredentialMock).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it("re-associates the same user after signed-out state revokes the credential", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);
    await waitForCondition(() => associateDesktopCloudCredentialMock.mock.calls.length === 1);

    for (const listener of desktopAuthStateListeners) {
      listener({ status: "signedOut" });
    }
    await flushPromises();
    for (const listener of desktopAuthStateListeners) {
      listener({
        status: "signedIn",
        user: { uid: "user-1", email: "upvote.sieve.7t@icloud.com" },
      });
    }
    await waitForCondition(() => associateDesktopCloudCredentialMock.mock.calls.length === 2);

    expect(associateDesktopCloudCredentialMock).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it("shows one toast when sign-in cloud task refresh fails", async () => {
    vi.useFakeTimers();
    cloudTasksMock.mockRejectedValueOnce(
      Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }),
    );

    const wrapper = await mountApp(SidebarWithRepoStub);
    await flushPromises();

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("Cloud sync failed: permission-denied");

    wrapper.unmount();
  });

  it("does not let a deferred one-shot cloud read overwrite a newer subscription snapshot", async () => {
    const oneShot = createDeferred<DesktopCloudSnapshot>();
    cloudTasksMock.mockImplementationOnce(() => oneShot.promise);
    const wrapper = await mountApp(RemoteTaskSelectionStub);
    const newerSnapshot = remoteTaskSnapshot(
      "cloud",
      "subscription-owner",
      "subscription-owner-task",
    );
    const originalTaskId = newerSnapshot.items[0].id;
    const newerTaskId = "cloud:repo-remote:task-subscription-newer";
    newerSnapshot.items[0].id = newerTaskId;
    newerSnapshot.items[0].branch = "task-subscription-newer";
    newerSnapshot.terminalRefs[newerTaskId] = newerSnapshot.terminalRefs[originalTaskId];
    delete newerSnapshot.terminalRefs[originalTaskId];

    for (const listener of desktopCloudTaskSnapshotListeners) {
      listener(newerSnapshot);
    }
    await nextTick();
    expect(wrapper.get('[data-testid="remote-task"]').attributes("data-task-id")).toBe(
      newerTaskId,
    );

    oneShot.resolve(remoteTaskSnapshot("cloud", "stale-owner", "stale-owner-task"));
    await flushPromises();
    await flushPromises();

    expect(wrapper.findAll('[data-testid="remote-task"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="remote-task"]').attributes("data-task-id")).toBe(
      newerTaskId,
    );

    wrapper.unmount();
  });

  it("does not let a deferred one-shot cloud read restore tasks after sign-out", async () => {
    const oneShot = createDeferred<DesktopCloudSnapshot>();
    cloudTasksMock.mockImplementationOnce(() => oneShot.promise);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    for (const listener of desktopAuthStateListeners) {
      listener({ status: "signedOut" });
    }
    await nextTick();
    expect(wrapper.findAll('[data-testid="remote-task"]')).toHaveLength(0);

    oneShot.resolve(remoteTaskSnapshot("cloud", "signed-out-owner", "signed-out-task"));
    await flushPromises();
    await flushPromises();

    expect(wrapper.findAll('[data-testid="remote-task"]')).toHaveLength(0);

    wrapper.unmount();
  });

  it("does not let a deferred one-shot cloud read from a previous account replace the current account snapshot", async () => {
    const previousAccountOneShot = createDeferred<DesktopCloudSnapshot>();
    cloudTasksMock
      .mockImplementationOnce(() => previousAccountOneShot.promise)
      .mockImplementationOnce(() => new Promise<DesktopCloudSnapshot>(() => {}));
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    for (const listener of desktopAuthStateListeners) {
      listener({
        status: "signedIn",
        user: { uid: "user-2", email: "current@example.com" },
      });
    }
    await nextTick();
    const currentSnapshot = remoteTaskSnapshot(
      "cloud",
      "current-account-owner",
      "current-account-task",
    );
    const currentOriginalTaskId = currentSnapshot.items[0].id;
    const currentTaskId = "cloud:repo-remote:task-current-account";
    currentSnapshot.items[0].id = currentTaskId;
    currentSnapshot.items[0].branch = "task-current-account";
    currentSnapshot.terminalRefs[currentTaskId] =
      currentSnapshot.terminalRefs[currentOriginalTaskId];
    delete currentSnapshot.terminalRefs[currentOriginalTaskId];
    for (const listener of desktopCloudTaskSnapshotListeners) {
      listener(currentSnapshot);
    }
    await nextTick();
    expect(wrapper.get('[data-testid="remote-task"]').attributes("data-task-id")).toBe(
      currentTaskId,
    );

    const previousSnapshot = remoteTaskSnapshot(
      "cloud",
      "previous-account-owner",
      "previous-account-task",
    );
    const previousOriginalTaskId = previousSnapshot.items[0].id;
    const previousTaskId = "cloud:repo-remote:task-previous-account";
    previousSnapshot.items[0].id = previousTaskId;
    previousSnapshot.items[0].branch = "task-previous-account";
    previousSnapshot.terminalRefs[previousTaskId] =
      previousSnapshot.terminalRefs[previousOriginalTaskId];
    delete previousSnapshot.terminalRefs[previousOriginalTaskId];
    previousAccountOneShot.resolve(previousSnapshot);
    await flushPromises();
    await flushPromises();

    expect(subscribeDesktopCloudTasksMock).toHaveBeenNthCalledWith(
      2,
      "user-2",
      expect.any(Function),
      expect.any(Object),
    );
    expect(wrapper.findAll('[data-testid="remote-task"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="remote-task"]').attributes("data-task-id")).toBe(
      currentTaskId,
    );

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
        workflow: "cloud",
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
        transition_revision: "run-owner-1",
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
        taskSlots: { type: Array, default: () => [] },
      },
      emits: ["select-item"],
      template: `
        <div data-testid="sidebar">
          <button
            v-for="item in taskSlots"
            :key="item.slot_id"
            data-testid="cloud-task"
            type="button"
            @click="$emit('select-item', item.slot_id)"
          >
            {{ item.display_name }}
          </button>
        </div>
      `,
    });

    const MainPanelCloudStub = defineComponent({
      name: "MainPanel",
      props: {
        uiSlot: Object,
        repoPath: String,
      },
      template: `
        <div data-testid="main-panel">
          <span data-testid="main-slot-id">{{ uiSlot?.slot_id || "" }}</span>
          <span data-testid="main-task-id">{{ uiSlot?.task_id || "" }}</span>
          <span data-testid="main-item-id">{{ uiSlot?.task?.id || "" }}</span>
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
    expect(wrapper.get('[data-testid="main-task-id"]').text()).toBe("cloud:repo-remote:task-remote");
    const presentationSlotId = wrapper.get('[data-testid="main-slot-id"]').text();
    expect(presentationSlotId).not.toBe("cloud:repo-remote:task-remote");
    expect(store.selectedItemId).toBe(presentationSlotId);
    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: "cloud:repo-remote:task-remote",
    });
    expect(wrapper.get('[data-testid="main-repo-path"]').text()).toBe("cloud");

    wrapper.unmount();
  });

  it("pins a remote-only task through the viewer-local overlay instead of the local pin API", async () => {
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
        workflow: "cloud",
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

    const settings = new Map<string, string>();
    updateDesktopServerClientHandlersForTests({
      getSetting: (key) => settings.get(key) ?? null,
      putSetting: (key, value) => {
        settings.set(key, value);
      },
      deleteSetting: (key) => {
        settings.delete(key);
      },
    });

    const SidebarPinStub = defineComponent({
      name: "Sidebar",
      props: {
        repos: { type: Array, default: () => [] },
        taskSlots: { type: Array, default: () => [] },
      },
      emits: ["pin-item", "unpin-item", "reorder-pinned"],
      template: `
        <div data-testid="sidebar">
          <button
            v-for="item in taskSlots"
            :key="item.slot_id"
            data-testid="pin-remote-task"
            type="button"
            @click="$emit('pin-item', item.task_id, 0); $emit('reorder-pinned', item.repo_id, [item.task_id])"
          >
            {{ item.display_name }}
          </button>
          <button
            v-for="item in taskSlots"
            :key="'unpin-' + item.slot_id"
            data-testid="unpin-remote-task"
            type="button"
            @click="$emit('unpin-item', item.task_id)"
          >
            unpin
          </button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarPinStub, {});
    await flushPromises();
    await flushPromises();

    try {
      store.pinItem.mockClear();
      store.reorderPinned.mockClear();
      store.reloadSnapshot.mockClear();

      await wrapper.get('[data-testid="pin-remote-task"]').trigger("click");
      for (let attempt = 0; attempt < 10; attempt++) {
        await flushPromises();
      }

      expect(store.pinItem).not.toHaveBeenCalled();
      expect(store.reorderPinned).not.toHaveBeenCalled();
      expect(JSON.parse(settings.get("remoteTaskPins") ?? "{}")).toEqual({ "task-remote": 0 });
      expect(store.reloadSnapshot).toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();

      await wrapper.get('[data-testid="unpin-remote-task"]').trigger("click");
      for (let attempt = 0; attempt < 10; attempt++) {
        await flushPromises();
      }

      expect(store.unpinItem).not.toHaveBeenCalled();
      expect(settings.has("remoteTaskPins")).toBe(false);
    } finally {
      // Restore the global test-setup defaults clobbered by this test's
      // settings-backed handlers.
      updateDesktopServerClientHandlersForTests({
        getSetting: async () => null,
        putSetting: async (key, value) => ({ key, value }),
        deleteSetting: async () => {},
      });
      wrapper.unmount();
    }
  });

  it("pins a cross-machine directory singleton by default and keeps an explicit unpin", async () => {
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
        id: "cloud:repo-remote:task-merge",
        repo_id: "cloud:repo-remote",
        prompt: "Merge Master",
        workflow: "cloud",
        singleton_agent: "merge",
        stage: "in progress",
        tags: "[]",
        pr_number: null,
        pr_url: null,
        branch: "task-merge",
        activity: "idle",
        activity_changed_at: "2026-05-18T00:00:00.000Z",
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Merge Master",
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

    const settings = new Map<string, string>();
    updateDesktopServerClientHandlersForTests({
      getSetting: (key) => settings.get(key) ?? null,
      putSetting: (key, value) => {
        settings.set(key, value);
      },
      deleteSetting: (key) => {
        settings.delete(key);
      },
    });

    const SidebarPinStub = defineComponent({
      name: "Sidebar",
      props: {
        repos: { type: Array, default: () => [] },
        taskSlots: { type: Array, default: () => [] },
      },
      emits: ["pin-item", "unpin-item", "reorder-pinned"],
      template: `
        <div data-testid="sidebar">
          <span data-testid="pinned-state">{{ taskSlots.some((slot) => slot.pinned) ? 'pinned' : 'unpinned' }}</span>
          <button
            v-for="item in taskSlots"
            :key="item.slot_id"
            data-testid="pin-remote-task"
            type="button"
            @click="$emit('pin-item', item.task_id, 0); $emit('reorder-pinned', item.repo_id, [item.task_id])"
          >
            {{ item.display_name }}
          </button>
          <button
            v-for="item in taskSlots"
            :key="'unpin-' + item.slot_id"
            data-testid="unpin-remote-task"
            type="button"
            @click="$emit('unpin-item', item.task_id)"
          >
            unpin
          </button>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarPinStub, {});
    await flushPromises();
    await flushPromises();

    try {
      // Nothing pinned it here: the row arrives pinned because it is the
      // account-wide singleton, and the overlay is still empty.
      expect(wrapper.get('[data-testid="pinned-state"]').text()).toBe("pinned");
      expect(settings.has("remoteTaskPins")).toBe(false);
      store.reloadSnapshot.mockClear();

      await wrapper.get('[data-testid="unpin-remote-task"]').trigger("click");
      for (let attempt = 0; attempt < 10; attempt++) {
        await flushPromises();
      }

      // The unpin is recorded rather than forgotten, so the default does not
      // put the row straight back on the next snapshot.
      expect(store.unpinItem).not.toHaveBeenCalled();
      expect(JSON.parse(settings.get("remoteTaskPins") ?? "{}")).toEqual({ "task-merge": null });
      expect(store.reloadSnapshot).toHaveBeenCalled();
      expect(toastErrorMock).not.toHaveBeenCalled();
    } finally {
      // Restore the global test-setup defaults clobbered by this test's
      // settings-backed handlers.
      updateDesktopServerClientHandlersForTests({
        getSetting: async () => null,
        putSetting: async (key, value) => ({ key, value }),
        deleteSetting: async () => {},
      });
      wrapper.unmount();
    }
  });

  it("marks a selected unread cloud task read through its owner relay after one second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "relay-owner", "relay-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(relayTerminalClientFactoryMock).toHaveBeenCalledOnce();
    expect(relayMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "relay-owner",
      taskId: "relay-owner-task",
      expectedActivityRevision: 7,
    });
    expect(lanTerminalClientFactoryMock).not.toHaveBeenCalled();
    expect(lanMarkTaskReadMock).not.toHaveBeenCalled();
    expect(relayCloseMock).toHaveBeenCalledOnce();

    wrapper.unmount();
  });

  it("marks only the replacement selection after its own full dwell", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "first-owner", "first-owner-task");
    const secondTaskId = "cloud:repo-remote:task-second";
    snapshot.items.push({
      ...snapshot.items[0],
      id: secondTaskId,
      prompt: "Second unread remote task",
      branch: "task-second",
    });
    snapshot.terminalRefs[secondTaskId] = {
      ownerDesktopId: "second-owner",
      ownerLocalRepoId: "owner-repo",
      ownerLocalTaskId: "second-owner-task",
      transport: "cloud",
    };
    cloudTasksMock.mockResolvedValue(snapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get(`[data-task-id="${snapshot.items[0].id}"]`).trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(600);
    await wrapper.get(`[data-task-id="${secondTaskId}"]`).trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(400);
    await flushPromises();

    expect(relayTerminalClientFactoryMock).not.toHaveBeenCalled();
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(599);
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(relayTerminalClientFactoryMock).toHaveBeenCalledOnce();
    expect(relayMarkTaskReadMock).toHaveBeenCalledOnce();
    expect(relayMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "second-owner",
      taskId: "second-owner-task",
      expectedActivityRevision: 7,
    });

    wrapper.unmount();
  });

  it("keeps elapsed dwell across a coherent snapshot refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "refreshed-owner", "refreshed-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get(`[data-task-id="${snapshot.items[0].id}"]`).trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(600);

    const refreshedSnapshot = remoteTaskSnapshot(
      "cloud",
      "refreshed-owner",
      "refreshed-owner-task",
    );
    refreshedSnapshot.items[0].prompt = "Refreshed unread remote task";
    refreshedSnapshot.items[0].updated_at = "2026-07-25T01:00:00.600Z";
    for (const listener of desktopCloudTaskSnapshotListeners) {
      listener(refreshedSnapshot);
    }
    await nextTick();

    await vi.advanceTimersByTimeAsync(399);
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(relayMarkTaskReadMock).toHaveBeenCalledOnce();
    expect(relayMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "refreshed-owner",
      taskId: "refreshed-owner-task",
      expectedActivityRevision: 7,
    });

    wrapper.unmount();
  });

  it("restarts the selected unread task dwell when activity revision advances", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "revision-owner", "revision-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get(`[data-task-id="${snapshot.items[0].id}"]`).trigger("click");
    await nextTick();
    const presentationSlotId = store.selectedItemId;
    await vi.advanceTimersByTimeAsync(600);

    const revisionEightSnapshot = remoteTaskSnapshot(
      "cloud",
      "revision-owner",
      "revision-owner-task",
    );
    revisionEightSnapshot.items[0].activity_revision = 8;
    revisionEightSnapshot.items[0].activity_changed_at = "2026-07-25T01:00:00.600Z";
    revisionEightSnapshot.items[0].updated_at = "2026-07-25T01:00:00.600Z";
    for (const listener of desktopCloudTaskSnapshotListeners) {
      listener(revisionEightSnapshot);
    }
    await nextTick();

    expect(store.selectedItemId).toBe(presentationSlotId);
    await vi.advanceTimersByTimeAsync(400);
    await flushPromises();
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(599);
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(relayMarkTaskReadMock).toHaveBeenCalledOnce();
    expect(relayMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "revision-owner",
      taskId: "revision-owner-task",
      expectedActivityRevision: 8,
    });

    wrapper.unmount();
  });

  it("rejects a stale stable-slot owner and marks the replacement after its own dwell", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "original-owner", "original-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get(`[data-task-id="${snapshot.items[0].id}"]`).trigger("click");
    await nextTick();
    const presentationSlotId = store.selectedItemId;
    await vi.advanceTimersByTimeAsync(600);

    const replacementSnapshot = remoteTaskSnapshot(
      "cloud",
      "replacement-owner",
      "replacement-owner-task",
    );
    replacementSnapshot.items[0].updated_at = "2026-07-25T01:00:00.600Z";
    for (const listener of desktopCloudTaskSnapshotListeners) {
      listener(replacementSnapshot);
    }
    await nextTick();

    expect(store.selectedItemId).toBe(presentationSlotId);
    await vi.advanceTimersByTimeAsync(400);
    await flushPromises();

    expect(relayTerminalClientFactoryMock).not.toHaveBeenCalled();
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(599);
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(relayTerminalClientFactoryMock).toHaveBeenCalledOnce();
    expect(relayMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "replacement-owner",
      taskId: "replacement-owner-task",
      expectedActivityRevision: 7,
    });

    wrapper.unmount();
  });

  it("closes an active mark-read client when the app unmounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "active-owner", "active-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    const markReadDeferred = createDeferred<void>();
    relayMarkTaskReadMock.mockImplementationOnce(() => markReadDeferred.promise);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get(`[data-task-id="${snapshot.items[0].id}"]`).trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await waitForCondition(() => relayMarkTaskReadMock.mock.calls.length === 1);

    expect(relayCloseMock).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(relayCloseMock).toHaveBeenCalledOnce();

    markReadDeferred.resolve();
    await flushPromises();
    expect(relayCloseMock).toHaveBeenCalledOnce();
  });

  it("expires and closes a mark-read client whose relay request never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "stalled-owner", "stalled-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    relayMarkTaskReadMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get(`[data-task-id="${snapshot.items[0].id}"]`).trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await waitForCondition(() => relayMarkTaskReadMock.mock.calls.length === 1);

    expect(relayCloseMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(relayCloseMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const closeCallsBeforeUnmount = relayCloseMock.mock.calls.length;

    wrapper.unmount();
    expect(closeCallsBeforeUnmount).toBe(1);
    expect(relayCloseMock).toHaveBeenCalledOnce();
  });

  it("closes a mark-read client acquired after app teardown without starting the request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "late-owner", "late-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    const client = {
      advanceStage: relayAdvanceStageMock,
      closeTask: relayCloseTaskMock,
      markTaskRead: relayMarkTaskReadMock,
      close: relayCloseMock,
    };
    const clientDeferred = createDeferred<typeof client>();
    relayTerminalClientFactoryMock.mockImplementationOnce(() => clientDeferred.promise);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get(`[data-task-id="${snapshot.items[0].id}"]`).trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await waitForCondition(() => relayTerminalClientFactoryMock.mock.calls.length === 1);

    wrapper.unmount();
    clientDeferred.resolve(client);
    await flushPromises();

    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();
    expect(relayCloseMock).toHaveBeenCalledOnce();
  });

  it("marks a selected unread LAN task read through its owner peer after one second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("lan", "lan-owner", "lan-owner-task");
    lanTasksMock.mockResolvedValue(snapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(lanTerminalClientFactoryMock).toHaveBeenCalledOnce();
    expect(lanMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "lan-owner",
      taskId: "lan-owner-task",
      expectedActivityRevision: 7,
    });
    expect(relayTerminalClientFactoryMock).not.toHaveBeenCalled();
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();
    expect(lanCloseMock).toHaveBeenCalledOnce();

    wrapper.unmount();
  });

  it("keeps LAN snapshot refresh single-flight while a peer request is stalled", async () => {
    vi.useFakeTimers();
    const firstRefresh = createDeferred<DesktopCloudSnapshot>();
    const secondRefresh = createDeferred<DesktopCloudSnapshot>();
    lanTasksMock
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => secondRefresh.promise);
    const wrapper = await mountApp(SidebarWithRepoStub);

    await waitForCondition(() => lanTasksMock.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(5000);

    expect(lanTasksMock).toHaveBeenCalledOnce();

    firstRefresh.resolve({ repos: [], items: [], terminalRefs: {}, blockedByTaskIds: {} });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);

    expect(lanTasksMock).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    secondRefresh.resolve({ repos: [], items: [], terminalRefs: {}, blockedByTaskIds: {} });
    await flushPromises();
  });

  it("preserves dwell and uses a preferred LAN route added while the task stays selected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const cloudSnapshot = remoteTaskSnapshot("cloud", "route-owner", "route-owner-task");
    const lanSnapshot = remoteTaskSnapshot("lan", "route-owner", "route-owner-task");
    lanSnapshot.repos[0].id = cloudSnapshot.repos[0].id;
    lanSnapshot.items[0].repo_id = cloudSnapshot.repos[0].id;
    cloudTasksMock.mockResolvedValue(cloudSnapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await vi.advanceTimersByTimeAsync(500);
    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await nextTick();
    const presentationSlotId = store.selectedItemId;
    lanTasksMock.mockResolvedValue(lanSnapshot);

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(store.selectedItemId).toBe(presentationSlotId);
    expect(lanMarkTaskReadMock).not.toHaveBeenCalled();
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(lanMarkTaskReadMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(store.selectedItemId).toBe(presentationSlotId);
    expect(lanMarkTaskReadMock).toHaveBeenCalledOnce();
    expect(lanMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "route-owner",
      taskId: "route-owner-task",
      expectedActivityRevision: 7,
    });
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("preserves dwell and falls back to relay when the selected task loses its LAN route", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const cloudSnapshot = remoteTaskSnapshot("cloud", "fallback-owner", "fallback-owner-task");
    const lanSnapshot = remoteTaskSnapshot("lan", "fallback-owner", "fallback-owner-task");
    lanSnapshot.repos[0].id = cloudSnapshot.repos[0].id;
    lanSnapshot.items[0].repo_id = cloudSnapshot.repos[0].id;
    cloudTasksMock.mockResolvedValue(cloudSnapshot);
    lanTasksMock.mockResolvedValue(lanSnapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await vi.advanceTimersByTimeAsync(500);
    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await nextTick();
    const presentationSlotId = store.selectedItemId;
    lanTasksMock.mockResolvedValue({
      repos: [],
      items: [],
      terminalRefs: {},
      transferMachines: [],
    });

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(store.selectedItemId).toBe(presentationSlotId);
    expect(lanMarkTaskReadMock).not.toHaveBeenCalled();
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(store.selectedItemId).toBe(presentationSlotId);
    expect(relayMarkTaskReadMock).toHaveBeenCalledOnce();
    expect(relayMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "fallback-owner",
      taskId: "fallback-owner-task",
      expectedActivityRevision: 7,
    });
    expect(lanMarkTaskReadMock).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("selects the newer cloud activity authority before the older LAN duplicate refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const cloudSnapshot = remoteTaskSnapshot("cloud", "duplicate-owner", "duplicate-owner-task");
    const lanSnapshot = remoteTaskSnapshot("lan", "duplicate-owner", "duplicate-owner-task");
    lanSnapshot.repos[0].id = cloudSnapshot.repos[0].id;
    lanSnapshot.items[0].repo_id = cloudSnapshot.repos[0].id;
    cloudTasksMock.mockResolvedValue(cloudSnapshot);
    lanTasksMock.mockResolvedValue(lanSnapshot);
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    expect(wrapper.findAll('[data-testid="remote-task"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="remote-task-activity"]').text()).toBe("unread");
    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await nextTick();
    const selectedPresentationSlot = store.selectedItemId;

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(lanMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "duplicate-owner",
      taskId: "duplicate-owner-task",
      expectedActivityRevision: 7,
    });
    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();

    const cloudReadSnapshot = remoteTaskSnapshot(
      "cloud",
      "duplicate-owner",
      "duplicate-owner-task",
    );
    cloudReadSnapshot.items[0].activity = "idle";
    cloudReadSnapshot.items[0].activity_revision = 8;
    cloudReadSnapshot.items[0].activity_changed_at = "2026-07-25T01:00:01.000Z";
    for (const listener of desktopCloudTaskSnapshotListeners) {
      listener(cloudReadSnapshot);
    }
    await nextTick();

    expect(wrapper.get('[data-testid="remote-task-activity"]').text()).toBe("idle");

    const lanReadSnapshot = remoteTaskSnapshot(
      "lan",
      "duplicate-owner",
      "duplicate-owner-task",
    );
    lanReadSnapshot.repos[0].id = cloudReadSnapshot.repos[0].id;
    lanReadSnapshot.items[0].repo_id = cloudReadSnapshot.repos[0].id;
    lanReadSnapshot.items[0].activity = "idle";
    lanReadSnapshot.items[0].activity_revision = 8;
    lanReadSnapshot.items[0].activity_changed_at = "2026-07-25T01:00:01.000Z";
    lanTasksMock.mockResolvedValue(lanReadSnapshot);

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(store.selectedItemId).toBe(selectedPresentationSlot);
    expect(wrapper.findAll('[data-testid="remote-task"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="remote-task-activity"]').text()).toBe("idle");

    wrapper.unmount();
  });

  it("marks a restored unread remote selection read through the store fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "restored-owner", "restored-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    store.selectedRepoId = snapshot.repos[0].id;
    store.selectedRepo = null;
    store.selectedItemId = snapshot.items[0].id;

    const wrapper = await mountApp(RemoteTaskSelectionStub);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(relayMarkTaskReadMock).toHaveBeenCalledWith({
      desktopId: "restored-owner",
      taskId: "restored-owner-task",
      expectedActivityRevision: 7,
    });
    expect(relayCloseMock).toHaveBeenCalledOnce();

    wrapper.unmount();
  });

  it("closes the relay client after mark-read failure and logs close failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "failing-owner", "failing-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    relayMarkTaskReadMock.mockRejectedValueOnce(new Error("mark read failed"));
    relayCloseMock.mockImplementationOnce(() => {
      throw new Error("close failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(relayCloseMock).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[remote] failed to mark task read:",
      "mark read failed",
    );
    expect(warn).toHaveBeenCalledWith(
      "[remote] failed to close mark-read client:",
      "close failed",
    );
    expect(toastErrorMock).not.toHaveBeenCalled();

    warn.mockRestore();
    wrapper.unmount();
  });

  it("leaves projected remote activity unread when relay acquisition fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const snapshot = remoteTaskSnapshot("cloud", "offline-owner", "offline-owner-task");
    cloudTasksMock.mockResolvedValue(snapshot);
    relayTerminalClientFactoryMock.mockRejectedValueOnce(new Error("relay unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = await mountApp(RemoteTaskSelectionStub);

    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(relayMarkTaskReadMock).not.toHaveBeenCalled();
    expect(relayCloseMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[remote] failed to mark task read:",
      "relay unavailable",
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(snapshot.items[0].activity).toBe("unread");
    expect(wrapper.get('[data-testid="remote-task-activity"]').text()).toBe("unread");

    warn.mockRestore();
    wrapper.unmount();
  });

  it("clears and persists a remote selection after closing its stable presentation slot", async () => {
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
        workflow: "cloud",
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
        "cloud:repo-remote:task-remote": {
          ownerDesktopId: "desktop-owner",
          ownerLocalRepoId: "repo-owner",
          ownerLocalTaskId: "task-owner",
          transport: "cloud",
        },
      },
    });

    const SidebarRemoteCloseStub = defineComponent({
      name: "Sidebar",
      props: {
        taskSlots: { type: Array, default: () => [] },
      },
      emits: ["select-item"],
      template: `
        <button
          v-for="item in taskSlots"
          :key="item.slot_id"
          data-testid="remote-close-task"
          type="button"
          @click="$emit('select-item', item.slot_id)"
        >
          {{ item.display_name }}
        </button>
      `,
    });

    const wrapper = await mountApp(SidebarRemoteCloseStub);
    await flushPromises();
    await flushPromises();

    await wrapper.get('[data-testid="remote-close-task"]').trigger("click");
    await flushPromises();

    const presentationSlotId = store.selectedItemId;
    expect(presentationSlotId).toMatch(/^remote:/);
    expect(store.lastSelectedItemByRepo["cloud:repo-remote"]).toBe(presentationSlotId);
    mockWindowWorkspace.persistSelection.mockClear();

    await capturedKeyboardActions?.closeTask();
    await flushPromises();

    expect(relayCloseTaskMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-owner",
    });
    expect(store.selectedItemId).toBeNull();
    expect(store.lastSelectedItemByRepo["cloud:repo-remote"]).toBeUndefined();
    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: null,
    });
    expect(wrapper.find('[data-testid="remote-close-task"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("clears a restored durable last selection when closing the repository's only remote task", async () => {
    const snapshot = remoteTaskSnapshot("cloud", "desktop-owner", "task-owner");
    const [remoteTask] = snapshot.items;
    cloudTasksMock.mockResolvedValue(snapshot);
    store.selectedRepoId = remoteTask.repo_id;
    store.selectedRepo = null;
    store.selectedItemId = remoteTask.id;
    store.lastSelectedItemByRepo[remoteTask.repo_id] = remoteTask.id;

    const wrapper = await mountApp(RemoteTaskSelectionStub);
    mockWindowWorkspace.persistSelection.mockClear();

    await capturedKeyboardActions?.closeTask();
    await flushPromises();

    expect(relayCloseTaskMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-owner",
    });
    expect(store.selectedItemId).toBeNull();
    expect(store.lastSelectedItemByRepo[remoteTask.repo_id]).toBeUndefined();
    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: remoteTask.repo_id,
      selectedItemId: null,
    });

    wrapper.unmount();
  });

  it("selects the next remote sibling and then the parent when closing selected children", async () => {
    const snapshot = remoteChildCloseSnapshot();
    const [parent, childA, childB] = snapshot.items;
    cloudTasksMock.mockResolvedValue(snapshot);

    const wrapper = await mountApp(RemoteTaskSelectionStub);
    await wrapper.get(`[data-task-id="${childA.id}"]`).trigger("click");
    await flushPromises();
    mockWindowWorkspace.persistSelection.mockClear();

    await capturedKeyboardActions?.closeTask();
    await flushPromises();

    expect(relayCloseTaskMock).toHaveBeenNthCalledWith(1, {
      desktopId: "desktop-owner",
      taskId: "task-child-a",
    });
    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: childB.id,
    });
    expect(store.lastSelectedItemByRepo["cloud:repo-remote"]).toBe(store.selectedItemId);
    expect(wrapper.find(`[data-task-id="${childA.id}"]`).exists()).toBe(false);
    expect(wrapper.find(`[data-task-id="${childB.id}"]`).exists()).toBe(true);

    await capturedKeyboardActions?.closeTask();
    await flushPromises();

    expect(relayCloseTaskMock).toHaveBeenNthCalledWith(2, {
      desktopId: "desktop-owner",
      taskId: "task-child-b",
    });
    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: parent.id,
    });
    expect(store.lastSelectedItemByRepo["cloud:repo-remote"]).toBe(store.selectedItemId);
    expect(wrapper.find(`[data-task-id="${childB.id}"]`).exists()).toBe(false);
    expect(wrapper.find(`[data-task-id="${parent.id}"]`).exists()).toBe(true);

    wrapper.unmount();
  });

  it("keeps the originally prepared next sibling when the closing row disappears during owner close", async () => {
    const snapshot = remoteChildCloseSnapshot();
    const [parent, childA, childB, unrelated] = snapshot.items;
    const childC = {
      ...childB,
      id: "cloud:repo-remote:task-child-c",
      display_name: "Remote child C",
      created_at: "2026-07-24T00:03:00.000Z",
    };
    snapshot.items = [parent, childA, childB, childC, unrelated];
    snapshot.terminalRefs[childC.id] = {
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "owner-repo",
      ownerLocalTaskId: "task-child-c",
      transport: "cloud",
    };
    cloudTasksMock.mockResolvedValue(snapshot);
    const closeDeferred = createDeferred<void>();
    relayCloseTaskMock.mockImplementationOnce(() => closeDeferred.promise);

    const wrapper = await mountApp(RemoteTaskSelectionStub);
    await wrapper.get(`[data-task-id="${childB.id}"]`).trigger("click");
    await flushPromises();

    const closePromise = capturedKeyboardActions?.closeTask();
    await waitForCondition(() => relayCloseTaskMock.mock.calls.length === 1);
    emitDesktopCloudSnapshot({
      ...snapshot,
      items: snapshot.items.filter((item) => item.id !== childB.id),
      terminalRefs: Object.fromEntries(
        Object.entries(snapshot.terminalRefs).filter(([taskId]) => taskId !== childB.id),
      ),
    });
    await flushPromises();

    closeDeferred.resolve();
    await closePromise;
    await flushPromises();

    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: childC.id,
    });
    expect(mockWindowWorkspace.persistSelection).not.toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: childA.id,
    });
    expect(store.lastSelectedItemByRepo["cloud:repo-remote"]).toBe(store.selectedItemId);

    wrapper.unmount();
  });

  it("uses a prepared previous-sibling fallback when the closing row and next sibling disappear", async () => {
    const snapshot = remoteChildCloseSnapshot();
    const [parent, childA, childB, unrelated] = snapshot.items;
    const childC = {
      ...childB,
      id: "cloud:repo-remote:task-child-c",
      display_name: "Remote child C",
      created_at: "2026-07-24T00:03:00.000Z",
    };
    snapshot.items = [parent, childA, childB, childC, unrelated];
    snapshot.terminalRefs[childC.id] = {
      ownerDesktopId: "desktop-owner",
      ownerLocalRepoId: "owner-repo",
      ownerLocalTaskId: "task-child-c",
      transport: "cloud",
    };
    cloudTasksMock.mockResolvedValue(snapshot);
    const closeDeferred = createDeferred<void>();
    relayCloseTaskMock.mockImplementationOnce(() => closeDeferred.promise);

    const wrapper = await mountApp(RemoteTaskSelectionStub);
    await wrapper.get(`[data-task-id="${childB.id}"]`).trigger("click");
    await flushPromises();

    const closePromise = capturedKeyboardActions?.closeTask();
    await waitForCondition(() => relayCloseTaskMock.mock.calls.length === 1);
    const removedTaskIds = new Set([childB.id, childC.id]);
    emitDesktopCloudSnapshot({
      ...snapshot,
      items: snapshot.items.filter((item) => !removedTaskIds.has(item.id)),
      terminalRefs: Object.fromEntries(
        Object.entries(snapshot.terminalRefs).filter(([taskId]) => !removedTaskIds.has(taskId)),
      ),
    });
    await flushPromises();

    closeDeferred.resolve();
    await closePromise;
    await flushPromises();

    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: childA.id,
    });
    expect(store.lastSelectedItemByRepo["cloud:repo-remote"]).toBe(store.selectedItemId);

    wrapper.unmount();
  });

  it("replaces a restored durable remote selection after closing it", async () => {
    const snapshot = remoteChildCloseSnapshot();
    const [, childA, childB] = snapshot.items;
    cloudTasksMock.mockResolvedValue(snapshot);
    store.selectedRepoId = "cloud:repo-remote";
    store.selectedRepo = null;
    store.selectedItemId = childA.id;

    const wrapper = await mountApp(RemoteTaskSelectionStub);
    mockWindowWorkspace.persistSelection.mockClear();

    await capturedKeyboardActions?.closeTask();
    await flushPromises();

    expect(relayCloseTaskMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-child-a",
    });
    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: childB.id,
    });
    expect(wrapper.find(`[data-task-id="${childA.id}"]`).exists()).toBe(false);
    expect(wrapper.find(`[data-task-id="${childB.id}"]`).exists()).toBe(true);

    wrapper.unmount();
  });

  it("preserves newer remote navigation while an owner close is pending", async () => {
    const snapshot = remoteChildCloseSnapshot();
    const [, childA, , unrelated] = snapshot.items;
    cloudTasksMock.mockResolvedValue(snapshot);
    const closeDeferred = createDeferred<void>();
    relayCloseTaskMock.mockImplementationOnce(() => closeDeferred.promise);

    const wrapper = await mountApp(RemoteTaskSelectionStub);
    await wrapper.get(`[data-task-id="${childA.id}"]`).trigger("click");
    await flushPromises();

    const closePromise = capturedKeyboardActions?.closeTask();
    await waitForCondition(() => relayCloseTaskMock.mock.calls.length === 1);
    await wrapper.get(`[data-task-id="${unrelated.id}"]`).trigger("click");
    await flushPromises();
    const newerPresentationSlotId = store.selectedItemId;

    closeDeferred.resolve();
    await closePromise;
    await flushPromises();

    expect(store.selectedItemId).toBe(newerPresentationSlotId);
    expect(mockWindowWorkspace.persistSelection).toHaveBeenLastCalledWith({
      selectedRepoId: "cloud:repo-remote",
      selectedItemId: unrelated.id,
    });
    expect(wrapper.find(`[data-task-id="${childA.id}"]`).exists()).toBe(false);
    expect(wrapper.find(`[data-task-id="${unrelated.id}"]`).exists()).toBe(true);

    wrapper.unmount();
  });

  it("returns success and hides the closed row when replacement persistence fails", async () => {
    const snapshot = remoteChildCloseSnapshot();
    const [, childA, childB] = snapshot.items;
    cloudTasksMock.mockResolvedValue(snapshot);
    const reconciliationError = new Error("selection persistence failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapper = await mountApp(RemoteTaskSelectionStub);
    await wrapper.get(`[data-task-id="${childA.id}"]`).trigger("click");
    await flushPromises();
    mockWindowWorkspace.persistSelection.mockRejectedValueOnce(reconciliationError);

    const closeResult = await (
      wrapper.vm as unknown as { closeSelectedWorkspaceTask: () => Promise<boolean> }
    ).closeSelectedWorkspaceTask();
    await flushPromises();

    expect(closeResult).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      "[cloud] post-close reconciliation failed:",
      reconciliationError,
    );
    expect(toastErrorMock).toHaveBeenCalledWith(reconciliationError.message);
    expect(wrapper.find(`[data-task-id="${childA.id}"]`).exists()).toBe(false);
    expect(wrapper.find(`[data-task-id="${childB.id}"]`).exists()).toBe(true);
    expect(store.lastSelectedItemByRepo["cloud:repo-remote"]).toBe(store.selectedItemId);

    consoleError.mockRestore();
    wrapper.unmount();
  });

  it("normalizes a retained remote presentation slot to its local task slot without losing the highlight", async () => {
    const localTask: PipelineItem = {
      id: "task-owner",
      repo_id: "repo-1",
      issue_number: null,
      issue_title: null,
      prompt: "Task that arrives locally",
      workflow: "default",
      pipeline_def: null,
      stage: "in progress",
      pr_number: null,
      pr_url: null,
      branch: "task-owner",
      closed_at: null,
      agent_type: "pty",
      agent_provider: "claude",
      activity: "working",
      activity_changed_at: "2026-05-18T00:00:00.000Z",
      unread_at: null,
      port_offset: null,
      display_name: "Local owner task",
      last_output_preview: null,
      port_env: null,
      pinned: 0,
      pin_order: null,
      base_ref: "origin/main",
      agent_session_id: null,
      teardown_started_at: null,
      parent_task_id: null,
      notify_task_id: null,
      notified_at: null,
      created_at: "2026-05-18T00:00:00.000Z",
      updated_at: "2026-05-18T00:00:00.000Z",
    };
    const localItems = reactive<PipelineItem[]>([]);
    store.items = localItems;
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
        ...localTask,
        id: "cloud:repo-1:task-owner",
        workflow: "cloud",
        display_name: "Remote presentation",
      }],
      terminalRefs: {
        "cloud:repo-1:task-owner": {
          ownerDesktopId: "desktop-owner",
          ownerLocalRepoId: "repo-1",
          ownerLocalTaskId: "task-owner",
          transport: "cloud",
        },
      },
    });
    store.selectItem.mockImplementation(async (taskId: string) => {
      const slot = store.taskUiSlots.find((candidate) => candidate.task_id === taskId) ?? null;
      store.selectedItemId = slot?.slot_id ?? taskId;
      store.selectedTaskId = slot?.task_id ?? taskId;
      store.currentTaskSlot = slot;
      store.currentItem = slot?.task ?? null;
    });

    const SidebarOwnershipStub = defineComponent({
      name: "Sidebar",
      props: {
        taskSlots: { type: Array, default: () => [] },
        selectedSlotId: String,
      },
      emits: ["select-item"],
      template: `
        <div data-testid="ownership-sidebar">
          <button
            v-for="item in taskSlots"
            :key="item.slot_id"
            data-testid="ownership-task"
            :data-slot-id="item.slot_id"
            @click="$emit('select-item', item.slot_id)"
          >{{ item.display_name }}</button>
          <span data-testid="ownership-selected-slot">{{ selectedSlotId || "" }}</span>
          <span data-testid="ownership-row-count">{{ taskSlots.length }}</span>
        </div>
      `,
    });
    const MainPanelOwnershipStub = defineComponent({
      name: "MainPanel",
      props: {
        cloudTask: Boolean,
      },
      template: '<div data-testid="ownership-cloud-task">{{ String(cloudTask) }}</div>',
    });

    const wrapper = await mountAppWithOverrides(SidebarOwnershipStub, {
      MainPanel: MainPanelOwnershipStub,
    });
    await flushPromises();
    await flushPromises();

    const presentationSlotId = wrapper.get('[data-testid="ownership-task"]').attributes("data-slot-id");
    expect(presentationSlotId).toMatch(/^remote:/);
    await wrapper.get('[data-testid="ownership-task"]').trigger("click");
    await flushPromises();
    expect(store.selectedItemId).toBe(presentationSlotId);
    expect(wrapper.get('[data-testid="ownership-cloud-task"]').text()).toBe("true");

    store.taskUiSlots = [readyTaskSlot("slot:local-owner", localTask)];
    localItems.push(localTask);
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(store.selectItem).toHaveBeenCalledWith("task-owner", {
      recordNavigation: false,
    });
    expect(store.selectedItemId).toBe("slot:local-owner");
    expect(wrapper.get('[data-testid="ownership-row-count"]').text()).toBe("1");
    expect(wrapper.get('[data-testid="ownership-task"]').attributes("data-slot-id")).toBe(presentationSlotId);
    expect(wrapper.get('[data-testid="ownership-selected-slot"]').text()).toBe(presentationSlotId);
    expect(wrapper.get('[data-testid="ownership-cloud-task"]').text()).toBe("false");

    wrapper.unmount();
  });

  it("passes stable slot props through and keeps a local creating slot ahead of a matching cloud route", async () => {
    const creatingSlot: TaskUiSlot = {
      slot_id: "create:stable-local",
      task_id: "durable-pending",
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 1,
      draft: {
        repo_id: "repo-1",
        prompt: "Keep the local creation view stable",
        display_name: "Stable local task",
        workflow: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "claude",
        created_at: "2026-05-18T00:00:00.000Z",
      },
    };
    store.taskUiSlots = [creatingSlot];
    store.currentTaskSlot = creatingSlot;
    store.selectedItemId = creatingSlot.slot_id;
    store.selectedTaskId = creatingSlot.task_id;
    cloudTasksMock.mockResolvedValue({
      repos: [],
      items: [{
        id: "cloud:repo-1:durable-pending",
        repo_id: "repo-1",
        prompt: creatingSlot.draft.prompt,
        workflow: "cloud",
        stage: "in progress",
        pipeline_def: null,
        pr_number: null,
        pr_url: null,
        branch: "task-durable-pending",
        activity: "working",
        activity_changed_at: "2026-05-18T00:00:00.000Z",
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Cloud copy that must not win",
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "claude",
        agent_type: "pty",
        teardown_started_at: null,
        last_output_preview: null,
        parent_task_id: null,
        notify_task_id: null,
        notified_at: null,
        created_at: "2026-05-18T00:00:00.000Z",
        updated_at: "2026-05-18T00:00:00.000Z",
      }],
      terminalRefs: {
        "cloud:repo-1:durable-pending": {
          ownerDesktopId: "desktop-owner",
          ownerLocalRepoId: "repo-1",
          ownerLocalTaskId: "durable-pending",
          transport: "cloud",
        },
      },
    });

    const SidebarSlotStub = defineComponent({
      name: "Sidebar",
      props: {
        taskSlots: { type: Array, default: () => [] },
        selectedSlotId: String,
      },
      template: `
        <div data-testid="slot-sidebar">
          <span data-testid="selected-slot-id">{{ selectedSlotId }}</span>
          <span data-testid="projected-slot-id">{{ taskSlots[0]?.slot_id || "" }}</span>
        </div>
      `,
    });
    const MainPanelSlotStub = defineComponent({
      name: "MainPanel",
      props: {
        uiSlot: Object,
        cloudTask: Boolean,
      },
      template: `
        <div data-testid="slot-main-panel">
          <span data-testid="panel-slot-id">{{ uiSlot?.slot_id || "" }}</span>
          <span data-testid="panel-slot-state">{{ uiSlot?.state || "" }}</span>
          <span data-testid="panel-task-id">{{ uiSlot?.task?.id || "" }}</span>
          <span data-testid="panel-cloud-task">{{ String(cloudTask) }}</span>
        </div>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarSlotStub, {
      MainPanel: MainPanelSlotStub,
    });
    await flushPromises();
    await flushPromises();

    expect(wrapper.get('[data-testid="selected-slot-id"]').text()).toBe("create:stable-local");
    expect(wrapper.get('[data-testid="projected-slot-id"]').text()).toBe("create:stable-local");
    expect(wrapper.get('[data-testid="panel-slot-id"]').text()).toBe("create:stable-local");
    expect(wrapper.get('[data-testid="panel-slot-state"]').text()).toBe("creating");
    expect(wrapper.get('[data-testid="panel-task-id"]').text()).toBe("");
    expect(wrapper.get('[data-testid="panel-cloud-task"]').text()).toBe("true");

    wrapper.unmount();
  });

  it("selects an unacknowledged creating row by slot id without a workspace alias", async () => {
    const creatingSlot: TaskUiSlot = {
      slot_id: "create:without-workspace",
      task_id: null,
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 0,
      draft: {
        repo_id: "repo-1",
        prompt: "Select me before acknowledgement",
        display_name: "Creating without workspace",
        workflow: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "claude",
        created_at: "2026-05-18T00:00:00.000Z",
      },
    };
    store.taskUiSlots = [creatingSlot];

    const SidebarCreatingStub = defineComponent({
      name: "Sidebar",
      props: {
        taskSlots: { type: Array, default: () => [] },
      },
      emits: ["select-item"],
      template: `
        <button
          v-for="item in taskSlots"
          :key="item.slot_id"
          data-testid="creating-without-workspace"
          @click="$emit('select-item', item.slot_id)"
        >{{ item.display_name }}</button>
      `,
    });

    const wrapper = await mountApp(SidebarCreatingStub);
    await wrapper.get('[data-testid="creating-without-workspace"]').trigger("click");
    await flushPromises();

    expect(store.selectItem).toHaveBeenCalledWith(
      "create:without-workspace",
      expect.objectContaining({ recordNavigation: false }),
    );
    expect(mockWindowWorkspace.persistSelection).not.toHaveBeenCalledWith(expect.objectContaining({
      selectedItemId: "create:without-workspace",
    }));

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
        workflow: "cloud",
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
        uiSlot: Object,
        repoPath: String,
      },
      template: `
        <div data-testid="main-panel">
          <span data-testid="main-item-id">{{ uiSlot?.task?.id || "" }}</span>
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
        workflow: "cloud",
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
        uiSlot: Object,
        repoPath: String,
      },
      template: `
        <div data-testid="main-panel">
          <span data-testid="main-item-id">{{ uiSlot?.task?.id || "" }}</span>
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

  it("hides stale remote copies immediately after closing a matching local task", async () => {
    const localItems = reactive([{
      id: "task-local",
      repo_id: "repo-1",
      prompt: "Close local task",
      workflow: "default",
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
      display_name: "Local task",
      issue_number: null,
      issue_title: null,
      closed_at: null,
      agent_session_id: null,
      base_ref: "origin/main",
      agent_provider: "claude",
      agent_type: "pty",
      previous_stage: null,
      stage_result: null,
      teardown_started_at: null,
      last_output_preview: null,
      active_post_action: null,
      created_at: "2026-05-18T00:00:00.000Z",
      updated_at: "2026-05-18T00:00:00.000Z",
    }]);
    store.items = localItems;
    store.currentItem = store.items[0];
    store.selectedItemId = "task-local";
    store.closeTask.mockImplementationOnce(async () => {
      localItems.splice(0);
      store.currentItem = null;
      store.selectedItemId = null;
      return true;
    });
    cloudTasksMock.mockResolvedValue({
      repos: [],
      items: [{
        ...store.items[0],
        id: "cloud:repo-1:task-local",
        workflow: "cloud",
        display_name: "Remote copy",
      }],
      terminalRefs: {
        "cloud:repo-1:task-local": {
          ownerDesktopId: "desktop-a",
          ownerLocalRepoId: "repo-1",
          ownerLocalTaskId: "task-local",
          transport: "cloud",
        },
      },
    });

    const SidebarCaptureStub = defineComponent({
      name: "Sidebar",
      props: {
        taskSlots: { type: Array, default: () => [] },
      },
      template: `
        <div data-testid="sidebar-items">
          <span v-for="item in taskSlots" :key="item.slot_id" data-testid="sidebar-item">
            {{ item.task_id }}:{{ String(item.remote_task) }}
          </span>
        </div>
      `,
    });

    const wrapper = await mountApp(SidebarCaptureStub);
    await flushPromises();
    await flushPromises();
    expect(wrapper.findAll('[data-testid="sidebar-item"]').map((node) => node.text())).toEqual([
      "task-local:false",
    ]);

    expect(capturedKeyboardActions).not.toBeNull();
    await capturedKeyboardActions?.closeTask();
    await flushPromises();

    expect(store.closeTask).toHaveBeenCalled();
    expect(wrapper.findAll('[data-testid="sidebar-item"]').map((node) => node.text())).toEqual([]);

    wrapper.unmount();
  });

  it("routes Cmd+S to the owner when a reachable remote workspace task is selected", async () => {
    const advanceDeferred = createDeferred<void>();
    relayAdvanceStageMock.mockImplementationOnce(() => advanceDeferred.promise);
    const localFallbackItem = {
      id: "task-local",
      repo_id: "repo-1",
      prompt: "Local fallback",
      workflow: "default",
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
        workflow: "cloud",
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
        transition_revision: "run-owner-1",
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
        taskSlots: { type: Array, default: () => [] },
      },
      emits: ["select-item"],
      template: `
        <div data-testid="sidebar">
          <button
            v-for="item in taskSlots"
            :key="item.slot_id"
            :data-testid="\`task-\${item.task_id}\`"
            type="button"
            @click="$emit('select-item', item.slot_id)"
          >
            {{ item.display_name }}
          </button>
        </div>
      `,
    });

    const MainPanelTaskStub = defineComponent({
      name: "MainPanel",
      props: {
        uiSlot: Object,
      },
      template: '<div data-testid="main-item-id">{{ uiSlot?.task?.id || "" }}</div>',
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
    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayAdvanceStageMock.mock.calls.length > 0);

    expect(store.advanceStage).not.toHaveBeenCalled();
    expect(relayAdvanceStageMock).toHaveBeenCalledOnce();
    expect(relayAdvanceStageMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-owner",
      expectedTransitionRevision: "run-owner-1",
    });
    expect(relayCloseMock).not.toHaveBeenCalled();

    advanceDeferred.resolve();
    await waitForCondition(() => relayCloseMock.mock.calls.length === 1);
    expect(relayCloseMock).toHaveBeenCalled();

    capturedKeyboardActions?.advanceStage();
    await flushPromises();
    expect(relayAdvanceStageMock).toHaveBeenCalledOnce();

    wrapper.unmount();
  });

  it("integrates remote blocker snapshots with presentation and owner stage actions", async () => {
    const CloudTerminalStub = defineComponent({
      name: "CloudTerminalView",
      props: {
        ownerDesktopId: String,
        ownerTaskId: String,
      },
      template: `
        <div
          data-testid="remote-cloud-terminal"
          :data-owner-desktop-id="ownerDesktopId"
          :data-owner-task-id="ownerTaskId"
        />
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      Sidebar: false,
      MainPanel: false,
      TaskHeader: true,
      TerminalTabs: true,
      CloudTerminalView: CloudTerminalStub,
    });
    emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
      blocked: true,
      updatedAt: "2026-07-25T01:00:00.000Z",
    }));
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("sidebar.sectionBlocked");
    const blockedTask = wrapper.get(
      '[data-task-id="cloud:repo-remote:task-blocked"]',
    );
    expect(blockedTask.text()).toContain("Blocked remote task");
    expect(blockedTask.get(".blocked-by-text").text()).toBe(
      "sidebar.blockedBy Remote blocker",
    );

    await blockedTask.trigger("click");
    await flushPromises();

    expect(wrapper.get(".blocked-placeholder").text()).toContain("mainPanel.taskBlocked");
    expect(wrapper.get(".blocker-name").text()).toBe("Remote blocker");
    expect(wrapper.find('[data-testid="remote-cloud-terminal"]').exists()).toBe(false);

    capturedKeyboardActions?.advanceStage();
    await flushPromises();

    expect(toastWarningMock).toHaveBeenCalledWith("mainPanel.taskBlocked");
    expect(relayAdvanceStageMock).not.toHaveBeenCalled();
    expect(relayCloseMock).not.toHaveBeenCalled();
    expect(store.advanceStage).not.toHaveBeenCalled();

    emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      updatedAt: "2026-07-25T01:01:00.000Z",
    }));
    await flushPromises();
    expect(wrapper.find(".blocked-placeholder").exists()).toBe(false);
    expect(wrapper.get('[data-testid="remote-cloud-terminal"]').attributes("data-owner-task-id"))
      .toBe("task-blocked");
    relayAdvanceStageMock.mockRejectedValueOnce(
      Object.assign(new Error("task is blocked: task-blocked"), { status: 409 }),
    );
    toastErrorMock.mockClear();

    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayCloseMock.mock.calls.length === 1);

    expect(relayAdvanceStageMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-blocked",
      expectedTransitionRevision: "run-blocked-1",
    });
    expect(toastErrorMock).toHaveBeenCalledWith("task is blocked: task-blocked");
    expect(relayCloseMock).toHaveBeenCalledTimes(1);

    relayAdvanceStageMock.mockClear();
    relayCloseMock.mockClear();
    toastErrorMock.mockClear();
    emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      hasRunningPost: true,
      updatedAt: "2026-07-25T01:01:30.000Z",
    }));
    await flushPromises();

    capturedKeyboardActions?.advanceStage();
    await flushPromises();

    expect(relayAdvanceStageMock).not.toHaveBeenCalled();
    expect(relayCloseMock).not.toHaveBeenCalled();

    emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      updatedAt: "2026-07-25T01:02:00.000Z",
    }));
    await flushPromises();
    await flushPromises();

    expect(wrapper.find(".blocked-placeholder").exists()).toBe(false);
    expect(wrapper.find(".blocked-by-text").exists()).toBe(false);
    const restoredTerminal = wrapper.get('[data-testid="remote-cloud-terminal"]');
    expect(restoredTerminal.attributes("data-owner-desktop-id")).toBe("desktop-owner");
    expect(restoredTerminal.attributes("data-owner-task-id")).toBe("task-blocked");

    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayCloseMock.mock.calls.length === 1);

    expect(relayAdvanceStageMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-blocked",
      expectedTransitionRevision: "run-blocked-1",
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(relayCloseMock).toHaveBeenCalledTimes(1);
    expect(store.advanceStage).not.toHaveBeenCalled();

    capturedKeyboardActions?.advanceStage();
    await flushPromises();
    expect(relayAdvanceStageMock).toHaveBeenCalledTimes(1);

    emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      transitionRevision: "run-blocked-2",
      updatedAt: "2026-07-25T01:03:00.000Z",
    }));
    await flushPromises();

    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayAdvanceStageMock.mock.calls.length === 2);
    expect(relayAdvanceStageMock).toHaveBeenLastCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-blocked",
      expectedTransitionRevision: "run-blocked-2",
    });

    wrapper.unmount();
  });

  it("keeps a raw blocker blocked across Sidebar, MainPanel, and Cmd+S when another repo has a resolved identity collision", async () => {
    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      Sidebar: false,
      MainPanel: false,
      TaskHeader: true,
      TerminalTabs: true,
      CloudTerminalView: true,
    });
    emitDesktopCloudSnapshot(buildCrossRepoCollidingBlockerSnapshot());
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("sidebar.sectionBlocked");
    const blockedTask = wrapper.get(
      '[data-task-id="cloud:repo-remote:task-blocked"]',
    );
    expect(blockedTask.get(".blocked-by-text").text()).toBe(
      "sidebar.blockedBy tasks.taskId",
    );
    expect(blockedTask.text()).not.toContain("Resolved task from another repo");

    await blockedTask.trigger("click");
    await flushPromises();

    expect(wrapper.get(".blocked-placeholder").text()).toContain("mainPanel.taskBlocked");
    expect(wrapper.get(".blocker-name").text()).toBe("tasks.taskId");
    expect(wrapper.text()).not.toContain("https://github.com/kanna/kanna/pull/999");

    capturedKeyboardActions?.advanceStage();
    await flushPromises();

    expect(toastWarningMock).toHaveBeenCalledWith("mainPanel.taskBlocked");
    expect(relayAdvanceStageMock).not.toHaveBeenCalled();
    expect(lanAdvanceStageMock).not.toHaveBeenCalled();
    expect(store.advanceStage).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("integrates authoritative LAN blocker changes with Sidebar, MainPanel, and owner stage actions", async () => {
    vi.useFakeTimers();
    const blockedSnapshot = buildRemoteBlockedWorkflowSnapshot({
      blocked: true,
      transport: "lan",
      updatedAt: "2026-07-26T03:00:00.000Z",
    });
    const unblockedSnapshot = buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      transport: "lan",
      updatedAt: "2026-07-26T03:01:00.000Z",
    });
    lanTasksMock.mockResolvedValue(blockedSnapshot);

    const LanTerminalStub = defineComponent({
      name: "CloudTerminalView",
      props: {
        ownerDesktopId: String,
        ownerTaskId: String,
        transport: String,
      },
      template: `
        <div
          data-testid="remote-lan-terminal"
          :data-owner-desktop-id="ownerDesktopId"
          :data-owner-task-id="ownerTaskId"
          :data-transport="transport"
        />
      `,
    });
    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      Sidebar: false,
      MainPanel: false,
      TaskHeader: true,
      TerminalTabs: true,
      CloudTerminalView: LanTerminalStub,
    });
    await flushPromises();

    expect(wrapper.text()).toContain("sidebar.sectionBlocked");
    const blockedTask = wrapper.get(
      '[data-task-id="cloud:repo-remote:task-blocked"]',
    );
    expect(blockedTask.get(".blocked-by-text").text()).toBe(
      "sidebar.blockedBy Remote blocker",
    );

    await blockedTask.trigger("click");
    await flushPromises();

    expect(wrapper.get(".blocked-placeholder").text()).toContain("mainPanel.taskBlocked");
    expect(wrapper.get(".blocker-name").text()).toBe("Remote blocker");
    expect(wrapper.find('[data-testid="remote-lan-terminal"]').exists()).toBe(false);

    capturedKeyboardActions?.advanceStage();
    await flushPromises();

    expect(toastWarningMock).toHaveBeenCalledWith("mainPanel.taskBlocked");
    expect(lanAdvanceStageMock).not.toHaveBeenCalled();
    expect(relayAdvanceStageMock).not.toHaveBeenCalled();
    expect(store.advanceStage).not.toHaveBeenCalled();

    lanTasksMock.mockResolvedValue(unblockedSnapshot);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(wrapper.find(".blocked-placeholder").exists()).toBe(false);
    const terminal = wrapper.get('[data-testid="remote-lan-terminal"]');
    expect(terminal.attributes("data-owner-task-id")).toBe("task-blocked");
    expect(terminal.attributes("data-transport")).toBe("lan");

    lanAdvanceStageMock.mockRejectedValueOnce(
      Object.assign(new Error("task is blocked again: task-blocked"), { status: 409 }),
    );
    toastErrorMock.mockClear();
    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => lanCloseMock.mock.calls.length === 1);

    expect(lanTerminalClientFactoryMock).toHaveBeenCalled();
    expect(lanAdvanceStageMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-blocked",
      expectedTransitionRevision: "run-blocked-1",
    });
    expect(toastErrorMock).toHaveBeenCalledWith("task is blocked again: task-blocked");
    expect(relayTerminalClientFactoryMock).not.toHaveBeenCalled();
    expect(relayAdvanceStageMock).not.toHaveBeenCalled();
    expect(store.advanceStage).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("releases an accepted remote advance after a later authoritative snapshot keeps the same revision", async () => {
    const wrapper = await mountApp(RemoteTaskSelectionStub);
    emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      transitionRevision: "run-detached-failure",
      updatedAt: "2026-07-26T02:00:00.000Z",
    }));
    await flushPromises();

    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await flushPromises();
    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayAdvanceStageMock.mock.calls.length === 1);

    emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      transitionRevision: "run-detached-failure",
      updatedAt: "2026-07-26T02:00:00.000Z",
    }));
    await flushPromises();
    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayAdvanceStageMock.mock.calls.length === 2);

    expect(relayAdvanceStageMock).toHaveBeenCalledTimes(2);
    expect(relayAdvanceStageMock).toHaveBeenLastCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-blocked",
      expectedTransitionRevision: "run-detached-failure",
    });
    wrapper.unmount();
  });

  it("releases remote advance state when a task disappears and reappears at the same revision", async () => {
    const snapshot = buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      transitionRevision: "run-reappears",
      updatedAt: "2026-07-26T03:00:00.000Z",
    });
    const wrapper = await mountApp(RemoteTaskSelectionStub);
    emitDesktopCloudSnapshot(snapshot);
    await flushPromises();

    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await flushPromises();
    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayAdvanceStageMock.mock.calls.length === 1);

    emitDesktopCloudSnapshot({
      repos: [],
      items: [],
      terminalRefs: {},
      blockedByTaskIds: {},
    });
    await flushPromises();
    emitDesktopCloudSnapshot(snapshot);
    await flushPromises();
    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await flushPromises();
    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayAdvanceStageMock.mock.calls.length === 2);

    expect(relayAdvanceStageMock).toHaveBeenCalledTimes(2);
    expect(relayAdvanceStageMock).toHaveBeenLastCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-blocked",
      expectedTransitionRevision: "run-reappears",
    });
    wrapper.unmount();
  });

  it("advances an authenticated legacy remote snapshot without a CAS revision", async () => {
    const wrapper = await mountApp(RemoteTaskSelectionStub);
    emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
      blocked: false,
      transitionRevision: null,
      updatedAt: "2026-07-26T04:00:00.000Z",
    }));
    await flushPromises();

    await wrapper.get('[data-testid="remote-task"]').trigger("click");
    await flushPromises();
    capturedKeyboardActions?.advanceStage();
    await waitForCondition(() => relayAdvanceStageMock.mock.calls.length === 1);

    expect(relayAdvanceStageMock).toHaveBeenCalledWith({
      desktopId: "desktop-owner",
      taskId: "task-blocked",
    });
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      "Remote task snapshot is missing its transition revision.",
    );
    wrapper.unmount();
  });

  it.each([
    {
      label: "revisioned snapshot",
      initialRevision: "run-before-route-replacement",
      replacementRevision: "run-after-route-replacement",
    },
    {
      label: "legacy snapshot without transition revisions",
      initialRevision: null,
      replacementRevision: null,
    },
  ])(
    "does not send through a delayed client after replacing a $label",
    async ({ initialRevision, replacementRevision }) => {
      const firstClient = createDeferred<{
        advanceStage: typeof relayAdvanceStageMock;
        close: typeof relayCloseMock;
      }>();
      const replacementClient = createDeferred<{
        advanceStage: typeof relayAdvanceStageMock;
        close: typeof relayCloseMock;
      }>();
      const staleAdvance = vi.fn(async () => {});
      const staleClose = vi.fn();
      relayTerminalClientFactoryMock
        .mockImplementationOnce(() => firstClient.promise)
        .mockImplementationOnce(() => replacementClient.promise);
      const wrapper = await mountApp(RemoteTaskSelectionStub);
      emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
        blocked: false,
        transitionRevision: initialRevision,
        updatedAt: "2026-07-26T05:00:00.000Z",
      }));
      await flushPromises();

      await wrapper.get('[data-testid="remote-task"]').trigger("click");
      await flushPromises();
      capturedKeyboardActions?.advanceStage();
      await waitForCondition(() => relayTerminalClientFactoryMock.mock.calls.length === 1);

      emitDesktopCloudSnapshot(buildRemoteBlockedWorkflowSnapshot({
        blocked: false,
        transitionRevision: replacementRevision,
        updatedAt: "2026-07-26T05:01:00.000Z",
      }));
      await flushPromises();
      capturedKeyboardActions?.advanceStage();
      await waitForCondition(() => relayTerminalClientFactoryMock.mock.calls.length === 2);

      firstClient.resolve({
        advanceStage: staleAdvance,
        close: staleClose,
      });
      await flushPromises();

      expect(staleAdvance).not.toHaveBeenCalled();
      expect(staleClose).toHaveBeenCalledOnce();
      wrapper.unmount();
    },
  );

  it("renders the modal with the preferred existing base branch selected", async () => {
    const wrapper = await mountApp(SidebarWithRepoStub);

    await flushPromises();
    await wrapper.get('[data-testid="open-new-task"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("origin/main");
  });

  it("opens New Task submit-ready on the repository's most recently used workflow", async () => {
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default", "single-reviewer"],
      }),
      fetchRepoRecentWorkflows: async () => ["single-reviewer"],
    });

    const wrapper = await mountApp(SidebarWithRepoStub);
    try {
      await wrapper.get('[data-testid="open-new-task"]').trigger("click");
      // Wait for the resolved state rather than a fixed number of flushes: the
      // modal has to leave its loading state deterministically, not eventually.
      await waitForCondition(
        () => !wrapper.find('[data-testid="task-options-loading"]').exists(),
        20,
      );

      expect(wrapper.find('[data-testid="task-options-loading"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="workflow-value"]').text()).toBe("single-reviewer");
      expect(wrapper.get('[data-testid="workflow-toggle"]').attributes("disabled")).toBeUndefined();
      expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("origin/main");
      expect(wrapper.get('[data-testid="base-branch-toggle"]').attributes("disabled")).toBeUndefined();

      // Submit-ready: a prompt is all that stands between the operator and a
      // create, and the create carries the sticky workflow.
      await wrapper.get("textarea").setValue("Ship the sticky workflow");
      expect(wrapper.get(".modal-overlay .btn-primary").attributes("disabled")).toBeUndefined();
      await wrapper.get(".modal-overlay .btn-primary").trigger("click");
      await flushPromises();

      expect(store.createItem).toHaveBeenCalledWith(
        "repo-1",
        expect.any(String),
        "Ship the sticky workflow",
        "pty",
        expect.objectContaining({ workflowName: "single-reviewer" }),
      );
    } finally {
      wrapper.unmount();
    }
  });

  it("keeps sidebar tasks visible and opens New Task with an error when definitions fail", async () => {
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => {
        throw new Error("definition endpoint unavailable");
      },
    });
    store.items = [{
      id: "task-visible",
      repo_id: "repo-1",
      prompt: "Keep this task visible",
      stage: "in progress",
      tags: "[]",
      pinned: 0,
      pin_order: null,
      created_at: "2026-07-16T00:00:00.000Z",
      updated_at: "2026-07-16T00:00:00.000Z",
    }];
    store.taskUiSlots = [readyTaskSlot("slot:visible", store.items[0])];
    const SidebarWithTaskStub = defineComponent({
      name: "Sidebar",
      props: {
        taskSlots: { type: Array, default: () => [] },
      },
      emits: ["new-task"],
      template: `
        <div>
          <span v-for="slot in taskSlots" :key="slot.slot_id" data-testid="sidebar-task">
            {{ slot.task_id }}
          </span>
          <button data-testid="open-new-task" @click="$emit('new-task', 'repo-1')">open</button>
        </div>
      `,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wrapper = await mountApp(SidebarWithTaskStub);
    try {
      expect(wrapper.get('[data-testid="sidebar-task"]').text()).toBe("task-visible");
      await wrapper.get('[data-testid="open-new-task"]').trigger("click");
      await flushPromises();
      await flushPromises();

      expect(wrapper.get('[data-testid="sidebar-task"]').text()).toBe("task-visible");
      expect(wrapper.find("textarea").exists()).toBe(true);
      expect(toastErrorMock).toHaveBeenCalledWith(
        "toasts.repoDefinitionsFailed: definition endpoint unavailable",
      );
    } finally {
      consoleError.mockRestore();
      wrapper.unmount();
    }
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
        workflow: "cloud",
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
    await vi.waitFor(() => {
      expect(store.createItem).toHaveBeenCalledWith(
        "repo-imported",
        "/Users/test/.kanna/repos/remote-repo",
        "Create task from remote repo",
        "pty",
        expect.objectContaining({
          baseBranch: "origin/main",
        }),
      );
    });

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
      "pty",
      expect.objectContaining({
        agentProvider: "claude",
        workflowName: "default",
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      "pty",
      expect.objectContaining({
        baseBranch: "main",
      }),
    );
  });
  it("skips blocked tasks when navigating to the oldest read task", async () => {
    store.sortedItemsForCurrentRepo = [
      { id: "blocked-oldest", activity: "idle", created_at: "2026-03-31T00:00:00.000Z", tags: "[]" },
      { id: "read-oldest", activity: "idle", created_at: "2026-03-31T01:00:00.000Z", tags: "[]" },
      { id: "read-newest", activity: "idle", created_at: "2026-03-31T03:00:00.000Z", tags: "[]" },
      { id: "blocked-newest", activity: "idle", created_at: "2026-03-31T04:00:00.000Z", tags: "[]" },
    ];
    store.taskBlockers = [
      { blocked_item_id: "blocked-oldest", blocker_item_id: "blocker" },
      { blocked_item_id: "blocked-newest", blocker_item_id: "blocker" },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestRead();
    expect(store.selectItem).toHaveBeenCalledWith(
      "read-oldest",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("skips pinned tasks when navigating to the oldest read task", async () => {
    store.sortedItemsForCurrentRepo = [
      { id: "pinned-oldest", activity: "idle", created_at: "2026-03-31T00:00:00.000Z", tags: "[]", pinned: 1 },
      { id: "read-oldest", activity: "idle", created_at: "2026-03-31T01:00:00.000Z", tags: "[]", pinned: 0 },
      { id: "read-newest", activity: "idle", created_at: "2026-03-31T03:00:00.000Z", tags: "[]", pinned: 0 },
      { id: "pinned-newest", activity: "idle", created_at: "2026-03-31T04:00:00.000Z", tags: "[]", pinned: 1 },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestRead();
    expect(store.selectItem).toHaveBeenCalledWith(
      "read-oldest",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("navigates to the absolute oldest read task", async () => {
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
    expect(store.selectItem).toHaveBeenCalledWith(
      "read-oldest",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("opens a new window through the workspace controller using the current selection", async () => {
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-1";
    store.selectedTaskId = "task-1";

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.newWindow();

    expect(mockWindowWorkspace.openWindow).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
    });
  });

  it("safely closes the focused window through the workspace controller", async () => {
    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.closeWindow();

    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.notifyWindowMembershipChanged).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.destroyNativeWindow).toHaveBeenCalledTimes(1);
    expect(nativeWindowDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("opens a new window when the native window-open event arrives", async () => {
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-1";
    store.selectedTaskId = "task-1";

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

  it("safely closes the current window when the native window-close event arrives", async () => {
    await mountApp(SidebarWithRepoStub);
    expect(listenHandlers.has(WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT)).toBe(false);
    const handler = currentWebviewWindowListenHandlers.get(WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT);
    expect(handler).toBeTypeOf("function");

    await handler?.({});

    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.notifyWindowMembershipChanged).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.destroyNativeWindow).toHaveBeenCalledTimes(1);
    expect(nativeWindowDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("persists workspace closure before explicitly destroying the native window", async () => {
    await mountApp(SidebarWithRepoStub);
    const handler = await waitForNativeCloseRequestedHandler();
    expect(handler).toBeTypeOf("function");
    const event = { preventDefault: vi.fn() };

    await handler?.(event);

    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.closeWindow).not.toHaveBeenCalled();
    expect(mockWindowWorkspace.notifyWindowMembershipChanged).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.destroyNativeWindow).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(nativeWindowDestroyMock).toHaveBeenCalledTimes(1);
  });

  it("prevents overlapping native closes until membership removal completes", async () => {
    const removal = createDeferred<null>();
    mockWindowWorkspace.forgetCurrentWindow.mockImplementationOnce(
      async () => removal.promise,
    );
    const wrapper = await mountApp(SidebarWithRepoStub);
    expect(await waitForNativeCloseRequestedHandler()).toBeTypeOf("function");

    const firstClose = dispatchNativeCloseRequest();
    await flushPromises();
    const secondClose = dispatchNativeCloseRequest();
    await secondClose.completion;

    expect(firstClose.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(secondClose.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.destroyNativeWindow).not.toHaveBeenCalled();
    expect(nativeWindowDestroyMock).not.toHaveBeenCalled();

    removal.resolve(null);
    await firstClose.completion;

    expect(mockWindowWorkspace.notifyWindowMembershipChanged).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.destroyNativeWindow).toHaveBeenCalledTimes(1);
    expect(nativeWindowDestroyMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it("prevents overlapping native closes while workspace initialization is pending", async () => {
    const initialization = createDeferred<void>();
    mockWindowWorkspace.initialize.mockImplementationOnce(
      async () => initialization.promise,
    );
    const wrapper = await mountApp(SidebarWithRepoStub);
    expect(await waitForNativeCloseRequestedHandler()).toBeTypeOf("function");

    const firstClose = dispatchNativeCloseRequest();
    await flushPromises();
    const secondClose = dispatchNativeCloseRequest();
    await secondClose.completion;

    expect(firstClose.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(secondClose.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.forgetCurrentWindow).not.toHaveBeenCalled();
    expect(mockWindowWorkspace.destroyNativeWindow).not.toHaveBeenCalled();
    expect(nativeWindowDestroyMock).not.toHaveBeenCalled();

    initialization.resolve();
    await firstClose.completion;

    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.destroyNativeWindow).toHaveBeenCalledTimes(1);
    expect(nativeWindowDestroyMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it("prevents overlapping native closes while final window destruction is pending", async () => {
    const finalDestruction = createDeferred<void>();
    mockWindowWorkspace.destroyNativeWindow.mockImplementationOnce(async () => {
      await finalDestruction.promise;
      await nativeWindowDestroyMock();
    });
    const wrapper = await mountApp(SidebarWithRepoStub);
    expect(await waitForNativeCloseRequestedHandler()).toBeTypeOf("function");

    const firstClose = dispatchNativeCloseRequest();
    await waitForCondition(
      () => mockWindowWorkspace.destroyNativeWindow.mock.calls.length === 1,
    );
    const secondClose = dispatchNativeCloseRequest();
    await secondClose.completion;

    expect(firstClose.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(secondClose.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.destroyNativeWindow).toHaveBeenCalledTimes(1);
    expect(nativeWindowDestroyMock).not.toHaveBeenCalled();

    finalDestruction.resolve();
    await firstClose.completion;

    expect(nativeWindowDestroyMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
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
    expect(mockWindowWorkspace.destroyNativeWindow).not.toHaveBeenCalled();
    expect(nativeWindowDestroyMock).not.toHaveBeenCalled();
  });

  it("restores window membership when final native destruction fails", async () => {
    const removedWindow = {
      windowId: "main",
      selectedRepoId: "repo-1",
      selectedItemId: "task-1",
      sidebarHidden: true,
      sidebarWidth: 347,
      order: 0,
    };
    mockWindowWorkspace.forgetCurrentWindow.mockResolvedValue(removedWindow);
    mockWindowWorkspace.destroyNativeWindow.mockRejectedValueOnce(
      new Error("destroy failed"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapper = await mountApp(SidebarWithRepoStub);

    const firstClose = dispatchNativeCloseRequest();
    await firstClose.completion;

    expect(firstClose.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.restoreCurrentWindow).toHaveBeenCalledWith(removedWindow);
    expect(mockWindowWorkspace.notifyWindowMembershipChanged).toHaveBeenCalledTimes(2);
    expect(nativeWindowDestroyMock).not.toHaveBeenCalled();

    const retryClose = dispatchNativeCloseRequest();
    await retryClose.completion;

    expect(retryClose.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockWindowWorkspace.forgetCurrentWindow).toHaveBeenCalledTimes(2);
    expect(mockWindowWorkspace.destroyNativeWindow).toHaveBeenCalledTimes(2);
    expect(nativeWindowDestroyMock).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
    wrapper.unmount();
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

    expect(store.selectItem).toHaveBeenCalledWith("task-old", {
      previousItemId: "task-new",
      recordNavigation: false,
    });
  });

  it("navigates task shortcuts in the same order the sidebar renders stage groups", async () => {
    store.selectedRepoId = "repo-1";
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
    store.taskUiSlots = [
      readyTaskSlot("slot:pr", store.items[0]),
      readyTaskSlot("slot:progress", store.items[1]),
    ];
    store.selectedItemId = "slot:progress";
    store.selectedTaskId = "task-progress";
    store.currentTaskSlot = store.taskUiSlots[1];
    store.selectItem.mockImplementationOnce(async (taskId: string) => {
      const slot = store.taskUiSlots.find((candidate) => candidate.task_id === taskId) ?? null;
      store.selectedItemId = slot?.slot_id ?? taskId;
      store.selectedTaskId = slot?.task_id ?? taskId;
      store.currentTaskSlot = slot;
    });

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.navigateDown();

    expect(store.selectItem).toHaveBeenCalledWith("task-pr", {
      previousItemId: "slot:progress",
      recordNavigation: false,
    });
    expect(store.selectedItemId).toBe("slot:pr");
  });

  it("navigates task shortcuts across repo boundaries in sidebar order", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
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
    store.taskUiSlots = [
      readyTaskSlot("slot:one", store.items[0]),
      readyTaskSlot("slot:two", store.items[1]),
    ];
    store.selectedItemId = "slot:one";
    store.selectedTaskId = "task-one";
    store.currentTaskSlot = store.taskUiSlots[0];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.navigateDown();
    await flushPromises();

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2", {
      persistWindowSelection: false,
    });
    expect(store.selectItem).toHaveBeenCalledWith("task-two", {
      previousItemId: "slot:one",
      recordNavigation: false,
    });
  });

  it("routes a cross-repo sidebar row click through the atomic selection path", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
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
    store.taskUiSlots = [
      readyTaskSlot("slot:one", store.items[0]),
      readyTaskSlot("slot:two", store.items[1]),
    ];
    store.selectedItemId = "slot:one";
    store.selectedTaskId = "task-one";
    store.currentTaskSlot = store.taskUiSlots[0];

    const SidebarRowStub = defineComponent({
      name: "Sidebar",
      props: {
        taskSlots: { type: Array, default: () => [] },
      },
      emits: ["select-item"],
      template: `
        <button
          v-for="item in taskSlots"
          :key="item.slot_id"
          :data-testid="'sidebar-task-' + item.slot_id"
          @click="$emit('select-item', item.slot_id)"
        >{{ item.display_name }}</button>
      `,
    });

    const wrapper = await mountApp(SidebarRowStub);
    await wrapper.get('[data-testid="sidebar-task-slot:two"]').trigger("click");
    await flushPromises();

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2", {
      persistWindowSelection: false,
    });
    expect(store.recordNavigation).toHaveBeenCalledWith("slot:two", "slot:one");
    expect(store.selectItem).toHaveBeenCalledWith("task-two", {
      previousItemId: "slot:one",
      recordNavigation: false,
    });

    wrapper.unmount();
  });

  it("keeps unread task shortcuts scoped to the selected repo before falling back to read tasks", async () => {
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
        id: "task-read-oldest",
        repo_id: "repo-1",
        prompt: "Repo one oldest read task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T09:00:00.000Z",
        updated_at: "2026-04-17T09:00:00.000Z",
      },
      {
        id: "task-read",
        repo_id: "repo-1",
        prompt: "Repo one current read task",
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

    expect(store.selectRepo).not.toHaveBeenCalled();
    expect(store.selectItem).toHaveBeenCalledWith(
      "task-read-oldest",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("keeps read task shortcuts scoped to the selected repo", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-current";
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" };
    store.currentItem = {
      id: "task-current",
      repo_id: "repo-1",
      activity: "idle",
      created_at: "2026-04-17T10:00:00.000Z",
      tags: "[]",
      stage: "in progress",
    };
    store.items = [
      {
        id: "task-current",
        repo_id: "repo-1",
        prompt: "Repo one current task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T10:00:00.000Z",
        updated_at: "2026-04-17T10:00:00.000Z",
      },
      {
        id: "task-read-other-repo",
        repo_id: "repo-2",
        prompt: "Repo two older read task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T09:00:00.000Z",
        updated_at: "2026-04-17T09:00:00.000Z",
      },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.goToOldestRead();
    await flushPromises();

    expect(store.selectRepo).not.toHaveBeenCalled();
    expect(store.selectItem).toHaveBeenCalledWith(
      "task-current",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("uses the all-repos unread action to select the oldest eligible unread task across visible repos", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "current";
    store.selectedTaskId = "current";
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" };
    sidebarSearchQuery.value = "global shortcut";
    store.items = [
      {
        id: "hidden-unread",
        repo_id: "repo-hidden",
        prompt: "Global shortcut hidden unread task",
        stage: "in progress",
        activity: "unread",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      },
      {
        id: "search-filtered-unread",
        repo_id: "repo-1",
        prompt: "Older ordinary unread task",
        stage: "in progress",
        activity: "unread",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T01:00:00.000Z",
        updated_at: "2026-04-17T01:00:00.000Z",
      },
      {
        id: "pinned-unread",
        repo_id: "repo-2",
        prompt: "Global shortcut pinned unread task",
        stage: "in progress",
        activity: "unread",
        tags: "[]",
        pinned: 1,
        pin_order: 0,
        created_at: "2026-04-17T02:00:00.000Z",
        updated_at: "2026-04-17T02:00:00.000Z",
      },
      {
        id: "teardown-unread",
        repo_id: "repo-1",
        prompt: "Global shortcut teardown unread task",
        stage: "pr",
        teardown_started_at: "2026-04-17T03:30:00.000Z",
        activity: "unread",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T03:00:00.000Z",
        updated_at: "2026-04-17T03:30:00.000Z",
      },
      {
        id: "target-unread",
        repo_id: "repo-2",
        prompt: "Global shortcut target unread task",
        stage: "in progress",
        activity: "unread",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T04:00:00.000Z",
        updated_at: "2026-04-17T04:00:00.000Z",
      },
      {
        id: "later-unread",
        repo_id: "repo-1",
        prompt: "Global shortcut later unread task",
        stage: "in progress",
        activity: "unread",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T05:00:00.000Z",
        updated_at: "2026-04-17T05:00:00.000Z",
      },
      {
        id: "current",
        repo_id: "repo-1",
        prompt: "Global shortcut current working task",
        stage: "in progress",
        activity: "working",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T06:00:00.000Z",
        updated_at: "2026-04-17T06:00:00.000Z",
      },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.goToOldestUnreadAllRepos();
    await flushPromises();

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2", {
      persistWindowSelection: false,
    });
    expect(store.selectItem).toHaveBeenCalledWith("target-unread", {
      previousItemId: "current",
      recordNavigation: false,
    });
  });

  it("the all-repos unread action does nothing when the global search result is empty", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "current";
    store.selectedTaskId = "current";
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" };
    sidebarSearchQuery.value = "matching target";
    store.sortedItemsAllRepos = [
      {
        id: "unfiltered-unread",
        repo_id: "repo-2",
        prompt: "Ordinary unread task",
        stage: "in progress",
        activity: "unread",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.goToOldestUnreadAllRepos();
    await flushPromises();

    expect(store.selectRepo).not.toHaveBeenCalled();
    expect(store.selectItem).not.toHaveBeenCalled();
  });

  it("uses the all-repos unread action to fall back to the oldest eligible read task across visible repos", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "current";
    store.selectedTaskId = "current";
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" };
    store.items = [
      {
        id: "blocked-read",
        repo_id: "repo-1",
        prompt: "Blocked oldest read task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      },
      {
        id: "target-read-fallback",
        repo_id: "repo-2",
        prompt: "Target read fallback task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T01:00:00.000Z",
        updated_at: "2026-04-17T01:00:00.000Z",
      },
      {
        id: "current",
        repo_id: "repo-1",
        prompt: "Current read task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T02:00:00.000Z",
        updated_at: "2026-04-17T02:00:00.000Z",
      },
      {
        id: "blocker",
        repo_id: "repo-1",
        prompt: "Unresolved blocker",
        stage: "in progress",
        activity: "working",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T03:00:00.000Z",
        updated_at: "2026-04-17T03:00:00.000Z",
      },
    ];
    store.taskBlockers = [
      { blocked_item_id: "blocked-read", blocker_item_id: "blocker" },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.goToOldestUnreadAllRepos();
    await flushPromises();

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2", {
      persistWindowSelection: false,
    });
    expect(store.selectItem).toHaveBeenCalledWith("target-read-fallback", {
      previousItemId: "current",
      recordNavigation: false,
    });
  });

  it("uses the all-repos read action to select the oldest read task across visible repos", async () => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "current";
    store.selectedTaskId = "current";
    store.selectedRepo = { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" };
    store.items = [
      {
        id: "older-working",
        repo_id: "repo-2",
        prompt: "Older working task",
        stage: "in progress",
        activity: "working",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      },
      {
        id: "target-read",
        repo_id: "repo-2",
        prompt: "Target oldest read task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T01:00:00.000Z",
        updated_at: "2026-04-17T01:00:00.000Z",
      },
      {
        id: "current",
        repo_id: "repo-1",
        prompt: "Current read task",
        stage: "in progress",
        activity: "idle",
        tags: "[]",
        pinned: 0,
        pin_order: null,
        created_at: "2026-04-17T02:00:00.000Z",
        updated_at: "2026-04-17T02:00:00.000Z",
      },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    await capturedKeyboardActions?.goToOldestReadAllRepos();
    await flushPromises();

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2", {
      persistWindowSelection: false,
    });
    expect(store.selectItem).toHaveBeenCalledWith("target-read", {
      previousItemId: "current",
      recordNavigation: false,
    });
  });

  it.each([
    { label: "presentation slot", rememberedSelection: "slot:two" },
    { label: "durable task id", rememberedSelection: "task-two" },
  ])("navigates repos when the native event remembers a $label", async ({ rememberedSelection }) => {
    store.repos = [
      { id: "repo-1", path: "/tmp/repo-1", name: "repo 1" },
      { id: "repo-2", path: "/tmp/repo-2", name: "repo 2" },
    ];
    store.selectedRepoId = "repo-1";
    store.selectedItemId = "task-one";
    store.items = [
      { id: "task-two", repo_id: "repo-2", stage: "in progress" },
    ];
    store.taskUiSlots = [readyTaskSlot("slot:two", store.items[0])];
    store.sortedItemsAllRepos = [
      { id: "task-one", repo_id: "repo-1" },
      { id: "task-two", repo_id: "repo-2" },
    ];
    store.lastSelectedItemByRepo = { "repo-2": rememberedSelection };

    await mountApp(SidebarWithRepoStub);
    expect(listenHandlers.has(WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT)).toBe(false);
    const handler = currentWebviewWindowListenHandlers.get(WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT);
    expect(handler).toBeTypeOf("function");

    await handler?.({});

    expect(store.selectRepo).toHaveBeenCalledWith("repo-2", {
      persistWindowSelection: false,
    });
    expect(store.selectItem).toHaveBeenCalledWith("task-two", {
      previousItemId: "task-one",
      recordNavigation: false,
    });
  });

  it("skips teardown tasks when navigating to unread tasks", async () => {
    store.sortedItemsForCurrentRepo = [
      { id: "teardown-unread", activity: "unread", created_at: "2026-03-31T00:00:00.000Z", tags: "[]", stage: "pr", teardown_started_at: "2026-05-08T00:00:00.000Z" },
      { id: "normal-unread", activity: "unread", created_at: "2026-03-31T01:00:00.000Z", tags: "[]", stage: "in progress" },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestUnread();
    expect(store.selectItem).toHaveBeenCalledWith(
      "normal-unread",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("navigates to the absolute oldest unread task", async () => {
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
    expect(store.selectItem).toHaveBeenCalledWith(
      "unread-oldest",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("skips pinned tasks when navigating to the oldest unread task", async () => {
    store.sortedItemsForCurrentRepo = [
      { id: "pinned-oldest", activity: "unread", created_at: "2026-03-31T00:00:00.000Z", tags: "[]", pinned: 1 },
      { id: "unread-oldest", activity: "unread", created_at: "2026-03-31T01:00:00.000Z", tags: "[]", pinned: 0 },
      { id: "unread-newest", activity: "unread", created_at: "2026-03-31T03:00:00.000Z", tags: "[]", pinned: 0 },
      { id: "pinned-newest", activity: "unread", created_at: "2026-03-31T04:00:00.000Z", tags: "[]", pinned: 1 },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestUnread();
    expect(store.selectItem).toHaveBeenCalledWith(
      "unread-oldest",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("falls back to absolute read tasks when unread shortcut navigation has no unread task", async () => {
    store.currentItem = { id: "current", created_at: "2026-03-31T02:30:00.000Z" };
    store.sortedItemsForCurrentRepo = [
      { id: "blocked-oldest", activity: "idle", created_at: "2026-03-31T00:00:00.000Z", tags: "[]" },
      { id: "read-oldest", activity: "idle", created_at: "2026-03-31T01:00:00.000Z", tags: "[]" },
      { id: "read-near-older", activity: "idle", created_at: "2026-03-31T02:00:00.000Z", tags: "[]" },
      { id: "current", activity: "idle", created_at: "2026-03-31T02:30:00.000Z", tags: "[]" },
      { id: "read-near-newer", activity: "idle", created_at: "2026-03-31T02:45:00.000Z", tags: "[]" },
      { id: "read-newest", activity: "idle", created_at: "2026-03-31T03:00:00.000Z", tags: "[]" },
      { id: "blocked-newest", activity: "idle", created_at: "2026-03-31T04:00:00.000Z", tags: "[]" },
    ];
    store.taskBlockers = [
      { blocked_item_id: "blocked-oldest", blocker_item_id: "blocker" },
      { blocked_item_id: "blocked-newest", blocker_item_id: "blocker" },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestUnread();
    expect(store.selectItem).toHaveBeenCalledWith(
      "read-oldest",
      expect.objectContaining({ recordNavigation: false }),
    );
  });

  it("skips pinned read tasks when unread shortcut navigation falls back to read tasks", async () => {
    store.sortedItemsForCurrentRepo = [
      { id: "pinned-oldest", activity: "idle", created_at: "2026-03-31T00:00:00.000Z", tags: "[]", pinned: 1 },
      { id: "read-oldest", activity: "idle", created_at: "2026-03-31T01:00:00.000Z", tags: "[]", pinned: 0 },
      { id: "read-newest", activity: "idle", created_at: "2026-03-31T03:00:00.000Z", tags: "[]", pinned: 0 },
      { id: "pinned-newest", activity: "idle", created_at: "2026-03-31T04:00:00.000Z", tags: "[]", pinned: 1 },
    ];

    await mountApp(SidebarWithRepoStub);
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.goToOldestUnread();
    expect(store.selectItem).toHaveBeenCalledWith(
      "read-oldest",
      expect.objectContaining({ recordNavigation: false }),
    );
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
          windowWorkspace: mockWindowWorkspace,
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      repo_id: "repo-1",
      closed_at: null,
      stage: "in progress",
      branch: "task-1",
      prompt: "Fix handoff",
      tags: "[]",
    };
    store.items = [store.currentItem];
    store.selectedItemId = "task-1";

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
        workflow: "cloud",
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

  it("uses the server repo catalog and launches factory commands through it", async () => {
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

    const createConfigButton = wrapper.get('[data-command-id="factory:create-config"]');
    expect(wrapper.get('[data-command-id="factory:create-agent"]').text()).toBe("Create Agent");
    expect(wrapper.get('[data-command-id="factory:create-workflow"]').text()).toBe("Create Workflow");
    expect(wrapper.get('[data-command-id="factory:setup-repo"]').text()).toBe("Set Up Repository");
    expect(wrapper.get('[data-command-id="factory:setup-repo"]').attributes("data-command-description")).toBe("Configure .kanna workflow and agent flavors");
    expect(createConfigButton.text()).toBe("Create Config");
    expect(createConfigButton.attributes("data-command-description")).toBe("Create or update .kanna/config.json");

    await wrapper.get('[data-command-id="factory:setup-repo"]').trigger("click");
    await flushPromises();

    expect(store.selectItem).toHaveBeenCalledWith("repo-command-task");
    store.selectItem.mockClear();

    await createConfigButton.trigger("click");
    await flushPromises();
    expect(store.selectItem).toHaveBeenCalledWith("repo-command-task");
  });

  it("launches the setup agent after importing an unconfigured repository from AddRepoModal", async () => {
    store.importRepo.mockResolvedValueOnce("repo-imported");
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "file_exists") return false;
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_repository_has_commits") return true;
      if (command === "git_repository_state") {
        return { defaultBranch: "main", hasCommits: true };
      }
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
      throw new Error(`unexpected invoke: ${command}`);
    });

    const AddRepoModalStub = defineComponent({
      name: "AddRepoModal",
      emits: ["import"],
      template: `
        <button
          data-testid="import-repo"
          @click="$emit('import', '/tmp/imported', 'imported', 'main')"
        >
          import
        </button>
      `,
    });

    const wrapper = await mountAppWithOverrides(SidebarWithRepoStub, {
      AddRepoModal: AddRepoModalStub,
    });

    await flushPromises();
    expect(capturedKeyboardActions).not.toBeNull();

    capturedKeyboardActions?.importRepo();
    await flushPromises();
    await wrapper.get('[data-testid="import-repo"]').trigger("click");
    await flushPromises();

    expect(store.importRepo).toHaveBeenCalledWith("/tmp/imported", "imported", "main");
    expect(invokeMock).toHaveBeenCalledWith("file_exists", {
      path: "/tmp/imported/.kanna",
    });
    expect(store.loadAgent).toHaveBeenCalledWith("repo-imported", "setup");
    expect(store.createItem).toHaveBeenCalledWith(
      "repo-imported",
      "/tmp/imported",
      "Set up Kanna for this repository.",
      "pty",
      expect.objectContaining({
        customTask: expect.objectContaining({
          agent: "setup",
          name: "Set Up Repository",
          prompt: "Set up Kanna for this repository.",
        }),
      }),
    );
    expect(store.createItem.mock.calls.at(-1)?.[4]).not.toHaveProperty("agentProvider");
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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
      repo_id: "repo-1",
      closed_at: null,
      stage: "in progress",
      branch: "task-1",
      prompt: "Fix handoff",
      tags: "[]",
    };
    store.items = [store.currentItem];
    store.selectedItemId = "task-1";
    const push = createDeferred<void>();
    store.pushTaskToPeer.mockImplementation(() => push.promise);
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) return `/usr/bin/${args.name}`;
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

  it("opens the latest terminal file link for the selected task", async () => {
    store.currentItem = {
      id: "task-1",
      stage: "in progress",
      branch: "task-1",
      prompt: "Fix handoff",
      tags: "[]",
    };
    store.selectedItemId = "task-1";
    const wrapper = await mountApp(SidebarWithRepoStub);

    await capturedKeyboardActions?.openLatestFileLink();

    expect(openLatestTerminalFileLinkMock).toHaveBeenCalledWith("task-1");
    expect(toastInfoMock).not.toHaveBeenCalledWith("toasts.noTerminalFileLink");
    wrapper.unmount();
  });

  it("shows info feedback when the selected terminal has no file link", async () => {
    openLatestTerminalFileLinkMock.mockResolvedValue(false);
    store.currentItem = {
      id: "task-1",
      stage: "in progress",
      branch: "task-1",
      prompt: "Fix handoff",
      tags: "[]",
    };
    store.selectedItemId = "task-1";
    const wrapper = await mountApp(SidebarWithRepoStub);

    await capturedKeyboardActions?.openLatestFileLink();

    expect(toastInfoMock).toHaveBeenCalledWith("toasts.noTerminalFileLink");
    wrapper.unmount();
  });

  it("shows the latest-file shortcut hint only once when a terminal link becomes available", async () => {
    localStorage.removeItem("kanna:terminal-file-link-shortcut-hint:v1");
    const wrapper = await mountApp(SidebarWithRepoStub);

    document.dispatchEvent(new CustomEvent("terminal-file-link-available", { bubbles: true }));
    document.dispatchEvent(new CustomEvent("terminal-file-link-available", { bubbles: true }));

    expect(toastInfoMock).toHaveBeenCalledTimes(1);
    expect(toastInfoMock).toHaveBeenCalledWith("toasts.latestAgentFileHint");
    expect(localStorage.getItem("kanna:terminal-file-link-shortcut-hint:v1")).toBe("1");
    wrapper.unmount();
  });

  it("dismiss closes the entire file flow after preview-local dismiss is exhausted", async () => {
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
          windowWorkspace: mockWindowWorkspace,
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

  it("opens Markdown rendered and persists a raw-mode choice", async () => {
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
          <button data-testid="toggle-markdown-raw" @click="emit('update-markdown-mode', 'raw')">raw</button>
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

    expect(wrapper.get('[data-testid="file-preview-modal"]').attributes("data-mode")).toBe("rendered");

    await wrapper.get('[data-testid="toggle-markdown-raw"]').trigger("click");
    await flushPromises();

    expect(store.markdownPreviewMode).toBe("raw");
    expect(store.savePreference).toHaveBeenCalledWith("markdownPreviewMode", "raw");

    wrapper.unmount();
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
          windowWorkspace: mockWindowWorkspace,
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
