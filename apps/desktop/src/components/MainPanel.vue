<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  watch,
  type ComponentPublicInstance,
  type Ref,
} from "vue";
import { AGENT_PROVIDERS, getAgentProviderSpec } from "@kanna/agent-protocol";
import type { AgentProvider, BlockerDisplayItem } from "../types/kanna";
import type { TaskUiSlot } from "../types/taskUi";
import type { RequestRevisionOptions } from "../stores/workflow";
import {
  fetchDesktopTaskDetail,
  type DesktopTaskDetail,
} from "../services/desktopServerClient";
import { isBlockerResolved } from "../utils/blockerResolution";
import { invoke } from "../invoke";
import TaskHeader from "./TaskHeader.vue";
import TerminalTabs from "./TerminalTabs.vue";
import MainTabBar from "./MainTabBar.vue";
import DiffModal from "./DiffModal.vue";
import FilePreviewModal from "./FilePreviewModal.vue";
import ShellModal from "./ShellModal.vue";
import TreeExplorerModal from "./TreeExplorerModal.vue";
import CommitGraphModal from "./CommitGraphModal.vue";
import AnalyticsModal from "./AnalyticsModal.vue";
import ImageUrlPreviewModal from "./ImageUrlPreviewModal.vue";
import PreferencesPanel from "./PreferencesPanel.vue";
import { AGENT_TAB_ID, type MainTab } from "../composables/useMainTabs";
import type { MainTabViewsController } from "./MainPanel.types";
import type { BranchInclude, DiffScope, DiffScrollPositions } from "../composables/useAppModals";
import type { MarkdownPreviewMode } from "../stores/markdownPreviewMode";
import CloudTerminalCache, {
  type CloudTerminalCacheEntry,
} from "./CloudTerminalCache.vue";

const props = defineProps<{
  uiSlot: TaskUiSlot | null;
  repoPath?: string;
  spawnPtySession?: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>;
  recoverTaskSession?: (sessionId: string, options?: { cols?: number; rows?: number }) => Promise<void>;
  maximized?: boolean;
  blockers?: BlockerDisplayItem[];
  blocked?: boolean;
  hasRepos?: boolean;
  cloudTask?: boolean;
  cloudTerminalRef?: {
    ownerDesktopId: string;
    ownerLocalTaskId: string;
    transport?: "cloud" | "lan";
  } | null;
  requestRevision?: (taskId: string, options: RequestRevisionOptions) => Promise<boolean>;
  /**
   * Present in the app; absent in isolated tests, where the panel is just the
   * agent session it has always been.
   */
  views?: MainTabViewsController;
}>();

const emit = defineEmits<{
  (e: "back"): void;
}>();

const isMobile = __KANNA_MOBILE__;
const COMMAND_HINT_STORAGE_KEY = "kanna:hide-command-hint";
const item = computed(() => props.uiSlot?.task ?? null);

const tabs = computed<MainTab[]>(() => props.views?.tabs.tabs.value ?? []);
const activeTabId = computed(() => props.views?.tabs.activeTabId.value ?? AGENT_TAB_ID);
const agentTabActive = computed(() => activeTabId.value === AGENT_TAB_ID);
const openViewTabs = computed(() => tabs.value.filter((tab) => tab.kind !== "agent"));
/**
 * The panel's own empty state — "no task selected", or the agent-install help
 * when there are no repositories — belongs to a main area with nothing in it.
 * A repository scope with tabs open is not empty.
 */
const showEmptyState = computed(() => !props.uiSlot && tabs.value.length === 0);
const scopeRepoId = computed(() =>
  item.value?.repo_id ?? props.views?.store.selectedRepoId ?? null
);
const scopeRepoPath = computed(() =>
  props.repoPath ?? props.views?.store.selectedRepo?.path ?? ""
);
const taskWorktreePath = computed(() =>
  item.value?.branch ? `${props.repoPath}/.kanna-worktrees/${item.value.branch}` : undefined
);

function selectTab(id: string) {
  props.views?.tabs.activateTab(id);
}

function closeTab(id: string) {
  props.views?.tabs.closeTab(id);
}

/**
 * Consequences of a tab closing that belong to the panel. Wired into the tab
 * store by App.vue so they run however the tab was closed.
 */
function onTabClosed(tab: MainTab) {
  // The shell is how an operator installs an agent CLI before they have any
  // repositories, so closing it is the moment to look again.
  if (tab.kind === "shell" && !props.hasRepos) void checkAllClis();
}

/**
 * A tab id is only unique inside its task's tab set, and the same file path
 * can be open in two tasks. Keying the rendered view by scope as well makes a
 * task switch remount it against the new worktree instead of leaving the
 * previous task's content in a reused node.
 */
