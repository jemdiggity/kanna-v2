import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { resolveAppKannaServer } from "../helpers/kannaServer";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { pairWithPeerThroughUi } from "../helpers/transferFlow";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import type { WebDriverClient } from "../helpers/webdriver";

/**
 * Moving a task between machines, driven the way an agent has to drive it.
 *
 * A task manager on 2026-09-06 was asked to move a task from a laptop to a
 * desktop and found no way to say so: the MCP catalog had no transfer tools and
 * `kanna-cli task --help` had no push or pull. It read desktop source, posted a
 * peer id straight at the server's transfer API, got `scheduled: true` back, and
 * reported the task moved — while the transfer was in fact dying on a relay
 * socket. Everything asserted here is one of those four failures:
 *
 *  - a destination is nameable from the CLI, without reading desktop code;
 *  - push and pull go through the same catalog declaration MCP resolves, and
 *    reach the real engine on both machines;
 *  - neither answer can be read as a completed move, and the completed move is
 *    observable through its own surface;
 *  - a duplicate, and a destination that does not exist, are answered honestly.
 *
 * `kanna-cli` is the surface under test rather than a convenience: it and
 * `kanna-mcp` resolve the same `kanna_tool_catalog` declaration and speak to the
 * same routes, so exercising one exercises the wiring of both. The MCP adapter's
 * own copy of that surface is pinned in `crates/kanna-mcp` and the catalog
 * contract tests.
 */

const execFileAsync = promisify(execFile);

const SOURCE_SESSION_ID = "9c4e7b02-51d6-4a3f-9c8e-1f2a3b4c5d6e";
const SOURCE_TRANSCRIPT = [
  JSON.stringify({ type: "user", message: { role: "user", content: "the codeword is cardamom" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: "noted: cardamom" } }),
  "",
].join("\n");

