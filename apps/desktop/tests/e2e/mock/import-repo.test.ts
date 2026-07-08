import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { queryDb } from "../helpers/vue";
import { waitForTaskCreated } from "../helpers/taskCreation";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { pauseForSlowMode } from "../helpers/slowMode";

interface RepoOrderRow {
  id: string;
  name: string;
  sort_order: number;
}

interface SetupTaskDetailRow {
  id: string;
  prompt: string;
  agent_provider: string | null;
  agent_type: string | null;
  display_name: string | null;
  worktree_path: string | null;
  terminal_cwd: string | null;
  daemon_session_id: string | null;
  stage_agent: string | null;
  stage_session_id: string | null;
  stage_cwd: string | null;
}

interface SpawnSessionArgs {
  sessionId?: string;
  args?: string[];
  env?: Record<string, string>;
  agentProvider?: string;
}

const FIRST_REPO_NAME = "import-repo-primary";
const SECOND_REPO_NAME = "import-repo-secondary";
const INVALID_CREATE_REPO_NAME = "repo with spaces";
const SETUP_TASK_PROMPT = "Set up Kanna for this repository.";
const SUPPORTED_SETUP_AGENT_PROVIDERS = ["claude", "copilot", "codex", "opencode", "antigravity"];

async function findRepoHeader(client: WebDriverClient, repoName: string): Promise<string> {
  const headers = await client.findElements(".repo-header");
  for (const header of headers) {
    const text = await client.getText(header);
    if (text.includes(repoName)) return header;
  }
  throw new Error(`repo header not found: ${repoName}`);
}

async function visibleRepoNames(client: WebDriverClient): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return Array.from(document.querySelectorAll(".repo-header .repo-name"))
      .map((el) => el.textContent?.trim() || "");`
  );
}

async function waitForRepoOrder(client: WebDriverClient, expectedNames: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const names = await visibleRepoNames(client);
    if (expectedNames.every((name, index) => names[index] === name)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for repo order: ${expectedNames.join(", ")}`);
}

async function openCreateRepoModal(client: WebDriverClient): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__?.setupState;
     Promise.resolve(ctx?.keyboardActions?.createRepo?.())
       .then(() => cb("ok"))
       .catch((e) => cb("err:" + (e?.message || String(e))));`
  );
  expect(result).toBe("ok");
  await client.waitForText(".modal-overlay .tab.active", "Create New");
}

async function repoRows(client: WebDriverClient): Promise<RepoOrderRow[]> {
  return await queryDb(
    client,
    "SELECT id, name, sort_order FROM repo WHERE hidden = 0 ORDER BY sort_order ASC, created_at ASC",
  ) as RepoOrderRow[];
}

async function waitForE2EInvoke<T>(
  client: WebDriverClient,
  predicateSource: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let calls: unknown[] = [];

  while (Date.now() < deadline) {
    const result = await client.executeSync<{ match: T | null; calls: unknown[] }>(
      `const calls = window.__KANNA_E2E__.invokes.getAll();
       const match = calls.find(${predicateSource});
       return { match: match ? JSON.parse(JSON.stringify(match.args)) : null, calls };`
    );
    calls = result.calls;
    if (result.match) return result.match;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for E2E invoke; calls were ${JSON.stringify(calls)}`);
}

async function clickCommandPaletteCommand(client: WebDriverClient, label: string): Promise<void> {
  const openResult = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__?.setupState;
     Promise.resolve(ctx?.keyboardActions?.commandPalette?.())
       .then(() => cb("ok"))
       .catch((e) => cb("err:" + (e?.message || String(e))));`
  );
  expect(openResult).toBe("ok");
  const input = await client.waitForElement(".modal-overlay .palette-input");
  await client.sendKeys(input, label);
  await client.waitForText(".modal-overlay .command-item", label);

  const clicked = await client.executeSync<boolean>(
    `const label = ${JSON.stringify(label)};
     const command = Array.from(document.querySelectorAll(".modal-overlay .command-item"))
       .find((el) => el.textContent?.includes(label));
     if (!command) return false;
     command.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
     return true;`
  );
  expect(clicked).toBe(true);
  await client.waitForNoElement(".modal-overlay", 5_000);
}

async function waitForSetupTaskCount(client: WebDriverClient, expectedCount: number, timeoutMs = 10_000): Promise<SetupTaskDetailRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: SetupTaskDetailRow[] = [];

  while (Date.now() < deadline) {
    rows = (await queryDb(
      client,
      `SELECT
         p.id,
         p.prompt,
         p.agent_provider,
         p.agent_type,
         p.display_name,
         w.path AS worktree_path,
         ts.cwd AS terminal_cwd,
         ts.daemon_session_id,
         sr.agent AS stage_agent,
         sr.session_id AS stage_session_id,
         sr.cwd AS stage_cwd
       FROM pipeline_item p
       LEFT JOIN worktree w ON w.pipeline_item_id = p.id
       LEFT JOIN terminal_session ts ON ts.pipeline_item_id = p.id AND ts.label = 'agent'
       LEFT JOIN stage_run sr ON sr.task_id = p.id AND sr.kind = 'main'
       WHERE p.prompt = ?
       ORDER BY p.created_at DESC`,
      [SETUP_TASK_PROMPT],
    )) as SetupTaskDetailRow[];
    if (rows.length === expectedCount) return rows;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${expectedCount} setup tasks; latest rows were ${JSON.stringify(rows)}`);
}

