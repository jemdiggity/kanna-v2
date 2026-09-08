import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { tauriInvoke } from "../helpers/vue";

interface DaemonSessionInfo {
  session_id?: string;
}

interface TerminalBufferStats {
  sessionId: string;
  lineCount: number;
  baseY: number;
  viewportY: number;
  matchingLineCount: number;
  firstMatchingLine: string | null;
  lastMatchingLine: string | null;
  hasEndMarker: boolean;
  tailLines?: string[];
  bufferTailLines?: string[];
  lastSpawnError?: unknown;
}

interface SessionRecoveryState {
  serialized?: string;
}

describe("terminal recovery", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let repoId = "";
  const taskIds: string[] = [];

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
    testRepoPath = await createFixtureRepo("terminal-recovery-test");
    await configureTerminalRecoveryFixture(testRepoPath);
    repoId = await importTestRepo(client, testRepoPath, "terminal-recovery-test");
  });

  afterAll(async () => {
    await Promise.all(
      taskIds.map((sessionId) =>
        tauriInvoke(client, "kill_session", { sessionId }).catch(() => null),
      ),
    );
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
      await cleanupFixtureRepos([testRepoPath]);
    }
    await client.deleteSession();
  });

  // Reproduces the stage-swap freeze: the engine kills the task session while
  // the terminal is attached (the exit latches), the respawn with the same
  // session id happens while the task is deselected (the session_created
  // rebind is never delivered to the paused view), and the reselect must
  // reconcile the stale exit latch against the live daemon session instead of
  // staying frozen on the dead PTY's last frame.
  it("reattaches after a kill+respawn that happened while the task was deselected", async () => {
    // Per-task setup overrides the repo-config fixture so the marker comes
    // straight from this PTY, independent of the shared fixture's
    // first-vs-respawn state; tasks are created serially to keep worktree
    // creation and session spawn deterministic under load.
    const taskId = await createRecoverableTask(client, {
      repoId,
      repoPath: testRepoPath,
      prompt: "Reattach after an unseen stage-swap respawn",
      setup: ["printf 'ORIGINAL_READY\\n'; while true; do sleep 60; done"],
    });
    taskIds.push(taskId);
    await waitForSessionPresence(client, taskId, true);
    await selectTask(client, taskId);
    await client.waitForElement(".main-panel .terminal-container", 15_000);
    await waitForTerminalEndMarker(client, taskId, "ORIGINAL_READY", "^ORIGINAL_READY$", 30_000);

    const otherTaskId = await createRecoverableTask(client, {
      repoId,
      repoPath: testRepoPath,
      prompt: "Temporary task used to pause the frozen task's terminal",
      setup: ["printf 'OTHER_READY\\n'; while true; do sleep 60; done"],
    });
    taskIds.push(otherTaskId);

    // Kill while attached: the exit reaches the view and latches.
    await strictTauriInvoke(client, "kill_session", { sessionId: taskId });
    await waitForSessionPresence(client, taskId, false);
    await waitForTerminalLineMatch(
      client,
      taskId,
      "^\\[Process exited with code \\d+\\]$",
      15_000,
    );

    // Deselect, then respawn the same session id (what a stage transition
    // does) while the view is paused and cannot observe session_created.
    await waitForSessionPresence(client, otherTaskId, true);
    await selectTask(client, otherTaskId);
    await sleep(500);
    await strictTauriInvoke(client, "spawn_session", {
      sessionId: taskId,
      cwd: testRepoPath,
      executable: "/bin/zsh",
      args: ["-c", "printf 'RESPAWN_READY\\n'; while true; do sleep 60; done"],
      env: {},
      cols: 80,
      rows: 24,
    });
    await waitForSessionPresence(client, taskId, true);
    await sleep(500);

    // Reselect: the terminal must attach to the respawned PTY instead of
    // staying frozen on the killed session's last frame.
    await selectTask(client, taskId);
    await waitForTerminalEndMarker(client, taskId, "RESPAWN_READY", "^RESPAWN_READY$", 30_000);

    // This is a clean reattach, not the missing-session respawn fallback:
    // `reconcileStaleExitLatch` clears the latch and attaches to the live
    // respawned PTY, so no session was started and the warning would be false.
    expect(await findRespawnToasts(client)).toEqual([]);
  });

  // Skipped during the KSP migration: this fixture asserts the retired Tauri
  // terminal attach/recovery lifecycle. KSP output and reselect snapshot
  // coverage lives in terminal-output-performance.test.ts.
  it.skip("does not respawn a normally exited task terminal after daemon_ready", async () => {
    const taskId = await createRecoverableTask(client, {
      repoId,
      repoPath: testRepoPath,
      prompt: "Do not recover a completed PTY session",
    });
    taskIds.push(taskId);

    await waitForSessionPresence(client, taskId, true);
    await selectTask(client, taskId);
    await client.waitForElement(".main-panel .terminal-container", 15_000);
    await waitForTerminalEndMarker(client, taskId, "ORIGINAL_READY", "^ORIGINAL_READY$", 15_000);
    await clearE2EInvokes(client);

    await strictTauriInvoke(client, "kill_session", { sessionId: taskId });
    await waitForSessionPresence(client, taskId, false);
    await emitTauriEvent(client, "session_exit", { session_id: taskId, code: 0 });
    await waitForTerminalEndMarker(client, taskId, "[Process exited with code 0]", "\\[Process exited with code 0\\]", 15_000);

    await emitTauriEvent(client, "daemon_ready");
    await sleep(1_000);

    expect(await getSpawnSessionCount(client, taskId)).toBe(0);
    expect(await findRespawnToasts(client)).toEqual([]);
  });

  // Skipped during the KSP migration: this fixture manipulates the retired
  // Tauri attach stream, not the active KSP terminal attachment. KSP reselect
  // snapshot coverage lives in terminal-output-performance.test.ts.
  it.skip("replays recovery scrollback and respawns a detached task terminal after KSP attach reports it missing", async () => {
    const taskId = await createRecoverableTask(client, {
      repoId,
      repoPath: testRepoPath,
      prompt: "Recover a missing PTY session",
    });
    taskIds.push(taskId);
    const detachTargetTaskId = await createRecoverableTask(client, {
      repoId,
      repoPath: testRepoPath,
      prompt: "Temporary task used to detach the KSP terminal stream",
    });
    taskIds.push(detachTargetTaskId);

    await waitForSessionPresence(client, taskId, true);
    await selectTask(client, taskId);
    await client.waitForElement(".main-panel .terminal-container", 15_000);
    await waitForTerminalEndMarker(client, taskId, "ORIGINAL_READY", "^ORIGINAL_READY$", 15_000);

    await waitForSessionPresence(client, detachTargetTaskId, true);
    await selectTask(client, detachTargetTaskId);
    await sleep(300);
    await strictTauriInvoke(client, "kill_session", { sessionId: taskId });
    await waitForSessionPresence(client, taskId, false);

    const recoverySnapshot = buildRecoverySnapshot(2_000);
    await seedAndWaitForRecoveryState(client, taskId, recoverySnapshot);

    await clearE2EInvokes(client);
    await selectTask(client, taskId);
    await waitForRespawnToast(
      client,
      "The previous terminal session could not be reattached. Scrollback was restored and a new session was started.",
    );

    await waitForSessionPresence(client, taskId, true, 20_000);
    const recoveredStats = await waitForTerminalEndMarker(
      client,
      taskId,
      "RECOVERY_DONE",
      "^RECOVERY_LINE\\d{4}$",
      20_000,
    );
    const respawnStats = await waitForTerminalEndMarker(
      client,
      taskId,
      "RESPAWN_READY",
      "^RESPAWN_READY$",
      20_000,
    );

    expect(recoveredStats.matchingLineCount).toBeGreaterThanOrEqual(2_000);
    expect(recoveredStats.firstMatchingLine).toBe("RECOVERY_LINE0001");
    expect(recoveredStats.lastMatchingLine).toBe("RECOVERY_LINE2000");
    expect(respawnStats.hasEndMarker).toBe(true);
    expect(await getSpawnSessionCount(client, taskId)).toBe(1);
  });

  // Skipped during the KSP migration: this fixture injects the retired desktop
  // Tauri terminal_snapshot event path. KSP scrollback preservation coverage
  // lives in terminal-output-performance.test.ts.
  it.skip("keeps Codex scrollback when a reconnect snapshot only partially redraws", async () => {
    const taskId = await createRecoverableTask(client, {
      repoId,
      repoPath: testRepoPath,
      prompt: "Preserve Codex scrollback across a partial snapshot redraw",
      agentProvider: "codex",
    });
    taskIds.push(taskId);

    await waitForSessionPresence(client, taskId, true);
    await selectTask(client, taskId);
    await client.waitForElement(".main-panel .terminal-container", 15_000);
    await waitForTerminalEndMarker(client, taskId, "ORIGINAL_READY", "^ORIGINAL_READY$", 15_000);

    await emitTauriEvent(client, "terminal_snapshot", {
      session_id: taskId,
      snapshot: {
        version: 1,
        rows: 24,
        cols: 80,
        cursor_row: 0,
        cursor_col: 0,
        cursor_visible: true,
        vt: "CODEX_PARTIAL_REDRAW\r\n",
      },
    });

    const stats = await waitForTerminalEndMarker(
      client,
      taskId,
      "CODEX_PARTIAL_REDRAW",
      "^ORIGINAL_READY$",
      5_000,
    );

    expect(stats.hasEndMarker).toBe(true);
    expect(stats.matchingLineCount).toBeGreaterThanOrEqual(1);
  });
});

