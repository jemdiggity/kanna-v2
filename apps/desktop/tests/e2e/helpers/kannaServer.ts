import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { tauriInvoke } from "./vue";
import type { WebDriverClient } from "./webdriver";
import { localProcessFetch } from "@kanna/local-process-fetch";

const execFileAsync = promisify(execFile);

export interface TestKannaServer {
  baseUrl: string;
  child: ChildProcessWithoutNullStreams;
}

export interface AppKannaServer {
  baseUrl: string;
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function resolveKannaServerBinary(): Promise<string> {
  const repoRoot = join(process.cwd(), "../..");
  const explicitBinary = process.env.KANNA_E2E_KANNA_SERVER_BINARY;
  if (explicitBinary) {
    if (await stat(explicitBinary).then((stats) => stats.isFile()).catch(() => false)) {
      return explicitBinary;
    }
    throw new Error(`KANNA_E2E_KANNA_SERVER_BINARY does not point to a file: ${explicitBinary}`);
  }

  const hostTarget = await resolveRustHostTarget();
  const hostCandidates = [
    join(repoRoot, ".build", hostTarget, "debug", "kanna-server"),
    join(process.cwd(), "src-tauri", "binaries", `kanna-server-${hostTarget}`),
  ];
  const hostMatches = await existingFiles(hostCandidates);
  if (hostMatches.length > 0) {
    hostMatches.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return hostMatches[0].path;
  }

  const fallbackCandidates = [
    join(repoRoot, ".build", "debug", "kanna-server"),
    join(process.cwd(), "src-tauri", "binaries", "kanna-server-aarch64-apple-darwin"),
    join(process.cwd(), "src-tauri", "binaries", "kanna-server-x86_64-apple-darwin"),
    join(repoRoot, ".build", "aarch64-apple-darwin", "debug", "kanna-server"),
    join(repoRoot, ".build", "x86_64-apple-darwin", "debug", "kanna-server"),
  ];
  for (const candidate of fallbackCandidates) {
    if (await stat(candidate).then((stats) => stats.isFile()).catch(() => false)) {
      return candidate;
    }
  }
  throw new Error(`kanna-server sidecar not found in ${[...hostCandidates, ...fallbackCandidates].join(", ")}`);
}

async function resolveRustHostTarget(): Promise<string> {
  const output = await execFileAsync("rustc", ["-vV"])
    .then(({ stdout }) => stdout)
    .catch(() => "");
  const hostLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("host:"));
  const hostTarget = hostLine?.replace("host:", "").trim();
  if (hostTarget) return hostTarget;
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  return `${process.arch}-${process.platform}`;
}

async function existingFiles(paths: string[]): Promise<Array<{ path: string; mtimeMs: number }>> {
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const path of paths) {
    const stats = await stat(path).catch(() => null);
    if (stats?.isFile()) {
      matches.push({ path, mtimeMs: stats.mtimeMs });
    }
  }
  return matches;
}

export async function startTestKannaServer(
  client: WebDriverClient,
  configDir: string,
): Promise<TestKannaServer> {
  const appDataDir = await tauriInvoke(client, "get_app_data_dir") as string;
  const dbName = await tauriInvoke(client, "read_env_var", { name: "KANNA_DB_NAME" }) as string;
  const daemonDir = process.env.KANNA_DAEMON_DIR;
  if (!daemonDir) throw new Error("KANNA_DAEMON_DIR is required for server E2E");

  const port = await findFreePort();
  const relayUrl = process.env.KANNA_RELAY_URL?.trim() ||
    (process.env.KANNA_RELAY_PORT ? `ws://127.0.0.1:${process.env.KANNA_RELAY_PORT}` : "");
  const configPath = join(configDir, "server-api-e2e.toml");
  const pairingStorePath = join(configDir, "server-api-e2e-pairings.json");
  await writeFile(
    configPath,
    [
      `relay_url = "${escapeTomlString(relayUrl)}"`,
      'device_token = "e2e-token"',
      `daemon_dir = "${escapeTomlString(daemonDir)}"`,
      `db_path = "${escapeTomlString(join(appDataDir, dbName))}"`,
      'desktop_id = "desktop-e2e"',
      'desktop_name = "Kanna E2E"',
      'lan_host = "127.0.0.1"',
      `lan_port = ${port}`,
      `pairing_store_path = "${escapeTomlString(pairingStorePath)}"`,
      "",
    ].join("\n"),
  );

  const child = spawn(await resolveKannaServerBinary(), [], {
    env: { ...process.env, KANNA_SERVER_CONFIG: configPath },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`kanna-server exited early with code ${child.exitCode}: ${stderr}`);
    }
    const response = await localProcessFetch(`${baseUrl}/v1/status`).catch(() => null);
    if (response?.ok) return { baseUrl, child };
    await sleep(250);
  }

  child.kill();
  throw new Error(`timed out waiting for kanna-server at ${baseUrl}: ${stderr}`);
}

export async function resolveAppKannaServer(client: WebDriverClient): Promise<AppKannaServer> {
  await tauriInvoke(client, "ensure_mobile_server");
  const status = await tauriInvoke(client, "mobile_server_status") as {
    lanPort?: number | string | null;
    lan_port?: number | string | null;
  };
  const port = status.lanPort ?? status.lan_port ??
    (await tauriInvoke(client, "read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" })
      .catch(() => "48120"));
  const normalizedPort = String(port ?? "").trim() || "48120";
  return { baseUrl: `http://127.0.0.1:${normalizedPort}` };
}