async function setupTaskDetails(client: WebDriverClient, taskId: string): Promise<SetupTaskDetailRow> {
  const rows = (await queryDb(
    client,
    `SELECT
       p.id,
       p.prompt,
       p.agent_provider,
       p.agent_type,
       p.display_name,
       w.path AS worktree_path,
       ts.cwd AS terminal_cwd,
       ts.daemon_session_id,
       sr.agent AS stage_agent,
       sr.session_id AS stage_session_id,
       sr.cwd AS stage_cwd
     FROM pipeline_item p
     LEFT JOIN worktree w ON w.pipeline_item_id = p.id
     LEFT JOIN terminal_session ts ON ts.pipeline_item_id = p.id AND ts.label = 'agent'
     LEFT JOIN stage_run sr ON sr.task_id = p.id AND sr.kind = 'main'
     WHERE p.id = ?`,
    [taskId],
  )) as SetupTaskDetailRow[];

  const row = rows[0];
  if (!row) throw new Error(`setup task not found: ${taskId}`);
  return row;
}

describe("import repo", () => {
  const client = new WebDriverClient();
  let firstRepoRoot = "";
  let secondRepoRoot = "";
  let firstRepoPath = "";
  let secondRepoPath = "";
  let firstRepoId = "";
  let secondRepoId = "";
  let importedSetupTaskId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    firstRepoRoot = await createFixtureRepo(FIRST_REPO_NAME);
    secondRepoRoot = await createFixtureRepo(SECOND_REPO_NAME);
    firstRepoPath = firstRepoRoot;
    secondRepoPath = secondRepoRoot;
  });

  afterAll(async () => {
    await cleanupFixtureRepos([firstRepoRoot, secondRepoRoot].filter(Boolean));
    await client.deleteSession();
  });

  it("does not create a repo when the Create New repo name contains spaces", async () => {
    await openCreateRepoModal(client);

    const input = await client.waitForElement(".modal-overlay input.text-input");
    await client.sendKeys(input, INVALID_CREATE_REPO_NAME);

    await client.waitForText(
      ".modal-overlay .error-inline",
      "Repo names cannot contain spaces. Use hyphens instead.",
    );

    const createButtonState = await client.executeSync<{ disabled: boolean; text: string }>(
      `const button = document.querySelector(".modal-overlay .btn-primary");
       return { disabled: Boolean(button?.disabled), text: button?.textContent?.trim() || "" };`
    );
    expect(createButtonState).toEqual({ disabled: true, text: "Create" });

    await client.executeSync(
      `document.querySelector(".modal-overlay .btn-primary")?.dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true })
       );
       document.querySelector(".modal-overlay input.text-input")?.dispatchEvent(
         new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, metaKey: true })
       );
       window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));`
    );

    await client.waitForElement(".modal-overlay");
    expect(await repoRows(client)).toEqual([]);
    expect(await visibleRepoNames(client)).not.toContain(INVALID_CREATE_REPO_NAME);
  });

  it("imports a repo and shows it in the sidebar", async () => {
    firstRepoId = await importTestRepo(client, firstRepoPath, FIRST_REPO_NAME);

    // Repo should appear in sidebar
    const el = await client.waitForText(".repo-header", FIRST_REPO_NAME);
    expect(el).toBeTruthy();
    await pauseForSlowMode("first repo visible");
  });

  it("creates a normal setup task for the imported repo", async () => {
    const task = await waitForTaskCreated(client, SETUP_TASK_PROMPT);
    importedSetupTaskId = task.id;
    expect(task.agent_type).toBe("pty");
    expect(SUPPORTED_SETUP_AGENT_PROVIDERS).toContain(task.agent_provider);

    const details = await setupTaskDetails(client, task.id);
    expect(details.prompt).toBe(SETUP_TASK_PROMPT);
    expect(details.display_name).toBe("Set Up Repository");
    expect(details.stage_agent).toBe("setup");
    expect(details.stage_session_id).toBe(task.id);
    expect(details.daemon_session_id).toBe(task.id);
    expect(details.worktree_path).toBeTruthy();
    expect(details.terminal_cwd).toBe(details.worktree_path);
    expect(details.stage_cwd).toBe(details.worktree_path);

    const spawnCall = await waitForE2EInvoke<SpawnSessionArgs>(
      client,
      `(call) => call.cmd === "spawn_session" && call.args?.sessionId === ${JSON.stringify(task.id)}`,
    );
    const command = spawnCall.args?.join(" ") ?? "";
    expect(spawnCall.agentProvider).toBe(task.agent_provider);
    expect(spawnCall.env?.KANNA_TASK_ID).toBe(task.id);
    expect(command).toContain("You are the Kanna setup agent.");
    expect(command).toContain(SETUP_TASK_PROMPT);
    expect(command).not.toContain("Default task agent that implements work and returns control to Kanna");
  });

  it("shows task count badge as 1", async () => {
    // The repo header shows the count
    const text = await client.executeSync<string>(
      `const headers = document.querySelectorAll(".repo-header");
       for (const h of headers) {
         if (h.textContent.includes(${JSON.stringify(FIRST_REPO_NAME)})) return h.textContent;
       }
       return "";`
    );
    expect(text).toContain("1");
  });

  it("shows the setup task under the imported repo", async () => {
    const el = await client.waitForText(".sidebar", "Set Up Repository");
    expect(el).toBeTruthy();
  });

  it("launches a setup task from the command palette", async () => {
    await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
    await clickCommandPaletteCommand(client, "Set Up Repository");

    const rows = await waitForSetupTaskCount(client, 2);
    const latest = rows.find((row) => row.id !== importedSetupTaskId);
    expect(latest).toBeTruthy();
    if (!latest) throw new Error("command palette setup task was not created");
    expect(latest.prompt).toBe(SETUP_TASK_PROMPT);
    expect(latest.agent_type).toBe("pty");
    expect(SUPPORTED_SETUP_AGENT_PROVIDERS).toContain(latest.agent_provider);
    expect(latest.display_name).toBe("Set Up Repository");
    expect(latest.stage_agent).toBe("setup");
    expect(latest.stage_session_id).toBe(latest.id);
    expect(latest.daemon_session_id).toBe(latest.id);
    expect(latest.terminal_cwd).toBe(latest.worktree_path);
    expect(latest.stage_cwd).toBe(latest.worktree_path);

    const spawnCall = await waitForE2EInvoke<SpawnSessionArgs>(
      client,
      `(call) => call.cmd === "spawn_session" && call.args?.sessionId === ${JSON.stringify(latest.id)}`,
    );
    const command = spawnCall.args?.join(" ") ?? "";
    expect(spawnCall.agentProvider).toBe(latest.agent_provider);
    expect(spawnCall.env?.KANNA_TASK_ID).toBe(latest.id);
    expect(command).toContain("You are the Kanna setup agent.");
    expect(command).not.toContain("Default task agent that implements work and returns control to Kanna");
  });

  it("can import a second repo", async () => {
    secondRepoId = await importTestRepo(client, secondRepoPath, SECOND_REPO_NAME);
    await client.waitForText(".sidebar", SECOND_REPO_NAME, 10000);
    await pauseForSlowMode("second repo visible");
    const text = await client.executeSync<string>(
      `return document.querySelector(".sidebar").textContent;`
    );
    expect(text).toContain(FIRST_REPO_NAME);
    expect(text).toContain(SECOND_REPO_NAME);
  });

  it("can select between repos", async () => {
    const firstHeader = await findRepoHeader(client, FIRST_REPO_NAME);
    const secondHeader = await findRepoHeader(client, SECOND_REPO_NAME);

    await client.click(firstHeader);
    await client.waitForText(".repo-header.selected", FIRST_REPO_NAME);
    await pauseForSlowMode("first repo selected");

    await client.click(secondHeader);
    await client.waitForText(".repo-header.selected", SECOND_REPO_NAME);
    await pauseForSlowMode("second repo selected");
  });

  it("persists repos reordered by dragging their sidebar headers", async () => {
    const sourceHeader = await findRepoHeader(client, SECOND_REPO_NAME);
    const targetHeader = await findRepoHeader(client, FIRST_REPO_NAME);

    await client.click(targetHeader);
    await client.waitForText(".repo-header.selected", FIRST_REPO_NAME);
    await client.dragElementToElement(sourceHeader, targetHeader);
    await waitForRepoOrder(client, [SECOND_REPO_NAME, FIRST_REPO_NAME]);
    await pauseForSlowMode("repos reordered");

    const names = await visibleRepoNames(client);
    expect(names.slice(0, 2)).toEqual([SECOND_REPO_NAME, FIRST_REPO_NAME]);

    const rows = await repoRows(client);
    expect(rows.map((row) => row.id)).toEqual([secondRepoId, firstRepoId]);
    expect(rows.map((row) => row.sort_order)).toEqual([0, 1]);
  });
});
