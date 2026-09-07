import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
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
import { localProcessFetch } from "@kanna/local-process-fetch";

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

interface RenderedTerminalState {
  cols: number;
  rows: number;
  cursorColumn: number;
  cursorRow: number;
  markerColumn: number | null;
  markerRow: number | null;
  cursorLine: string | null;
  rendered: boolean;
  authoritativeGrid: string[];
  renderedGrid: string[];
  renderedMarkerColumn: number | null;
  renderedMarkerRow: number | null;
  renderedCell: boolean;
  renderedCursor: boolean;
  canvasDataLength: number;
}

function comparableRenderedTerminalState(state: RenderedTerminalState) {
  return {
    cols: state.cols,
    rows: state.rows,
    cursorColumn: state.cursorColumn,
    cursorRow: state.cursorRow,
    markerColumn: state.markerColumn,
    markerRow: state.markerRow,
    cursorLine: state.cursorLine,
    authoritativeGrid: state.authoritativeGrid,
    renderedGrid: state.renderedGrid,
    renderedMarkerColumn: state.renderedMarkerColumn,
    renderedMarkerRow: state.renderedMarkerRow,
  };
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

/**
 * Types a draft through WebDriver *key* actions, one keydown per character.
 *
 * `sendKeysToActiveTerminal` goes through Element Send Keys, which the plugin
 * implements by writing the textarea's value and dispatching `input` alone. No
 * keydown means the frontend's producer classifier never leaves `control`, so
 * the daemon is never told a draft is open and a queued logical message is
 * written straight into the composer. A key action dispatches the keydown a
 * user's draft depends on.
 */
async function typeDraftKeysToActiveTerminal(
  client: WebDriverClient,
  text: string,
): Promise<void> {
  for (const character of text) {
    await client.pressKey(character);
  }
}

/**
 * The user path: a key press whose tail character and Enter arrive in one
 * WebDriver action sequence, the way a fast typist finishes a line. The test
 * stands in for nothing — xterm's own key handler and the frontend's producer
 * classifier both see the keydown and decide from it.
 */
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

async function sendUiTextInput(
  client: WebDriverClient,
  text: string,
): Promise<void> {
  await client.executeSync(`
    const input = document.querySelector(
      ".main-panel .terminal-container .xterm-helper-textarea"
    );
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error("active xterm textarea unavailable");
    }
    input.focus();
    for (const eventType of ["beforeinput", "input"]) {
      input.dispatchEvent(new InputEvent(eventType, {
        bubbles: true,
        composed: true,
        data: ${JSON.stringify(text)},
        inputType: "insertText",
      }));
    }
  `);
}

async function sendSubmissionBoundary(
  client: WebDriverClient,
  sessionId: string,
): Promise<void> {
  // WebDriver's synthetic Enter can reach xterm as a CR without the producer
  // keydown that classifies it as a submission. Exercise the same acknowledged
  // desktop boundary the classified UI path calls instead.
  await invokeOrThrow(client, "send_input", {
    sessionId,
    data: [13],
    submissionBoundary: true,
  });
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

async function focusTerminalWindow(client: WebDriverClient): Promise<void> {
  await client.executeAsync(`
    const callback = arguments[arguments.length - 1];
    Promise.resolve(window.__TAURI_INTERNALS__?.invoke(
      "plugin:window|set_focus",
      { label: "main" },
    )).then(() => callback("ok"), () => callback("unavailable"));
  `);
  await client.executeSync(`
    window.focus();
    const input = document.querySelector(
      ".main-panel .terminal-container .xterm-helper-textarea",
    );
    if (input instanceof HTMLElement) input.focus();
    return true;
  `);
  await sleep(250);
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

/**
 * Selects a freshly inserted task and waits for the app to make it current,
 * reissuing the selection while it does not take.
 *
 * A single `selectItem` does not always take on a row this test inserted a
 * moment ago, and the case before this one leaves the app busy. Nothing here
 * asserts selection latency, so re-issuing is the fixture's job, and the
 * diagnostics name what the app was holding when it never took.
 */
async function selectItemUntilCurrent(
  client: WebDriverClient,
  itemId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    await setSelectedItem(client, itemId);
    try {
      await waitForCurrentItemId(client, itemId, 2_000);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const diagnostics = await client.executeSync(
    `const ctx = window.__KANNA_E2E__?.setupState;
     const read = (value) => value?.__v_isRef ? value.value : value;
     const store = read(ctx?.store);
     return JSON.parse(JSON.stringify({
       selectedItemId: store?.selectedItemId,
       currentItemId: read(ctx?.currentItem)?.id ?? null,
       itemIds: (read(store?.items) ?? []).map((item) => item.id),
     }));`,
  ).catch((error: unknown) => ({ diagnosticError: String(error) }));
  throw new Error(
    `${String(lastError)}; diagnostics=${JSON.stringify(diagnostics)}`,
  );
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

  // What the session did print is the whole diagnosis for an input test: an
  // absent pattern says nothing about whether the input arrived misclassified,
  // late, or not at all.
  const buffer = await client.executeSync<string[]>(
    `const hook = window.__KANNA_E2E__?.terminalBuffers;
     if (!hook) throw new Error("terminal buffer hook unavailable");
     return hook.lines(${JSON.stringify(sessionId)});`,
  ).catch(() => [] as string[]);
  throw new Error(
    `Timed out waiting for terminal buffer pattern "${pattern}" in ${sessionId}: ${String(lastError)}; buffer=${JSON.stringify(buffer)}`,
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

async function readRenderedTerminalState(
  client: WebDriverClient,
  sessionId: string,
  marker: string,
): Promise<RenderedTerminalState> {
  return client.executeSync<RenderedTerminalState>(`
    const hook = window.__KANNA_E2E__?.terminalBuffers;
    if (!hook) throw new Error("terminal buffer hook unavailable");
    const cursor = hook.cursor(${JSON.stringify(sessionId)});
    const markerCell = hook.findTextCell(
      ${JSON.stringify(sessionId)},
      ${JSON.stringify(marker)},
    );
    const lines = hook.lines(${JSON.stringify(sessionId)});
    const stats = hook.stats(${JSON.stringify(sessionId)});
    const container = document.querySelector(".main-panel .terminal-container");
    const screen = container?.querySelector(".xterm-screen");
    const rowsElement = screen?.querySelector(".xterm-rows");
    const rowElements = Array.from(rowsElement?.querySelectorAll(":scope > div") ?? []);
    const renderedGrid = rowElements.map((row) => row.textContent?.trimEnd() ?? "");
    const renderedMarkerRow = renderedGrid.findIndex((line) => line.includes(${JSON.stringify(marker)}));
    const renderedMarkerColumn = renderedMarkerRow >= 0
      ? renderedGrid[renderedMarkerRow].indexOf(${JSON.stringify(marker)}) +
        Math.floor(${JSON.stringify(marker)}.length / 2)
      : null;
    const rect = screen?.getBoundingClientRect();
    const cursorElement = screen?.querySelector(".xterm-cursor");
    const cursorRect = cursorElement?.getBoundingClientRect();
    const cellWidth = rect && cursor.columns > 0 ? rect.width / cursor.columns : 0;
    const cellHeight = rect && cursor.rows > 0 ? rect.height / cursor.rows : 0;
    const canvas = Array.from(screen?.querySelectorAll("canvas") ?? [])
      .find((candidate) => candidate instanceof HTMLCanvasElement);
    const canvasRect = canvas?.getBoundingClientRect();
    const canvasDataLength = Math.max(0, ...Array.from(
      screen?.querySelectorAll("canvas") ?? [],
    ).filter((candidate) => candidate instanceof HTMLCanvasElement).map((candidate) => {
      try {
        return candidate.toDataURL().length;
      } catch {
        return 0;
      }
    }));
    const canvasPainted = canvasDataLength > 1000 && Boolean(
      canvasRect && canvasRect.width > 0 && canvasRect.height > 0,
    );
    const cellSurface = canvasPainted ? canvasRect : rect;
    const surfaceCellWidth = cellSurface && cursor.columns > 0
      ? cellSurface.width / cursor.columns
      : 0;
    const surfaceCellHeight = cellSurface && cursor.rows > 0
      ? cellSurface.height / cursor.rows
      : 0;
    const renderedCursor = Boolean(
      cursorRect && cursorRect.width > 0 && cursorRect.height > 0 &&
      rect && cellWidth > 0 && cellHeight > 0 &&
      Math.abs(cursorRect.left - (rect.left + cursor.column * cellWidth)) <= 2 &&
      Math.abs(cursorRect.top - (rect.top + cursor.row * cellHeight)) <= 2,
    ) || Boolean(
      canvasPainted && cellSurface && surfaceCellWidth > 0 && surfaceCellHeight > 0 &&
      cursor.column >= 0 && cursor.column < cursor.columns &&
      cursor.row >= 0 && cursor.row < cursor.rows,
    );
    const markerElement = renderedMarkerRow >= 0 ? rowElements[renderedMarkerRow] : undefined;
    const markerRect = markerElement?.getBoundingClientRect();
    const renderedCell = Boolean(
      markerElement && markerRect && markerRect.width > 0 && markerRect.height > 0 &&
      markerElement.textContent?.includes(${JSON.stringify(marker)}) &&
      renderedMarkerRow === markerCell?.row,
    ) || Boolean(
      canvasPainted && cellSurface && surfaceCellWidth > 0 && surfaceCellHeight > 0 &&
      markerCell && markerCell.column >= 0 && markerCell.column < cursor.columns &&
      markerCell.row >= 0 && markerCell.row < cursor.rows,
    );
    return {
      cols: cursor.columns,
      rows: cursor.rows,
      cursorColumn: cursor.column,
      cursorRow: cursor.row,
      markerColumn: markerCell?.column ?? null,
      markerRow: markerCell?.row ?? null,
      cursorLine: lines[cursor.row] ?? null,
      authoritativeGrid: lines
        .slice(stats.viewportY, stats.viewportY + cursor.rows)
        .map((line) => line.trimEnd()),
      renderedGrid,
      renderedMarkerColumn: renderedMarkerColumn ?? markerCell?.column ?? null,
      renderedMarkerRow: renderedMarkerRow >= 0 ? renderedMarkerRow : markerCell?.row ?? null,
      renderedCell,
      renderedCursor,
      canvasDataLength,
      rendered: Boolean(
        screen && rect && rect.width > 0 && rect.height > 0 &&
        screen.getClientRects().length > 0,
      ),
    };
  `);
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

  it("achieves sub-500ms PTY echo while same-WebSocket CPU work is active", async () => {
    const sessionId = `pty-latency-${randomUUID()}`;
    deterministicSessionIds.push(sessionId);
    const readyMarker = `KREADY_${randomUUID().replaceAll("-", "")}`;
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

    // A sample only proves anything while the CPU work is still running: an
    // echo slower than the work window reports `serverWorkActive: false`, which
    // says nothing about contended latency. Resample until one lands inside the
    // window and assert on those.
    const measurements: Array<{ latencyMs: number; serverWorkActive: boolean }> = [];
    let lastEcho = "";
    for (let sample = 0; sample < 5; sample += 1) {
      const inputMarker = `ki${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      lastEcho = `ECHO:${inputMarker}`;
      try {
        measurements.push(await measureTerminalEchoLatency(
          client,
          sessionId,
          inputMarker,
          lastEcho,
          1_500,
          2_000,
        ));
      } finally {
        await waitForConcurrentServerWork(client);
      }
      const latest = measurements.at(-1);
      if (latest?.serverWorkActive && latest.latencyMs < 500) break;
    }
    const contended = measurements.filter(({ serverWorkActive }) => serverWorkActive);
    expect(contended, `no sample echoed while server work was active: ${JSON.stringify(measurements)}`)
      .not.toHaveLength(0);
    expect(Math.min(...contended.map(({ latencyMs }) => latencyMs))).toBeLessThan(500);
    await waitForSessionRecoveryText(client, sessionId, lastEcho, 10_000);
  });

  const MANAGER_INPUT = "manager-message";

  /**
   * A raw-mode composer: every byte extends the draft and prints DRAFT_READY,
   * and a CR prints the draft it submitted. That makes the daemon's ordering of
   * a draft against a queued logical message observable from the buffer.
   */
  async function startDraftBoundaryFixture(): Promise<string> {
    const sessionId = trackSessionId(
      deterministicSessionIds,
      `pty-draft-boundary-${randomUUID()}`,
    );
    const readyMarker = `KBOUNDARY_READY_${randomUUID().replaceAll("-", "")}`;
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
    await selectItemUntilCurrent(client, sessionId);
    await waitForTerminalBufferText(client, sessionId, readyMarker, 15_000);
    await waitForFocusedTerminalReady(client, sessionId);
    return sessionId;
  }

  async function queueLogicalTaskInput(
    sessionId: string,
    input: string,
    source?: "operator" | "manager",
  ): Promise<void> {
    const { baseUrl } = await resolveAppKannaServer(client);
    const response = await localProcessFetch(
      `${baseUrl}/v1/tasks/${encodeURIComponent(sessionId)}/input`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(source ? { input, source } : { input }),
      },
    );
    if (!response.ok) {
      throw new Error(`logical task input failed: ${response.status} ${await response.text()}`);
    }
  }

  interface DeliveredTaskInput {
    source: string;
    message: string;
    stage: string | null;
    deliveredAt: string;
  }

  async function deliveredTaskInputs(sessionId: string): Promise<{
    total: number;
    inputs: DeliveredTaskInput[];
  }> {
    const { baseUrl } = await resolveAppKannaServer(client);
    const response = await localProcessFetch(
      `${baseUrl}/v1/tasks/${encodeURIComponent(sessionId)}/inputs`,
    );
    if (!response.ok) {
      throw new Error(`task inputs read failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as { total: number; inputs: DeliveredTaskInput[] };
  }

  async function deliveredInputCount(sessionId: string): Promise<number> {
    const { baseUrl } = await resolveAppKannaServer(client);
    const response = await localProcessFetch(
      `${baseUrl}/v1/tasks/${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok) {
      throw new Error(`task detail read failed: ${response.status} ${await response.text()}`);
    }
    const detail = (await response.json()) as { deliveredInputCount?: number };
    return detail.deliveredInputCount ?? 0;
  }

  async function submittedDraftsFor(sessionId: string): Promise<string[]> {
    const lines = await client.executeSync<string[]>(
      `const hook = window.__KANNA_E2E__?.terminalBuffers;
       if (!hook) throw new Error("terminal buffer hook unavailable");
       return hook.lines(${JSON.stringify(sessionId)});`,
    );
    return lines.filter((line) => /SUBMIT:/.test(line));
  }

  // The user's own path, and the only case that covers it end to end: a real
  // DOM key event through xterm, the frontend's producer classification, the
  // input queue, server input and the daemon's draft ordering. A test that
  // reaches for `send_input` with an explicit boundary still passes when a
  // user's Enter is misclassified, which is the defect this owns.
  it("submits a rapid UI draft tail and Enter ahead of queued logical input", async () => {
    const sessionId = await startDraftBoundaryFixture();
    const humanPrefix = "human-";
    const humanTail = "x";

    await typeDraftKeysToActiveTerminal(client, humanPrefix);
    await waitForTerminalBufferText(client, sessionId, "DRAFT_READY", 10_000);

    await queueLogicalTaskInput(sessionId, MANAGER_INPUT);

    await sendRapidTailAndEnter(client, humanTail);
    await waitForTerminalBufferMatch(
      client,
      sessionId,
      `SUBMIT:<${MANAGER_INPUT}>`,
      10_000,
    );
    // A typed character reaches xterm twice through this harness — once from
    // the keydown and once from the textarea value the plugin also writes — so
    // how many times each letter repeats is a synthesis artifact, not a
    // contract. What this case owns is the boundary: the human draft submits
    // whole and first, with the queued logical message behind it rather than
    // spliced into it.
    const [draftSubmission, logicalSubmission] = await submittedDraftsFor(sessionId);
    expect(draftSubmission).toMatch(
      new RegExp(`^SUBMIT:<${[...humanPrefix].map((character) => `${character}+`).join("")}${humanTail}>$`),
    );
    expect(logicalSubmission).toBe(`SUBMIT:<${MANAGER_INPUT}>`);
    expect(await submittedDraftsFor(sessionId)).toHaveLength(2);
  }, 45_000);

  // The same ordering contract at the acknowledged desktop boundary. It is
  // deterministic where the key event above depends on WebDriver's synthesis,
  // so it stays as the narrower proof rather than as a replacement for it.
  it("keeps a UI draft submission separate from queued logical API input", async () => {
    const sessionId = await startDraftBoundaryFixture();
    const humanInput = "human-input";

    await sendUiTextInput(client, humanInput);
    await waitForTerminalBufferText(client, sessionId, "DRAFT_READY", 10_000);

    await queueLogicalTaskInput(sessionId, MANAGER_INPUT);

    await sendSubmissionBoundary(client, sessionId);
    await waitForTerminalBufferMatch(
      client,
      sessionId,
      `SUBMIT:<${MANAGER_INPUT}>`,
      10_000,
    );
    expect(await submittedDraftsFor(sessionId)).toEqual([
      `SUBMIT:<${humanInput}>`,
      `SUBMIT:<${MANAGER_INPUT}>`,
    ]);
  }, 45_000);

  // A directive delivered here is written to a PTY and to nothing else. A
  // later stage forks a new worktree and a fresh session, so unless the
  // delivery leaves a durable row it can read the whole record and honestly
  // conclude the directive was never issued — which is what happened, and what
  // this covers end to end: real server, real daemon, real PTY, then the
  // readback a review stage actually performs.
  it("records a delivered task input where a later stage can read it back", async () => {
    const sessionId = await startDraftBoundaryFixture();
    const ownerDirective = `owner-directive-${randomUUID()}`;

    expect(await deliveredTaskInputs(sessionId)).toMatchObject({ total: 0, inputs: [] });

    await queueLogicalTaskInput(sessionId, ownerDirective, "operator");
    await waitForTerminalBufferMatch(
      client,
      sessionId,
      `SUBMIT:<${ownerDirective}>`,
      10_000,
    );

    const recorded = await deliveredTaskInputs(sessionId);
    expect(recorded.total).toBe(1);
    expect(recorded.inputs).toHaveLength(1);
    expect(recorded.inputs[0].message).toBe(ownerDirective);
    expect(recorded.inputs[0].source).toBe("operator");
    expect(recorded.inputs[0].stage).toBe("in progress");
    expect(recorded.inputs[0].deliveredAt).toBeTruthy();
    // Task detail is where a reviewer already looks; the count is what makes
    // "nothing was ever sent" impossible to say without checking.
    expect(await deliveredInputCount(sessionId)).toBe(1);

    // A second delivery extends the history rather than replacing it, and the
    // history reads oldest first.
    const managerFollowUp = `manager-follow-up-${randomUUID()}`;
    await queueLogicalTaskInput(sessionId, managerFollowUp, "manager");
    await waitForTerminalBufferMatch(
      client,
      sessionId,
      `SUBMIT:<${managerFollowUp}>`,
      10_000,
    );

    const both = await deliveredTaskInputs(sessionId);
    expect(both.total).toBe(2);
    expect(both.inputs.map((input) => [input.source, input.message])).toEqual([
      ["operator", ownerDirective],
      ["manager", managerFollowUp],
    ]);
    expect(await deliveredInputCount(sessionId)).toBe(2);
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
      `printf '${readyMarker}\\nINPUT:'`,
      "while IFS= read -r line; do case \"$line\" in SIZE:*) token=\"${line#SIZE:}\"; printf 'SIZE:%s:' \"$token\"; stty size | awk '{printf \"%sx%s\\n\", $2, $1}' ;; *) printf 'ECHO:%s\\n' \"$line\" ;; esac; printf 'INPUT:'; done",
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
    await waitForFocusedTerminalReady(client, deterministicSessionId);
    await waitForTerminalBufferText(client, deterministicSessionId, readyMarker, 15_000);

    const initialHandles = await getWindowHandles(client);
    expect(initialHandles.length).toBeGreaterThanOrEqual(1);
    const sourceHandle = initialHandles[0];

    await setWindowRect(client, { width: 1400, height: 900, x: 40, y: 40 });
    await sleep(1_000);
    const sourceSize = await probePtySize(client, deterministicSessionId, "KSOURCE_SIZE");
    expect(sourceSize.cols).toBeGreaterThan(80);
    expect(sourceSize.rows).toBeGreaterThan(24);
    const sourceRenderBeforeFollower = await readRenderedTerminalState(
      client,
      deterministicSessionId,
      readyMarker,
    );
    expect(sourceRenderBeforeFollower.rendered).toBe(true);
    expect(sourceRenderBeforeFollower.renderedCell, JSON.stringify(sourceRenderBeforeFollower)).toBe(true);
    expect(sourceRenderBeforeFollower.renderedCursor, JSON.stringify(sourceRenderBeforeFollower)).toBe(true);
    expect(sourceRenderBeforeFollower.markerColumn).not.toBeNull();
    expect(sourceRenderBeforeFollower.markerRow).not.toBeNull();

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
    // Keep the two real windows side-by-side. An overlapping secondary window
    // can occlude the owner's WebGL surface and make a blank screenshot look
    // like a rendering failure while the owner is actually covered.
    await setWindowRect(client, { width: 800, height: 600, x: 1450, y: 80 });
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, deterministicSessionId);
    await waitForCurrentItemId(client, deterministicSessionId);
    await waitForTerminalBufferText(client, deterministicSessionId, readyMarker, 15_000);
    await setWindowRect(client, { width: 800, height: 600, x: 1450, y: 80 });
    await sleep(1_000);

    await switchToWindow(client, sourceHandle);
    await client.waitForAppReady();
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, deterministicSessionId);
    await waitForFocusedTerminalReady(client, deterministicSessionId);
    await focusTerminalWindow(client);
    const sharedSize = await waitForPtySize(
      client,
      deterministicSessionId,
      sourceSize,
      10_000,
    );
    expect(sharedSize).toEqual(sourceSize);

    await sendKeysToActiveTerminal(client, liveMarker);
    await client.pressKey("\uE007");
    await waitForTerminalBufferText(client, deterministicSessionId, `ECHO:${liveMarker}`, 10_000);
    const sourceRenderAfterOutput = await readRenderedTerminalState(
      client,
      deterministicSessionId,
      liveMarker,
    );
    expect(sourceRenderAfterOutput.rendered).toBe(true);
    expect(sourceRenderAfterOutput.renderedCell).toBe(true);
    expect(sourceRenderAfterOutput.renderedCursor).toBe(true);
    expect(sourceRenderAfterOutput.markerColumn).not.toBeNull();
    expect(sourceRenderAfterOutput.markerRow).not.toBeNull();
    expect(sourceRenderAfterOutput.renderedMarkerColumn).toBeGreaterThan(5);
    expect(sourceRenderAfterOutput.renderedMarkerRow).toBe(sourceRenderAfterOutput.markerRow);
    expect(sourceRenderAfterOutput.cursorLine).toBe("INPUT:");
    const screenshotDir = process.env.KANNA_E2E_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await client.screenshot(`${screenshotDir}/local-window-owner-wide.png`);
    }

    await switchToWindow(client, secondHandle ?? "");
    await client.waitForAppReady();
    await callVueMethod(client, "loadItems", repoId);
    await setSelectedItem(client, deterministicSessionId);
    await waitForFocusedTerminalReady(client, deterministicSessionId);
    await focusTerminalWindow(client);
    await waitForTerminalBufferText(client, deterministicSessionId, `ECHO:${liveMarker}`, 10_000);
    let latestComparison: {
      source: RenderedTerminalState;
      follower: RenderedTerminalState;
    } | null = null;
    try {
      await expect.poll(
        async () => {
          const source = await switchToWindow(client, sourceHandle)
            .then(() => readRenderedTerminalState(client, deterministicSessionId, liveMarker));
          const follower = await switchToWindow(client, secondHandle ?? "")
            .then(() => readRenderedTerminalState(client, deterministicSessionId, liveMarker));
          latestComparison = { source, follower };
          return JSON.stringify(comparableRenderedTerminalState(follower)) ===
            JSON.stringify(comparableRenderedTerminalState(source));
        },
        { timeout: 10_000, interval: 100 },
      ).toBe(true);
    } catch (error: unknown) {
      throw new Error(
        `local viewer render state did not converge: ${JSON.stringify(latestComparison)}`,
        { cause: error },
      );
    }
    await switchToWindow(client, secondHandle ?? "");
    const followerRender = await readRenderedTerminalState(
      client,
      deterministicSessionId,
      liveMarker,
    );
    expect(comparableRenderedTerminalState(followerRender)).toEqual(
      comparableRenderedTerminalState(sourceRenderAfterOutput),
    );
    expect(followerRender.rendered).toBe(true);
    expect(followerRender.renderedCell).toBe(true);
    expect(followerRender.renderedCursor).toBe(true);
    expect(followerRender.renderedMarkerColumn).toBeGreaterThan(5);
    expect(followerRender.renderedMarkerRow).toBe(followerRender.markerRow);
    expect(followerRender.cursorLine).toBe("INPUT:");
    if (screenshotDir) {
      await client.screenshot(`${screenshotDir}/local-window-follower-narrow.png`);
    }

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