async function seedAndWaitForRecoveryState(
  client: WebDriverClient,
  sessionId: string,
  serialized: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    await strictTauriInvoke(client, "seed_session_recovery_state", {
      sessionId,
      serialized,
      cols: 80,
      rows: 24,
      cursorRow: 23,
      cursorCol: 0,
      cursorVisible: true,
    });
    latest = await strictTauriInvoke(client, "get_session_recovery_state", { sessionId });
    if (isRecoverySnapshotWithMarker(latest, "RECOVERY_DONE")) return;
    await sleep(100);
  }

  throw new Error(`seeded recovery snapshot was not observable for ${sessionId}: ${JSON.stringify(latest)}`);
}

function isRecoverySnapshotWithMarker(value: unknown, marker: string): value is SessionRecoveryState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SessionRecoveryState).serialized === "string" &&
    (value as SessionRecoveryState).serialized?.includes(marker) === true
  );
}

async function createRecoverableTask(
  client: WebDriverClient,
  options: {
    repoId: string;
    repoPath: string;
    prompt: string;
    agentProvider?: "claude" | "codex";
    setup?: string[];
  },
): Promise<string> {
  const agentProvider = options.agentProvider ?? "claude";
  const customTaskOption = options.setup
    ? `customTask: {
         executionMode: "pty",
         agentProvider: ${JSON.stringify(agentProvider)},
         setup: ${JSON.stringify(options.setup)},
       },`
    : "";
  const taskId = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(
       ctx.createItem(${JSON.stringify(options.repoId)}, ${JSON.stringify(options.repoPath)}, ${JSON.stringify(options.prompt)}, "pty", {
         selectOnCreate: false,
         agentProvider: ${JSON.stringify(agentProvider)},
         ${customTaskOption}
       })
     ).then((id) => cb(id)).catch((error) => cb("__error:" + (error?.message || String(error))));`,
  );
  if (!/^[0-9a-f]{8}$/.test(taskId)) {
    throw new Error(`recoverable task creation failed: ${taskId}`);
  }
  return taskId;
}

async function configureTerminalRecoveryFixture(repoPath: string): Promise<void> {
  const setupCommand = [
    "if [ -f .kanna/terminal-recovery-respawn.ready ]; then",
    "printf 'RESPAWN_READY\\n';",
    "else",
    "touch .kanna/terminal-recovery-respawn.ready;",
    "printf 'ORIGINAL_READY\\n';",
    "fi;",
    "while true; do sleep 60; done",
  ].join(" ");

  await writeFile(
    `${repoPath}/.kanna/config.json`,
    JSON.stringify({ setup: [setupCommand] }, null, 2),
  );
  await runCommand(["git", "add", ".kanna/config.json"], repoPath);
  await runCommand(["git", "commit", "-m", "configure terminal recovery fixture"], repoPath);
  await runCommand(["git", "push", "origin", "main"], repoPath);
}

async function runCommand(command: string[], cwd: string): Promise<void> {
  const [file, ...args] = command;
  const proc = spawn(file, args, { cwd, stdio: "pipe" });
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (signal) {
        reject(new Error(`${command.join(" ")} exited with signal ${signal}`));
        return;
      }
      const details = stderr.trim();
      reject(new Error(
        details.length > 0
          ? `${command.join(" ")} failed: ${details}`
          : `${command.join(" ")} exited with code ${code ?? "unknown"}`,
      ));
    });
  });
}

async function selectTask(client: WebDriverClient, taskId: string): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(ctx.store.selectItem(${JSON.stringify(taskId)}))
       .then(() => cb("ok"))
       .catch((error) => cb("__error:" + (error?.message || String(error))));`,
  );
  if (result !== "ok") {
    throw new Error(`select task failed: ${result}`);
  }
  await waitForSelectedItem(client, taskId);
}

