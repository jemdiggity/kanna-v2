import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localProcessFetch } from "@kanna/local-process-fetch";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { resolveAppKannaServer } from "../helpers/kannaServer";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { callVueMethod, getVueState, tauriInvoke } from "../helpers/vue";

/**
 * The main content area hosts a task's views as tabs: the agent session plus
 * whichever of the diff, a file, and the task shell the operator (or an agent
 * through `kanna_open_file`) has opened. These are the boundary-crossing parts
 * that unit tests cannot prove — the real keyboard path, the real xterm buffer
 * surviving a tab switch, and a server route reaching a live window.
 */
async function openTabIds(client: WebDriverClient): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return Array.from(document.querySelectorAll('[data-testid="main-tab-bar"] [role="tab"]'))
      .map((tab) => (tab.getAttribute("data-testid") || "").replace(/^main-tab-/, ""));`
  );
}

async function activeTabId(client: WebDriverClient): Promise<string | null> {
  return await client.executeSync<string | null>(
    `const active = document.querySelector('[data-testid="main-tab-bar"] [role="tab"][aria-selected="true"]');
     return active ? (active.getAttribute("data-testid") || "").replace(/^main-tab-/, "") : null;`
  );
}

async function waitForActiveTab(
  client: WebDriverClient,
  id: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: string | null = null;
  while (Date.now() < deadline) {
    latest = await activeTabId(client);
    if (latest === id) return;
    await sleep(150);
  }
  throw new Error(`expected active tab ${id}, got ${latest} of ${JSON.stringify(await openTabIds(client))}`);
}

/**
 * The app has renamed its selection entry point before, and an e2e helper that
 * silently missed it selects nothing while every later assertion still looks
 * plausible. Resolve it by trying each spelling.
 */
const SELECT_SIDEBAR_ITEM_SCRIPT = `
  function selectSidebarItem(ctx, id) {
    const select = ctx.selectSidebarItemById || ctx.handleSelectItem
      || (ctx.store && ctx.store.selectItem && ctx.store.selectItem.bind(ctx.store));
    if (!select) throw new Error("no sidebar selection entry point on setupState");
    return select(id);
  }
