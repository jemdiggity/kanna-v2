import type { AgentProvider, PipelineItem } from "@kanna/db";
import { getRepo, updateAgentSessionId } from "@kanna/db";
import { buildKannaRuntimeSystemPrompt, buildKannaRuntimeUserPrompt } from "../../../../packages/core/src/pipeline/prompt-builder";
import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import { buildTaskShellCommand, getShellTerminalEnv, getTaskTerminalEnv } from "../composables/terminalSessionRecovery";
import { buildKannaCliPathEnv, buildTaskRuntimeEnv, resolveKannaServerBaseUrl } from "./kannaCliEnv";
import { prepareKannaMcpRuntime } from "./kannaMcpRuntime";
import { readEnvVarOptional, whichBinaryOptional } from "../utils/invokeHelpers";
import { encodeDaemonInput } from "./daemonInput";
import { getAgentPermissionFlags } from "./agent-permissions";
import { buildAgentCommand } from "./agentCommand";
import { buildWorktreeSessionEnv } from "./worktreeEnv";
import {
  requireResolvedAgentProvider,
  type AgentProviderAvailability,
} from "./agent-provider";
import { shouldIgnoreRuntimeStatusDuringSetup } from "./taskRuntimeStatus";
import { isReadableDirectory, resolveShellSpawnCwd } from "../utils/shellCwd";
import { readRepoConfig, requireService, type AgentSpawnRecoveryOptions, type PreparedPtySession, type PtySpawnOptions, type StoreContext, type TaskSessionRecoveryOptions } from "./state";

interface DaemonSessionInfo {
  session_id?: string;
  status?: string;
}

const CODEX_SPAWN_SUBMIT_DELAY_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function agentProviderBinary(provider: AgentProvider): string {
  return provider === "antigravity" ? "agy" : provider;
}

export interface SessionsApi {
  applyTaskRuntimeStatus: (item: import("@kanna/db").PipelineItem, status: string) => Promise<void>;
  syncTaskStatusesFromDaemon: () => Promise<void>;
  isAgentProviderAvailable: (provider: AgentProvider) => Promise<boolean>;
  getAgentProviderAvailability: () => Promise<AgentProviderAvailability>;
  waitForSessionExit: (sessionId: string) => Promise<void>;
  resolveSessionExitWaiters: (sessionId: string) => void;
  persistExitedSessionResumeId: (sessionId: string, resumeSessionId?: string | null) => Promise<void>;
  spawnShellSession: (
    sessionId: string,
    cwd: string,
    portEnv?: string | null,
    isWorktree?: boolean,
    fallbackCwd?: string | null,
  ) => Promise<void>;
  prewarmWorktreeShellSession: (
    sessionId: string,
    worktreePath: string,
    portEnv?: string | null,
    fallbackCwd?: string | null,
  ) => Promise<void>;
  preparePtySession: (
    sessionId: string,
    prompt: string,
    options?: PtySpawnOptions,
  ) => Promise<PreparedPtySession>;
  spawnPtySession: (
    sessionId: string,
    cwd: string,
    prompt: string,
    cols?: number,
    rows?: number,
    options?: PtySpawnOptions,
  ) => Promise<void>;
  recoverTaskSession: (
    sessionId: string,
    options?: TaskSessionRecoveryOptions,
  ) => Promise<void>;
}

