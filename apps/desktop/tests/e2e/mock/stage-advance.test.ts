import { join } from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript } from "../helpers/keyboard";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__error" in value &&
    typeof (value as { __error?: unknown }).__error === "string",
  );
}

async function waitForActivePostAction(
  client: WebDriverClient,
  taskId: string,
  expectedPostAction: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT stage, active_post_action FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ stage: string | null; active_post_action: string | null }>;
    const row = rows[0];
    if (row?.stage === "in progress" && row.active_post_action === expectedPostAction) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${taskId} to enter post-action ${expectedPostAction}`);
}

async function waitForClosedTask(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT stage, closed_at FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ stage: string | null; closed_at: string | null }>;
    const row = rows[0];
    if (row?.stage === "done" && typeof row.closed_at === "string" && row.closed_at.length > 0) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${taskId} to close`);
}

async function hydrateStoreItem(client: WebDriverClient, taskId: string): Promise<void> {
  const rows = (await queryDb(
    client,
    "SELECT * FROM pipeline_item WHERE id = ?",
    [taskId],
  )) as Array<Record<string, unknown>>;
  const item = rows[0];
  if (!item) {
    throw new Error(`seeded task ${taskId} was not found`);
  }

  const result = await client.executeSync<string>(
    `const item = ${JSON.stringify(item)};
     const ctx = window.__KANNA_E2E__.setupState;
     const items = ctx.store?.items?.value ?? ctx.store?.items;
     if (!Array.isArray(items)) return "items-unavailable";
     const index = items.findIndex((candidate) => candidate.id === item.id);
     if (index >= 0) items.splice(index, 1, item);
     else items.push(item);
     return "ok";`,
  );
  if (result !== "ok") {
    throw new Error(`failed to hydrate store item: ${result}`);
  }
}

async function injectCloudSnapshot(
  client: WebDriverClient,
  snapshot: { repos: Array<Record<string, unknown>>; items: Array<Record<string, unknown>>; terminalRefs?: Record<string, unknown> },
): Promise<void> {
  const result = await client.executeSync<string>(
    `const ctx = window.__KANNA_E2E__.setupState;
     const snapshot = ${JSON.stringify(snapshot)};
     const cloudSnapshot = ctx.cloudSnapshot;
     if (!cloudSnapshot) return "cloud-snapshot-unavailable";
     if (cloudSnapshot.__v_isRef) cloudSnapshot.value = snapshot;
     else Object.assign(cloudSnapshot, snapshot);
     return "ok";`,
  );
  if (result !== "ok") {
    throw new Error(`failed to inject cloud snapshot: ${result}`);
  }
}

async function sendPipelineStageComplete(client: WebDriverClient, taskId: string): Promise<void> {
  const socketPath = await tauriInvoke(client, "get_pipeline_socket_path");
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new Error(`unexpected pipeline socket path: ${JSON.stringify(socketPath)}`);
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = createConnection(socketPath);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      settle(new Error(`timed out sending pipeline_stage_complete for ${taskId}`));
    }, 5_000);

    socket.once("error", (error) => settle(error));
    socket.once("connect", () => {
      socket.end(`${JSON.stringify({ type: "stage_complete", task_id: taskId })}\n`);
    });
    socket.once("close", (hadError) => {
      if (!hadError) settle();
    });
  });
}

interface CreatedStageTaskRow {
  id: string | null;
  display_name: string | null;
  base_ref: string | null;
}

interface WaitForCreatedStageTaskOptions {
  excludeIds?: Iterable<string>;
  displayName?: string;
  baseRef?: string;
}

async function getStageTaskIds(
  client: WebDriverClient,
  repoId: string,
  stage: string,
): Promise<Set<string>> {
  const rows = (await queryDb(
    client,
    "SELECT id FROM pipeline_item WHERE repo_id = ? AND stage = ? AND closed_at IS NULL",
    [repoId, stage],
  )) as Array<{ id: string | null }>;
  return new Set(rows.flatMap((row) => (row.id ? [row.id] : [])));
}

