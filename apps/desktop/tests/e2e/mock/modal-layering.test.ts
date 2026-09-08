import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { getVueState, tauriInvoke } from "../helpers/vue";

type ModalKind = "diff" | "shell" | "tree" | "graph" | "picker" | "preview";

interface ModalStackEntry {
  kind: ModalKind;
  zIndex: number;
}

function modalStackScript(): string {
  return `
    const entries = Array.from(document.querySelectorAll(".modal-overlay"))
      .filter((overlay) => {
        if (!(overlay instanceof HTMLElement)) return false;
        const style = getComputedStyle(overlay);
        const rect = overlay.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((overlay) => {
        const kind =
          overlay.querySelector(".diff-modal") ? "diff" :
          overlay.querySelector(".shell-modal") ? "shell" :
          overlay.querySelector(".tree-modal") ? "tree" :
          overlay.querySelector(".graph-modal") ? "graph" :
          overlay.querySelector(".picker-modal") ? "picker" :
          overlay.querySelector(".preview-modal") ? "preview" :
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

async function openPreviewFromCurrentContext(client: WebDriverClient): Promise<void> {
  await pressShortcut(client, { key: "p", meta: true });
  await waitForTopModal(client, "picker");
  const file = await client.waitForElement(".picker-modal .file-item", 5000);
  await client.click(file);
  await waitForTopModal(client, "preview");
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

  it("opens preview modals from other preview modal contexts and stacks each new modal on top", async () => {
    await pressShortcut(client, { key: "d", meta: true });
    let stack = await waitForTopModal(client, "diff");
    expect(stack.map((entry) => entry.kind)).toEqual(["diff"]);

    await pressShortcut(client, { key: "j", meta: true });
    stack = await waitForTopModal(client, "shell");
    expect(stack.map((entry) => entry.kind).slice(0, 2)).toEqual(["shell", "diff"]);

    await pressShortcut(client, { key: "E", meta: true, shift: true });
    stack = await waitForTopModal(client, "tree");
    expect(stack.map((entry) => entry.kind).slice(0, 3)).toEqual(["tree", "shell", "diff"]);

    await pressShortcut(client, { key: "g", meta: true });
    stack = await waitForTopModal(client, "graph");
    expect(stack.map((entry) => entry.kind).slice(0, 4)).toEqual(["graph", "tree", "shell", "diff"]);

    await openPreviewFromCurrentContext(client);
    stack = await modalStack(client);
    expect(stack[0]?.kind).toBe("preview");
    expect(stack.map((entry) => entry.kind)).toContain("graph");
    expect(stack.map((entry) => entry.kind)).toContain("shell");

    await pressShortcut(client, { key: "d", meta: true });
    stack = await waitForTopModal(client, "diff");
    expect(stack[0]?.kind).toBe("diff");

    await pressShortcut(client, { key: "j", meta: true });
    stack = await waitForTopModal(client, "shell");
    expect(stack[0]?.kind).toBe("shell");

    await pressShortcut(client, { key: "E", meta: true, shift: true });
    stack = await waitForTopModal(client, "tree");
    expect(stack[0]?.kind).toBe("tree");

    await pressShortcut(client, { key: "g", meta: true });
    stack = await waitForTopModal(client, "graph");
    expect(stack[0]?.kind).toBe("graph");

    await openPreviewFromCurrentContext(client);
    stack = await waitForTopModal(client, "preview");
    expect(stack[0]?.kind).toBe("preview");
  });
});
