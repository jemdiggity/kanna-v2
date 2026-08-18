import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { createKannaClient } from "../../../apps/mobile/src/lib/api/client";
import type { AgentProvider } from "../../../packages/agent-protocol/src/index";
import type {
  DesktopDescriptor,
  TaskSummary
} from "../../../apps/mobile/src/lib/api/types";
import type { TaskTerminalStreamEvent, TaskTerminalSubscription } from "../../../apps/mobile/src/lib/api/client";
import { createLanTransport, type FetchLike, type WebSocketLike } from "../../../apps/mobile/src/lib/transports/lanTransport";
import { createMobileController } from "../../../apps/mobile/src/state/mobileController";
import {
  createSessionStore,
  type SessionStore
} from "../../../apps/mobile/src/state/sessionStore";
import {
  terminalOutputToString,
  type TerminalOutputLike
} from "../../../apps/mobile/src/state/terminalOutputBuffer";
import {
  hostInstalledAgentProviders,
  startRemoteHarness,
  type RemoteHarness
} from "./harness";
import {
  collectTerminalEvents,
  createScriptedTask,
  waitForTerminalOutput
} from "./terminalFlowTestUtils";

describe("LAN task loop E2E", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  it("reuses the mobile LAN transport for status, desktop discovery, and seeded task listing", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "LAN client loop task"
    });
    const transport = createLanTransport(
      harness.lanBaseUrl,
      nodeFetch,
      (url) => new NodeWebSocketAdapter(url)
    );

    await expect(transport.getStatus()).resolves.toMatchObject({
      desktopId: harness.desktopId,
      desktopName: "Remote E2E Desktop",
      lanHost: "127.0.0.1",
      lanPort: harness.ports.server,
      state: "running"
    });
    // Both desktop descriptions carry the machine's provider inventory, so the
    // exact shape is asserted around it rather than against it.
    const [lanDesktop] = await transport.listDesktops();
    expect(lanDesktop).toMatchObject({
      id: harness.desktopId,
      name: "Remote E2E Desktop",
      online: true,
      mode: "lan"
    });
    expectHarnessAgentProviders(lanDesktop.agentProviders);
    const [descriptor] = await fetchJson<DesktopDescriptor[]>(
      `${harness.lanBaseUrl}/v1/desktops`
    );
    expect(descriptor).toMatchObject({
      id: harness.desktopId,
      name: "Remote E2E Desktop",
      connectionMode: "both"
    });
    expectHarnessAgentProviders(descriptor.agentProviders);

    const repos = await transport.listRepos();
    expect(repos).toContainEqual(expect.objectContaining({
      id: task.repoId,
      name: "LAN client loop task"
    }));
    await expect(transport.listRepoTasks(task.repoId)).resolves.toEqual([
      expect.objectContaining({
        id: task.taskId,
        repoId: task.repoId,
        title: "LAN client loop task"
      })
    ]);
    const recentTasks = await transport.listRecentTasks();
    expect(recentTasks).toContainEqual(expect.objectContaining({
      id: task.taskId,
      repoId: task.repoId,
      title: "LAN client loop task"
    }));
  });

  it("creates a local pairing session with LAN endpoint and five-minute expiry", async () => {
    const transport = createLanClient(harness);
    const before = Date.now();

    const pairing = await harness.createDesktopPairingSession();
    const expiresInMs = pairing.expiresAtUnixMs - before;

    expect(pairing).toMatchObject({
      desktopId: harness.desktopId,
      desktopName: "Remote E2E Desktop",
      lanHost: "127.0.0.1",
      lanPort: harness.ports.server
    });
    expect(pairing.code).toMatch(/^[0-9A-F]{6}$/);
    expect(expiresInMs).toBeGreaterThanOrEqual(295_000);
    expect(expiresInMs).toBeLessThanOrEqual(305_000);

    await expect(transport.getStatus()).resolves.toMatchObject({
      pairingCode: null
    });
  });

  it("streams a deterministic PTY task over LAN and delivers LAN input to the PTY", async () => {
    const setupCommand = "echo setup-ran-$((6*7))";
    const task = await createScriptedTask(harness, {
      displayName: "LAN terminal task",
      setupCommands: [setupCommand]
    });
    const transport = createLanClient(harness);
    const events = collectLanTerminalEvents(transport, task.taskId);

    try {
      await events.waitForReady();
      const output = await events.waitForOutput("SCRIPT_READY", 30_000);
      // Repository setup must be visible in the mobile terminal stream: the
      // banner, the echoed `$ command`, and the command's own output, all
      // before the agent starts.
      const bannerIndex = output.indexOf("Running startup...");
      const commandIndex = output.indexOf(`$ ${setupCommand}`);
      const outputIndex = output.indexOf("setup-ran-42", commandIndex + setupCommand.length + 2);
      expect(bannerIndex).toBeGreaterThanOrEqual(0);
      expect(commandIndex).toBeGreaterThan(bannerIndex);
      expect(outputIndex).toBeGreaterThan(commandIndex);
      expect(output.indexOf("SCRIPT_READY")).toBeGreaterThan(outputIndex);
      await events.waitForOutput("SCRIPT_HEARTBEAT");

      await transport.sendTaskInput(task.taskId, "hello from lan");
      await events.waitForOutput("SCRIPT_INPUT:hello from lan");

      await transport.sendTaskInput(task.taskId, "exit-zero");
      await events.waitForOutput("SCRIPT_EXITING");
      await events.waitForExit(0);
    } finally {
      events.close();
    }
  }, 45_000);

  it("keeps a LAN terminal draft separate from a simultaneous logical task message", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "LAN raw draft and manager input isolation",
      tracePartialInput: true
    });
    const transport = createLanClient(harness);
    const events = collectLanTerminalEvents(transport, task.taskId);
    const humanDraft = "human LAN draft in progress";
    const managerMessage = "manager message stays separate over LAN";

    try {
      await events.waitForOutput("SCRIPT_INPUT_READY", 30_000);
      events.sendInput(Buffer.from(humanDraft).toString("base64"));
      await events.waitForOutput(`SCRIPT_PARTIAL:${humanDraft}`);

      await transport.sendTaskInput(task.taskId, managerMessage);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events.outputText()).not.toContain(`SCRIPT_INPUT:${humanDraft}`);
      expect(events.outputText()).not.toContain(`SCRIPT_INPUT:${managerMessage}`);

      events.sendInput(Buffer.from("\r").toString("base64"), true);
      const output = await events.waitForOutput(
        `SCRIPT_INPUT:${managerMessage}`,
        30_000
      );
      const humanIndex = output.indexOf(`SCRIPT_INPUT:${humanDraft}`);
      const managerIndex = output.indexOf(`SCRIPT_INPUT:${managerMessage}`);
      expect(humanIndex).toBeGreaterThanOrEqual(0);
      expect(managerIndex).toBeGreaterThan(humanIndex);
      expect(output).not.toContain(`${humanDraft}${managerMessage}`);
    } finally {
      events.close();
    }
  }, 45_000);

  it("does not let production mobile scroll control strand a logical task message", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "LAN mobile control and manager input",
      tracePartialInput: true
    });
    const transport = createLanClient(harness);
    const events = collectLanTerminalEvents(transport, task.taskId);
    const managerMessage = "manager message after mobile scroll";

    try {
      await events.waitForOutput("SCRIPT_INPUT_READY", 30_000);
      events.sendInput("G1s8NjU7MTsxTQ==", false, true);
      await events.waitForOutput("SCRIPT_CONTROL:scroll", 30_000);

      await transport.sendTaskInput(task.taskId, managerMessage);
      const output = await events.waitForOutput(
        `SCRIPT_INPUT:${managerMessage}`,
        30_000
      );
      expect(output).not.toContain(`SCRIPT_PARTIAL:\u001b[<65;1;1M${managerMessage}`);
    } finally {
      events.close();
    }
  }, 45_000);

  it("retains authoritative no-echo input and a live PTY burst across a mobile terminal remount", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "Mobile retained terminal input task",
      redactInput: true
    });
    const client = createKannaClient(createLanClient(harness));
    const store = createSessionStore();
    const controller = createMobileController(client, store);
    const submittedInput = "first pasted line\n日本語の composed password";

    try {
      await controller.bootstrap();
      controller.openTask(task.taskId);
      await waitForStoreTerminalOutput(store, "SCRIPT_INPUT_READY", 30_000);

      await controller.sendTaskInput(task.taskId, submittedInput);
      const connectedOutput = await waitForStoreTerminalOutput(
        store,
        "SCRIPT_REDACTED_INPUT",
        30_000
      );
      expect(connectedOutput).not.toContain(submittedInput);
      expect(connectedOutput).not.toContain("composed password");

      await controller.sendTaskInput(task.taskId, "burst-output");
      const burstOutput = await waitForStoreTerminalOutput(
        store,
        "SCRIPT_BURST_DONE",
        30_000
      );
      expect(burstOutput).toContain("SCRIPT_BURST_0001_");
      expect(burstOutput).toContain("SCRIPT_BURST_2000_");

      const connectedEpoch =
        store.taskTerminalOutputSource.getSnapshot().outputEpoch;
      controller.closeTask(task.taskId);
      expect(
        terminalOutputToString(
          store.taskTerminalOutputSource.getSnapshot().output
        )
      ).toBe("");
      controller.openTask(task.taskId);

      const remountedOutput = await waitForStoreTerminalOutput(
        store,
        "SCRIPT_BURST_DONE",
        30_000
      );
      expect(remountedOutput).not.toContain(submittedInput);
      expect(remountedOutput).not.toContain("composed password");
      expect(remountedOutput).toContain("SCRIPT_BURST_0001_");
      expect(remountedOutput).toContain("SCRIPT_BURST_2000_");
      expect(
        store.taskTerminalOutputSource.getSnapshot().outputEpoch
      ).toBeGreaterThan(connectedEpoch);
    } finally {
      controller.dispose();
    }
  }, 60_000);

  it("keeps LAN and relay task state and terminal exit observations in parity", async () => {
    const task = await createScriptedTask(harness, {
      displayName: "LAN relay parity task"
    });
    const transport = createLanClient(harness);
    const lanEvents = collectLanTerminalEvents(transport, task.taskId);
    const relayEvents = collectTerminalEvents(harness, task.taskId);

    try {
      await Promise.all([
        lanEvents.waitForOutput("SCRIPT_READY"),
        waitForTerminalOutput(relayEvents, "SCRIPT_READY")
      ]);

      const lanTasks = await transport.listRecentTasks();
      const relayTasks = asTaskSummaries(await harness.client.invokeDesktop({
        desktopId: harness.desktopId,
        method: "GET",
        path: "/v1/tasks/recent",
        body: null
      }));
      expect(findTask(lanTasks, task.taskId)).toEqual(findTask(relayTasks, task.taskId));

      await transport.sendTaskInput(task.taskId, "exit-zero");
      await Promise.all([
        lanEvents.waitForExit(0),
        relayEvents.waitForExit(0)
      ]);
      expect(lanEvents.exitCode()).toBe(0);
    } finally {
      lanEvents.close();
      relayEvents.close();
    }
  }, 45_000);
});

