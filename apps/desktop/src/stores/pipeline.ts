import { parseAgentDefinition } from "../../../../packages/core/src/pipeline/agent-loader";
import { parsePipelineJson } from "../../../../packages/core/src/pipeline/pipeline-loader";
import type { AgentDefinition, PipelineDefinition } from "../../../../packages/core/src/pipeline/pipeline-types";
import { invoke } from "../invoke";
import { resolveKannaServerBaseUrl } from "./kannaCliEnv";
import { readEnvVarOptional } from "../utils/invokeHelpers";
import { requireService, type AdvanceStageOptions, type StoreContext } from "./state";
import { debugLog } from "../utils/debugLog";

const LOCAL_SERVER_ACTION_TIMEOUT_MS = 30_000;
const LOCAL_SERVER_ACTION_RETRY_DELAY_MS = 250;

export interface PipelineApi {
  loadPipeline: (repoPath: string, pipelineName: string) => Promise<PipelineDefinition>;
  loadAgent: (repoPath: string, agentName: string) => Promise<AgentDefinition>;
  advanceStage: (taskId: string, options?: AdvanceStageOptions) => Promise<void>;
  rerunStage: (taskId: string) => Promise<void>;
}

export function createPipelineApi(context: StoreContext): PipelineApi {
  interface TaskActionResponse {
    taskId: string;
    followTask?: boolean;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function resolveLocalServerBaseUrl(): Promise<string> {
    const deadline = Date.now() + LOCAL_SERVER_ACTION_TIMEOUT_MS;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        await invoke("ensure_mobile_server");
        const port = await readEnvVarOptional("KANNA_MOBILE_SERVER_PORT");
        return resolveKannaServerBaseUrl(port);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("another kanna-server is already starting")) {
          throw error;
        }
        await sleep(LOCAL_SERVER_ACTION_RETRY_DELAY_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "kanna-server did not become ready"));
  }

  async function postTaskAction(taskId: string, action: "advance-stage" | "rerun-stage"): Promise<Response> {
    const serverBaseUrl = await resolveLocalServerBaseUrl();
    const url = `${serverBaseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/${action}`;
    const deadline = Date.now() + LOCAL_SERVER_ACTION_TIMEOUT_MS;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      try {
        return await fetch(url, { method: "POST" });
      } catch (error) {
        lastError = error;
        await sleep(LOCAL_SERVER_ACTION_RETRY_DELAY_MS);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? `failed to call ${action}`));
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
        debugLog("[pipeline:advanceStage] restoring selection", {
          targetItemId: itemId,
          targetStage: item.stage,
          targetBranch: item.branch,
          selectedBefore: context.state.selectedItemId.value,
        });
        await requireService(context.services.selectItem, "selectItem")(itemId);
        return;
      }
    }

    debugLog("[pipeline:advanceStage] clearing selection during restore", {
      requestedItemId: itemId,
      selectedBefore: context.state.selectedItemId.value,
    });
    context.state.selectedItemId.value = null;
  }

  async function loadPipeline(repoPath: string, pipelineName: string): Promise<PipelineDefinition> {
    const cacheKey = `${repoPath}::${pipelineName}`;
    const cached = context.state.pipelineCache.get(cacheKey);
    if (cached) return cached;

    let pipeline: PipelineDefinition;
    try {
      const path = `${repoPath}/.kanna/pipelines/${pipelineName}.json`;
      const content = await invoke<string>("read_text_file", { path });
      pipeline = parsePipelineJson(content);
    } catch (error) {
      console.debug(`[pipeline] failed to load pipeline "${pipelineName}" from repo; trying bundled resource:`, error);
      try {
        const content = await invoke<string>("read_builtin_resource", {
          relativePath: `.kanna/pipelines/${pipelineName}.json`,
        });
        pipeline = parsePipelineJson(content);
      } catch (error) {
        throw new Error(
          `Pipeline "${pipelineName}" not found: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        );
      }
    }

    context.state.pipelineCache.set(cacheKey, pipeline);
    return pipeline;
  }

  async function loadAgent(repoPath: string, agentName: string): Promise<AgentDefinition> {
    const cacheKey = `${repoPath}::${agentName}`;
    const cached = context.state.agentCache.get(cacheKey);
    if (cached) return cached;

    let agent: AgentDefinition;
    try {
      const path = `${repoPath}/.kanna/agents/${agentName}/AGENT.md`;
      const content = await invoke<string>("read_text_file", { path });
      agent = parseAgentDefinition(content);
    } catch (error) {
      console.debug(`[pipeline] failed to load agent "${agentName}" from repo; trying bundled resource:`, error);
      try {
        const content = await invoke<string>("read_builtin_resource", {
          relativePath: `.kanna/agents/${agentName}/AGENT.md`,
        });
        agent = parseAgentDefinition(content);
      } catch (error) {
        throw new Error(
          `Agent "${agentName}" not found on disk or in bundled resources: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        );
      }
    }

    context.state.agentCache.set(cacheKey, agent);
    return agent;
  }

  async function advanceStage(taskId: string, options: AdvanceStageOptions = {}): Promise<void> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) return;
    if (item.closed_at != null) return;
    const sourceTaskIsSelected = context.state.selectedItemId.value === item.id;
    const fallbackSelectionId = computeNextVisibleItemId(item.id);
    debugLog("[pipeline:advanceStage] selection policy", {
      taskId,
      currentStage: item.stage,
      initiatedBy: options.initiatedBy ?? "manual",
      sourceTaskIsSelected,
      fallbackSelectionId,
      selectedBefore: context.state.selectedItemId.value,
    });

    try {
      const response = await postTaskAction(taskId, "advance-stage");
      if (!response.ok) {
        const message = await response.text();
        if (response.status === 409) {
          context.toast.warning(context.tt("mainPanel.taskBlocked"));
          return;
        }
        throw new Error(message);
      }
      const result = await response.json() as TaskActionResponse;
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();

      // Durable tasks: an in-pipeline advance transitions the SAME task in
      // place, so the user's selection stays put. Only when the advance
      // closed the task (final stage) does selection move to the next
      // visible item — analogous to closing a task.
      const advancedItem = context.state.items.value.find((candidate) => candidate.id === result.taskId);
      const taskClosed = !advancedItem || advancedItem.closed_at != null;
      if (taskClosed && sourceTaskIsSelected) {
        await restoreStageAdvanceSelection(fallbackSelectionId);
      }
    } catch (error) {
      console.error("[store] advanceStage: server action failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function rerunStage(taskId: string): Promise<void> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) return;
    if (item.closed_at != null) return;

    try {
      const response = await postTaskAction(taskId, "rerun-stage");
      if (!response.ok) {
        throw new Error(await response.text());
      }
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
    } catch (error) {
      console.error("[store] rerunStage: server action failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
    }
  }

  return {
    loadPipeline,
    loadAgent,
    advanceStage,
    rerunStage,
  };
}