`;

async function pressShortcut(
  client: WebDriverClient,
  options: { key: string; meta?: boolean; shift?: boolean; alt?: boolean },
): Promise<void> {
  await client.executeSync(buildGlobalKeydownScript(options));
}

/**
 * ⌘W itself belongs to the native File menu in the packaged app, which
 * dispatches to this action — so a test presses it the way the menu does
 * rather than synthesising a keydown the web handler deliberately ignores.
 */
async function pressCloseTab(client: WebDriverClient): Promise<void> {
  const result = await callVueMethod(client, "keyboardActions.closeTabOrWindow");
  if (result && typeof result === "object" && "__error" in result) {
    throw new Error(String((result as { __error: string }).__error));
  }
  await sleep(200);
}

/** Tabs persist per task, so each test starts from the agent session alone. */
async function closeViewTabs(client: WebDriverClient): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const closed = await client.executeSync<boolean>(
      `const close = document.querySelector('[data-testid^="main-tab-close-"]');
       if (!close) return false;
       close.click();
       return true;`
    );
    if (!closed) return;
    await sleep(120);
  }
  throw new Error(`tabs would not close: ${JSON.stringify(await openTabIds(client))}`);
}

describe("main content area tabs", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";
  let taskId = "";
  let secondTaskId = "";

  async function createTask(prompt: string): Promise<string> {
    const repoId = await getVueState(client, "selectedRepoId") as string;
    const id = crypto.randomUUID();
    const branch = `task-${id}`;
    const worktreePath = `${testRepoPath}/.kanna-worktrees/${branch}`;

    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: worktreePath,
    });
    await tauriInvoke(client, "run_script", {
      script: "printf '\\n# main tabs e2e\\n' >> README.md",
      cwd: worktreePath,
      env: {},
    });

    const created = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       ${SELECT_SIDEBAR_ITEM_SCRIPT}
       const db = ctx.db.value || ctx.db;
       db.execute("INSERT INTO pipeline_item (id, repo_id, prompt, stage, branch, agent_type) VALUES (?, ?, ?, ?, ?, ?)",
         ["${id}", "${repoId}", "${prompt}", "in progress", "${branch}", "agent"])
         // kanna_open_file resolves the file through the task's recorded
         // workspace, so the row has to exist as well as the directory.
         .then(function() {
           return db.execute("INSERT INTO worktree (id, pipeline_item_id, path, branch) VALUES (?, ?, ?, ?)",
             ["wt-${id}", "${id}", "${worktreePath}", "${branch}"]);
         })
         .then(function() { return ctx.loadItems("${repoId}"); })
         .then(function() { selectSidebarItem(ctx, "${id}"); return ctx.refreshAllItems ? ctx.refreshAllItems() : null; })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + (e && e.message ? e.message : String(e))); });`
    );
    if (typeof created === "string" && created.startsWith("err:")) {
      throw new Error(`creating task ${prompt} failed: ${created.slice(4)}`);
    }
    await client.waitForText(".sidebar", prompt);
    return id;
  }

  async function selectTask(id: string): Promise<void> {
    const result = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       try {
         const ctx = window.__KANNA_E2E__.setupState;
         ${SELECT_SIDEBAR_ITEM_SCRIPT}
         selectSidebarItem(ctx, "${id}");
         setTimeout(function() { cb("ok"); }, 100);
       } catch (e) {
         cb("err:" + (e && e.message ? e.message : String(e)));
       }`
    );
    if (typeof result === "string" && result.startsWith("err:")) {
      throw new Error(`selecting task ${id} failed: ${result.slice(4)}`);
    }
  }

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);

    fixtureRepoRoot = await createSeedFixtureRepo("task-switch-minimal");
    testRepoPath = fixtureRepoRoot;
    await importTestRepo(client, testRepoPath, "main-tabs-test");

    taskId = await createTask("Main tabs task");
    secondTaskId = await createTask("Main tabs other task");
    await selectTask(taskId);
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("opens the diff and the task shell as tabs beside the agent session", async () => {
    await client.waitForElement('[data-testid="main-tab-bar"]', 5_000);
    expect(await openTabIds(client)).toEqual(["agent"]);

    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");
    await client.waitForElement(".diff-view", 8_000);
    // The agent session is still mounted behind it, not torn down.
    expect(await openTabIds(client)).toEqual(["agent", "diff"]);

    await pressShortcut(client, { key: "j", meta: true });
    await waitForActiveTab(client, "shell");
    expect(await openTabIds(client)).toEqual(["agent", "diff", "shell"]);

    // The shortcut that opened a view raises it again rather than toggling it
    // shut — closing is ⌘W's job.
    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");
    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");
    expect(await openTabIds(client)).toEqual(["agent", "diff", "shell"]);

    // ⌘W closes the tab in front and hands over to the one that takes its
    // place.
    await pressCloseTab(client);
    await waitForActiveTab(client, "shell");
    expect(await openTabIds(client)).toEqual(["agent", "shell"]);

    // Escape belongs to whatever runs in the shell, so it does not close it.
    await pressShortcut(client, { key: "Escape" });
    await sleep(400);
    expect(await openTabIds(client)).toEqual(["agent", "shell"]);

    await pressCloseTab(client);
    await waitForActiveTab(client, "agent");
    expect(await openTabIds(client)).toEqual(["agent"]);
  });

  it("closes a diff tab with Escape once no modal wants the key", async () => {
    await selectTask(taskId);
    await closeViewTabs(client);

    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");

    await pressShortcut(client, { key: "Escape" });
    await waitForActiveTab(client, "agent");
    expect(await openTabIds(client)).toEqual(["agent"]);
  });

  it("keeps each tab's view alive while another tab is in front", async () => {
    await selectTask(taskId);
    await closeViewTabs(client);
    await waitForActiveTab(client, "agent");

    await pressShortcut(client, { key: "j", meta: true });
    await waitForActiveTab(client, "shell");
    const shellTerminals = await client.executeSync<number>(
      `return document.querySelectorAll(".shell-modal .xterm").length;`
    );
    expect(shellTerminals).toBeGreaterThan(0);

    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");

    // Hidden, but still in the DOM: the xterm buffer is not rebuilt when the
    // shell comes back, which is why tabs use v-show rather than v-if.
    const hiddenShell = await client.executeSync<boolean>(
      `const shell = document.querySelector(".shell-modal");
       if (!shell) return false;
       const overlay = shell.closest(".embedded-view");
       return Boolean(overlay) && getComputedStyle(overlay).display === "none";`
    );
    expect(hiddenShell).toBe(true);

    await pressShortcut(client, { key: "j", meta: true });
    await waitForActiveTab(client, "shell");
  });

  it("gives every task its own tabs", async () => {
    await selectTask(taskId);
    await closeViewTabs(client);
    await waitForActiveTab(client, "agent");
    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");

    await selectTask(secondTaskId);
    await closeViewTabs(client);
    await waitForActiveTab(client, "agent");
    expect(await openTabIds(client)).toEqual(["agent"]);

    // Coming back restores what that task had open — the point of tabs over
    // the ephemeral modals they replaced.
    await selectTask(taskId);
    await waitForActiveTab(client, "diff");
    expect(await openTabIds(client)).toEqual(["agent", "diff"]);
  });

  it("closes the tab in front from the native File menu, and spares the window", async () => {
    await selectTask(taskId);
    await closeViewTabs(client);
    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");

    // ⌘W is the menu's accelerator in the packaged app, so this is the path
    // the key actually takes: the item emits, and the action closes the tab.
    // A synthesized keydown proves nothing here — the web handler skips it.
    const emitNativeClose = async () => {
      const result = await client.executeAsync<string>(
        `const cb = arguments[arguments.length - 1];
         import("/src/emit.ts")
           .then((module) => module.emit("kanna://native-close-window", {}))
           .then(() => cb("ok"))
           .catch((error) => cb("err:" + String(error && error.message ? error.message : error)));`
      );
      if (typeof result === "string" && result.startsWith("err:")) {
        throw new Error(`native close-window emit failed: ${result.slice(4)}`);
      }
      await sleep(500);
    };

    await emitNativeClose();
    await waitForActiveTab(client, "agent");
    expect(await openTabIds(client)).toEqual(["agent"]);
    expect(await client.getWindowHandles()).toHaveLength(1);

    // With a view open behind the agent session, ⌘W declines rather than
    // closing the window out from under it.
    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");
    await client.executeSync(
      `document.querySelector('[data-testid="main-tab-agent"]')?.click(); return true;`,
    );
    await waitForActiveTab(client, "agent");

    await emitNativeClose();
    expect(await openTabIds(client)).toEqual(["agent", "diff"]);
    expect(await client.getWindowHandles()).toHaveLength(1);

    await closeViewTabs(client);
  });

  it("gives a repository with no task selected a tab set of its own", async () => {
    await selectTask(taskId);
    await closeViewTabs(client);

    // Deselect the task: the main area belongs to the repository now.
    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const store = ctx.store;
       if (store?.selectedItemId?.__v_isRef) store.selectedItemId.value = null;
       else store.selectedItemId = null;
       setTimeout(function() { cb("ok"); }, 200);`
    );
    await sleep(400);

    // A repository has no agent session, so its tab set starts empty.
    expect(await openTabIds(client)).toEqual([]);

    await pressShortcut(client, { key: "g", meta: true });
    await waitForActiveTab(client, "graph");
    await pressShortcut(client, { key: "A", meta: true, shift: true });
    await waitForActiveTab(client, "analytics");
    expect(await openTabIds(client)).toEqual(["graph", "analytics"]);

    // ⌘J has no worktree to run in here, so it opens the repo-root shell.
    await pressShortcut(client, { key: "j", meta: true });
    await waitForActiveTab(client, "shell:repo");

    await closeViewTabs(client);
    expect(await openTabIds(client)).toEqual([]);

    // Back on the task, its own tabs are untouched by any of that.
    await selectTask(taskId);
    await sleep(400);
    expect(await openTabIds(client)).toEqual(["agent"]);
  });

  it("opens the remaining views as tabs of the selected task", async () => {
    await selectTask(taskId);
    await closeViewTabs(client);
    await waitForActiveTab(client, "agent");

    await pressShortcut(client, { key: "E", meta: true, shift: true });
    await waitForActiveTab(client, "tree");
    await pressShortcut(client, { key: ",", meta: true });
    await waitForActiveTab(client, "preferences");
    await pressShortcut(client, { key: "J", meta: true, shift: true });
    await waitForActiveTab(client, "shell:repo");

    // The worktree shell and the repo-root shell are separate tabs.
    await pressShortcut(client, { key: "j", meta: true });
    await waitForActiveTab(client, "shell");
    expect(await openTabIds(client)).toEqual([
      "agent",
      "tree",
      "preferences",
      "shell:repo",
      "shell",
    ]);

    await closeViewTabs(client);
    await waitForActiveTab(client, "agent");
  });

  it("opens a file an agent asked for through kanna_open_file", async () => {
    await selectTask(taskId);
    await closeViewTabs(client);
    await waitForActiveTab(client, "agent");

    const server = await resolveAppKannaServer(client);
    const response = await localProcessFetch(`${server.baseUrl}/v1/desktop/views/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, path: "README.md" }),
    });
    expect(response.ok).toBe(true);
    // Requested, never shown: the response says only that a window was asked.
    expect(await response.json()).toMatchObject({ requested: true, path: "README.md" });

    await waitForActiveTab(client, "file:README.md");
    await client.waitForText(".preview-modal .file-path", "README.md", 8_000);

    const refused = await localProcessFetch(`${server.baseUrl}/v1/desktop/views/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, path: "../outside.txt" }),
    });
    // A path outside the task's workspace fails at the route, so a mistyped
    // path is an error the agent can act on rather than a silent no-op.
    expect(refused.ok).toBe(false);

    await pressShortcut(client, { key: "Escape" });
    await waitForActiveTab(client, "agent");
    expect(await openTabIds(client)).toEqual(["agent"]);
  });

  it("brings a task's tabs back after the app restarts, and forgets a closed task's", async () => {
    await selectTask(taskId);
    await closeViewTabs(client);

    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");
    await callVueMethod(client, "openFilePreview", "README.md");
    await waitForActiveTab(client, "file:README.md");
    await pressShortcut(client, { key: "d", meta: true });
    await waitForActiveTab(client, "diff");

    // The tab state is written on a debounce, so a reload that beat the write
    // would prove nothing. Reload rather than open a second WebDriver session:
    // a new session attaches to the app that is still running, so the tabs
    // would never have left memory and this would pass with no storage at all.
    await sleep(1_200);

    await client.reload();
    await selectTask(taskId);

    // The agent session is rebuilt rather than stored, and the tab that was in
    // front is the tab that comes back in front.
    await waitForActiveTab(client, "diff");
    expect(await openTabIds(client)).toEqual(["agent", "diff", "file:README.md"]);
    await client.waitForText(".preview-modal .file-path", "README.md", 8_000);

    // The other task never opened a view, so it comes back as it was.
    await selectTask(secondTaskId);
    expect(await openTabIds(client)).toEqual(["agent"]);

    await selectTask(taskId);
    await closeViewTabs(client);
    await sleep(1_200);
  });
});
