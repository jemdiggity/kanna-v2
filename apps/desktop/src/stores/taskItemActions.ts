import { type AgentProvider } from "@kanna/db";
import { invoke } from "../invoke";
import { createDesktopTask } from "../services/desktopServerClient";
import { publishDesktopLanTaskSnapshot } from "../services/desktopLanTaskIndex";
import { debugLog } from "../utils/debugLog";
import { resolveRealE2eAgentOverride } from "./e2eRealAgentOverride";
import { resolveInitialBaseRef } from "./taskBaseBranch";
import { normalizeAgentExecutionType, type AgentExecutionType } from "./agentExecutionType";
import { requireService, type CreateItemOptions, type StoreContext } from "./state";
import {
  acknowledgeTaskUiSlot,
  buildCreatingTaskUiSlot,
  reconcileTaskUiSlots,
  removeTaskUiSlot,
} from "./taskUiSlots";
import type { TasksApi } from "./tasks";
import { recordSelectionIntent } from "./selectionIntent";

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
      requestedWorkflow: opts?.workflowName,
      selectOnCreate: opts?.selectOnCreate,
      selectedAtStart: context.state.selectedItemId.value,
    });

    const creatingSlot = buildCreatingTaskUiSlot({
      slotId,
      repoId,
      prompt: effectivePrompt,
      displayName,
      workflowName: opts?.workflowName,
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
      recordSelectionIntent(context.state);
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
      const resolvedEffort = opts?.customTask?.effort ?? opts?.effort;
      const baseRef = await resolveCreateBaseRef(repoPath, opts);
      if (!baseRef) {
        context.toast.error("No valid base branch selected");
        throw new Error("No valid base branch selected");
      }

      const created = await createDesktopTask({
        requestedTaskId: opts?.requestedTaskId,
        repoId,
        prompt: effectivePrompt,
        displayName,
        workflowName: opts?.workflowName,
        stage: opts?.stage,
        baseRef,
        agent: opts?.customTask?.agent,
        agentProvider: effectiveAgentProvider,
        agentType: effectiveAgentType,
        terminalCols: opts?.terminalCols,
        terminalRows: opts?.terminalRows,
        model: resolvedModel,
        effort: resolvedEffort,
        permissionMode: opts?.customTask?.permissionMode ?? opts?.permissionMode,
        allowedTools: opts?.customTask?.allowedTools ?? opts?.allowedTools,
        disallowedTools: opts?.customTask?.disallowedTools,
        maxTurns: opts?.customTask?.maxTurns,
        maxBudgetUsd: opts?.customTask?.maxBudgetUsd,
        setupCmds: opts?.customTask?.setup,
        resumeSessionId: opts?.resumeSessionId,
        recoverySnapshot: opts?.recoverySnapshot,
        transferImport: opts?.transferImport,
        blockerTaskIds: opts?.blockerTaskIds?.length ? opts.blockerTaskIds : undefined,
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

    if (context.state.items.value.some((candidate) => candidate.id === createdTaskId)) {
      void publishDesktopLanTaskSnapshot(context.requireDb());
    }
    debugLog(`[perf:createItem] server create TOTAL: ${(performance.now() - t0).toFixed(1)}ms`);

    try {
      await invalidateWindowWorkspace("createItem");
    } catch (error) {
      console.error("[store] failed to invalidate workspace after task creation:", error);
    }
    return createdTaskId;
  }

  return { createItem };
}
