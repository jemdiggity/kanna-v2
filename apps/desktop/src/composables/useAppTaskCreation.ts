import { ref, type ComputedRef, type Ref } from "vue";
import { computedAsync } from "@vueuse/core";
import { parseRepoConfig } from "@kanna/core";
import type { AgentProvider } from "@kanna/db";

import { invoke } from "../invoke";
import { getDefaultBaseBranch } from "../utils/baseBranchPicker";
import { parseRepoInput } from "../utils/parseRepoInput";
import { defaultReposHome } from "../utils/reposHome";
import type { DesktopCloudSnapshot } from "../services/desktopCloudTaskIndex";
import type { useKannaStore } from "../stores/kanna";
import type { useToast } from "./useToast";

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
}: UseAppTaskCreationOptions) {
  const cloningRepo = ref(false);

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

  return {
    cloningRepo,
    currentBlockers,
    openNewTaskModal,
    handleNewTaskSubmit,
    handleCreateRepo,
    handleImportRepo,
    handleCloneRepo,
  };
}
