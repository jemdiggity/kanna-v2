<script setup lang="ts">
import { ref, reactive, computed, inject, onMounted, onBeforeUnmount, onUnmounted, nextTick, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";

import { computedAsync } from "@vueuse/core";
import { isTauri } from "./tauri-mock";
import { invoke } from "./invoke";
import { listen, listenCurrentWebviewWindow } from "./listen";
import { parseRepoConfig } from "@kanna/core";
import { getSetting, setSetting, type AgentProvider, type DbHandle, type PipelineItem } from "@kanna/db";
import i18n from "./i18n";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import NewTaskModal from "./components/NewTaskModal.vue";
import AddRepoModal from "./components/AddRepoModal.vue";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal.vue";
import FilePickerModal from "./components/FilePickerModal.vue";
import FilePreviewModal from "./components/FilePreviewModal.vue";
import TreeExplorerModal from "./components/TreeExplorerModal.vue";
import DiffModal from "./components/DiffModal.vue";
import CommitGraphModal from "./components/CommitGraphModal.vue";
import ShellModal from "./components/ShellModal.vue";
import CommandPaletteModal from "./components/CommandPaletteModal.vue";
import AnalyticsModal from "./components/AnalyticsModal.vue";
import BlockerSelectModal from "./components/BlockerSelectModal.vue";
import PeerPickerModal from "./components/PeerPickerModal.vue";
import PreferencesPanel from "./components/PreferencesPanel.vue";
import AppUpdatePrompt from "./components/AppUpdatePrompt.vue";
import ToastContainer from "./components/ToastContainer.vue";
import { getConfiguredDesktopAuthSession } from "./services/desktopAuthSdk";
import type { DesktopAuthSession, DesktopAuthState } from "./services/desktopAuth";
import { listDesktopCloudTasks, type DesktopCloudSnapshot } from "./services/desktopCloudTaskIndex";
import { listDesktopLanTasks, publishDesktopLanTaskSnapshot } from "./services/desktopLanTaskIndex";
import { deleteRemoteTaskSnapshots, reconcileDesktopTaskSnapshots } from "./services/desktopCloudPublisher";
import { getCachedRepoRemoteMetadata } from "./services/repoRemoteUrl";
import { createConfiguredDesktopRelayTerminalClient } from "./services/desktopRelayTerminal";
import { createConfiguredDesktopLanTerminalClient } from "./services/desktopLanTerminal";
import { useKeyboardShortcuts, type ActionName } from "./composables/useKeyboardShortcuts";
import { scheduleStartupBackup, startPeriodicBackup } from "./composables/useBackup";
import { useOperatorEvents } from "./composables/useOperatorEvents";
import { type ShortcutContext } from "./composables/useShortcutContext";
import { useCustomTasks } from "./composables/useCustomTasks";
import { useToast } from "./composables/useToast";
import { useRestoreFocus } from "./composables/useRestoreFocus";
import { useAppUpdate } from "./composables/useAppUpdate";
import { isTopModal } from "./composables/useModalZIndex";
import { selectTaskByActivity } from "./utils/selectTaskByActivity";
import { sortSidebarItemsForRepo } from "./utils/sidebarOrdering";
import { getDefaultBaseBranch } from "./utils/baseBranchPicker";
import { computeTaskSnapshotFingerprint } from "./utils/cloudTaskFingerprint";
import { remoteTaskClosureAliases, remoteTaskIsLocallyClosed } from "./utils/remoteTaskIdentity";
import { parseRepoInput } from "./utils/parseRepoInput";
import { defaultReposHome } from "./utils/reposHome";
import { buildWorkspace } from "./workspace/buildWorkspace";
import type { WorkspaceTask } from "./workspace/types";
import { isTaskTearingDown } from "./stores/taskStages";
import {
  parseIncomingTransferRequest,
  parsePairingCompletedEvent,
  parsePairingRequestedEvent,
  parsePairingResult,
  parseOutgoingTransferCommittedEvent,
  parseOutgoingTransferFinalizationRequestEvent,
  parseTransferPeers,
  type TransferPeerOption,
} from "./utils/taskTransfer";
import { useKannaStore } from "./stores/kanna";
import { NEW_CUSTOM_TASK_PROMPT } from "@kanna/core";
import type { CustomTaskConfig } from "@kanna/core";
import type { DynamicCommand } from "./components/CommandPaletteModal.vue";
import {
  applyCurrentDocumentTheme,
  useThemeRuntime,
  setSystemPrefersDark,
  setThemePreferences,
} from "./theme/runtime";
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  normalizeAppThemePreference,
  normalizeCodeThemePreference,
} from "./theme/theme";
import { syncNativeAppTheme } from "./theme/native";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
  WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
  normalizeSidebarWidth,
  type WindowWorkspaceController,
} from "./windowWorkspace";

const isMobile = __KANNA_MOBILE__;

type AppSidebarItem = PipelineItem & {
  remote_task?: boolean;
};

function hasTag(item: { tags: string }, tag: string): boolean {
  try {
    return (JSON.parse(item.tags) as string[]).includes(tag);
  } catch (error) {
    console.debug("[App] failed to parse task tags:", error);
    return false;
  }
}

function isActivityShortcutCandidate(item: { stage?: string; teardown_started_at?: string | null }): boolean {
  if (typeof item.stage !== "string") return true;
  return !isTaskTearingDown({ stage: item.stage, teardown_started_at: item.teardown_started_at });
}

function firstSupportedAgentProvider(agentProvider: AgentProvider | AgentProvider[] | string | string[] | undefined): AgentProvider | undefined {
  const providers = Array.isArray(agentProvider) ? agentProvider : [agentProvider];
  return providers.find((provider): provider is AgentProvider =>
    provider === "claude" || provider === "copilot" || provider === "codex" || provider === "opencode"
  );
}

const store = useKannaStore();
const toast = useToast();
const { t } = useI18n();
const db = inject<DbHandle>("db")!;
const dbName = inject<string>("dbName")!;
const windowWorkspace = inject<WindowWorkspaceController>("windowWorkspace")!;
const { tasks: customTasks, scan: scanCustomTasks } = useCustomTasks();
const { effectiveAppTheme } = useThemeRuntime();
const appUpdate = useAppUpdate();
const appUnlisteners: Array<() => void> = [];
let closingCurrentWindow = false;
useOperatorEvents(computed(() => db) as unknown as Ref<DbHandle | null>);
store.attachWindowWorkspace(windowWorkspace);
const desktopAuthSession = ref<DesktopAuthSession | null>(null);
const desktopAuthState = ref<DesktopAuthState>({ status: "signedOut" });
const cloudSnapshot = ref<DesktopCloudSnapshot>({ repos: [], items: [], terminalRefs: {} });
const lanSnapshot = ref<DesktopCloudSnapshot>({ repos: [], items: [], terminalRefs: {} });
const locallyClosedRemoteTaskIds = ref<Set<string>>(new Set());
let unsubscribeDesktopAuth: (() => void) | null = null;
let cloudRefreshTimer: ReturnType<typeof setInterval> | null = null;
let lanRefreshTimer: ReturnType<typeof setInterval> | null = null;
const reconciledCloudSnapshotUsers = new Set<string>();
let lastPublishedTaskFingerprint: string | null = null;
let lastCloudBackendErrorToastAt: number | null = null;
const CLOUD_BACKEND_ERROR_TOAST_INTERVAL_MS = 30_000;
const selectedCloudRepoId = ref<string | null>(null);
const selectedCloudItemId = ref<string | null>(null);

async function requestCloseCurrentWindow() {
  if (closingCurrentWindow) return;
  closingCurrentWindow = true;
  try {
    await windowWorkspace.closeWindow();
  } catch (error: unknown) {
    closingCurrentWindow = false;
    throw error;
  }
}

// UI state
const showNewTaskModal = ref(false);
const availablePipelines = ref<string[]>([]);
const defaultPipelineName = ref<string | undefined>(undefined);
const availableBaseBranches = ref<string[]>([]);
const defaultBaseBranchName = ref<string | undefined>(undefined);
const repoDefaultBranchName = ref<string | undefined>(undefined);
const showAddRepoModal = ref(false);
const addRepoInitialTab = ref<"create" | "import">("create");
const showShortcutsModal = ref(false);
const shortcutsStartFull = ref(false);
const shortcutsContext = ref<ShortcutContext>("main");
const showFilePickerModal = ref(false);
const filePickerHidden = ref(false);
const showFilePreviewModal = ref(false);
const previewFilePath = ref("");
const previewInitialLine = ref<number | undefined>(undefined);
const previewHidden = ref(false);
const previewFromPicker = ref(false);
const previewFromTree = ref(false);
const showDiffModal = ref(false);
const showTreeExplorer = ref(false);
const currentWorktreePath = computed(() => {
  if (!store.selectedRepo?.path || !store.currentItem?.branch) return undefined;
  return `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}`;
});
const activeWorktreePath = computed(() =>
  currentWorktreePath.value ?? store.selectedRepo?.path ?? ""
);
const treeExplorerRoot = computed(() => {
  if (currentWorktreePath.value) return currentWorktreePath.value;
  if (store.selectedRepo?.path) return store.selectedRepo.path;
  return homePath.value;
});
const showShellModal = ref(false);
const shellRepoRoot = ref(false);
const shellModalCwd = computed(() => {
  if (shellRepoRoot.value && !store.selectedRepo) return homePath.value;
  if (shellRepoRoot.value) return store.selectedRepo?.path ?? homePath.value;
  return currentWorktreePath.value ?? store.selectedRepo?.path ?? homePath.value;
});
const shellModalFallbackCwd = computed(() =>
  shellRepoRoot.value ? undefined : store.selectedRepo?.path
);
const showCommandPalette = ref(false);
const commandUsageCounts = ref<Record<string, number>>({});
const showAnalyticsModal = ref(false);
const showBlockerSelect = ref(false);
const blockerSelectMode = ref<"block" | "edit">("block");
const peerPickerMode = ref<"push" | "pair">("push");
const selectedTransferTaskId = ref<string | null>(null);
const showPeerPicker = ref(false);
const transferPeers = ref<TransferPeerOption[]>([]);
const transferPeersLoading = ref(false);
const transferPeerActionPending = ref(false);
let transferPeerLoadRequestId = 0;
const TRANSFER_PEER_DISCOVERY_RETRY_MS = 250;
const TRANSFER_PEER_DISCOVERY_TIMEOUT_MS = 2500;
const showPreferencesPanel = ref(false);
const preferences = reactive({
  suspendAfterMinutes: 30,
  killAfterMinutes: 60,
  ideCommand: "code",
  locale: "en",
  devLingerTerminals: false,
  defaultAgentProvider: "claude" as AgentProvider,
  appTheme: DEFAULT_APP_THEME,
  codeTheme: DEFAULT_CODE_THEME,
});
const localReposForCloudMatching = computedAsync(async () => {
  return Promise.all(store.repos.map(async (repo) => {
    const metadata = await getCachedRepoRemoteMetadata(db, repo);
    return {
      repo,
      remoteUrl: metadata.remoteUrl,
      remoteUrlHash: metadata.remoteUrlHash,
    };
  }));
}, store.repos.map((repo) => ({
  repo,
  remoteUrl: null,
  remoteUrlHash: null,
})));
const remoteSnapshot = computed<DesktopCloudSnapshot>(() => ({
  repos: [...cloudSnapshot.value.repos, ...lanSnapshot.value.repos],
  items: [...cloudSnapshot.value.items, ...lanSnapshot.value.items]
    .filter((item) => {
      const terminalRef = cloudSnapshot.value.terminalRefs[item.id] ?? lanSnapshot.value.terminalRefs[item.id];
      return !remoteTaskIsLocallyClosed(item, terminalRef, locallyClosedRemoteTaskIds.value);
    }),
  terminalRefs: Object.fromEntries(
    Object.entries({ ...cloudSnapshot.value.terminalRefs, ...lanSnapshot.value.terminalRefs })
      .filter(([taskId, ref]) =>
        !remoteTaskIsLocallyClosed({ id: taskId }, ref, locallyClosedRemoteTaskIds.value),
      ),
  ),
}));
const workspace = computed(() => buildWorkspace({
  localRepos: localReposForCloudMatching.value,
  localItems: store.items,
  cloudSnapshot: filterClosedRemoteSnapshot(cloudSnapshot.value),
  lanSnapshot: filterClosedRemoteSnapshot(lanSnapshot.value),
}));
const remoteTaskDiagnostics = computed(() => workspace.value.diagnostics);
const workspaceTasksByItemId = computed(() => {
  const entries: Array<[string, WorkspaceTask]> = [];
  for (const task of workspace.value.tasks) {
    entries.push([task.item.id, task]);
    if (task.localTaskId) entries.push([task.localTaskId, task]);
    for (const remoteTaskId of task.remoteTaskIds) entries.push([remoteTaskId, task]);
  }
  return new Map(entries);
});
const sidebarRepos = computed(() => workspace.value.repos.map((repo) => ({
  id: repo.key,
  path: repo.path ?? "cloud",
  name: repo.name,
  remote_url: repo.remoteUrl,
  remote_url_hash: repo.remoteUrlHash,
  default_branch: repo.defaultBranch ?? "main",
  hidden: 0,
  sort_order: 0,
  created_at: "",
  last_opened_at: "",
})));
const sidebarItems = computed<AppSidebarItem[]>(() => workspace.value.tasks.map((task) => ({
  ...task.item,
  id: task.item.id,
  repo_id: task.repoKey,
  remote_task: task.owner.kind !== "local",
})));
const selectedCloudRepo = computed(() =>
  remoteSnapshot.value.repos.find((repo) => repo.id === (selectedCloudRepoId.value ?? store.selectedRepoId))
    ?? sidebarRepos.value.find((repo) => repo.id === (selectedCloudRepoId.value ?? store.selectedRepoId) && repo.path === "cloud")
    ?? null,
);
const selectedCloudItem = computed(() => {
  const selectedItemId = selectedCloudItemId.value ?? store.selectedItemId;
  if (!selectedItemId) return null;
  const task = workspaceTasksByItemId.value.get(selectedItemId);
  if (!task || task.owner.kind === "local") return null;
  if (task.item.repo_id === (selectedCloudRepoId.value ?? store.selectedRepoId)) return task.item;
  if (task.repoKey === (selectedCloudRepoId.value ?? store.selectedRepoId)) return task.item;
  return null;
});
const mainPanelRepo = computed(() => selectedCloudRepo.value ?? store.selectedRepo);
const mainPanelItem = computed(() => selectedCloudItem.value ?? store.currentItem);
const mainPanelIsCloudTask = computed(() => Boolean(selectedCloudItem.value));
const selectedWorkspaceTask = computed(() => {
  const selectedItemId = selectedCloudItemId.value ?? store.selectedItemId;
  return selectedItemId ? workspaceTasksByItemId.value.get(selectedItemId) ?? null : null;
});
const mainPanelCloudTerminalRef = computed(() => {
  const selectedItemId = selectedCloudItemId.value ?? store.selectedItemId;
  if (!selectedItemId) return null;
  const task = workspaceTasksByItemId.value.get(selectedItemId);
  return task?.terminal.remoteRef ?? null;
});

