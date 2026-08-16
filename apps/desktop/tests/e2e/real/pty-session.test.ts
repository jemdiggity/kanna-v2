import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { submitTaskFromUi } from "../helpers/newTaskFlow";
import {
  nudgeTerminalTrustPrompt,
  sendKeysToActiveTerminal,
  typeTextToFocusedTerminalWindow,
} from "../helpers/terminalInput";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { resolveAppKannaServer } from "../helpers/kannaServer";
import { callVueMethod, execDb, getVueState, tauriInvoke } from "../helpers/vue";

interface WebDriverErrorValue {
  error?: string;
  message?: string;
}

interface WebDriverResponse<T> {
  value: T | WebDriverErrorValue;
}

interface TerminalBufferStats {
  matchingLineCount: number;
  firstMatchingLine: string | null;
  lastMatchingLine: string | null;
}

interface SessionRecoveryStatePayload {
  serialized: string;
}

interface WindowRectInput {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

interface PtySize {
  cols: number;
  rows: number;
}

const execFileAsync = promisify(execFile);

function getClientSessionId(client: WebDriverClient): string {
  const state = client as unknown as { sessionId?: string | null };
  if (!state.sessionId) {
    throw new Error("No WebDriver session. Call createSession() first.");
  }
  return state.sessionId;
}

async function getWindowHandles(client: WebDriverClient): Promise<string[]> {
  const sessionId = getClientSessionId(client);
  const response = await fetch(
    `${client.getBaseUrl()}/session/${sessionId}/window/handles`,
  );
  const body = await response.json() as WebDriverResponse<string[]>;
  if (
    typeof body.value === "object" &&
    body.value !== null &&
    "error" in body.value
  ) {
    throw new Error(`WebDriver error: ${body.value.message ?? "unknown error"}`);
  }
  return Array.isArray(body.value) ? body.value : [];
}

async function switchToWindow(client: WebDriverClient, handle: string): Promise<void> {
  const sessionId = getClientSessionId(client);
  const response = await fetch(`${client.getBaseUrl()}/session/${sessionId}/window`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ handle }),
  });
  const body = await response.json() as WebDriverResponse<null>;
  if (
    typeof body.value === "object" &&
    body.value !== null &&
    "error" in body.value
  ) {
    throw new Error(`WebDriver error: ${body.value.message ?? "unknown error"}`);
  }
  await client.executeSync(
    `window.dispatchEvent(new FocusEvent("focus"));
     return true;`,
  );
}

async function sendRapidTailAndEnter(
  client: WebDriverClient,
  tail: string,
): Promise<void> {
  const sessionId = getClientSessionId(client);
  const response = await fetch(`${client.getBaseUrl()}/session/${sessionId}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actions: [{
        type: "key",
        id: "rapid-terminal-input",
        actions: [
          { type: "keyDown", value: tail },
          { type: "keyDown", value: "\uE007" },
          { type: "keyUp", value: "\uE007" },
          { type: "keyUp", value: tail },
        ],
      }],
    }),
  });
  const body = await response.json() as WebDriverResponse<null>;
  if (
    typeof body.value === "object"
    && body.value !== null
    && "error" in body.value
  ) {
    throw new Error(`WebDriver error: ${body.value.message ?? "unknown error"}`);
  }
}

async function waitForFocusedTerminalReady(
  client: WebDriverClient,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<void> {
  await client.executeSync(
    `window.dispatchEvent(new Event("focus"));
     return true;`,
  );

  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await client.executeSync(
      `const hook = window.__KANNA_E2E__;
       return {
         sessionIds: hook?.terminalBuffers?.sessionIds?.() ?? [],
       };`,
    );
    const state = latest as {
      sessionIds?: string[];
    } | null;
    if ((state?.sessionIds ?? []).includes(sessionId)) {
      const focused = await client.executeSync<boolean>(
        `const el = document.querySelector(".main-panel .xterm-helper-textarea");
         if (el instanceof HTMLElement) el.focus();
         return el instanceof HTMLElement && document.activeElement === el;`,
      );
      if (focused) return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for focused terminal ${sessionId}; latest=${JSON.stringify(latest)}`);
}

async function setWindowRect(
  client: WebDriverClient,
  rect: WindowRectInput,
): Promise<void> {
  const sessionId = getClientSessionId(client);
  const response = await fetch(
    `${client.getBaseUrl()}/session/${sessionId}/window/rect`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rect),
    },
  );
  const body = await response.json() as WebDriverResponse<unknown>;
  if (
    typeof body.value === "object" &&
    body.value !== null &&
    "error" in body.value
  ) {
    throw new Error(`WebDriver error: ${body.value.message ?? "unknown error"}`);
  }
}

async function waitForWindowCount(
  client: WebDriverClient,
  count: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handles = await getWindowHandles(client);
    if (handles.length === count) {
      return handles;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${count} windows.`);
}

async function setSelectedItem(client: WebDriverClient, itemId: string): Promise<void> {
  await callVueMethod(client, "store.selectItem", itemId);
}

async function waitForCurrentItemId(
  client: WebDriverClient,
  itemId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentItem = await getVueState(client, "currentItem") as { id?: string | null } | null;
    if (currentItem?.id === itemId) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for current item ${itemId}`);
}

