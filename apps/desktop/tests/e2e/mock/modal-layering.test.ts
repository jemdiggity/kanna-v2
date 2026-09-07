import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { getVueState, tauriInvoke } from "../helpers/vue";

/**
 * The task's own views — diff, file, shell — are tabs in the main content
 * area now, not overlays. What is left stacking is the modals that are still
 * modals: the tree explorer, the commit graph and the file picker. They must
 * keep layering above each other, and above the tabs.
 */
type ModalKind = "tree" | "graph" | "picker";

interface ModalStackEntry {
  kind: ModalKind;
  zIndex: number;
}

function modalStackScript(): string {
  return `
    const entries = Array.from(document.querySelectorAll(".modal-overlay:not(.embedded)"))
      .filter((overlay) => {
        if (!(overlay instanceof HTMLElement)) return false;
        const style = getComputedStyle(overlay);
        const rect = overlay.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((overlay) => {
        const kind =
          overlay.querySelector(".tree-modal") ? "tree" :
          overlay.querySelector(".graph-modal") ? "graph" :
          overlay.querySelector(".picker-modal") ? "picker" :
          null;
        return kind ? { kind, zIndex: Number(getComputedStyle(overlay).zIndex) || 0 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.zIndex - a.zIndex);
    return entries;
  `;
}

async function modalStack(client: WebDriverClient): Promise<ModalStackEntry[]> {
  return await client.executeSync<ModalStackEntry[]>(modalStackScript());
}

async function waitForTopModal(
  client: WebDriverClient,
  kind: ModalKind,
  timeoutMs = 8000,
): Promise<ModalStackEntry[]> {
  const deadline = Date.now() + timeoutMs;
  let latest: ModalStackEntry[] = [];

  while (Date.now() < deadline) {
    latest = await modalStack(client);
    if (latest[0]?.kind === kind) return latest;
    await sleep(200);
  }

  throw new Error(`expected top modal ${kind}, got stack ${JSON.stringify(latest)}`);
}

async function pressShortcut(
  client: WebDriverClient,
  options: { key: string; meta?: boolean; shift?: boolean },
): Promise<void> {
  await client.executeSync(buildGlobalKeydownScript(options));
}

async function openTabIds(client: WebDriverClient): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return Array.from(document.querySelectorAll('[data-testid="main-tab-bar"] [role="tab"]'))
      .map((tab) => (tab.getAttribute("data-testid") || "").replace(/^main-tab-/, ""));`
  );
}

async function waitForOpenTab(
  client: WebDriverClient,
  id: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest: string[] = [];
  while (Date.now() < deadline) {
    latest = await openTabIds(client);
    if (latest.includes(id)) return;
    await sleep(200);
  }
  throw new Error(`expected an open ${id} tab, got ${JSON.stringify(latest)}`);
}

describe("modal layering", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);

    fixtureRepoRoot = await createSeedFixtureRepo("task-switch-minimal");
    testRepoPath = fixtureRepoRoot;
    await importTestRepo(client, testRepoPath, "modal-layering-test");

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
      script: "printf '\\n# modal layering e2e\\n' >> README.md",
      cwd: worktreePath,
      env: {},
    });

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       db.execute("INSERT INTO pipeline_item (id, repo_id, prompt, stage, branch, agent_type) VALUES (?, ?, ?, ?, ?, ?)",
         ["${id}", "${repoId}", "Modal layering task", "in progress", "${branch}", "agent"])
         .then(function() { return ctx.loadItems("${repoId}"); })
         .then(function() { ctx.selectSidebarItemById("${id}"); return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    await client.waitForText(".sidebar", "Modal layering task");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("stacks the remaining modals above each other and above the task's tabs", async () => {
    // The task's own views go to the tab bar, not onto the modal stack.
    await pressShortcut(client, { key: "d", meta: true });
    await waitForOpenTab(client, "diff");
    await pressShortcut(client, { key: "j", meta: true });
    await waitForOpenTab(client, "shell");
    expect(await modalStack(client)).toEqual([]);

    await pressShortcut(client, { key: "E", meta: true, shift: true });
    let stack = await waitForTopModal(client, "tree");
    expect(stack.map((entry) => entry.kind)).toEqual(["tree"]);

    await pressShortcut(client, { key: "g", meta: true });
    stack = await waitForTopModal(client, "graph");
    expect(stack.map((entry) => entry.kind).slice(0, 2)).toEqual(["graph", "tree"]);

    await pressShortcut(client, { key: "p", meta: true });
    stack = await waitForTopModal(client, "picker");
    expect(stack.map((entry) => entry.kind).slice(0, 3)).toEqual(["picker", "graph", "tree"]);

    // Picking a file hands it to the tab bar and takes the picker off the
    // stack; the tree explorer is a browser, not a launcher, and stays.
    const file = await client.waitForElement(".picker-modal .file-item", 5000);
    await client.click(file);
    await waitForTopModal(client, "graph");
    stack = await modalStack(client);
    expect(stack.map((entry) => entry.kind)).toEqual(["graph", "tree"]);
    expect(await openTabIds(client)).toContain("diff");
    expect(await openTabIds(client)).toContain("shell");
    expect((await openTabIds(client)).some((id) => id.startsWith("file:"))).toBe(true);

    // Escape reaches the tabs only once every modal has declined it: the
    // graph goes first, then the tree, and the tabs are still there.
    await pressShortcut(client, { key: "Escape" });
    await waitForTopModal(client, "tree");
    await pressShortcut(client, { key: "Escape" });
    await sleep(400);
    expect(await modalStack(client)).toEqual([]);
    expect(await openTabIds(client)).toContain("diff");
  });
});
