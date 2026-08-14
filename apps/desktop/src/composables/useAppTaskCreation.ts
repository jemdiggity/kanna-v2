import { computed, ref, type ComputedRef, type Ref } from "vue";
import { computedAsync } from "@vueuse/core";
import type { AgentProvider } from "../types/kanna";
import type { AgentExecutionType } from "../stores/agentExecutionType";

import { invoke } from "../invoke";
import { getDefaultBaseBranch } from "../utils/baseBranchPicker";
import { parseRepoInput } from "../utils/parseRepoInput";
import { defaultReposHome } from "../utils/reposHome";
import { fileExistsSafe } from "../utils/invokeHelpers";
import { isBlockerResolved } from "../utils/blockerResolution";
import type { DesktopCloudSnapshot } from "../services/desktopCloudTaskIndex";
import {
  fetchDesktopRepoAgentProviders,
  fetchDesktopRepoKannaDefinitions,
  fetchDesktopRepoRecentWorkflows,
} from "../services/desktopServerClient";
import { resolveStickyWorkflowDefault } from "../utils/stickyWorkflow";
import type { useKannaStore } from "../stores/kanna";
import { claimLocalTaskSelectionOwnership } from "./localTaskSelectionOwnership";
import type { useToast } from "./useToast";

const SETUP_TASK_PROMPT = "Set up Kanna for this repository.";

interface SidebarRepoProjection {
  id: string;
}

interface GitRepositoryState {
  defaultBranch: string;
  hasCommits: boolean;
}

interface UseAppTaskCreationOptions {
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  t: (key: string) => string;
  sidebarRepos: ComputedRef<SidebarRepoProjection[]>;
  remoteSnapshot: ComputedRef<DesktopCloudSnapshot>;
  mainPanelIsCloudTask: ComputedRef<boolean>;
  selectedCloudRepoId: Ref<string | null>;
  selectedCloudItemId: Ref<string | null>;
  showNewTaskModal: Ref<boolean>;
  availableWorkflows: Ref<string[]>;
  defaultWorkflowName: Ref<string | undefined>;
  availableBaseBranches: Ref<string[]>;
  defaultBaseBranchName: Ref<string | undefined>;
  repoDefaultBranchName: Ref<string | undefined>;
  showAddRepoModal: Ref<boolean>;
  isCloudOnlyRepoId: (repoId: string | undefined | null) => boolean;
  cloudRepoRemoteUrl: (repoId: string | undefined | null) => string | null;
  onAgentChoiceUsed?: (choice: { provider: AgentProvider; executionType: AgentExecutionType }) => void | Promise<void>;
}

interface NewTaskOptionsSnapshot {
  availableAgentProviders: AgentProvider[] | undefined;
  availableWorkflows: string[];
  defaultWorkflowName: string | undefined;
  availableBaseBranches: string[];
  defaultBaseBranchName: string | undefined;
  repoDefaultBranchName: string | undefined;
}