async function closeFocusedWindowThroughAppAction(client: WebDriverClient): Promise<void> {
  const result = await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     setTimeout(() => {
       void Promise.resolve(ctx.keyboardActions?.closeWindow?.() ?? ctx.windowWorkspace.closeWindow())
         .catch((error) => console.error("[e2e] close focused window failed", error));
     }, 0);
     cb("scheduled");`,
  );
  if (
    typeof result === "object" &&
    result !== null &&
    "__error" in result
  ) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
}

async function invokeOrThrow(
  client: WebDriverClient,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await tauriInvoke(client, cmd, args);
  if (
    typeof result === "object" &&
    result !== null &&
    "__error" in result
  ) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
  return result;
}

function trackSessionId(sessionIds: string[], sessionId: string): string {
  sessionIds.push(sessionId);
  return sessionId;
}

async function waitForDaemonPid(
  daemonDir: string,
  expectedPid: number,
  timeoutMs = 10_000,
): Promise<void> {
  const pidPath = join(daemonDir, "daemon.pid");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readFile(pidPath, "utf8").catch(() => "");
    if (pid.trim() === String(expectedPid)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for replacement daemon pid ${expectedPid}`);
}

async function readDaemonPid(daemonDir: string): Promise<number> {
  const pid = Number.parseInt(await readFile(join(daemonDir, "daemon.pid"), "utf8"), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid daemon pid ${pid}`);
  }
  return pid;
}

async function readProcessState(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync("/bin/ps", [
      "-o",
      "state=",
      "-p",
      String(pid),
    ]);
    return result.stdout.trim() || null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1
    ) {
      return null;
    }
    throw error;
  }
}

async function waitForProcessRelease(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readProcessState(pid);
    if (state === null || state.startsWith("Z")) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for daemon pid ${pid} to release its sessions`);
}

interface ReplacementDaemonPids {
  incumbent: number;
  successor: number;
}

async function spawnReplacementDaemon(
  client: WebDriverClient,
): Promise<ReplacementDaemonPids> {
  const daemonDir = await invokeOrThrow(client, "read_env_var", { name: "KANNA_DAEMON_DIR" }) as string;
  const incumbent = await readDaemonPid(daemonDir);
  const successor = await invokeOrThrow(
    client,
    "spawn_replacement_daemon_for_e2e",
  );
  if (typeof successor !== "number" || !Number.isSafeInteger(successor) || successor <= 0) {
    throw new Error(`Replacement daemon returned invalid pid ${String(successor)}`);
  }
  await waitForDaemonPid(daemonDir, successor);
  return { incumbent, successor };
}

async function waitForRecoverySnapshotText(
  client: WebDriverClient,
  sessionId: string,
  text: string,
  timeoutMs = 10_000,
): Promise<SessionRecoveryStatePayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await invokeOrThrow(client, "get_session_recovery_state", { sessionId });
    if (
      snapshot &&
      typeof snapshot === "object" &&
      "serialized" in snapshot &&
      typeof snapshot.serialized === "string" &&
      snapshot.serialized.includes(text)
    ) {
      return snapshot;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for recovery snapshot text "${text}" in ${sessionId}`);
}

async function attachSessionWithRetry(
  client: WebDriverClient,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await invokeOrThrow(client, "attach_session_with_snapshot", { sessionId });
      return;
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }

  throw new Error(`Timed out reattaching ${sessionId} after daemon handoff: ${String(lastError)}`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePtySize(line: string, marker: string): PtySize {
  const match = line.match(new RegExp(`SIZE:${escapeRegExp(marker)}:(\\d+)x(\\d+)`));
  if (!match) {
    throw new Error(`Unable to parse PTY size from line: ${line}`);
  }
  return {
    cols: Number(match[1]),
    rows: Number(match[2]),
  };
}

function samePtySize(left: PtySize, right: PtySize): boolean {
  return left.cols === right.cols && left.rows === right.rows;
}

async function waitForTerminalBufferText(
  client: WebDriverClient,
  sessionId: string,
  text: string,
  timeoutMs = 10_000,
  pollIntervalMs = 200,
): Promise<TerminalBufferStats> {
  const deadline = Date.now() + timeoutMs;
  const pattern = escapeRegExp(text);
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const stats = await client.executeSync<TerminalBufferStats>(
        `const hook = window.__KANNA_E2E__?.terminalBuffers;
         if (!hook) throw new Error("terminal buffer hook unavailable");
         return hook.stats(${JSON.stringify(sessionId)}, new RegExp(${JSON.stringify(pattern)}));`,
      );
      if (stats.matchingLineCount > 0) {
        return stats;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for terminal buffer text "${text}" in ${sessionId}: ${String(lastError)}`,
  );
}

async function waitForConcurrentServerWork(client: WebDriverClient): Promise<void> {
  const result = await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const work = window.__KANNA_E2E__?.serverWork;
     if (!work) return cb({ __error: "server work hook unavailable" });
     work.wait()
       .then(() => cb("complete"))
       .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
  );
  if (typeof result === "object" && result !== null && "__error" in result) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
}

