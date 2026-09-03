import { ref, type ComputedRef, type Ref } from "vue";
import type { RepoConfig } from "@kanna/core";
import type {
  AgentProvider,
  BlockerTaskStates,
  DbHandle,
  PipelineItem,
  Repo,
  TaskBlocker,
} from "../types/kanna";
import type { WorkflowDefinition, AgentDefinition } from "../../../../packages/core/src/workflow/workflow-types";
import type { SessionRecoveryState } from "../composables/sessionRecoveryState";
import i18n from "../i18n";
import { useToast } from "../composables/useToast";
import { fetchDesktopRepoKannaDefinitions } from "../services/desktopServerClient";
import type { WindowBootstrap, WindowWorkspaceController } from "../windowWorkspace";
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  type AppThemePreference,
  type CodeThemePreference,
} from "../theme/theme";
import type { AgentExecutionType } from "./agentExecutionType";
import {
  DEFAULT_MARKDOWN_PREVIEW_MODE,
  type MarkdownPreviewMode,
} from "./markdownPreviewMode";
import type { AdvanceStageResult, RequestRevisionOptions } from "./workflow";
import type { ReloadSnapshotOptions } from "./queries";
import type { TaskUiSlot } from "../types/taskUi";

export type AgentMessageAppearance = "chat" | "log" | "terminal";

/** Generate an 8-char hex ID (32 bits of randomness). */
export function generateId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PtySpawnOptions {
  agentProvider?: AgentProvider;
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setupCmdsOverride?: string[];
  portEnv?: Record<string, string>;
  setupCmds?: string[];
  resumeSessionId?: string;
  displayPrompt?: string;
  worktreePath?: string;
  repoConfig?: RepoConfig;
}

export interface AgentSpawnRecoveryOptions {
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
}

export interface PreparedPtySession {
  env: Record<string, string>;
  setupCmds: string[];
  agentCmd: string;
  agentCmdPreamble?: string;
  agentProvider: AgentProvider;
  kannaCliPath?: string;
  mcpConfigPath?: string;
  /** The agent CLI's own session id this spawn starts or resumes, when known. */
  agentSessionId?: string;
}

export interface TaskSessionRecoveryOptions {
  cols?: number;
  rows?: number;
}

export interface WorktreeBootstrapResult {
  visibleBootstrapSteps: string[];
}

export interface AdvanceStageOptions {
  initiatedBy?: "manual" | "auto";
  skipPostAction?: boolean;
}

export interface RepoSnapshotEntry {
  repo: Repo;
  items: PipelineItem[];
}

export interface KannaSnapshot {
  entries: RepoSnapshotEntry[];
  repoSidebarOrder?: Record<string, number>;
  taskBlockers: TaskBlocker[];
  blockerTaskStates?: BlockerTaskStates;
  worktreePaths: Record<string, string>;
  settings: Record<string, string>;
}

export interface CreateItemOptions {
  requestedTaskId?: string;
  baseBranch?: string;
  baseRef?: string | null;
  workflowName?: string;
  stage?: string;
  customTask?: import("@kanna/core").CustomTaskConfig;
  agentProvider?: AgentProvider;
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string[];
  displayName?: string | null;
  selectOnCreate?: boolean;
  resumeSessionId?: string | null;
  recoverySnapshot?: SessionRecoveryState | null;
  /** Set only by the receiver side of a cross-machine transfer; display only. */
  transferImport?: import("./transferImportSummary").TransferImportSummary | null;
  blockerTaskIds?: string[];
}

