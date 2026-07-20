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
} from "../services/desktopServerClient";
import type { useKannaStore } from "../stores/kanna";
import { claimLocalTaskSelectionOwnership } from "./localTaskSelectionOwnership";
import type { useToast } from "./useToast";

const SETUP_TASK_PROMPT = "Set up Kanna for this repository.";

interface SidebarRepoProjection {
  id: string;
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
  availablePipelines: Ref<string[]>;
  defaultPipelineName: Ref<string | undefined>;
  availableBaseBranches: Ref<string[]>;
  defaultBaseBranchName: Ref<string | undefined>;
  repoDefaultBranchName: Ref<string | undefined>;
  showAddRepoModal: Ref<boolean>;
  isCloudOnlyRepoId: (repoId: string | undefined | null) => boolean;
  cloudRepoRemoteUrl: (repoId: string | undefined | null) => string | null;
  onAgentChoiceUsed?: (choice: { provider: AgentProvider; executionType: AgentExecutionType }) => void | Promise<void>;
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
  availablePipelines,
  defaultPipelineName,
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
  let pendingNewTaskSubmit: Promise<void> | null = null;

  function claimLocalTaskOwnership(repoId: string) {
    claimLocalTaskSelectionOwnership({
      store,
      repoId,
      selectedCloudRepoId,
      selectedCloudItemId,
    });
  }

  async function openNewTaskModal(repoId?: string) {
    await pendingNewTaskSubmit?.catch(() => undefined);

    const targetRepoId = repoId ?? store.selectedRepoId ?? (sidebarRepos.value.length === 1 ? sidebarRepos.value[0]?.id : undefined);
    if (targetRepoId) store.selectedRepoId = targetRepoId;
    const targetRepo = store.repos.find((r) => r.id === targetRepoId);
    const repoPath = targetRepo?.path;
    if (repoPath) {
      const [manifest, defaultBranch, baseBranches, repoAgentProviders] = await Promise.all([
        fetchDesktopRepoKannaDefinitions(targetRepo.id).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[App] failed to load repo definitions for new task modal:", error);
          toast.error(`${t("toasts.repoDefinitionsFailed")}: ${message}`);
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
      ]);
      availableAgentProviders.value = repoAgentProviders;
      availablePipelines.value = manifest?.pipelines ?? [];
      defaultPipelineName.value = manifest?.defaultPipeline;
      repoDefaultBranchName.value = defaultBranch || undefined;
      availableBaseBranches.value = baseBranches;
      defaultBaseBranchName.value =
        getDefaultBaseBranch(baseBranches, defaultBranch || "main") || undefined;
    } else if (isCloudOnlyRepoId(targetRepoId)) {
      availableAgentProviders.value = undefined;
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
      availableAgentProviders.value = undefined;
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
    const submitPromise = (async () => {
      await store.createItem(store.selectedRepoId ?? repo.id, repo.path, prompt, agentType, {
        agentProvider,
        pipelineName,
        baseBranch,
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
      claimLocalTaskOwnership(repoId);
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

  async function handleCreateRepo(name: string, path: string) {
    try {
      const repoId = await store.createRepo(name, path);
      showAddRepoModal.value = false;
      await launchSetupTask(repoId, path);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${t('toasts.repoCreationFailed')}: ${msg}`);
    }
  }

  async function handleImportRepo(path: string, name: string, defaultBranch: string) {
    try {
      const repoId = await store.importRepo(path, name, defaultBranch);
      showAddRepoModal.value = false;
      await launchSetupTask(repoId, path);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${t('toasts.repoImportFailed')}: ${msg}`);
    }
  }

  async function handleCloneRepo(url: string, destination: string) {
    cloningRepo.value = true;
    try {
      const repoId = await store.cloneAndImportRepo(url, destination);
      showAddRepoModal.value = false;
      await launchSetupTask(repoId, destination);
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
    currentBlockers,
    currentTaskIsBlocked,
    openNewTaskModal,
    handleNewTaskSubmit,
    handleCreateRepo,
    handleImportRepo,
    handleCloneRepo,
  };
}