async function waitForSelectedItem(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    // `selectedItemId` is a sidebar SLOT id — for a task created through the
    // app it stays `create:<uuid>` after the row lands. `selectedTaskId` is
    // the durable task the selected slot resolves to.
    latest = await client.executeSync(
      "return window.__KANNA_E2E__.setupState.store.selectedTaskId ?? null;",
    );
    if (latest === taskId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for task ${taskId} to be selected; latest=${JSON.stringify(latest)}`);
}

function buildRecoverySnapshot(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    lines.push(`RECOVERY_LINE${String(i).padStart(4, "0")}`);
  }
  lines.push("RECOVERY_DONE");
  return `${lines.join("\r\n")}\r\n`;
}

async function waitForSessionPresence(
  client: WebDriverClient,
  sessionId: string,
  expectedPresent: boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessions = await tauriInvoke(client, "list_sessions");
    if (Array.isArray(sessions)) {
      const sessionIds = new Set(
        sessions
          .map((session) =>
            typeof session === "object" && session !== null
              ? (session as DaemonSessionInfo).session_id
              : undefined)
          .filter((value): value is string => typeof value === "string"),
      );
      if (sessionIds.has(sessionId) === expectedPresent) return;
    }
    await sleep(100);
  }

  throw new Error(
    `timed out waiting for session ${sessionId} to be ${expectedPresent ? "present" : "absent"}`,
  );
}

async function waitForTerminalLineMatch(
  client: WebDriverClient,
  sessionId: string,
  matcherSource: string,
  timeoutMs: number,
): Promise<TerminalBufferStats> {
  const deadline = Date.now() + timeoutMs;
  let latest: TerminalBufferStats | null = null;
  while (Date.now() < deadline) {
    latest = await readTerminalStats(client, sessionId, matcherSource, "__unused__");
    if (latest.matchingLineCount >= 1) return latest;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for terminal line ${matcherSource} in ${sessionId}; latest=${JSON.stringify(latest)}`,
  );
}

