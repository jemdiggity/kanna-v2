import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { localProcessFetch } from "@kanna/local-process-fetch";

/**
 * Launch and drive a real `kanna-worker`, the way an operator's machine runs
 * one.
 *
 * The lane deliberately does **not** start the daemon or the server itself:
 * proving they come up, get authorized and are restarted correctly is the
 * point, and a harness that spawned them would prove none of it.
 *
 * Every request goes through `@kanna/local-process-fetch`. That is not a
 * convenience — undici sends `Sec-Fetch-*` headers, which `lan_trust`
 * classifies as browser-originated and refuses without this desktop's control
 * credential.
 */

export const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export function binary(name: string): string {
  const path = join(repoRoot, ".build", "debug", name);
  if (!existsSync(path)) {
    throw new Error(
      `${name} is missing at ${path}; this lane drives real binaries, so build them first: ` +
        `cargo build -p kanna-worker -p kanna-daemon -p kanna-server -p kanna-cli`,
    );
  }
  return path;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("could not allocate a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

export type Run = { code: number | null; stdout: string; stderr: string };

export async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

/** Everything needed to launch a supervisor again for the same instance. */
export interface WorkerLaunch {
  root: string;
  dataDir: string;
  dbPath: string;
  lanPort: number;
  transferPort: number;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export class Worker {
  private child: ChildProcess;

  private constructor(
    child: ChildProcess,
    readonly launch: WorkerLaunch,
    readonly dataDir: string,
    readonly baseUrl: string,
    readonly env: NodeJS.ProcessEnv,
    private readonly log: string[],
  ) {
    this.child = child;
  }

  static async start(providerBinDir: string): Promise<Worker> {
    const root = await mkdtemp(join(tmpdir(), "kanna-headless-"));
    const dataDir = join(root, "worker");
    const lanPort = await freePort();
    const transferPort = await freePort();
    // Its own XDG roots, so the lane never touches this machine's real
    // database, daemon socket or transfer registry.
    const xdgData = join(root, "xdg-data");
    const xdgRuntime = join(root, "xdg-runtime");
    await mkdir(xdgData, { recursive: true });
    await mkdir(xdgRuntime, { recursive: true, mode: 0o700 });

    // Every inherited `KANNA_*` variable is dropped, not just the obvious
    // ones. A lane run from inside a Kanna task inherits that task's own
    // identity, socket, server URL and completion context; `stage-complete`
    // reading the *outer* task's completion context is how this lane first
    // tried to finish the session that was running it. The daemon applies the
    // same rule to every child it spawns, for the same reason.
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("KANNA_")),
    );
    env.PATH = providerPath(providerBinDir, process.env.PATH);
    env.XDG_DATA_HOME = xdgData;
    env.XDG_RUNTIME_DIR = xdgRuntime;
    // The gate asserts durable rows, never terminal scrapings.
    env.KANNA_E2E_TEST_SQL = "1";

    const dbPath = join(root, "kanna-gate.db");
    const args = [
      "run",
      "--data-dir",
      dataDir,
      // An explicit database, always. macOS resolves application data from
      // `~/Library/Application Support` and ignores XDG entirely, so without
      // this the lane would open (and write to) the developer's real Kanna
      // database.
      "--db-path",
      dbPath,
      "--lan-port",
      String(lanPort),
      "--transfer-port",
      String(transferPort),
    ];
    const launch: WorkerLaunch = {
      root,
      dataDir,
      dbPath,
      lanPort,
      transferPort,
      args,
      env,
    };

    const log: string[] = [];
    const child = spawnSupervisor(launch, log);
    const worker = new Worker(
      child,
      launch,
      dataDir,
      `http://127.0.0.1:${lanPort}`,
      env,
      log,
    );
    await waitFor(
      async () => (await worker.status()) !== null,
      () => `kanna-worker never served ${worker.baseUrl}\n${worker.output()}`,
    );
    return worker;
  }

  output(): string {
    return this.log.join("");
  }

  /** The supervisor's own pid. */
  get supervisorPid(): number {
    return this.child.pid ?? -1;
  }

  /**
   * Kill the supervisor outright, the way a crash or an OOM kill does.
   *
   * The daemon and the server survive, reparented to init — which is exactly
   * the state the next supervisor has to cope with.
   */
  async killSupervisor(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) return;
    const exited = new Promise<void>((done) => this.child.once("exit", () => done()));
    process.kill(pid, "SIGKILL");
    await exited;
  }

  /** Start another supervisor for this same instance: same dirs, db and ports. */
  async relaunch(): Promise<void> {
    this.child = spawnSupervisor(this.launch, this.log);
    await waitFor(
      async () => (await this.status()) !== null,
      () => `the replacement kanna-worker never served ${this.baseUrl}\n${this.output()}`,
    );
  }

  async status(): Promise<Record<string, unknown> | null> {
    try {
      const response = await localProcessFetch(`${this.baseUrl}/v1/status`);
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** The daemon generation currently serving, as the daemon itself published it. */
  async daemonPid(): Promise<number> {
    return Number.parseInt(
      (await readFile(join(this.dataDir, "daemon.pid"), "utf8")).trim(),
      10,
    );
  }

  async serverPid(): Promise<number> {
    return this.childPid("kanna-server");
  }

  private async childPid(name: string): Promise<number> {
    const listing = await run("/bin/ps", ["-eo", "pid,ppid,args"], process.env);
    const children = listing.stdout
      .split("\n")
      .map((entry) => entry.trim().split(/\s+/))
      .filter((fields) => fields[1] === String(this.child.pid));
    const line = children.find((fields) => fields.slice(2).join(" ").includes(name));
    if (!line) {
      throw new Error(
        `no ${name} child of ${this.child.pid}; its children are ` +
          `${JSON.stringify(children.map((fields) => fields.slice(2).join(" ")))}`,
      );
    }
    return Number.parseInt(line[0]!, 10);
  }

  /** Spawn a replacement daemon; live sessions hand off to it. */
  reload(): void {
    process.kill(this.child.pid!, "SIGHUP");
  }

  async cli(args: string[]): Promise<Run> {
    return run(binary("kanna-cli"), args, {
      ...this.env,
      KANNA_SERVER_BASE_URL: this.baseUrl,
    });
  }

  async api(path: string, init?: RequestInit): Promise<Response> {
    return localProcessFetch(`${this.baseUrl}${path}`, init);
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.api(path, init);
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async sql(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    const response = await this.api("/v1/e2e/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, params, query: true }),
    });
    if (!response.ok) {
      throw new Error(`e2e sql failed (${response.status}): ${await response.text()}`);
    }
    return ((await response.json()) as { rows: Array<Record<string, unknown>> }).rows;
  }

  async stop(): Promise<void> {
    // SIGTERM stops only the server, by design, so the daemon is torn down
    // explicitly — the same two steps an operator would take.
    await run(binary("kanna-worker"), ["stop-daemon", "--data-dir", this.dataDir], this.env);
    if (this.child.exitCode === null && this.child.pid !== undefined) {
      const exited = new Promise<void>((done) => this.child.once("exit", () => done()));
      this.child.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
    await rm(this.launch.root, { recursive: true, force: true });
  }
}

/**
 * PATH for the worker, with the host's own agent CLIs removed.
 *
 * `kanna-server` resolves a provider by name, so a developer's real `claude`
 * earlier on PATH would be spawned instead of the scripted one and the gate
 * would spend a model turn on every assertion. Only directories that actually
 * hold a provider CLI are dropped, so ordinary tooling survives.
 */
export function providerPath(
  providerBinDir: string,
  existingPath: string | undefined,
  holdsProvider: (directory: string) => boolean = (directory) =>
    AGENT_PROVIDER_EXECUTABLES.some((executable) => existsSync(join(directory, executable))),
): string {
  const entries = (existingPath ?? "")
    .split(":")
    .filter((entry) => entry.length > 0 && entry !== providerBinDir)
    .filter((entry) => !holdsProvider(entry));
  return [providerBinDir, ...entries].join(":");
}

/** Every provider executable `kanna-server` probes. */
export const AGENT_PROVIDER_EXECUTABLES = ["claude", "codex", "copilot", "opencode", "agy"];

function spawnSupervisor(launch: WorkerLaunch, log: string[]): ChildProcess {
  const child = spawn(binary("kanna-worker"), launch.args, {
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => log.push(String(chunk)));
  child.stderr?.on("data", (chunk) => log.push(String(chunk)));
  return child;
}

/** Is that pid still there? */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pids holding a listening socket on `port`.
 *
 * Deliberately the same question `kanna-server-process` answers for the
 * supervisor: "who is actually listening", not "who is named kanna-server".
 */
export async function listenersOnPort(port: number): Promise<number[]> {
  if (process.platform === "linux") {
    const listing = await run("/bin/ss", ["-lptnH", `sport = :${port}`], process.env);
    return [...listing.stdout.matchAll(/pid=(\d+)/g)]
      .map((match) => Number.parseInt(match[1]!, 10))
      .filter((pid, index, all) => all.indexOf(pid) === index);
  }
  const listing = await run(
    "/usr/sbin/lsof",
    ["-nP", "-ti", `TCP:${port}`, "-sTCP:LISTEN"],
    process.env,
  );
  return listing.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid));
}

export async function waitFor(
  condition: () => Promise<boolean>,
  message: string | (() => string | Promise<string>),
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${typeof message === "string" ? message : await message()}`);
}

export async function writeExecutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { mode: 0o755 });
}