async function waitForCreatedStageTask(
  client: WebDriverClient,
  repoId: string,
  stage: string,
  options: WaitForCreatedStageTaskOptions = {},
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const excludeIds = new Set(options.excludeIds ?? []);
  while (Date.now() < deadline) {
    const rows = (await queryDb(
      client,
      "SELECT id, display_name, base_ref FROM pipeline_item WHERE repo_id = ? AND stage = ? AND closed_at IS NULL ORDER BY created_at DESC, id DESC",
      [repoId, stage],
    )) as CreatedStageTaskRow[];
    const row = rows.find((candidate) => {
      if (!candidate.id || excludeIds.has(candidate.id)) return false;
      if (options.displayName !== undefined && candidate.display_name !== options.displayName) return false;
      if (options.baseRef !== undefined && candidate.base_ref !== options.baseRef) return false;
      return true;
    });
    if (row?.id) return row.id;
    await sleep(100);
  }
  throw new Error(`timed out waiting for a ${stage} task`);
}

async function waitForSelectedTask(client: WebDriverClient, expectedTaskId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const selectedTaskId = await getVueState(client, "selectedItemId");
    if (selectedTaskId === expectedTaskId) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for selected task ${expectedTaskId}`);
}

async function waitForSidebarToExcludeText(
  client: WebDriverClient,
  text: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSidebarText = "";
  while (Date.now() < deadline) {
    lastSidebarText = await client.executeSync<string>(
      `return document.querySelector(".sidebar")?.textContent || "";`,
    );
    if (!lastSidebarText.includes(text)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for sidebar to remove ${JSON.stringify(text)}; saw ${JSON.stringify(lastSidebarText)}`);
}

async function clickSidebarItemByTitle(
  client: WebDriverClient,
  title: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await client.executeSync<boolean>(
      `const title = ${JSON.stringify(title)};
       const titles = Array.from(document.querySelectorAll(".sidebar .item-title"));
       const match = titles.find((element) => element.textContent?.includes(title));
       const item = match?.closest(".pipeline-item");
       if (!item) return false;
       item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
       return true;`,
    );
    if (clicked) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for sidebar item ${JSON.stringify(title)}`);
}

async function waitForFileSize(path: string, expectedSize: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const size = await stat(path).then((stats) => stats.size).catch(() => 0);
    if (size === expectedSize) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${path} to reach ${expectedSize} bytes`);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await stat(path).then((stats) => stats.isFile()).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function resolveKannaServerBinary(): Promise<string> {
  const repoRoot = join(process.cwd(), "../..");
  const explicitBinary = process.env.KANNA_E2E_KANNA_SERVER_BINARY;
  if (explicitBinary) {
    if (await stat(explicitBinary).then((stats) => stats.isFile()).catch(() => false)) {
      return explicitBinary;
    }
    throw new Error(`KANNA_E2E_KANNA_SERVER_BINARY does not point to a file: ${explicitBinary}`);
  }

  const hostTarget = await resolveRustHostTarget();
  const hostCandidates = [
    join(repoRoot, ".build", hostTarget, "debug", "kanna-server"),
    join(process.cwd(), "src-tauri", "binaries", `kanna-server-${hostTarget}`),
  ];
  const hostMatches = await existingFiles(hostCandidates);
  if (hostMatches.length > 0) {
    hostMatches.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return hostMatches[0].path;
  }

  const fallbackCandidates = [
    join(repoRoot, ".build", "debug", "kanna-server"),
    join(process.cwd(), "src-tauri", "binaries", "kanna-server-aarch64-apple-darwin"),
    join(process.cwd(), "src-tauri", "binaries", "kanna-server-x86_64-apple-darwin"),
    join(repoRoot, ".build", "aarch64-apple-darwin", "debug", "kanna-server"),
    join(repoRoot, ".build", "x86_64-apple-darwin", "debug", "kanna-server"),
  ];
  for (const candidate of fallbackCandidates) {
    if (await stat(candidate).then((stats) => stats.isFile()).catch(() => false)) {
      return candidate;
    }
  }
  throw new Error(`kanna-server sidecar not found in ${[...hostCandidates, ...fallbackCandidates].join(", ")}`);
}

async function resolveRustHostTarget(): Promise<string> {
  const output = await execFileAsync("rustc", ["-vV"])
    .then(({ stdout }) => stdout)
    .catch(() => "");
  const hostLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("host:"));
  const hostTarget = hostLine?.replace("host:", "").trim();
  if (hostTarget) return hostTarget;
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  return `${process.arch}-${process.platform}`;
}

async function existingFiles(paths: string[]): Promise<Array<{ path: string; mtimeMs: number }>> {
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const path of paths) {
    const stats = await stat(path).catch(() => null);
    if (stats?.isFile()) {
      matches.push({ path, mtimeMs: stats.mtimeMs });
    }
  }
  return matches;
}

