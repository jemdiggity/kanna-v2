import type { PipelineItem } from "../types/kanna";
import {
  closeDesktopTask,
  fetchClosedTaskIdentities,
  patchDesktopRepo,
  reopenDesktopTask,
} from "../services/desktopServerClient";
import { hasOpenSubtasks } from "../utils/taskParenting";
import { requireService, type StoreContext } from "./state";
import { resolveAgentProvider } from "./agent-provider";
import { resolveTaskItemForDaemonSession } from "./taskSessionIdentity";
import type { TasksApi } from "./tasks";

export function createTaskCloseActions(
  context: StoreContext,
  _dependencies: { checkUnblocked: (blockerItemId: string) => Promise<void> },
): Pick<TasksApi, "closeTask" | "undoClose" | "handleAgentFinished"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

  async function selectReplacementAfterTaskRemoval(item: PipelineItem): Promise<void> {
    await requireService(
      context.services.selectReplacementAfterItemRemoval,
      "selectReplacementAfterItemRemoval",
    )(item);
  }

  async function taskCloseWasCommitted(taskId: string): Promise<boolean> {
    const snapshot = await requireService(context.services.fetchSnapshot, "fetchSnapshot")();
    return snapshot.entries.every((entry) =>
      entry.items.every((candidate) => candidate.id !== taskId || candidate.closed_at !== null),
    );
  }

  async function closeTask(
    targetItemId?: string,
    opts?: { selectNext?: boolean },
  ): Promise<boolean> {
    const item = targetItemId
      ? context.state.items.value.find((candidate) => candidate.id === targetItemId)
      : requireService(context.services.currentItem, "currentItem").value;
    const repo = item
      ? context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      : requireService(context.services.selectedRepo, "selectedRepo").value;
    if (!item || !repo) return false;
    if (hasOpenSubtasks(context.state.items.value, item.id)) {
      context.toast.warning(context.tt("toasts.closeTaskHasOpenSubtasks"));
      return false;
    }
    const itemWasSelected = requireService(
      context.services.selectedTaskId,
      "selectedTaskId",
    ).value === item.id;
    const selectionIntentAtStart = context.state.selectionIntentVersion.value;

    try {
      await closeDesktopTask(item.id);
    } catch (error) {
      let closeWasCommitted = false;
      try {
        closeWasCommitted = await taskCloseWasCommitted(item.id);
      } catch (verificationError) {
        console.error("[store] failed to verify task state after close error:", verificationError);
      }

      if (!closeWasCommitted) {
        console.error("[store] close failed:", error);
        context.toast.error(context.tt("toasts.closeTaskFailed"));
        return false;
      }

      console.warn("[store] close response failed after the task was committed:", error);
    }

    try {
      const selectionIntentIsCurrent = context.state.selectionIntentVersion.value
        === selectionIntentAtStart;
      if (opts?.selectNext !== false && itemWasSelected && selectionIntentIsCurrent) {
        await selectReplacementAfterTaskRemoval(item);
      }
      await reloadSnapshot();
      await invalidateWindowWorkspace("closeTask");
    } catch (error) {
      console.error("[store] post-close reconciliation failed:", error);
      context.toast.error(context.tt("toasts.closeTaskFailed"));
    }

    return true;
  }

  async function undoClose() {
    try {
      if (context.state.lastHiddenRepoId.value) {
        const repoId = context.state.lastHiddenRepoId.value;
        await patchDesktopRepo(repoId, { hidden: false });
        context.state.lastHiddenRepoId.value = null;
        await reloadSnapshot();
        await invalidateWindowWorkspace("undoClose");
        return;
      }

      const [identity] = await fetchClosedTaskIdentities();
      if (!identity) return;

      await reopenDesktopTask(identity.id);
      await reloadSnapshot();
      const reopenedItem = context.state.items.value.find((candidate) => candidate.id === identity.id);
      if (!reopenedItem) return;
      const repo = context.state.repos.value.find((candidate) => candidate.id === reopenedItem.repo_id);
      if (!repo) return;
      const worktreePath = reopenedItem.branch ? `${repo.path}/.kanna-worktrees/${reopenedItem.branch}` : repo.path;
      await requireService(context.services.selectItem, "selectItem")(reopenedItem.id);
      await invalidateWindowWorkspace("undoClose");

      if (reopenedItem.branch) {
        try {
          const agentProvider = resolveAgentProvider(
            reopenedItem.agent_provider,
            await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
          );
          await requireService(context.services.spawnPtySession, "spawnPtySession")(reopenedItem.id, worktreePath, reopenedItem.prompt || "", 80, 24, {
            agentProvider,
            ...(reopenedItem.agent_session_id ? { resumeSessionId: reopenedItem.agent_session_id } : {}),
          });
          await reloadSnapshot();
        } catch (spawnError) {
          console.error("[store] session re-spawn after undo failed:", spawnError);
          context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${spawnError instanceof Error ? spawnError.message : spawnError}`);
        }
      }
    } catch (error) {
      console.error("[store] undo close failed:", error);
      context.toast.error(context.tt("toasts.undoCloseFailed"));
    }
  }

  async function handleAgentFinished(sessionId: string) {
    const item = resolveTaskItemForDaemonSession(context.state.items.value, sessionId);
    if (!item) return;
    if (item.closed_at !== null) return;
    try {
      await requireService(
        context.services.applyTaskRuntimeStatus as ((item: PipelineItem, status: string) => Promise<void>) | undefined,
        "applyTaskRuntimeStatus",
      )(item, "idle");
      await reloadSnapshot();
      await invalidateWindowWorkspace("taskActivity");
    } catch (error) {
      console.error("[store] activity update failed:", error);
    }
  }

  return {
    closeTask,
    undoClose,
    handleAgentFinished,
  };
}
