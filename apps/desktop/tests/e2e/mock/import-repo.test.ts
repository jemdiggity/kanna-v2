import { setTimeout as sleep } from "node:timers/promises";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AGENT_PROVIDERS } from "@kanna/agent-protocol";
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

interface LocalSelectionState {
  selectedRepoId: string | null;
  selectedItemId: string | null;
  selectedCloudRepoId: string | null;
  selectedCloudItemId: string | null;
}

interface WorkspaceWindowState {
  windowId: string;
  selectedRepoId: string | null;
  selectedItemId: string | null;
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

const FIRST_REPO_NAME = "import-repo-primary";
const SECOND_REPO_NAME = "import-repo-secondary";
const CONFIGURED_REPO_NAME = "import-repo-configured";
const CLONED_CONFIGURED_REPO_NAME = "import-repo-configured-clone";
const INVALID_CREATE_REPO_NAME = "repo with spaces";
const SETUP_TASK_PROMPT = "Set up Kanna for this repository.";
const SUPPORTED_SETUP_AGENT_PROVIDERS = [...AGENT_PROVIDERS];
const UNCONFIGURED_FIXTURE_NAME = "task-switch-minimal";

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

async function setCloudSelectionOwnership(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `const ctx = window.__KANNA_E2E__.setupState;
     const setValue = (key, value) => {
       const current = ctx[key];
       if (current?.__v_isRef) current.value = value;
       else ctx[key] = value;
     };
     setValue("selectedCloudRepoId", "cloud:repo-stale");
     setValue("selectedCloudItemId", "cloud:repo-stale:task-stale");`,
  );
}

async function probeNextImportCompletion(client: WebDriverClient): Promise<void> {
  const installed = await client.executeSync<boolean>(
    `const ctx = window.__KANNA_E2E__.setupState;
     const creation = ctx.appTaskCreation;
     const original = creation?.handleImportRepo;
     if (typeof original !== "function") return false;
     window.__KANNA_E2E_IMPORT_COMPLETION__ = null;
     creation.handleImportRepo = (...args) => {
       const completion = Promise.resolve(original(...args));
       window.__KANNA_E2E_IMPORT_COMPLETION__ = completion;
       completion.finally(() => {
         creation.handleImportRepo = original;
       });
       return completion;
     };
     return true;`,
  );
  expect(installed).toBe(true);
}

