import { networkInterfaces } from "node:os";

export function detectLanHost(env: NodeJS.ProcessEnv): string {
  if (env.KANNA_MOBILE_SERVER_HOST?.trim()) {
    return env.KANNA_MOBILE_SERVER_HOST;
  }

  const interfaces = networkInterfaces();
  for (const name of ["en0", "en1"]) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return "127.0.0.1";
}

export function resolveMobileServerUrl(env: NodeJS.ProcessEnv): string {
  return `http://${detectLanHost(env)}:${env.KANNA_MOBILE_SERVER_PORT ?? "48120"}`;
}
