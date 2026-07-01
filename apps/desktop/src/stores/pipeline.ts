import { parseAgentDefinition } from "../../../../packages/core/src/pipeline/agent-loader";
import { parsePipelineJson } from "../../../../packages/core/src/pipeline/pipeline-loader";
import { buildStagePrompt } from "../../../../packages/core/src/pipeline/prompt-builder";
import { getNextStage } from "../../../../packages/core/src/pipeline/types";
import type { AgentDefinition, PipelineDefinition, PipelinePostAction } from "../../../../packages/core/src/pipeline/pipeline-types";
import { clearPipelineItemActivePostAction, clearPipelineItemStageResult, getRepo, updatePipelineItemActivePostAction, updatePipelineItemStage } from "@kanna/db";
import { invoke } from "../invoke";
import { resolveCurrentKannaServerBaseUrl } from "../services/kannaServerBaseUrl";
import { buildTaskRuntimeEnv } from "./kannaCliEnv";
import { encodeAgentStageInputChunks } from "./daemonInput";
import {
  getPreferredAgentProviders,
  resolveAgentProvider,
} from "./agent-provider";
import { requireService, type AdvanceStageOptions, type StoreContext } from "./state";
import { debugLog } from "../utils/debugLog";
import { normalizeAgentExecutionType } from "./agentExecutionType";

const CODEX_STAGE_SUBMIT_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PipelineApi {
  loadPipeline: (repoPath: string, pipelineName: string) => Promise<PipelineDefinition>;
  loadAgent: (repoPath: string, agentName: string) => Promise<AgentDefinition>;
  advanceStage: (taskId: string, options?: AdvanceStageOptions) => Promise<void>;
  rerunStage: (taskId: string) => Promise<void>;
}

