import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import { runCommand } from "./processes";
import {
  SCRIPTED_AGENT_SNAPSHOT_HISTORY_SENTINEL,
  writeScriptedAgentBinary,
  type ScriptedAgentOptions,
} from "./scriptedAgent";
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
  sendInput(dataB64: string, submissionBoundary?: boolean, controlInput?: boolean): void;
  waitForExit(expectedCode: number, timeoutMs?: number): Promise<void>;
  waitForOutput(marker: string, timeoutMs?: number): Promise<string>;
  /** Wait for a snapshot produced after this call, never one retained from
   * fixture setup or this observer's own attach. */
  waitForNewSnapshot(
    expectation: TerminalSnapshotExpectation,
    timeoutMs?: number,
  ): Promise<ObservedTerminalSnapshot>;
  waitForSnapshot(
    expectation: TerminalSnapshotExpectation,
    timeoutMs?: number,
  ): Promise<ObservedTerminalSnapshot>;
}

export interface TerminalSnapshotExpectation {
  cols?: number;
  maxEncodedChars?: number;
  minEncodedChars: number;
  minRetainedScrollbackLines?: number;
  rows?: number;
  sentinel: string;
}

export interface ObservedTerminalSnapshot {
  cols: number;
  dataB64: string;
  rows: number;
  scrollbackLines: number;
}

export async function connectRawRelayClient(harness: RemoteHarness): Promise<RawRelayClient> {
  const token = await harness.getIdToken();
  const socket = new WebSocket(harness.relayUrl);
  const client = new RawRelayClientImpl(socket);
  await client.waitUntilOpen();
  client.send({ type: "auth", id_token: token });
  await client.waitFor((message) => message.type === "auth_ok", 5_000);
  return client;
}