function tabKey(tab: MainTab): string {
  return `${props.views?.tabs.scopeKey.value ?? ""}:${tab.id}`;
}

const diffViewProps = computed(() => {
  const modals = props.views?.modals;
  if (!modals) return null;
  const state = modals.currentDiffViewState.value;
  const route = modals.activeRemoteTaskRoute.value;
  return {
    repoPath: modals.activeRepoPath.value || props.repoPath || "",
    worktreePath: modals.activeDiffWorktreePath.value,
    initialScope: state?.scope,
    initialScrollPositions: state?.scrollPositions,
    initialBranchInclude: state?.branchInclude,
    baseRef: item.value?.base_ref ?? undefined,
    viewKey: modals.currentDiffViewKey.value,
    remoteDiffLoader: modals.activeTaskViewIsRemote.value ? modals.readRemoteTaskDiff : undefined,
    remoteDesktopId: route?.desktopId,
    remoteTaskId: route?.taskId,
    remoteTransport: route?.transport,
  };
});

function fileViewProps(tab: MainTab) {
  const modals = props.views?.modals;
  return {
    filePath: tab.filePath ?? "",
    worktreePath: modals?.activeWorktreePath.value ?? taskWorktreePath.value ?? "",
    remoteContent: tab.remoteContent ?? null,
    remoteContentLoader: modals?.activeTaskViewIsRemote.value
      ? modals.readRemoteTaskFile
      : undefined,
    ideCommand: props.views?.store.ideCommand,
    initialLine: tab.initialLine,
    initialMarkdownMode: modals?.currentPreviewMarkdownMode.value,
  };
}

function shellSessionId(tab: MainTab): string {
  if (tab.shellScope === "repo") {
    const repoId = scopeRepoId.value;
    return repoId ? `shell-repo-${repoId}` : "shell-home";
  }
  return item.value ? `shell-wt-${item.value.id}` : "";
}

function shellCwd(tab: MainTab): string {
  if (tab.shellScope === "repo") {
    return scopeRepoPath.value || (props.views?.modals.homePath.value ?? "");
  }
  return taskWorktreePath.value ?? scopeRepoPath.value;
}

function treeViewProps() {
  const modals = props.views?.modals;
  const route = modals?.activeRemoteTaskRoute.value;
  return {
    worktreePath: modals?.treeExplorerRoot.value ?? taskWorktreePath.value ?? scopeRepoPath.value,
    repoRoot: scopeRepoPath.value || (modals?.treeExplorerRoot.value ?? ""),
    homePath: modals?.homePath.value,
    remoteDirectoryLoader: modals?.activeTaskViewIsRemote.value
      ? modals.listRemoteTaskDirectory
      : undefined,
    remoteDesktopId: route?.desktopId,
    remoteTaskId: route?.taskId,
    remoteTransport: route?.transport,
  };
}

function onDiffScopeChange(scope: DiffScope) {
  props.views?.modals.updateCurrentDiffViewState({ scope });
}

function onDiffScrollStateChange(scrollPositions: DiffScrollPositions) {
  props.views?.modals.updateCurrentDiffViewState({ scrollPositions });
}

function onDiffBranchIncludeChange(branchInclude: BranchInclude) {
  props.views?.modals.updateCurrentDiffViewState({ branchInclude });
}

function onMarkdownModeChange(mode: MarkdownPreviewMode) {
  props.views?.modals.updateCurrentPreviewMarkdownMode(mode);
}

interface DismissableView {
  dismiss?: () => boolean;
}

const viewRefs = new Map<string, DismissableView>();

function setViewRef(id: string, component: Element | ComponentPublicInstance | null) {
  if (component) {
    viewRefs.set(id, component as unknown as DismissableView);
  } else {
    viewRefs.delete(id);
  }
}

/**
 * Escape's share of the tab surface. The centralized dismiss handler calls
 * this once every open modal has declined, because a modal is always above the
 * tabs. Returns true when the key was consumed.
 */
function dismissActiveTab(): boolean {
  const controller = props.views?.tabs;
  const tab = controller?.activeTab.value;
  if (!controller || !tab || tab.kind === "agent") return false;
  // A shell tab is a live terminal; Escape belongs to whatever runs in it.
  if (tab.kind === "shell") return false;
  // A view with its own layered dismiss — a file's search, the tree's filter,
  // the graph's detail pane — gets to close that first.
  if (viewRefs.get(tab.id)?.dismiss?.() === false) return true;
  controller.closeTab(tab.id);
  return true;
}
const headerItem = computed(() => {
  const slot = props.uiSlot;
  if (!slot) return null;
  const task = slot.task;
  return {
    display_name: task?.display_name ?? slot.draft.display_name,
    issue_title: task?.issue_title ?? null,
    prompt: task?.prompt ?? slot.draft.prompt,
    stage: task?.stage ?? slot.draft.stage,
    branch: task?.branch ?? null,
    port_env: task?.port_env ?? null,
    issue_number: task?.issue_number ?? null,
    pr_number: task?.pr_number ?? null,
    pr_url: task?.pr_url ?? null,
  };
});