export function createPipelineApi(context: StoreContext): PipelineApi {
  interface DaemonSessionInfo {
    session_id?: string;
    state?: unknown;
  }

  function buildWorktreePath(repoPath: string, branch: string): string {
    return `${repoPath}/.kanna-worktrees/${branch}`;
  }

  function resolveSourceWorktree(repoPath: string, branch: string | null | undefined): string | undefined {
    if (!branch) return undefined;
    return buildWorktreePath(repoPath, branch);
  }

  async function resolveCurrentSourceBranch(repoPath: string, storedBranch: string): Promise<string> {
    const worktreePath = buildWorktreePath(repoPath, storedBranch);
    try {
      const currentBranch = await invoke<string | null>("git_current_branch", { repoPath: worktreePath });
      const trimmed = currentBranch?.trim();
      if (trimmed) return trimmed;
    } catch (error) {
      console.warn("[pipeline:advanceStage] failed to resolve current source branch:", error);
    }
    return storedBranch;
  }

  function resolvePriorTaskSourceWorktree(repoPath: string, baseRef: string | null): string | undefined {
    if (!baseRef?.startsWith("task-")) return undefined;
    return buildWorktreePath(repoPath, baseRef);
  }

  function resolveInheritedTaskTitle(item: { display_name: string | null; issue_title: string | null; prompt: string | null }): string | null {
    return item.display_name ?? item.issue_title ?? item.prompt ?? null;
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

  async function hasLiveDaemonSession(taskId: string): Promise<boolean> {
    const sessions = await invoke<DaemonSessionInfo[]>("list_sessions");
    return sessions.some((session) => {
      if (session.session_id !== taskId) return false;
      return session.state === "Active" || session.state === "Suspended";
    });
  }

  async function sendStagePromptToTask(
    item: import("@kanna/db").PipelineItem,
    stagePrompt: string,
    agentProvider: string | null | undefined,
    kittyKeyboard: boolean,
  ): Promise<void> {
    if (normalizeAgentExecutionType(item.agent_type) === "agent") {
      await invoke("send_agent_input", { sessionId: item.id, text: stagePrompt });
      return;
    }

    const inputChunks = encodeAgentStageInputChunks(stagePrompt, { agentProvider, kittyKeyboard });
    for (let index = 0; index < inputChunks.length; index += 1) {
      const data = inputChunks[index];
      if (!data) continue;
      await invoke("send_input", { sessionId: item.id, data });
      if (agentProvider === "codex" && index < inputChunks.length - 1) {
        await delay(CODEX_STAGE_SUBMIT_DELAY_MS);
      }
    }
  }

  async function continueStageInPlace(
    item: import("@kanna/db").PipelineItem,
    repo: import("@kanna/db").Repo,
    nextStageName: string,
    stagePrompt: string,
    agentProvider: string | null | undefined,
    kittyKeyboard: boolean,
  ): Promise<void> {
    const taskId = item.id;
    const previousStageName = item.stage;
    let hasLiveSession = false;
    try {
      hasLiveSession = await hasLiveDaemonSession(taskId);
    } catch (error) {
      console.error("[store] continueStageInPlace: failed to list daemon sessions:", error);
    }

    if (!hasLiveSession && agentProvider === "codex" && item.branch) {
      try {
        await updatePipelineItemStage(context.requireDb(), taskId, nextStageName);
        await clearPipelineItemStageResult(context.requireDb(), taskId);
        await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
        await requireService(context.services.spawnPtySession, "spawnPtySession")(
          taskId,
          buildWorktreePath(repo.path, item.branch),
          stagePrompt,
          80,
          24,
          {
            agentProvider: "codex",
            ...(item.agent_session_id ? { resumeSessionId: item.agent_session_id } : {}),
          },
        );
        await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      } catch (error) {
        await updatePipelineItemStage(context.requireDb(), taskId, previousStageName);
        await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
        context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      }
      return;
    }

    if (!hasLiveSession) {
      context.toast.error(context.tt("toasts.agentStartFailed"));
      return;
    }

    try {
      await updatePipelineItemStage(context.requireDb(), taskId, nextStageName);
      await clearPipelineItemStageResult(context.requireDb(), taskId);
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await sendStagePromptToTask(item, stagePrompt, agentProvider, kittyKeyboard);
    } catch (error) {
      await updatePipelineItemStage(context.requireDb(), taskId, previousStageName);
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function buildPostActionPrompt(
    repoPath: string,
    item: import("@kanna/db").PipelineItem,
    sourceBranch: string,
    sourceWorktree: string | undefined,
    postAction: PipelinePostAction,
  ): Promise<{ prompt: string; agentProvider: import("@kanna/db").AgentProvider }> {
    if (!postAction.agent) {
      return { prompt: "", agentProvider: item.agent_provider };
    }

    const agent = await loadAgent(repoPath, postAction.agent);
    const prompt = buildStagePrompt(agent.prompt, postAction.prompt, {
      taskPrompt: item.prompt ?? "",
      prevResult: item.stage_result ?? undefined,
      branch: sourceBranch,
      baseRef: item.base_ref ?? undefined,
      sourceWorktree,
    });
    const preferredProviders = getPreferredAgentProviders({
      stage: postAction.agent_provider as import("@kanna/db").AgentProvider | import("@kanna/db").AgentProvider[] | undefined,
      agent: agent.agent_provider as import("@kanna/db").AgentProvider | import("@kanna/db").AgentProvider[] | undefined,
      item: item.agent_provider,
    });
    const agentProvider = resolveAgentProvider(
      preferredProviders,
      await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
    );

    return { prompt, agentProvider };
  }

  async function enterPostAction(
    item: import("@kanna/db").PipelineItem,
    postAction: PipelinePostAction,
    stagePrompt: string,
    agentProvider: import("@kanna/db").AgentProvider,
  ): Promise<void> {
    let hasLiveSession = false;
    try {
      hasLiveSession = await hasLiveDaemonSession(item.id);
    } catch (error) {
      console.error("[store] enterPostAction: failed to list daemon sessions:", error);
    }

    if (!hasLiveSession) {
      context.toast.error(context.tt("toasts.agentStartFailed"));
      return;
    }

    try {
      await updatePipelineItemActivePostAction(context.requireDb(), item.id, postAction.name);
      await clearPipelineItemStageResult(context.requireDb(), item.id);
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await sendStagePromptToTask(
        item,
        stagePrompt,
        agentProvider,
        item.agent_provider === "claude" && Boolean(item.prompt),
      );
    } catch (error) {
      await clearPipelineItemActivePostAction(context.requireDb(), item.id);
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
    }
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

  async function reloadPipeline(repoPath: string, pipelineName: string): Promise<PipelineDefinition> {
    context.state.pipelineCache.delete(`${repoPath}::${pipelineName}`);
    return loadPipeline(repoPath, pipelineName);
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

  async function hasUnresolvedBlockers(itemId: string): Promise<boolean> {
    const { listBlockersForItem } = await import("@kanna/db");
    const blockers = await listBlockersForItem(context.requireDb(), itemId);
    return blockers.some((blocker) => blocker.closed_at === null);
  }

  async function advanceStage(taskId: string, options: AdvanceStageOptions = {}): Promise<void> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item?.branch) return;
    if (item.closed_at != null) return;

    const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      ?? await getRepo(context.requireDb(), item.repo_id);
    if (!repo) {
      console.error("[store] advanceStage: repo not found for", taskId);
      return;
    }

    let pipeline: PipelineDefinition;
    try {
      pipeline = await reloadPipeline(repo.path, item.pipeline);
    } catch (error) {
      console.error("[store] advanceStage: pipeline definition not found:", error);
      context.toast.error(context.tt("toasts.pipelineNotFound"));
      return;
    }

    const nextStage = getNextStage(pipeline, item.stage);
    if (!nextStage) {
      await requireService(context.services.closeTask, "closeTask")(item.id);
      return;
    }

    if (await hasUnresolvedBlockers(taskId)) {
      context.toast.warning(context.tt("toasts.taskBlocked"));
      return;
    }

    const shouldFollowTask = nextStage.follow_task ?? (options.initiatedBy !== "auto");
    const sourceTaskIsSelected = context.state.selectedItemId.value === item.id;
    const fallbackSelectionId = computeNextVisibleItemId(item.id);
    debugLog("[pipeline:advanceStage] selection policy", {
      taskId,
      currentStage: item.stage,
      nextStage: nextStage.name,
      followTask: nextStage.follow_task,
      initiatedBy: options.initiatedBy ?? "manual",
      shouldFollowTask,
      sourceTaskIsSelected,
      fallbackSelectionId,
      selectedBefore: context.state.selectedItemId.value,
    });

    let stagePrompt = "";
    let agentOpts: Record<string, unknown> = { agentProvider: item.agent_provider };
    const sourceBranch = await resolveCurrentSourceBranch(repo.path, item.branch);
    const sourceWorktree = resolveSourceWorktree(repo.path, item.branch);
    const currentStage = pipeline.stages.find((stage) => stage.name === item.stage);

    if (!options.skipPostAction && !item.active_post_action && currentStage?.post_action) {
      try {
        const postActionPrompt = await buildPostActionPrompt(
          repo.path,
          item,
          sourceBranch,
          sourceWorktree,
          currentStage.post_action,
        );
        await enterPostAction(item, currentStage.post_action, postActionPrompt.prompt, postActionPrompt.agentProvider);
      } catch (error) {
        console.error("[store] advanceStage: failed to enter post-action:", error);
        context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      }
      return;
    }

    if (nextStage.agent) {
      try {
        const agent = await loadAgent(repo.path, nextStage.agent);
        const prevResult = item.stage_result ?? undefined;
        stagePrompt = buildStagePrompt(agent.prompt, nextStage.prompt, {
          taskPrompt: item.prompt ?? "",
          prevResult,
          branch: sourceBranch,
          baseRef: item.base_ref ?? undefined,
          sourceWorktree,
        });

        const preferredProviders = getPreferredAgentProviders({
          stage: nextStage.agent_provider as import("@kanna/db").AgentProvider | import("@kanna/db").AgentProvider[] | undefined,
          agent: agent.agent_provider as import("@kanna/db").AgentProvider | import("@kanna/db").AgentProvider[] | undefined,
          item: item.agent_provider,
        });
        const resolvedProvider = resolveAgentProvider(
          preferredProviders,
          await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
        );

        agentOpts = {
          agentProvider: resolvedProvider,
          model: agent.model,
          permissionMode: agent.permission_mode,
          allowedTools: agent.allowed_tools,
        };
      } catch (error) {
        console.error("[store] advanceStage: failed to load agent:", error);
        context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
        return;
      }
    }

    if (nextStage.mode === "continue") {
      await continueStageInPlace(
        item,
        repo,
        nextStage.name,
        stagePrompt,
        item.agent_provider,
        item.agent_provider === "claude" && Boolean(item.prompt),
      );
      return;
    }

    if (sourceTaskIsSelected) {
      await restoreStageAdvanceSelection(fallbackSelectionId);
    }

    debugLog("[pipeline:advanceStage] closing source task", {
      taskId: item.id,
      selectedBeforeClose: context.state.selectedItemId.value,
    });
    await requireService(context.services.closeTask, "closeTask")(item.id, { selectNext: false });
    debugLog("[pipeline:advanceStage] creating next-stage task", {
      taskId: item.id,
      nextStage: nextStage.name,
      selectOnCreate: shouldFollowTask,
      selectedBeforeCreate: context.state.selectedItemId.value,
    });
    const nextAgentType = normalizeAgentExecutionType(item.agent_type);
    const createdItemId = await requireService(context.services.createItem, "createItem")(
      repo.id,
      repo.path,
      stagePrompt,
      nextAgentType,
      {
        baseBranch: sourceBranch,
        baseRef: item.base_ref ?? sourceBranch,
        pipelineName: item.pipeline,
        stage: nextStage.name,
        selectOnCreate: shouldFollowTask,
        displayName: resolveInheritedTaskTitle(item),
        ...agentOpts,
      },
    );
    debugLog("[pipeline:advanceStage] created next-stage task", {
      taskId: item.id,
      createdItemId,
      nextStage: nextStage.name,
      selectOnCreate: shouldFollowTask,
      selectedAfterCreate: context.state.selectedItemId.value,
    });
  }

  function parseTaskPortEnv(portEnv: string | null): Record<string, string> | undefined {
    if (!portEnv) return undefined;
    return JSON.parse(portEnv) as Record<string, string>;
  }

  async function rerunStage(taskId: string): Promise<void> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) return;
    if (!item.branch) return;

    const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      ?? await getRepo(context.requireDb(), item.repo_id);
    if (!repo) return;

    let pipeline: PipelineDefinition;
    try {
      pipeline = await reloadPipeline(repo.path, item.pipeline);
    } catch (error) {
      console.error("[store] rerunStage: pipeline not found:", error);
      context.toast.error(context.tt("toasts.pipelineNotFound"));
      return;
    }

    const currentStage = pipeline.stages.find((stage) => stage.name === item.stage);
    if (!currentStage) {
      console.error("[store] rerunStage: stage not found:", item.stage);
      context.toast.error(context.tt("toasts.stageNotFound"));
      return;
    }
    const activePostAction = item.active_post_action
      ? currentStage.post_action?.name === item.active_post_action
        ? currentStage.post_action
        : null
      : null;
    const execution = activePostAction ?? currentStage;

    await clearPipelineItemStageResult(context.requireDb(), taskId);

    if (currentStage.environment) {
      const env = pipeline.environments?.[currentStage.environment];
      if (env?.setup?.length) {
        const worktreePath = buildWorktreePath(repo.path, item.branch);
        try {
          const portEnv = parseTaskPortEnv(item.port_env);
          const inheritedPath = await invoke<string>("read_env_var", { name: "PATH" }).catch((error) => {
            console.debug("[pipeline] PATH not available while building setup env:", error);
            return null;
          });
          const scriptEnv = buildTaskRuntimeEnv({
            taskId,
            socketPath: await invoke<string>("get_pipeline_socket_path"),
            serverBaseUrl: await resolveCurrentKannaServerBaseUrl("building setup env"),
            portEnv,
            kannaCliPath: await invoke<string>("which_binary", { name: "kanna-cli" }).catch((error) => {
              console.debug("[pipeline] kanna-cli not available while building setup env:", error);
              return null;
            }),
            path: inheritedPath,
          });
          for (const script of env.setup) {
            await invoke("run_script", { script, cwd: worktreePath, env: scriptEnv });
          }
        } catch (error) {
          console.error("[store] rerunStage: setup script failed:", error);
          context.toast.error(context.tt("toasts.stageSetupFailed"));
          return;
        }
      }
    }

    if (execution.agent) {
      try {
        const agent = await loadAgent(repo.path, execution.agent);
        const stagePrompt = buildStagePrompt(agent.prompt, execution.prompt, {
          taskPrompt: item.prompt ?? "",
          branch: item.branch ?? undefined,
          baseRef: item.base_ref ?? undefined,
          sourceWorktree: resolvePriorTaskSourceWorktree(repo.path, item.base_ref),
        });
        const worktreePath = buildWorktreePath(repo.path, item.branch);
        const preferredProviders = getPreferredAgentProviders({
          stage: execution.agent_provider as import("@kanna/db").AgentProvider | import("@kanna/db").AgentProvider[] | undefined,
          agent: agent.agent_provider as import("@kanna/db").AgentProvider | import("@kanna/db").AgentProvider[] | undefined,
          item: item.agent_provider,
        });
        const agentProvider = resolveAgentProvider(
          preferredProviders,
          await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
        );

        await invoke("kill_session", { sessionId: taskId }).catch((error: unknown) =>
          console.error("[store] kill_session before rerun failed:", error),
        );

        await requireService(context.services.spawnPtySession, "spawnPtySession")(taskId, worktreePath, stagePrompt, 80, 24, {
          agentProvider,
          model: agent.model,
          permissionMode: agent.permission_mode,
          allowedTools: agent.allowed_tools,
        });
      } catch (error) {
        console.error("[store] rerunStage: agent spawn failed:", error);
        context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      }
    }

    await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  }

  return {
    loadPipeline,
    loadAgent,
    advanceStage,
    rerunStage,
  };
}