async function measureTerminalEchoLatency(
  client: WebDriverClient,
  sessionId: string,
  input: string,
  expectedEcho: string,
  serverWorkMs: number,
  timeoutMs: number,
): Promise<{ latencyMs: number; serverWorkActive: boolean }> {
  const result = await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const hook = window.__KANNA_E2E__?.terminalBuffers;
     const work = window.__KANNA_E2E__?.serverWork;
     if (!hook) return cb({ __error: "terminal buffer hook unavailable" });
     if (!work) return cb({ __error: "server work hook unavailable" });
     let finished = false;
     const finish = (value) => {
       if (finished) return;
       finished = true;
       cb(value);
     };
     work.start(${serverWorkMs}).then(() => {
       setTimeout(() => {
         if (!work.isActive()) {
           return finish({ __error: "CPU work ended before terminal input started" });
         }
         const startedAt = performance.now();
         hook.input(${JSON.stringify(sessionId)}, ${JSON.stringify(`${input}\r`)});
         const checkEcho = () => {
           try {
             const stats = hook.stats(
               ${JSON.stringify(sessionId)},
               new RegExp(${JSON.stringify(escapeRegExp(expectedEcho))}),
             );
             if (stats.matchingLineCount > 0) {
               return finish({
                 latencyMs: performance.now() - startedAt,
                 serverWorkActive: work.isActive(),
               });
             }
           } catch (error) {
             return finish({ __error: error?.message ?? String(error) });
           }
           if (performance.now() - startedAt >= ${timeoutMs}) {
             return finish({ __error: "timed out waiting for echoed terminal input" });
           }
           setTimeout(checkEcho, 5);
         };
         checkEcho();
       }, 50);
     }).catch((error) => finish({ __error: error?.message ?? String(error) }));`,
  );
  if (typeof result === "object" && result !== null && "__error" in result) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
  return result as { latencyMs: number; serverWorkActive: boolean };
}

async function detachTerminalStream(
  client: WebDriverClient,
  taskId: string,
): Promise<void> {
  const result = await client.executeAsync(
    `const cb = arguments[arguments.length - 1];
     const terminalStreams = window.__KANNA_E2E__?.terminalStreams;
     if (!terminalStreams) return cb({ __error: "terminal stream hook unavailable" });
     terminalStreams.detach(${JSON.stringify(taskId)})
       .then(() => cb("detached"))
       .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
  );
  if (typeof result === "object" && result !== null && "__error" in result) {
    throw new Error(String((result as { __error: unknown }).__error));
  }
}

async function getTerminalBufferTextStats(
  client: WebDriverClient,
  sessionId: string,
  text: string,
): Promise<TerminalBufferStats> {
  const pattern = escapeRegExp(text);
  return client.executeSync<TerminalBufferStats>(
    `const hook = window.__KANNA_E2E__?.terminalBuffers;
     if (!hook) throw new Error("terminal buffer hook unavailable");
     return hook.stats(${JSON.stringify(sessionId)}, new RegExp(${JSON.stringify(pattern)}));`,
  );
}

async function waitForTerminalBufferMatch(
  client: WebDriverClient,
  sessionId: string,
  pattern: string,
  timeoutMs = 10_000,
): Promise<TerminalBufferStats> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const stats = await client.executeSync<TerminalBufferStats>(
        `const hook = window.__KANNA_E2E__?.terminalBuffers;
         if (!hook) throw new Error("terminal buffer hook unavailable");
         return hook.stats(${JSON.stringify(sessionId)}, new RegExp(${JSON.stringify(pattern)}));`,
      );
      if (stats.matchingLineCount > 0) {
        return stats;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }

  throw new Error(
    `Timed out waiting for terminal buffer pattern "${pattern}" in ${sessionId}: ${String(lastError)}`,
  );
}

async function waitForSessionRecoveryText(
  client: WebDriverClient,
  sessionId: string,
  text: string,
  timeoutMs = 10_000,
): Promise<SessionRecoveryStatePayload> {
  const deadline = Date.now() + timeoutMs;
  let latest: SessionRecoveryStatePayload | null = null;

  while (Date.now() < deadline) {
    latest = await invokeOrThrow(client, "get_session_recovery_state", {
      sessionId,
    }) as SessionRecoveryStatePayload | null;
    if (latest?.serialized.includes(text)) {
      return latest;
    }
    await sleep(200);
  }

  throw new Error(
    `Timed out waiting for recovery state text "${text}" in ${sessionId}; latest was ${
      latest?.serialized.slice(-200) ?? "null"
    }`,
  );
}

async function probePtySize(
  client: WebDriverClient,
  sessionId: string,
  label: string,
): Promise<PtySize> {
  const marker = `${label}_${randomUUID().replaceAll("-", "")}`;
  await sendKeysToActiveTerminal(client, `SIZE:${marker}`);
  await client.pressKey("\uE007");
  const stats = await waitForTerminalBufferMatch(
    client,
    sessionId,
    `SIZE:${escapeRegExp(marker)}:\\d+x\\d+`,
    10_000,
  );
  return parsePtySize(stats.lastMatchingLine ?? "", marker);
}

