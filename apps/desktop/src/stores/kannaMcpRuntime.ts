import { invoke } from "../invoke";
import { buildKannaMcpPathEnv } from "./kannaCliEnv";

interface KannaMcpRuntime {
  kannaMcpPath?: string;
  mcpConfigPath?: string;
}

function joinPath(root: string, ...parts: string[]): string {
  const trimmedRoot = root.replace(/\/+$/, "");
  return [trimmedRoot, ...parts.map((part) => part.replace(/^\/+|\/+$/g, ""))].join("/");
}

async function resolveMcpRuntimeRoot(): Promise<string> {
  const daemonDir = await invoke<string>("read_env_var", { name: "KANNA_DAEMON_DIR" }).catch(() => "");
  if (daemonDir.trim().length > 0) {
    return daemonDir;
  }
  return invoke<string>("get_app_data_dir");
}

export async function prepareKannaMcpRuntime(
  taskId: string,
  env: Record<string, string>,
): Promise<KannaMcpRuntime> {
  const kannaMcpPath = await invoke<string>("which_binary", { name: "kanna-mcp" }).catch((error) => {
    console.debug("[store] kanna-mcp not available while building task runtime env:", error);
    return null;
  });
  if (!kannaMcpPath) {
    return {};
  }

  Object.assign(env, buildKannaMcpPathEnv(kannaMcpPath, env.PATH));

  try {
    const runtimeRoot = await resolveMcpRuntimeRoot();
    const configDir = joinPath(runtimeRoot, "runtime", "mcp");
    const mcpConfigPath = joinPath(configDir, `${taskId}.json`);
    const serverBaseUrl = env.KANNA_SERVER_BASE_URL ?? "http://127.0.0.1:48120";
    const content = JSON.stringify({
      mcpServers: {
        "kanna-mcp": {
          command: kannaMcpPath,
          args: ["serve"],
          env: {
            KANNA_SERVER_BASE_URL: serverBaseUrl,
          },
        },
      },
    }, null, 2);

    await invoke("ensure_directory", { path: configDir });
    await invoke("write_text_file", { path: mcpConfigPath, content });
    env.KANNA_MCP_CONFIG = mcpConfigPath;
    return { kannaMcpPath, mcpConfigPath };
  } catch (error) {
    console.error("[store] failed to write Kanna MCP config:", error);
    return { kannaMcpPath };
  }
}
