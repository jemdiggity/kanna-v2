import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { submitTaskFromUi } from "../helpers/newTaskFlow";
import { nudgeTerminalTrustPrompt, sendKeysToActiveTerminal } from "../helpers/terminalInput";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
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

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
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

async function spawnReplacementDaemon(client: WebDriverClient): Promise<number> {
  const daemonBin = await invokeOrThrow(client, "which_binary", { name: "kanna-daemon" }) as string;
  const daemonDir = await invokeOrThrow(client, "read_env_var", { name: "KANNA_DAEMON_DIR" }) as string;
  const child = spawn(daemonBin, [], {
    detached: true,
    env: {
      ...process.env,
      KANNA_DAEMON_DIR: daemonDir,
    },
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) {
    throw new Error("Replacement daemon did not expose a pid");
  }
  await waitForDaemonPid(daemonDir, child.pid);
  return child.pid;
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
    await sleep(200);
  }

  throw new Error(
    `Timed out waiting for terminal buffer text "${text}" in ${sessionId}: ${String(lastError)}`,
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
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
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
    expect(task.agent_provider).toBe("codex");
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

  it("renders typed input promptly while terminal recovery persistence remains enabled", async () => {
    // The desktop harness exercises the real app -> Tauri -> daemon -> PTY -> xterm path,
    // but it cannot currently slow only the daemon's recovery persistence worker without
    // restarting the app under a special daemon env. The paired daemon reconnect regression
    // uses that testability hook to force slow recovery bookkeeping.
    const sessionId = `pty-latency-${randomUUID()}`;
    deterministicSessionIds.push(sessionId);
    const readyMarker = `KREADY_${randomUUID().replaceAll("-", "")}`;
    const inputMarker = `KINPUT_${randomUUID().replaceAll("-", "")}`;
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

    const startedAt = Date.now();
    await sendKeysToActiveTerminal(client, inputMarker);
    await client.pressKey("\uE007");

    const echoStats = await waitForTerminalBufferText(
      client,
      sessionId,
      `ECHO:${inputMarker}`,
      2_000,
    );
    const renderMs = Date.now() - startedAt;

    expect(echoStats.lastMatchingLine).toContain(inputMarker);
    expect(renderMs).toBeLessThan(2_000);
    await waitForSessionRecoveryText(client, sessionId, `ECHO:${inputMarker}`, 10_000);
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
    await waitForTerminalBufferText(client, deterministicSessionId, `ECHO:${liveMarker}`, 10_000);

    await invokeOrThrow(client, "detach_session", { sessionId: deterministicSessionId });

    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
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

  it("sends input to an existing PTY after daemon handoff replaces the command socket", async () => {
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

    await invokeOrThrow(client, "send_input", {
      sessionId: deterministicSessionId,
      data: utf8Bytes(`${beforeMarker}\n`),
    });
    await waitForTerminalBufferText(client, deterministicSessionId, `ECHO:${beforeMarker}`, 10_000);

    await invokeOrThrow(client, "detach_session", { sessionId: deterministicSessionId });
    await spawnReplacementDaemon(client);
    await sleep(1_000);
    await attachSessionWithRetry(client, deterministicSessionId);

    await invokeOrThrow(client, "send_input", {
      sessionId: deterministicSessionId,
      data: utf8Bytes(`${afterMarker}\n`),
    });

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
