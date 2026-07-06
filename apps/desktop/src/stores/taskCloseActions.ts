import {
  unhideRepo as unhideRepoQuery,
  type PipelineItem,
} from "@kanna/db";
import { closeDesktopTask, reopenDesktopTask } from "../services/desktopServerClient";
import { hasOpenSubtasks } from "../utils/taskParenting";
import { requireService, type StoreContext } from "./state";
import { resolveAgentProvider } from "./agent-provider";
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
    if (context.state.selectedItemId.value !== item.id) return;
    await requireService(
      context.services.selectReplacementAfterItemRemoval,
      "selectReplacementAfterItemRemoval",
    )(item);
  }

  async function closeTask(targetItemId?: string, opts?: { selectNext?: boolean }) {
    const item = targetItemId
      ? context.state.items.value.find((candidate) => candidate.id === targetItemId)
      : requireService(context.services.currentItem, "currentItem").value;
    const repo = item
      ? context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      : requireService(context.services.selectedRepo, "selectedRepo").value;
    if (!item || !repo) return;
    if (hasOpenSubtasks(context.state.items.value, item.id)) {
      context.toast.warning(context.tt("toasts.closeTaskHasOpenSubtasks"));
      return;
    }

    try {
      await closeDesktopTask(item.id);
      if (opts?.selectNext !== false) await selectReplacementAfterTaskRemoval(item);
      await reloadSnapshot();
      await invalidateWindowWorkspace("closeTask");
    } catch (error) {
      console.error("[store] close failed:", error);
      context.toast.error(context.tt("toasts.closeTaskFailed"));
    }
  }

  async function undoClose() {
    if (context.state.lastHiddenRepoId.value) {
      const repoId = context.state.lastHiddenRepoId.value;
      context.state.lastHiddenRepoId.value = null;
      await unhideRepoQuery(context.requireDb(), repoId);
      await reloadSnapshot();
      await invalidateWindowWorkspace("undoClose");
      return;
    }

    try {
      const rows = await context.requireDb().select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1",
      );
      const item = rows[0];
      if (!item) return;
      const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id);
      if (!repo) return;
      const worktreePath = item.branch ? `${repo.path}/.kanna-worktrees/${item.branch}` : repo.path;

      await reopenDesktopTask(item.id);
      await reloadSnapshot();
      const reopenedItem = context.state.items.value.find((candidate) => candidate.id === item.id) ?? item;
      await requireService(context.services.selectItem, "selectItem")(item.id);
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

      context.state.selectedItemId.value = reopenedItem.id;
    } catch (error) {
      console.error("[store] undo close failed:", error);
      context.toast.error(context.tt("toasts.undoCloseFailed"));
    }
  }

  async function handleAgentFinished(sessionId: string) {
    const item = context.state.items.value.find((candidate) => candidate.id === sessionId);
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