function isCloudOnlyRepoId(repoId: string | undefined | null): boolean {
  return Boolean(repoId && remoteSnapshot.value.repos.some((repo) => repo.id === repoId));
}

function cloudRepoRemoteUrl(repoId: string | undefined | null): string | null {
  if (!repoId) return null;
  const repo = remoteSnapshot.value.repos.find((candidate) => candidate.id === repoId);
  return repo?.remote_url ?? null;
}

function filterClosedRemoteSnapshot(snapshot: DesktopCloudSnapshot): DesktopCloudSnapshot {
  const closedIds = locallyClosedRemoteTaskIds.value;
  if (closedIds.size === 0) return snapshot;
  return {
    repos: snapshot.repos,
    items: snapshot.items.filter((item) =>
      !remoteTaskIsLocallyClosed(item, snapshot.terminalRefs[item.id], closedIds),
    ),
    terminalRefs: Object.fromEntries(
      Object.entries(snapshot.terminalRefs).filter(([taskId, ref]) =>
        !remoteTaskIsLocallyClosed({ id: taskId }, ref, closedIds),
      ),
    ),
  };
}

function markWorkspaceTaskLocallyClosed(workspaceTask: WorkspaceTask): void {
  const closedAliases = new Set<string>();
  for (const source of workspaceTask.sources) {
    for (const alias of remoteTaskClosureAliases({ id: source.taskId }, source.terminalRef)) {
      closedAliases.add(alias);
    }
  }
  if (workspaceTask.terminal.remoteRef) {
    for (const alias of remoteTaskClosureAliases(workspaceTask.item, workspaceTask.terminal.remoteRef)) {
      closedAliases.add(alias);
    }
  } else {
    closedAliases.add(workspaceTask.item.id);
  }
  locallyClosedRemoteTaskIds.value = new Set([
    ...locallyClosedRemoteTaskIds.value,
    ...closedAliases,
  ]);
}
type DiffScope = "branch" | "working";
type BranchInclude = "none" | "staged" | "all";

interface DiffScrollPositions {
  branch?: number;
  working?: number;
}

interface DiffViewState {
  scope?: DiffScope;
  scrollPositions?: DiffScrollPositions;
  branchInclude?: BranchInclude;
}

interface FilePreviewRecallState {
  filePath: string;
  initialLine?: number;
  markdownMode?: "raw" | "rendered";
}

const diffViewStates = reactive<Record<string, DiffViewState>>({});
const filePreviewRecallStates = reactive<Record<string, FilePreviewRecallState>>({});
const currentDiffViewKey = computed(() => {
  if (store.currentItem) return `item:${store.currentItem.id}`;
  if (store.selectedRepo) return `repo:${store.selectedRepo.id}`;
  return undefined;
});
const currentDiffViewState = computed(() => {
  const key = currentDiffViewKey.value;
  return key ? diffViewStates[key] : undefined;
});

function updateCurrentDiffViewState(partial: DiffViewState) {
  const key = currentDiffViewKey.value;
  if (!key) return;
  const current = diffViewStates[key] ?? {};
  diffViewStates[key] = { ...current, ...partial };
}

function showCloudBackendErrorToast(error: unknown) {
  const now = Date.now();
  if (
    lastCloudBackendErrorToastAt !== null
    && now - lastCloudBackendErrorToastAt < CLOUD_BACKEND_ERROR_TOAST_INTERVAL_MS
  ) {
    return;
  }
  lastCloudBackendErrorToastAt = now;
  toast.error(`Cloud sync failed: ${cloudBackendErrorLabel(error)}`);
}

function cloudBackendErrorLabel(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error);
}

function buildCurrentFileFlowKey(): string | undefined {
  if (store.currentItem) return `item:${store.currentItem.id}`;
  if (store.selectedRepo) return `repo:${store.selectedRepo.id}`;
  return undefined;
}

async function refreshCloudTasksForSignedInUser(): Promise<void> {
  const state = desktopAuthState.value;
  if (state.status !== "signedIn") {
    cloudSnapshot.value = { repos: [], items: [], terminalRefs: {} };
    return;
  }
  const snapshot = await listDesktopCloudTasks(state.user.uid, undefined, {
    localRepos: localReposForCloudMatching.value,
    localItems: store.items,
  });
  cloudSnapshot.value = {
    repos: snapshot.repos,
    items: snapshot.items,
    terminalRefs: snapshot.terminalRefs ?? {},
  };
}

async function syncCloudTasksForSignedInUser(): Promise<void> {
  if (desktopAuthState.value.status !== "signedIn") {
    await refreshCloudTasksForSignedInUser();
    return;
  }
  // Only publish (reconcile) when the local open-task set actually changed.
  // The periodic poll runs every second purely to READ peers' tasks; without
  // this guard it re-published the full snapshot — and rewrote users/{uid} —
  // on every tick.
  const fingerprint = computeTaskSnapshotFingerprint(store.items);
  if (fingerprint !== lastPublishedTaskFingerprint) {
    await reconcileDesktopTaskSnapshots(db).catch((error) => {
      console.warn("[cloud] failed to reconcile local task snapshots:", error);
      showCloudBackendErrorToast(error);
    });
    lastPublishedTaskFingerprint = fingerprint;
  }
  await refreshCloudTasksForSignedInUser();
}

async function refreshLanTasks(): Promise<void> {
  await publishDesktopLanTaskSnapshot(db);
  const snapshot = await listDesktopLanTasks({
    localRepos: localReposForCloudMatching.value,
  });
  lanSnapshot.value = {
    repos: snapshot.repos,
    items: snapshot.items,
    terminalRefs: snapshot.terminalRefs ?? {},
  };
}

async function initializeDesktopCloudAuth(): Promise<void> {
  const session = await getConfiguredDesktopAuthSession();
  desktopAuthSession.value = session;
  await session.initialize();
  unsubscribeDesktopAuth?.();
  unsubscribeDesktopAuth = session.subscribe((state) => {
    desktopAuthState.value = state;
    if (state.status === "signedIn" && !reconciledCloudSnapshotUsers.has(state.user.uid)) {
      reconciledCloudSnapshotUsers.add(state.user.uid);
      void reconcileDesktopTaskSnapshots(db)
        .then(() => {
          // Record what we just published so the periodic poll doesn't
          // immediately re-publish the same snapshot on its next tick.
          lastPublishedTaskFingerprint = computeTaskSnapshotFingerprint(store.items);
        })
        .catch((error) => {
          console.warn("[cloud] failed to reconcile local task snapshots:", error);
          showCloudBackendErrorToast(error);
        })
        .then(() => refreshCloudTasksForSignedInUser());
    }
    void refreshCloudTasksForSignedInUser().catch((error) => {
      console.warn("[cloud] failed to refresh cloud tasks:", error);
      showCloudBackendErrorToast(error);
    });
  });
  cloudRefreshTimer = setInterval(() => {
    void syncCloudTasksForSignedInUser().catch((error) => {
      console.warn("[cloud] failed to sync cloud tasks:", error);
      showCloudBackendErrorToast(error);
    });
  }, 1000);
}

function initializeDesktopLanTaskSync(): void {
  void refreshLanTasks().catch((error) =>
    console.warn("[lan] failed to refresh LAN tasks:", error),
  );
  lanRefreshTimer = setInterval(() => {
    void refreshLanTasks().catch((error) =>
      console.warn("[lan] failed to refresh LAN tasks:", error),
    );
  }, 1000);
}

const currentFileFlowKey = computed(() => buildCurrentFileFlowKey());

function rememberCurrentPreview(filePath: string, initialLine: number | undefined) {
  const key = buildCurrentFileFlowKey();
  if (!key) return;
  filePreviewRecallStates[key] = {
    filePath,
    initialLine,
    markdownMode: filePreviewRecallStates[key]?.markdownMode ?? "raw",
  };
}

function getCurrentPreviewRecall(): FilePreviewRecallState | undefined {
  const key = buildCurrentFileFlowKey();
  return key ? filePreviewRecallStates[key] : undefined;
}

const currentPreviewMarkdownMode = computed<"raw" | "rendered">(() => {
  const key = currentFileFlowKey.value;
  return (key ? filePreviewRecallStates[key]?.markdownMode : undefined) ?? "raw";
});

function updateCurrentPreviewMarkdownMode(mode: "raw" | "rendered") {
  const key = buildCurrentFileFlowKey();
  if (!key) return;
  const current = filePreviewRecallStates[key];
  if (!current) return;
  filePreviewRecallStates[key] = { ...current, markdownMode: mode };
}

