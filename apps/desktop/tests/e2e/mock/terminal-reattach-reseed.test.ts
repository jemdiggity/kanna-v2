import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { cleanupWorktrees, importTestRepoDirect, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const execFileAsync = promisify(execFile);

interface SessionRecoveryStatePayload {
  serialized: string;
  cols: number;
  rows: number;
}

/** The visible text of a daemon terminal snapshot.
 *
 *  The daemon serializes its grid the way xterm's serializer does: content
 *  painted from the cursor with relative movement only and no absolute
 *  addressing, so dropping the escape sequences leaves the rendered rows in
 *  order. */
function daemonFrameLines(serialized: string): string[] {
  return serialized
    .replace(/\u001b\][^\u001b\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[=><78c]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

async function invokeOrThrow(
  client: WebDriverClient,
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const result = await tauriInvoke(client, command, args);
  if (result && typeof result === "object" && "__error" in result) {
    throw new Error(`${command} failed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function readDaemonPid(daemonDir: string): Promise<number> {
  const pid = Number.parseInt(await readFile(join(daemonDir, "daemon.pid"), "utf8"), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`invalid daemon pid ${pid}`);
  }
  return pid;
}

async function waitForDaemonPid(
  daemonDir: string,
  expected: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest = 0;
  while (Date.now() < deadline) {
    latest = await readDaemonPid(daemonDir).catch(() => 0);
    if (latest === expected) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for daemon pid ${expected}; latest=${latest}`);
}

async function processIsGone(pid: number): Promise<boolean> {
  try {
    const result = await execFileAsync("/bin/ps", ["-o", "state=", "-p", String(pid)]);
    const state = result.stdout.trim();
    return state.length === 0 || state.startsWith("Z");
  } catch {
    return true;
  }
}

async function waitForProcessRelease(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await processIsGone(pid)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for daemon pid ${pid} to hand off its sessions`);
}

/** Replace the daemon the way an upgrade does: the successor takes the
 *  sessions over SCM_RIGHTS and the incumbent exits under the live viewer. */
async function replaceDaemon(client: WebDriverClient): Promise<{
  incumbent: number;
  successor: number;
}> {
  const daemonDir = await invokeOrThrow(client, "read_env_var", {
    name: "KANNA_DAEMON_DIR",
  }) as string;
  const incumbent = await readDaemonPid(daemonDir);
  const successor = await invokeOrThrow(client, "spawn_replacement_daemon_for_e2e");
  if (typeof successor !== "number" || !Number.isSafeInteger(successor) || successor <= 0) {
    throw new Error(`replacement daemon returned invalid pid ${String(successor)}`);
  }
  await waitForDaemonPid(daemonDir, successor);
  await waitForProcessRelease(incumbent);
  return { incumbent, successor };
}

async function renderedFrameLines(
  client: WebDriverClient,
  sessionId: string,
): Promise<string[]> {
  const lines = await client.executeSync<string[]>(
    `const hook = window.__KANNA_E2E__?.terminalBuffers;
     if (!hook) throw new Error("terminal buffer hook unavailable");
     return hook.lines(${JSON.stringify(sessionId)});`,
  );
  return lines.map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

async function waitForRenderedText(
  client: WebDriverClient,
  sessionId: string,
  text: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: string[] = [];
  while (Date.now() < deadline) {
    latest = await renderedFrameLines(client, sessionId).catch(() => []);
    if (latest.some((line) => line.includes(text))) return;
    await sleep(200);
  }
  throw new Error(
    `timed out waiting for "${text}" in ${sessionId}; last lines=${JSON.stringify(latest.slice(-5))}`,
  );
}

async function waitForDaemonSnapshotText(
  client: WebDriverClient,
  sessionId: string,
  text: string,
  timeoutMs = 30_000,
): Promise<SessionRecoveryStatePayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await invokeOrThrow(client, "get_session_recovery_state", { sessionId })
      .catch(() => null);
    if (
      latest
      && typeof latest === "object"
      && "serialized" in latest
      && typeof latest.serialized === "string"
      && latest.serialized.includes(text)
    ) {
      return latest as SessionRecoveryStatePayload;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for "${text}" in the daemon snapshot for ${sessionId}`);
}

/** Leave output queued in xterm that it has not parsed yet.
 *
 *  This is what a loaded machine produces: the viewer accepts terminal frames
 *  faster than xterm parses them, so a snapshot pushed by a stream re-attach
 *  lands with earlier output still in front of it. Writing the chunks straight
 *  into the viewer's terminal reproduces that state without having to race a
 *  PTY against the handoff. */
async function queueUnparsedOutput(
  client: WebDriverClient,
  sessionId: string,
  chunks: number,
): Promise<void> {
  await client.executeSync(
    `const hook = window.__KANNA_E2E__?.terminalBuffers;
     if (!hook) throw new Error("terminal buffer hook unavailable");
     const line = "KRESEED_FILLER_" + "x".repeat(60) + "\\r\\n";
     for (let index = 0; index < ${chunks}; index += 1) {
       hook.write(${JSON.stringify(sessionId)}, line);
     }
     return null;`,
  );
}

// Importing the fixture repo leaves its own setup task selected, and the row
// for a task inserted straight into the database only exists once the store
// has refreshed. Keep asking until this task owns the terminal view.
async function selectTask(client: WebDriverClient, taskId: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    const result = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(ctx.refreshAllItems())
         .then(() => ctx.store.selectItem(${JSON.stringify(taskId)}))
         .then(() => cb("ok"))
         .catch((error) => cb("__error:" + (error?.message || String(error))));`,
    );
    if (result === "ok") {
      latest = await client.executeSync(
        "return window.__KANNA_E2E__.setupState.store.selectedTaskId ?? null;",
      );
      if (latest === taskId) return;
    } else {
      latest = result;
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for task ${taskId} to be selected; latest=${JSON.stringify(latest)}`,
  );
}

// A daemon can be replaced under a live viewer — an upgrade, or a handoff
// after the incumbent goes away. The server's terminal stream re-attaches to
// the successor and pushes a fresh snapshot, and the owner viewer has to
// hydrate from it exactly as a fresh attach would. When it does not, the grid
// renders as the deltas without the initial state: only the cells that
// changed after the re-attach are painted, and everything older is blank.
//
// The follower's cell for the same hydration is
// `src/composables/terminalSnapshotApply.test.ts`, which drives the owner and
// follower call shapes against a real xterm; the follower's own transport is
// covered by the two-instance `real/remote-visual-companion.test.ts`.
describe("terminal re-attach re-seed", () => {
  const client = new WebDriverClient();
  let fixtureRepoPath = "";
  let repoId = "";
  const sessionIds: string[] = [];

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
    fixtureRepoPath = await createFixtureRepo("terminal-reattach-reseed");
    repoId = await importTestRepoDirect(client, fixtureRepoPath, "Terminal re-attach re-seed");
  });

  afterAll(async () => {
    for (const sessionId of sessionIds) {
      await tauriInvoke(client, "kill_session", { sessionId }).catch(() => null);
    }
    if (fixtureRepoPath) {
      await cleanupWorktrees(client, fixtureRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([fixtureRepoPath]);
    }
    await client.deleteSession();
  });

  it("keeps the whole grid when the daemon is replaced under the owner viewer", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const sessionId = `reseed-${suffix}`;
    sessionIds.push(sessionId);
    const readyMarker = `KRESEED_READY_${suffix}`;
    const settledMarker = `KRESEED_SETTLED_${suffix}`;
    const deltaMarker = `KRESEED_DELTA_${suffix}`;
    const frameRows = Array.from(
      { length: 8 },
      (_, index) => `KRESEED_ROW_${String(index + 1).padStart(2, "0")}_${suffix}`,
    );
    const quietPath = join(fixtureRepoPath, `reseed-quiet-${suffix}`);
    // The delta is written with absolute addressing and the cursor saved and
    // restored around it, so it changes one row and leaves the rest of the
    // frame exactly as it was before the handoff.
    const script = [
      "printf '\\033[2J\\033[H'",
      ...frameRows.map((row) => `printf '${row}\\n'`),
      `printf '${readyMarker}\\n'`,
      `while [ ! -f ${quietPath} ]; do sleep 0.05; done`,
      `printf '\\0337\\033[3;1H\\033[2K${deltaMarker}\\0338'`,
      `printf '\\0337\\033[999;1H${settledMarker}\\0338'`,
      "while IFS= read -r line; do :; done",
    ].join("; ");

    await execDb(
      client,
      `INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type, agent_provider)
       VALUES (?, ?, ?, 'in progress', 'pty', 'claude')`,
      [sessionId, repoId, "Daemon replacement re-seed fixture"],
    );
    await invokeOrThrow(client, "spawn_session", {
      sessionId,
      cwd: fixtureRepoPath,
      executable: "/bin/zsh",
      args: ["-f", "-c", script],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
      agentProvider: "claude",
    });
    await callVueMethod(client, "loadItems", repoId);
    await selectTask(client, sessionId);
    await client.waitForElement(".main-panel .terminal-container", 20_000);
    await waitForRenderedText(client, sessionId, readyMarker);

    await queueUnparsedOutput(client, sessionId, 10_000);
    const replacement = await replaceDaemon(client);
    expect(replacement.successor).not.toBe(replacement.incumbent);

    // Quiesce, then change exactly one row. Every other frame row predates the
    // handoff, so it can only still be on screen if the viewer was re-seeded
    // from the re-attach snapshot rather than left holding the deltas that
    // arrived after it.
    await writeFile(quietPath, "");
    await waitForRenderedText(client, sessionId, deltaMarker, 60_000);
    await waitForRenderedText(client, sessionId, settledMarker, 60_000);
    const snapshot = await waitForDaemonSnapshotText(client, sessionId, deltaMarker);
    // The daemon's frame and the viewer's buffer settle through different
    // paths; give the last deltas a beat to be parsed before comparing them.
    await sleep(1_000);

    const rendered = await renderedFrameLines(client, sessionId);
    for (const [index, row] of frameRows.entries()) {
      if (index === 2) continue;
      expect(rendered).toContain(row);
    }
    expect(rendered).toContain(deltaMarker);
    expect(rendered).not.toContain(frameRows[2]);
    expect(daemonFrameLines(snapshot.serialized)).toEqual(rendered);

    const evidenceDir = process.env.KANNA_VISUAL_EVIDENCE_DIR;
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await dismissStartupShortcutsModal(client);
      await client.executeSync(
        `window.__KANNA_E2E__?.terminalBuffers?.refresh(${JSON.stringify(sessionId)});`,
      );
      await sleep(400);
      await client.screenshot(join(evidenceDir, "terminal-reattach-reseed.png"));
    }
  });
});
