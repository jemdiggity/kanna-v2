import { parseAgentMd, type RepoConfig } from "@kanna/core";
import type { PipelineItem, Repo } from "../types/kanna";
import { invoke } from "../invoke";
import { resolveCurrentKannaServerBaseUrl } from "../services/kannaServerBaseUrl";
import { buildTaskRuntimeEnv } from "./kannaCliEnv";
import { prepareKannaMcpRuntime } from "./kannaMcpRuntime";
import { fetchRepoConfig } from "./state";
import { readEnvVarOptional, whichBinaryOptional } from "../utils/invokeHelpers";
import { buildWorktreeSessionEnv } from "./worktreeEnv";

const INSTANCE_SCOPED_WORKTREE_ENV_KEYS = [
  "KANNA_TMUX_SESSION",
  "KANNA_DB_NAME",
  "KANNA_DB_PATH",
  "KANNA_DAEMON_DIR",
  "KANNA_TRANSFER_ROOT",
  "KANNA_WEBDRIVER_PORT",
  "KANNA_E2E_TARGET_WEBDRIVER_PORT",
  "KANNA_TRANSFER_PORT",
  "KANNA_TRANSFER_DISPLAY_NAME",
  "KANNA_TRANSFER_PEER_ID",
  "KANNA_TRANSFER_REGISTRY_DIR",
] as const;

export function applyWorktreeProcessIsolation(env: Record<string, string>): Record<string, string> {
  for (const key of INSTANCE_SCOPED_WORKTREE_ENV_KEYS) {
    env[key] = "";
  }
  return env;
}

export function parseTaskPortEnv(portEnv: string | null): Record<string, string> {
  if (!portEnv) return {};
  try {
    const parsed = JSON.parse(portEnv) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)]),
    );
  } catch (error) {
    console.debug("[store] failed to parse task port env:", error);
    return {};
  }
}

export async function buildTaskLifecycleEnv(options: {
  taskId: string;
  worktreePath: string;
  repoConfig: RepoConfig;
  portEnv?: Record<string, string>;
  logContext: string;
}): Promise<{ env: Record<string, string>; mcpConfigPath?: string }> {
  const inheritedPath = await readEnvVarOptional("PATH");
  const worktreeEnv = buildWorktreeSessionEnv({
    worktreePath: options.worktreePath,
    repoConfig: options.repoConfig,
    portEnv: options.portEnv,
    inheritedPath,
  });
  const kannaCliPath = await whichBinaryOptional("kanna-cli");

  const env = {
    ...worktreeEnv,
    ...buildTaskRuntimeEnv({
      taskId: options.taskId,
      socketPath: await invoke<string>("get_pipeline_socket_path"),
      serverBaseUrl: await resolveCurrentKannaServerBaseUrl(`creating ${options.logContext} env`),
      kannaCliPath,
      path: worktreeEnv.PATH ?? inheritedPath,
      portEnv: options.portEnv,
    }),
  };
  const { mcpConfigPath } = await prepareKannaMcpRuntime(options.taskId, env);
  return { env, mcpConfigPath };
}


export function hasLiveTaskResources(item: PipelineItem): boolean {
  return item.branch !== null || item.agent_session_id !== null || item.port_env !== null;
}

export async function collectTeardownCommands(item: PipelineItem, repo: Repo): Promise<string[]> {
  const cmds: string[] = [];
  if (item.display_name) {
    try {
      const tasksDir = `${repo.path}/.kanna/tasks`;
      const entries = await invoke<string[]>("list_dir", { path: tasksDir }).catch((error) => {
        console.debug("[store] no custom task teardown directory:", error);
        return [] as string[];
      });
      for (const entry of entries) {
        const agentMdPath = `${tasksDir}/${entry}/agent.md`;
        let content: string;
        try {
          content = await invoke<string>("read_text_file", { path: agentMdPath });
        } catch (error) {
          console.debug(`[store] failed to read custom task teardown config ${agentMdPath}:`, error);
          continue;
        }
        const config = parseAgentMd(content, entry);
        if (config && config.name === item.display_name && config.teardown?.length) {
          cmds.push(...config.teardown);
          break;
        }
      }
    } catch (error) {
      console.error("[store] custom task teardown lookup failed:", error);
    }
  }

  const repoConfig = await fetchRepoConfig(repo.id);
  if (repoConfig.teardown?.length) {
    cmds.push(...repoConfig.teardown);
  }
  return cmds;
}
