import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, execDb } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";

const taskId = "themed-agent-task";

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(value && typeof value === "object" && "__error" in value);
}

function installMockKspScript(): string {
  return `
    window.__KSP_SENT__ = [];
    window.WebSocket = class MockKspSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.({});
        }, 0);
      }
      send(raw) {
        const frame = JSON.parse(raw);
        window.__KSP_SENT__.push(frame);
        if (frame.type === "auth") {
          this.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
          return;
        }
        if (frame.type === "attach" && frame.kind === "agent") {
          this.onmessage?.({ data: JSON.stringify({
            type: "agent_snapshot",
            task_id: frame.task_id,
            next_seq: 8,
            events: [
              { seq: 1, event: { type: "turn_started", model: "claude-test" } },
              { seq: 2, event: { type: "assistant_text", text: "Hello **themed** view", truncated: false } },
              { seq: 3, event: { type: "tool_call", call_id: "call-1", tool_name: "Bash", input: { command: "pnpm test" } } },
              { seq: 4, event: { type: "tool_result", call_id: "call-1", output: "passed", truncated: false, is_error: false } },
              { seq: 5, event: { type: "permission_request", request_id: "perm-1", tool_name: "Edit", input: { file_path: "README.md" } } },
              { seq: 6, event: { type: "diagnostic", message: "debug stderr" } },
              { seq: 7, event: { type: "turn_completed", status: "success", stats: { duration_ms: 1200, num_turns: 1, total_cost_usd: 0.01 } } }
            ]
          }) });
        }
      }
      close() {
        this.readyState = 3;
        this.onclose?.({});
      }
    };
  `;
}

