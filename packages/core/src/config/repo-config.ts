/**
 * Built-in stage display order used when no repo-level override is configured.
 * Stages not listed here sort alphabetically after the listed ones.
 */
export const DEFAULT_STAGE_ORDER: readonly string[] = ["pr", "review", "in progress"];

export interface RepoWorkspacePathConfig {
  prepend?: string[];
  append?: string[];
}

export interface RepoWorkspaceConfig {
  env?: Record<string, string>;
  path?: RepoWorkspacePathConfig;
}

export interface RepoConfig {
  pipeline?: string;
  setup?: string[];
  teardown?: string[];
  test?: string[];
  ports?: Record<string, number>;
  stage_order?: string[];
  workspace?: RepoWorkspaceConfig;
}

export function parseRepoConfig(json: string): RepoConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const raw = parsed as Record<string, unknown>;
  const config: RepoConfig = {};

  if (typeof raw.pipeline === "string") {
    config.pipeline = raw.pipeline;
  }

  if (Array.isArray(raw.setup) && raw.setup.every((s) => typeof s === "string")) {
    config.setup = raw.setup as string[];
  }

  if (Array.isArray(raw.teardown) && raw.teardown.every((s) => typeof s === "string")) {
    config.teardown = raw.teardown as string[];
  }

  if (Array.isArray(raw.test) && raw.test.every((s) => typeof s === "string")) {
    config.test = raw.test as string[];
  }

  if (raw.ports && typeof raw.ports === "object" && !Array.isArray(raw.ports)) {
    const ports: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw.ports as Record<string, unknown>)) {
      if (typeof value === "number") ports[name] = value;
    }
    if (Object.keys(ports).length > 0) config.ports = ports;
  }

  if (Array.isArray(raw.stage_order) && raw.stage_order.every((s) => typeof s === "string")) {
    config.stage_order = raw.stage_order as string[];
  }

  if (raw.workspace && typeof raw.workspace === "object" && !Array.isArray(raw.workspace)) {
    const workspaceRaw = raw.workspace as Record<string, unknown>;
    const workspace: RepoWorkspaceConfig = {};

    if (workspaceRaw.env && typeof workspaceRaw.env === "object" && !Array.isArray(workspaceRaw.env)) {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(workspaceRaw.env as Record<string, unknown>)) {
        if (typeof value === "string") {
          env[name] = value;
        }
      }
      if (Object.keys(env).length > 0) {
        workspace.env = env;
      }
    }

    if (workspaceRaw.path && typeof workspaceRaw.path === "object" && !Array.isArray(workspaceRaw.path)) {
      const pathRaw = workspaceRaw.path as Record<string, unknown>;
      const pathConfig: RepoWorkspacePathConfig = {};

      if (Array.isArray(pathRaw.prepend)) {
        const prepend = pathRaw.prepend.filter((entry): entry is string => typeof entry === "string");
        if (prepend.length > 0) {
          pathConfig.prepend = prepend;
        }
      }

      if (Array.isArray(pathRaw.append)) {
        const append = pathRaw.append.filter((entry): entry is string => typeof entry === "string");
        if (append.length > 0) {
          pathConfig.append = append;
        }
      }

      if (Object.keys(pathConfig).length > 0) {
        workspace.path = pathConfig;
      }
    }

    if (Object.keys(workspace).length > 0) {
      config.workspace = workspace;
    }
  }

  return config;
}