async function waitForPtySize(
  client: WebDriverClient,
  sessionId: string,
  expected: PtySize,
  timeoutMs = 10_000,
): Promise<PtySize> {
  const deadline = Date.now() + timeoutMs;
  let lastSize: PtySize | null = null;

  while (Date.now() < deadline) {
    lastSize = await probePtySize(client, sessionId, "KWAIT_SIZE");
    if (samePtySize(lastSize, expected)) {
      return lastSize;
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for PTY size ${expected.cols}x${expected.rows}; last size was ${
      lastSize ? `${lastSize.cols}x${lastSize.rows}` : "unknown"
    }`,
  );
}

async function waitForPtySizeDifferentFrom(
  client: WebDriverClient,
  sessionId: string,
  original: PtySize,
  timeoutMs = 10_000,
): Promise<PtySize> {
  const deadline = Date.now() + timeoutMs;
  let lastSize: PtySize | null = null;

  while (Date.now() < deadline) {
    lastSize = await probePtySize(client, sessionId, "KWAIT_DIFF_SIZE");
    if (
      lastSize.cols <= original.cols &&
      lastSize.rows <= original.rows &&
      !samePtySize(lastSize, original)
    ) {
      return lastSize;
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for PTY size to differ from ${original.cols}x${original.rows}; last size was ${
      lastSize ? `${lastSize.cols}x${lastSize.rows}` : "unknown"
    }`,
  );
}

describe("pty session (real CLI)", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let repoId = "";
  const deterministicSessionIds: string[] = [];

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
    testRepoPath = await createFixtureRepo("claude-real-test");
    repoId = await importTestRepo(client, testRepoPath, "claude-real-test");
  });

  afterAll(async () => {
    for (const sessionId of deterministicSessionIds) {
      await invokeOrThrow(client, "kill_session", { sessionId }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
      await cleanupFixtureRepos([testRepoPath]);
    }
    await client.deleteSession();
  });

  it("creates a PTY task and renders terminal output", async () => {
    const prompt = "Respond with exactly: E2E_TEST_OK";

    await submitTaskFromUi(client, prompt);

    const task = await waitForTaskCreated(client, prompt);
    expect(task.agent_provider).toBe("opencode");
    await nudgeTerminalTrustPrompt(client, {
      initialDelayMs: 5_000,
      attempts: 4,
      intervalMs: 5_000,
    });

    // In PTY mode, output appears in the terminal container
    // Wait for the terminal to have content (xterm.js renders into a canvas)
    const terminal = await client.waitForElement(".terminal-container", 15_000);
    expect(terminal).toBeTruthy();

    // Wait for session to exit — the terminal shows "[Process exited with code X]"
    await sleep(10_000);
    const termText = await client.executeSync<string>(
      `const el = document.querySelector(".xterm-screen");
       return el ? el.textContent : "";`
    );
    // Terminal should have some content from the real agent session
    expect(termText.length).toBeGreaterThan(0);
  });

  it("renders the terminal view for PTY mode", async () => {
    const container = await client.findElement(".terminal-container");
    expect(container).toBeTruthy();
  });

  it("uses the live daemon provider in both directions when a one-window terminal reconnects", async () => {
    const sessionId = trackSessionId(
      deterministicSessionIds,
      `pty-runtime-provider-${randomUUID()}`,
    );
    const otherSessionId = trackSessionId(
      deterministicSessionIds,
      `pty-runtime-provider-other-${randomUUID()}`,
    );
    const readyMarker = `KPROVIDER_${randomUUID().replaceAll("-", "")}`;
    const otherReadyMarker = `KPROVIDER_OTHER_${randomUUID().replaceAll("-", "")}`;
    const staleMarker = `KSTALE_${randomUUID().replaceAll("-", "")}`;
    const preservedMarker = `KPRESERVED_${randomUUID().replaceAll("-", "")}`;

    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        repoId,
        "Stage provider terminal fixture",
        "single-reviewer",
        "pr",
        `task-${sessionId}`,
        "pty",
        "codex",
        "idle",
      ],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        otherSessionId,
        repoId,
        "Provider reconnect switch target",
        "single-reviewer",
        "pr",
        `task-${otherSessionId}`,
        "pty",
        "claude",
        "idle",
      ],
    );
    await invokeOrThrow(client, "spawn_session", {
      sessionId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "-f",
        "-c",
        `printf '${readyMarker}\\n'; while IFS= read -r line; do :; done`,
      ],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
      // Deliberately disagree with the task row above. The daemon's live
      // session metadata is authoritative for reconnect snapshot behavior.
      agentProvider: "claude",
    });
    await invokeOrThrow(client, "spawn_session", {
      sessionId: otherSessionId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "-f",
        "-c",
        `printf '${otherReadyMarker}\\n'; while IFS= read -r line; do :; done`,
      ],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });

    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, sessionId);
    await waitForCurrentItemId(client, sessionId);
    await waitForTerminalBufferText(client, sessionId, readyMarker, 15_000);

    const currentItem = await getVueState(client, "mainPanelItem") as {
      agent_provider?: string | null;
    } | null;
    expect(currentItem?.agent_provider).toBe("codex");

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       window.__KANNA_E2E__.terminalBuffers.write(
         ${JSON.stringify(sessionId)},
         ${JSON.stringify(`\r\n${staleMarker}\r\n`)},
         function() { cb("written"); }
       );`,
    );
    expect(
      (await getTerminalBufferTextStats(client, sessionId, staleMarker)).matchingLineCount,
    ).toBe(1);

    await setSelectedItem(client, otherSessionId);
    await waitForCurrentItemId(client, otherSessionId);
    await waitForTerminalBufferText(client, otherSessionId, otherReadyMarker, 15_000);
    await setSelectedItem(client, sessionId);
    await waitForCurrentItemId(client, sessionId);

    const deadline = Date.now() + 15_000;
    let staleStats = await getTerminalBufferTextStats(client, sessionId, staleMarker);
    while (staleStats.matchingLineCount > 0 && Date.now() < deadline) {
      await sleep(200);
      staleStats = await getTerminalBufferTextStats(client, sessionId, staleMarker);
    }
    expect(staleStats.matchingLineCount).toBe(0);
    await waitForTerminalBufferText(client, sessionId, readyMarker, 15_000);

    await setSelectedItem(client, otherSessionId);
    await waitForCurrentItemId(client, otherSessionId);
    await waitForTerminalBufferText(client, otherSessionId, otherReadyMarker, 15_000);
    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       window.__KANNA_E2E__.terminalBuffers.write(
         ${JSON.stringify(otherSessionId)},
         ${JSON.stringify(`\r\n${preservedMarker}\r\n`)},
         function() { cb("written"); }
       );`,
    );
    expect(
      (await getTerminalBufferTextStats(client, otherSessionId, preservedMarker)).matchingLineCount,
    ).toBe(1);

    await setSelectedItem(client, sessionId);
    await waitForCurrentItemId(client, sessionId);
    const readyMarkerCountBeforeReattach = (
      await getTerminalBufferTextStats(client, otherSessionId, otherReadyMarker)
    ).matchingLineCount;
    await detachTerminalStream(client, otherSessionId);
    await setSelectedItem(client, otherSessionId);
    await waitForCurrentItemId(client, otherSessionId);

    const snapshotDeadline = Date.now() + 15_000;
    let readyStats = await getTerminalBufferTextStats(client, otherSessionId, otherReadyMarker);
    while (
      readyStats.matchingLineCount <= readyMarkerCountBeforeReattach &&
      Date.now() < snapshotDeadline
    ) {
      await sleep(200);
      readyStats = await getTerminalBufferTextStats(client, otherSessionId, otherReadyMarker);
    }
    expect(readyStats.matchingLineCount).toBeGreaterThan(readyMarkerCountBeforeReattach);

    expect(
      (await getTerminalBufferTextStats(client, otherSessionId, preservedMarker)).matchingLineCount,
    ).toBe(1);
  });

  it("renders PTY echo within 500ms while same-WebSocket CPU work is active", async () => {
    const sessionId = `pty-latency-${randomUUID()}`;
    deterministicSessionIds.push(sessionId);
    const readyMarker = `KREADY_${randomUUID().replaceAll("-", "")}`;
    const inputMarker = `ki${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const script = [
      `printf '${readyMarker}\\n'`,
      "while IFS= read -r line; do printf 'ECHO:%s\\n' \"$line\"; done",
    ].join("; ");

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [sessionId, repoId, "Deterministic PTY latency fixture", "in progress", "pty"],
    );
    await invokeOrThrow(client, "spawn_session", {
      sessionId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: ["-f", "-c", script],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, sessionId);
    await waitForCurrentItemId(client, sessionId);
    await waitForTerminalBufferText(client, sessionId, readyMarker, 15_000);
    await waitForSessionRecoveryText(client, sessionId, readyMarker, 10_000);

    try {
      const measurement = await measureTerminalEchoLatency(
        client,
        sessionId,
        inputMarker,
        `ECHO:${inputMarker}`,
        1_500,
        2_000,
      );
      expect(measurement.latencyMs).toBeLessThan(500);
      expect(measurement.serverWorkActive).toBe(true);
    } finally {
      await waitForConcurrentServerWork(client);
    }
    await waitForSessionRecoveryText(client, sessionId, `ECHO:${inputMarker}`, 10_000);
  });

  it("keeps rapid UI draft submission separate from queued logical API input", async () => {
    const sessionId = trackSessionId(
      deterministicSessionIds,
      `pty-draft-boundary-${randomUUID()}`,
    );
    const readyMarker = `KBOUNDARY_READY_${randomUUID().replaceAll("-", "")}`;
    const humanPrefix = "human-";
    const humanTail = "x";
    const humanInput = `${humanPrefix}${humanTail}`;
    const managerInput = "manager-message";
    const script = [
      "select(STDOUT); $| = 1;",
      "system('stty raw -echo');",
      `print ${JSON.stringify(`${readyMarker}\r\n`)};`,
      "my $composer = '';",
      "while (1) {",
      "  my $read = sysread(STDIN, my $chunk, 1);",
      "  last unless defined($read) && $read > 0;",
      "  if ($chunk eq qq{\\r}) {",
      "    print qq{SUBMIT:<$composer>\\r\\n};",
      "    $composer = '';",
      "    next;",
      "  }",
      "  $composer .= $chunk;",
      "  print qq{DRAFT_READY\\r\\n};",
      "}",
    ].join("\n");

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [sessionId, repoId, "Rapid PTY draft boundary fixture", "in progress", "pty"],
    );
    await invokeOrThrow(client, "spawn_session", {
      sessionId,
      cwd: testRepoPath,
      executable: "/usr/bin/perl",
      args: ["-e", script],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, sessionId);
    await waitForCurrentItemId(client, sessionId);
    await waitForTerminalBufferText(client, sessionId, readyMarker, 15_000);
    await waitForFocusedTerminalReady(client, sessionId);

    await sendKeysToActiveTerminal(client, humanPrefix);
    await waitForTerminalBufferText(client, sessionId, "DRAFT_READY", 10_000);

    const { baseUrl } = await resolveAppKannaServer(client);
    const response = await fetch(
      `${baseUrl}/v1/tasks/${encodeURIComponent(sessionId)}/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: managerInput }),
      },
    );
    if (!response.ok) {
      throw new Error(`logical task input failed: ${response.status} ${await response.text()}`);
    }

    await sendRapidTailAndEnter(client, humanTail);
    await waitForTerminalBufferMatch(
      client,
      sessionId,
      `SUBMIT:<${managerInput}>`,
      10_000,
    );
    const submittedLines = await client.executeSync<string[]>(
      `const hook = window.__KANNA_E2E__?.terminalBuffers;
       if (!hook) throw new Error("terminal buffer hook unavailable");
       return hook.lines(${JSON.stringify(sessionId)});`,
    );
    expect(
      submittedLines.filter((line) => /SUBMIT:/.test(line)),
    ).toEqual([`SUBMIT:<${humanInput}>`, `SUBMIT:<${managerInput}>`]);
  }, 45_000);

  it("routes focused-window keyboard input to that window's selected PTY task", async () => {
    const taskAId = `pty-focus-a-${randomUUID()}`;
    const taskBId = `pty-focus-b-${randomUUID()}`;
    deterministicSessionIds.push(taskAId, taskBId);
    const readyA = `ka${randomUUID().replaceAll("-", "")}`;
    const readyB = `kb${randomUUID().replaceAll("-", "")}`;
    const inputA = `ia${randomUUID().replaceAll("-", "")}`;
    const inputB = `ib${randomUUID().replaceAll("-", "")}`;
    const scriptA = [
      `printf '${readyA}\\n'`,
      "while IFS= read -r line; do printf 'a_echo:%s\\n' \"$line\"; done",
    ].join("; ");
    const scriptB = [
      `printf '${readyB}\\n'`,
      "while IFS= read -r line; do printf 'b_echo:%s\\n' \"$line\"; done",
    ].join("; ");

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskAId, repoId, "Focused window PTY fixture A", "in progress", "pty"],
    );
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskBId, repoId, "Focused window PTY fixture B", "in progress", "pty"],
    );
    await invokeOrThrow(client, "spawn_session", {
      sessionId: taskAId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: ["-f", "-c", scriptA],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });
    await invokeOrThrow(client, "spawn_session", {
      sessionId: taskBId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: ["-f", "-c", scriptB],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });

    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, taskAId);
    await waitForCurrentItemId(client, taskAId);
    await waitForTerminalBufferText(client, taskAId, readyA, 15_000);

    const initialHandles = await getWindowHandles(client);
    expect(initialHandles.length).toBeGreaterThanOrEqual(1);
    const sourceHandle = initialHandles[0];
    let secondHandle: string | undefined;

    try {
      await client.executeAsync(
        `const cb = arguments[arguments.length - 1];
         const ctx = window.__KANNA_E2E__.setupState;
         Promise.resolve(
           ctx.windowWorkspace.openWindow({
             selectedRepoId: ${JSON.stringify(repoId)},
             selectedItemId: ${JSON.stringify(taskAId)},
           })
         ).then(() => cb("ok"))
          .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
      );

      const handles = await waitForWindowCount(client, initialHandles.length + 1);
      secondHandle = handles.find((handle) => !initialHandles.includes(handle));
      expect(secondHandle).toBeTruthy();

      await switchToWindow(client, secondHandle ?? "");
      await client.waitForAppReady();
      await dismissStartupShortcutsModal(client);
      await setSelectedItem(client, taskBId);
      await waitForCurrentItemId(client, taskBId);
      await waitForTerminalBufferText(client, taskBId, readyB, 15_000);

      await switchToWindow(client, sourceHandle);
      await client.waitForAppReady();
      await waitForCurrentItemId(client, taskAId);
      await waitForTerminalBufferText(client, taskAId, readyA, 15_000);
      await waitForFocusedTerminalReady(client, taskAId);
      await typeTextToFocusedTerminalWindow(client, `${inputA}\n`, { initialDelayMs: 500 });
      await waitForTerminalBufferText(client, taskAId, `a_echo:${inputA}`, 10_000);

      await switchToWindow(client, secondHandle ?? "");
      await client.waitForAppReady();
      await waitForCurrentItemId(client, taskBId);
      await waitForTerminalBufferText(client, taskBId, readyB, 15_000);
      expect((await getTerminalBufferTextStats(client, taskBId, `b_echo:${inputA}`)).matchingLineCount).toBe(0);

      await waitForFocusedTerminalReady(client, taskBId);
      await typeTextToFocusedTerminalWindow(client, `${inputB}\n`, { initialDelayMs: 500 });
      await waitForTerminalBufferText(client, taskBId, `b_echo:${inputB}`, 10_000);

      await switchToWindow(client, sourceHandle);
      await client.waitForAppReady();
      await waitForCurrentItemId(client, taskAId);
      await waitForTerminalBufferText(client, taskAId, readyA, 15_000);
      expect((await getTerminalBufferTextStats(client, taskAId, `a_echo:${inputB}`)).matchingLineCount).toBe(0);
    } finally {
      if (secondHandle) {
        await switchToWindow(client, secondHandle).catch(() => undefined);
        await client.waitForAppReady().catch(() => undefined);
        await closeFocusedWindowThroughAppAction(client).catch(() => undefined);
        await waitForWindowCount(client, initialHandles.length).catch(() => undefined);
      }
      await switchToWindow(client, sourceHandle).catch(() => undefined);
      await client.waitForAppReady().catch(() => undefined);
    }
  });

  it("keeps an existing PTY stream alive when a secondary window attaches and detaches", async () => {
    const deterministicSessionId = trackSessionId(
      deterministicSessionIds,
      `pty-window-${randomUUID()}`,
    );
    const readyMarker = `KREADY_${randomUUID().replaceAll("-", "")}`;
    const liveMarker = `KLIVE_${randomUUID().replaceAll("-", "")}`;
    const afterDetachMarker = `KAFTER_${randomUUID().replaceAll("-", "")}`;
    const script = [
      `printf '${readyMarker}\\n'`,
      "while IFS= read -r line; do case \"$line\" in SIZE:*) token=\"${line#SIZE:}\"; printf 'SIZE:%s:' \"$token\"; stty size | awk '{printf \"%sx%s\\\\n\", $2, $1}' ;; *) printf 'ECHO:%s\\n' \"$line\" ;; esac; done",
    ].join("; ");

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [deterministicSessionId, repoId, "Deterministic PTY echo fixture", "in progress", "pty"],
    );
    await invokeOrThrow(client, "spawn_session", {
      sessionId: deterministicSessionId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: ["-f", "-c", script],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, deterministicSessionId);
    await waitForCurrentItemId(client, deterministicSessionId);
    await waitForTerminalBufferText(client, deterministicSessionId, readyMarker, 15_000);

    const initialHandles = await getWindowHandles(client);
    expect(initialHandles.length).toBeGreaterThanOrEqual(1);
    const sourceHandle = initialHandles[0];

    await setWindowRect(client, { width: 1400, height: 900, x: 40, y: 40 });
    await sleep(1_000);
    const sourceSize = await probePtySize(client, deterministicSessionId, "KSOURCE_SIZE");
    expect(sourceSize.cols).toBeGreaterThan(80);
    expect(sourceSize.rows).toBeGreaterThan(24);

    await client.executeAsync(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(
         ctx.windowWorkspace.openWindow({
           selectedRepoId: ${JSON.stringify(repoId)},
           selectedItemId: ${JSON.stringify(deterministicSessionId)},
         })
       ).then(() => cb("ok"))
        .catch((error) => cb({ __error: error?.message ?? String(error) }));`,
    );

    const handles = await waitForWindowCount(client, initialHandles.length + 1);
    const secondHandle = handles.find((handle) => !initialHandles.includes(handle));
    expect(secondHandle).toBeTruthy();

    await switchToWindow(client, secondHandle ?? "");
    await setWindowRect(client, { width: 800, height: 600, x: 80, y: 80 });
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    await waitForCurrentItemId(client, deterministicSessionId);
    await waitForTerminalBufferText(client, deterministicSessionId, readyMarker, 15_000);
    await setWindowRect(client, { width: 800, height: 600, x: 80, y: 80 });
    await sleep(1_000);

    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
    await waitForFocusedTerminalReady(client, deterministicSessionId);
    const sharedSize = await waitForPtySizeDifferentFrom(
      client,
      deterministicSessionId,
      sourceSize,
      10_000,
    );
    expect(sharedSize.cols).toBeLessThanOrEqual(sourceSize.cols);
    expect(sharedSize.rows).toBeLessThanOrEqual(sourceSize.rows);
    expect(samePtySize(sharedSize, sourceSize)).toBe(false);

    await sendKeysToActiveTerminal(client, liveMarker);
    await client.pressKey("\uE007");
    await waitForTerminalBufferText(client, deterministicSessionId, `ECHO:${liveMarker}`, 10_000);

    await switchToWindow(client, secondHandle ?? "");
    await client.waitForAppReady();
    await waitForFocusedTerminalReady(client, deterministicSessionId);
    await waitForTerminalBufferText(client, deterministicSessionId, `ECHO:${liveMarker}`, 10_000);

    await detachTerminalStream(client, deterministicSessionId);

    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
    await waitForFocusedTerminalReady(client, deterministicSessionId);
    const restoredSize = await waitForPtySize(client, deterministicSessionId, sourceSize, 10_000);
    expect(restoredSize).toEqual(sourceSize);

    await switchToWindow(client, secondHandle ?? "");
    await client.waitForAppReady();
    await closeFocusedWindowThroughAppAction(client);

    const remainingHandles = await waitForWindowCount(client, initialHandles.length);
    expect(remainingHandles).toContain(sourceHandle);
    expect(remainingHandles).not.toContain(secondHandle);

    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
    await waitForFocusedTerminalReady(client, deterministicSessionId);
    const afterCloseSize = await waitForPtySize(client, deterministicSessionId, sourceSize, 10_000);
    expect(afterCloseSize).toEqual(sourceSize);

    await sendKeysToActiveTerminal(client, afterDetachMarker);
    await client.pressKey("\uE007");

    const afterDetachStats = await waitForTerminalBufferText(
      client,
      deterministicSessionId,
      `ECHO:${afterDetachMarker}`,
      10_000,
    );
    expect(afterDetachStats.lastMatchingLine).toContain(afterDetachMarker);
  });

  it("routes xterm input to a durable task's replacement daemon session", async () => {
    const taskId = `pty-route-task-${randomUUID()}`;
    const oldSessionId = trackSessionId(
      deterministicSessionIds,
      `pty-route-old-${randomUUID()}`,
    );
    const newSessionId = trackSessionId(
      deterministicSessionIds,
      `pty-route-new-${randomUUID()}`,
    );
    const navigationId = trackSessionId(
      deterministicSessionIds,
      `pty-route-nav-${randomUUID()}`,
    );
    const oldReady = `KROUTE_OLD_READY_${randomUUID().replaceAll("-", "")}`;
    const newReady = `KROUTE_NEW_READY_${randomUUID().replaceAll("-", "")}`;
    const navReady = `KROUTE_NAV_READY_${randomUUID().replaceAll("-", "")}`;
    const beforeMarker = `KROUTE_BEFORE_${randomUUID().replaceAll("-", "")}`;
    const afterMarker = `KROUTE_AFTER_${randomUUID().replaceAll("-", "")}`;

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskId, repoId, "Durable task session replacement fixture", "in progress", "pty"],
    );
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [navigationId, repoId, "Route replacement navigation fixture", "in progress", "pty"],
    );
    await execDb(
      client,
      `INSERT INTO terminal_session
         (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
       VALUES (?, ?, ?, 'agent', ?, ?)`,
      [`terminal-${taskId}`, repoId, taskId, testRepoPath, oldSessionId],
    );

    await invokeOrThrow(client, "spawn_session", {
      sessionId: oldSessionId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "-f",
        "-c",
        `printf '${oldReady}\\n'; while IFS= read -r line; do printf 'OLD_ECHO:%s\\n' "$line"; done`,
      ],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });
    await invokeOrThrow(client, "spawn_session", {
      sessionId: newSessionId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: [
        "-f",
        "-c",
        `printf '${newReady}\\n'; while IFS= read -r line; do printf 'NEW_ECHO:%s\\n' "$line"; done`,
      ],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });
    await invokeOrThrow(client, "spawn_session", {
      sessionId: navigationId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: ["-f", "-c", `printf '${navReady}\\n'; while IFS= read -r line; do :; done`],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });

    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, taskId);
    await waitForCurrentItemId(client, taskId);
    await waitForTerminalBufferText(client, taskId, oldReady, 15_000);
    await waitForFocusedTerminalReady(client, taskId);
    await sendKeysToActiveTerminal(client, beforeMarker);
    await client.pressKey("\uE007");
    await waitForTerminalBufferText(client, taskId, `OLD_ECHO:${beforeMarker}`, 10_000);

    await execDb(
      client,
      "UPDATE terminal_session SET daemon_session_id = ? WHERE pipeline_item_id = ?",
      [newSessionId, taskId],
    );
    await setSelectedItem(client, navigationId);
    await waitForCurrentItemId(client, navigationId);
    await waitForTerminalBufferText(client, navigationId, navReady, 15_000);
    await setSelectedItem(client, taskId);
    await waitForCurrentItemId(client, taskId);
    await waitForTerminalBufferText(client, taskId, newReady, 15_000);
    await waitForFocusedTerminalReady(client, taskId);
    await sendKeysToActiveTerminal(client, afterMarker);
    await client.pressKey("\uE007");

    const replacementEcho = await waitForTerminalBufferText(
      client,
      taskId,
      `NEW_ECHO:${afterMarker}`,
      10_000,
    );
    expect(replacementEcho.lastMatchingLine).toContain(afterMarker);
  });

  it("sends xterm/KSP input after daemon handoff replaces the command socket", async () => {
    const deterministicSessionId = trackSessionId(
      deterministicSessionIds,
      `pty-handoff-input-${randomUUID()}`,
    );
    const readyMarker = `KHANDOFF_READY_${randomUUID().replaceAll("-", "")}`;
    const beforeMarker = `KHANDOFF_BEFORE_${randomUUID().replaceAll("-", "")}`;
    const afterMarker = `KHANDOFF_AFTER_${randomUUID().replaceAll("-", "")}`;
    const script = [
      `printf '${readyMarker}\\n'`,
      "while IFS= read -r line; do printf 'ECHO:%s\\n' \"$line\"; done",
    ].join("; ");

    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [deterministicSessionId, repoId, "Deterministic PTY handoff echo fixture", "in progress", "pty"],
    );
    await invokeOrThrow(client, "spawn_session", {
      sessionId: deterministicSessionId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: ["-f", "-c", script],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, deterministicSessionId);
    await waitForCurrentItemId(client, deterministicSessionId);
    await waitForTerminalBufferText(client, deterministicSessionId, readyMarker, 15_000);

    await waitForFocusedTerminalReady(client, deterministicSessionId);
    await sendKeysToActiveTerminal(client, beforeMarker);
    await client.pressKey("\uE007");
    await waitForTerminalBufferText(client, deterministicSessionId, `ECHO:${beforeMarker}`, 10_000);

    await invokeOrThrow(client, "detach_session", { sessionId: deterministicSessionId });
    const replacement = await spawnReplacementDaemon(client);
    expect(replacement.successor).not.toBe(replacement.incumbent);
    await waitForProcessRelease(replacement.incumbent);
    await sleep(1_000);
    await attachSessionWithRetry(client, deterministicSessionId);

    await waitForFocusedTerminalReady(client, deterministicSessionId);
    await sendKeysToActiveTerminal(client, afterMarker);
    await client.pressKey("\uE007");

    const echoedText = `ECHO:${afterMarker}`;
    const afterHandoffStats = await waitForTerminalBufferText(
      client,
      deterministicSessionId,
      echoedText,
      15_000,
    );
    expect(afterHandoffStats.lastMatchingLine).toContain(afterMarker);

    const snapshot = await waitForRecoverySnapshotText(
      client,
      deterministicSessionId,
      echoedText,
      10_000,
    );
    expect(snapshot.serialized).toContain(afterMarker);
  });
});