export async function createScriptedTask(
  harness: RemoteHarness,
  options: {
    displayName: string;
    inputTraceFile?: string;
    prompt?: string;
    repoName?: string;
    redactInput?: boolean;
    setupCommands?: string[];
    snapshotHistory?: ScriptedAgentOptions["snapshotHistory"];
    terminalPasteSemantics?: boolean;
    terminalCols?: number;
    terminalRows?: number;
    terminalKeyTraceFile?: string;
    tracePartialInput?: boolean;
    traceTerminalKeys?: boolean;
    waitingPromptSnippet?: string;
    agentProvider?: "claude" | "codex";
  }
): Promise<ScriptedTask> {
  const repoPath = join(
    harness.paths.root,
    `scripted-repo-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await writeScriptedRepo(repoPath, {
    inputTraceFile: options.inputTraceFile,
    redactInput: options.redactInput,
    setupCommands: options.setupCommands,
    snapshotHistory: options.snapshotHistory,
    terminalPasteSemantics: options.terminalPasteSemantics,
    terminalKeyTraceFile: options.terminalKeyTraceFile,
    tracePartialInput: options.tracePartialInput,
    traceTerminalKeys: options.traceTerminalKeys,
  });

  const repo = asCreatedRepo(await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method: "POST",
    path: "/v1/repos",
    body: {
      path: repoPath,
      name: options.repoName ?? options.displayName
    }
  }));

  const basePrompt =
    options.prompt ?? `Run deterministic scripted task for ${options.displayName}`;
  const taskPrompt = options.snapshotHistory
    ? `${basePrompt}\n${SCRIPTED_AGENT_SNAPSHOT_HISTORY_SENTINEL}`
    : basePrompt;
  const task = asCreatedTask(await harness.client.invokeDesktop({
    desktopId: harness.desktopId,
    method: "POST",
    path: "/v1/tasks",
    body: {
      repoId: repo.id,
      prompt: taskPrompt,
      displayName: options.displayName,
      agentProvider: options.agentProvider ?? "codex",
      agentType: "pty",
      ...(options.terminalCols === undefined
        ? {}
        : { terminalCols: options.terminalCols }),
      ...(options.terminalRows === undefined
        ? {}
        : { terminalRows: options.terminalRows })
    }
  }));

  if (options.waitingPromptSnippet !== undefined) {
    const sql = [
      "PRAGMA busy_timeout=5000;",
      "UPDATE pipeline_item",
      `SET last_output_preview = ${sqliteString(options.waitingPromptSnippet)}, updated_at = datetime('now')`,
      `WHERE id = ${sqliteString(task.taskId)};`
    ].join(" ");
    await execFileAsync("sqlite3", [harness.paths.dbPath, sql], {
      cwd: harness.repoRoot,
      env: process.env
    });
  }

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

const SINGLE_STAGE_WORKFLOW = "remote-single-stage";

/// Pin the task to a one-stage workflow with no post, so advancing the stage
/// moves straight past the final stage and closes the task. The built-in
/// workflows interpose commit/approve posts that would need real agents to
/// satisfy; the scripted agent only echoes.
export async function pinSingleStageWorkflow(
  harness: RemoteHarness,
  taskId: string
): Promise<void> {
  const definition = JSON.stringify({
    name: SINGLE_STAGE_WORKFLOW,
    stages: [{ name: "in progress", transition: "manual", prompt: "$TASK_PROMPT" }]
  });
  const sql = [
    "PRAGMA busy_timeout=5000;",
    "UPDATE pipeline_item",
    `SET pipeline = ${sqliteString(SINGLE_STAGE_WORKFLOW)}, pipeline_def = ${sqliteString(definition)}`,
    `WHERE id = ${sqliteString(taskId)};`,
    "UPDATE stage_run SET completion_transition = 'manual'",
    `WHERE task_id = ${sqliteString(taskId)} AND kind = 'main' AND status = 'running';`
  ].join(" ");
  await execFileAsync("sqlite3", [harness.paths.dbPath, sql], {
    cwd: harness.repoRoot,
    env: process.env
  });
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

export async function registerLegacyNotifyTarget(
  harness: RemoteHarness,
  childTaskId: string,
  targetTaskId: string
): Promise<void> {
  const sql = [
    "PRAGMA busy_timeout=5000;",
    "UPDATE pipeline_item",
    `SET notify_task_id = ${sqliteString(targetTaskId)}, notified_at = NULL`,
    `WHERE id = ${sqliteString(childTaskId)};`
  ].join(" ");
  await execFileAsync("sqlite3", [harness.paths.dbPath, sql], {
    cwd: harness.repoRoot,
    env: process.env
  });
}

export async function taskInputCount(
  harness: RemoteHarness,
  taskId: string
): Promise<number> {
  const sql = `SELECT COUNT(*) AS count FROM task_input WHERE task_id = ${sqliteString(taskId)};`;
  const { stdout } = await execFileAsync("sqlite3", ["-json", harness.paths.dbPath, sql], {
    cwd: harness.repoRoot,
    env: process.env
  });
  const rows = JSON.parse(stdout.trim() || "[]") as unknown;
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) {
    throw new Error(`task_input count unavailable for ${taskId}: ${stdout}`);
  }
  return typeof rows[0].count === "number" ? rows[0].count : Number(rows[0].count);
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
        reject(new Error(`timed out waiting for relay message; received:\n${this.describeMessages()}`));
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

  private describeMessages(): string {
    if (this.messages.length === 0) {
      return "(none)";
    }
    return this.messages
      .map((message, index) => `${index + 1}. ${describeRelayMessage(message)}`)
      .join("\n")
      .slice(0, 4_000);
  }
}

class TerminalEventCollectorImpl implements TerminalEventCollector {
  private chunks: string[] = [];
  private lastSnapshot: ObservedTerminalSnapshot | null = null;
  private readonly outputWaiters: Array<{
    marker: string;
    resolve(output: string): void;
  }> = [];
  private readonly snapshotWaiters: Array<{
    expectation: TerminalSnapshotExpectation;
    minimumSequence: number;
    resolve(snapshot: ObservedTerminalSnapshot): void;
  }> = [];
  private snapshotSequence = 0;
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

  sendInput(dataB64: string, submissionBoundary = false, controlInput = false): void {
    if (controlInput) {
      this.subscription.sendInput?.(dataB64, false, true);
    } else if (submissionBoundary) {
      this.subscription.sendInput?.(dataB64, true);
    } else {
      this.subscription.sendInput?.(dataB64);
    }
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
        reject(new Error(
          `timed out waiting for terminal output ${marker} from ${this.taskId}; output so far:\n${this.outputText() || "(none)"}`
        ));
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

  async waitForSnapshot(
    expectation: TerminalSnapshotExpectation,
    timeoutMs = 10_000,
  ): Promise<ObservedTerminalSnapshot> {
    if (this.lastSnapshot && snapshotMatches(this.lastSnapshot, expectation)) {
      return this.lastSnapshot;
    }
    return await new Promise<ObservedTerminalSnapshot>((resolve, reject) => {
      const waiter = { expectation, minimumSequence: 0, resolve };
      const timeout = setTimeout(() => {
        const index = this.snapshotWaiters.indexOf(waiter);
        if (index >= 0) {
          this.snapshotWaiters.splice(index, 1);
        }
        const lastEncodedChars = this.lastSnapshot?.dataB64.length ?? 0;
        const lastDimensions = this.lastSnapshot
          ? `${this.lastSnapshot.cols}x${this.lastSnapshot.rows}`
          : "none";
        reject(new Error(
          `timed out waiting for terminal snapshot from ${this.taskId}; ` +
            `last encoded length=${lastEncodedChars}, dimensions=${lastDimensions}; ` +
            `expected >${expectation.minEncodedChars} chars` +
            `${expectation.cols === undefined || expectation.rows === undefined
              ? ""
              : ` at ${expectation.cols}x${expectation.rows}`} with ` +
            expectation.sentinel,
        ));
      }, timeoutMs);
      this.snapshotWaiters.push({
        expectation,
        minimumSequence: 0,
        resolve: (snapshot) => {
          clearTimeout(timeout);
          resolve(snapshot);
        },
      });
    });
  }

  async waitForNewSnapshot(
    expectation: TerminalSnapshotExpectation,
    timeoutMs = 10_000,
  ): Promise<ObservedTerminalSnapshot> {
    const minimumSequence = this.snapshotSequence + 1;
    return await new Promise<ObservedTerminalSnapshot>((resolve, reject) => {
      const waiter = { expectation, minimumSequence, resolve };
      const timeout = setTimeout(() => {
        const index = this.snapshotWaiters.indexOf(waiter);
        if (index >= 0) this.snapshotWaiters.splice(index, 1);
        reject(new Error(
          `timed out waiting for a new terminal snapshot from ${this.taskId}; ` +
            `last snapshot sequence=${this.snapshotSequence}`,
        ));
      }, timeoutMs);
      this.snapshotWaiters.push({
        expectation,
        minimumSequence,
        resolve: (snapshot) => {
          clearTimeout(timeout);
          resolve(snapshot);
        },
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
    if (process.env.KANNA_E2E_DEBUG_TERMINAL_EVENTS === "1") {
      const summary =
        event.type === "snapshot" || event.type === "output"
          ? JSON.stringify(Buffer.from(event.dataB64, "base64").toString("utf8").slice(0, 200))
          : JSON.stringify(event);
      console.log(`[collector ${this.taskId}] ${event.type} ${summary}`);
    }
    switch (event.type) {
      case "snapshot": {
        this.snapshotSequence += 1;
        const decoded = Buffer.from(event.dataB64, "base64").toString("utf8");
        this.chunks = [decoded];
        this.lastSnapshot = {
          cols: event.cols,
          dataB64: event.dataB64,
          rows: event.rows,
          scrollbackLines: event.window?.scrollbackLines ?? 0,
        };
        this.resolveOutputWaiters();
        for (const waiter of [...this.snapshotWaiters]) {
          if (
            this.snapshotSequence >= waiter.minimumSequence &&
            snapshotMatches(this.lastSnapshot, waiter.expectation)
          ) {
            this.snapshotWaiters.splice(this.snapshotWaiters.indexOf(waiter), 1);
            waiter.resolve(this.lastSnapshot);
          }
        }
        return;
      }
      case "output": {
        this.chunks.push(Buffer.from(event.dataB64, "base64").toString("utf8"));
        this.resolveOutputWaiters();
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
        this.snapshotWaiters.splice(0);
        return;
      }
    }
  }

  private resolveOutputWaiters(): void {
    const output = this.outputText();
    for (const waiter of [...this.outputWaiters]) {
      if (output.includes(waiter.marker)) {
        this.outputWaiters.splice(this.outputWaiters.indexOf(waiter), 1);
        waiter.resolve(output);
      }
    }
  }
}

function snapshotMatches(
  snapshot: ObservedTerminalSnapshot,
  expectation: TerminalSnapshotExpectation,
): boolean {
  return (
    (expectation.cols === undefined || snapshot.cols === expectation.cols) &&
    (expectation.rows === undefined || snapshot.rows === expectation.rows) &&
    snapshot.dataB64.length > expectation.minEncodedChars &&
    (expectation.maxEncodedChars === undefined ||
      snapshot.dataB64.length < expectation.maxEncodedChars) &&
    snapshot.scrollbackLines >=
      (expectation.minRetainedScrollbackLines ?? 0) &&
    Buffer.from(snapshot.dataB64, "base64")
      .toString("utf8")
      .includes(expectation.sentinel)
  );
}

async function writeScriptedRepo(
  repoPath: string,
  options: ScriptedAgentOptions & { setupCommands?: string[] } = {},
): Promise<void> {
  await mkdir(join(repoPath, ".kanna"), { recursive: true });
  await mkdir(join(repoPath, "bin"), { recursive: true });
  await writeFile(
    join(repoPath, ".kanna", "config.json"),
    JSON.stringify({
      setup: [
        "export PATH=\"$PWD/bin:$PATH\"",
        "codex() { \"$PWD/bin/codex\" \"$@\"; }",
        ...(options.setupCommands ?? [])
      ],
      workspace: {
        path: {
          prepend: ["bin"]
        }
      }
    }, null, 2)
  );
  await writeFile(join(repoPath, "README.md"), "# Remote E2E scripted repo\n");
  const codexPath = join(repoPath, "bin", "codex");
  await writeScriptedAgentBinary(codexPath, options);
  await runCommand("git", ["init", "-b", "main"], { cwd: repoPath, env: process.env });
  await runCommand("git", ["config", "user.email", "remote-e2e@example.invalid"], {
    cwd: repoPath,
    env: process.env
  });
  await runCommand("git", ["config", "user.name", "Remote E2E"], {
    cwd: repoPath,
    env: process.env
  });
  await runCommand("git", ["add", "."], { cwd: repoPath, env: process.env });
  await runCommand("git", ["commit", "-m", "Initial scripted repo"], {
    cwd: repoPath,
    env: process.env
  });
  // Repository definitions (.kanna/config.json, agents, workflows) are read
  // from refs/remotes/origin/<default_branch>, never the working tree. Without
  // this ref the scripted repo's setup commands and workspace config would be
  // silently ignored during task creation.
  await runCommand("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
    cwd: repoPath,
    env: process.env
  });
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

function describeRelayMessage(message: RelayMessage): string {
  if (isRelayEvent(message)) {
    const sessionId = typeof message.payload.session_id === "string"
      ? ` session=${message.payload.session_id}`
      : "";
    const data = decodedOutput(message.payload);
    const output = data ? ` output=${JSON.stringify(data.slice(0, 500))}` : "";
    return `event ${message.name}${sessionId}${output}`;
  }
  const id = typeof message.id === "string" ? ` id=${message.id}` : "";
  return `${String(message.type ?? "unknown")}${id}`;
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