export interface StoreState {
  db: Ref<DbHandle | null>;
  repos: Ref<Repo[]>;
  items: Ref<PipelineItem[]>;
  taskUiSlots: Ref<TaskUiSlot[]>;
  taskBlockers: Ref<TaskBlocker[]>;
  blockerTaskStates: Ref<BlockerTaskStates>;
  worktreePaths: Ref<Record<string, string>>;
  snapshotSettings: Ref<Record<string, string>>;
  repoSidebarOrder: Ref<Record<string, number>>;
  initialWindowBootstrap: Ref<WindowBootstrap | null>;
  selectedRepoId: Ref<string | null>;
  selectedItemId: Ref<string | null>;
  selectionIntentVersion: Ref<number>;
  lastSelectedItemByRepo: Ref<Record<string, string>>;
  suspendAfterMinutes: Ref<number>;
  killAfterMinutes: Ref<number>;
  ideCommand: Ref<string>;
  hideShortcutsOnStartup: Ref<boolean>;
  devLingerTerminals: Ref<boolean>;
  appTheme: Ref<AppThemePreference>;
  codeTheme: Ref<CodeThemePreference>;
  agentMessageAppearance: Ref<AgentMessageAppearance>;
  markdownPreviewMode: Ref<MarkdownPreviewMode>;
  lastHiddenRepoId: Ref<string | null>;
  workflowCache: Map<string, RevisionedDefinitionCacheEntry<WorkflowDefinition>>;
  agentCache: Map<string, RevisionedDefinitionCacheEntry<AgentDefinition>>;
  stageOrderCache: Map<string, RevisionedStageOrderCacheEntry>;
  pendingCreateVisibility: Map<string, { bumpAt: number }>;
}

export interface RevisionedDefinitionCacheEntry<T> {
  revision: string | null;
  definition: T;
}

export interface RevisionedStageOrderCacheEntry {
  revision: string | null;
  stageOrder: string[] | null;
}

export interface StoreServices {
  windowWorkspace?: WindowWorkspaceController;
  loadInitialData?: () => Promise<void>;
  reloadSnapshot?: (options?: ReloadSnapshotOptions) => Promise<void>;
  fetchSnapshot?: () => Promise<KannaSnapshot>;
  withOptimisticItemOverlay?: <T>(input: {
    key: string;
    apply: (snapshot: KannaSnapshot) => KannaSnapshot;
    run: () => Promise<T>;
    reconcile?: () => Promise<void>;
  }) => Promise<T>;
  selectedRepo?: ComputedRef<Repo | null>;
  currentItem?: ComputedRef<PipelineItem | null>;
  selectedTaskId?: ComputedRef<string | null>;
  currentTaskSlot?: ComputedRef<TaskUiSlot | null>;
  persistSelection?: () => Promise<void>;
  sortedItemsForCurrentRepo?: ComputedRef<PipelineItem[]>;
  sortedItemsAllRepos?: ComputedRef<PipelineItem[]>;
  isItemHidden?: (item: PipelineItem) => boolean;
  getStageOrder?: (repoId: string) => readonly string[];
  selectRepo?: (
    repoId: string,
    options?: { persistWindowSelection?: boolean },
  ) => Promise<void>;
  selectItem?: (itemId: string, options?: { previousItemId?: string | null }) => Promise<void>;
  selectReplacementAfterItemRemoval?: (removedItem: PipelineItem) => Promise<string | null>;
  reconcileSelection?: () => void;
  restoreSelection?: (itemId: string) => void;
  goBack?: () => void;
  goForward?: () => void;
  loadWorkflow?: (repoId: string, workflowName: string) => Promise<WorkflowDefinition>;
  loadAgent?: (repoId: string, agentName: string) => Promise<AgentDefinition>;
  advanceStage?: (taskId: string, options?: AdvanceStageOptions) => Promise<AdvanceStageResult>;
  requestRevision?: (taskId: string, options: RequestRevisionOptions) => Promise<boolean>;
  rerunStage?: (taskId: string) => Promise<void>;
  spawnShellSession?: (
    sessionId: string,
    cwd: string,
    portEnv?: string | null,
    isWorktree?: boolean,
    fallbackCwd?: string | null,
  ) => Promise<void>;
  prewarmWorktreeShellSession?: (
    sessionId: string,
    worktreePath: string,
    portEnv?: string | null,
    fallbackCwd?: string | null,
  ) => Promise<void>;
  preparePtySession?: (
    sessionId: string,
    prompt: string,
    options?: PtySpawnOptions,
  ) => Promise<PreparedPtySession>;
  spawnPtySession?: (
    sessionId: string,
    cwd: string,
    prompt: string,
    cols?: number,
    rows?: number,
    options?: PtySpawnOptions,
  ) => Promise<void>;
  recoverTaskSession?: (
    sessionId: string,
    options?: TaskSessionRecoveryOptions,
  ) => Promise<void>;
  applyTaskRuntimeStatus?: (item: PipelineItem, status: string) => Promise<void>;
  waitForSessionExit?: (sessionId: string) => Promise<void>;
  resolveSessionExitWaiters?: (sessionId: string) => void;
  persistExitedSessionResumeId?: (sessionId: string, resumeSessionId?: string | null) => Promise<void>;
  getAgentProviderAvailability?: () => Promise<import("./agent-provider").AgentProviderAvailability>;
  createItem?: (
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType?: AgentExecutionType,
    opts?: CreateItemOptions,
  ) => Promise<string>;
  closeTask?: (targetItemId?: string, opts?: { selectNext?: boolean }) => Promise<boolean>;
  undoClose?: () => Promise<void>;
  checkUnblocked?: (blockerItemId: string) => Promise<void>;
  startBlockedTask?: (item: PipelineItem) => Promise<void>;
  blockTask?: (blockerIds: string[]) => Promise<void>;
  editBlockedTask?: (itemId: string, newBlockerIds: string[]) => Promise<void>;
}