export function createSessionsApi(context: StoreContext): SessionsApi {
  const sessionExitWaiters = new Map<string, Array<() => void>>();

  function parsePortEnv(portEnv?: string | null): Record<string, string> {
    if (!portEnv) {
      return {};
    }

    try {
      return JSON.parse(portEnv) as Record<string, string>;
    } catch (error) {
      console.error("[store] failed to parse portEnv:", error);
      return {};
    }
  }

  function taskIdFromWorktreeShellSessionId(sessionId: string): string | null {
    const prefix = "shell-wt-";
    if (!sessionId.startsWith(prefix)) return null;
    const taskId = sessionId.slice(prefix.length);
    return taskId.length > 0 ? taskId : null;
  }

  async function readInheritedPath(explicitPath?: string): Promise<string | null> {
    if (explicitPath && explicitPath.length > 0) {
      return explicitPath;
    }

    const inheritedPath = await readEnvVarOptional("PATH");
    return inheritedPath && inheritedPath.length > 0 ? inheritedPath : null;
  }

  async function applyTaskRuntimeStatus(item: import("@kanna/db").PipelineItem, status: string) {
    if (item.closed_at !== null) {
      return;
    }

    if (shouldIgnoreRuntimeStatusDuringSetup(status, context.state.pendingSetupIds.value.includes(item.id))) {
      return;
    }

    if (status === "busy" || status === "idle" || status === "waiting") {
      await requireService(context.services.reloadSnapshot, "reloadSnapshot")();
      await context.services.windowWorkspace?.invalidateSharedData("taskActivity");
    }
  }

  async function syncTaskStatusesFromDaemon() {
    if (!isTauri) return;

    try {
      const sessions = await invoke<DaemonSessionInfo[]>("list_sessions");
      for (const session of sessions) {
        const sessionId = session.session_id;
        const status = session.status;
        if (!sessionId || !status) continue;
        const item = context.state.items.value.find((candidate) => candidate.id === sessionId);
        if (!item) continue;
        await applyTaskRuntimeStatus(item, status);
      }
    } catch (error) {
      console.error("[store] failed to sync task statuses from daemon:", error);
    }
  }

  async function isAgentProviderAvailable(provider: AgentProvider): Promise<boolean> {
    const binary = agentProviderBinary(provider);
    const path = await whichBinaryOptional(binary);
    return Boolean(path);
  }

  async function getAgentProviderAvailability(): Promise<AgentProviderAvailability> {
    const [claude, copilot, codex, opencode, antigravity] = await Promise.all([
      isAgentProviderAvailable("claude"),
      isAgentProviderAvailable("copilot"),
      isAgentProviderAvailable("codex"),
      isAgentProviderAvailable("opencode"),
      isAgentProviderAvailable("antigravity"),
    ]);

    return { claude, copilot, codex, opencode, antigravity };
  }

  async function waitForSessionExit(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const existing = sessionExitWaiters.get(sessionId) ?? [];
      existing.push(resolve);
      sessionExitWaiters.set(sessionId, existing);
    });
  }

  function resolveSessionExitWaiters(sessionId: string): void {
    const waiters = sessionExitWaiters.get(sessionId);
    if (!waiters) return;
    sessionExitWaiters.delete(sessionId);
    for (const resolve of waiters) resolve();
  }

  async function persistExitedSessionResumeId(
    sessionId: string,
    resumeSessionId?: string | null,
  ): Promise<void> {
    if (!resumeSessionId) return;
    const item = context.state.items.value.find((candidate) => candidate.id === sessionId);
    if (!item || item.agent_provider !== "codex") return;
    await updateAgentSessionId(context.requireDb(), sessionId, resumeSessionId);
  }

  async function spawnShellSession(
    sessionId: string,
    cwd: string,
    portEnv?: string | null,
    isWorktree = true,
    fallbackCwd?: string | null,
  ): Promise<void> {
    const parsedPortEnv = parsePortEnv(portEnv);
    let env: Record<string, string> = { ...getShellTerminalEnv() };
    if (isWorktree) {
      env.KANNA_WORKTREE = "1";
      env = buildWorktreeSessionEnv({
        worktreePath: cwd,
        baseEnv: env,
        repoConfig: await readRepoConfig(cwd),
        portEnv: parsedPortEnv,
        inheritedPath: await readInheritedPath(env.PATH),
      });
    } else if (Object.keys(parsedPortEnv).length > 0) {
      Object.assign(env, parsedPortEnv);
    }
    const runtimePath = await readInheritedPath(env.PATH);
    const resolvedKannaCliPath = await whichBinaryOptional("kanna-cli");

    const shellTaskId = isWorktree ? taskIdFromWorktreeShellSessionId(sessionId) : null;
    if (shellTaskId) {
      try {
        const [socketPath, mobileServerPort] = await Promise.all([
          invoke<string>("get_pipeline_socket_path"),
          readEnvVarOptional("KANNA_MOBILE_SERVER_PORT"),
        ]);
        Object.assign(env, buildTaskRuntimeEnv({
          taskId: shellTaskId,
          socketPath,
          serverBaseUrl: resolveKannaServerBaseUrl(mobileServerPort),
          portEnv: parsedPortEnv,
          kannaCliPath: resolvedKannaCliPath,
          path: runtimePath,
        }));
      } catch (error) {
        console.error("[store] failed to resolve task shell kanna-cli env:", error);
        Object.assign(env, buildKannaCliPathEnv(resolvedKannaCliPath, runtimePath));
      }
    } else {
      Object.assign(env, buildKannaCliPathEnv(resolvedKannaCliPath, runtimePath));
    }
    try {
      env.ZDOTDIR = await invoke<string>("ensure_term_init");
    } catch (error) {
      console.error("[store] failed to set up term init:", error);
    }
    const resolvedCwd = await resolveShellSpawnCwd(cwd, fallbackCwd);
    if (resolvedCwd.fellBack) {
      console.warn("[store] shell cwd unreadable, falling back:", {
        sessionId,
        from: cwd,
        to: resolvedCwd.cwd,
      });
    }
    await invoke("spawn_session", {
      sessionId,
      cwd: resolvedCwd.cwd,
      executable: "/bin/zsh",
      args: ["--login"],
      env,
      cols: 80,
      rows: 24,
    });
  }

  async function prewarmWorktreeShellSession(
    sessionId: string,
    worktreePath: string,
    portEnv?: string | null,
    fallbackCwd?: string | null,
  ): Promise<void> {
    if (!await isReadableDirectory(worktreePath)) {
      console.warn("[store] skipping shell pre-warm for unreadable worktree:", worktreePath);
      return;
    }
    await spawnShellSession(sessionId, worktreePath, portEnv, true, fallbackCwd);
  }

  async function resolveTaskWorktreePath(item: PipelineItem): Promise<string> {
    const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      ?? await getRepo(context.requireDb(), item.repo_id);
    if (!repo) {
      throw new Error(`repo not found for task ${item.id}`);
    }
    return item.branch ? `${repo.path}/.kanna-worktrees/${item.branch}` : repo.path;
  }

  function parseAgentSpawnRecoveryOptions(raw: string | null | undefined): AgentSpawnRecoveryOptions {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as AgentSpawnRecoveryOptions;
      return {
        model: typeof parsed.model === "string" ? parsed.model : null,
        permissionMode: typeof parsed.permissionMode === "string" ? parsed.permissionMode : null,
        allowedTools: Array.isArray(parsed.allowedTools)
          ? parsed.allowedTools.filter((tool): tool is string => typeof tool === "string")
          : null,
        disallowedTools: Array.isArray(parsed.disallowedTools)
          ? parsed.disallowedTools.filter((tool): tool is string => typeof tool === "string")
          : null,
        maxTurns: typeof parsed.maxTurns === "number" ? parsed.maxTurns : null,
        maxBudgetUsd: typeof parsed.maxBudgetUsd === "number" ? parsed.maxBudgetUsd : null,
      };
    } catch (error) {
      console.debug("[store] failed to parse agent spawn recovery options:", error);
      return {};
    }
  }

  async function buildAgentSessionEnv(
    sessionId: string,
    worktreePath: string,
    portEnv: Record<string, string>,
  ): Promise<{ env: Record<string, string>; mcpConfigPath?: string }> {
    const repoConfig = await readRepoConfig(worktreePath).catch((error) => {
      console.error("[store] failed to read SDK task config during session recovery:", error);
      return {};
    });
    const inheritedPath = await readEnvVarOptional("PATH");
    const agentBaseEnv = buildWorktreeSessionEnv({
      worktreePath,
      repoConfig,
      portEnv,
      inheritedPath,
    });
    const env = {
      ...agentBaseEnv,
      ...buildTaskRuntimeEnv({
        taskId: sessionId,
        socketPath: await invoke<string>("get_pipeline_socket_path"),
        serverBaseUrl: resolveKannaServerBaseUrl(await readEnvVarOptional("KANNA_MOBILE_SERVER_PORT")),
        kannaCliPath: await whichBinaryOptional("kanna-cli"),
        path: agentBaseEnv.PATH ?? inheritedPath,
      }),
    };
    const { mcpConfigPath } = await prepareKannaMcpRuntime(sessionId, env);
    return { env, mcpConfigPath };
  }

  async function preparePtySession(
    sessionId: string,
    prompt: string,
    options?: PtySpawnOptions,
  ): Promise<PreparedPtySession> {
    const provider = requireResolvedAgentProvider(options?.agentProvider);
    const env: Record<string, string> = { ...getTaskTerminalEnv(provider) };
    let kannaCliPath: string | undefined;
    let setupCmds: string[] = options?.setupCmds || [];
    let portEnv = options?.portEnv;
    let worktreePath = options?.worktreePath;
    let repoConfig = options?.repoConfig;

    const item = context.state.items.value.find((candidate) => candidate.id === sessionId);
    if (item) {
      if (!portEnv && item.port_env) {
        portEnv = parsePortEnv(item.port_env);
      }

      if (!worktreePath || (setupCmds.length === 0 && !repoConfig)) {
        try {
          const repo = await getRepo(context.requireDb(), item.repo_id);
          if (repo && item.branch) {
            worktreePath ??= `${repo.path}/.kanna-worktrees/${item.branch}`;
          }
        } catch (error) {
          console.error("[store] failed to resolve worktree path:", error);
        }
      }
    }

    if (worktreePath && !repoConfig) {
      try {
        repoConfig = await readRepoConfig(worktreePath);
      } catch (error) {
        console.error("[store] failed to read setup config:", error);
      }
    }

    if (setupCmds.length === 0 && repoConfig?.setup?.length) {
      setupCmds = repoConfig.setup;
    }

    if (worktreePath) {
      Object.assign(env, buildWorktreeSessionEnv({
        worktreePath,
        baseEnv: env,
        repoConfig,
        portEnv,
        inheritedPath: await readInheritedPath(env.PATH),
      }));
    } else if (portEnv) {
      Object.assign(env, portEnv);
    }
    const runtimePath = await readInheritedPath(env.PATH);

    const resolvedKannaCliPath = await whichBinaryOptional("kanna-cli");
    if (resolvedKannaCliPath) {
      kannaCliPath = resolvedKannaCliPath;
    }

    try {
      const [socketPath] = await Promise.all([
        invoke<string>("get_pipeline_socket_path"),
      ]);
      Object.assign(env, buildTaskRuntimeEnv({
        taskId: sessionId,
        socketPath,
        serverBaseUrl: resolveKannaServerBaseUrl(await readEnvVarOptional("KANNA_MOBILE_SERVER_PORT")),
        kannaCliPath: resolvedKannaCliPath,
        path: runtimePath,
      }));
    } catch (error) {
      console.error("[store] failed to resolve kanna-cli env:", error);
    }

    const { mcpConfigPath } = await prepareKannaMcpRuntime(sessionId, env);

    // Only the Claude PTY command registers kanna-mcp in this spawn path; the
    // prompt-prepended providers fall back to kanna-cli per the guidance.
    const runtimeSystemPrompt = buildKannaRuntimeSystemPrompt({
      taskId: sessionId,
      provider: "claude",
      mcpConfigured: !!mcpConfigPath,
    });
    const runtimeUserPrompt = buildKannaRuntimeUserPrompt(prompt, { taskId: sessionId });
    const permissionFlags = getAgentPermissionFlags(provider, options?.permissionMode);
    const { agentCmd, agentCmdPreamble, agentSessionId } = await buildAgentCommand(provider, {
      taskId: sessionId,
      prompt,
      runtimeSystemPrompt,
      runtimeUserPrompt,
      permissionFlags,
      mcpConfigPath,
      model: options?.model,
      allowedTools: options?.allowedTools,
      disallowedTools: options?.disallowedTools,
      maxTurns: options?.maxTurns,
      maxBudgetUsd: options?.maxBudgetUsd,
      resumeSessionId: options?.resumeSessionId,
      worktreePath,
      persistAgentSessionId: async (agentSessionId) => {
        await updateAgentSessionId(context.requireDb(), sessionId, agentSessionId);
      },
      resolveBinaryPath: async (name) => invoke<string>("which_binary", { name }),
    });

    return {
      env,
      setupCmds: [...setupCmds, ...(options?.setupCmdsOverride || [])],
      agentCmd,
      agentCmdPreamble,
      agentProvider: provider,
      kannaCliPath,
      mcpConfigPath,
      agentSessionId,
    };
  }

  async function spawnPtySession(
    sessionId: string,
    cwd: string,
    prompt: string,
    cols = 80,
    rows = 24,
    options?: PtySpawnOptions,
  ) {
    const { env, setupCmds, agentCmd, agentCmdPreamble, agentProvider, kannaCliPath } = await preparePtySession(sessionId, prompt, {
      ...options,
      worktreePath: options?.worktreePath ?? cwd,
    });
    const fullCmd = buildTaskShellCommand(agentCmd, setupCmds, { kannaCliPath, agentCmdPreamble });

    await invoke("spawn_session", {
      sessionId,
      cwd,
      executable: "/bin/zsh",
      args: ["--login", "-i", "-c", fullCmd],
      env,
      cols,
      rows,
      agentProvider: options?.agentProvider ?? null,
    });
    if (agentProvider === "codex" && prompt.trim().length > 0) {
      await delay(CODEX_SPAWN_SUBMIT_DELAY_MS);
      await invoke("send_input", {
        sessionId,
        data: encodeDaemonInput("\r"),
      });
    }
    await syncTaskStatusesFromDaemon();
  }

  async function recoverTaskSession(
    sessionId: string,
    options: TaskSessionRecoveryOptions = {},
  ): Promise<void> {
    const item = context.state.items.value.find((candidate) => candidate.id === sessionId);
    if (!item) {
      throw new Error(`task not found for session recovery: ${sessionId}`);
    }
    if (item.closed_at !== null) {
      throw new Error(`cannot recover closed task session: ${sessionId}`);
    }

    const worktreePath = await resolveTaskWorktreePath(item);
    const agentProvider = requireResolvedAgentProvider(item.agent_provider ?? undefined);
    const prompt = item.prompt ?? "";
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const portEnv = parsePortEnv(item.port_env);
    const spawnOptions = parseAgentSpawnRecoveryOptions(item.agent_spawn_options);

    if (item.agent_type === "agent" || item.agent_type === "sdk") {
      const { env, mcpConfigPath } = await buildAgentSessionEnv(sessionId, worktreePath, portEnv);
      await invoke("spawn_agent_session", {
        sessionId,
        cwd: worktreePath,
        prompt,
        env,
        agentProvider,
        systemPrompt: buildKannaRuntimeSystemPrompt({
          taskId: sessionId,
          stage: item.stage,
          pipeline: item.pipeline,
          provider: agentProvider,
          mcpConfigured: !!mcpConfigPath,
        }),
        mcpConfigPath: mcpConfigPath ?? null,
        permissionMode: spawnOptions.permissionMode ?? null,
        model: spawnOptions.model ?? null,
        allowedTools: spawnOptions.allowedTools ?? null,
        disallowedTools: spawnOptions.disallowedTools ?? null,
        maxTurns: spawnOptions.maxTurns ?? null,
        maxBudgetUsd: spawnOptions.maxBudgetUsd ?? null,
        executable: null,
      });
      await syncTaskStatusesFromDaemon();
      return;
    }

    await spawnPtySession(sessionId, worktreePath, prompt, cols, rows, {
      agentProvider,
      portEnv,
      worktreePath,
      ...(item.agent_session_id ? { resumeSessionId: item.agent_session_id } : {}),
    });
  }

  return {
    applyTaskRuntimeStatus,
    syncTaskStatusesFromDaemon,
    isAgentProviderAvailable,
    getAgentProviderAvailability,
    waitForSessionExit,
    resolveSessionExitWaiters,
    persistExitedSessionResumeId,
    spawnShellSession,
    prewarmWorktreeShellSession,
    preparePtySession,
    spawnPtySession,
    recoverTaskSession,
  };
}