const sidebarHidden = ref(false);
const sidebarWidth = ref(DEFAULT_SIDEBAR_WIDTH);
const maximizedModal = ref<ShortcutContext | null>(null);
const maximized = computed(() => maximizedModal.value !== null);
const homePath = ref("");
const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);
const mainPanelRef = ref<InstanceType<typeof MainPanel> | null>(null);
const shellModalRef = ref<InstanceType<typeof ShellModal> | null>(null);
const diffModalRef = ref<InstanceType<typeof DiffModal> | null>(null);
const showCommitGraphModal = ref(false);
const commitGraphModalRef = ref<InstanceType<typeof CommitGraphModal> | null>(null);
const treeExplorerRef = ref<InstanceType<typeof TreeExplorerModal> | null>(null);
const filePickerRef = ref<InstanceType<typeof FilePickerModal> | null>(null);
const filePreviewRef = ref<InstanceType<typeof FilePreviewModal> | null>(null);
const preferencesRef = ref<InstanceType<typeof PreferencesPanel> | null>(null);
const sidebarShellStyle = computed(() => ({
  width: `${sidebarWidth.value}px`,
  minWidth: `${sidebarWidth.value}px`,
  maxWidth: `${sidebarWidth.value}px`,
}));
const canResizeSidebar = computed(() => !isMobile);
let sidebarResizeStartX = 0;
let sidebarResizeStartWidth = DEFAULT_SIDEBAR_WIDTH;
let sidebarResizeActive = false;

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function stopSidebarResize() {
  if (!sidebarResizeActive) return;
  sidebarResizeActive = false;
  document.removeEventListener("pointermove", handleSidebarResizeMove);
  document.removeEventListener("pointerup", handleSidebarResizeEnd);
  document.body.classList.remove("is-resizing-sidebar");
}

function handleSidebarResizeMove(event: PointerEvent) {
  if (!sidebarResizeActive) return;
  sidebarWidth.value = clampSidebarWidth(
    sidebarResizeStartWidth + event.clientX - sidebarResizeStartX,
  );
}

async function handleSidebarResizeEnd(event: PointerEvent) {
  handleSidebarResizeMove(event);
  stopSidebarResize();
  try {
    await windowWorkspace.persistSidebarWidth(sidebarWidth.value);
  } catch (error: unknown) {
    console.error("[App] failed to persist sidebar width:", error);
  }
}

function startSidebarResize(event: PointerEvent) {
  if (!canResizeSidebar.value) return;
  event.preventDefault();
  sidebarResizeActive = true;
  sidebarResizeStartX = event.clientX;
  sidebarResizeStartWidth = sidebarWidth.value;
  document.addEventListener("pointermove", handleSidebarResizeMove);
  document.addEventListener("pointerup", handleSidebarResizeEnd);
  document.body.classList.add("is-resizing-sidebar");
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
}

async function restoreSidebarWidth() {
  try {
    const snapshot = await windowWorkspace.loadSnapshot();
    const savedWindow = snapshot.windows.find((entry) =>
      entry.windowId === windowWorkspace.bootstrap.windowId
    );
    sidebarWidth.value = normalizeSidebarWidth(savedWindow?.sidebarWidth);
  } catch (error: unknown) {
    console.error("[App] failed to restore sidebar width:", error);
  }
}

interface PendingIncomingTransferRow {
  id: string;
  source_peer_id: string | null;
  source_task_id: string | null;
  payload_json: string | null;
}