const isBlocked = computed(() => {
  if (props.blocked !== undefined) return props.blocked;
  if (!props.blockers || props.blockers.length === 0) return false;
  return props.blockers.some(b => !isBlockerResolved(b));
});

const activeCloudTerminal = computed<CloudTerminalCacheEntry | null>(() => {
  const task = item.value;
  const terminalRef = props.cloudTerminalRef;
  if (
    !task
    || props.uiSlot?.state !== "ready"
    || !props.cloudTask
    || isBlocked.value
    || !terminalRef
  ) {
    return null;
  }
  return {
    key: task.id,
    ownerDesktopId: terminalRef.ownerDesktopId,
    ownerTaskId: terminalRef.ownerLocalTaskId,
    transport: terminalRef.transport,
  };
});

const discardedCloudTerminalKey = computed(() => {
  const task = item.value;
  if (!task || props.uiSlot?.state !== "ready" || !props.cloudTask) return null;
  return isBlocked.value || !props.cloudTerminalRef ? task.id : null;
});

const commandHintDismissed = ref(readCommandHintDismissed());
const showCommandHint = computed(() => !commandHintDismissed.value);
const taskDetail = ref<DesktopTaskDetail | null>(null);
const revisionComposerOpen = ref(false);
const revisionSummary = ref("");
const revisionPrompt = ref("");
const revisionStarting = ref(false);
const revisionSummaryRef = ref<HTMLTextAreaElement | null>(null);

const parkedRevisionAvailable = computed(() => {
  const task = item.value;
  const detail = taskDetail.value;
  if (!props.requestRevision || !task || !detail || task.closed_at != null || detail.closedAt != null) return false;
  if (detail.id !== task.id || detail.revisionLimit <= 0) return false;
  if (detail.revisionRounds < detail.revisionLimit) return false;
  const latestRun = detail.latestRun;
  return latestRun?.status === "failed"
    && latestRun.summary?.startsWith("Parked for human review:") === true;
});

/// A session the daemon refuses to deliver messages into is running normally
/// and looks idle everywhere else, so the only sign of it used to be some
/// other agent's stage failing. Say it on the task itself.
const inputBlocked = computed(() => {
  const task = item.value;
  const detail = taskDetail.value;
  if (!task || !detail || detail.id !== task.id) return false;
  if (task.closed_at != null || detail.closedAt != null) return false;
  return typeof detail.inputBlocked === "string" && detail.inputBlocked.length > 0;
});

const postHeldByDraft = computed(() => {
  const task = item.value;
  const detail = taskDetail.value;
  if (!task || !detail || detail.id !== task.id || !task.has_running_post) return false;
  if (task.closed_at != null || detail.closedAt != null) return false;
  return detail.composer?.attestation === "typed";
});

let taskDetailRequest = 0;
async function loadTaskDetail(taskId: string): Promise<void> {
  const request = ++taskDetailRequest;
  try {
    const detail = await fetchDesktopTaskDetail(taskId);
    if (request === taskDetailRequest && item.value?.id === taskId) {
      taskDetail.value = detail;
    }
  } catch (error) {
    console.error(`[main-panel] failed to load task detail for ${taskId}:`, error);
  }
}

watch(
  () => [
    item.value?.id ?? null,
    item.value?.activity_revision ?? 0,
    item.value?.stage ?? null,
    item.value?.updated_at ?? null,
    item.value?.has_running_post ?? 0,
  ] as const,
  ([taskId], previous) => {
    if (taskId !== previous?.[0]) {
      taskDetailRequest += 1;
      taskDetail.value = null;
      revisionComposerOpen.value = false;
      revisionSummary.value = "";
      revisionPrompt.value = "";
    }
    if (taskId) void loadTaskDetail(taskId);
  },
  { immediate: true },
);

function openRevisionComposer() {
  if (!parkedRevisionAvailable.value || revisionStarting.value) return;
  revisionComposerOpen.value = true;
  nextTick(() => revisionSummaryRef.value?.focus());
}

async function submitRevision() {
  const taskId = item.value?.id;
  const summary = revisionSummary.value.trim();
  const prompt = revisionPrompt.value.trim();
  if (!taskId || !props.requestRevision || !summary || !prompt || revisionStarting.value) return;

  revisionStarting.value = true;
  try {
    const started = await props.requestRevision(taskId, {
      targetStage: "in progress",
      summary,
      prompt,
      metadata: { source: "kanna-parked-revision-recovery" },
    });
    if (!started) return;
    await loadTaskDetail(taskId);
    revisionComposerOpen.value = false;
    revisionSummary.value = "";
    revisionPrompt.value = "";
  } finally {
    revisionStarting.value = false;
  }
}