export interface StoreContext {
  state: StoreState;
  services: StoreServices;
  toast: ReturnType<typeof useToast>;
  requireDb: () => DbHandle;
  tt: (key: string) => string;
}

export function requireService<T>(
  service: T | undefined,
  name: string,
): T {
  if (service == null) {
    throw new Error(`Store service "${name}" is not registered`);
  }
  return service;
}

export async function fetchRepoConfig(repoId: string): Promise<RepoConfig> {
  return (await fetchDesktopRepoKannaDefinitions(repoId)).config;
}

export function createStoreState(): StoreState {
  const db = ref<DbHandle | null>(null);
  const repos = ref<Repo[]>([]);
  const items = ref<PipelineItem[]>([]);
  const taskUiSlots = ref<TaskUiSlot[]>([]);
  const taskBlockers = ref<TaskBlocker[]>([]);
  const blockerTaskStates = ref<BlockerTaskStates>({});
  const worktreePaths = ref<Record<string, string>>({});
  const snapshotSettings = ref<Record<string, string>>({});
  const repoSidebarOrder = ref<Record<string, number>>({});
  const initialWindowBootstrap = ref<WindowBootstrap | null>(null);
  const selectedRepoId = ref<string | null>(null);
  const selectedItemId = ref<string | null>(null);
  const selectionIntentVersion = ref(0);
  const lastSelectedItemByRepo = ref<Record<string, string>>({});
  const suspendAfterMinutes = ref(30);
  const killAfterMinutes = ref(60);
  const ideCommand = ref("code");
  const hideShortcutsOnStartup = ref(false);
  const devLingerTerminals = ref(false);
  const appTheme = ref<AppThemePreference>(DEFAULT_APP_THEME);
  const codeTheme = ref<CodeThemePreference>(DEFAULT_CODE_THEME);
  const agentMessageAppearance = ref<AgentMessageAppearance>("chat");
  const markdownPreviewMode = ref<MarkdownPreviewMode>(DEFAULT_MARKDOWN_PREVIEW_MODE);
  const lastHiddenRepoId = ref<string | null>(null);
  const pendingCreateVisibility = new Map<string, { bumpAt: number }>();
  const workflowCache = new Map<string, RevisionedDefinitionCacheEntry<WorkflowDefinition>>();
  const agentCache = new Map<string, RevisionedDefinitionCacheEntry<AgentDefinition>>();
  const stageOrderCache = new Map<string, RevisionedStageOrderCacheEntry>();

  return {
    db,
    repos,
    items,
    taskUiSlots,
    taskBlockers,
    blockerTaskStates,
    worktreePaths,
    snapshotSettings,
    repoSidebarOrder,
    initialWindowBootstrap,
    selectedRepoId,
    selectedItemId,
    selectionIntentVersion,
    lastSelectedItemByRepo,
    suspendAfterMinutes,
    killAfterMinutes,
    ideCommand,
    hideShortcutsOnStartup,
    devLingerTerminals,
    appTheme,
    codeTheme,
    agentMessageAppearance,
    markdownPreviewMode,
    lastHiddenRepoId,
    workflowCache,
    agentCache,
    stageOrderCache,
    pendingCreateVisibility,
  };
}

export function createStoreContext(
  state: StoreState,
  toast: ReturnType<typeof useToast>,
  services: StoreServices,
): StoreContext {
  return {
    state,
    services,
    toast,
    requireDb: () => {
      if (!state.db.value) {
        throw new Error("Kanna store has not been initialized");
      }
      return state.db.value;
    },
    tt: (key: string) => i18n.global.t(key),
  };
}
