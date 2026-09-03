import type { AgentDefinition, WorkflowDefinition } from "../../../../packages/core/src/workflow/workflow-types";
import {
  fetchDesktopRepoAgentDefinition,
  fetchDesktopRepoWorkflowDefinition,
} from "../services/desktopServerClient";
import { postDesktopTaskAction } from "../services/desktopTaskActions";
import { requireService, type AdvanceStageOptions, type KannaSnapshot, type StoreContext } from "./state";
import { debugLog } from "../utils/debugLog";

const STAGE_ADVANCE_RECONCILE_TIMEOUT_MS = 15_000;
const STAGE_ADVANCE_RECONCILE_RETRY_MS = 100;

export interface WorkflowApi {
  loadWorkflow: (repoId: string, workflowName: string) => Promise<WorkflowDefinition>;
  loadAgent: (repoId: string, agentName: string) => Promise<AgentDefinition>;
  advanceStage: (taskId: string, options?: AdvanceStageOptions) => Promise<AdvanceStageResult>;
  requestRevision: (taskId: string, options: RequestRevisionOptions) => Promise<boolean>;
  rerunStage: (taskId: string) => Promise<void>;
}

export type AdvanceStageResult = "advanced" | "ignored" | "failed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RequestRevisionOptions {
  targetStage: string;
  summary: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export function createWorkflowApi(context: StoreContext): WorkflowApi {
  const revisionRequestsInFlight = new Set<string>();
  interface TaskActionResponse {
    taskId: string;
    followTask?: boolean;
    inputDelivery?: {
      status: "queued";
      reason: "input_held_by_draft";
    };
  }

  interface StageAdvanceProjection {
    nextStageName: string | null;
    pendingPostName: string | null;
    closesOnSuccess: boolean;
  }

  // Selection during stage advance is only adjusted when the task being advanced
  // (and therefore closed) is the one currently selected — analogous to deletion,
  // where selection moves to the next visible task. When any other task advances
  // (including auto-advance), the user's selection must be left untouched.
  function computeNextVisibleItemId(currentItemId: string): string | null {
    const sortedItems = requireService(context.services.sortedItemsForCurrentRepo, "sortedItemsForCurrentRepo").value;
    const currentIndex = sortedItems.findIndex((candidate) => candidate.id === currentItemId);
    if (currentIndex === -1) return null;

    const remainingItems = sortedItems.filter((candidate) => candidate.id !== currentItemId);
    const nextIndex = currentIndex >= remainingItems.length ? remainingItems.length - 1 : currentIndex;
    return remainingItems[nextIndex]?.id ?? null;
  }

  async function restoreStageAdvanceSelection(itemId: string | null) {
    if (itemId) {
      const item = context.state.items.value.find((candidate) => candidate.id === itemId);
      const isItemHidden = requireService(context.services.isItemHidden, "isItemHidden");
      if (item && !isItemHidden(item) && item.repo_id === context.state.selectedRepoId.value) {
        debugLog("[workflow:advanceStage] restoring selection", {
          targetItemId: itemId,
          targetStage: item.stage,
          targetBranch: item.branch,
          selectedBefore: context.state.selectedItemId.value,
        });
        await requireService(context.services.selectItem, "selectItem")(itemId);
        return;
      }
    }

    debugLog("[workflow:advanceStage] clearing selection during restore", {
      requestedItemId: itemId,
      selectedBefore: context.state.selectedItemId.value,
    });
    const clearedSlotId = context.state.selectedItemId.value;
    const clearedRepoId = context.state.selectedRepoId.value;
    context.state.selectedItemId.value = null;
    if (
      clearedRepoId
      && context.state.lastSelectedItemByRepo.value[clearedRepoId] === clearedSlotId
    ) {
      const { [clearedRepoId]: _removed, ...remaining } = context.state.lastSelectedItemByRepo.value;
      context.state.lastSelectedItemByRepo.value = remaining;
    }
    await requireService(context.services.persistSelection, "persistSelection")();
  }

  async function resolveStageAdvanceProjection(item: {
    repo_id: string;
    pipeline: string;
    stage: string;
  }): Promise<StageAdvanceProjection> {
    try {
      const workflow = await loadWorkflow(item.repo_id, item.pipeline || "no-review");
      const currentIndex = workflow.stages.findIndex((stage) => stage.name === item.stage);
      if (currentIndex === -1) return { nextStageName: null, pendingPostName: null, closesOnSuccess: false };
      const currentStage = workflow.stages[currentIndex];
      const pendingPostName = currentStage?.post?.name ?? null;
      return {
        nextStageName: workflow.stages[currentIndex + 1]?.name ?? null,
        pendingPostName,
        closesOnSuccess: currentIndex === workflow.stages.length - 1 && pendingPostName === null,
      };
    } catch (error) {
      console.debug("[workflow:advanceStage] could not resolve stage projection for optimistic update:", error);
      return { nextStageName: null, pendingPostName: null, closesOnSuccess: false };
    }
  }

  async function withOptimisticStageAdvance<T>(
    taskId: string,
    nextStageName: string | null,
    pendingPostName: string | null,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!nextStageName && !pendingPostName) return run();
    return requireService(context.services.withOptimisticItemOverlay, "withOptimisticItemOverlay")({
      key: `advance-stage:${taskId}`,
      apply: (snapshot: KannaSnapshot): KannaSnapshot => ({
        ...snapshot,
        entries: snapshot.entries.map((entry) => ({
          ...entry,
          items: entry.items.map((candidate) =>
            candidate.id === taskId
              ? {
                  ...candidate,
                  ...(pendingPostName
                    ? {
                        active_post_action: candidate.active_post_action ?? pendingPostName,
                        has_running_post: 1,
                        activity: "working" as const,
                      }
                    : {
                        stage: nextStageName ?? candidate.stage,
                        activity: "working" as const,
                      }),
                }
              : candidate,
          ),
        })),
      }),
      run,
      reconcile: async () => {
        await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      },
    });
  }

  function stageAdvanceSnapshotCaughtUp(
    taskId: string,
    nextStageName: string | null,
    pendingPostName: string | null,
    closesOnSuccess: boolean,
  ): boolean {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item || item.closed_at != null) return true;
    if (closesOnSuccess) return false;
    if (pendingPostName) {
      return Boolean(item.has_running_post) || item.active_post_action === pendingPostName;
    }
    if (nextStageName) {
      return item.stage === nextStageName;
    }
    return true;
  }

  async function waitForStageAdvanceSnapshot(
    taskId: string,
    nextStageName: string | null,
    pendingPostName: string | null,
    closesOnSuccess: boolean,
  ): Promise<void> {
    const reloadSnapshot = requireService(context.services.reloadSnapshot, "reloadSnapshot");
    const deadline = Date.now() + STAGE_ADVANCE_RECONCILE_TIMEOUT_MS;
    while (true) {
      await reloadSnapshot();
      if (stageAdvanceSnapshotCaughtUp(taskId, nextStageName, pendingPostName, closesOnSuccess)) return;
      if (Date.now() >= deadline) {
        console.warn("[workflow:advanceStage] snapshot did not catch up before timeout", {
          taskId,
          nextStageName,
          pendingPostName,
          closesOnSuccess,
        });
        return;
      }
      await sleep(STAGE_ADVANCE_RECONCILE_RETRY_MS);
    }
  }

  async function loadWorkflow(repoId: string, workflowName: string): Promise<WorkflowDefinition> {
    const cacheKey = `${repoId}::${workflowName}`;
    const response = await fetchDesktopRepoWorkflowDefinition(repoId, workflowName);
    const cached = context.state.workflowCache.get(cacheKey);
    if (cached?.revision === response.revision) return cached.definition;

    context.state.workflowCache.set(cacheKey, response);
    return response.definition;
  }

  async function loadAgent(repoId: string, agentName: string): Promise<AgentDefinition> {
    const cacheKey = `${repoId}::${agentName}`;
    const response = await fetchDesktopRepoAgentDefinition(repoId, agentName);
    const cached = context.state.agentCache.get(cacheKey);
    if (cached?.revision === response.revision) return cached.definition;

    context.state.agentCache.set(cacheKey, response);
    return response.definition;
  }

  async function advanceStage(
    taskId: string,
    options: AdvanceStageOptions = {},
  ): Promise<AdvanceStageResult> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) return "ignored";
    if (item.closed_at != null) return "ignored";
    // Single-flight: while a post (e.g. approve) runs, an ordinary repeated
    // advance would hit the backend's running-post override and transition
    // the stage before the post finishes its work. Only the post's own
    // completion may move the task.
    if (item.has_running_post) {
      context.toast.warning(context.tt("toasts.stagePostRunning"));
      return "ignored";
    }
    const sourceTaskIsSelected = requireService(context.services.selectedTaskId, "selectedTaskId").value === item.id;
    const fallbackSelectionId = computeNextVisibleItemId(item.id);
    const { nextStageName, pendingPostName, closesOnSuccess } = await resolveStageAdvanceProjection(item);
    debugLog("[workflow:advanceStage] selection policy", {
      taskId,
      currentStage: item.stage,
      optimisticNextStage: nextStageName,
      optimisticPendingPost: pendingPostName,
      closesOnSuccess,
      initiatedBy: options.initiatedBy ?? "manual",
      sourceTaskIsSelected,
      fallbackSelectionId,
      selectedBefore: context.state.selectedItemId.value,
    });

    try {
      return await withOptimisticStageAdvance(taskId, nextStageName, pendingPostName, async () => {
        const response = await postDesktopTaskAction(taskId, "advance-stage", {
          source: "operator",
        });
        if (!response.ok) {
          const message = await response.text();
          if (response.status === 409) {
            context.toast.warning(context.tt("mainPanel.taskBlocked"));
            return "ignored" as const;
          }
          throw new Error(message);
        }
        const result = await response.json() as TaskActionResponse;
        const postHeldByDraft = response.status === 202
          && result.inputDelivery?.reason === "input_held_by_draft";
        await waitForStageAdvanceSnapshot(result.taskId, nextStageName, pendingPostName, closesOnSuccess);
        if (postHeldByDraft) {
          context.toast.warning(context.tt("toasts.advanceHeldByDraft"));
        }

        // Durable tasks: an in-workflow advance transitions the SAME task in
        // place, so the user's selection stays put. Only when the advance
        // closed the task (final stage) does selection move to the next
        // visible item — analogous to closing a task.
        const advancedItem = context.state.items.value.find((candidate) => candidate.id === result.taskId);
        const taskClosed = !advancedItem || advancedItem.closed_at != null;
        if (taskClosed && sourceTaskIsSelected) {
          await restoreStageAdvanceSelection(fallbackSelectionId);
        }
        return "advanced" as const;
      });
    } catch (error) {
      console.error("[store] advanceStage: server action failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      return "failed";
    }
  }

  async function rerunStage(taskId: string): Promise<void> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) return;
    if (item.closed_at != null) return;

    try {
      const response = await postDesktopTaskAction(taskId, "rerun-stage");
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
    } catch (error) {
      console.error("[store] rerunStage: server action failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function requestRevision(taskId: string, options: RequestRevisionOptions): Promise<boolean> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) return false;
    if (item.closed_at != null) return false;
    if (revisionRequestsInFlight.has(taskId)) {
      context.toast.warning(context.tt("toasts.revisionAlreadyStarting"));
      return false;
    }

    revisionRequestsInFlight.add(taskId);
    try {
      const response = await postDesktopTaskAction(taskId, "request-revision", {
        targetStage: options.targetStage,
        summary: options.summary,
        prompt: options.prompt,
        metadata: options.metadata,
        // A revision the user asked for is never refused by the agent
        // revision-round budget, and it hands the budget back.
        origin: "human",
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      return true;
    } catch (error) {
      console.error("[store] requestRevision: server action failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      return false;
    } finally {
      revisionRequestsInFlight.delete(taskId);
    }
  }

  return {
    loadWorkflow,
    loadAgent,
    advanceStage,
    requestRevision,
    rerunStage,
  };
}
