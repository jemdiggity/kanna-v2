import { type RepoConfig } from "@kanna/core";
import {
  insertPipelineItem,
  insertWorktree,
  updateAgentSessionId,
  updatePipelineItemActivity,
  upsertTerminalSession,
  type AgentProvider,
} from "@kanna/db";
import { buildKannaRuntimeSystemPrompt, buildStagePrompt } from "../../../../packages/core/src/pipeline/prompt-builder";
import { invoke } from "../invoke";
import { publishDesktopTaskSnapshot } from "../services/desktopCloudPublisher";
import { publishDesktopLanTaskSnapshot } from "../services/desktopLanTaskIndex";
import { buildTaskShellCommand } from "../composables/terminalSessionRecovery";
import { buildTaskBootstrapCommand } from "../utils/taskBootstrap";
import { debugLog } from "../utils/debugLog";
import { getPreferredAgentProviders, resolveAgentProvider } from "./agent-provider";
import { resolveRealE2eAgentOverride } from "./e2eRealAgentOverride";
import { buildPendingTaskPlaceholder } from "./taskCreationPlaceholder";
import { shouldPrewarmTaskShellOnCreate } from "./taskShellPrewarm";
import { getCreateWorktreeStartPoint, getOriginFetchBranch, resolveInitialBaseRef } from "./taskBaseBranch";
import { buildTaskLifecycleEnv } from "./taskLifecycleEnv";
import { encodeDaemonInput } from "./daemonInput";
import { normalizeAgentExecutionType, type AgentExecutionType } from "./agentExecutionType";
import { reportPrewarmSessionError } from "./kannaCleanup";
import { showCloudPublishErrorToast } from "./taskPublishing";
import { readRepoConfig, requireService, type AgentSpawnRecoveryOptions, type CreateItemOptions, type StoreContext, type WorktreeBootstrapResult } from "./state";
import type { PortsStore } from "./ports";
import type { TasksApi } from "./tasks";