const nodeFetch: FetchLike = async (input, init) => fetch(input, init);

type LanTransport = ReturnType<typeof createLanTransport>;

function createLanClient(harness: RemoteHarness): LanTransport {
  return createLanTransport(
    harness.lanBaseUrl,
    nodeFetch,
    (url) => new NodeWebSocketAdapter(url)
  );
}

function decodeRetainedTerminalOutput(output: TerminalOutputLike): string {
  return terminalOutputToString(output)
    .split("\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => Buffer.from(frame, "base64").toString("utf8"))
    .join("");
}

async function waitForStoreTerminalOutput(
  store: SessionStore,
  marker: string,
  timeoutMs: number
): Promise<string> {
  const currentOutput = decodeRetainedTerminalOutput(
    store.taskTerminalOutputSource.getSnapshot().output
  );
  if (currentOutput.includes(marker)) {
    return currentOutput;
  }

  return await new Promise<string>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for retained terminal output ${marker}`));
    }, timeoutMs);
    const resolveIfPresent = () => {
      const output = decodeRetainedTerminalOutput(
        store.taskTerminalOutputSource.getSnapshot().output
      );
      if (!output.includes(marker)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(output);
    };
    unsubscribe = store.taskTerminalOutputSource.subscribe(resolveIfPresent);
    // Close the read-before-subscribe race against a direct terminal frame.
    resolveIfPresent();
  });
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`request failed (${response.status}) for ${url}`);
  }
  return response.json() as Promise<T>;
}

/**
 * The harness server runs with only its stub `codex` reachable
 * (`serverProviderPath`), so its inventory must name codex and must not name a
 * provider this host does not also expose in the globally probed directories.
 */
function expectHarnessAgentProviders(
  reported: readonly AgentProvider[] | undefined
): void {
  expect(reported).toBeDefined();
  expect(reported).toContain("codex");
  const unavoidable = new Set(["codex", ...hostInstalledAgentProviders()]);
  expect(
    (reported ?? []).filter((provider) => !unavoidable.has(provider))
  ).toEqual([]);
}

class NodeWebSocketAdapter implements WebSocketLike {
  private readonly socket: WebSocket;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("open", () => this.onopen?.());
    this.socket.on("close", () => this.onclose?.());
    this.socket.on("error", () => this.onerror?.());
    this.socket.on("message", (data) => {
      this.onmessage?.({ data: rawDataToString(data) });
    });
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}

interface LanTerminalCollector {
  close(): void;
  exitCode(): number | null;
  outputText(): string;
  sendInput(dataB64: string, submissionBoundary?: boolean, controlInput?: boolean): void;
  waitForReady(timeoutMs?: number): Promise<void>;
  waitForOutput(marker: string, timeoutMs?: number): Promise<string>;
  waitForExit(expectedCode: number, timeoutMs?: number): Promise<void>;
}

function collectLanTerminalEvents(transport: LanTransport, taskId: string): LanTerminalCollector {
  return new LanTerminalCollectorImpl(transport, taskId);
}

class LanTerminalCollectorImpl implements LanTerminalCollector {
  private chunks: string[] = [];
  private readonly readyWaiters: Array<{
    resolve(): void;
  }> = [];
  private readonly outputWaiters: Array<{
    marker: string;
    resolve(output: string): void;
  }> = [];
  private readonly exitWaiters: Array<{
    expectedCode: number;
    resolve(): void;
    reject(error: Error): void;
  }> = [];
  private ready = false;
  private code: number | null = null;
  private readonly subscription: TaskTerminalSubscription;

  constructor(transport: LanTransport, private readonly taskId: string) {
    this.subscription = transport.observeTaskTerminal(taskId, (event) => this.onEvent(event));
  }

  close(): void {
    this.subscription.close();
  }

  exitCode(): number | null {
    return this.code;
  }

  outputText(): string {
    return this.chunks.join("");
  }

  sendInput(dataB64: string, submissionBoundary = false, controlInput = false): void {
    this.subscription.sendInput?.(dataB64, submissionBoundary, controlInput);
  }

  async waitForReady(timeoutMs = 10_000): Promise<void> {
    if (this.ready) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve };
      const timeout = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index >= 0) {
          this.readyWaiters.splice(index, 1);
        }
        reject(new Error(`timed out waiting for LAN terminal ready from ${this.taskId}`));
      }, timeoutMs);
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
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
        reject(new Error(`timed out waiting for LAN terminal output ${marker} from ${this.taskId}`));
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
    if (this.code !== null) {
      if (this.code !== expectedCode) {
        throw new Error(`expected LAN exit ${expectedCode}, got ${this.code}`);
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
        reject(new Error(`timed out waiting for LAN terminal exit from ${this.taskId}`));
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
      case "snapshot": {
        this.chunks = [Buffer.from(event.dataB64, "base64").toString("utf8")];
        this.ready = true;
        for (const waiter of [...this.readyWaiters]) {
          this.readyWaiters.splice(this.readyWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
        const output = this.outputText();
        for (const waiter of [...this.outputWaiters]) {
          if (output.includes(waiter.marker)) {
            this.outputWaiters.splice(this.outputWaiters.indexOf(waiter), 1);
            waiter.resolve(output);
          }
        }
        return;
      }
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
        this.code = event.code;
        for (const waiter of [...this.exitWaiters]) {
          this.exitWaiters.splice(this.exitWaiters.indexOf(waiter), 1);
          if (event.code === waiter.expectedCode) {
            waiter.resolve();
          } else {
            waiter.reject(new Error(`expected LAN exit ${waiter.expectedCode}, got ${event.code}`));
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
    }
  }
}

function asTaskSummaries(value: unknown): TaskSummary[] {
  if (!Array.isArray(value) || !value.every(isTaskSummary)) {
    throw new Error(`unexpected task list response ${JSON.stringify(value)}`);
  }
  return value;
}

function isTaskSummary(value: unknown): value is TaskSummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.repoId === "string" &&
    typeof value.title === "string"
  );
}

function findTask(tasks: readonly TaskSummary[], taskId: string): TaskSummary {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`task ${taskId} not found in ${JSON.stringify(tasks)}`);
  }
  return task;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
