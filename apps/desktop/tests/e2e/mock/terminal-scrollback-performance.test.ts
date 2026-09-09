import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { appendE2ePerfSummaryLine } from "../helpers/perfOutput";
import { tauriInvoke } from "../helpers/vue";

interface TerminalScrollbackStats {
  sessionId: string;
  lineCount: number;
  baseY: number;
  viewportY: number;
  matchingLineCount: number;
  firstMatchingLine: string | null;
  lastMatchingLine: string | null;
  hasEndMarker: boolean;
  elapsedMs: number;
}

describe("terminal scrollback performance (real PTY)", () => {
  const client = new WebDriverClient();
  let testRepoPath = "";
  let repoId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
    testRepoPath = await createFixtureRepo("scrollback-perf-test");
    repoId = await importTestRepo(client, testRepoPath, "scrollback-perf-test");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
      await cleanupFixtureRepos([testRepoPath]);
    }
    await client.deleteSession();
  });

  it("keeps 10K numbered shell lines in xterm scrollback", async () => {
    const sessionId = `shell-repo-${repoId}`;

    await client.executeSync(
      `const ctx = window.__KANNA_E2E__.setupState;
       ctx.keyboardActions.openShellRepoRoot();`,
    );
    await client.waitForElement(".shell-modal .terminal-container", 15_000);

    await sendInputToShellSession(
      client,
      sessionId,
      `awk 'BEGIN { for (i = 1; i <= 10050; i++) printf "KSCROLL%05d\\n", i; print "KSCROLLEND" }'\n`,
    );

    const stats = await waitForScrollbackStats(client, {
      sessionId,
      matcherSource: "^KSCROLL\\d{5}$",
      endMarker: "KSCROLLEND",
      timeoutMs: 60_000,
    });

    await appendE2ePerfSummaryLine(
      [
        "[e2e][terminal-scrollback-perf]",
        `elapsedMs=${stats.elapsedMs.toFixed(1)}ms`,
        `lineCount=${stats.lineCount}`,
        `baseY=${stats.baseY}`,
        `matchingLineCount=${stats.matchingLineCount}`,
        `first=${stats.firstMatchingLine ?? "null"}`,
        `last=${stats.lastMatchingLine ?? "null"}`,
      ].join(" "),
    );

    expect(stats.hasEndMarker).toBe(true);
    expect(stats.matchingLineCount).toBeGreaterThanOrEqual(10_000);
    expect(parseScrollbackLineNumber(stats.firstMatchingLine)).toBeLessThanOrEqual(51);
    expect(stats.lastMatchingLine).toBe("KSCROLL10050");
  });

  it("keeps 10K numbered agent terminal lines after headless snapshot attach", async () => {
    await closeShellModal(client);

    const taskId = await createDeterministicAgentTask(client, {
      repoId,
      repoPath: testRepoPath,
      prompt: "Agent terminal scrollback perf",
      prefix: "ASCROLL",
      count: 10_050,
      selectOnCreate: false,
      initialDelaySeconds: 0,
    });

    const snapshotStats = await waitForDaemonSnapshotStats(client, {
      sessionId: taskId,
      marker: "ASCROLLEND",
      matcherSource: "ASCROLL\\d{5}",
      timeoutMs: 60_000,
    });
    console.log("[e2e][agent-terminal-snapshot-before-attach]", JSON.stringify(snapshotStats));

    await selectTask(client, taskId);
    await client.waitForElement(".main-panel .terminal-container", 15_000);

    const stats = await waitForScrollbackStats(client, {
      sessionId: taskId,
      matcherSource: "^ASCROLL\\d{5}$",
      endMarker: "ASCROLLEND",
      timeoutMs: 60_000,
    });

    await appendE2ePerfSummaryLine(
      [
        "[e2e][agent-terminal-scrollback-perf]",
        `elapsedMs=${stats.elapsedMs.toFixed(1)}ms`,
        `lineCount=${stats.lineCount}`,
        `baseY=${stats.baseY}`,
        `matchingLineCount=${stats.matchingLineCount}`,
        `first=${stats.firstMatchingLine ?? "null"}`,
        `last=${stats.lastMatchingLine ?? "null"}`,
      ].join(" "),
    );

    expect(stats.hasEndMarker).toBe(true);
    expect(stats.matchingLineCount).toBeGreaterThanOrEqual(10_000);
    expect(parseScrollbackLineNumber(stats.firstMatchingLine)).toBeLessThanOrEqual(51);
    expect(stats.lastMatchingLine).toBe("ASCROLL10050");
  });
});

function parseScrollbackLineNumber(line: string | null): number {
  const match = /^[AK]SCROLL(\d{5})$/.exec(line ?? "");
  if (!match) return Number.POSITIVE_INFINITY;
  return Number.parseInt(match[1], 10);
}

async function sendInputToShellSession(
  client: WebDriverClient,
  sessionId: string,
  text: string,
): Promise<void> {
  await tauriInvoke(client, "send_input", {
    sessionId,
    data: Array.from(new TextEncoder().encode(text)),
  });
}

async function closeShellModal(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `const ctx = window.__KANNA_E2E__.setupState;
     const shellTabs = (ctx.mainTabs?.tabs?.value ?? []).filter((tab) => tab.kind === "shell");
     if (shellTabs.length > 0) {
       for (const tab of shellTabs) ctx.mainTabs.closeTab(tab.id);
     }`,
  );
}

