export interface RepoConfig {
  setup?: string[];
  teardown?: string[];
  ports?: Record<string, number>;
}

export function parseRepoConfig(json: string): RepoConfig {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const config: RepoConfig = {};

  if (Array.isArray(raw.setup) && raw.setup.every((s) => typeof s === "string")) {
    config.setup = raw.setup as string[];
  }

  if (Array.isArray(raw.teardown) && raw.teardown.every((s) => typeof s === "string")) {
    config.teardown = raw.teardown as string[];
  }

  if (raw.ports && typeof raw.ports === "object" && !Array.isArray(raw.ports)) {
    const ports: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw.ports as Record<string, unknown>)) {
      if (typeof value === "number") ports[name] = value;
    }
    if (Object.keys(ports).length > 0) config.ports = ports;
  }

  return config;
}