export function useAppTaskCreation({
  store,
  toast,
  t,
  sidebarRepos,
  remoteSnapshot,
  mainPanelIsCloudTask,
  selectedCloudRepoId,
  selectedCloudItemId,
  showNewTaskModal,
  availableWorkflows,
  defaultWorkflowName,
  availableBaseBranches,
  defaultBaseBranchName,
  repoDefaultBranchName,
  showAddRepoModal,
  isCloudOnlyRepoId,
  cloudRepoRemoteUrl,
  onAgentChoiceUsed,
}: UseAppTaskCreationOptions) {
  const cloningRepo = ref(false);
  const availableAgentProviders = ref<AgentProvider[] | undefined>(undefined);
  const newTaskOptionsLoading = ref(false);
  const newTaskSubmissionPending = ref(false);
  let pendingNewTaskSubmit: Promise<void> | null = null;
  let newTaskOptionsLoadGeneration = 0;
  const newTaskOptionsCache = new Map<string, NewTaskOptionsSnapshot>();

  function applyNewTaskOptions(snapshot: NewTaskOptionsSnapshot) {
    availableAgentProviders.value = snapshot.availableAgentProviders;
    availableWorkflows.value = snapshot.availableWorkflows;
    defaultWorkflowName.value = snapshot.defaultWorkflowName;
    availableBaseBranches.value = snapshot.availableBaseBranches;
    defaultBaseBranchName.value = snapshot.defaultBaseBranchName;
    repoDefaultBranchName.value = snapshot.repoDefaultBranchName;
  }

  function clearNewTaskOptions() {
    applyNewTaskOptions({
      availableAgentProviders: undefined,
      availableWorkflows: [],
      defaultWorkflowName: undefined,
      availableBaseBranches: [],
      defaultBaseBranchName: undefined,
      repoDefaultBranchName: undefined,
    });
  }

  function claimLocalTaskOwnership(repoId: string) {
    claimLocalTaskSelectionOwnership({
      store,
      repoId,
      selectedCloudRepoId,
      selectedCloudItemId,
    });
  }

  async function openNewTaskModal(repoId?: string) {
    const loadGeneration = ++newTaskOptionsLoadGeneration;
    const targetRepoId = repoId ?? store.selectedRepoId ?? (sidebarRepos.value.length === 1 ? sidebarRepos.value[0]?.id : undefined);
    if (targetRepoId) store.selectedRepoId = targetRepoId;
    const cachedOptions = targetRepoId ? newTaskOptionsCache.get(targetRepoId) : undefined;
    if (cachedOptions) {
      applyNewTaskOptions(cachedOptions);
    } else {
      clearNewTaskOptions();
    }
    newTaskOptionsLoading.value = true;
    showNewTaskModal.value = true;

    const targetRepo = store.repos.find((r) => r.id === targetRepoId);
    const repoPath = targetRepo?.path;
    try {
      if (repoPath) {
        const [manifest, defaultBranch, baseBranches, repoAgentProviders, recentWorkflows] = await Promise.all([
          fetchDesktopRepoKannaDefinitions(targetRepo.id).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[App] failed to load repo definitions for new task modal:", error);
            if (loadGeneration === newTaskOptionsLoadGeneration && showNewTaskModal.value) {
              toast.error(`${t("toasts.repoDefinitionsFailed")}: ${message}`);
            }
            return null;
          }),
          invoke<string>("git_default_branch", { repoPath }).catch((error) => {
            console.debug("[App] failed to read default branch for new task modal:", error);
            return "";
          }),
          invoke<string[]>("git_list_base_branches", { repoPath }).catch((error) => {
            console.debug("[App] failed to list base branches for new task modal:", error);
            return [] as string[];
          }),
          fetchDesktopRepoAgentProviders(targetRepo.id).catch((error) => {
            console.debug("[App] failed to resolve repo agent providers for new task modal:", error);
            return undefined;
          }),
          // Sticky workflow default. Losing it is not worth failing the modal
          // over — an empty history falls back to the repo's configured default.
          fetchDesktopRepoRecentWorkflows(targetRepo.id).catch((error) => {
            console.debug("[App] failed to read recently used workflows for new task modal:", error);
            return [] as string[];
          }),
        ]);
        if (loadGeneration !== newTaskOptionsLoadGeneration || !showNewTaskModal.value) return;
        const availableWorkflowNames = manifest?.workflows ?? [];
        const snapshot: NewTaskOptionsSnapshot = {
          availableAgentProviders: repoAgentProviders,
          availableWorkflows: availableWorkflowNames,
          defaultWorkflowName: resolveStickyWorkflowDefault(
            availableWorkflowNames,
            recentWorkflows,
            manifest?.defaultWorkflow,
          ),
          availableBaseBranches: baseBranches,
          defaultBaseBranchName:
            getDefaultBaseBranch(baseBranches, defaultBranch || "main") || undefined,
          repoDefaultBranchName: defaultBranch || undefined,
        };
        newTaskOptionsCache.set(targetRepo.id, snapshot);
        applyNewTaskOptions(snapshot);
      } else if (isCloudOnlyRepoId(targetRepoId)) {
        const cloudRepo = remoteSnapshot.value.repos.find((repo) => repo.id === targetRepoId);
        const remoteUrl = cloudRepo?.remote_url ?? null;
        const baseBranches = remoteUrl
          ? await invoke<string[]>("git_list_remote_base_branches", { remoteUrl }).catch((error) => {
              console.debug("[App] failed to list remote base branches for cloud repo:", error);
              return [] as string[];
            })
          : [];
        if (loadGeneration !== newTaskOptionsLoadGeneration || !showNewTaskModal.value) return;
        const snapshot: NewTaskOptionsSnapshot = {
          availableAgentProviders: undefined,
          availableWorkflows: [],
          defaultWorkflowName: undefined,
          availableBaseBranches: baseBranches,
          defaultBaseBranchName:
            getDefaultBaseBranch(baseBranches, cloudRepo?.default_branch || "main") || undefined,
          repoDefaultBranchName: cloudRepo?.default_branch || undefined,
        };
        if (targetRepoId) newTaskOptionsCache.set(targetRepoId, snapshot);
        applyNewTaskOptions(snapshot);
      }
    } finally {
      if (loadGeneration === newTaskOptionsLoadGeneration) {
        newTaskOptionsLoading.value = false;
      }
    }
  }

  // Open tasks in the selected repo that a new task can declare as blockers.
  const newTaskBlockerCandidates = computed(() => {
    const repoId = store.selectedRepoId;
    if (!repoId) return [];
    return store.items.filter((item) => item.repo_id === repoId && item.closed_at == null);
  });

  // Handlers that mix UI state + store
  async function handleNewTaskSubmit(
    prompt: string,
    agentProvider: AgentProvider,
    workflowName?: string,
    baseBranch?: string,
    agentType: "pty" | "agent" = "pty",
    blockerTaskIds?: string[],
  ) {
    if (pendingNewTaskSubmit) return;

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
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Cloud repo clone failed:", e);
        toast.error(`${t('toasts.cloneFailed')}: ${msg}`);
        return;
      }
    }
    if (!repo) return;
    claimLocalTaskOwnership(repo.id);
    showNewTaskModal.value = false;
    newTaskSubmissionPending.value = true;
    const submitPromise = (async () => {
      await store.createItem(store.selectedRepoId ?? repo.id, repo.path, prompt, agentType, {
        agentProvider,
        workflowName,
        baseBranch,
        blockerTaskIds,
      });
      try {
        await onAgentChoiceUsed?.({ provider: agentProvider, executionType: agentType });
      } catch (error: unknown) {
        console.warn("[App] failed to record recent agent choice:", error);
      }
    })();
    pendingNewTaskSubmit = submitPromise;
    try {
      await submitPromise;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Task creation failed:", e);
      toast.error(`${t('toasts.taskCreationFailed')}: ${msg}`);
    } finally {
      if (pendingNewTaskSubmit === submitPromise) {
        pendingNewTaskSubmit = null;
        newTaskSubmissionPending.value = false;
      }
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
      const exists = await fileExistsSafe(candidatePath);
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

  async function launchSetupTask(repoId: string | null | undefined, repoPath: string) {
    if (!repoId) return;
    try {
      const agent = await store.loadAgent(repoId, "setup");
      await store.createItem(
        repoId,
        repoPath,
        SETUP_TASK_PROMPT,
        "pty",
        {
          customTask: {
            name: "Set Up Repository",
            agent: "setup",
            prompt: SETUP_TASK_PROMPT,
            model: agent.model,
            effort: agent.effort,
            permissionMode: agent.permission_mode,
            allowedTools: agent.allowed_tools,
          },
        },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[App] setup task creation failed:", error);
      toast.error(`${t('toasts.taskCreationFailed')}: ${msg}`);
    }
  }

  async function launchSetupTaskIfNeeded(
    repoId: string | null | undefined,
    repoPath: string,
  ) {
    if (!repoId) return;
    let repositoryState: GitRepositoryState;
    try {
      repositoryState = await invoke<GitRepositoryState>("git_repository_state", { repoPath });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[App] setup eligibility check failed:", error);
      toast.error(`${t('toasts.taskCreationFailed')}: ${msg}`);
      return;
    }
    if (!repositoryState.hasCommits) {
      toast.warning(t("toasts.emptyRepoNeedsInitialCommit"));
      return;
    }
    const hasKannaConfig = await fileExistsSafe(`${repoPath}/.kanna`);
    if (hasKannaConfig) return;
    await launchSetupTask(repoId, repoPath);
  }

  async function handleCreateRepo(name: string, path: string) {
    try {
      const repoId = await store.createRepo(name, path);
      if (repoId) claimLocalTaskOwnership(repoId);
      showAddRepoModal.value = false;
      await launchSetupTaskIfNeeded(repoId, path);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${t('toasts.repoCreationFailed')}: ${msg}`);
    }
  }

  async function handleImportRepo(path: string, name: string, defaultBranch: string) {
    try {
      const repoId = await store.importRepo(path, name, defaultBranch);
      if (repoId) claimLocalTaskOwnership(repoId);
      showAddRepoModal.value = false;
      await launchSetupTaskIfNeeded(repoId, path);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${t('toasts.repoImportFailed')}: ${msg}`);
    }
  }

  async function handleCloneRepo(url: string, destination: string) {
    cloningRepo.value = true;
    try {
      const repoId = await store.cloneAndImportRepo(url, destination);
      if (repoId) claimLocalTaskOwnership(repoId);
      showAddRepoModal.value = false;
      await launchSetupTaskIfNeeded(repoId, destination);
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

  const currentTaskIsBlocked = computed(() => {
    if (mainPanelIsCloudTask.value) return false;
    const item = store.currentItem;
    if (!item) return false;
    return (store.taskBlockers ?? []).some((blocker) => {
      if (blocker.blocked_item_id !== item.id) return false;
      const blockerState = (store.blockerTaskStates ?? {})[blocker.blocker_item_id]
        ?? store.items.find((candidate) => candidate.id === blocker.blocker_item_id);
      return !blockerState || !isBlockerResolved(blockerState);
    });
  });

  return {
    cloningRepo,
    availableAgentProviders,
    newTaskOptionsLoading,
    newTaskSubmissionPending,
    currentBlockers,
    currentTaskIsBlocked,
    newTaskBlockerCandidates,
    openNewTaskModal,
    handleNewTaskSubmit,
    handleCreateRepo,
    handleImportRepo,
    handleCloneRepo,
  };
}
