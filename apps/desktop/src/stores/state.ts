import { ref, type ComputedRef, type Ref } from "vue";
import { parseRepoConfig, type RepoConfig } from "@kanna/core";
import type { AgentProvider, DbHandle, PipelineItem, Repo, TaskBlocker } from "../types/kanna";
import type { PipelineDefinition, AgentDefinition } from "../../../../packages/core/src/pipeline/pipeline-types";
import type { SessionRecoveryState } from "../composables/sessionRecoveryState";
import { invoke } from "../invoke";
import i18n from "../i18n";
import { useToast } from "../composables/useToast";
import { getAppErrorMessage } from "../appError";
import type { WindowBootstrap, WindowWorkspaceController } from "../windowWorkspace";
import {
  DEFAULT_APP_THEME,
  DEFAULT_CODE_THEME,
  type AppThemePreference,
  type CodeThemePreference,
} from "../theme/theme";
import type { AgentExecutionType } from "./agentExecutionType";
import type { RequestRevisionOptions } from "./pipeline";
import type { InitializingTaskItem } from "./taskInitialization";

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
  taskBlockers: TaskBlocker[];
  worktreePaths: Record<string, string>;
  settings: Record<string, string>;
}

export type SnapshotReloadResult =
  | { status: "applied" }
  | { status: "superseded" };

export interface CreateItemOptions {
  baseBranch?: string;
  baseRef?: string | null;
  pipelineName?: string;
  stage?: string;
  customTask?: import("@kanna/core").CustomTaskConfig;
  agentProvider?: AgentProvider;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  displayName?: string | null;
  selectOnCreate?: boolean;
  resumeSessionId?: string | null;
  recoverySnapshot?: SessionRecoveryState | null;
}

export interface StoreState {
  db: Ref<DbHandle | null>;
  repos: Ref<Repo[]>;
  items: Ref<PipelineItem[]>;
  taskBlockers: Ref<TaskBlocker[]>;
  worktreePaths: Ref<Record<string, string>>;
  snapshotSettings: Ref<Record<string, string>>;
  initialWindowBootstrap: Ref<WindowBootstrap | null>;
  selectedRepoId: Ref<string | null>;
  selectedItemId: Ref<string | null>;
  lastSelectedItemByRepo: Ref<Record<string, string>>;
  suspendAfterMinutes: Ref<number>;
  killAfterMinutes: Ref<number>;
  ideCommand: Ref<string>;
  hideShortcutsOnStartup: Ref<boolean>;
  devLingerTerminals: Ref<boolean>;
  appTheme: Ref<AppThemePreference>;
  codeTheme: Ref<CodeThemePreference>;
  agentMessageAppearance: Ref<AgentMessageAppearance>;
  lastHiddenRepoId: Ref<string | null>;
  initializingTaskItems: Ref<InitializingTaskItem[]>;
  pipelineCache: Map<string, PipelineDefinition>;
  agentCache: Map<string, AgentDefinition>;
  stageOrderCache: Map<string, string[]>;
  pendingCreateVisibility: Map<string, { bumpAt: number }>;
}