const CODEX_SPAWN_SUBMIT_DELAY_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTaskItemActions(
  context: StoreContext,
  ports: PortsStore,
): Pick<TasksApi, "createItem"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };
  const withOptimisticItemOverlay = <T>(input: Parameters<NonNullable<StoreContext["services"]["withOptimisticItemOverlay"]>>[0]) =>
    requireService(context.services.withOptimisticItemOverlay, "withOptimisticItemOverlay")(input) as Promise<T>;

  async function createWorktree(
    repoPath: string,
    branch: string,
    worktreePath: string,
    baseRef?: string | null,
  ): Promise<WorktreeBootstrapResult> {
    const visibleBootstrapSteps: string[] = [];
    let startPoint = getCreateWorktreeStartPoint(baseRef ?? undefined);
    let renderedStartPoint = startPoint ?? "HEAD";
    const originFetchBranch = getOriginFetchBranch(startPoint);

    if (originFetchBranch) {
      renderedStartPoint = startPoint ?? renderedStartPoint;
      visibleBootstrapSteps.push(`git fetch origin ${originFetchBranch}`);
      try {
        await invoke("git_fetch", { repoPath, branch: originFetchBranch });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[store] fetch origin failed:", message);
        context.toast.warning(context.tt("toasts.fetchFailed"));
      }
    } else if (!startPoint) {
      try {
        const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
        renderedStartPoint = defaultBranch;
        visibleBootstrapSteps.push(`git fetch origin ${defaultBranch}`);
        await invoke("git_fetch", { repoPath, branch: defaultBranch });
        startPoint = `origin/${defaultBranch}`;
        renderedStartPoint = startPoint;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isOffline = /could not resolve host|network is unreachable|connection refused|timed out/i.test(message);
        const noRemote = /does not appear to be a git repository|could not find remote|no remote|remote.*not found/i.test(message);
        if (isOffline || noRemote) {
          console.debug("[store] fetch origin failed (offline or no remote), using local HEAD");
        } else {
          console.warn("[store] fetch origin failed:", message);
          context.toast.warning(context.tt("toasts.fetchFailed"));
        }
      }
    }

    await invoke("git_worktree_add", {
      repoPath,
      branch,
      path: worktreePath,
      startPoint,
    });

    visibleBootstrapSteps.push(
      `git worktree add -b ${branch} '${worktreePath.replace(/'/g, `'\\''`)}' ${renderedStartPoint}`,
    );

    return { visibleBootstrapSteps };
  }

  async function setupWorktreeAndSpawn(
    id: string,
    repoId: string,
    repoPath: string,
    worktreePath: string,
    branch: string,
    prompt: string,
    agentType: AgentExecutionType,
    agentProvider: AgentProvider,
    opts?: CreateItemOptions,
  ) {
    const s0 = performance.now();
    const resolvedModel = opts?.customTask?.model ?? opts?.model ?? null;
    let worktreeCreated = false;
    const markSetupFailed = async (error: unknown, logPrefix: string, toastMessage: string) => {
      await Promise.allSettled([
        invoke("kill_session", { sessionId: id }),
        invoke("kill_session", { sessionId: `shell-wt-${id}` }),
      ]);
      await ports.releaseTaskPorts(id).catch((cleanupError) => {
        console.debug("[store] failed to release ports after task setup failure:", cleanupError);
      });
      if (worktreeCreated) {
        await invoke("git_worktree_remove", { repoPath, path: worktreePath }).catch((cleanupError) => {
          console.debug("[store] failed to remove worktree after task setup failure:", cleanupError);
        });
      }
      await context.requireDb().execute("DELETE FROM pipeline_item WHERE id = ?", [id]).catch((cleanupError) => {
        console.debug("[store] failed to delete partially-created task after setup failure:", cleanupError);
        return updatePipelineItemActivity(context.requireDb(), id, "idle");
      });
      await reloadSnapshot();
      console.error(logPrefix, error);
      context.toast.error(toastMessage);
    };
    const finishPendingSetup = () => {
      context.state.pendingSetupIds.value = context.state.pendingSetupIds.value.filter((pendingId) => pendingId !== id);
      context.state.pendingCreateVisibility.delete(id);
    };

    try {
      let s1 = performance.now();
      let worktreeBootstrap: WorktreeBootstrapResult | null = null;
      let repoConfig: RepoConfig = {};
      let portEnv: Record<string, string> = {};
      let ptySetupCmds: string[] = [];
      try {
        worktreeBootstrap = await createWorktree(repoPath, branch, worktreePath, opts?.baseBranch ?? opts?.baseRef ?? null);
        worktreeCreated = true;
        await insertWorktree(context.requireDb(), {
          id: `wt-${id}`,
          pipeline_item_id: id,
          path: worktreePath,
          branch,
        });
        repoConfig = await readRepoConfig(worktreePath);
        ptySetupCmds = repoConfig.setup || [];
      } catch (error) {
        await markSetupFailed(error, "[store] failed to read repo config or create worktree:", context.tt("toasts.worktreeFailed"));
        return;
      }
      debugLog(`[perf:setup] readConfig+createWorktree: ${(performance.now() - s1).toFixed(1)}ms`);

      s1 = performance.now();
      try {
        const allocated = await ports.claimTaskPorts(id, repoConfig);
        portEnv = allocated.portEnv;
        const portOffset = allocated.firstPort;
        await context.requireDb().execute(
          "UPDATE pipeline_item SET port_offset = ?, port_env = ?, updated_at = datetime('now') WHERE id = ?",
          [portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, id],
        );
        await reloadSnapshot();
      } catch (error) {
        await markSetupFailed(error, "[store] task port allocation failed:", `${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
        return;
      }
      debugLog(`[perf:setup] portAllocation: ${(performance.now() - s1).toFixed(1)}ms`);

      s1 = performance.now();
      try {
        if (shouldPrewarmTaskShellOnCreate(agentType)) {
          requireService(context.services.prewarmWorktreeShellSession, "prewarmWorktreeShellSession")(
            `shell-wt-${id}`,
            worktreePath,
            JSON.stringify(portEnv),
            repoPath,
          ).catch((error) => reportPrewarmSessionError("[store] shell pre-warm failed:", error));
        }

        if (agentType === "agent") {
          const { env: agentEnv, mcpConfigPath } = await buildTaskLifecycleEnv({
            taskId: id,
            worktreePath,
            repoConfig,
            portEnv,
            logContext: "SDK task",
          });
          const setupCmds = [...(repoConfig.setup || []), ...(opts?.customTask?.setup || [])];
          for (const setupCmd of setupCmds) {
            await invoke("run_script", {
              script: setupCmd,
              cwd: worktreePath,
              env: agentEnv,
            }).catch((error: unknown) => {
              console.warn("[store] SDK setup command failed; continuing:", error);
            });
          }
          await invoke("spawn_agent_session", {
            sessionId: id,
            cwd: worktreePath,
            prompt,
            env: agentEnv,
            agentProvider,
            systemPrompt: buildKannaRuntimeSystemPrompt(),
            mcpConfigPath: mcpConfigPath ?? null,
            permissionMode: opts?.customTask?.permissionMode ?? opts?.permissionMode ?? null,
            model: resolvedModel,
            allowedTools: opts?.customTask?.allowedTools ?? opts?.allowedTools ?? null,
            disallowedTools: opts?.customTask?.disallowedTools ?? null,
            maxTurns: opts?.customTask?.maxTurns ?? null,
            maxBudgetUsd: opts?.customTask?.maxBudgetUsd ?? null,
            executable: null,
          });
          await upsertTerminalSession(context.requireDb(), {
            id: `agent-${id}`,
            repo_id: repoId,
            pipeline_item_id: id,
            label: "agent",
            cwd: worktreePath,
            daemon_session_id: id,
          });
        } else {
          const { env, setupCmds, agentCmd, agentCmdPreamble, kannaCliPath } = await requireService(context.services.preparePtySession, "preparePtySession")(
            id,
            prompt,
            {
              agentProvider,
              model: resolvedModel ?? undefined,
              permissionMode: opts?.customTask?.permissionMode,
              allowedTools: opts?.customTask?.allowedTools,
              disallowedTools: opts?.customTask?.disallowedTools,
              maxTurns: opts?.customTask?.maxTurns,
              maxBudgetUsd: opts?.customTask?.maxBudgetUsd,
              setupCmdsOverride: opts?.customTask?.setup,
              worktreePath,
              repoConfig,
              portEnv,
              setupCmds: ptySetupCmds,
              resumeSessionId: opts?.resumeSessionId ?? undefined,
            },
          );
          const fullCmd = buildTaskBootstrapCommand({
            worktreePath,
            visibleBootstrapSteps: worktreeBootstrap?.visibleBootstrapSteps ?? [],
            setupCmds,
            agentCmd: buildTaskShellCommand(agentCmd, [], { kannaCliPath, agentCmdPreamble }),
          });
          await invoke("spawn_session", {
            sessionId: id,
            cwd: worktreePath,
            executable: "/bin/zsh",
            args: ["--login", "-i", "-c", fullCmd],
            env,
            cols: 80,
            rows: 24,
            agentProvider,
          });
          await upsertTerminalSession(context.requireDb(), {
            id: `agent-${id}`,
            repo_id: repoId,
            pipeline_item_id: id,
            label: "agent",
            cwd: worktreePath,
            daemon_session_id: id,
          });
          if (opts?.recoverySnapshot) {
            await invoke("seed_session_recovery_state", {
              sessionId: id,
              serialized: opts.recoverySnapshot.serialized,
              cols: opts.recoverySnapshot.cols,
              rows: opts.recoverySnapshot.rows,
              cursorRow: opts.recoverySnapshot.cursorRow,
              cursorCol: opts.recoverySnapshot.cursorCol,
              cursorVisible: opts.recoverySnapshot.cursorVisible,
            });
          }
          await requireService(context.services.syncTaskStatusesFromDaemon, "syncTaskStatusesFromDaemon")();
        }
      } catch (error) {
        if (import.meta.env.DEV && typeof window !== "undefined") {
          (window as unknown as { __KANNA_E2E_LAST_AGENT_SPAWN_ERROR__?: unknown }).__KANNA_E2E_LAST_AGENT_SPAWN_ERROR__ = {
            taskId: id,
            message: error instanceof Error ? error.message : String(error),
            error,
          };
        }
        await markSetupFailed(
          error,
          "[store] agent spawn failed:",
          `${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`,
        );
        return;
      }
      debugLog(`[perf:setup] spawnSession: ${(performance.now() - s1).toFixed(1)}ms`);

      s1 = performance.now();
      finishPendingSetup();
      debugLog("[tasks:createItem] setup selection policy", {
        taskId: id,
        stage: opts?.stage,
        selectOnCreate: opts?.selectOnCreate,
        selectedBeforeSetupSelect: context.state.selectedItemId.value,
      });
      if (opts?.selectOnCreate !== false) {
        await requireService(context.services.selectItem, "selectItem")(id);
        debugLog(`[perf:setup] selectItem: ${(performance.now() - s1).toFixed(1)}ms`);
      } else {
        debugLog("[tasks:createItem] skipped setup auto-select", {
          taskId: id,
          selectedAfterSkip: context.state.selectedItemId.value,
        });
      }
      if (agentType === "pty" && agentProvider === "codex" && prompt.trim().length > 0) {
        await delay(CODEX_SPAWN_SUBMIT_DELAY_MS);
        await invoke("send_input", {
          sessionId: id,
          data: encodeDaemonInput("\r"),
        });
      }
      debugLog(`[perf:setup] TOTAL (background): ${(performance.now() - s0).toFixed(1)}ms`);
    } finally {
      finishPendingSetup();
      await requireService(context.services.syncTaskStatusesFromDaemon, "syncTaskStatusesFromDaemon")();
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
    const id = crypto.randomUUID().slice(0, 8);
    const branch = `task-${id}`;
    const worktreePath = `${repoPath}/.kanna-worktrees/${branch}`;
    const effectivePrompt = opts?.customTask?.prompt ?? prompt;
    const effectiveAgentType = normalizeAgentExecutionType(opts?.customTask?.executionMode ?? agentType);
    const customTaskAgentProvider = opts?.customTask?.agentProvider;
    const customTaskModel = opts?.customTask?.model;
    const requestedAgentProviders = customTaskAgentProvider ?? opts?.agentProvider;
    const requestedModel = customTaskModel ?? opts?.model;
    const displayName = opts?.customTask?.name ?? opts?.displayName ?? null;
    debugLog("[tasks:createItem] start", {
      taskId: id,
      repoId,
      agentType: effectiveAgentType,
      requestedStage: opts?.stage,
      requestedPipeline: opts?.pipelineName,
      selectOnCreate: opts?.selectOnCreate,
      selectedAtStart: context.state.selectedItemId.value,
    });
    const realE2eAgentOverride = await resolveRealE2eAgentOverride({
      agentType: effectiveAgentType,
      explicitAgentProvider: requestedAgentProviders,
      explicitModel: requestedModel,
    });
    const providerCandidatesExplicit = customTaskAgentProvider ?? realE2eAgentOverride?.agentProvider ?? requestedAgentProviders;
    const resolvedModel = customTaskModel ?? realE2eAgentOverride?.model ?? requestedModel ?? null;
    const agentSpawnOptions: AgentSpawnRecoveryOptions = {
      model: resolvedModel,
      permissionMode: opts?.customTask?.permissionMode ?? null,
      allowedTools: opts?.customTask?.allowedTools ?? null,
      disallowedTools: opts?.customTask?.disallowedTools ?? null,
      maxTurns: opts?.customTask?.maxTurns ?? null,
      maxBudgetUsd: opts?.customTask?.maxBudgetUsd ?? null,
    };

    const pendingPlaceholder = buildPendingTaskPlaceholder({
      id,
      repoId,
      prompt: effectivePrompt,
      branch,
      agentType: effectiveAgentType,
      requestedAgentProviders,
      pipelineName: opts?.pipelineName,
      stage: opts?.stage,
      displayName,
    });
    context.state.pendingSetupIds.value = [...context.state.pendingSetupIds.value, id];
    context.state.pendingCreateVisibility.set(id, { bumpAt: performance.now() });

    const removePendingPlaceholder = () => {
      context.state.pendingSetupIds.value = context.state.pendingSetupIds.value.filter((pendingId) => pendingId !== id);
      context.state.pendingCreateVisibility.delete(id);
    };

    let pipelineName = opts?.pipelineName;
    let repoConfig: RepoConfig = {};
    let t1 = performance.now();
    if (!pipelineName) {
      try {
        repoConfig = await readRepoConfig(repoPath);
        pipelineName = repoConfig.pipeline ?? "default";
      } catch (error) {
        console.debug("[store] no repo config while creating task; using default pipeline:", error);
        pipelineName = "default";
      }
    }
    debugLog(`[perf:createItem] readRepoConfig: ${(performance.now() - t1).toFixed(1)}ms`);

    let firstStageName = opts?.stage ?? "in progress";
    let pipelinePrompt = effectivePrompt;
    let firstStageProviders: AgentProvider | AgentProvider[] | undefined;
    let firstStageAgentProviders: AgentProvider | AgentProvider[] | undefined;
    t1 = performance.now();
    try {
      const pipeline = await requireService(context.services.loadPipeline, "loadPipeline")(repoPath, pipelineName);
      if (!opts?.stage && pipeline.stages.length > 0) {
        const firstStage = pipeline.stages[0];
        firstStageName = firstStage.name;
        firstStageProviders = firstStage.agent_provider as AgentProvider | AgentProvider[] | undefined;
        if (firstStage.agent && !opts?.stage) {
          try {
            const agent = await requireService(context.services.loadAgent, "loadAgent")(repoPath, firstStage.agent);
            firstStageAgentProviders = agent.agent_provider as AgentProvider | AgentProvider[] | undefined;
            pipelinePrompt = buildStagePrompt(
              agent.prompt,
              firstStage.prompt,
              { taskPrompt: effectivePrompt },
            );
          } catch (error) {
            console.error("[store] failed to load agent for first stage:", error);
          }
        }
      }
    } catch (error) {
      console.error("[store] failed to load pipeline definition:", error);
    }
    debugLog(`[perf:createItem] loadPipeline+loadAgent: ${(performance.now() - t1).toFixed(1)}ms`);

    if (Object.keys(repoConfig).length === 0) {
      try {
        repoConfig = await readRepoConfig(repoPath);
      } catch (error) {
        console.debug("[store] no repo config while creating task; using empty config:", error);
        repoConfig = {};
      }
    }

    let effectiveAgentProvider: AgentProvider;
    try {
      const candidates = getPreferredAgentProviders({
        explicit: providerCandidatesExplicit,
        stage: firstStageProviders,
        agent: firstStageAgentProviders,
      });
      const availability = await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")();
      effectiveAgentProvider = resolveAgentProvider(candidates, availability);
    } catch (error) {
      console.error("[store] createItem: failed to resolve agent provider:", error);
      throw error;
    }

    let baseRef: string | null = null;
    let pipelineItemInserted = false;

    try {
      await withOptimisticItemOverlay<void>({
        key: `create:${id}`,
        apply: (snapshot) => ({
          entries: snapshot.entries.map((entry) =>
            entry.repo.id === repoId
              ? {
                  ...entry,
                  items: [pendingPlaceholder, ...entry.items.filter((item) => item.id !== id)],
                }
              : entry,
          ),
          taskBlockers: snapshot.taskBlockers,
        }),
        run: async () => {
          try {
            t1 = performance.now();
            if (opts?.baseRef !== undefined) {
              baseRef = opts.baseRef;
            } else {
              try {
                const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
                const availableBaseBranches = await invoke<string[]>("git_list_base_branches", { repoPath });
                baseRef = resolveInitialBaseRef({
                  selectedBaseBranch: opts?.baseBranch,
                  availableBaseBranches,
                  defaultBranch,
                });
              } catch (error) {
                console.warn("[store] failed to verify base branch:", error);
                baseRef = null;
              }
            }
            if (!baseRef) {
              throw new Error("No valid base branch selected");
            }
            debugLog(`[perf:createItem] git base_ref: ${(performance.now() - t1).toFixed(1)}ms`);

            t1 = performance.now();
            await insertPipelineItem(context.requireDb(), {
              id,
              repo_id: repoId,
              issue_number: null,
              issue_title: null,
              prompt: effectivePrompt,
              pipeline: pipelineName,
              stage: firstStageName,
              pr_number: null,
              pr_url: null,
              branch,
              agent_type: effectiveAgentType,
              agent_provider: effectiveAgentProvider,
              port_offset: null,
              port_env: null,
              activity: "working",
              display_name: displayName,
              base_ref: baseRef,
              agent_spawn_options: JSON.stringify(agentSpawnOptions),
            });

            pipelineItemInserted = true;
            if (opts?.resumeSessionId) {
              await updateAgentSessionId(context.requireDb(), id, opts.resumeSessionId);
            }
          } catch (error) {
            if (pipelineItemInserted) {
              await context.requireDb().execute("DELETE FROM pipeline_item WHERE id = ?", [id]).catch((cleanupError) => {
                console.debug("[store] failed to clean up partially inserted pipeline item:", cleanupError);
              });
            }
            await ports.releaseTaskPorts(id).catch((cleanupError) => {
              console.debug("[store] failed to release ports after task creation failure:", cleanupError);
            });
            console.error("[store] task creation failed:", error);
            const message = error instanceof Error ? error.message : String(error);
            context.toast.error(message === "No valid base branch selected" ? message : context.tt("toasts.dbInsertFailed"));
            throw error;
          }
          debugLog(`[perf:createItem] DB insert: ${(performance.now() - t1).toFixed(1)}ms`);

          await reloadSnapshot();
          const createdItem = context.state.items.value.find((candidate) => candidate.id === id);
          const createdRepo = context.state.repos.value.find((candidate) => candidate.id === repoId) ?? null;
          if (createdItem) {
            void publishDesktopLanTaskSnapshot(context.requireDb());
            const publishPromise = publishDesktopTaskSnapshot(context.requireDb(), createdItem, createdRepo)
              .then(() => {
                if (import.meta.env.DEV && typeof window !== "undefined") {
                  (window as unknown as { __KANNA_E2E_CLOUD_PUBLISH__?: unknown }).__KANNA_E2E_CLOUD_PUBLISH__ = {
                    status: "ok",
                    taskId: id,
                  };
                }
              })
              .catch((error) => {
                if (import.meta.env.DEV && typeof window !== "undefined") {
                  (window as unknown as { __KANNA_E2E_CLOUD_PUBLISH__?: unknown }).__KANNA_E2E_CLOUD_PUBLISH__ = {
                    status: "error",
                    taskId: id,
                    message: error instanceof Error ? error.message : String(error),
                  };
                }
                console.warn("[cloud] failed to publish task snapshot:", error);
                showCloudPublishErrorToast(context, error);
                throw error;
              });
            const awaitCloudPublish = import.meta.env.DEV
              ? await invoke<string>("read_env_var", { name: "KANNA_E2E_AWAIT_CLOUD_PUBLISH" }).catch((error) => {
                  console.debug("[store] E2E cloud publish await flag not set:", error);
                  return "";
                })
              : "";
            if (awaitCloudPublish === "1") {
              await publishPromise;
            } else {
              void publishPromise.catch((error) => {
                console.debug("[cloud] async publish task snapshot failed after non-awaited path:", error);
              });
            }
          }
          debugLog(`[perf:createItem] reload -> waiting for items refresh (id=${id})`);
          debugLog(`[perf:createItem] TOTAL (modal → reload): ${(performance.now() - t0).toFixed(1)}ms`);
          debugLog("[tasks:createItem] inserted and reloaded", {
            taskId: id,
            stage: firstStageName,
            selectOnCreate: opts?.selectOnCreate,
            selectedAfterReload: context.state.selectedItemId.value,
          });

          void setupWorktreeAndSpawn(
            id,
            repoId,
            repoPath,
            worktreePath,
            branch,
            pipelinePrompt,
            effectiveAgentType,
            effectiveAgentProvider,
            {
              ...opts,
              baseRef,
              model: resolvedModel ?? undefined,
            },
          );
        },
        reconcile: reloadSnapshot,
      });
    } catch (error) {
      removePendingPlaceholder();
      throw error;
    }
    debugLog("[tasks:createItem] returning", {
      taskId: id,
      selectOnCreate: opts?.selectOnCreate,
      selectedBeforeReturn: context.state.selectedItemId.value,
    });
    await invalidateWindowWorkspace("createItem");
    return id;
  }


  return { createItem };
}