async function waitForProbedImportCompletion(client: WebDriverClient): Promise<void> {
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const completion = window.__KANNA_E2E_IMPORT_COMPLETION__;
     if (!completion) {
       cb("err:import completion probe was not invoked");
       return;
     }
     Promise.resolve(completion)
       .then(() => cb("ok"))
       .catch((error) => cb("err:" + (error?.message || String(error))));`,
  );
  expect(result).toBe("ok");
}

async function localSelectionState(client: WebDriverClient): Promise<LocalSelectionState> {
  return client.executeSync<LocalSelectionState>(
    `const ctx = window.__KANNA_E2E__.setupState;
     const unwrap = (value) => value?.__v_isRef ? value.value : value;
     return {
       selectedRepoId: unwrap(ctx.store?.selectedRepoId ?? ctx.selectedRepoId) ?? null,
       selectedItemId: unwrap(ctx.store?.selectedItemId ?? ctx.selectedItemId) ?? null,
       selectedCloudRepoId: unwrap(ctx.selectedCloudRepoId) ?? null,
       selectedCloudItemId: unwrap(ctx.selectedCloudItemId) ?? null,
     };`,
  );
}

async function waitForPersistedLocalSelection(
  client: WebDriverClient,
  repoId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latestRaw: string | null = null;

  while (Date.now() < deadline) {
    const rows = await queryDb(
      client,
      "SELECT value FROM settings WHERE key = ?",
      ["window_workspace_v1"],
    ) as Array<{ value?: string | null }>;
    latestRaw = rows[0]?.value ?? null;
    if (latestRaw) {
      const snapshot = JSON.parse(latestRaw) as { windows?: WorkspaceWindowState[] };
      const currentWindow = snapshot.windows?.find((windowState) => windowState.windowId === "main");
      if (currentWindow?.selectedRepoId === repoId) {
        return;
      }
    }
    await sleep(100);
  }

  throw new Error(
    `Timed out waiting for persisted local selection ${repoId}; latest workspace was ${latestRaw}`,
  );
}

async function setupTaskCountForRepo(
  client: WebDriverClient,
  repoId: string,
): Promise<number> {
  const rows = await queryDb(
    client,
    "SELECT COUNT(*) AS count FROM pipeline_item WHERE repo_id = ? AND prompt = ?",
    [repoId, SETUP_TASK_PROMPT],
  ) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
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

async function taskCreationSettled(
  client: WebDriverClient,
  taskIds: string[],
): Promise<boolean> {
  return client.executeSync<boolean>(
    `const expectedIds = new Set(${JSON.stringify(taskIds)});
     const ctx = window.__KANNA_E2E__.setupState;
     const unwrap = (value) => value?.__v_isRef ? value.value : value;
     const items = Array.from(unwrap(ctx.store?.items ?? ctx.items) ?? []);
     const slots = Array.from(unwrap(ctx.store?.taskUiSlots) ?? []);
     return [...expectedIds].every((taskId) =>
       items.some((item) => item.id === taskId)
       && slots.some((slot) =>
         slot.task_id === taskId
         && slot.state === "ready"
       )
     );`,
  );
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
    const allTasksReady = rows.every((row) =>
      row.stage_agent === "setup"
      && row.stage_session_id === row.id
      && row.daemon_session_id === row.id
      && Boolean(row.worktree_path)
      && row.terminal_cwd === row.worktree_path
      && row.stage_cwd === row.worktree_path
    );
    if (
      rows.length === expectedCount
      && allTasksReady
      && await taskCreationSettled(client, rows.map((row) => row.id))
    ) {
      return rows;
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${expectedCount} setup tasks; latest rows were ${JSON.stringify(rows)}`);
}

async function setupTaskDetails(client: WebDriverClient, taskId: string): Promise<SetupTaskDetailRow> {
  const deadline = Date.now() + 10_000;
  let row: SetupTaskDetailRow | undefined;
  while (Date.now() < deadline) {
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
    row = rows[0];
    if (
      row?.stage_agent === "setup"
      && row.stage_session_id === taskId
      && row.daemon_session_id === taskId
      && row.worktree_path
      && row.terminal_cwd === row.worktree_path
      && row.stage_cwd === row.worktree_path
      && await taskCreationSettled(client, [taskId])
    ) {
      return row;
    }
    await sleep(100);
  }

  throw new Error(`setup task did not become ready: ${taskId}; latest row was ${JSON.stringify(row)}`);
}