export interface StoreServices {
  windowWorkspace?: WindowWorkspaceController;
  loadInitialData?: () => Promise<void>;
  reloadSnapshot?: () => Promise<SnapshotReloadResult | void>;
  fetchSnapshot?: () => Promise<KannaSnapshot>;
  withOptimisticItemOverlay?: <T>(input: {
    key: string;
    apply: (snapshot: KannaSnapshot) => KannaSnapshot;
    run: () => Promise<T>;
    reconcile?: () => Promise<void>;
  }) => Promise<T>;
  selectedRepo?: ComputedRef<Repo | null>;
  currentItem?: ComputedRef<PipelineItem | null>;
  sortedItemsForCurrentRepo?: ComputedRef<PipelineItem[]>;
  sortedItemsAllRepos?: ComputedRef<PipelineItem[]>;
  isItemHidden?: (item: PipelineItem) => boolean;
  getStageOrder?: (repoId: string) => readonly string[];
  persistSelection?: () => Promise<void>;
  selectRepo?: (repoId: string) => Promise<void>;
  selectItem?: (itemId: string, options?: { previousItemId?: string | null }) => Promise<void>;
  selectReplacementAfterItemRemoval?: (
    removedItem: Pick<PipelineItem, "id" | "repo_id">,
  ) => Promise<string | null>;
  reconcileSelection?: () => void;
  restoreSelection?: (itemId: string) => void;
  goBack?: () => void;
  goForward?: () => void;
  loadPipeline?: (repoPath: string, pipelineName: string) => Promise<PipelineDefinition>;
  loadAgent?: (repoPath: string, agentName: string) => Promise<AgentDefinition>;
  advanceStage?: (taskId: string, options?: AdvanceStageOptions) => Promise<void>;
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
  syncTaskStatusesFromDaemon?: () => Promise<void>;
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
  closeTask?: (targetItemId?: string, opts?: { selectNext?: boolean }) => Promise<void>;
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

export async function readRepoConfig(basePath: string): Promise<RepoConfig> {
  const configPath = `${basePath}/.kanna/config.json`;

  function isMissingRepoConfigError(error: unknown): boolean {
    const message = getAppErrorMessage(error).toLowerCase();
    return message.includes("no such file or directory")
      || message.includes("missing config")
      || message.includes("not found");
  }

  try {
    const content = await invoke<string>("read_text_file", {
      path: configPath,
    });

    if (!content) {
      return {};
    }

    try {
      return parseRepoConfig(content);
    } catch (error) {
      throw new Error(`invalid repo config '${configPath}': ${getAppErrorMessage(error)}`);
    }
  } catch (error) {
    if (isMissingRepoConfigError(error)) {
      console.debug("[store] no .kanna/config.json:", error);
      return {};
    }
    throw error;
  }
}

export function createStoreState(): StoreState {
  const db = ref<DbHandle | null>(null);
  const repos = ref<Repo[]>([]);
  const items = ref<PipelineItem[]>([]);
  const taskBlockers = ref<TaskBlocker[]>([]);
  const worktreePaths = ref<Record<string, string>>({});
  const snapshotSettings = ref<Record<string, string>>({});
  const initialWindowBootstrap = ref<WindowBootstrap | null>(null);
  const selectedRepoId = ref<string | null>(null);
  const selectedItemId = ref<string | null>(null);
  const lastSelectedItemByRepo = ref<Record<string, string>>({});
  const suspendAfterMinutes = ref(30);
  const killAfterMinutes = ref(60);
  const ideCommand = ref("code");
  const hideShortcutsOnStartup = ref(false);
  const devLingerTerminals = ref(false);
  const appTheme = ref<AppThemePreference>(DEFAULT_APP_THEME);
  const codeTheme = ref<CodeThemePreference>(DEFAULT_CODE_THEME);
  const agentMessageAppearance = ref<AgentMessageAppearance>("chat");
  const lastHiddenRepoId = ref<string | null>(null);
  const initializingTaskItems = ref<InitializingTaskItem[]>([]);
  const pendingCreateVisibility = new Map<string, { bumpAt: number }>();
  const pipelineCache = new Map<string, PipelineDefinition>();
  const agentCache = new Map<string, AgentDefinition>();
  const stageOrderCache = new Map<string, string[]>();

  return {
    db,
    repos,
    items,
    taskBlockers,
    worktreePaths,
    snapshotSettings,
    initialWindowBootstrap,
    selectedRepoId,
    selectedItemId,
    lastSelectedItemByRepo,
    suspendAfterMinutes,
    killAfterMinutes,
    ideCommand,
    hideShortcutsOnStartup,
    devLingerTerminals,
    appTheme,
    codeTheme,
    agentMessageAppearance,
    lastHiddenRepoId,
    initializingTaskItems,
    pipelineCache,
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
