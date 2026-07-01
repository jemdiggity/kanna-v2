interface BuildKannaCliEnvOptions {
  taskId: string;
  socketPath: string;
  serverBaseUrl: string;
}

export function resolveKannaServerBaseUrl(mobileServerPort?: string | null): string {
  const port = mobileServerPort?.trim();
  return `http://127.0.0.1:${port || "48120"}`;
}

export function buildKannaCliEnv(options: BuildKannaCliEnvOptions): Record<string, string> {
  const { taskId, socketPath, serverBaseUrl } = options;

  return {
    KANNA_TASK_ID: taskId,
    KANNA_SOCKET_PATH: socketPath,
    KANNA_SERVER_BASE_URL: serverBaseUrl,
  };
}

interface BuildTaskRuntimeEnvOptions extends BuildKannaCliEnvOptions {
  portEnv?: Record<string, string>;
  kannaCliPath?: string | null;
  kannaMcpPath?: string | null;
  mcpConfigPath?: string | null;
  path?: string | null;
}

function directoryName(path: string): string | null {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return path.slice(0, lastSlash);
}

function prependPathEntry(path: string | null | undefined, entry: string): string {
  const existingEntries = (path ?? "").split(":").filter((part) => part.length > 0);
  return [entry, ...existingEntries.filter((part) => part !== entry)].join(":");
}

export function buildKannaCliPathEnv(kannaCliPath?: string | null, path?: string | null): Record<string, string> {
  const kannaCliDir = kannaCliPath ? directoryName(kannaCliPath) : null;
  const runtimePath = kannaCliDir && path ? prependPathEntry(path, kannaCliDir) : null;

  return {
    ...(kannaCliPath ? { KANNA_CLI_PATH: kannaCliPath } : {}),
    ...(runtimePath ? { PATH: runtimePath } : {}),
  };
}

export function buildKannaMcpPathEnv(kannaMcpPath?: string | null, path?: string | null): Record<string, string> {
  const kannaMcpDir = kannaMcpPath ? directoryName(kannaMcpPath) : null;
  const runtimePath = kannaMcpDir && path ? prependPathEntry(path, kannaMcpDir) : null;

  return {
    ...(kannaMcpPath ? { KANNA_MCP_PATH: kannaMcpPath } : {}),
    ...(runtimePath ? { PATH: runtimePath } : {}),
  };
}

export function buildTaskRuntimeEnv(options: BuildTaskRuntimeEnvOptions): Record<string, string> {
  const { portEnv, kannaCliPath, kannaMcpPath, mcpConfigPath, path, ...kannaCliEnvOptions } = options;
  const cliPathEnv = buildKannaCliPathEnv(kannaCliPath, path);
  const mcpPathEnv = buildKannaMcpPathEnv(kannaMcpPath, cliPathEnv.PATH ?? path);

  return {
    KANNA_WORKTREE: "1",
    ...(portEnv ?? {}),
    ...cliPathEnv,
    ...mcpPathEnv,
    ...(mcpConfigPath ? { KANNA_MCP_CONFIG: mcpConfigPath } : {}),
    ...buildKannaCliEnv(kannaCliEnvOptions),
  };
}