function validatePendingIncomingTransferRow(row: PendingIncomingTransferRow): string | null {
  if (!row.source_peer_id) return "missing source_peer_id";
  if (!row.source_task_id) return "missing source_task_id";
  if (!row.payload_json) return "missing payload_json";

  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (!parsed || typeof parsed !== "object") return "payload_json did not decode to an object";
    const record = parsed as { task?: unknown; repo?: unknown };
    if (!record.task || typeof record.task !== "object") return "payload_json missing task";
    if (!record.repo || typeof record.repo !== "object") return "payload_json missing repo";
  } catch (error: unknown) {
    return `payload_json is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }

  return null;
}

async function markPendingIncomingTransferFailed(transferId: string, reason: string): Promise<boolean> {
  const result = await db.execute(
    `UPDATE task_transfer
        SET status = 'failed',
            completed_at = datetime('now'),
            error = ?
      WHERE id = ? AND direction = 'incoming' AND status IN ('pending', 'streaming')`,
    [reason, transferId],
  );
  return result.rowsAffected === 1;
}

async function claimPendingIncomingTransfer(transferId: string): Promise<boolean> {
  const result = await db.execute(
    `UPDATE task_transfer
        SET status = 'streaming',
            error = NULL
      WHERE id = ? AND direction = 'incoming' AND status = 'pending'`,
    [transferId],
  );
  return result.rowsAffected === 1;
}

function visibleSidebarItemsForRepo(repoId: string, options: { currentRepoScope?: boolean } = {}) {
  const workspaceItems = sidebarItems.value.filter((item) => item.repo_id === repoId);
  const searchQuery = sidebarRef.value?.searchQuery ?? "";
  const sortOptions = {
    repoId,
    getStageOrder: store.getStageOrder,
    searchQuery,
  };
  const withRepoId = (items: typeof workspaceItems) => items.map((item) => ({
    ...item,
    repo_id: item.repo_id ?? repoId,
  }));
  if (workspaceItems.length === 0 && options.currentRepoScope && repoId === store.selectedRepoId && !repoId.startsWith("cloud:")) {
    return sortSidebarItemsForRepo({ ...sortOptions, items: withRepoId(store.sortedItemsForCurrentRepo) });
  }
  if (options.currentRepoScope && repoId === store.selectedRepoId && !repoId.startsWith("cloud:")) {
    return sortSidebarItemsForRepo({ ...sortOptions, items: workspaceItems });
  }
  return sortSidebarItemsForRepo({ ...sortOptions, items: workspaceItems });
}

function visibleSidebarItemsAllRepos() {
  const workspaceItems = sidebarRepos.value.flatMap((repo) => visibleSidebarItemsForRepo(repo.id));
  if (workspaceItems.length > 0) return workspaceItems;
  if (store.sortedItemsAllRepos.length > 0) return store.sortedItemsAllRepos;
  const repoId = store.selectedRepoId;
  return repoId ? visibleSidebarItemsForRepo(repoId, { currentRepoScope: true }) : [];
}

// Navigation
async function selectSidebarItem(item: Pick<AppSidebarItem, "id" | "repo_id">, previousItemId?: string | null) {
  if (item.repo_id !== store.selectedRepoId) {
    const previous = previousItemId !== undefined ? previousItemId : store.selectedItemId;
    await handleSelectRepo(item.repo_id);
    await handleSelectItem(item.id, previous);
    return;
  }

  if (previousItemId !== undefined) {
    await handleSelectItem(item.id, previousItemId);
  } else {
    await handleSelectItem(item.id);
  }
}

async function navigateItems(direction: -1 | 1) {
  const allItems = visibleSidebarItemsAllRepos();
  const visibleItems = allItems;
  if (visibleItems.length === 0) return;
  const currentIndex = visibleItems.findIndex((i) => i.id === store.selectedItemId);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= visibleItems.length) nextIndex = visibleItems.length - 1;
  }
  const nextItem = visibleItems[nextIndex];
  if (nextItem.id !== store.selectedItemId) {
    const previousItemId = store.selectedItemId;
    await selectSidebarItem(nextItem, previousItemId);
  }
}

async function navigateRepos(direction: -1 | 1) {
  const visibleRepos = sidebarRepos.value;
  if (visibleRepos.length === 0) return;
  const currentIndex = visibleRepos.findIndex((r) => r.id === store.selectedRepoId);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= visibleRepos.length) return;
  }
  const nextRepo = visibleRepos[nextIndex];
  if (nextRepo.id === store.selectedRepoId) return;
  const previousItemId = store.selectedItemId;

  // Restore last-selected task for this repo, or fall back to first task.
  const lastItemId = store.lastSelectedItemByRepo[nextRepo.id];
  const lastItem = lastItemId
    ? sidebarItems.value.find((i) => i.id === lastItemId && i.repo_id === nextRepo.id && i.stage !== "done" && i.closed_at == null)
    : undefined;
  const targetItem = lastItem ?? visibleSidebarItemsForRepo(nextRepo.id)[0];

  if (targetItem && !nextRepo.id.startsWith("cloud:")) {
    store.selectedRepoId = nextRepo.id;
    await handleSelectItem(targetItem.id, previousItemId);
    await store.selectRepo(nextRepo.id);
    return;
  }

  await handleSelectRepo(nextRepo.id);
  if (targetItem) {
    await handleSelectItem(targetItem.id, previousItemId);
  }
}

async function selectReadTask(mode: "oldest" | "newest") {
  const target = selectTaskByActivity(
    visibleSidebarItemsAllRepos().filter((item) => isActivityShortcutCandidate(item) && !hasTag(item, "blocked")),
    mode,
    "idle",
    mainPanelItem.value?.created_at,
  );
  if (target) await selectSidebarItem(target);
}

async function selectUnreadTaskWithReadFallback(mode: "oldest" | "newest") {
  const target = selectTaskByActivity(
    visibleSidebarItemsAllRepos().filter(isActivityShortcutCandidate),
    mode,
    "unread",
    mainPanelItem.value?.created_at,
  );
  if (target) {
    await selectSidebarItem(target);
    return;
  }
  await selectReadTask(mode);
}

function handleBlockTask() {
  blockerSelectMode.value = "block";
  showBlockerSelect.value = true;
}

function handleEditBlockedTask() {
  blockerSelectMode.value = "edit";
  showBlockerSelect.value = true;
}

const blockerCandidates = computed(() => {
  const item = store.currentItem;
  if (!item) return [];
  return store.items.filter((i) =>
    i.id !== item.id &&
    i.stage !== "done" &&
    i.closed_at == null &&
    i.repo_id === store.selectedRepoId
  );
});

// Tasks that would create circular dependencies — shown greyed out
const disabledBlockerIds = computedAsync(async () => {
  const item = store.currentItem;
  if (!item) return [];
  if (item.stage !== "done" && item.closed_at == null) {
    const dependents = await collectDependents(item.id);
    return [...dependents];
  }
  return [];
}, []);

/** Walk the blocker graph to find all tasks transitively blocked by itemId. */
async function collectDependents(itemId: string): Promise<Set<string>> {
  const result = new Set<string>();
  const queue = [itemId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const blocked = await store.listBlockedByItem(current);
    for (const b of blocked) {
      if (!result.has(b.id)) {
        result.add(b.id);
        queue.push(b.id);
      }
    }
  }
  return result;
}

const preselectedBlockerIds = computedAsync(async () => {
  const item = store.currentItem;
  if (!item) return [];
  const blockers = await store.listBlockersForItem(item.id);
  return blockers.map((b) => b.id);
}, []);

// Build a map of blocked item ID → blocker names for the sidebar
const sidebarBlockerNames = computedAsync(async () => {
  const blockedItems = store.items.filter((i) => hasTag(i, "blocked"));
  if (blockedItems.length === 0) return {};
  const map: Record<string, string> = {};
  for (const item of blockedItems) {
    const blockers = await store.listBlockersForItem(item.id);
    map[item.id] = blockers
      .map((b) => b.display_name || (b.prompt ? b.prompt.slice(0, 30) : "Untitled"))
      .join(", ");
  }
  return map;
}, {});

async function onBlockerConfirm(selectedIds: string[]) {
  showBlockerSelect.value = false;
  if (blockerSelectMode.value === "block") {
    await store.blockTask(selectedIds);
  } else {
    const item = store.currentItem;
    if (item) {
      try {
        await store.editBlockedTask(item.id, selectedIds);
      } catch (e: any) {
        toast.error(e.message);
      }
    }
  }
}

const paletteExtraCommands = computed(() => {
  const cmds: Array<{ action: ActionName; label: string; group: string; shortcut: string }> = [];
  const item = store.currentItem;
  if (item && item.stage !== "done" && item.closed_at == null && !hasTag(item, "blocked")) {
    cmds.push({ action: "blockTask", label: t('tasks.blockTask'), group: t('shortcuts.groupTasks'), shortcut: "" });
  }
  if (item && hasTag(item, "blocked")) {
    cmds.push({ action: "editBlockedTask", label: t('tasks.editBlockedTask'), group: t('shortcuts.groupTasks'), shortcut: "" });
  }
  return cmds;
});

// Custom tasks
async function handleLaunchCustomTask(task: CustomTaskConfig) {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert(t('app.selectRepoFirst'));
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    let resolvedTask = task;
    let requestedAgentProvider: AgentProvider | undefined;

    if (task.agent) {
      const agent = await store.loadAgent(repo.path, task.agent);
      const firstProvider = firstSupportedAgentProvider(agent.agent_provider);

      resolvedTask = {
        ...task,
        prompt: task.prompt || agent.prompt,
        model: task.model ?? agent.model,
        permissionMode: task.permissionMode ?? agent.permission_mode,
        allowedTools: task.allowedTools ?? agent.allowed_tools,
      };
      requestedAgentProvider = task.agentProvider ?? firstProvider;
    }

    await store.createItem(store.selectedRepoId, repo.path, resolvedTask.prompt, "pty", {
      customTask: resolvedTask,
      stage: task.stage,
      agentProvider: requestedAgentProvider,
    });
  } catch (e: any) {
    console.error("[App] custom task launch failed:", e);
    alert(`${t('app.customTaskLaunchFailed')}: ${e?.message || e}`);
  }
}

async function handleCreateCustomTask() {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert(t('app.selectRepoFirst'));
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    await store.createItem(store.selectedRepoId, repo.path, NEW_CUSTOM_TASK_PROMPT);
  } catch (e: unknown) {
    console.error("[App] custom task creation failed:", e);
    alert(`${t('app.customTaskCreationFailed')}: ${e instanceof Error ? e.message : e}`);
  }
}

async function handleCreateAgent() {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert(t('app.selectRepoFirst'));
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    await store.createItem(store.selectedRepoId, repo.path, "Help me create a new agent definition for this repository.");
  } catch (e: unknown) {
    console.error("[App] create agent task failed:", e);
    alert(`Failed to create agent task: ${e instanceof Error ? e.message : e}`);
  }
}

async function handleCreatePipeline() {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert(t('app.selectRepoFirst'));
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    await store.createItem(store.selectedRepoId, repo.path, "Help me create a new pipeline definition for this repository.");
  } catch (e: unknown) {
    console.error("[App] create pipeline task failed:", e);
    alert(`Failed to create pipeline task: ${e instanceof Error ? e.message : e}`);
  }
}

async function handleCreateConfig() {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert(t('app.selectRepoFirst'));
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    const agent = await store.loadAgent(repo.path, "config-factory");
    await store.createItem(
      store.selectedRepoId,
      repo.path,
      "Help me create or update the .kanna/config.json for this repository.",
      "pty",
      {
        agentProvider: firstSupportedAgentProvider(agent.agent_provider),
        customTask: {
          name: "Create Config",
          agent: "config-factory",
          prompt: agent.prompt,
          model: agent.model,
          permissionMode: agent.permission_mode,
          allowedTools: agent.allowed_tools,
        },
      },
    );
  } catch (e: unknown) {
    console.error("[App] create config task failed:", e);
    alert(`Failed to create config task: ${e instanceof Error ? e.message : e}`);
  }
}

const paletteDynamicCommands = computed<DynamicCommand[]>(() => {
  const cmds: DynamicCommand[] = [];
  // Rename task (only when a task is selected)
  if (store.currentItem) {
    cmds.push({
      id: "rename-task",
      label: t('tasks.renameTask'),
      execute: () => sidebarRef.value?.renameSelectedItem(),
    });
  }
  if (store.currentItem && store.currentItem.stage !== "done" && store.currentItem.closed_at == null) {
    cmds.push({
      id: "push-to-machine",
      label: t('taskTransfer.pushToMachine'),
      execute: () => openPeerPicker(store.currentItem!.id),
    });
  }
  cmds.push({
    id: "pair-machine",
    label: t('taskTransfer.pairPeer'),
    execute: () => openPairPeerPicker(),
  });
  // Factory commands
  cmds.push({
    id: "create-agent",
    label: "Create Agent",
    description: "Create a new agent definition",
    execute: () => { handleCreateAgent().catch((e) => console.error("[App] create agent failed:", e)); },
  });
  cmds.push({
    id: "create-pipeline",
    label: "Create Pipeline",
    description: "Create a new pipeline definition",
    execute: () => { handleCreatePipeline().catch((e) => console.error("[App] create pipeline failed:", e)); },
  });
  cmds.push({
    id: "create-config",
    label: "Create Config",
    description: "Create or update .kanna/config.json",
    execute: () => { handleCreateConfig().catch((e) => console.error("[App] create config failed:", e)); },
  });
  // Always include "New Custom Task" option
  cmds.push({
    id: "custom-task-new",
    label: t('app.newCustomTask'),
    description: t('app.newCustomTaskDesc'),
    execute: () => handleCreateCustomTask(),
  });
  // Add discovered custom tasks
  for (const task of customTasks.value) {
    cmds.push({
      id: `custom-task-${task.name}`,
      label: task.name,
      description: task.description,
      execute: () => handleLaunchCustomTask(task),
    });
  }
  return cmds;
});

interface ModalShortcutContextEntry {
  context: ShortcutContext;
  visible: boolean;
  zIndex: number;
}

function topPreviewModalContext(): ShortcutContext | null {
  const modalContexts: ModalShortcutContextEntry[] = [
    { context: "diff", visible: showDiffModal.value, zIndex: diffModalRef.value?.zIndex ?? 0 },
    { context: "graph", visible: showCommitGraphModal.value, zIndex: commitGraphModalRef.value?.zIndex ?? 0 },
    { context: "file", visible: showFilePickerModal.value, zIndex: filePickerRef.value?.zIndex ?? 0 },
    { context: "file", visible: showFilePreviewModal.value, zIndex: filePreviewRef.value?.zIndex ?? 0 },
    { context: "tree", visible: showTreeExplorer.value, zIndex: treeExplorerRef.value?.zIndex ?? 0 },
    { context: "shell", visible: showShellModal.value, zIndex: shellModalRef.value?.zIndex ?? 0 },
  ];
  const entries = modalContexts.filter((entry) => entry.visible);

  entries.sort((a, b) => b.zIndex - a.zIndex);
  return entries[0]?.context ?? null;
}

// Derive shortcut context from visible modals (more reliable than the global singleton
// which can be stale if a KeepAlive deactivation resets it after a modal sets it).
const currentShortcutContext = computed<ShortcutContext>(() => {
  // The shortcuts modal is topmost and should own Escape/help toggles even when
  // it is opened on top of a context like tree or shell that doesn't expose
  // the generic dismiss shortcut.
  if (showShortcutsModal.value) return "main";
  if (showPeerPicker.value) return "transfer";
  if (showNewTaskModal.value) return "newTask";
  const topPreviewContext = topPreviewModalContext();
  if (topPreviewContext) return topPreviewContext;
  return "main";
});

function onShellClose() {
  showShellModal.value = false;
  maximizedModal.value = null;
  if (!store.repos.length) {
    mainPanelRef.value?.recheckClis?.();
  }
}

function closeTreeExplorer() {
  showTreeExplorer.value = false;
  maximizedModal.value = maximizedModal.value === "tree" ? null : maximizedModal.value;
}

function closeFileFlow() {
  showFilePreviewModal.value = false;
  showFilePickerModal.value = false;
  filePickerHidden.value = false;
  maximizedModal.value = maximizedModal.value === "file" ? null : maximizedModal.value;
  previewHidden.value = false;
  previewFromPicker.value = false;
  previewFromTree.value = false;
}

watch(currentFileFlowKey, (newKey, oldKey) => {
  if (!oldKey || newKey === oldKey) return;
  closeFileFlow();
});

function closeFilePicker() {
  showFilePickerModal.value = false;
  filePickerHidden.value = false;
}

function showFilePickerOnTop() {
  previewHidden.value = false;
  showFilePickerModal.value = true;
  filePickerHidden.value = false;
  nextTick(() => filePickerRef.value?.bringToFront?.());
}

function openFilePreview(
  filePath: string,
  initialLine: number | undefined,
  fromPicker: boolean,
  fromTree = false
) {
  previewFilePath.value = filePath;
  previewInitialLine.value = initialLine;
  rememberCurrentPreview(filePath, initialLine);
  previewFromPicker.value = fromPicker;
  previewFromTree.value = fromTree;
  previewHidden.value = false;
  showFilePreviewModal.value = true;
  nextTick(() => filePreviewRef.value?.bringToFront?.());
}

function selectFileFromPicker(filePath: string) {
  showFilePickerModal.value = false;
  filePickerHidden.value = true;
  openFilePreview(filePath, undefined, true);
}

function closeFilePreview(reopenPicker: boolean) {
  showFilePreviewModal.value = false;
  maximizedModal.value = maximizedModal.value === "file" ? null : maximizedModal.value;
  previewHidden.value = false;

  const shouldReopenPicker = reopenPicker && previewFromPicker.value;
  previewFromPicker.value = false;
  previewFromTree.value = false;

  if (shouldReopenPicker) {
    showFilePickerOnTop();
  }
}

async function loadTransferPeers() {
  const requestId = ++transferPeerLoadRequestId;
  transferPeersLoading.value = true;
  try {
    const maxAttempts =
      Math.floor(TRANSFER_PEER_DISCOVERY_TIMEOUT_MS / TRANSFER_PEER_DISCOVERY_RETRY_MS) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const raw = await invoke<unknown>("list_transfer_peers");
      const peers = parseTransferPeers(raw);
      if (requestId !== transferPeerLoadRequestId) {
        return;
      }
      if (peers.length > 0 || attempt === maxAttempts - 1) {
        transferPeers.value = peers;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, TRANSFER_PEER_DISCOVERY_RETRY_MS));
    }
  } catch (e: unknown) {
    console.error(
      "[App] failed to list transfer peers:",
      e instanceof Error ? e.message : String(e),
    );
    if (requestId === transferPeerLoadRequestId) {
      transferPeers.value = [];
    }
  } finally {
    if (requestId === transferPeerLoadRequestId) {
      transferPeersLoading.value = false;
    }
  }
}

async function warmTransferSidecar() {
  if (!isTauri) return;
  try {
    await invoke("list_transfer_peers");
  } catch (e: unknown) {
    console.error(
      "[App] transfer sidecar warmup failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function openPeerPicker(taskId: string) {
  console.debug("[transfer] opening push-to-machine picker", { taskId });
  selectedTransferTaskId.value = taskId;
  peerPickerMode.value = "push";
  transferPeerActionPending.value = false;
  showPeerPicker.value = true;
  void loadTransferPeers();
}

function openPairPeerPicker() {
  console.debug("[transfer] opening pair-machine picker");
  selectedTransferTaskId.value = null;
  peerPickerMode.value = "pair";
  transferPeerActionPending.value = false;
  showPeerPicker.value = true;
  void loadTransferPeers();
}

function closePeerPicker() {
  showPeerPicker.value = false;
  selectedTransferTaskId.value = null;
  peerPickerMode.value = "push";
  transferPeerActionPending.value = false;
}

async function handlePeerSelected(peerId: string) {
  if (transferPeerActionPending.value) return;
  const taskId = selectedTransferTaskId.value;
  if (!taskId) return;
  const selectedPeer = transferPeers.value.find((peer) => peer.id === peerId);
  if (selectedPeer && !selectedPeer.trusted) {
    toast.error("Pair this peer before transferring a task.");
    return;
  }
  try {
    transferPeerActionPending.value = true;
    await store.pushTaskToPeer(taskId, peerId);
    closePeerPicker();
  } catch (e: unknown) {
    console.error("[App] task transfer push failed:", e);
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    transferPeerActionPending.value = false;
  }
}

async function handlePairPeer(peerId: string) {
  if (transferPeerActionPending.value) return;
  try {
    transferPeerActionPending.value = true;
    console.debug("[transfer] pair-machine request started", { peerId });
    const result = parsePairingResult(await invoke("start_peer_pairing", { peerId }));
    console.debug("[transfer] pair-machine request completed", {
      peerId,
      pairedPeerId: result.peer.id,
      pairedPeerName: result.peer.name,
    });
    toast.info(`Paired with ${result.peer.name}. Verify code ${result.verificationCode}.`);
    closePeerPicker();
    await loadTransferPeers();
  } catch (e: unknown) {
    console.error("[App] peer pairing failed:", e);
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    transferPeerActionPending.value = false;
  }
}

async function importPendingIncomingTransfers() {
  const rows = await db.select<PendingIncomingTransferRow>(
    `SELECT id, source_peer_id, source_task_id, payload_json
       FROM task_transfer
      WHERE direction = 'incoming' AND status = 'pending'
      ORDER BY started_at ASC`,
  );
  for (const row of rows) {
    const invalidReason = validatePendingIncomingTransferRow(row);
    if (invalidReason) {
      const reason = `pending incoming transfer is malformed: ${invalidReason}`;
      if (await markPendingIncomingTransferFailed(row.id, reason)) {
        console.warn("[App] disabled malformed pending incoming transfer:", { transferId: row.id, reason });
      }
      continue;
    }

    const claimed = await claimPendingIncomingTransfer(row.id);
    if (!claimed) {
      continue;
    }

    try {
      await store.approveIncomingTransfer(row.id);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      if (await markPendingIncomingTransferFailed(row.id, reason)) {
        console.warn("[App] failed to auto-import pending incoming transfer; marked failed:", {
          transferId: row.id,
          reason,
        });
      }
    }
  }
}

async function closeSelectedWorkspaceTask() {
  const workspaceTask = selectedWorkspaceTask.value;
  if (!workspaceTask || workspaceTask.terminal.kind === "local") {
    if (workspaceTask) {
      markWorkspaceTaskLocallyClosed(workspaceTask);
    }
    await store.closeTask();
    return;
  }

  const remoteRef = workspaceTask.terminal.remoteRef;
  if (!remoteRef || !workspaceTask.capabilities.canClose) {
    toast.error("Remote task is not reachable.");
    return;
  }

  const client = workspaceTask.terminal.kind === "lan"
    ? await createConfiguredDesktopLanTerminalClient()
    : await createConfiguredDesktopRelayTerminalClient();
  if (!client) {
    toast.error("Remote task owner is unavailable.");
    return;
  }

  try {
    await client.closeTask({
      desktopId: remoteRef.ownerDesktopId,
      taskId: remoteRef.ownerLocalTaskId,
    });
    deleteRemoteCloudTaskMetadata(workspaceTask);
    markWorkspaceTaskLocallyClosed(workspaceTask);
    if (selectedCloudItemId.value && locallyClosedRemoteTaskIds.value.has(selectedCloudItemId.value)) {
      selectedCloudItemId.value = null;
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    client.close();
  }
}

function deleteRemoteCloudTaskMetadata(workspaceTask: WorkspaceTask): void {
  for (const source of workspaceTask.sources) {
    if (source.kind !== "cloud" || !source.terminalRef) continue;
    void deleteRemoteTaskSnapshots({
      ownerDesktopId: source.terminalRef.ownerDesktopId,
      localRepoId: source.terminalRef.ownerLocalRepoId
        ?? resolveRemoteCloseLocalRepoId(workspaceTask, source.taskId, source.terminalRef.ownerLocalTaskId),
      ownerLocalTaskId: source.terminalRef.ownerLocalTaskId,
    }).catch((error) => {
      console.warn("[cloud] failed to delete remote task metadata:", error);
    });
  }
}

function resolveRemoteCloseLocalRepoId(
  workspaceTask: WorkspaceTask,
  sourceTaskId: string,
  ownerLocalTaskId: string,
): string {
  if (!workspaceTask.item.repo_id.startsWith("cloud:")) return workspaceTask.item.repo_id;
  const unprefixed = sourceTaskId.startsWith("cloud:")
    ? sourceTaskId.slice("cloud:".length)
    : sourceTaskId;
  const suffix = `:${ownerLocalTaskId}`;
  return unprefixed.endsWith(suffix)
    ? unprefixed.slice(0, -suffix.length)
    : workspaceTask.item.repo_id.slice("cloud:".length);
}

async function advanceSelectedRemoteWorkspaceTask(workspaceTask: NonNullable<typeof selectedWorkspaceTask.value>) {
  const remoteRef = workspaceTask.terminal.remoteRef;
  if (!remoteRef || !workspaceTask.capabilities.canAdvanceStage) {
    toast.error("Remote task is not reachable.");
    return;
  }

  const client = workspaceTask.terminal.kind === "lan"
    ? await createConfiguredDesktopLanTerminalClient()
    : await createConfiguredDesktopRelayTerminalClient();
  if (!client) {
    toast.error("Remote task owner is unavailable.");
    return;
  }

  try {
    await client.advanceStage({
      desktopId: remoteRef.ownerDesktopId,
      taskId: remoteRef.ownerLocalTaskId,
    });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    client.close();
  }
}

// Keyboard shortcuts
const keyboardActions = {
  newTask: () => {
    if (sidebarRepos.value.length === 0) {
      toast.warning(t("toasts.noReposLoaded"));
      return;
    }
    openNewTaskModal().catch((e) => console.error("[App] openNewTaskModal failed:", e));
  },
  newWindow: async () => {
    await windowWorkspace.openWindow({
      selectedRepoId: store.selectedRepoId,
      selectedItemId: store.selectedItemId,
    });
  },
  closeWindow: async () => {
    await requestCloseCurrentWindow();
  },
  openFile: () => {
    if (showFilePickerModal.value) {
      const z = filePickerRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        showFilePickerModal.value = false;
        filePickerHidden.value = true;
      } else {
        filePickerRef.value?.bringToFront();
      }
    } else {
      showFilePickerOnTop();
    }
  },
  toggleFilePreview: () => {
    if (showFilePreviewModal.value) {
      showFilePreviewModal.value = false;
      previewHidden.value = true;
      previewFromPicker.value = false;
      previewFromTree.value = false;
    } else {
      const recalledPreview = getCurrentPreviewRecall();
      if (recalledPreview) {
        openFilePreview(recalledPreview.filePath, recalledPreview.initialLine, false);
        return;
      }
      previewHidden.value = false;
      previewFromPicker.value = false;
      previewFromTree.value = false;
      showFilePickerOnTop();
    }
  },
  toggleTreeExplorer: () => {
    if (showTreeExplorer.value) {
      const z = treeExplorerRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        closeTreeExplorer();
      } else {
        treeExplorerRef.value?.bringToFront();
      }
    } else {
      showTreeExplorer.value = true;
    }
  },
  openInIDE: async () => {
    const item = store.currentItem;
    const repo = store.selectedRepo;
    if (!item?.branch || !repo) return;
    const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
    await invoke("run_script", { script: `${store.ideCommand} "${worktreePath}"`, cwd: worktreePath, env: {} }).catch((e) => console.error("[openInIDE] failed:", e));
  },
  advanceStage: () => {
    const workspaceTask = selectedWorkspaceTask.value;
    if (workspaceTask) {
      if (!workspaceTask.capabilities.canAdvanceStage) return;
      if (!workspaceTask.localTaskId) {
        void advanceSelectedRemoteWorkspaceTask(workspaceTask);
        return;
      }
      void store.advanceStage(workspaceTask.localTaskId);
      return;
    }

    const item = store.currentItem;
    if (!item) return;
    if (store.selectedItemId && item.id !== store.selectedItemId) return;
    void store.advanceStage(item.id);
  },
  closeTask: () => closeSelectedWorkspaceTask(),
  undoClose: () => store.undoClose(),
  navigateUp: () => navigateItems(-1),
  navigateDown: () => navigateItems(1),
  goToOldestUnread: () => selectUnreadTaskWithReadFallback("oldest"),
  goToNewestUnread: () => selectUnreadTaskWithReadFallback("newest"),
  goToOldestRead: () => selectReadTask("oldest"),
  goToNewestRead: () => selectReadTask("newest"),
  navigateRepoUp: () => navigateRepos(-1),
  navigateRepoDown: () => navigateRepos(1),
  toggleSidebar: () => { sidebarHidden.value = !sidebarHidden.value; },
  toggleMaximize: () => {
    const ctx = currentShortcutContext.value;
    maximizedModal.value = maximizedModal.value === ctx ? null : ctx;
  },
  dismiss: () => {
    if (showCommandPalette.value) { showCommandPalette.value = false; return true; }
    if (showShortcutsModal.value) { showShortcutsModal.value = false; return true; }
    if (showPeerPicker.value) { closePeerPicker(); return true; }
    if (showFilePickerModal.value) { closeFilePicker(); return true; }
    if (showFilePreviewModal.value) {
      const shouldCloseFileFlow = filePreviewRef.value?.dismiss() ?? true;
      if (shouldCloseFileFlow) closeFileFlow();
      return true;
    }
    // Shell before diff: let Escape reach the shell terminal (vim, etc.)
    if (showShellModal.value) { return; }
    if (showDiffModal.value) { showDiffModal.value = false; maximizedModal.value = null; return true; }
    if (showAnalyticsModal.value) { showAnalyticsModal.value = false; return true; }
    if (showCommitGraphModal.value) {
      const shouldCloseCommitGraph = commitGraphModalRef.value?.dismiss() ?? true;
      if (shouldCloseCommitGraph) {
        showCommitGraphModal.value = false;
      }
      return true;
    }
    if (showTreeExplorer.value) {
      const shouldCloseTreeExplorer = treeExplorerRef.value?.dismiss() ?? true;
      if (shouldCloseTreeExplorer) {
        closeTreeExplorer();
      }
      return true;
    }
    if (showNewTaskModal.value) { showNewTaskModal.value = false; return true; }
    if (showAddRepoModal.value) { showAddRepoModal.value = false; return true; }
  },
  openShell: () => {
    const workspaceTask = selectedWorkspaceTask.value;
    if (workspaceTask && !workspaceTask.capabilities.canOpenShell) {
      toast.warning(t("toasts.remoteShellUnavailable"));
      return;
    }
    if (!store.selectedRepo || !store.currentItem) return;
    if (showShellModal.value && !shellRepoRoot.value) {
      const z = shellModalRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        onShellClose();
      } else {
        shellModalRef.value?.bringToFront();
      }
    } else {
      shellRepoRoot.value = false;
      showShellModal.value = true;
    }
  },
  openShellRepoRoot: () => {
    if (showShellModal.value && shellRepoRoot.value) {
      const z = shellModalRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        onShellClose();
      } else {
        shellModalRef.value?.bringToFront();
      }
    } else {
      shellRepoRoot.value = true;
      showShellModal.value = true;
    }
  },
  showDiff: () => {
    if (!store.selectedRepo) return;
    if (showDiffModal.value) {
      const z = diffModalRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        showDiffModal.value = false;
        maximizedModal.value = null;
      } else {
        diffModalRef.value?.bringToFront();
      }
    } else {
      showDiffModal.value = true;
    }
  },
  showCommitGraph: () => {
    if (!store.selectedRepo) return;
    if (showCommitGraphModal.value) {
      const z = commitGraphModalRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        showCommitGraphModal.value = false;
      } else {
        commitGraphModalRef.value?.bringToFront();
      }
    } else {
      showCommitGraphModal.value = true;
    }
  },
  showShortcuts: () => {
    if (showShortcutsModal.value) {
      if (shortcutsStartFull.value && currentShortcutContext.value !== "main") {
        // Showing all in a modal context → switch to contextual
        shortcutsStartFull.value = false;
      } else {
        showShortcutsModal.value = false;
      }
      return;
    }
    showCommandPalette.value = false;
    shortcutsContext.value = currentShortcutContext.value;
    // Main = always full set; modals start in context mode
    shortcutsStartFull.value = currentShortcutContext.value === "main";
    showShortcutsModal.value = true;
  },
  showAllShortcuts: () => {
    if (showShortcutsModal.value) {
      if (!shortcutsStartFull.value) {
        // Showing contextual → switch to all
        shortcutsStartFull.value = true;
      } else {
        showShortcutsModal.value = false;
      }
      return;
    }
    showCommandPalette.value = false;
    shortcutsContext.value = currentShortcutContext.value;
    shortcutsStartFull.value = true;
    showShortcutsModal.value = true;
  },
  commandPalette: () => {
    showCommandPalette.value = !showCommandPalette.value;
    if (showCommandPalette.value) {
      const repo = store.selectedRepo;
      if (repo) scanCustomTasks(repo.path);
    }
  },
  showAnalytics: () => { showAnalyticsModal.value = !showAnalyticsModal.value; },
  goBack: () => store.goBack(),
  goForward: () => store.goForward(),
  createRepo: () => { addRepoInitialTab.value = "create"; showAddRepoModal.value = true; },
  importRepo: () => { addRepoInitialTab.value = "import"; showAddRepoModal.value = true; },
  blockTask: () => { handleBlockTask(); },
  editBlockedTask: () => { handleEditBlockedTask(); },
  openPreferences: () => { showPreferencesPanel.value = !showPreferencesPanel.value; },
  prevTab: () => { preferencesRef.value?.cycleTab(-1); },
  nextTab: () => { preferencesRef.value?.cycleTab(1); },
  focusSearch: () => { sidebarRef.value?.focusSearch(); },
};
useKeyboardShortcuts(keyboardActions, {
  context: () => currentShortcutContext.value,
  beforeAction: (action) => {
    if (action !== "showShortcuts" && action !== "showAllShortcuts" && action !== "dismiss" && showShortcutsModal.value) {
      showShortcutsModal.value = false;
    }
  },
});

function focusAgentTerminal() {
  nextTick(() => {
    const el = document.querySelector(".main-panel .xterm-helper-textarea") as HTMLElement | null;
    el?.focus();
  });
}

function listenNativeMenuAction(
  eventName: string,
  action: () => void | Promise<void>,
  label: string,
) {
  void (async () => {
    try {
      const unlisten = await listenCurrentWebviewWindow(eventName, async () => {
        await action();
      });
      appUnlisteners.push(unlisten);
    } catch (e: unknown) {
      console.error(`[App] native ${label} listener registration failed:`, e);
    }
  })();
}

function isFileTransfer(event: DragEvent): boolean {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  if (transfer.files.length > 0) return true;
  return Array.from(transfer.types).includes("Files");
}

function suppressFileDropNavigation(event: DragEvent) {
  if (!isFileTransfer(event)) return;
  event.preventDefault();
}

function handleFileLinkActivate(event: Event) {
  const detail = (event as CustomEvent).detail as { path: string; line?: number };
  openFilePreview(detail.path, detail.line, false);
}

// Auto-restore focus to whatever had it before the modal opened
const anyModalOpen = computed(() =>
  showNewTaskModal.value || showAddRepoModal.value || showShortcutsModal.value ||
  showFilePickerModal.value || showFilePreviewModal.value || showDiffModal.value ||
  showTreeExplorer.value || showShellModal.value || showAnalyticsModal.value ||
  showBlockerSelect.value || showPreferencesPanel.value || showCommitGraphModal.value ||
  showPeerPicker.value
);
useRestoreFocus(anyModalOpen);

// Restore focus after native macOS fullscreen exit.
// WKWebView loses first-responder status during the exit animation, breaking
// terminal input and keyboard shortcuts. The Rust side calls
// evaluateJavaScript: after a delay, which triggers becomeFirstResponder on
// WKWebView (WebKit Bug 143482 fix). We track the last meaningful focused
// element and expose a global restore function for that call.
let lastFocusedElement: HTMLElement | null = null;
document.addEventListener("focusin", (e) => {
  const el = e.target as HTMLElement;
  if (el && el !== document.body) lastFocusedElement = el;
});
(window as unknown as Record<string, unknown>).__kannaRestoreFocus = () => {
  if (lastFocusedElement) {
    lastFocusedElement.focus();
  }
};

async function handleSelectRepo(repoId: string) {
  if (repoId.startsWith("cloud:")) {
    selectedCloudRepoId.value = repoId;
    store.selectedRepoId = repoId;
    store.selectedItemId = store.lastSelectedItemByRepo[repoId] ?? null;
    selectedCloudItemId.value = store.selectedItemId;
    await windowWorkspace.persistSelection({
      selectedRepoId: store.selectedRepoId,
      selectedItemId: store.selectedItemId,
    });
    return;
  }
  selectedCloudRepoId.value = null;
  selectedCloudItemId.value = null;
  await store.selectRepo(repoId);
}

async function handleSelectItem(itemId: string, previousItemId?: string | null) {
  const workspaceTask = workspaceTasksByItemId.value.get(itemId);
  if (workspaceTask && workspaceTask.owner.kind !== "local") {
    selectedCloudRepoId.value = workspaceTask.repoKey;
    selectedCloudItemId.value = itemId;
    store.selectedRepoId = workspaceTask.repoKey;
    store.selectedItemId = itemId;
    store.lastSelectedItemByRepo[workspaceTask.repoKey] = itemId;
    await windowWorkspace.persistSelection({
      selectedRepoId: store.selectedRepoId,
      selectedItemId: store.selectedItemId,
    });
    return;
  }
  selectedCloudRepoId.value = null;
  selectedCloudItemId.value = null;
  if (previousItemId !== undefined) {
    await store.selectItem(itemId, { previousItemId });
  } else {
    await store.selectItem(itemId);
  }
}

async function openNewTaskModal(repoId?: string) {
  const targetRepoId = repoId ?? store.selectedRepoId ?? (sidebarRepos.value.length === 1 ? sidebarRepos.value[0]?.id : undefined);
  if (targetRepoId) store.selectedRepoId = targetRepoId;
  const repoPath = store.repos.find((r) => r.id === targetRepoId)?.path;
  if (repoPath) {
    const pipelinesDir = `${repoPath}/.kanna/pipelines`;
    const [files, configContent, defaultBranch, baseBranches] = await Promise.all([
      invoke<string[]>("list_dir", { path: pipelinesDir }).catch((error) => {
        console.debug("[App] no custom pipelines directory available for new task modal:", error);
        return [] as string[];
      }),
      invoke<string>("read_text_file", { path: `${repoPath}/.kanna/config.json` }).catch((error) => {
        console.debug("[App] no repo config available for new task modal:", error);
        return "";
      }),
      invoke<string>("git_default_branch", { repoPath }).catch((error) => {
        console.debug("[App] failed to read default branch for new task modal:", error);
        return "";
      }),
      invoke<string[]>("git_list_base_branches", { repoPath }).catch((error) => {
        console.debug("[App] failed to list base branches for new task modal:", error);
        return [] as string[];
      }),
    ]);
    availablePipelines.value = files
      .filter((f) => f.endsWith(".json") && f !== "schema.json")
      .map((f) => f.replace(/\.json$/, ""));
    if (configContent) {
      try {
        const config = parseRepoConfig(configContent);
        defaultPipelineName.value = config.pipeline;
      } catch (error) {
        console.debug("[App] failed to parse repo config while opening new task modal:", error);
        defaultPipelineName.value = undefined;
      }
    } else {
      defaultPipelineName.value = undefined;
    }
    repoDefaultBranchName.value = defaultBranch || undefined;
    availableBaseBranches.value = baseBranches;
    defaultBaseBranchName.value =
      getDefaultBaseBranch(baseBranches, defaultBranch || "main") || undefined;
  } else if (isCloudOnlyRepoId(targetRepoId)) {
    const cloudRepo = remoteSnapshot.value.repos.find((repo) => repo.id === targetRepoId);
    const remoteUrl = cloudRepo?.remote_url ?? null;
    const baseBranches = remoteUrl
      ? await invoke<string[]>("git_list_remote_base_branches", { remoteUrl }).catch((error) => {
          console.debug("[App] failed to list remote base branches for cloud repo:", error);
          return [] as string[];
        })
      : [];
    availablePipelines.value = [];
    defaultPipelineName.value = undefined;
    repoDefaultBranchName.value = cloudRepo?.default_branch || undefined;
    availableBaseBranches.value = baseBranches;
    defaultBaseBranchName.value =
      getDefaultBaseBranch(baseBranches, cloudRepo?.default_branch || "main") || undefined;
  } else {
    availablePipelines.value = [];
    defaultPipelineName.value = undefined;
    availableBaseBranches.value = [];
    defaultBaseBranchName.value = undefined;
    repoDefaultBranchName.value = undefined;
  }
  showNewTaskModal.value = true;
}

// Handlers that mix UI state + store
async function handleNewTaskSubmit(
  prompt: string,
  agentProvider: AgentProvider,
  pipelineName?: string,
  baseBranch?: string,
  agentType: "pty" | "agent" = "pty",
) {
  if (!store.selectedRepoId) {
    if (sidebarRepos.value.length === 1) {
      store.selectedRepoId = sidebarRepos.value[0].id;
    } else {
      toast.warning(t('toasts.selectRepoFirst'));
      return;
    }
  }
  let repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo && isCloudOnlyRepoId(store.selectedRepoId)) {
    const cloudRepoId = store.selectedRepoId;
    const remoteUrl = cloudRepoRemoteUrl(cloudRepoId);
    if (!remoteUrl) {
      toast.error(`${t('toasts.taskCreationFailed')}: remote URL is unavailable for this cloud repo`);
      return;
    }
    try {
      const destination = await allocateCloudRepoClonePath(remoteUrl, cloudRepoId);
      await store.cloneAndImportRepo(remoteUrl, destination);
      repo = store.repos.find((candidate) => candidate.id === store.selectedRepoId)
        ?? store.repos.find((candidate) => candidate.path === destination);
      if (!repo) {
        throw new Error("cloned repo was not imported");
      }
      selectedCloudRepoId.value = null;
      selectedCloudItemId.value = null;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Cloud repo clone failed:", e);
      toast.error(`${t('toasts.cloneFailed')}: ${msg}`);
      return;
    }
  }
  if (!repo) return;
  showNewTaskModal.value = false;
  try {
    await store.createItem(store.selectedRepoId, repo.path, prompt, agentType, {
      agentProvider,
      pipelineName,
      baseBranch,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Task creation failed:", e);
    toast.error(`${t('toasts.taskCreationFailed')}: ${msg}`);
  }
}

async function allocateCloudRepoClonePath(remoteUrl: string, repoId: string): Promise<string> {
  const homeDir = await invoke<string>("read_env_var", { name: "HOME" }).catch((error) => {
    console.debug("[App] failed to read HOME while allocating cloud repo clone path:", error);
    return "/Users/unknown";
  });
  const parentDir = defaultReposHome(homeDir);
  const baseName = sanitizeCloudRepoName(parseCloudRepoName(remoteUrl) ?? repoId.replace(/^cloud:/, ""));
  for (let i = 1; i <= 99; i++) {
    const candidateName = i === 1 ? baseName : `${baseName}-${i}`;
    const candidatePath = `${parentDir}/${candidateName}`;
    const exists = await invoke<boolean>("file_exists", { path: candidatePath }).catch((error) => {
      console.debug("[App] failed to check candidate cloud clone path; treating as available:", error);
      return false;
    });
    if (!exists) return candidatePath;
  }
  return `${parentDir}/${baseName}-${Date.now()}`;
}

function parseCloudRepoName(remoteUrl: string): string | null {
  const parsed = parseRepoInput(remoteUrl);
  if (parsed.repo) return parsed.repo;
  const lastSegment = remoteUrl.trim().split(/[/:]/).filter(Boolean).pop();
  if (!lastSegment) return null;
  return lastSegment.replace(/\.git$/, "");
}

function sanitizeCloudRepoName(name: string): string {
  const sanitized = name.trim().replace(/[\\/]/g, "-");
  return sanitized.length > 0 ? sanitized : "repo";
}

async function handleCreateRepo(name: string, path: string) {
  try {
    await store.createRepo(name, path);
    showAddRepoModal.value = false;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`${t('toasts.repoCreationFailed')}: ${msg}`);
  }
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await store.importRepo(path, name, defaultBranch);
  showAddRepoModal.value = false;
}

const cloningRepo = ref(false);

async function handleCloneRepo(url: string, destination: string) {
  cloningRepo.value = true;
  try {
    await store.cloneAndImportRepo(url, destination);
    showAddRepoModal.value = false;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`${t('toasts.cloneFailed')}: ${msg}`);
  } finally {
    cloningRepo.value = false;
  }
}

const currentBlockers = computedAsync(async () => {
  if (mainPanelIsCloudTask.value) return [];
  const item = store.currentItem;
  if (!item) return [];
  return store.listBlockersForItem(item.id);
}, []);

let colorSchemeQuery: MediaQueryList | null = null;
let themeSyncRevision = 0;

function readSystemPrefersDark(): boolean {
  if (colorSchemeQuery) return colorSchemeQuery.matches;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function syncThemeRuntime() {
  const revision = ++themeSyncRevision;
  setThemePreferences({
    appTheme: preferences.appTheme,
    codeTheme: preferences.codeTheme,
  });

  if (preferences.appTheme === "system") {
    void syncNativeAppTheme(null)
      .catch((error: unknown) => {
        console.error("[App] failed to sync native theme:", error);
      })
      .then(() => {
        if (revision !== themeSyncRevision) return;
        setSystemPrefersDark(readSystemPrefersDark());
        applyCurrentDocumentTheme();
      });
    return;
  }

  applyCurrentDocumentTheme();
  void syncNativeAppTheme(effectiveAppTheme.value).catch((error: unknown) => {
    console.error("[App] failed to sync native theme:", error);
  });
}

function handleSystemThemeChange(event: MediaQueryListEvent) {
  setSystemPrefersDark(event.matches);
  syncThemeRuntime();
}

function startSystemThemeListener() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    setSystemPrefersDark(false);
    syncThemeRuntime();
    return;
  }

  colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  setSystemPrefersDark(colorSchemeQuery.matches);
  if (typeof colorSchemeQuery.addEventListener === "function") {
    colorSchemeQuery.addEventListener("change", handleSystemThemeChange);
  } else {
    colorSchemeQuery.addListener?.(handleSystemThemeChange);
  }
  syncThemeRuntime();
}

function stopSystemThemeListener() {
  if (typeof colorSchemeQuery?.removeEventListener === "function") {
    colorSchemeQuery.removeEventListener("change", handleSystemThemeChange);
  } else {
    colorSchemeQuery?.removeListener?.(handleSystemThemeChange);
  }
  colorSchemeQuery = null;
}

async function trackCommandUsage(commandId: string) {
  const counts = { ...commandUsageCounts.value };
  counts[commandId] = (counts[commandId] || 0) + 1;
  commandUsageCounts.value = counts;
  await setSetting(db, "commandPaletteUsage", JSON.stringify(counts));
}

// Preferences update handler
async function handlePreferenceUpdate(key: string, value: string) {
  await store.savePreference(key, value);
  if (key === "locale" && ["en", "ja", "ko"].includes(value)) {
    i18n.global.locale.value = value as "en" | "ja" | "ko";
    preferences.locale = value;
  } else if (key === "suspendAfterMinutes") {
    preferences.suspendAfterMinutes = parseInt(value, 10) || 30;
  } else if (key === "killAfterMinutes") {
    preferences.killAfterMinutes = parseInt(value, 10) || 60;
  } else if (key === "ideCommand") {
    preferences.ideCommand = value;
  } else if (key === "dev.lingerTerminals") {
    preferences.devLingerTerminals = value === "true";
  } else if (key === "defaultAgentProvider") {
    preferences.defaultAgentProvider = firstSupportedAgentProvider(value) ?? "claude";
  } else if (key === "appTheme") {
    preferences.appTheme = normalizeAppThemePreference(value);
    syncThemeRuntime();
  } else if (key === "codeTheme") {
    preferences.codeTheme = normalizeCodeThemePreference(value);
    syncThemeRuntime();
  }
}

// Init
onMounted(async () => {
  appUpdate.start();
  window.addEventListener("dragenter", suppressFileDropNavigation);
  window.addEventListener("dragover", suppressFileDropNavigation);
  window.addEventListener("drop", suppressFileDropNavigation);
  document.addEventListener("file-link-activate", handleFileLinkActivate);

  await restoreSidebarWidth();
  await store.init(db);
  preferences.appTheme = normalizeAppThemePreference(store.appTheme);
  preferences.codeTheme = normalizeCodeThemePreference(store.codeTheme);
  startSystemThemeListener();
  await nextTick();
  if (windowWorkspace && windowWorkspace.bootstrap.windowId === "main") {
    scheduleStartupBackup(dbName);
  }
  void initializeDesktopCloudAuth().catch((error) =>
    console.warn("[cloud] failed to initialize desktop auth:", error),
  );
  initializeDesktopLanTaskSync();
  await importPendingIncomingTransfers();
  if (import.meta.env.DEV && window.__KANNA_E2E__) {
    void remoteTaskDiagnostics.value;
    window.__KANNA_E2E__.ready = true;
  }

  try {
    const unlistenNativeNewWindow = await listenCurrentWebviewWindow(WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT, async () => {
      await keyboardActions.newWindow();
    });
    appUnlisteners.push(unlistenNativeNewWindow);
  } catch (e: unknown) {
    console.error("[App] native new-window listener registration failed:", e);
  }

  try {
    const unlistenNativeCloseWindow = await listenCurrentWebviewWindow(WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT, async () => {
      await keyboardActions.closeWindow();
    });
    appUnlisteners.push(unlistenNativeCloseWindow);
  } catch (e: unknown) {
    console.error("[App] native close-window listener registration failed:", e);
  }

  if (isTauri) {
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const unlistenNativeWindowCloseRequest = await getCurrentWindow().onCloseRequested(async (event) => {
          if (closingCurrentWindow) return;
          closingCurrentWindow = true;
          try {
            await windowWorkspace.forgetCurrentWindow();
          } catch (error: unknown) {
            closingCurrentWindow = false;
            event.preventDefault();
            console.error("[App] native window close request failed:", error);
          }
        });
        appUnlisteners.push(unlistenNativeWindowCloseRequest);
      } catch (e: unknown) {
        console.error("[App] native window close-request listener registration failed:", e);
      }
    })();
  }

  listenNativeMenuAction(
    WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
    keyboardActions.navigateUp,
    "navigate-task-up",
  );
  listenNativeMenuAction(
    WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
    keyboardActions.navigateDown,
    "navigate-task-down",
  );
  listenNativeMenuAction(
    WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
    keyboardActions.navigateRepoUp,
    "navigate-repo-up",
  );
  listenNativeMenuAction(
    WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
    keyboardActions.navigateRepoDown,
    "navigate-repo-down",
  );

  try {
    const unlistenTransferRequest = await listen("transfer-request", async (event: unknown) => {
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const request = parseIncomingTransferRequest(payload);
        await store.recordIncomingTransfer(request);
        await store.approveIncomingTransfer(request.transferId);
      } catch (e: unknown) {
        console.error("[App] failed to import incoming transfer request:", e);
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
    appUnlisteners.push(unlistenTransferRequest);
  } catch (e: unknown) {
    console.error("[App] transfer-request listener registration failed:", e);
  }

  try {
    const unlistenPairingStarted = await listen("pairing-started", async (event: unknown) => {
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const pairing = parsePairingCompletedEvent(payload);
        toast.info(`Enter code ${pairing.verificationCode} on ${pairing.displayName}.`);
      } catch (e: unknown) {
        console.error("[App] failed to handle pairing started event:", e);
      }
    });
    appUnlisteners.push(unlistenPairingStarted);
  } catch (e: unknown) {
    console.error("[App] pairing-started listener registration failed:", e);
  }

  try {
    const unlistenPairingRequested = await listen("pairing-requested", async (event: unknown) => {
      let pairingRequestId: string | null = null;
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const pairing = parsePairingRequestedEvent(payload);
        pairingRequestId = pairing.requestId;
        const enteredCode = window
          .prompt(`Enter pairing code for ${pairing.displayName}`)
          ?.trim() ?? null;
        if (enteredCode !== pairing.verificationCode) {
          await invoke("reject_peer_pairing", { pairingRequestId: pairing.requestId });
          toast.error("Pairing code did not match.");
          return;
        }

        await invoke("accept_peer_pairing", {
          pairingRequestId: pairing.requestId,
          verificationCode: enteredCode,
        });
        toast.info(`Paired with ${pairing.displayName}. Verify code ${pairing.verificationCode}.`);
      } catch (e: unknown) {
        console.error("[App] failed to handle pairing request event:", e);
        if (pairingRequestId) {
          try {
            await invoke("reject_peer_pairing", { pairingRequestId });
          } catch (rejectError: unknown) {
            console.error("[App] failed to reject pairing request:", rejectError);
          }
        }
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
    appUnlisteners.push(unlistenPairingRequested);
  } catch (e: unknown) {
    console.error("[App] pairing-requested listener registration failed:", e);
  }

  try {
    const unlistenPairingCompleted = await listen("pairing-completed", async (event: unknown) => {
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const pairing = parsePairingCompletedEvent(payload);
        console.debug("[transfer] pairing-completed event received", {
          peerId: pairing.peerId,
          displayName: pairing.displayName,
        });
        toast.info(`Paired with ${pairing.displayName}. Verify code ${pairing.verificationCode}.`);
      } catch (e: unknown) {
        console.error("[App] failed to handle pairing completion event:", e);
      }
    });
    appUnlisteners.push(unlistenPairingCompleted);
  } catch (e: unknown) {
    console.error("[App] pairing-completed listener registration failed:", e);
  }

  try {
    const unlistenOutgoingTransferCommitted = await listen("outgoing-transfer-committed", async (event: unknown) => {
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const committed = parseOutgoingTransferCommittedEvent(payload);
        await store.handleOutgoingTransferCommitted(committed);
      } catch (e: unknown) {
        console.error("[App] failed to handle outgoing transfer commit acknowledgment:", e);
      }
    });
    appUnlisteners.push(unlistenOutgoingTransferCommitted);
  } catch (e: unknown) {
    console.error("[App] outgoing-transfer-committed listener registration failed:", e);
  }

  try {
    const unlistenOutgoingTransferFinalizationRequested = await listen("outgoing-transfer-finalization-requested", async (event: unknown) => {
      const payload = (event as { payload?: unknown })?.payload ?? event;
      const request = parseOutgoingTransferFinalizationRequestEvent(payload);
      try {
        const finalized = await store.finalizeOutgoingTransfer(request.transferId);
        await invoke("complete_outgoing_transfer_finalization", {
          transferId: request.transferId,
          payload: finalized.payload,
          finalizedCleanly: finalized.finalizedCleanly,
          error: null,
        });
      } catch (error: unknown) {
        console.error("[App] failed to finalize outgoing transfer:", error);
        await invoke("complete_outgoing_transfer_finalization", {
          transferId: request.transferId,
          payload: null,
          finalizedCleanly: false,
          error: error instanceof Error ? error.message : String(error),
        }).catch((invokeError: unknown) => {
          console.error("[App] failed to report outgoing transfer finalization error:", invokeError);
        });
      }
    });
    appUnlisteners.push(unlistenOutgoingTransferFinalizationRequested);
  } catch (e: unknown) {
    console.error("[App] outgoing-transfer-finalization-requested listener registration failed:", e);
  }

  await warmTransferSidecar();

  // Cache $HOME for shell-at-home (no repo selected)
  invoke("read_env_var", { name: "HOME" }).then((val) => {
    homePath.value = val as string;
  }).catch(() => {
    homePath.value = "/Users";
  });

  // Load persisted locale
  const savedLocale = await getSetting(db, "locale");
  if (savedLocale && ["en", "ja", "ko"].includes(savedLocale)) {
    i18n.global.locale.value = savedLocale as "en" | "ja" | "ko";
    preferences.locale = savedLocale;
  }

  // Sync preferences from store
  preferences.suspendAfterMinutes = store.suspendAfterMinutes;
  preferences.killAfterMinutes = store.killAfterMinutes;
  preferences.ideCommand = store.ideCommand;
  preferences.devLingerTerminals = store.devLingerTerminals;

  const savedAgentProvider = await getSetting(db, "defaultAgentProvider");
  if (savedAgentProvider === "copilot") preferences.defaultAgentProvider = "copilot";
  else if (savedAgentProvider === "codex") preferences.defaultAgentProvider = "codex";
  else if (savedAgentProvider === "opencode") preferences.defaultAgentProvider = "opencode";

  startPeriodicBackup(dbName, ref(db) as Ref<DbHandle | null>);
  if (!store.hideShortcutsOnStartup) {
    shortcutsStartFull.value = true;
    showShortcutsModal.value = true;
  }
  const raw = await getSetting(db, "commandPaletteUsage");
  if (raw) {
    try { commandUsageCounts.value = JSON.parse(raw); }
    catch (e) { console.error("[App] corrupt commandPaletteUsage setting:", e); }
  }

});

onUnmounted(() => {
  while (appUnlisteners.length > 0) {
    const unlisten = appUnlisteners.pop();
    try {
      unlisten?.();
    } catch (e: unknown) {
      console.error("[App] failed to unlisten app event:", e);
    }
  }
});

onBeforeUnmount(() => {
  unsubscribeDesktopAuth?.();
  if (cloudRefreshTimer) {
    clearInterval(cloudRefreshTimer);
  }
  if (lanRefreshTimer) {
    clearInterval(lanRefreshTimer);
  }
  stopSidebarResize();
  window.removeEventListener("dragenter", suppressFileDropNavigation);
  window.removeEventListener("dragover", suppressFileDropNavigation);
  window.removeEventListener("drop", suppressFileDropNavigation);
  document.removeEventListener("file-link-activate", handleFileLinkActivate);
  stopSystemThemeListener();
  appUpdate.dispose();
});
</script>

<template>
  <div class="app" :class="{ mobile: isMobile }">
    <div
      v-if="!maximized && !sidebarHidden && (!isMobile || !store.selectedItemId)"
      class="sidebar-shell"
      :style="sidebarShellStyle"
      data-testid="sidebar-shell"
    >
      <Sidebar
        ref="sidebarRef"
        :repos="sidebarRepos"
        :pipeline-items="sidebarItems"
        :selected-repo-id="store.selectedRepoId"
        :selected-item-id="store.selectedItemId"
        :blocker-names="sidebarBlockerNames"
        @select-repo="handleSelectRepo"
        @select-item="handleSelectItem"
        @new-task="(repoId: string) => openNewTaskModal(repoId).catch((e) => console.error('[App] openNewTaskModal failed:', e))"
        @pin-item="store.pinItem"
        @unpin-item="store.unpinItem"
        @reorder-pinned="store.reorderPinned"
        @rename-item="store.renameItem"
        @rename-done="focusAgentTerminal"
        @hide-repo="store.hideRepo"
        @rename-repo="store.renameRepo"
        @reorder-repos="store.reorderRepos"
      />
      <div
        v-if="canResizeSidebar"
        class="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        data-testid="sidebar-resize-handle"
        @pointerdown="startSidebarResize"
      />
    </div>
    <div v-if="!isMobile || store.selectedItemId" class="main-column">
      <MainPanel
        ref="mainPanelRef"
        :item="mainPanelItem"
        :repo-path="mainPanelRepo?.path"
        :spawn-pty-session="store.spawnPtySession"
        :maximized="maximized"
        :blockers="currentBlockers"
        :has-repos="sidebarRepos.length > 0"
        :pending-setup="store.currentItem ? (store.pendingSetupIds ?? []).includes(store.currentItem.id) : false"
        :cloud-task="mainPanelIsCloudTask"
        :cloud-terminal-ref="mainPanelCloudTerminalRef"
        @close-task="closeSelectedWorkspaceTask"
        @back="store.selectedItemId = null"
      />
    </div>

    <NewTaskModal
      v-if="showNewTaskModal"
      :default-agent-provider="preferences.defaultAgentProvider"
      :pipelines="availablePipelines"
      :default-pipeline="defaultPipelineName"
      :base-branches="availableBaseBranches"
      :default-base-branch="defaultBaseBranchName"
      :default-branch-name="repoDefaultBranchName"
      @submit="(prompt, agentProvider, pipelineName, baseBranch, agentType) => handleNewTaskSubmit(prompt, agentProvider, pipelineName, baseBranch, agentType)"
      @cancel="showNewTaskModal = false"
    />
    <AddRepoModal
      v-if="showAddRepoModal"
      :initial-tab="addRepoInitialTab"
      :cloning="cloningRepo"
      @create="handleCreateRepo"
      @import="handleImportRepo"
      @clone="handleCloneRepo"
      @cancel="showAddRepoModal = false"
    />
    <CommandPaletteModal
      v-if="showCommandPalette"
      :extra-commands="paletteExtraCommands"
      :dynamic-commands="paletteDynamicCommands"
      :usage-counts="commandUsageCounts"
      @close="showCommandPalette = false"
      @execute="(action: ActionName) => keyboardActions[action]()"
      @use="trackCommandUsage"
    />
    <KeyboardShortcutsModal
      v-if="showShortcutsModal"
      :context="shortcutsContext"
      :start-in-full-mode="shortcutsStartFull"
      :hide-on-startup="store.hideShortcutsOnStartup"
      @close="showShortcutsModal = false"
      @update:hide-on-startup="(val: boolean) => store.savePreference('hideShortcutsOnStartup', String(val))"
      @update:full-mode="shortcutsStartFull = $event"
    />
    <KeepAlive :max="10">
      <ShellModal
        ref="shellModalRef"
        v-if="showShellModal && !isMobile && (store.selectedRepo ? (shellRepoRoot || store.currentItem) : shellRepoRoot)"
        :key="`shell-${shellRepoRoot && !store.selectedRepo ? 'home' : shellRepoRoot ? `repo-${store.selectedRepo!.id}` : `wt-${store.currentItem?.id}`}`"
        :session-id="`shell-${shellRepoRoot && !store.selectedRepo ? 'home' : shellRepoRoot ? `repo-${store.selectedRepo!.id}` : `wt-${store.currentItem?.id}`}`"
        :cwd="shellModalCwd"
        :fallback-cwd="shellModalFallbackCwd"
        :port-env="shellRepoRoot ? undefined : store.currentItem?.port_env"
        :maximized="maximizedModal === 'shell'"
        @close="onShellClose"
      />
    </KeepAlive>
    <DiffModal
      ref="diffModalRef"
      v-if="showDiffModal && !isMobile && store.selectedRepo?.path"
      :repo-path="store.selectedRepo.path"
      :worktree-path="store.currentItem?.branch ? activeWorktreePath : undefined"
      :initial-scope="currentDiffViewState?.scope"
      :initial-scroll-positions="currentDiffViewState?.scrollPositions"
      :initial-branch-include="currentDiffViewState?.branchInclude"
      :base-ref="store.currentItem?.base_ref ?? undefined"
      :view-key="currentDiffViewKey"
      :maximized="maximizedModal === 'diff'"
      @scope-change="(scope: DiffScope) => updateCurrentDiffViewState({ scope })"
      @scroll-state-change="(scrollPositions: DiffScrollPositions) => updateCurrentDiffViewState({ scrollPositions })"
      @branch-include-change="(branchInclude: BranchInclude) => updateCurrentDiffViewState({ branchInclude })"
      @close="showDiffModal = false; maximizedModal = null"
    />
    <CommitGraphModal
      ref="commitGraphModalRef"
      v-if="showCommitGraphModal && store.selectedRepo?.path"
      :repo-path="store.selectedRepo.path"
      :worktree-path="store.currentItem?.branch ? activeWorktreePath : undefined"
      @close="showCommitGraphModal = false"
    />
    <div
      v-if="(showFilePickerModal || filePickerHidden) && !isMobile && store.selectedRepo?.path"
      v-show="showFilePickerModal"
    >
      <FilePickerModal
        ref="filePickerRef"
        :key="activeWorktreePath"
        :worktree-path="activeWorktreePath"
        :repo-root="store.selectedRepo?.path ?? ''"
        @close="closeFilePicker"
        @select="selectFileFromPicker"
      />
    </div>
    <TreeExplorerModal
      ref="treeExplorerRef"
      v-if="showTreeExplorer && treeExplorerRoot"
      :worktree-path="treeExplorerRoot"
      :repo-root="store.selectedRepo?.path ?? treeExplorerRoot"
      :home-path="homePath"
      :maximized="maximizedModal === 'tree'"
      :suspended="showFilePreviewModal && previewFromTree"
      @close="closeTreeExplorer"
      @open-file="(f: string) => openFilePreview(f, undefined, false, true)"
    />
    <FilePreviewModal
      ref="filePreviewRef"
      v-if="(showFilePreviewModal || previewHidden) && !isMobile && store.selectedRepo?.path"
      v-show="showFilePreviewModal"
      :key="`${activeWorktreePath}:${previewFilePath}`"
      :file-path="previewFilePath"
      :worktree-path="activeWorktreePath"
      :ide-command="store.ideCommand"
      :initial-line="previewInitialLine"
      :initial-markdown-mode="currentPreviewMarkdownMode"
      :maximized="maximizedModal === 'file'"
      @close="closeFilePreview(true)"
      @update-markdown-mode="updateCurrentPreviewMarkdownMode"
    />
    <AnalyticsModal
      v-if="showAnalyticsModal"
      :db="db"
      :repo-id="store.selectedRepoId"
      @close="showAnalyticsModal = false"
    />
    <BlockerSelectModal
      v-if="showBlockerSelect"
      :candidates="blockerCandidates"
      :disabled-ids="disabledBlockerIds"
      :preselected="blockerSelectMode === 'edit' ? preselectedBlockerIds : undefined"
      :title="blockerSelectMode === 'block' ? $t('app.selectBlockingTasks') : $t('app.editBlockingTasks')"
      @confirm="onBlockerConfirm"
      @cancel="showBlockerSelect = false"
    />
    <PeerPickerModal
      v-if="showPeerPicker"
      :peers="peerPickerMode === 'pair'
        ? transferPeers.filter((peer) => !peer.trusted)
        : transferPeers.filter((peer) => peer.trusted)"
      :loading="transferPeersLoading"
      :title="peerPickerMode === 'pair' ? $t('taskTransfer.pairPeer') : $t('taskTransfer.pushToMachine')"
      :action-label="peerPickerMode === 'pair' ? $t('taskTransfer.pairPeer') : $t('taskTransfer.pushToMachine')"
      :action-pending="transferPeerActionPending"
      :require-trusted="peerPickerMode !== 'pair'"
      @cancel="closePeerPicker"
      @select="(peerId) => peerPickerMode === 'pair' ? handlePairPeer(peerId) : handlePeerSelected(peerId)"
    />
    <PreferencesPanel
      v-if="showPreferencesPanel"
      ref="preferencesRef"
      :preferences="preferences"
      @update="handlePreferenceUpdate"
      @close="showPreferencesPanel = false"
    />
    <AppUpdatePrompt :controller="appUpdate" />
    <ToastContainer />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
</style>

<style scoped>
.app {
  display: flex;
  height: 100%;
  width: 100%;
}

.sidebar-shell {
  position: relative;
  flex: 0 0 auto;
  height: 100%;
  min-height: 0;
}

.sidebar-shell :deep(.sidebar) {
  width: 100%;
  min-width: 0;
  max-width: none;
}

.sidebar-resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}

.sidebar-resize-handle::after {
  content: "";
  position: absolute;
  top: 0;
  right: 2px;
  width: 1px;
  height: 100%;
  background: transparent;
}

.sidebar-resize-handle:hover::after,
.sidebar-resize-handle:focus-visible::after {
  background: var(--kn-accent);
}

:global(body.is-resizing-sidebar) {
  cursor: col-resize;
  user-select: none;
}

.main-column {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

@media (max-width: 768px) {
  .app {
    flex-direction: column;
  }
}

.app.mobile {
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}

.app.mobile :deep(.sidebar) {
  width: 100%;
  max-width: none;
  height: 100%;
  border-right: none;
}

.app.mobile .sidebar-shell {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  height: 100%;
}

.app.mobile .main-panel {
  width: 100%;
  height: 100%;
}

.app.mobile .main-column {
  width: 100%;
  height: 100%;
}
</style>