describe("import repo", () => {
  const client = new WebDriverClient();
  let firstRepoRoot = "";
  let secondRepoRoot = "";
  let configuredRepoRoot = "";
  let clonedConfiguredRepoPath = "";
  let firstRepoPath = "";
  let secondRepoPath = "";
  let firstRepoId = "";
  let secondRepoId = "";
  let importedSetupTaskId = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    firstRepoRoot = await createFixtureRepo(FIRST_REPO_NAME, {
      fixtureName: UNCONFIGURED_FIXTURE_NAME,
    });
    secondRepoRoot = await createFixtureRepo(SECOND_REPO_NAME, {
      fixtureName: UNCONFIGURED_FIXTURE_NAME,
    });
    configuredRepoRoot = await createFixtureRepo(CONFIGURED_REPO_NAME);
    clonedConfiguredRepoPath = join(
      dirname(configuredRepoRoot),
      CLONED_CONFIGURED_REPO_NAME,
    );
    firstRepoPath = firstRepoRoot;
    secondRepoPath = secondRepoRoot;
  });

  afterAll(async () => {
    await cleanupFixtureRepos(
      [firstRepoRoot, secondRepoRoot, configuredRepoRoot].filter(Boolean),
    );
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
    // Server-backed task creation spawns the daemon from Rust, so the browser
    // E2E invoke log cannot observe the final shell command. The matching Rust
    // task_creator/http_api tests assert that agent="setup" expands to the
    // setup AGENT.md prompt and not the default implement prompt.
  });

  it("records one open setup task for the imported repo", async () => {
    const rows = await queryDb(
      client,
      "SELECT COUNT(*) AS count FROM pipeline_item WHERE repo_id = ? AND closed_at IS NULL",
      [firstRepoId],
    ) as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(1);
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
  });

  it("does not launch another setup task when re-importing an already tracked configured repo", async () => {
    const beforeRows = await waitForSetupTaskCount(client, 2);
    const beforeIds = beforeRows.map((row) => row.id).sort();
    await mkdir(join(firstRepoPath, ".kanna"), { recursive: true });
    await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
    const importResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__?.setupState;
       Promise.resolve(ctx?.appTaskCreation?.handleImportRepo?.(
         ${JSON.stringify(firstRepoPath)},
         ${JSON.stringify(FIRST_REPO_NAME)},
         "main"
       ))
         .then(() => cb("ok"))
         .catch((e) => cb("err:" + (e?.message || String(e))));`,
    );
    expect(importResult).toBe("ok");

    const rows = await waitForSetupTaskCount(client, 2, 1_000);
    expect(rows.map((row) => row.id).sort()).toEqual(beforeIds);
  });

  it("can import a second repo", async () => {
    secondRepoId = await importTestRepo(client, secondRepoPath, SECOND_REPO_NAME);
    await client.waitForText(".sidebar", SECOND_REPO_NAME, 10000);
    await waitForSetupTaskCount(client, 3);
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

  it("imports a configured repo without creating a setup task and persists local selection ownership", async () => {
    await access(join(configuredRepoRoot, ".kanna"));
    await setCloudSelectionOwnership(client);
    await probeNextImportCompletion(client);

    const configuredRepoId = await importTestRepo(
      client,
      configuredRepoRoot,
      CONFIGURED_REPO_NAME,
    );
    await waitForProbedImportCompletion(client);

    await client.waitForText(".repo-header.selected", CONFIGURED_REPO_NAME);
    const selection = await localSelectionState(client);
    expect(selection.selectedRepoId).toBe(configuredRepoId);
    expect(selection.selectedCloudRepoId).toBeNull();
    expect(selection.selectedCloudItemId).toBeNull();
    await waitForPersistedLocalSelection(client, configuredRepoId);
    expect(await setupTaskCountForRepo(client, configuredRepoId)).toBe(0);
  });

  it("clones a configured local fixture without creating a setup task and persists local selection ownership", async () => {
    await setCloudSelectionOwnership(client);

    // AddRepoModal only accepts GitHub-style clone input. Calling its emitted
    // app-task-creation handler here still exercises the real Tauri git clone,
    // server-backed repo import, selection persistence, and setup guard.
    const cloneResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__?.setupState;
       Promise.resolve(ctx?.appTaskCreation?.handleCloneRepo?.(
         ${JSON.stringify(configuredRepoRoot)},
         ${JSON.stringify(clonedConfiguredRepoPath)}
       ))
         .then(() => cb("ok"))
         .catch((e) => cb("err:" + (e?.message || String(e))));`,
    );
    expect(cloneResult).toBe("ok");

    await access(join(clonedConfiguredRepoPath, ".kanna"));
    await client.waitForText(".repo-header.selected", CLONED_CONFIGURED_REPO_NAME);
    const clonedRows = await queryDb(
      client,
      "SELECT id FROM repo WHERE name = ? AND hidden = 0",
      [CLONED_CONFIGURED_REPO_NAME],
    ) as Array<{ id: string }>;
    const clonedRepoId = clonedRows[0]?.id;
    expect(clonedRepoId).toBeTruthy();
    if (!clonedRepoId) throw new Error("cloned configured repo was not imported");

    const selection = await localSelectionState(client);
    expect(selection.selectedRepoId).toBe(clonedRepoId);
    expect(selection.selectedCloudRepoId).toBeNull();
    expect(selection.selectedCloudItemId).toBeNull();
    await waitForPersistedLocalSelection(client, clonedRepoId);
    expect(await setupTaskCountForRepo(client, clonedRepoId)).toBe(0);
  });
});
