import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildGlobalKeydownScript, buildSelectorKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepoDirect, resetDatabase } from "../helpers/reset";
import { callVueMethod, execDb, closeMainTabsScript } from "../helpers/vue";

const REPO_NAME = "task-switch-minimal";
const IGNORED_FILE = "ignored-output.log";

function isVueCallError(result: unknown): result is { __error: string } {
  return Boolean(
    result
    && typeof result === "object"
    && "__error" in result
    && typeof (result as { __error?: unknown }).__error === "string",
  );
}

async function pressKey(
  client: WebDriverClient,
  key: string,
  opts: { meta?: boolean; shift?: boolean; alt?: boolean } = {},
): Promise<void> {
  await client.executeSync(buildGlobalKeydownScript({
    key,
    meta: opts.meta,
    shift: opts.shift,
    alt: opts.alt,
  }));
}

async function pressTreeKey(client: WebDriverClient, key: string): Promise<void> {
  await client.executeSync(buildSelectorKeydownScript(".tree-modal", { key }));
}

async function pressActiveElementKey(client: WebDriverClient, key: string): Promise<void> {
  await client.executeSync(
    `document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
       key: ${JSON.stringify(key)},
       bubbles: true,
       cancelable: true,
     }));`,
  );
}

async function textContent(client: WebDriverClient, selector: string): Promise<string> {
  return await client.executeSync<string>(
    `return document.querySelector(${JSON.stringify(selector)})?.textContent ?? "";`,
  );
}

async function waitForExplorerText(
  client: WebDriverClient,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await textContent(client, ".tree-modal");
    if (text.includes(expected)) return;
    await sleep(100);
  }
  throw new Error(`tree explorer never showed ${expected}`);
}

async function clickTreeItem(client: WebDriverClient, columnSelector: string, label: string): Promise<void> {
  const clicked = await client.executeSync<boolean>(
    `const column = document.querySelector(${JSON.stringify(columnSelector)});
     const item = Array.from(column?.querySelectorAll(".tree-item") ?? [])
       .find((el) => el.querySelector(".entry-name")?.textContent?.trim() === ${JSON.stringify(label)});
     if (!item) return false;
     item.click();
     return true;`,
  );
  expect(clicked).toBe(true);
}

async function wheelTree(client: WebDriverClient, deltaX: number, deltaY = 0): Promise<void> {
  await client.executeSync(
    `const target = document.querySelector(".miller-columns");
     target?.dispatchEvent(new WheelEvent("wheel", {
       deltaX: ${deltaX},
       deltaY: ${deltaY},
       bubbles: true,
       cancelable: true,
     }));`,
  );
}

async function waitForBreadcrumb(
  client: WebDriverClient,
  text: string,
  options: { contains: boolean },
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const breadcrumb = await textContent(client, ".breadcrumb-bar");
    if (options.contains ? breadcrumb.includes(text) : !breadcrumb.includes(text)) return;
    await sleep(100);
  }
  const mode = options.contains ? "include" : "exclude";
  throw new Error(`breadcrumb did not ${mode} ${text}`);
}

