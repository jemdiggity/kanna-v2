import { type AgentProvider, type PipelineItem } from "@kanna/db";
import { invoke } from "../invoke";
import { createDesktopTask, fetchClosedTaskIdentities } from "../services/desktopServerClient";
import { publishDesktopLanTaskSnapshot } from "../services/desktopLanTaskIndex";
import { debugLog } from "../utils/debugLog";
import { resolveRealE2eAgentOverride } from "./e2eRealAgentOverride";
import {
  buildInitializingTaskItem,
  initializeTaskItem,
  removeInitializingTaskItem,
} from "./taskInitialization";
import { resolveInitialBaseRef } from "./taskBaseBranch";
import { normalizeAgentExecutionType, type AgentExecutionType } from "./agentExecutionType";
import { requireService, type CreateItemOptions, type StoreContext } from "./state";
import type { TasksApi } from "./tasks";

const CREATE_SNAPSHOT_RETRY_DELAYS_MS = [50, 150] as const;
const CREATE_BACKGROUND_SNAPSHOT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000] as const;

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createTaskItemActions(
  context: StoreContext,
): Pick<TasksApi, "createItem"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const persistSelection = () => requireService(context.services.persistSelection, "persistSelection")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

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
    const initializingItemId = `create:${crypto.randomUUID()}`;
    const effectivePrompt = opts?.customTask?.prompt ?? prompt;
    const effectiveAgentType = normalizeAgentExecutionType(opts?.customTask?.executionMode ?? agentType);
    const customTaskAgentProvider = opts?.customTask?.agentProvider;
    const requestedAgentProviders = customTaskAgentProvider ?? opts?.agentProvider;
    const requestedModel = opts?.customTask?.model ?? opts?.model;
    const displayName = opts?.customTask?.name ?? opts?.displayName ?? null;
    debugLog("[tasks:createItem] server create start", {
      initializingItemId,
      repoId,
      agentType: effectiveAgentType,
      requestedPipeline: opts?.pipelineName,
      selectOnCreate: opts?.selectOnCreate,
      selectedAtStart: context.state.selectedItemId.value,
    });

    const initializingItem = buildInitializingTaskItem({
      id: initializingItemId,
      repoId,
      prompt: effectivePrompt,
      agentType: effectiveAgentType,
      requestedAgentProviders,
      pipelineName: opts?.pipelineName,
      stage: opts?.stage,
      displayName,
    });
    context.state.initializingTaskItems.value = [
      initializingItem,
      ...context.state.initializingTaskItems.value.filter(
        (candidate) => candidate.id !== initializingItemId,
      ),
    ];
    context.state.pendingCreateVisibility.set(initializingItemId, { bumpAt: performance.now() });

    const removeInitializingItem = () => {
      context.state.initializingTaskItems.value = removeInitializingTaskItem(
        context.state.initializingTaskItems.value,
        initializingItemId,
      );
      context.state.pendingCreateVisibility.delete(initializingItemId);
    };
    const replaceRememberedInitializingItem = (
      taskId: string | null,
      expectedItemId = initializingItemId,
    ) => {
      if (context.state.lastSelectedItemByRepo.value[repoId] !== expectedItemId) return;
      const next = { ...context.state.lastSelectedItemByRepo.value };
      if (taskId) {
        next[repoId] = taskId;
      } else {
        delete next[repoId];
      }
      context.state.lastSelectedItemByRepo.value = next;
    };
    const selectInitializingItem = () => {
      if (opts?.selectOnCreate === false) return;
      context.state.selectedRepoId.value = repoId;
      context.state.selectedItemId.value = initializingItemId;
      context.state.lastSelectedItemByRepo.value = {
        ...context.state.lastSelectedItemByRepo.value,
        [repoId]: initializingItemId,
      };
    };
    const selectReplacementAfterInitializationFailure = async () => {
      if (context.state.selectedItemId.value !== initializingItemId) return;
      await requireService(
        context.services.selectReplacementAfterItemRemoval,
        "selectReplacementAfterItemRemoval",
      )(initializingItem);
    };

    selectInitializingItem();
    if (opts?.selectOnCreate !== false) {
      void persistSelection().catch((error) => {
        console.error("[store] failed to persist initializing task selection:", error);
      });
    }

    let createdTaskId: string;
    try {
      const realE2eAgentOverride = await resolveRealE2eAgentOverride({
        agentType: effectiveAgentType,
        explicitAgentProvider: requestedAgentProviders,
        explicitModel: requestedModel,
      });
      const effectiveAgentProvider = (
        customTaskAgentProvider
        ?? realE2eAgentOverride?.agentProvider
        ?? requestedAgentProviders
      ) as AgentProvider | undefined;
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
      replaceRememberedInitializingItem(null);
      removeInitializingItem();
      try {
        await selectReplacementAfterInitializationFailure();
      } catch (cleanupError) {
        console.error("[store] failed to persist selection after task creation failure:", cleanupError);
      }
      throw error;
    }

    const visibility = context.state.pendingCreateVisibility.get(initializingItemId);
    context.state.pendingCreateVisibility.delete(initializingItemId);
    if (visibility) {
      context.state.pendingCreateVisibility.set(createdTaskId, visibility);
    }
    context.state.initializingTaskItems.value = initializeTaskItem(
      context.state.initializingTaskItems.value,
      initializingItemId,
      createdTaskId,
    );
    if (context.state.selectedItemId.value === initializingItemId) {
      void persistSelection().catch((error) => {
        console.error("[store] failed to persist acknowledged task selection:", error);
      });
    }

    let createdItem: PipelineItem | null = null;
    let publishedCreatedTask = false;
    const handoffHydratedCreatedTask = async (): Promise<PipelineItem | null> => {
      const hydratedItem = context.state.items.value.find(
        (candidate) => candidate.id === createdTaskId,
      ) ?? null;
      if (!hydratedItem) return null;

      const liveInitializingItem = context.state.initializingTaskItems.value.find(
        (candidate) => candidate.id === initializingItemId,
      );
      if (liveInitializingItem) {
        const wasSelected = context.state.selectedItemId.value === initializingItemId;
        if (context.state.lastSelectedItemByRepo.value[repoId] === initializingItemId) {
          context.state.lastSelectedItemByRepo.value = {
            ...context.state.lastSelectedItemByRepo.value,
            [repoId]: createdTaskId,
          };
        }
        if (wasSelected) {
          context.state.selectedItemId.value = createdTaskId;
          context.state.lastSelectedItemByRepo.value = {
            ...context.state.lastSelectedItemByRepo.value,
            [repoId]: createdTaskId,
          };
        }
        removeInitializingItem();

        const selectItem = context.services.selectItem;
        if (wasSelected && selectItem) {
          try {
            await selectItem(createdTaskId, { previousItemId: initializingItemId });
          } catch (error) {
            console.error("[store] failed to persist created task selection:", error);
          }
        }
      }

      context.state.pendingCreateVisibility.delete(createdTaskId);
      return hydratedItem;
    };
    const publishHydratedCreatedTask = () => {
      if (publishedCreatedTask) return;
      publishedCreatedTask = true;
      void publishDesktopLanTaskSnapshot(context.requireDb());
    };
    const isCreatedTaskReconciliationLive = () => context.state.initializingTaskItems.value.some(
      (candidate) => candidate.id === initializingItemId && candidate.taskId === createdTaskId,
    );
    const stopReconciliationIfTaskClosed = async (): Promise<boolean> => {
      let taskIsClosed = false;
      try {
        taskIsClosed = (await fetchClosedTaskIdentities()).some(
          (candidate) => candidate.id === createdTaskId,
        );
      } catch (error) {
        console.error("[store] failed to check created task closure during reconciliation:", error);
        return false;
      }
      if (!taskIsClosed) return false;

      context.state.pendingCreateVisibility.delete(createdTaskId);
      replaceRememberedInitializingItem(null);
      removeInitializingItem();
      try {
        await selectReplacementAfterInitializationFailure();
      } catch (error) {
        console.error("[store] failed to persist selection after reconciled task closure:", error);
      }
      return true;
    };

    for (let attempt = 0; attempt <= CREATE_SNAPSHOT_RETRY_DELAYS_MS.length; attempt += 1) {
      createdItem = await handoffHydratedCreatedTask();
      if (createdItem || !isCreatedTaskReconciliationLive()) break;

      let reloadWasSuperseded = false;
      try {
        const reloadResult = await reloadSnapshot();
        reloadWasSuperseded = reloadResult?.status === "superseded";
      } catch (error) {
        // The create request already committed the durable task and session.
        // Retain the initialized UI row while bounded retries recover a
        // transient snapshot failure without inviting a duplicate task.
        console.error("[store] failed to hydrate created task snapshot:", error);
      }

      createdItem = await handoffHydratedCreatedTask();
      if (createdItem || reloadWasSuperseded || !isCreatedTaskReconciliationLive()) break;

      const retryDelay = CREATE_SNAPSHOT_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) break;
      await sleep(retryDelay);
    }

    if (createdItem) {
      publishHydratedCreatedTask();
    } else {
      const continueCreatedTaskReconciliation = async () => {
        let retryIndex = 0;
        while (true) {
          const alreadyHydrated = await handoffHydratedCreatedTask();
          if (alreadyHydrated) {
            publishHydratedCreatedTask();
            return;
          }
          if (!isCreatedTaskReconciliationLive()) return;

          const retryDelay = CREATE_BACKGROUND_SNAPSHOT_RETRY_DELAYS_MS[
            Math.min(retryIndex, CREATE_BACKGROUND_SNAPSHOT_RETRY_DELAYS_MS.length - 1)
          ];
          await sleep(retryDelay);
          retryIndex += 1;

          const hydratedAfterSleep = await handoffHydratedCreatedTask();
          if (hydratedAfterSleep) {
            publishHydratedCreatedTask();
            return;
          }
          if (!isCreatedTaskReconciliationLive()) return;

          let reloadApplied = false;
          try {
            const reloadResult = await reloadSnapshot();
            reloadApplied = reloadResult?.status !== "superseded";
          } catch (error) {
            console.error("[store] background created task snapshot retry failed:", error);
          }

          const hydratedAfterReload = await handoffHydratedCreatedTask();
          if (hydratedAfterReload) {
            publishHydratedCreatedTask();
            return;
          }
          if (!isCreatedTaskReconciliationLive()) return;
          if (reloadApplied && await stopReconciliationIfTaskClosed()) return;
        }
      };
      void continueCreatedTaskReconciliation().catch((error) => {
        console.error("[store] created task reconciliation stopped unexpectedly:", error);
      });
    }

    debugLog(`[perf:createItem] server create TOTAL: ${(performance.now() - t0).toFixed(1)}ms`);
    try {
      await invalidateWindowWorkspace("createItem");
    } catch (error) {
      console.error("[store] failed to invalidate windows after task creation:", error);
    }
    return createdTaskId;
  }

  return { createItem };
}
