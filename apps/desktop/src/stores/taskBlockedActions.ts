import { type RepoConfig } from "@kanna/core";
import {
  getRepo,
  hasCircularDependency,
  insertTaskBlocker,
  listBlockedByItem,
  listBlockersForItem,
  removeTaskBlocker,
  updatePipelineItemActivity,
  updatePipelineItemTags,
  type AgentProvider,
  type PipelineItem,
} from "@kanna/db";
import { invoke } from "../invoke";
import { encodeAgentPromptInputChunks } from "./daemonInput";
import { resolveAgentProvider } from "./agent-provider";
import { hasLiveTaskResources } from "./taskLifecycleEnv";
import { readRepoConfig, requireService, type StoreContext } from "./state";
import type { PortsStore } from "./ports";
import type { TasksApi } from "./tasks";

export function createTaskBlockedActions(
  context: StoreContext,
  ports: PortsStore,
): Pick<TasksApi, "blockTask" | "editBlockedTask" | "checkUnblocked" | "restoreUnblockedTask" | "startBlockedTask"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

  function buildBlockedResumeMessage(blockers: PipelineItem[]): string {
    const blockerContext = blockers
      .map((blocker) => {
        const name = blocker.display_name || (blocker.prompt ? blocker.prompt.slice(0, 60) : "Untitled");
        return `- ${name} (branch: ${blocker.branch || "unknown"})`;
      })
      .join("\n");

    return [
      "This task was previously blocked by the following tasks, which have now completed:",
      blockerContext,
      "Their changes may be on branches that haven't merged to main yet.",
      "Please continue this task using that context where relevant.",
    ].join("\n");
  }

  async function checkUnblocked(blockerItemId: string) {
    const blockedItems = await listBlockedByItem(context.requireDb(), blockerItemId);
    for (const blocked of blockedItems) {
      if (blocked.closed_at !== null) continue;
      const blockers = await listBlockersForItem(context.requireDb(), blocked.id);
      if (blockers.length === 0) continue;
      const allClear = blockers.every((blocker) => blocker.closed_at !== null);
      if (allClear) {
        await restoreUnblockedTask(blocked, blockers);
      }
    }
  }

  async function restoreUnblockedTask(
    item: PipelineItem,
    blockers?: PipelineItem[],
  ): Promise<void> {
    const resolvedBlockers = blockers ?? await listBlockersForItem(context.requireDb(), item.id);
    if (resolvedBlockers.length === 0) return;

    if (hasLiveTaskResources(item)) {
      await resumeBlockedTaskInPlace(item, resolvedBlockers);
      return;
    }

    await startBlockedTask(item);
  }

  async function resumeBlockedTaskInPlace(
    item: PipelineItem,
    blockers?: PipelineItem[],
  ): Promise<void> {
    if (!JSON.parse(item.tags).includes("blocked")) return;
    const resolvedBlockers = blockers ?? await listBlockersForItem(context.requireDb(), item.id);

    const nextTags = JSON.parse(item.tags).filter((tag: string) => tag !== "blocked");
    await updatePipelineItemTags(context.requireDb(), item.id, nextTags);
    await updatePipelineItemActivity(context.requireDb(), item.id, "working");
    await reloadSnapshot();

    const inputChunks = encodeAgentPromptInputChunks(buildBlockedResumeMessage(resolvedBlockers), {
      agentProvider: item.agent_provider,
      kittyKeyboard: false,
    });
    for (const data of inputChunks) {
      await invoke("send_input", { sessionId: item.id, data });
    }
  }

  async function startBlockedTask(item: PipelineItem) {
    const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      ?? await getRepo(context.requireDb(), item.repo_id);
    if (!repo) {
      console.error("[store] startBlockedTask: repo not found for", item.id);
      return;
    }

    const blockers = await listBlockersForItem(context.requireDb(), item.id);
    const blockerContext = blockers
      .map((blocker) => {
        const name = blocker.display_name || (blocker.prompt ? blocker.prompt.slice(0, 60) : "Untitled");
        return `- ${name} (branch: ${blocker.branch || "unknown"})`;
      })
      .join("\n");

    const augmentedPrompt = [
      "Note: this task was previously blocked by the following tasks which have now completed:",
      blockerContext,
      "Their changes may be on branches that haven't merged to main yet.",
      "",
      "Original task:",
      item.prompt || "",
    ].join("\n");

    const id = item.id;
    const branch = `task-${id}`;
    const worktreePath = `${repo.path}/.kanna-worktrees/${branch}`;

    const worktreeExists = await invoke<boolean>("file_exists", { path: worktreePath });
    let resolvedBaseRef: string | null = null;
    if (!worktreeExists) {
      let startPoint: string | null = null;
      try {
        const defaultBranch = await invoke<string>("git_default_branch", { repoPath: repo.path });
        await invoke("git_fetch", { repoPath: repo.path, branch: defaultBranch });
        startPoint = `origin/${defaultBranch}`;
        resolvedBaseRef = startPoint;
      } catch (error) {
        console.debug("[store] fetch origin failed (offline?), using local HEAD:", error);
        try {
          const defaultBranch = await invoke<string>("git_default_branch", { repoPath: repo.path });
          resolvedBaseRef = defaultBranch;
        } catch (defaultBranchError) {
          console.debug("[store] failed to resolve default branch after fetch fallback:", defaultBranchError);
          resolvedBaseRef = null;
        }
      }

      try {
        await invoke("git_worktree_add", {
          repoPath: repo.path,
          branch,
          path: worktreePath,
          startPoint,
        });
      } catch (error) {
        console.error("[store] startBlockedTask worktree_add failed:", error);
        context.toast.error(context.tt("toasts.blockedWorktreeFailed"));
        return;
      }
    }

    let repoConfig: RepoConfig = {};
    try {
      repoConfig = await readRepoConfig(worktreePath);
    } catch (error) {
      console.debug("[store] no .kanna/config.json:", error);
    }

    let agentProvider: AgentProvider;
    let portEnv: Record<string, string> = {};
    try {
      agentProvider = resolveAgentProvider(
        item.agent_provider,
        await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
      );
    } catch (error) {
      console.error("[store] startBlockedTask: agent provider resolution failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      return;
    }

    try {
      const allocated = await ports.claimTaskPorts(id, repoConfig);
      portEnv = allocated.portEnv;
      const portOffset = allocated.firstPort;

      await context.requireDb().execute(
        `UPDATE pipeline_item
         SET branch = ?, port_offset = ?, port_env = ?, base_ref = ?,
             tags = '[]', activity = 'working',
             activity_changed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
        [branch, portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, resolvedBaseRef, id],
      );
      await reloadSnapshot();

      await requireService(context.services.spawnPtySession, "spawnPtySession")(id, worktreePath, augmentedPrompt, 80, 24, {
        agentProvider,
        portEnv,
        setupCmds: repoConfig.setup || [],
      });
    } catch (error) {
      await updatePipelineItemActivity(context.requireDb(), id, "idle");
      await reloadSnapshot();
      console.error("[store] startBlockedTask PTY spawn failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function blockTask(blockerIds: string[]) {
    const item = requireService(context.services.currentItem, "currentItem").value;
    const repo = requireService(context.services.selectedRepo, "selectedRepo").value;
    const isItemHidden = requireService(context.services.isItemHidden as ((item: PipelineItem) => boolean) | undefined, "isItemHidden");
    if (!item || !repo || isItemHidden(item) || JSON.parse(item.tags).includes("blocked")) return;

    for (const blockerId of blockerIds) {
      await insertTaskBlocker(context.requireDb(), item.id, blockerId);
    }

    const nextTags = Array.from(new Set([...JSON.parse(item.tags), "blocked"]));
    await updatePipelineItemTags(context.requireDb(), item.id, nextTags);
    await updatePipelineItemActivity(context.requireDb(), item.id, "idle");
    await reloadSnapshot();
    await invalidateWindowWorkspace("blockTask");
    await requireService(context.services.selectItem, "selectItem")(item.id);
  }

  async function editBlockedTask(itemId: string, newBlockerIds: string[]) {
    const item = context.state.items.value.find((candidate) => candidate.id === itemId);
    if (!item || !JSON.parse(item.tags).includes("blocked")) return;

    if (newBlockerIds.length > 0) {
      const hasCycle = await hasCircularDependency(context.requireDb(), itemId, newBlockerIds);
      if (hasCycle) {
        throw new Error("Cannot add blocker — it would create a circular dependency");
      }
    }

    const currentBlockers = await listBlockersForItem(context.requireDb(), itemId);
    const currentIds = new Set(currentBlockers.map((blocker) => blocker.id));
    const newIds = new Set(newBlockerIds);

    for (const id of currentIds) {
      if (!newIds.has(id)) {
        await removeTaskBlocker(context.requireDb(), itemId, id);
      }
    }

    for (const id of newIds) {
      if (!currentIds.has(id)) {
        await insertTaskBlocker(context.requireDb(), itemId, id);
      }
    }

    await reloadSnapshot();
    await invalidateWindowWorkspace("editBlockedTask");

    const updatedBlockers = await listBlockersForItem(context.requireDb(), itemId);
    const allClear = updatedBlockers.length === 0 || updatedBlockers.every(
      (blocker) => blocker.closed_at !== null,
    );
    if (allClear) {
      const resumeBlockers = updatedBlockers.length > 0 ? updatedBlockers : currentBlockers;
      if (hasLiveTaskResources(item)) {
        await resumeBlockedTaskInPlace(item, resumeBlockers);
      } else {
        await startBlockedTask(item);
      }
    }
  }


  return {
    blockTask,
    editBlockedTask,
    checkUnblocked,
    restoreUnblockedTask,
    startBlockedTask,
  };
}