describe("tree explorer", () => {
  const client = new WebDriverClient();
  let fixtureRepoPath = "";
  let fixtureRepoId = "";
  let repoImported = false;

  beforeAll(async () => {
    fixtureRepoPath = await createSeedFixtureRepo("task-switch-minimal");
    await writeFile(join(fixtureRepoPath, ".gitignore"), "*.log\n", "utf8");
    await writeFile(join(fixtureRepoPath, IGNORED_FILE), "ignored\n", "utf8");
    await client.createSession();
    await resetDatabase(client);
  });

  afterAll(async () => {
    if (fixtureRepoPath) await cleanupWorktrees(client, fixtureRepoPath);
    await cleanupFixtureRepos(fixtureRepoPath ? [fixtureRepoPath] : []);
    await client.deleteSession();
  });

  async function ensureRepoImported(): Promise<void> {
    if (repoImported) return;
    fixtureRepoId = await importTestRepoDirect(client, fixtureRepoPath, REPO_NAME);
    await client.waitForText(".repo-header", REPO_NAME, 10_000);
    repoImported = true;
  }

  it("toggles ignored files through the UI for an imported fixture repo", async () => {
    await ensureRepoImported();

    await pressKey(client, "E", { meta: true, shift: true });
    await client.waitForElement(".tree-modal", 5_000);
    await waitForExplorerText(client, "README.md");

    expect(await textContent(client, ".tree-modal")).not.toContain(IGNORED_FILE);

    const toggle = await client.waitForElement(".show-all-toggle", 2_000);
    await client.click(toggle);
    await waitForExplorerText(client, IGNORED_FILE);

    expect(await textContent(client, ".show-all-toggle")).toContain("showing all");
  });

  it("enters a directory from a current-column mouse click", async () => {
    await ensureRepoImported();

    await client.executeSync(
      closeMainTabsScript(["tree"]),
    );

    await pressKey(client, "E", { meta: true, shift: true });
    await client.waitForElement(".tree-modal", 5_000);
    await waitForExplorerText(client, "src/");

    await clickTreeItem(client, ".col-current", "src/");

    await client.waitForText(".breadcrumb-bar", "src", 5_000);
    await waitForExplorerText(client, "index.txt");
  });

  it("uses horizontal trackpad gestures to enter and exit folders", async () => {
    await ensureRepoImported();

    await client.executeSync(
      closeMainTabsScript(["tree"]),
    );

    await pressKey(client, "E", { meta: true, shift: true });
    await client.waitForElement(".tree-modal", 5_000);
    await waitForExplorerText(client, "src/");

    await wheelTree(client, 96);

    await waitForBreadcrumb(client, "src", { contains: true });
    await waitForExplorerText(client, "index.txt");

    await wheelTree(client, -96);

    await waitForBreadcrumb(client, "src", { contains: false });
  });

  it("closes a stacked commit graph before closing the tree explorer with Escape", async () => {
    await ensureRepoImported();

    await client.executeSync(
      closeMainTabsScript(["tree", "graph"]),
    );

    await pressKey(client, "E", { meta: true, shift: true });
    await client.waitForElement(".tree-modal", 5_000);

    await pressKey(client, "g", { meta: true });
    await client.waitForElement(".graph-modal", 5_000);

    await pressKey(client, "Escape");
    await client.waitForNoElement(".graph-modal", 5_000);
    await client.waitForElement(".tree-modal", 5_000);

    await pressKey(client, "Escape");
    await client.waitForNoElement(".tree-modal", 5_000);
  });

  it("keeps tree explorer keyboard shortcuts active after closing a file preview", async () => {
    await ensureRepoImported();

    await client.executeSync(
      closeMainTabsScript(["tree", "file"]),
    );

    await pressKey(client, "E", { meta: true, shift: true });
    await client.waitForElement(".tree-modal", 5_000);
    await waitForExplorerText(client, "README.md");

    expect(await textContent(client, ".tree-modal")).not.toContain(IGNORED_FILE);

    await pressTreeKey(client, "j");
    await pressTreeKey(client, "j");
    await pressTreeKey(client, "l");
    await client.waitForText(".preview-modal .file-path", "README.md", 5_000);

    await pressKey(client, "Escape");
    await client.waitForNoElement(".preview-modal", 5_000);
    await client.waitForElement(".tree-modal", 5_000);

    await pressActiveElementKey(client, "a");
    await waitForExplorerText(client, IGNORED_FILE);
    expect(await textContent(client, ".show-all-toggle")).toContain("showing all");
  });

  it("renders a removed local task worktree as unavailable instead of an empty tree or repo fallback", async () => {
    await ensureRepoImported();
    const taskId = "tree-missing-worktree";
    const branch = "task-tree-missing-worktree";
    await execDb(
      client,
      `INSERT OR REPLACE INTO pipeline_item
         (id, repo_id, prompt, display_name, stage, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        fixtureRepoId,
        "Missing worktree explorer fixture",
        "Missing worktree explorer fixture",
        "in progress",
        branch,
        "agent",
        "2026-09-03T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
      ],
    );
    const refreshResult = await callVueMethod(client, "refreshAllItems");
    if (isVueCallError(refreshResult)) throw new Error(refreshResult.__error);
    const selectResult = await callVueMethod(client, "store.selectItem", taskId);
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);

    await client.executeSync(
      closeMainTabsScript(["tree"]),
    );
    await pressKey(client, "E", { meta: true, shift: true });
    await client.waitForElement('[data-testid="tree-explorer-unavailable"]', 5_000);

    const explorerText = await textContent(client, ".tree-modal");
    expect(explorerText).toContain("Task files unavailable:");
    expect(explorerText).not.toContain("README.md");
    expect(explorerText).not.toContain("(empty)");
  });
});