describe("themed agent view", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("themed-agent-view-test");
    testRepoPath = fixtureRepoRoot;
    await mkdir(join(testRepoPath, ".kanna"), { recursive: true });
    await importTestRepo(client, testRepoPath, "themed-agent-view-test");
    await client.executeSync(installMockKspScript());
  });

  afterAll(async () => {
    if (testRepoPath) await cleanupWorktrees(client, testRepoPath);
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("renders journal events, sends input and permissions, interrupts, and rehydrates after reload", async () => {
    const repoId = await client.executeSync<string>(
      `return window.__KANNA_E2E__.setupState.store.repos.find((repo) => repo.path === ${JSON.stringify(testRepoPath)})?.id;`,
    );
    expect(repoId).toBeTruthy();

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, tags, branch, agent_type, agent_provider, activity, created_at, updated_at
       ) VALUES (?, ?, 'Theme this task', 'default', 'in progress', '[]', 'task-themed-agent-task', 'agent', 'claude', 'working', datetime('now'), datetime('now'))`,
      [taskId, repoId],
    );
    await execDb(
      client,
      `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
       VALUES (?, ?, ?, 'agent', ?, ?)`,
      [`agent-${taskId}`, repoId, taskId, testRepoPath, taskId],
    );
    const worktreeRoot = join(testRepoPath, ".kanna-worktrees", "task-themed-agent-task");
    await mkdir(join(worktreeRoot, ".claude", "commands"), { recursive: true });
    // A project slash command the menu should discover when the view mounts.
    await writeFile(
      join(worktreeRoot, ".claude", "commands", "ping.md"),
      "---\ndescription: Reply with pong\n---\nReply with exactly: pong\n",
    );
    const loadResult = await callVueMethod(client, "loadItems");
    if (isVueCallError(loadResult)) throw new Error(loadResult.__error);
    const selectResult = await callVueMethod(client, "handleSelectItem", taskId);
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);
    const refreshResult = await callVueMethod(client, "refreshAllItems");
    if (isVueCallError(refreshResult)) throw new Error(refreshResult.__error);

    const selectedState = await client.executeSync<{
      selectedItemId: string | null;
      currentItem: { id: string; agent_type: string | null; stage: string | null } | null;
      itemIds: string[];
    }>(
      `const ctx = window.__KANNA_E2E__.setupState;
       return {
         selectedItemId: ctx.store.selectedItemId,
         currentItem: ctx.store.currentItem ? {
           id: ctx.store.currentItem.id,
           agent_type: ctx.store.currentItem.agent_type,
           stage: ctx.store.currentItem.stage,
         } : null,
         itemIds: ctx.store.items.map((item) => item.id),
       };`,
    );
    expect(selectedState).toEqual(expect.objectContaining({
      selectedItemId: taskId,
      currentItem: expect.objectContaining({ id: taskId, agent_type: "agent" }),
    }));

    await client.waitForElement('[data-testid="agent-message-view"]', 5_000);

    await client.waitForText('[data-testid="agent-message-view"]', "Hello themed view", 5_000);
    // Tool-call/result/debug plumbing is intentionally hidden; the permission
    // prompt is the one piece of tool machinery that stays surfaced.
    await client.waitForText(".permission-card", "README.md", 5_000);

    await client.waitForElement('[data-testid="model-select"]', 5_000);
    await client.executeSync(
      `const select = document.querySelector('[data-testid="model-select"]');
       select.value = "claude-haiku-4-5-20251001";
       select.dispatchEvent(new Event("change", { bubbles: true }));`,
    );
    const modelFrame = await client.executeSync<{ type: string; task_id: string; model: string } | undefined>(
      `return window.__KSP_SENT__.find((frame) => frame.type === "agent_set_model");`,
    );
    expect(modelFrame).toEqual({
      type: "agent_set_model",
      task_id: taskId,
      model: "claude-haiku-4-5-20251001",
    });

    // Slash commands: typing "/" scans the worktree's .claude/commands and
    // surfaces them in a menu. Clear it afterwards so later steering is clean.
    await client.executeSync(
      `const composer = document.querySelector('[data-testid="agent-composer"]');
       composer.value = "/";
       composer.dispatchEvent(new Event("input", { bubbles: true }));`,
    );
    await client.waitForText('[data-testid="slash-menu"]', "/ping", 5_000);
    await client.executeSync(
      `const composer = document.querySelector('[data-testid="agent-composer"]');
       composer.value = "";
       composer.dispatchEvent(new Event("input", { bubbles: true }));`,
    );
    await client.waitForNoElement('[data-testid="slash-menu"]', 5_000);

    // Appearance is driven by the user preference (moved out of an in-view switcher).
    await client.executeSync(
      `window.__KANNA_E2E__.setupState.store.agentMessageAppearance = 'log';`,
    );
    await client.waitForElement('.agent-message-view.skin-log', 5_000);
    await client.executeSync(
      `window.__KANNA_E2E__.setupState.store.agentMessageAppearance = 'terminal';`,
    );
    await client.waitForElement('.agent-message-view.skin-terminal', 5_000);

    await client.executeSync(
      `const composer = document.querySelector('[data-testid="agent-composer"]');
       composer.value = "Please continue";
       composer.dispatchEvent(new Event("input", { bubbles: true }));
       composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));`,
    );
    await client.click(await client.waitForText(".permission-actions button", "Allow", 2_000));
    await client.click(await client.waitForText(".permission-actions button", "Deny", 2_000));
    // Interrupt via Esc in the composer (the send button only becomes Stop while a
    // turn is actively running; Esc-to-interrupt is always available).
    await client.executeSync(
      `document.querySelector('[data-testid="agent-composer"]')
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));`,
    );

    const sentTypes = await client.executeSync<string[]>("return window.__KSP_SENT__.map((frame) => frame.type);");
    expect(sentTypes).toContain("agent_input");
    expect(sentTypes).toContain("agent_permission");
    expect(sentTypes).toContain("agent_interrupt");

    await client.executeSync(installMockKspScript());
    await client.executeSync(
      `const store = window.__KANNA_E2E__.setupState.store;
       store.$patch({ selectedItemId: null });
       setTimeout(() => { store.$patch({ selectedItemId: ${JSON.stringify(taskId)} }); }, 0);`,
    );
    await client.waitForText('[data-testid="agent-message-view"]', "Hello themed view", 5_000);
  });
});
