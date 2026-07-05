import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import {
  addDesktopRepo,
  findDesktopRepoByPath,
  patchDesktopRepo,
  reorderDesktopRepos,
  type DesktopRepoResponse,
} from "../services/desktopServerClient";
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
  const repoId = (repo: Pick<DesktopRepoResponse, "id">) => repo.id;
  const repoHidden = (repo: Pick<DesktopRepoResponse, "hidden">) => Boolean(repo.hidden);

  async function importRepo(path: string, name: string, defaultBranch: string): Promise<string> {
    void defaultBranch;
    const existing = await findDesktopRepoByPath(path);
    if (existing) {
      if (repoHidden(existing)) {
        await patchDesktopRepo(existing.id, { hidden: false });
        await reloadSnapshot();
        await invalidateWindowWorkspace("importRepo");
        context.state.selectedRepoId.value = existing.id;
      }
      return existing.id;
    }
    const created = await addDesktopRepo({ path, name });
    const id = repoId(created);
    await refreshRepoRemoteMetadata({ id, path });
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
    const existing = await findDesktopRepoByPath(path);
    if (existing) {
      if (repoHidden(existing)) {
        await patchDesktopRepo(existing.id, { hidden: false });
        await reloadSnapshot();
        await invalidateWindowWorkspace("createRepo");
        context.state.selectedRepoId.value = existing.id;
      }
      return;
    }
    await invoke("ensure_directory", { path });
    await invoke("git_init", { path });
    const created = await addDesktopRepo({ path, name });
    const id = repoId(created);
    await refreshRepoRemoteMetadata({ id, path });
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
    const created = await addDesktopRepo({ path: destination, name });
    const id = repoId(created);
    await refreshRepoRemoteMetadata({ id, path: destination });
    await reloadSnapshot();
    await invalidateWindowWorkspace("cloneAndImportRepo");
    context.state.selectedRepoId.value = id;
    if (isTauri) {
      requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${id}`, destination, null, false)
        .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
    }
  }

  async function hideRepo(repoId: string) {
    await patchDesktopRepo(repoId, { hidden: true });
    if (context.state.selectedRepoId.value === repoId) context.state.selectedRepoId.value = null;
    context.state.lastHiddenRepoId.value = repoId;
    await reloadSnapshot();
    await invalidateWindowWorkspace("hideRepo");
  }

  async function renameRepo(repoId: string, name: string) {
    await patchDesktopRepo(repoId, { name });
    await reloadSnapshot();
    await invalidateWindowWorkspace("renameRepo");
  }

  async function reorderRepos(orderedIds: string[]) {
    await reorderDesktopRepos(orderedIds);
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
