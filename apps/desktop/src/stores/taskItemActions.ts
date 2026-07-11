import { type AgentProvider, type PipelineItem } from "@kanna/db";
import { invoke } from "../invoke";
import { createDesktopTask } from "../services/desktopServerClient";
import { publishDesktopTaskSnapshot } from "../services/desktopCloudPublisher";
import { publishDesktopLanTaskSnapshot } from "../services/desktopLanTaskIndex";
import { debugLog } from "../utils/debugLog";
import { resolveRealE2eAgentOverride } from "./e2eRealAgentOverride";
import { resolveInitialBaseRef } from "./taskBaseBranch";
import { normalizeAgentExecutionType, type AgentExecutionType } from "./agentExecutionType";
import { requireService, type CreateItemOptions, type StoreContext } from "./state";
import { showCloudPublishErrorToast } from "./taskPublishing";
import {
  acknowledgeTaskUiSlot,
  buildCreatingTaskUiSlot,
  reconcileTaskUiSlots,
  removeTaskUiSlot,
} from "./taskUiSlots";
import type { TasksApi } from "./tasks";

export function createTaskItemActions(
  context: StoreContext,
): Pick<TasksApi, "createItem"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

  function persistSelectionBestEffort(message: string): void {
    void requireService(context.services.persistSelection, "persistSelection")()
      .catch((error) => console.error(message, error));
  }

  async function resolveCreateBaseRef(repoPath: string, opts?: CreateItemOptions): Promise<string | null> {
    if (opts?.baseRef !== undefined) return opts.baseRef;
    try {
      const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
      const availableBaseBranches = await invoke<string[]>("git_list_base_branches", { repoPath });
      return resolveInitialBaseRef({
        selectedBaseBranch: opts?.baseBranch,
        availableBaseBranches,
        defaultBranch,
      });
    } catch (error) {
      console.warn("[store] failed to verify base branch:", error);
      return null;
    }
  }

  async function createItem(
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType: AgentExecutionType = "pty",
    opts?: CreateItemOptions,
  ): Promise<string> {
    const t0 = performance.now();
    const slotId = `create:${crypto.randomUUID()}`;
    const effectivePrompt = opts?.customTask?.prompt ?? prompt;
    const effectiveAgentType = normalizeAgentExecutionType(opts?.customTask?.executionMode ?? agentType);
    const customTaskAgentProvider = opts?.customTask?.agentProvider;
    const requestedAgentProviders = customTaskAgentProvider ?? opts?.agentProvider;
    const requestedModel = opts?.customTask?.model ?? opts?.model;
    const displayName = opts?.customTask?.name ?? opts?.displayName ?? null;
    debugLog("[tasks:createItem] server create start", {
      slotId,
      repoId,
      agentType: effectiveAgentType,
      requestedPipeline: opts?.pipelineName,
      selectOnCreate: opts?.selectOnCreate,
      selectedAtStart: context.state.selectedItemId.value,
    });

    const creatingSlot = buildCreatingTaskUiSlot({
      slotId,
      repoId,
      prompt: effectivePrompt,
      displayName,
      pipelineName: opts?.pipelineName,
      stage: opts?.stage,
      agentType: effectiveAgentType,
      requestedAgentProviders,
    });
    context.state.taskUiSlots.value = [
      creatingSlot,
      ...context.state.taskUiSlots.value.filter((slot) => slot.slot_id !== slotId),
    ];
    context.state.pendingCreateVisibility.set(slotId, { bumpAt: performance.now() });

    if (opts?.selectOnCreate !== false) {
      context.state.selectedRepoId.value = repoId;
      context.state.selectedItemId.value = slotId;
      context.state.lastSelectedItemByRepo.value = {
        ...context.state.lastSelectedItemByRepo.value,
        [repoId]: slotId,
      };
      persistSelectionBestEffort("[store] failed to persist creating task selection:");
    }

    let createdTaskId: string | null = null;
    try {
      const realE2eAgentOverride = await resolveRealE2eAgentOverride({
        agentType: effectiveAgentType,
        explicitAgentProvider: requestedAgentProviders,
        explicitModel: requestedModel,
      });
      const effectiveAgentProvider = (customTaskAgentProvider ?? realE2eAgentOverride?.agentProvider ?? requestedAgentProviders) as AgentProvider | undefined;
      const resolvedModel = opts?.customTask?.model ?? realE2eAgentOverride?.model ?? opts?.model;
      const baseRef = await resolveCreateBaseRef(repoPath, opts);
      if (!baseRef) {
        context.toast.error("No valid base branch selected");
        throw new Error("No valid base branch selected");
      }

      const created = await createDesktopTask({
        repoId,
        prompt: effectivePrompt,
        displayName,
        pipelineName: opts?.pipelineName,
        stage: opts?.stage,
        baseRef,
        agent: opts?.customTask?.agent,
        agentProvider: effectiveAgentProvider,
        agentType: effectiveAgentType,
        model: resolvedModel,
        permissionMode: opts?.customTask?.permissionMode ?? opts?.permissionMode,
        allowedTools: opts?.customTask?.allowedTools ?? opts?.allowedTools,
        disallowedTools: opts?.customTask?.disallowedTools,
        maxTurns: opts?.customTask?.maxTurns,
        maxBudgetUsd: opts?.customTask?.maxBudgetUsd,
        setupCmds: opts?.customTask?.setup,
        resumeSessionId: opts?.resumeSessionId,
        recoverySnapshot: opts?.recoverySnapshot,
      });
      createdTaskId = created.taskId;
    } catch (error) {
      context.state.pendingCreateVisibility.delete(slotId);
      context.state.taskUiSlots.value = removeTaskUiSlot(context.state.taskUiSlots.value, slotId);
      context.state.taskUiSlots.value = reconcileTaskUiSlots(
        context.state.taskUiSlots.value,
        context.state.items.value,
        { authoritative: false },
      );
      if (context.state.lastSelectedItemByRepo.value[repoId] === slotId) {
        const { [repoId]: _removed, ...lastSelectedItemByRepo } = context.state.lastSelectedItemByRepo.value;
        context.state.lastSelectedItemByRepo.value = lastSelectedItemByRepo;
      }
      if (context.state.selectedItemId.value === slotId) {
        requireService(context.services.reconcileSelection, "reconcileSelection")();
        const fallbackSlotId = context.state.selectedItemId.value;
        const fallbackRepoId = context.state.selectedRepoId.value;
        if (fallbackSlotId && fallbackRepoId) {
          context.state.lastSelectedItemByRepo.value = {
            ...context.state.lastSelectedItemByRepo.value,
            [fallbackRepoId]: fallbackSlotId,
          };
        }
        persistSelectionBestEffort("[store] failed to persist selection after task creation failure:");
      }
      throw error;
    }

    context.state.taskUiSlots.value = reconcileTaskUiSlots(
      acknowledgeTaskUiSlot(
        context.state.taskUiSlots.value,
        slotId,
        createdTaskId,
      ),
      context.state.items.value,
      { authoritative: false },
    );
    const pendingVisibility = context.state.pendingCreateVisibility.get(slotId);
    context.state.pendingCreateVisibility.delete(slotId);
    if (pendingVisibility) {
      context.state.pendingCreateVisibility.set(createdTaskId, pendingVisibility);
    }
    if (context.state.selectedItemId.value === slotId) {
      persistSelectionBestEffort("[store] failed to persist acknowledged task selection:");
    }

    try {
      await reloadSnapshot();
    } catch (error) {
      console.error("[store] failed to hydrate created task snapshot:", error);
    }

    const createdItem = context.state.items.value.find((candidate) => candidate.id === createdTaskId);
    const createdRepo = context.state.repos.value.find((candidate) => candidate.id === repoId) ?? null;
    if (createdItem) {
      void publishDesktopLanTaskSnapshot(context.requireDb());
      publishCreatedTaskSnapshot(createdTaskId, createdItem, createdRepo);
    }
    debugLog(`[perf:createItem] server create TOTAL: ${(performance.now() - t0).toFixed(1)}ms`);

    try {
      await invalidateWindowWorkspace("createItem");
    } catch (error) {
      console.error("[store] failed to invalidate workspace after task creation:", error);
    }
    return createdTaskId;
  }

  function publishCreatedTaskSnapshot(taskId: string, createdItem: PipelineItem, createdRepo: Parameters<typeof publishDesktopTaskSnapshot>[2]) {
    const publishPromise = publishDesktopTaskSnapshot(context.requireDb(), createdItem, createdRepo)
      .then(() => {
        if (import.meta.env.DEV && typeof window !== "undefined") {
          (window as unknown as { __KANNA_E2E_CLOUD_PUBLISH__?: unknown }).__KANNA_E2E_CLOUD_PUBLISH__ = {
            status: "ok",
            taskId,
          };
        }
      })
      .catch((error) => {
        if (import.meta.env.DEV && typeof window !== "undefined") {
          (window as unknown as { __KANNA_E2E_CLOUD_PUBLISH__?: unknown }).__KANNA_E2E_CLOUD_PUBLISH__ = {
            status: "error",
            taskId,
            message: error instanceof Error ? error.message : String(error),
          };
        }
        console.warn("[cloud] failed to publish task snapshot:", error);
        showCloudPublishErrorToast(context, error);
        throw error;
      });
    void publishPromise.catch((error) => {
      console.debug("[cloud] async publish task snapshot failed after non-awaited path:", error);
    });
  }

  return { createItem };
}