async function waitForTerminalEndMarker(
  client: WebDriverClient,
  sessionId: string,
  endMarker: string,
  matcherSource: string,
  timeoutMs: number,
): Promise<TerminalBufferStats> {
  const deadline = Date.now() + timeoutMs;
  let latest: TerminalBufferStats | null = null;
  while (Date.now() < deadline) {
    latest = await readTerminalStats(client, sessionId, matcherSource, endMarker);
    if (latest.hasEndMarker) return latest;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for terminal marker ${endMarker} in ${sessionId}; latest=${JSON.stringify(latest)}`,
  );
}

async function readTerminalStats(
  client: WebDriverClient,
  sessionId: string,
  matcherSource: string,
  endMarker: string,
): Promise<TerminalBufferStats> {
  return await client.executeSync<TerminalBufferStats>(
    `const hook = window.__KANNA_E2E__?.terminalBuffers;
     if (!hook) throw new Error("terminalBuffers E2E hook is not available");
     const stats = hook.stats(${JSON.stringify(sessionId)}, new RegExp(${JSON.stringify(matcherSource)}), ${JSON.stringify(endMarker)});
     const tailLines = Array.from(document.querySelectorAll(".main-panel .xterm-rows > div"))
       .map((el) => el.textContent || "")
       .slice(-20);
     const bufferTailLines = hook.lines(${JSON.stringify(sessionId)}).slice(-20);
     const lastSpawnError = window.__KANNA_E2E_LAST_AGENT_SPAWN_ERROR__ ?? null;
     return { ...stats, tailLines, bufferTailLines, lastSpawnError };`,
  );
}

async function clearE2EInvokes(client: WebDriverClient): Promise<void> {
  await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
}

async function getSpawnSessionCount(client: WebDriverClient, sessionId: string): Promise<number> {
  return await client.executeSync<number>(
    `return window.__KANNA_E2E__.invokes.getAll()
      .filter((call) => call.cmd === "spawn_session" && call.args?.sessionId === ${JSON.stringify(sessionId)})
      .length;`,
  );
}

async function findRespawnToasts(client: WebDriverClient): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return Array.from(document.querySelectorAll(".toast.warning .toast-message"))
      .map((el) => el.textContent || "")
      .filter((text) => text.includes("terminal session could not be reattached"));`,
  );
}

async function waitForRespawnToast(client: WebDriverClient, expectedMessage: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let latest: string[] = [];
  while (Date.now() < deadline) {
    latest = await findRespawnToasts(client);
    if (latest.includes(expectedMessage)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for respawn toast; latest=${JSON.stringify(latest)}`);
}

async function strictTauriInvoke(
  client: WebDriverClient,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await tauriInvoke(client, cmd, args);
  if (
    result &&
    typeof result === "object" &&
    "__error" in result &&
    typeof (result as { __error?: unknown }).__error === "string"
  ) {
    throw new Error(`${cmd} failed: ${(result as { __error: string }).__error}`);
  }
  return result;
}

async function emitTauriEvent(
  client: WebDriverClient,
  event: string,
  payload: unknown = null,
): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const event = ${JSON.stringify(event)};
     const payload = ${JSON.stringify(payload)};
     window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload })
       .then(() => cb("ok"))
       .catch(() => {
         window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", {
           target: { kind: "WebviewWindow", label: "main" },
           event,
           payload,
         }).then(() => cb("ok")).catch((error) => cb("__error:" + (error?.message || String(error))));
       });`,
  );
  if (result !== "ok") {
    throw new Error(`emit ${event} failed: ${result}`);
  }
}
