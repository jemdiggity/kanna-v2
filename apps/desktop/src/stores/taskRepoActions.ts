import {
  findRepoByPath,
  hideRepo as hideRepoQuery,
  insertRepo,
  reorderRepos as reorderReposQuery,
  unhideRepo as unhideRepoQuery,
  updateRepoName,
} from "@kanna/db";
import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import { refreshRepoRemoteMetadata } from "../services/repoRemoteUrl";
import { reportPrewarmSessionError } from "./kannaCleanup";
import { requireService, type StoreContext } from "./state";
import type { TasksApi } from "./tasks";

export function createTaskRepoActions(
  context: StoreContext,
): Pick<TasksApi, "importRepo" | "createRepo" | "cloneAndImportRepo" | "hideRepo" | "renameRepo" | "reorderRepos"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

  async function importRepo(path: string, name: string, defaultBranch: string): Promise<string> {
    const existing = await findRepoByPath(context.requireDb(), path);
    if (existing) {
      if (existing.hidden) {
        await unhideRepoQuery(context.requireDb(), existing.id);
        await reloadSnapshot();
        await invalidateWindowWorkspace("importRepo");
        context.state.selectedRepoId.value = existing.id;
      }
      return existing.id;
    }
    const id = crypto.randomUUID().slice(0, 8);
    await insertRepo(context.requireDb(), { id, path, name, default_branch: defaultBranch });
    await refreshRepoRemoteMetadata(context.requireDb(), { id, path });
    await reloadSnapshot();
    await invalidateWindowWorkspace("importRepo");
    context.state.selectedRepoId.value = id;
    if (isTauri) {
      requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${id}`, path, null, false)
        .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
    }
    return id;
  }

  async function createRepo(name: string, path: string) {
    const existing = await findRepoByPath(context.requireDb(), path);
    if (existing) {
      if (existing.hidden) {
        await unhideRepoQuery(context.requireDb(), existing.id);
        await reloadSnapshot();
        await invalidateWindowWorkspace("createRepo");
        context.state.selectedRepoId.value = existing.id;
      }
      return;
    }
    await invoke("ensure_directory", { path });
    await invoke("git_init", { path });
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath: path }).catch(() => "main");
    const id = crypto.randomUUID().slice(0, 8);
    await insertRepo(context.requireDb(), { id, path, name, default_branch: defaultBranch });
    await refreshRepoRemoteMetadata(context.requireDb(), { id, path });
    await reloadSnapshot();
    await invalidateWindowWorkspace("createRepo");
    context.state.selectedRepoId.value = id;
    if (isTauri) {
      requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${id}`, path, null, false)
        .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
    }
  }

  async function cloneAndImportRepo(url: string, destination: string) {
    await invoke("git_clone", { url, destination });
    const name = destination.split("/").pop() || "repo";
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath: destination }).catch(() => "main");
    const id = crypto.randomUUID().slice(0, 8);
    await insertRepo(context.requireDb(), { id, path: destination, name, default_branch: defaultBranch });
    await refreshRepoRemoteMetadata(context.requireDb(), { id, path: destination });
    await reloadSnapshot();
    await invalidateWindowWorkspace("cloneAndImportRepo");
    context.state.selectedRepoId.value = id;
    if (isTauri) {
      requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${id}`, destination, null, false)
        .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
    }
  }

  async function hideRepo(repoId: string) {
    await hideRepoQuery(context.requireDb(), repoId);
    if (context.state.selectedRepoId.value === repoId) context.state.selectedRepoId.value = null;
    context.state.lastHiddenRepoId.value = repoId;
    await reloadSnapshot();
    await invalidateWindowWorkspace("hideRepo");
  }

  async function renameRepo(repoId: string, name: string) {
    await updateRepoName(context.requireDb(), repoId, name);
    await reloadSnapshot();
    await invalidateWindowWorkspace("renameRepo");
  }

  async function reorderRepos(orderedIds: string[]) {
    await reorderReposQuery(context.requireDb(), orderedIds);
    await reloadSnapshot();
    await invalidateWindowWorkspace("reorderRepos");
  }


  return {
    importRepo,
    createRepo,
    cloneAndImportRepo,
    hideRepo,
    renameRepo,
    reorderRepos,
  };
}
