import { chmod, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import { waitForBuffyIdToken } from "./firebaseAuth";
import { runCommand } from "./processes";
import type { RemoteHarness } from "./harness";
import type { TaskTerminalStreamEvent, TaskTerminalSubscription } from "../../../apps/mobile/src/lib/api/client";

const execFileAsync = promisify(execFile);

interface RelayMessage extends Record<string, unknown> {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  payload?: unknown;
}

interface RelayEventMessage extends RelayMessage {
  type: "event";
  name: string;
  payload: Record<string, unknown>;
}

interface CreatedTaskResponse {
  taskId: string;
  repoId: string;
  title: string;
  stage: string;
  agentType: string;
  worktreePath?: string | null;
}

interface CreatedRepoResponse {
  id: string;
}

export interface ScriptedTask {
  taskId: string;
  repoId: string;
  worktreePath: string | null;
}

export interface PipelineItemRow {
  activity: string | null;
  notified_at: string | null;
}

export interface RawRelayClient {
  close(): void;
  send(message: Record<string, unknown>): void;
  waitFor(predicate: (message: RelayMessage) => boolean, timeoutMs?: number): Promise<RelayMessage>;
}

export interface TerminalEventCollector {
  close(): void;
  outputText(): string;
  waitForExit(expectedCode: number, timeoutMs?: number): Promise<void>;
  waitForOutput(marker: string, timeoutMs?: number): Promise<string>;
}

export async function connectRawRelayClient(harness: RemoteHarness): Promise<RawRelayClient> {
  const token = await waitForBuffyIdToken(harness.ports.auth, 10_000);
  const socket = new WebSocket(`ws://127.0.0.1:${harness.ports.relay}`);
  const client = new RawRelayClientImpl(socket);
  await client.waitUntilOpen();
  client.send({ type: "auth", id_token: token });
  await client.waitFor((message) => message.type === "auth_ok", 5_000);
  return client;
}

export async function createScriptedTask(
  harness: RemoteHarness,
  options: { displayName: string; notifyTaskId?: string }
): Promise<ScriptedTask> {
  const repoPath = join(
    harness.paths.root,
    `scripted-repo-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await writeScriptedRepo(repoPath);

  const repo = asCreatedRepo(await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method: "POST",
    path: "/v1/repos",
    body: {
      path: repoPath,
      name: options.displayName
    }
  }));

  const task = asCreatedTask(await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method: "POST",
    path: "/v1/tasks",
    body: {
      repoId: repo.id,
      prompt: `Run deterministic scripted task for ${options.displayName}`,
      displayName: options.displayName,
      agentProvider: "codex",
      agentType: "pty",
      notifyTaskId: options.notifyTaskId
    }
  }));

  return {
    taskId: task.taskId,
    repoId: repo.id,
    worktreePath: task.worktreePath ?? null
  };
}

export function collectTerminalEvents(
  harness: RemoteHarness,
  taskId: string
): TerminalEventCollector {
  return new TerminalEventCollectorImpl(harness, taskId);
}

export async function waitForTerminalOutput(
  collector: TerminalEventCollector,
  marker: string,
  timeoutMs = 10_000
): Promise<string> {
  return collector.waitForOutput(marker, timeoutMs);
}

export async function waitForRelayEvent(
  client: RawRelayClient,
  name: string,
  sessionId: string,
  payloadPredicate: (payload: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 10_000
): Promise<RelayEventMessage> {
  const message = await client.waitFor((candidate) => {
    if (!isRelayEvent(candidate) || candidate.name !== name) {
      return false;
    }
    return candidate.payload.session_id === sessionId && payloadPredicate(candidate.payload);
  }, timeoutMs);
  if (!isRelayEvent(message)) {
    throw new Error(`expected relay event ${name}`);
  }
  return message;
}

export async function expectNoRelayEvent(
  client: RawRelayClient,
  name: string,
  sessionId: string,
  payloadPredicate: (payload: Record<string, unknown>) => boolean,
  timeoutMs = 500
): Promise<void> {
  await client.waitFor((candidate) => {
    if (!isRelayEvent(candidate) || candidate.name !== name) {
      return false;
    }
    return candidate.payload.session_id === sessionId && payloadPredicate(candidate.payload);
  }, timeoutMs).then(
    (message) => {
      throw new Error(`unexpected relay event ${JSON.stringify(message)}`);
    },
    () => undefined
  );
}

export function decodedOutput(payload: Record<string, unknown>): string {
  const dataB64 = typeof payload.data_b64 === "string" ? payload.data_b64 : "";
  return Buffer.from(dataB64, "base64").toString("utf8");
}

export async function readPipelineItem(
  harness: RemoteHarness,
  taskId: string
): Promise<PipelineItemRow> {
  const sql = `SELECT activity, notified_at FROM pipeline_item WHERE id = ${sqliteString(taskId)};`;
  const { stdout } = await execFileAsync("sqlite3", ["-json", harness.paths.dbPath, sql], {
    cwd: harness.repoRoot,
    env: process.env
  });
  const rows = JSON.parse(stdout.trim() || "[]") as unknown;
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) {
    throw new Error(`pipeline_item row not found for ${taskId}: ${stdout}`);
  }
  return {
    activity: typeof rows[0].activity === "string" ? rows[0].activity : null,
    notified_at: typeof rows[0].notified_at === "string" ? rows[0].notified_at : null
  };
}

class RawRelayClientImpl implements RawRelayClient {
  private readonly messages: RelayMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: RelayMessage) => boolean;
    resolve(message: RelayMessage): void;
  }> = [];

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      const message = parseRelayMessage(data);
      if (!message) {
        return;
      }
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
  }

  async waitUntilOpen(timeoutMs = 5_000): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out opening relay socket")), timeoutMs);
      this.socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("relay socket error"));
      });
    });
  }

  close(): void {
    this.socket.close();
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(
    predicate: (message: RelayMessage) => boolean,
    timeoutMs = 5_000
  ): Promise<RelayMessage> {
    const existing = this.messages.find(predicate);
    if (existing) {
      return existing;
    }
    return await new Promise<RelayMessage>((resolve, reject) => {
      const waiter = { predicate, resolve };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("timed out waiting for relay message"));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
  }
}

class TerminalEventCollectorImpl implements TerminalEventCollector {
  private readonly chunks: string[] = [];
  private readonly outputWaiters: Array<{
    marker: string;
    resolve(output: string): void;
  }> = [];
  private readonly exitWaiters: Array<{
    expectedCode: number;
    resolve(): void;
    reject(error: Error): void;
  }> = [];
  private exitCode: number | null = null;
  private readonly subscription: TaskTerminalSubscription;

  constructor(harness: RemoteHarness, private readonly taskId: string) {
    this.subscription = harness.client.observeTaskTerminal({
      desktopId: harness.desktopId,
      taskId
    }, (event) => this.onEvent(event));
  }

  close(): void {
    this.subscription.close();
  }

  outputText(): string {
    return this.chunks.join("");
  }

  async waitForOutput(marker: string, timeoutMs = 10_000): Promise<string> {
    const current = this.outputText();
    if (current.includes(marker)) {
      return current;
    }
    return await new Promise<string>((resolve, reject) => {
      const waiter = { marker, resolve };
      const timeout = setTimeout(() => {
        const index = this.outputWaiters.indexOf(waiter);
        if (index >= 0) {
          this.outputWaiters.splice(index, 1);
        }
        reject(new Error(`timed out waiting for terminal output ${marker} from ${this.taskId}`));
      }, timeoutMs);
      this.outputWaiters.push({
        marker,
        resolve: (output) => {
          clearTimeout(timeout);
          resolve(output);
        }
      });
    });
  }

  async waitForExit(expectedCode: number, timeoutMs = 10_000): Promise<void> {
    if (this.exitCode !== null) {
      if (this.exitCode !== expectedCode) {
        throw new Error(`expected exit ${expectedCode}, got ${this.exitCode}`);
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { expectedCode, resolve, reject };
      const timeout = setTimeout(() => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) {
          this.exitWaiters.splice(index, 1);
        }
        reject(new Error(`timed out waiting for terminal exit from ${this.taskId}`));
      }, timeoutMs);
      this.exitWaiters.push({
        expectedCode,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private onEvent(event: TaskTerminalStreamEvent): void {
    switch (event.type) {
      case "output": {
        this.chunks.push(Buffer.from(event.dataB64, "base64").toString("utf8"));
        const output = this.outputText();
        for (const waiter of [...this.outputWaiters]) {
          if (output.includes(waiter.marker)) {
            this.outputWaiters.splice(this.outputWaiters.indexOf(waiter), 1);
            waiter.resolve(output);
          }
        }
        return;
      }
      case "exit": {
        this.exitCode = event.code;
        for (const waiter of [...this.exitWaiters]) {
          this.exitWaiters.splice(this.exitWaiters.indexOf(waiter), 1);
          if (event.code === waiter.expectedCode) {
            waiter.resolve();
          } else {
            waiter.reject(new Error(`expected exit ${waiter.expectedCode}, got ${event.code}`));
          }
        }
        return;
      }
      case "error": {
        const error = new Error(event.message);
        for (const waiter of [...this.exitWaiters]) {
          this.exitWaiters.splice(this.exitWaiters.indexOf(waiter), 1);
          waiter.reject(error);
        }
        return;
      }
      case "ready":
        return;
    }
  }
}

async function writeScriptedRepo(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, ".kanna"), { recursive: true });
  await mkdir(join(repoPath, "bin"), { recursive: true });
  await writeFile(
    join(repoPath, ".kanna", "config.json"),
    JSON.stringify({
      setup: ["export PATH=\"$PWD/bin:$PATH\""],
      workspace: {
        path: {
          prepend: ["bin"]
        }
      }
    }, null, 2)
  );
  await writeFile(join(repoPath, "README.md"), "# Remote E2E scripted repo\n");
  const codexPath = join(repoPath, "bin", "codex");
  await writeFile(codexPath, scriptedAgentSource());
  await chmod(codexPath, 0o755);
  await runCommand("git", ["init"], { cwd: repoPath, env: process.env });
  await runCommand("git", ["add", "."], { cwd: repoPath, env: process.env });
  await runCommand("git", [
    "-c",
    "user.email=remote-e2e@example.invalid",
    "-c",
    "user.name=Remote E2E",
    "commit",
    "-m",
    "Initial scripted repo"
  ], { cwd: repoPath, env: process.env });
}

function scriptedAgentSource(): string {
  return `#!/bin/sh
printf 'SCRIPT_READY\\n'
(
  i=0
  while true; do
    i=$((i + 1))
    printf 'SCRIPT_HEARTBEAT %s\\n' "$i"
    sleep 0.25
  done
) &
heartbeat_pid=$!
trap 'kill "$heartbeat_pid" 2>/dev/null || true' EXIT
while IFS= read -r line; do
  printf 'SCRIPT_INPUT:%s\\n' "$line"
  case "$line" in
    *exit-zero*)
      printf 'SCRIPT_EXITING\\n'
      exit 0
      ;;
    *exit-one*)
      printf 'SCRIPT_FAILING\\n'
      exit 7
      ;;
  esac
done
`;
}

function asCreatedRepo(value: unknown): CreatedRepoResponse {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error(`unexpected repo response ${JSON.stringify(value)}`);
  }
  return { id: value.id };
}

function asCreatedTask(value: unknown): CreatedTaskResponse {
  if (
    !isRecord(value) ||
    typeof value.taskId !== "string" ||
    typeof value.repoId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.stage !== "string" ||
    typeof value.agentType !== "string"
  ) {
    throw new Error(`unexpected task response ${JSON.stringify(value)}`);
  }
  return {
    taskId: value.taskId,
    repoId: value.repoId,
    title: value.title,
    stage: value.stage,
    agentType: value.agentType,
    worktreePath: typeof value.worktreePath === "string" ? value.worktreePath : null
  };
}

function parseRelayMessage(data: RawData): RelayMessage | null {
  const raw = rawDataToString(data);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}

function isRelayEvent(message: RelayMessage): message is RelayEventMessage {
  return (
    message.type === "event" &&
    typeof message.name === "string" &&
    isRecord(message.payload)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(message);
}