async function startTestKannaServer(
  client: WebDriverClient,
  configDir: string,
): Promise<{ baseUrl: string; child: ChildProcessWithoutNullStreams }> {
  const appDataDir = await tauriInvoke(client, "get_app_data_dir") as string;
  const dbName = await tauriInvoke(client, "read_env_var", { name: "KANNA_DB_NAME" }) as string;
  const daemonDir = process.env.KANNA_DAEMON_DIR;
  if (!daemonDir) throw new Error("KANNA_DAEMON_DIR is required for server E2E");

  const port = await findFreePort();
  const configPath = join(configDir, "server-api-e2e.toml");
  const pairingStorePath = join(configDir, "server-api-e2e-pairings.json");
  await writeFile(
    configPath,
    [
      'relay_url = "wss://relay.example.invalid"',
      'device_token = "e2e-token"',
      `daemon_dir = "${escapeTomlString(daemonDir)}"`,
      `db_path = "${escapeTomlString(join(appDataDir, dbName))}"`,
      'desktop_id = "desktop-e2e"',
      'desktop_name = "Kanna E2E"',
      'lan_host = "127.0.0.1"',
      `lan_port = ${port}`,
      `pairing_store_path = "${escapeTomlString(pairingStorePath)}"`,
      "",
    ].join("\n"),
  );

  const child = spawn(await resolveKannaServerBinary(), [], {
    env: { ...process.env, KANNA_SERVER_CONFIG: configPath },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`kanna-server exited early with code ${child.exitCode}: ${stderr}`);
    }
    const response = await fetch(`${baseUrl}/v1/status`).catch(() => null);
    if (response?.ok) return { baseUrl, child };
    await sleep(250);
  }

  child.kill();
  throw new Error(`timed out waiting for kanna-server at ${baseUrl}: ${stderr}`);
}