interface SqlRow {
  [column: string]: unknown;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Claude keys transcripts by the session's working directory. */
function claudeProjectSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

function transcriptPathFor(worktreePath: string): string {
  const resolved = existsSync(worktreePath)
    ? realpathSync(worktreePath)
    : join(realpathSync(dirname(worktreePath)), basename(worktreePath));
  return join(homedir(), ".claude/projects", claudeProjectSlug(resolved), `${SOURCE_SESSION_ID}.jsonl`);
}

/**
 * Read one instance's database through its own renderer.
 *
 * Deliberately not a `fetch` at `/v1/e2e/sql`: Node's `fetch` sends
 * `Sec-Fetch-*` headers, which is exactly the signal `lan_trust.rs` uses to
 * classify a request as browser-originated, so those reads are answered 403
 * unless they carry this desktop's local control credential. A `waitForSql`
 * built on one swallows that 403 as "no rows yet" and reports a completed
 * transfer as a timeout — which is what it did the first time this suite ran.
 */
async function instanceSql(
  client: WebDriverClient,
  sql: string,
  params: unknown[] = [],
): Promise<SqlRow[]> {
  const rows = await queryDb(client, sql, params);
  if (rows && typeof rows === "object" && "__error" in (rows as Record<string, unknown>)) {
    throw new Error(String((rows as { __error: unknown }).__error));
  }
  return (rows ?? []) as SqlRow[];
}

async function waitForSql(
  client: WebDriverClient,
  sql: string,
  params: unknown[],
  accept: (rows: SqlRow[]) => boolean,
  label: string,
  timeoutMs = 180_000,
): Promise<SqlRow[]> {
  const deadline = Date.now() + timeoutMs;
  let last: SqlRow[] = [];
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      last = await instanceSql(client, sql, params);
      lastError = null;
    } catch (error) {
      // Kept and re-thrown on timeout. A read that cannot run is not the same
      // answer as a read that returned nothing, and conflating the two is how
      // this suite first reported two completed transfers as timeouts.
      lastError = error;
    }
    if (!lastError && accept(last)) return last;
    await sleep(200);
  }
  if (lastError) {
    throw new Error(`failed reading ${label}: ${lastError}`);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const { primary, secondary } = createPrimaryAndSecondaryClients();
let testRepoPath = "";
let primaryServer = "";
let secondaryServer = "";
let kannaCliPath = "";
const materializedTranscriptDirs = new Set<string>();

/**
 * Run `kanna-cli` exactly as a task agent would: the instance-local binary the
 * app puts on a task's PATH, pointed at one instance's own server.
 *
 * `KANNA_TASK_ID` is cleared deliberately. The suite runs inside whatever
 * session launched it, and a leaked task id would make the CLI resolve a
 * repository context belonging to a completely different machine's database.
 */
async function kannaCli(baseUrl: string, args: string[]): Promise<CliResult> {
  const env = { ...process.env };
  delete env.KANNA_TASK_ID;
  delete env.KANNA_SERVER_URL;
  try {
    const { stdout, stderr } = await execFileAsync(
      kannaCliPath,
      [...args, "--server-url", baseUrl],
      { env, maxBuffer: 16 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

async function kannaCliJson(baseUrl: string, args: string[]): Promise<unknown> {
  const result = await kannaCli(baseUrl, args);
  if (result.code !== 0) {
    throw new Error(`kanna-cli ${args.join(" ")} failed (${result.code}): ${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`kanna-cli ${args.join(" ")} printed non-JSON: ${result.stdout}\n${error}`);
  }
}

/**
 * Poll `kanna-cli task transfers` until one reaches a coarse state, which is
 * the loop the tool descriptions tell an agent to write.
 *
 * The push and pull answers say `moved: false` precisely because this is the
 * only surface that can say otherwise, so the test reads it the documented way
 * rather than sampling it once and hoping the engine got there first.
 */
async function waitForTransferState(
  baseUrl: string,
  taskId: string,
  direction: "incoming" | "outgoing",
  expected: string,
  timeoutMs = 180_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const listed = await kannaCliJson(baseUrl, ["task", "transfers", "--task-id", taskId]) as {
      transfers?: Array<Record<string, unknown>>;
    };
    last = listed.transfers;
    const match = (listed.transfers ?? []).find((transfer) => transfer.direction === direction);
    if (match?.state === expected) return match;
    // A transfer that ended the other way is never going to arrive at the one
    // we asked for, so say that instead of spending the whole window on it.
    if (match && match.state !== "pending") {
      throw new Error(
        `${direction} transfer of ${taskId} reached ${match.state}, not ${expected}: `
        + JSON.stringify(match),
      );
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for a ${expected} ${direction} transfer of ${taskId}: ${JSON.stringify(last)}`,
  );
}

/** Plants a Claude PTY task with a transcript the transfer has to carry. */
async function createSourceTask(repoId: string, prompt: string): Promise<string> {
  const created = await callVueMethod(primary, "store.createItem", repoId, testRepoPath, prompt, "agent");
  if (typeof created !== "string") {
    throw new Error(`failed to create source task: ${JSON.stringify(created)}`);
  }
  await execDb(
    primary,
    "UPDATE pipeline_item SET agent_type = 'pty', agent_provider = 'claude', agent_session_id = ? WHERE id = ?",
    [SOURCE_SESSION_ID, created],
  );
  await callVueMethod(primary, "store.reloadSnapshot");

  const worktree = `${testRepoPath}/.kanna-worktrees/task-${created}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !existsSync(worktree)) await sleep(200);
  const transcript = transcriptPathFor(worktree);
  materializedTranscriptDirs.add(dirname(transcript));
  await mkdir(dirname(transcript), { recursive: true });
  await writeFile(transcript, SOURCE_TRANSCRIPT, "utf8");
  return created;
}

async function destinationTaskFor(sourceTaskId: string): Promise<string> {
  const rows = await waitForSql(
    secondary,
    `SELECT local_task_id, status FROM task_transfer
      WHERE direction = 'incoming' AND source_task_id = ?
      ORDER BY started_at DESC LIMIT 1`,
    [sourceTaskId],
    (rows) => rows[0]?.status === "completed" && Boolean(rows[0]?.local_task_id),
    `incoming transfer of ${sourceTaskId} to complete`,
  );
  return String(rows[0].local_task_id);
}

async function resolveKannaCliPath(client: WebDriverClient): Promise<string> {
  const resolved = await tauriInvoke(client, "which_binary", { name: "kanna-cli" });
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new Error(`kanna-cli is not on this instance's PATH: ${JSON.stringify(resolved)}`);
  }
  return resolved;
}

describe("task transfer through the agent surfaces", () => {
  let repoId = "";

  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    testRepoPath = await createFixtureRepo("local-transfer-agent-surfaces");
    repoId = await importTestRepo(primary, testRepoPath, "local-transfer-agent-surfaces");
    primaryServer = (await resolveAppKannaServer(primary)).baseUrl;
    secondaryServer = (await resolveAppKannaServer(secondary)).baseUrl;
    kannaCliPath = await resolveKannaCliPath(primary);
    await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
      promptClient: secondary,
      promptPeerId: "peer-primary",
    });
  }, 300_000);

  afterAll(async () => {
    for (const directory of materializedTranscriptDirs) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    await cleanupWorktrees(primary, testRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, testRepoPath).catch(() => undefined);
    await cleanupFixtureRepos([testRepoPath].filter(Boolean)).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  }, 300_000);

  /**
   * The first of the four failures: there was no way to name a destination
   * without reading `desktopTransferMachines.ts`. The resolution that used to
   * live in a signed-in window now answers on the CLI.
   */
  it("names the machines a task can move between, without a peer id from desktop source", async () => {
    const listed = await kannaCliJson(secondaryServer, ["machine", "transfer-peers"]) as {
      currentMachineId?: string;
      peers?: Array<Record<string, unknown>>;
    };
    expect(typeof listed.currentMachineId).toBe("string");

    const primaryPeer = (listed.peers ?? []).find((peer) => peer.peerId === "peer-primary");
    expect(primaryPeer, `peer-primary missing from ${JSON.stringify(listed)}`).toBeTruthy();
    expect(primaryPeer).toMatchObject({
      peerId: "peer-primary",
      trusted: true,
      acceptingTransfers: true,
      lanAvailable: true,
      transferable: true,
      preferredTransport: "lan",
      // No cloud route is provisioned in this fixture, so there is nothing to
      // fall back to — and the listing says so rather than implying one.
      cloudAvailable: false,
      cloudFallback: false,
    });
    expect(primaryPeer?.unavailableReason ?? null).toBeNull();

    // A destination is named by identity. Nothing here hands an agent a key, an
    // endpoint, or a relay credential.
    for (const peer of listed.peers ?? []) {
      expect(Object.keys(peer)).not.toContain("publicKey");
      expect(Object.keys(peer)).not.toContain("endpoint");
    }
  }, 120_000);

  it("pulls a task onto this machine and only reports it moved once it has", async () => {
    const sourceTaskId = await createSourceTask(repoId, "Pull me with the CLI");

    const requested = await kannaCliJson(secondaryServer, [
      "task",
      "pull",
      "--source-task-id",
      sourceTaskId,
      "--from-machine",
      "peer-primary",
      "--transport",
      "lan",
    ]) as Record<string, unknown>;

    // The answer the manager needed and did not get: a request, not a move.
    expect(requested).toMatchObject({
      accepted: true,
      state: "requested",
      moved: false,
      sourceTaskId,
    });
    expect(requested.source).toMatchObject({ peerId: "peer-primary", transport: "lan" });
    expect(typeof requested.requestId).toBe("string");
    expect(String(requested.nextStep)).toContain("kanna_task_transfers");

    // A repeat inside the source's request window is the same request, and says
    // so with the same id rather than starting a second move.
    const repeated = await kannaCliJson(secondaryServer, [
      "task",
      "pull",
      "--source-task-id",
      sourceTaskId,
      "--from-machine",
      "peer-primary",
      "--transport",
      "lan",
    ]) as Record<string, unknown>;
    expect(repeated.requestId).toBe(requested.requestId);
    expect(repeated.state).toBe("already_requested");
    expect(repeated.moved).toBe(false);

    const destinationTaskId = await destinationTaskFor(sourceTaskId);

    // The conversation crossed, keyed to the destination's own worktree slug.
    const destinationRepo = await instanceSql(
      secondary,
      `SELECT repo.path AS path FROM repo
         JOIN pipeline_item ON pipeline_item.repo_id = repo.id
        WHERE pipeline_item.id = ?`,
      [destinationTaskId],
    );
    const destinationTranscript = transcriptPathFor(
      `${String(destinationRepo[0].path)}/.kanna-worktrees/task-${destinationTaskId}`,
    );
    materializedTranscriptDirs.add(dirname(destinationTranscript));

    // Ownership, read through the surface an agent is told to read.
    const incoming = await waitForTransferState(
      secondaryServer,
      destinationTaskId,
      "incoming",
      "completed",
    );
    expect(incoming).toMatchObject({ sourceTaskId, localTaskId: destinationTaskId });

    // …and the source half, which is where "moved" is finally true: the
    // outgoing transfer completed and the source task closed.
    await waitForSql(
      primary,
      "SELECT closed_at FROM pipeline_item WHERE id = ?",
      [sourceTaskId],
      (rows) => Boolean(rows[0]?.closed_at),
      "the pulled source task to close",
    );
    const outgoing = await waitForTransferState(
      primaryServer,
      sourceTaskId,
      "outgoing",
      "completed",
    );
    expect(outgoing).toMatchObject({ sourceTaskId });
  }, 600_000);

  it("pushes a task to another machine, and answers a duplicate without starting a second move", async () => {
    const sourceTaskId = await createSourceTask(repoId, "Push me with the CLI");

    const scheduled = await kannaCliJson(primaryServer, [
      "task",
      "push",
      "--task-id",
      sourceTaskId,
      "--to-machine",
      "peer-secondary",
      "--transport",
      "lan",
      "--intent-key",
      "e2e-agent-surface-push",
    ]) as Record<string, unknown>;

    expect(scheduled).toMatchObject({
      scheduled: true,
      state: "scheduled",
      moved: false,
      sourceTaskId,
    });
    expect(scheduled.target).toMatchObject({ peerId: "peer-secondary", transport: "lan" });

    // The same intent again. Whether the engine has already opened the transfer
    // or not, the one thing that must never happen is a second move — so the
    // answer is `scheduled: false` either way, and names which of the two
    // reasons it is.
    const duplicate = await kannaCliJson(primaryServer, [
      "task",
      "push",
      "--task-id",
      sourceTaskId,
      "--to-machine",
      "peer-secondary",
      "--transport",
      "lan",
      "--intent-key",
      "e2e-agent-surface-push",
    ]) as Record<string, unknown>;
    expect(duplicate.scheduled).toBe(false);
    expect(duplicate.moved).toBe(false);
    expect(["already_queued", "already_in_flight"]).toContain(duplicate.state);

    const destinationTaskId = await destinationTaskFor(sourceTaskId);
    expect(destinationTaskId).toBeTruthy();
    await waitForSql(
      primary,
      "SELECT closed_at FROM pipeline_item WHERE id = ?",
      [sourceTaskId],
      (rows) => Boolean(rows[0]?.closed_at),
      "the pushed source task to close",
    );

    await waitForTransferState(primaryServer, sourceTaskId, "outgoing", "completed");

    // One intent, one move. The duplicate cost nothing.
    const departed = await kannaCliJson(primaryServer, [
      "task",
      "transfers",
      "--task-id",
      sourceTaskId,
    ]) as { transfers?: Array<Record<string, unknown>> };
    const outgoing = (departed.transfers ?? []).filter((transfer) => transfer.direction === "outgoing");
    expect(outgoing).toHaveLength(1);
  }, 600_000);

  /**
   * The failure mode that used to be silent. A destination that cannot be
   * resolved has to be refused before anything is queued, and the refusal has to
   * say what does exist — otherwise the only way to find a valid destination is
   * the desktop source code this surface exists to replace.
   */
  it("refuses a destination it cannot resolve, and says which machines it can reach", async () => {
    const sourceTaskId = await createSourceTask(repoId, "Refuse to push me anywhere");

    const refused = await kannaCli(primaryServer, [
      "task",
      "push",
      "--task-id",
      sourceTaskId,
      "--to-machine",
      "desktop-that-does-not-exist",
    ]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("no transfer peer matches machine desktop-that-does-not-exist");
    expect(refused.stderr).toContain("peer-secondary");

    // Nothing was queued: the task has no transfer, and is still open here.
    const transfers = await kannaCliJson(primaryServer, [
      "task",
      "transfers",
      "--task-id",
      sourceTaskId,
    ]) as { transfers?: unknown[] };
    expect(transfers.transfers).toEqual([]);
    const rows = await instanceSql(
      primary,
      "SELECT closed_at FROM pipeline_item WHERE id = ?",
      [sourceTaskId],
    );
    expect(rows[0]?.closed_at ?? null).toBeNull();

    const pullRefused = await kannaCli(secondaryServer, [
      "task",
      "pull",
      "--source-task-id",
      sourceTaskId,
      "--from-machine",
      "desktop-that-does-not-exist",
    ]);
    expect(pullRefused.code).not.toBe(0);
    expect(pullRefused.stderr).toContain("no transfer peer matches machine");
  }, 300_000);
});
