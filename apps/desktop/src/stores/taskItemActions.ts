import { type AgentProvider, type PipelineItem } from "@kanna/db";
import { invoke } from "../invoke";
import { createDesktopTask } from "../services/desktopServerClient";
import { publishDesktopTaskSnapshot } from "../services/desktopCloudPublisher";
import { publishDesktopLanTaskSnapshot } from "../services/desktopLanTaskIndex";
import { debugLog } from "../utils/debugLog";
import { resolveRealE2eAgentOverride } from "./e2eRealAgentOverride";
import { buildPendingTaskPlaceholder } from "./taskCreationPlaceholder";
import { resolveInitialBaseRef } from "./taskBaseBranch";
import { normalizeAgentExecutionType, type AgentExecutionType } from "./agentExecutionType";
import { requireService, type CreateItemOptions, type KannaSnapshot, type StoreContext } from "./state";
import { showCloudPublishErrorToast } from "./taskPublishing";
import type { TasksApi } from "./tasks";

export function createTaskItemActions(
  context: StoreContext,
): Pick<TasksApi, "createItem"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };
  const withOptimisticItemOverlay = <T>(input: Parameters<NonNullable<StoreContext["services"]["withOptimisticItemOverlay"]>>[0]) =>
    requireService(context.services.withOptimisticItemOverlay, "withOptimisticItemOverlay")(input) as Promise<T>;

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
    const placeholderId = crypto.randomUUID().slice(0, 8);
    const effectivePrompt = opts?.customTask?.prompt ?? prompt;
    const effectiveAgentType = normalizeAgentExecutionType(opts?.customTask?.executionMode ?? agentType);
    const customTaskAgentProvider = opts?.customTask?.agentProvider;
    const requestedAgentProviders = customTaskAgentProvider ?? opts?.agentProvider;
    const requestedModel = opts?.customTask?.model ?? opts?.model;
    const displayName = opts?.customTask?.name ?? opts?.displayName ?? null;
    debugLog("[tasks:createItem] server create start", {
      placeholderId,
      repoId,
      agentType: effectiveAgentType,
      requestedPipeline: opts?.pipelineName,
      selectOnCreate: opts?.selectOnCreate,
      selectedAtStart: context.state.selectedItemId.value,
    });

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

    const pendingPlaceholder = buildPendingTaskPlaceholder({
      id: placeholderId,
      repoId,
      prompt: effectivePrompt,
      branch: `task-${placeholderId}`,
      agentType: effectiveAgentType,
      requestedAgentProviders,
      pipelineName: opts?.pipelineName,
      displayName,
    });
    context.state.pendingSetupIds.value = [...context.state.pendingSetupIds.value, placeholderId];
    context.state.pendingCreateVisibility.set(placeholderId, { bumpAt: performance.now() });

    const removePendingPlaceholder = () => {
      context.state.pendingSetupIds.value = context.state.pendingSetupIds.value.filter((pendingId) => pendingId !== placeholderId);
      context.state.pendingCreateVisibility.delete(placeholderId);
    };
    const applyPendingPlaceholderOverlay = (snapshot: KannaSnapshot): KannaSnapshot => ({
      ...snapshot,
      entries: snapshot.entries.map((entry) =>
        entry.repo.id === repoId
          ? {
              ...entry,
              items: [pendingPlaceholder, ...entry.items.filter((item) => item.id !== placeholderId)],
            }
          : entry,
      ),
    });
    const selectPendingPlaceholder = () => {
      if (opts?.selectOnCreate === false) return;
      context.state.selectedRepoId.value = repoId;
      context.state.selectedItemId.value = placeholderId;
      context.state.lastSelectedItemByRepo.value = {
        ...context.state.lastSelectedItemByRepo.value,
        [repoId]: placeholderId,
      };
    };
    const selectReplacementAfterPendingRemoval = async () => {
      if (context.state.selectedItemId.value !== placeholderId) return;
      await requireService(context.services.selectReplacementAfterItemRemoval, "selectReplacementAfterItemRemoval")(pendingPlaceholder);
    };

    let createdTaskId = placeholderId;
    try {
      await withOptimisticItemOverlay<void>({
        key: `create:immediate:${placeholderId}`,
        apply: applyPendingPlaceholderOverlay,
        run: async () => {
          selectPendingPlaceholder();
          const created = await createDesktopTask({
            repoId,
            prompt: effectivePrompt,
            displayName,
            pipelineName: opts?.pipelineName,
            baseRef,
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
          removePendingPlaceholder();
          await reloadSnapshot();
          if (opts?.selectOnCreate !== false) {
            await requireService(context.services.selectItem, "selectItem")(createdTaskId);
          }
          const createdItem = context.state.items.value.find((candidate) => candidate.id === createdTaskId);
          const createdRepo = context.state.repos.value.find((candidate) => candidate.id === repoId) ?? null;
          if (createdItem) {
            void publishDesktopLanTaskSnapshot(context.requireDb());
            publishCreatedTaskSnapshot(createdTaskId, createdItem, createdRepo);
          }
          debugLog(`[perf:createItem] server create TOTAL: ${(performance.now() - t0).toFixed(1)}ms`);
        },
        reconcile: reloadSnapshot,
      });
    } catch (error) {
      removePendingPlaceholder();
      await selectReplacementAfterPendingRemoval();
      throw error;
    }
    await invalidateWindowWorkspace("createItem");
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