describe("stage advance", () => {
  const client = new WebDriverClient();
  let repoId = "";
  let fixtureRepoRoot = "";
  let testRepoPath = "";
  let renamedStageTaskId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("stage-advance-test");
    testRepoPath = fixtureRepoRoot;

    const pipelineName = "continue-e2e";
    const kannaDir = join(testRepoPath, ".kanna");
    await mkdir(join(kannaDir, "pipelines"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "commit-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "agents", "revision-e2e"), { recursive: true });
    await mkdir(join(kannaDir, "fake-bin"), { recursive: true });
    await writeFile(
      join(kannaDir, "config.json"),
      JSON.stringify({
        setup: [
          "export PATH=\"$PWD/.kanna/fake-bin:$PATH\"",
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "pipelines", `${pipelineName}.json`),
      JSON.stringify({
        name: pipelineName,
        stages: [
          {
            name: "in progress",
            transition: "manual",
            post_action: {
              name: "commit",
              transition: "auto",
              agent: "commit-e2e",
              prompt: "Commit stage marker for $TASK_PROMPT",
            },
          },
          { name: "pr", transition: "manual" },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "pipelines", "auto-spawn-focus-e2e.json"),
      JSON.stringify({
        name: "auto-spawn-focus-e2e",
        stages: [
          { name: "auto-source", transition: "auto" },
          { name: "review", transition: "manual" },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "pipelines", "final-stage-e2e.json"),
      JSON.stringify({
        name: "final-stage-e2e",
        stages: [
          { name: "in progress", transition: "manual" },
          { name: "pr", transition: "manual" },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "pipelines", "revision-e2e.json"),
      JSON.stringify({
        name: "revision-e2e",
        stages: [
          {
            name: "in progress",
            transition: "manual",
            agent: "revision-e2e",
          },
          { name: "review", transition: "auto" },
          { name: "pr", transition: "manual" },
        ],
      }),
    );
    await writeFile(
      join(kannaDir, "agents", "commit-e2e", "AGENT.md"),
      [
        "---",
        "name: Commit E2E",
        "description: Verifies post-action advancement.",
        "---",
        "Commit agent generated prompt marker.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(kannaDir, "agents", "revision-e2e", "AGENT.md"),
      [
        "---",
        "name: Revision E2E",
        "description: Captures request-revision prompts.",
        "agent_provider: codex",
        "---",
        "Implement revision:",
        "$TASK_PROMPT",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(kannaDir, "fake-bin", "codex"),
      [
        "#!/bin/sh",
        "mkdir -p .kanna",
        "printf '%s\\n' \"$@\" > .kanna/revision-codex-args.txt",
        "",
      ].join("\n"),
    );
    await chmod(join(kannaDir, "fake-bin", "codex"), 0o755);
    await git(testRepoPath, ["add", ".kanna"]);
    await git(testRepoPath, ["commit", "-m", "test: add kanna stage fixtures"]);

    repoId = await importTestRepo(client, testRepoPath, "stage-advance-test");
  });

  afterAll(async () => {
    await tauriInvoke(client, "kill_session", { sessionId: "continue-stage-task" }).catch(() => undefined);
    await tauriInvoke(client, "kill_session", { sessionId: "continue-stage-claude-enter-task" }).catch(() => undefined);
    await tauriInvoke(client, "kill_session", { sessionId: "continue-stage-copilot-task" }).catch(() => undefined);
    await tauriInvoke(client, "kill_session", { sessionId: "server-continue-stage-task" }).catch(() => undefined);
    if (renamedStageTaskId) {
      await tauriInvoke(client, "kill_session", { sessionId: renamedStageTaskId }).catch(() => undefined);
    }
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("keeps an automatically spawned next-stage task in the background when follow_task is omitted", async () => {
    const sourceTaskId = "auto-spawn-focus-source";
    const sourceBranch = "task-auto-spawn-focus-source";
    const activeTaskId = "auto-spawn-focus-active";
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch: sourceBranch,
      path: join(testRepoPath, ".kanna-worktrees", sourceBranch),
      startPoint: "main",
    });

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sourceTaskId,
        repoId,
        "Automatically spawn review",
        "auto-spawn-focus-e2e",
        "auto-source",
        null,
        "[]",
        sourceBranch,
        "pty",
        "codex",
        "idle",
        null,
        "2026-05-06T00:00:00.000Z",
        "2026-05-06T00:00:00.000Z",
      ],
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activeTaskId,
        repoId,
        "Keep this task selected",
        "auto-spawn-focus-e2e",
        "auto-source",
        null,
        "[]",
        null,
        "sdk",
        "codex",
        "idle",
        null,
        "2026-05-06T00:01:00.000Z",
        "2026-05-06T00:01:00.000Z",
      ],
    );
    await hydrateStoreItem(client, sourceTaskId);
    await hydrateStoreItem(client, activeTaskId);

    const selectResult = await callVueMethod(client, "store.selectItem", activeTaskId);
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);
    await waitForSelectedTask(client, activeTaskId);

    await execDb(
      client,
      "UPDATE pipeline_item SET stage_result = ?, updated_at = datetime('now') WHERE id = ?",
      [JSON.stringify({ status: "success", summary: "ready for review" }), sourceTaskId],
    );
    const existingReviewTaskIds = await getStageTaskIds(client, repoId, "review");
    await sendPipelineStageComplete(client, sourceTaskId);

    const reviewTaskId = await waitForCreatedStageTask(client, repoId, "review", {
      excludeIds: existingReviewTaskIds,
      displayName: "Automatically spawn review",
      baseRef: sourceBranch,
    });
    expect(reviewTaskId).not.toBe(sourceTaskId);
    await sleep(500);
    expect(await getVueState(client, "selectedItemId")).toBe(activeTaskId);
  });

  it("creates the next stage task from the source worktree's renamed branch", async () => {
    const sourceTaskId = "renamed-source-stage-task";
    const storedSourceBranch = "task-renamed-source-stage";
    const actualSourceBranch = "renamed/stage-source-e2e";
    const markerName = "renamed-source-stage-marker.txt";
    const markerContent = "created on the renamed source branch\n";
    const sourceWorktreePath = join(testRepoPath, ".kanna-worktrees", storedSourceBranch);

    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch: storedSourceBranch,
      path: sourceWorktreePath,
      startPoint: "main",
    });
    await git(sourceWorktreePath, ["branch", "-m", actualSourceBranch]);
    await writeFile(join(sourceWorktreePath, markerName), markerContent);
    await git(sourceWorktreePath, ["add", markerName]);
    await git(sourceWorktreePath, ["commit", "-m", "test: marker on renamed source branch"]);

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        sourceTaskId,
        repoId,
        "Advance from renamed source",
        "auto-spawn-focus-e2e",
        "auto-source",
        JSON.stringify({ status: "success", summary: "ready for review" }),
        "[]",
        storedSourceBranch,
        "pty",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, sourceTaskId);

    const existingReviewTaskIds = await getStageTaskIds(client, repoId, "review");
    const advanceResult = await callVueMethod(client, "store.advanceStage", sourceTaskId);
    if (isVueCallError(advanceResult)) throw new Error(advanceResult.__error);

    renamedStageTaskId = await waitForCreatedStageTask(client, repoId, "review", {
      excludeIds: existingReviewTaskIds,
      displayName: "Advance from renamed source",
      baseRef: actualSourceBranch,
    });
    expect(renamedStageTaskId).not.toBe(sourceTaskId);

    const rows = (await queryDb(
      client,
      "SELECT branch, base_ref FROM pipeline_item WHERE id = ?",
      [renamedStageTaskId],
    )) as Array<{ branch: string | null; base_ref: string | null }>;
    const createdBranch = rows[0]?.branch;
    expect(createdBranch).toBeTruthy();
    expect(rows[0]?.base_ref).toBe(actualSourceBranch);

    const createdMarkerPath = join(testRepoPath, ".kanna-worktrees", createdBranch as string, markerName);
    await waitForFileSize(createdMarkerPath, Buffer.byteLength(markerContent), 20_000);
    expect(await readFile(createdMarkerPath, "utf8")).toBe(markerContent);
  });

  it("starts a live task commit post-action through the daemon input command", async () => {
    const taskId = "continue-stage-task";
    const inputCapturePath = join(testRepoPath, ".kanna", "continue-stage-input.bin");
    const expectedPrompt = [
      "Commit agent generated prompt marker.",
      "",
      "Commit stage marker for Write the commit",
    ].join("\n");
    const expectedInput = Buffer.from(`${expectedPrompt}\x1b[13u`, "utf8");
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "Write the commit",
        "continue-e2e",
        "in progress",
        JSON.stringify({ status: "success", summary: "implemented" }),
        "[]",
        "task-continue-stage",
        "pty",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, taskId);

    await tauriInvoke(client, "spawn_session", {
      sessionId: taskId,
      cwd: testRepoPath,
      executable: "/bin/sh",
      args: [
        "-lc",
        `stty raw -echo; dd bs=1 count=${expectedInput.length} of=.kanna/continue-stage-input.bin 2>/dev/null`,
      ],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });

    const advanceResult = await callVueMethod(client, "store.advanceStage", taskId);
    if (isVueCallError(advanceResult)) throw new Error(advanceResult.__error);

    await waitForActivePostAction(client, taskId, "commit");
    await waitForFileSize(inputCapturePath, expectedInput.length);
    expect(await readFile(inputCapturePath)).toEqual(expectedInput);
  });

  it("advances a commit post-action through the server API without creating a new task", async () => {
    const taskId = "server-continue-stage-task";
    const branch = "task-server-continue-stage";
    const worktreePath = join(testRepoPath, ".kanna-worktrees", branch);
    const inputCapturePath = join(worktreePath, ".kanna", "server-continue-stage-input.bin");
    const expectedPrompt = [
      "Commit agent generated prompt marker.",
      "",
      "Commit stage marker for Write the server commit",
    ].join("\n");
    const expectedInput = Buffer.from(`\x1b[200~${expectedPrompt}\x1b[201~\x1b[13u`, "utf8");

    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: worktreePath,
      startPoint: "main",
    });
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "Write the server commit",
        "continue-e2e",
        "in progress",
        JSON.stringify({ status: "success", summary: "implemented over HTTP" }),
        "[]",
        branch,
        "pty",
        "claude",
        "idle",
        null,
      ],
    );

    await tauriInvoke(client, "spawn_session", {
      sessionId: taskId,
      cwd: worktreePath,
      executable: "/bin/sh",
      args: [
        "-lc",
        `stty raw -echo; dd bs=1 count=${expectedInput.length} of=.kanna/server-continue-stage-input.bin 2>/dev/null`,
      ],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "claude",
    });

    const server = await startTestKannaServer(client, join(testRepoPath, ".kanna"));
    try {
      const response = await fetch(`${server.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/advance-stage`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`advance-stage failed: ${response.status} ${await response.text()}`);
      }
      expect(await response.json()).toEqual({ taskId });

      await waitForActivePostAction(client, taskId, "commit");
      await waitForFileSize(inputCapturePath, expectedInput.length);
      expect(await readFile(inputCapturePath)).toEqual(expectedInput);

      const rows = (await queryDb(
        client,
        "SELECT stage, active_post_action, stage_result, closed_at, branch FROM pipeline_item WHERE repo_id = ? ORDER BY id",
        [repoId],
      )) as Array<{
        stage: string | null;
        active_post_action: string | null;
        stage_result: string | null;
        closed_at: string | null;
        branch: string | null;
      }>;
      const row = rows.find((candidate) => candidate.branch === branch);
      expect(row).toEqual({
        stage: "in progress",
        active_post_action: "commit",
        stage_result: null,
        closed_at: null,
        branch,
      });
      expect(rows.filter((candidate) => candidate.branch === branch)).toHaveLength(1);
    } finally {
      server.child.kill();
    }
  });

  it("requests a revision through the server API without replacing the reviewed task title", async () => {
    const taskId = "server-request-revision-title-task";
    const branch = "task-server-request-revision-title";
    const worktreePath = join(testRepoPath, ".kanna-worktrees", branch);
    const originalTitle = "Preserve reviewed task title";
    const reviewPrompt = "Review prompt that should be hidden after revision.";
    const revisionPrompt = "Add E2E coverage for the request-revision title path.";
    const expectedAgentPrompt = [
      "Implement revision:",
      revisionPrompt,
    ].join("\n");

    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: worktreePath,
      startPoint: "main",
    });
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        reviewPrompt,
        "revision-e2e",
        "review",
        JSON.stringify({ status: "success", summary: "ready for review" }),
        "[]",
        branch,
        "pty",
        "codex",
        "idle",
        originalTitle,
      ],
    );
    await hydrateStoreItem(client, taskId);

    const existingInProgressTaskIds = await getStageTaskIds(client, repoId, "in progress");
    const server = await startTestKannaServer(client, join(testRepoPath, ".kanna"));
    try {
      const response = await fetch(`${server.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/actions/request-revision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetStage: "in progress",
          summary: "missing request-revision title coverage",
          prompt: revisionPrompt,
          metadata: { source: "e2e" },
        }),
      });
      if (!response.ok) {
        throw new Error(`request-revision failed: ${response.status} ${await response.text()}`);
      }

      const body = await response.json() as { taskId: string };
      const revisionTaskId = body.taskId;
      expect(revisionTaskId).toBeTruthy();
      expect(existingInProgressTaskIds.has(revisionTaskId)).toBe(false);

      const rows = (await queryDb(
        client,
        `SELECT id, prompt, display_name, stage, closed_at, branch
         FROM pipeline_item
         WHERE id IN (?, ?)
         ORDER BY id`,
        [taskId, revisionTaskId],
      )) as Array<{
        id: string | null;
        prompt: string | null;
        display_name: string | null;
        stage: string | null;
        closed_at: string | null;
        branch: string | null;
      }>;
      const reviewed = rows.find((row) => row.id === taskId);
      const revision = rows.find((row) => row.id === revisionTaskId);
      expect(reviewed?.stage).toBe("done");
      expect(reviewed?.closed_at).toBeTruthy();
      expect(revision?.stage).toBe("in progress");
      expect(revision?.display_name).toBe(originalTitle);
      expect(revision?.prompt).toBe(expectedAgentPrompt);
      expect(revision?.branch).toMatch(/^task-/);

      const createdWorktreePath = join(testRepoPath, ".kanna-worktrees", revision?.branch ?? "");
      const capturedArgsPath = join(createdWorktreePath, ".kanna", "revision-codex-args.txt");
      await waitForFile(capturedArgsPath, 20_000);
      const capturedArgs = await readFile(capturedArgsPath, "utf8");
      expect(capturedArgs).toContain("--yolo\n");
      expect(capturedArgs).toContain(`${expectedAgentPrompt}\n`);

      const tasksResponse = await fetch(`${server.baseUrl}/v1/repos/${encodeURIComponent(repoId)}/tasks`);
      if (!tasksResponse.ok) {
        throw new Error(`list tasks failed: ${tasksResponse.status} ${await tasksResponse.text()}`);
      }
      const tasks = await tasksResponse.json() as Array<{ id: string; title: string; stage: string | null }>;
      expect(tasks.find((task) => task.id === taskId)).toBeUndefined();
      expect(tasks.find((task) => task.id === revisionTaskId)).toMatchObject({
        id: revisionTaskId,
        title: originalTitle,
        stage: "in progress",
      });
    } finally {
      server.child.kill();
    }
  });

  it("submits a Claude commit post-action with the terminal Enter sequence", async () => {
    const taskId = "continue-stage-claude-enter-task";
    const inputCapturePath = join(testRepoPath, ".kanna", "continue-stage-claude-enter-input.bin");
    const expectedPrompt = [
      "Commit agent generated prompt marker.",
      "",
      "Commit stage marker for Write the commit",
    ].join("\n");
    const expectedInput = Buffer.from(`\x1b[200~${expectedPrompt}\x1b[201~\x1b[13u`, "utf8");
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "Write the commit",
        "continue-e2e",
        "in progress",
        JSON.stringify({ status: "success", summary: "implemented" }),
        "[]",
        "task-continue-stage-claude-enter",
        "pty",
        "claude",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, taskId);

    await tauriInvoke(client, "spawn_session", {
      sessionId: taskId,
      cwd: testRepoPath,
      executable: "/bin/sh",
      args: [
        "-lc",
        `stty raw -echo; dd bs=1 count=${expectedInput.length} of=.kanna/continue-stage-claude-enter-input.bin 2>/dev/null`,
      ],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "claude",
    });

    const advanceResult = await callVueMethod(client, "store.advanceStage", taskId);
    if (isVueCallError(advanceResult)) throw new Error(advanceResult.__error);

    await waitForActivePostAction(client, taskId, "commit");
    await waitForFileSize(inputCapturePath, expectedInput.length);
    expect(await readFile(inputCapturePath)).toEqual(expectedInput);
  });

  it("submits a Copilot commit post-action with carriage return", async () => {
    const taskId = "continue-stage-copilot-task";
    const inputCapturePath = join(testRepoPath, ".kanna", "continue-stage-copilot-input.bin");
    const expectedPrompt = [
      "Commit agent generated prompt marker.",
      "",
      "Commit stage marker for Write the commit",
    ].join("\n");
    const expectedInput = Buffer.from(`\x1b[200~${expectedPrompt}\x1b[201~\r`, "utf8");
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "Write the commit",
        "continue-e2e",
        "in progress",
        JSON.stringify({ status: "success", summary: "implemented" }),
        "[]",
        "task-continue-stage-copilot",
        "pty",
        "copilot",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, taskId);

    await tauriInvoke(client, "spawn_session", {
      sessionId: taskId,
      cwd: testRepoPath,
      executable: "/bin/sh",
      args: [
        "-lc",
        `stty raw -echo; dd bs=1 count=${expectedInput.length} of=.kanna/continue-stage-copilot-input.bin 2>/dev/null`,
      ],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "copilot",
    });

    const advanceResult = await callVueMethod(client, "store.advanceStage", taskId);
    if (isVueCallError(advanceResult)) throw new Error(advanceResult.__error);

    await waitForActivePostAction(client, taskId, "commit");
    await waitForFileSize(inputCapturePath, expectedInput.length);
    expect(await readFile(inputCapturePath)).toEqual(expectedInput);
  });

  it("clears a successful commit post-action and creates the PR task", async () => {
    const taskId = "post-action-complete-task";
    const branch = "task-post-action-complete";
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: join(testRepoPath, ".kanna-worktrees", branch),
      startPoint: "main",
    });
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, active_post_action, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "Complete commit post-action",
        "continue-e2e",
        "in progress",
        "commit",
        JSON.stringify({ status: "success", summary: "committed" }),
        "[]",
        branch,
        "pty",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, taskId);

    const existingPrTaskIds = await getStageTaskIds(client, repoId, "pr");
    await sendPipelineStageComplete(client, taskId);

    const prTaskId = await waitForCreatedStageTask(client, repoId, "pr", {
      excludeIds: existingPrTaskIds,
      displayName: "Complete commit post-action",
      baseRef: branch,
    });
    expect(prTaskId).not.toBe(taskId);
    const rows = (await queryDb(
      client,
      "SELECT active_post_action FROM pipeline_item WHERE id = ?",
      [taskId],
    )) as Array<{ active_post_action: string | null }>;
    expect(rows[0]?.active_post_action).toBeNull();
  });

  it("closes a final-stage task through the Cmd+S shortcut", async () => {
    const taskId = "final-stage-shortcut-task";
    const branch = "task-final-stage-shortcut";
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: join(testRepoPath, ".kanna-worktrees", branch),
      startPoint: "main",
    });
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        taskId,
        repoId,
        "Close PR from shortcut",
        "final-stage-e2e",
        "pr",
        null,
        "[]",
        branch,
        "pty",
        "codex",
        "idle",
        null,
      ],
    );
    await hydrateStoreItem(client, taskId);

    const selectResult = await callVueMethod(client, "store.selectItem", taskId);
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);
    await waitForSelectedTask(client, taskId);

    await client.executeSync(buildGlobalKeydownScript({ key: "s", meta: true }));

    await waitForClosedTask(client, taskId);
    await waitForSidebarToExcludeText(client, "Close PR from shortcut");
  });

  it("does not close a stale local fallback task when Cmd+S is pressed with a remote workspace task selected", async () => {
    // The mock E2E app has no seeded Firebase/relay peer to publish a true
    // remote desktop snapshot. A full cloud E2E would need harness support for
    // publishing a controllable remote task into the primary app before
    // selection. This regression keeps the narrower UI contract covered:
    // sidebar selects a remote workspace task, the real global shortcut fires,
    // and the stale local fallback row stays untouched.
    const fallbackTaskId = "stale-local-final-stage-shortcut-task";
    const fallbackBranch = "task-stale-local-final-stage-shortcut";
    const remoteTaskId = `cloud:${repoId}:remote-shortcut-task`;
    const createdAt = "2026-05-18T00:00:00.000Z";
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch: fallbackBranch,
      path: join(testRepoPath, ".kanna-worktrees", fallbackBranch),
      startPoint: "main",
    });
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, stage_result, tags, branch,
         agent_type, agent_provider, activity, display_name, pinned, pin_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fallbackTaskId,
        repoId,
        "Stale local fallback from shortcut",
        "final-stage-e2e",
        "pr",
        null,
        "[]",
        fallbackBranch,
        "pty",
        "codex",
        "idle",
        "Stale local fallback",
        1,
        0,
        createdAt,
        createdAt,
      ],
    );
    await hydrateStoreItem(client, fallbackTaskId);

    const selectFallbackResult = await callVueMethod(client, "store.selectItem", fallbackTaskId);
    if (isVueCallError(selectFallbackResult)) throw new Error(selectFallbackResult.__error);
    await waitForSelectedTask(client, fallbackTaskId);

    await injectCloudSnapshot(client, {
      repos: [{
        id: repoId,
        path: "cloud",
        name: "Shortcut Remote",
        default_branch: "main",
        hidden: 0,
        sort_order: 0,
        created_at: createdAt,
        last_opened_at: createdAt,
      }],
      items: [{
        id: remoteTaskId,
        repo_id: repoId,
        prompt: "Remote shortcut task",
        pipeline: "cloud",
        stage: "in progress",
        tags: "[]",
        pr_number: null,
        pr_url: null,
        branch: "remote-shortcut-task",
        activity: "idle",
        activity_changed_at: createdAt,
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Remote shortcut task",
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "codex",
        agent_type: "pty",
        previous_stage: null,
        stage_result: null,
        teardown_started_at: null,
        last_output_preview: null,
        active_post_action: null,
        created_at: "2026-05-18T00:01:00.000Z",
        updated_at: "2026-05-18T00:01:00.000Z",
      }],
      terminalRefs: {},
    });

    await clickSidebarItemByTitle(client, "Remote shortcut task");
    await waitForSelectedTask(client, remoteTaskId);

    const selectedState = await client.executeSync<{
      selectedItemId: string | null;
      currentItemId: string | null;
      selectedWorkspaceTaskId: string | null;
    }>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const read = (value) => value && value.__v_isRef ? value.value : value;
       return {
         selectedItemId: read(ctx.store.selectedItemId),
         currentItemId: read(ctx.store.currentItem)?.id ?? null,
         selectedWorkspaceTaskId: read(ctx.selectedWorkspaceTask)?.id ?? null,
       };`,
    );
    expect(selectedState).toEqual({
      selectedItemId: remoteTaskId,
      currentItemId: fallbackTaskId,
      selectedWorkspaceTaskId: remoteTaskId,
    });

    await client.executeSync(buildGlobalKeydownScript({ key: "s", meta: true }));
    await sleep(500);

    const rows = (await queryDb(
      client,
      "SELECT stage, closed_at FROM pipeline_item WHERE id = ?",
      [fallbackTaskId],
    )) as Array<{ stage: string | null; closed_at: string | null }>;
    expect(rows[0]).toEqual({ stage: "pr", closed_at: null });
  });

});