interface DeterministicAgentTaskOptions {
  repoId: string;
  repoPath: string;
  prompt: string;
  prefix: string;
  count: number;
  selectOnCreate: boolean;
  initialDelaySeconds: number;
}

async function createDeterministicAgentTask(
  client: WebDriverClient,
  options: DeterministicAgentTaskOptions,
): Promise<string> {
  const setupCommand = buildNumberedOutputCommand(
    options.prefix,
    options.count,
    options.initialDelaySeconds,
  );
  const taskId = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__.setupState;
     Promise.resolve(
       ctx.createItem(${JSON.stringify(options.repoId)}, ${JSON.stringify(options.repoPath)}, ${JSON.stringify(options.prompt)}, "pty", {
         selectOnCreate: ${JSON.stringify(options.selectOnCreate)},
         agentProvider: "claude",
         customTask: {
           executionMode: "pty",
           agentProvider: "claude",
           setup: [${JSON.stringify(setupCommand)}],
         },
       })
     ).then((id) => cb(id)).catch((error) => cb("__error:" + (error?.message || String(error))));`,
  );
  if (!/^[0-9a-f]{8}$/.test(taskId)) {
    throw new Error(`deterministic agent task creation failed: ${taskId}`);
  }
  return taskId;
}

function buildNumberedOutputCommand(prefix: string, count: number, initialDelaySeconds = 0): string {
  const delay = initialDelaySeconds > 0 ? `sleep ${initialDelaySeconds}; ` : "";
  return `${delay}awk -v prefix=${shellQuote(prefix)} -v count=${count} 'BEGIN { for (i = 1; i <= count; i++) printf "%s%05d\\n", prefix, i; printf "%sEND\\n", prefix }'; while true; do sleep 60; done`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
}

interface DaemonSnapshotStats {
  serializedLength: number;
  cols: number | null;
  rows: number | null;
  hasMarker: boolean;
  matchCount: number;
  firstMatchingLine: string | null;
  lastMatchingLine: string | null;
}

interface WaitForDaemonSnapshotOptions {
  sessionId: string;
  marker: string;
  matcherSource: string;
  timeoutMs: number;
}

async function waitForDaemonSnapshotStats(
  client: WebDriverClient,
  options: WaitForDaemonSnapshotOptions,
): Promise<DaemonSnapshotStats> {
  const deadline = Date.now() + options.timeoutMs;
  let latest: DaemonSnapshotStats = {
    serializedLength: 0,
    cols: null,
    rows: null,
    hasMarker: false,
    matchCount: 0,
    firstMatchingLine: null,
    lastMatchingLine: null,
  };

  while (Date.now() < deadline) {
    const snapshot = await tauriInvoke(client, "get_session_recovery_state", {
      sessionId: options.sessionId,
    }).catch(() => null) as { serialized?: string; cols?: number; rows?: number } | null;
    const serialized = snapshot?.serialized ?? "";
    const matches = serialized.match(new RegExp(options.matcherSource, "g")) ?? [];
    latest = {
      serializedLength: serialized.length,
      cols: typeof snapshot?.cols === "number" ? snapshot.cols : null,
      rows: typeof snapshot?.rows === "number" ? snapshot.rows : null,
      hasMarker: serialized.includes(options.marker),
      matchCount: matches.length,
      firstMatchingLine: matches[0] ?? null,
      lastMatchingLine: matches.at(-1) ?? null,
    };
    if (latest.hasMarker && latest.matchCount >= 10_000) return latest;
    await sleep(250);
  }

  throw new Error(
    `timed out waiting for daemon snapshot marker ${options.marker} in ${options.sessionId}; latest=${JSON.stringify(latest)}`,
  );
}

interface WaitForScrollbackStatsOptions {
  sessionId: string;
  matcherSource: string;
  endMarker: string;
  timeoutMs: number;
}

async function waitForScrollbackStats(
  client: WebDriverClient,
  options: WaitForScrollbackStatsOptions,
): Promise<TerminalScrollbackStats> {
  const startedAt = Date.now();
  const deadline = Date.now() + options.timeoutMs;
  let latest: TerminalScrollbackStats | null = null;

  while (Date.now() < deadline) {
    latest = await readScrollbackStats(client, options, startedAt);
    if (latest.hasEndMarker) return latest;
    await sleep(250);
  }

  throw new Error(
    `timed out waiting for ${options.sessionId} scrollback end marker after ${options.timeoutMs}ms; latest=${JSON.stringify(latest)}`,
  );
}

async function readScrollbackStats(
  client: WebDriverClient,
  options: WaitForScrollbackStatsOptions,
  startedAt: number,
): Promise<TerminalScrollbackStats> {
  return await client.executeSync<TerminalScrollbackStats>(
    `const hook = window.__KANNA_E2E__?.terminalBuffers;
     if (!hook) throw new Error("terminalBuffers E2E hook is not available");
     const stats = hook.stats(${JSON.stringify(options.sessionId)}, new RegExp(${JSON.stringify(options.matcherSource)}), ${JSON.stringify(options.endMarker)});
     return { ...stats, elapsedMs: Date.now() - ${startedAt} };`,
  );
}