// --- Agent CLI detection ---

interface AgentCliStatus {
  installed: boolean;
  version?: string;
}

const claude = ref<AgentCliStatus>({ installed: false });
const copilot = ref<AgentCliStatus>({ installed: false });
const codex = ref<AgentCliStatus>({ installed: false });
const opencode = ref<AgentCliStatus>({ installed: false });
const antigravity = ref<AgentCliStatus>({ installed: false });
const copiedAgent = ref<string | null>(null);

interface AgentSetupCard {
  key: AgentProvider;
  nameKey: string;
  sortName: string;
  installCommand: string;
  status: AgentCliStatus;
}

interface AgentCardMetadata {
  nameKey: string;
  sortName: string;
  installCommand: string;
}

const AGENT_CARD_METADATA: Record<AgentProvider, AgentCardMetadata> = {
  claude: {
    nameKey: "mainPanel.agentClaudeName",
    sortName: "Claude Code",
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  copilot: {
    nameKey: "mainPanel.agentCopilotName",
    sortName: "GitHub Copilot",
    installCommand: "curl -fsSL https://gh.io/copilot-install | bash",
  },
  codex: {
    nameKey: "mainPanel.agentCodexName",
    sortName: "OpenAI Codex",
    installCommand: "npm install -g @openai/codex",
  },
  opencode: {
    nameKey: "mainPanel.agentOpenCodeName",
    sortName: "OpenCode",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
  },
  antigravity: {
    nameKey: "mainPanel.agentAntigravityName",
    sortName: "Google Antigravity",
    installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  },
};

const statusByProvider: Record<AgentProvider, Ref<AgentCliStatus>> = {
  claude,
  copilot,
  codex,
  opencode,
  antigravity,
};

const agentCards = computed<AgentSetupCard[]>(() => AGENT_PROVIDERS.map((provider) => ({
  key: provider,
  ...AGENT_CARD_METADATA[provider],
  status: statusByProvider[provider].value,
})));

const agentSetupGroups = computed(() => {
  const sorted = [...agentCards.value].sort((a, b) =>
    a.sortName.localeCompare(b.sortName, undefined, { sensitivity: "base" })
  );
  return [
    {
      key: "installed",
      titleKey: "mainPanel.agentInstalled",
      cards: sorted.filter(agent => agent.status.installed),
    },
    {
      key: "not-installed",
      titleKey: "mainPanel.agentNotInstalled",
      cards: sorted.filter(agent => !agent.status.installed),
    },
  ].filter(group => group.cards.length > 0);
});

function parseSemver(output: string): string | undefined {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return match?.[1];
}

async function readE2eCliVersion(name: string): Promise<string | undefined> {
  if (!import.meta.env.DEV) return undefined;
  const envName = `KANNA_E2E_AGENT_CLI_VERSION_${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
  try {
    return await invoke<string>("read_env_var", { name: envName });
  } catch (error) {
    console.debug(`[main-panel] E2E CLI version override not set for ${name}:`, error);
    return undefined;
  }
}

async function checkCli(provider: AgentProvider): Promise<AgentCliStatus> {
  const binary = getAgentProviderSpec(provider).executable;
  const e2eVersionOutput = await readE2eCliVersion(binary);
  if (e2eVersionOutput !== undefined) {
    return { installed: true, version: parseSemver(e2eVersionOutput) };
  }

  try {
    await invoke("which_binary", { name: binary });
  } catch (error) {
    console.debug(`[main-panel] CLI binary not found: ${binary}`, error);
    return { installed: false };
  }
  try {
    const output = await invoke("run_script", {
      script: `${binary} --version`,
      cwd: "/",
      env: {},
    }) as string;
    return { installed: true, version: parseSemver(output) };
  } catch (error) {
    console.debug(`[main-panel] failed to read CLI version for ${provider}:`, error);
    return { installed: true };
  }
}

async function checkAllClis() {
  const statuses = await Promise.all(
    AGENT_PROVIDERS.map(async (provider) => [provider, await checkCli(provider)] as const),
  );
  for (const [provider, status] of statuses) {
    statusByProvider[provider].value = status;
  }
}

watch(() => props.hasRepos, (has) => {
  if (!has) checkAllClis();
}, { immediate: true });

/** ⇧⌘[ / ⇧⌘] reach the Preferences tab's own sections while it is in front. */
function cyclePreferencesSection(direction: -1 | 1) {
  const tab = props.views?.tabs.activeTab.value;
  if (tab?.kind !== "preferences") return;
  (viewRefs.get(tab.id) as { cycleTab?: (direction: -1 | 1) => void } | undefined)
    ?.cycleTab?.(direction);
}

defineExpose({
  recheckClis: checkAllClis,
  dismissActiveTab,
  cyclePreferencesSection,
  onTabClosed,
});

async function copyCommand(agent: AgentProvider) {
  const cmd = AGENT_CARD_METADATA[agent].installCommand;
  await navigator.clipboard.writeText(cmd);
  copiedAgent.value = agent;
  setTimeout(() => { copiedAgent.value = null; }, 1500);
}

function readCommandHintDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COMMAND_HINT_STORAGE_KEY) === "1";
}

function dismissCommandHint() {
  commandHintDismissed.value = true;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(COMMAND_HINT_STORAGE_KEY, "1");
  }
}
</script>

<template>
  <main class="main-panel">
    <template v-if="uiSlot">
      <div v-if="isMobile" class="mobile-back-bar" @click="emit('back')">
        <span class="mobile-back-arrow">&larr;</span>
        <span>Tasks</span>
      </div>
      <TaskHeader v-if="!maximized && headerItem" :item="headerItem" />
      <section v-if="inputBlocked" class="input-blocked" data-testid="input-blocked">
        <p class="input-blocked-title">{{ $t('mainPanel.inputBlockedTitle') }}</p>
        <p class="input-blocked-hint">{{ $t('mainPanel.inputBlockedHint') }}</p>
      </section>
      <section v-if="postHeldByDraft" class="post-held" data-testid="post-held-by-draft">
        <p class="post-held-title">{{ $t('mainPanel.advanceHeldTitle') }}</p>
        <p class="post-held-hint">{{ $t('mainPanel.advanceHeldHint') }}</p>
      </section>
      <section v-if="parkedRevisionAvailable" class="revision-recovery" data-testid="revision-recovery">
        <div>
          <p class="revision-recovery-title">{{ $t('mainPanel.revisionExhaustedTitle') }}</p>
          <p class="revision-recovery-hint">
            {{ $t('mainPanel.revisionExhaustedHint', {
              rounds: taskDetail?.revisionRounds,
              limit: taskDetail?.revisionLimit,
            }) }}
          </p>
        </div>
        <button
          type="button"
          data-testid="open-revision-composer"
          :disabled="revisionStarting"
          @click="openRevisionComposer"
        >
          {{ $t('mainPanel.revise') }}
        </button>
      </section>
      <div v-show="agentTabActive" class="main-tab-panel" data-testid="main-tab-panel-agent">
        <CloudTerminalCache
          :active-terminal="activeCloudTerminal"
          :discard-key="discardedCloudTerminalKey"
        />
        <template v-if="uiSlot.state !== 'ready' || !item">
          <div class="setup-placeholder">
            <p class="setup-title">{{ $t('mainPanel.taskSettingUp') }}</p>
          </div>
        </template>
        <template v-else-if="isBlocked">
          <div class="blocked-placeholder">
            <p class="blocked-title">{{ $t('mainPanel.taskBlocked') }}</p>
            <p class="blocked-hint">{{ $t('mainPanel.taskBlockedHint') }}</p>
            <div v-if="blockers && blockers.length > 0" class="blocked-by">
              <p class="blocked-by-label">{{ $t('mainPanel.waitingOn') }}</p>
              <div v-for="b in blockers" :key="b.id" class="blocker-item">
                <span
                  class="blocker-status"
                  :style="{ color: b.closed_at != null ? 'var(--kn-text-muted)' : 'var(--kn-accent)' }"
                >{{ b.closed_at != null ? $t('mainPanel.blockerDone') : $t('mainPanel.blockerActive') }}</span>
                <span class="blocker-name">{{
                  b.display_name
                    || b.issue_title
                    || (b.prompt ? b.prompt.slice(0, 60) : null)
                    || (b.fallback_task_id
                      ? $t('tasks.taskId', { id: b.fallback_task_id })
                      : $t('tasks.untitled'))
                }}</span>
              </div>
            </div>
          </div>
        </template>
        <template v-else-if="cloudTask">
          <div v-if="!cloudTerminalRef" class="cloud-task-placeholder">
            <p class="cloud-task-title">Task is running on another machine</p>
            <p class="cloud-task-hint">Cloud sync is showing the task here, but terminal routing information is unavailable.</p>
          </div>
        </template>
        <template v-else>
          <TerminalTabs
            :session-id="item.id"
            :active="agentTabActive"
            :agent-type="item.agent_type || 'pty'"
            :agent-provider="item.agent_provider"
            :repo-path="repoPath"
            :worktree-path="taskWorktreePath"
            :prompt="item.prompt || ''"
            :spawn-pty-session="spawnPtySession"
            :recover-task-session="recoverTaskSession"
          />
        </template>
      </div>
    </template>
    <MainTabBar
      v-if="views && tabs.length > 0"
      :tabs="tabs"
      :active-tab-id="activeTabId"
      @select="selectTab"
      @close="closeTab"
    />
    <template v-if="views">
      <template v-for="tab in openViewTabs" :key="tabKey(tab)">
        <DiffModal
          v-if="tab.kind === 'diff' && diffViewProps"
          v-show="activeTabId === tab.id"
          v-bind="diffViewProps"
          embedded
          :active="activeTabId === tab.id"
          @scope-change="onDiffScopeChange"
          @scroll-state-change="onDiffScrollStateChange"
          @branch-include-change="onDiffBranchIncludeChange"
          @close="closeTab(tab.id)"
        />
        <FilePreviewModal
          v-else-if="tab.kind === 'file'"
          :ref="(component) => setViewRef(tab.id, component)"
          v-show="activeTabId === tab.id"
          v-bind="fileViewProps(tab)"
          embedded
          :active="activeTabId === tab.id"
          @update-markdown-mode="onMarkdownModeChange"
          @close="closeTab(tab.id)"
        />
        <ShellModal
          v-else-if="tab.kind === 'shell' && shellSessionId(tab)"
          v-show="activeTabId === tab.id"
          :session-id="shellSessionId(tab)"
          :cwd="shellCwd(tab)"
          :fallback-cwd="tab.shellScope === 'repo' ? undefined : scopeRepoPath"
          :port-env="tab.shellScope === 'repo' ? undefined : item?.port_env"
          embedded
          :active="activeTabId === tab.id"
          @close="closeTab(tab.id)"
        />
        <TreeExplorerModal
          v-else-if="tab.kind === 'tree'"
          :ref="(component) => setViewRef(tab.id, component)"
          v-show="activeTabId === tab.id"
          v-bind="treeViewProps()"
          embedded
          :active="activeTabId === tab.id"
          @open-file="(filePath: string) => views?.modals.openFilePreview(filePath)"
          @close="closeTab(tab.id)"
        />
        <CommitGraphModal
          v-else-if="tab.kind === 'graph' && scopeRepoPath"
          :ref="(component) => setViewRef(tab.id, component)"
          v-show="activeTabId === tab.id"
          :repo-path="scopeRepoPath"
          :worktree-path="taskWorktreePath"
          embedded
          :active="activeTabId === tab.id"
          @close="closeTab(tab.id)"
        />
        <AnalyticsModal
          v-else-if="tab.kind === 'analytics'"
          v-show="activeTabId === tab.id"
          :repo-id="scopeRepoId"
          embedded
          :active="activeTabId === tab.id"
          @close="closeTab(tab.id)"
        />
        <ImageUrlPreviewModal
          v-else-if="tab.kind === 'image'"
          v-show="activeTabId === tab.id"
          :image-url="tab.imageUrl ?? ''"
          embedded
          :active="activeTabId === tab.id"
          @close="closeTab(tab.id)"
        />
        <PreferencesPanel
          v-else-if="tab.kind === 'preferences' && views"
          :ref="(component) => setViewRef(tab.id, component)"
          v-show="activeTabId === tab.id"
          :preferences="views.preferences.preferences"
          embedded
          :active="activeTabId === tab.id"
          @update="views.preferences.handlePreferenceUpdate"
          @close="closeTab(tab.id)"
        />
      </template>
    </template>
    <div v-if="showEmptyState" class="empty-state">
      <template v-if="!hasRepos">
        <div class="agent-setup">
          <p class="setup-title">{{ $t('mainPanel.agentSetupTitle') }}</p>
          <div class="agent-cards">
            <section v-for="group in agentSetupGroups" :key="group.key" class="agent-group">
              <p class="agent-group-title">{{ $t(group.titleKey) }}</p>
              <div v-for="agent in group.cards" :key="agent.key" class="agent-card">
                <div class="agent-header">
                  <span class="agent-name">{{ $t(agent.nameKey) }}</span>
                  <span v-if="agent.status.installed" class="agent-badge installed">
                    <span class="checkmark">✓</span>
                    {{ $t('mainPanel.agentVersion', { version: agent.status.version || '?' }) }}
                  </span>
                  <span v-else class="agent-badge not-installed">
                    {{ $t('mainPanel.agentNotInstalled') }}
                  </span>
                </div>
                <div v-if="!agent.status.installed" class="install-block">
                  <code class="install-cmd">{{ agent.installCommand }}</code>
                  <button
                    class="copy-btn"
                    :title="copiedAgent === agent.key ? $t('mainPanel.agentCopied') : 'Copy'"
                    @click="copyCommand(agent.key)"
                  >
                    {{ copiedAgent === agent.key ? '✓' : '⧉' }}
                  </button>
                </div>
              </div>
            </section>
          </div>
          <p class="setup-hint">
            {{ $t('mainPanel.agentInstallHint', { shellShortcut: '⇧⌘J' }) }}
          </p>
          <p class="empty-hint">{{ $t('mainPanel.noReposHint', { shortcut: '⌘I' }) }}</p>
        </div>
      </template>
      <template v-else>
        <p class="empty-title">{{ $t('mainPanel.noTaskSelected') }}</p>
        <p class="empty-hint">{{ $t('mainPanel.noTaskHint', { shortcut: '⇧⌘N' }) }}</p>
      </template>
    </div>
    <div
      v-if="showCommandHint"
      data-testid="command-hint"
      class="command-hint"
    >
      <span class="command-hint-copy">
        <span v-if="$t('mainPanel.commandHintPrefix')" class="command-hint-text">
          {{ $t('mainPanel.commandHintPrefix') }}
        </span>
        <span class="command-hint-shortcut">
          <kbd>⌘</kbd><kbd>/</kbd>
        </span>
        <span class="command-hint-text">
          {{ $t('mainPanel.commandHintSuffix') }}
        </span>
      </span>
      <button
        data-testid="command-hint-dismiss"
        type="button"
        class="command-hint-dismiss"
        :aria-label="$t('actions.dismiss')"
        @click="dismissCommandHint"
      >
        ×
      </button>
    </div>
    <div v-if="revisionComposerOpen" class="revision-composer" data-testid="revision-composer">
      <form class="revision-panel" @submit.prevent="submitRevision">
        <h2>{{ $t('mainPanel.requestRevision') }}</h2>
        <p>{{ $t('mainPanel.requestRevisionHint') }}</p>
        <label>
          <span>{{ $t('mainPanel.revisionSummaryLabel') }}</span>
          <textarea
            ref="revisionSummaryRef"
            v-model="revisionSummary"
            data-testid="revision-summary"
            :placeholder="$t('mainPanel.revisionSummaryPlaceholder')"
          />
        </label>
        <label>
          <span>{{ $t('mainPanel.revisionPromptLabel') }}</span>
          <textarea
            v-model="revisionPrompt"
            data-testid="revision-prompt"
            :placeholder="$t('mainPanel.revisionPromptPlaceholder')"
          />
        </label>
        <div class="revision-actions">
          <button type="button" :disabled="revisionStarting" @click="revisionComposerOpen = false">
            {{ $t('actions.cancel') }}
          </button>
          <button
            type="submit"
            class="primary"
            data-testid="submit-revision"
            :disabled="revisionStarting || !revisionSummary.trim() || !revisionPrompt.trim()"
          >
            {{ revisionStarting ? $t('mainPanel.startingRevision') : $t('mainPanel.startRevision') }}
          </button>
        </div>
      </form>
    </div>
  </main>
</template>

<style scoped>
.main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--kn-bg-app);
}

.main-tab-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.input-blocked {
  padding: 10px 16px;
  border-bottom: 1px solid var(--kn-warning);
  background: var(--kn-warning-bg);
}

.post-held {
  padding: 9px 12px;
  border-bottom: 1px solid var(--kn-warning);
  background: var(--kn-warning-bg);
}

.post-held-title {
  margin: 0;
  color: var(--kn-text-primary);
  font-size: 13px;
  font-weight: 600;
}

.post-held-hint {
  margin: 2px 0 0;
  color: var(--kn-text-muted);
  font-size: 11px;
}

.input-blocked-title {
  margin: 0;
  color: var(--kn-text-primary);
  font-size: 13px;
  font-weight: 600;
}

.input-blocked-hint {
  margin: 2px 0 0;
  color: var(--kn-text-muted);
  font-size: 11px;
}

.revision-recovery {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--kn-warning);
  background: var(--kn-warning-bg);
}

.revision-recovery-title {
  margin: 0;
  color: var(--kn-text-primary);
  font-size: 13px;
  font-weight: 600;
}

.revision-recovery-hint {
  margin: 2px 0 0;
  color: var(--kn-text-muted);
  font-size: 11px;
}

.revision-recovery button,
.revision-actions button {
  padding: 5px 11px;
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-primary);
  cursor: pointer;
  white-space: nowrap;
}

.revision-recovery button:disabled,
.revision-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.revision-composer {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--kn-overlay-scrim);
}

.revision-panel {
  width: min(560px, 100%);
  padding: 20px;
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  background: var(--kn-bg-panel);
  box-shadow: var(--kn-shadow-modal);
}

.revision-panel h2 {
  margin: 0 0 6px;
  color: var(--kn-text-primary);
  font-size: 16px;
}

.revision-panel > p {
  margin: 0 0 16px;
  color: var(--kn-text-muted);
  font-size: 12px;
}

.revision-panel label {
  display: block;
  margin-top: 12px;
  color: var(--kn-text-secondary);
  font-size: 12px;
}

.revision-panel textarea {
  width: 100%;
  min-height: 72px;
  margin-top: 5px;
  padding: 8px;
  resize: vertical;
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  background: var(--kn-bg-app);
  color: var(--kn-text-primary);
  font: inherit;
}

.revision-panel label:nth-of-type(2) textarea {
  min-height: 140px;
}

.revision-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.revision-actions .primary {
  border-color: var(--kn-accent);
  background: var(--kn-accent);
  color: var(--kn-text-inverse);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.terminal-policy-loading {
  flex: 1;
  min-height: 0;
}

.setup-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--kn-text-muted);
  font-size: 13px;
}

.cloud-task-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--kn-text-muted);
  font-size: 13px;
  text-align: center;
}

.cloud-task-title {
  margin: 0;
  color: var(--kn-text-primary);
  font-size: 14px;
}

.cloud-task-hint {
  margin: 0;
  max-width: 360px;
  line-height: 1.4;
}

.empty-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--kn-text-muted);
}

.empty-hint {
  font-size: 12px;
  color: var(--kn-text-muted);
}

.empty-hint kbd {
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: inherit;
  font-size: 11px;
  color: var(--kn-text-muted);
}

.empty-hint kbd + kbd {
  margin-left: 2px;
}

.blocked-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  max-width: 600px;
  margin: 0 auto;
}

.blocked-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--kn-text-muted);
}

.blocked-prompt {
  font-size: 13px;
  color: var(--kn-text-muted);
  text-align: center;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

.blocked-by {
  width: 100%;
  margin-top: 8px;
}

.blocked-by-label {
  font-size: 12px;
  color: var(--kn-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.blocker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--kn-bg-panel);
  border-radius: 4px;
  margin-bottom: 4px;
}

.blocker-status {
  font-size: 11px;
  font-weight: 600;
  min-width: 80px;
}

.blocker-name {
  font-size: 12px;
  color: var(--kn-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blocked-hint {
  font-size: 11px;
  color: var(--kn-text-muted);
  margin-top: 8px;
}

.command-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--kn-border-default);
  background: var(--kn-bg-app);
  color: var(--kn-text-muted);
  font-size: 12px;
}

.command-hint-copy {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.command-hint-shortcut {
  display: inline-flex;
  align-items: center;
}

.command-hint-copy kbd {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: inherit;
  font-size: 11px;
  color: var(--kn-text-secondary);
}

.command-hint-copy kbd + kbd {
  margin-left: 2px;
}

.command-hint-dismiss {
  border: 0;
  background: transparent;
  color: var(--kn-text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 2px;
}

.command-hint-dismiss:hover {
  color: var(--kn-text-muted);
}

.agent-setup {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  max-width: 480px;
  margin: 0 auto;
  padding: 32px;
}

.setup-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--kn-text-muted);
  margin-bottom: 4px;
}

.agent-cards {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
}

.agent-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agent-group-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--kn-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.agent-card {
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-default);
  border-radius: 8px;
  padding: 14px 16px;
}

.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.agent-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--kn-text-secondary);
}

.agent-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
}

.agent-badge.installed {
  color: var(--kn-success);
  background: var(--kn-success-bg);
}

.agent-badge.not-installed {
  color: var(--kn-text-muted);
  background: var(--kn-bg-panel-raised);
}

.checkmark {
  margin-right: 4px;
}

.install-block {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.install-cmd {
  flex: 1;
  font-size: 11px;
  font-family: monospace;
  color: var(--kn-text-muted);
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-default);
  border-radius: 4px;
  padding: 6px 10px;
  overflow-x: auto;
  white-space: nowrap;
}

.copy-btn {
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-muted);
  font-size: 13px;
  padding: 4px 8px;
  cursor: pointer;
  flex-shrink: 0;
}

.copy-btn:hover {
  background: var(--kn-bg-hover);
  color: var(--kn-text-secondary);
}

.setup-hint {
  font-size: 12px;
  color: var(--kn-text-muted);
}

.mobile-back-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: var(--kn-bg-panel-raised);
  border-bottom: 1px solid var(--kn-border-default);
  color: var(--kn-accent);
  font-size: 14px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.mobile-back-arrow {
  font-size: 18px;
}
</style>
