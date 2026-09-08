import { mkdir, realpath, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, execDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";

const taskId = "themed-agent-task";
const runningTaskId = "themed-agent-running-task";
const recoveryTaskId = "themed-agent-recovery-task";
const imageTaskId = "themed-agent-image-task";

function isVueCallError(value: unknown): value is { __error: string } {
  return Boolean(value && typeof value === "object" && "__error" in value);
}

function installMockKspScript(options: { failFirstAgentAttach?: boolean; recoveredText?: string; activeTurn?: boolean } = {}): string {
  const failFirstAgentAttach = options.failFirstAgentAttach === true;
  const recoveredText = options.recoveredText ?? "Hello **themed** view";
  const activeTurn = options.activeTurn === true;
  return `
    window.__KSP_REAL_WEBSOCKET__ = window.__KSP_REAL_WEBSOCKET__ || window.WebSocket;
    window.__KSP_SENT__ = [];
    window.__KSP_AGENT_ATTACH_COUNT__ = 0;
    window.__KSP_MOCK_OPTIONS__ = {
      failFirstAgentAttach: ${JSON.stringify(failFirstAgentAttach)},
      recoveredText: ${JSON.stringify(recoveredText)},
      activeTurn: ${JSON.stringify(activeTurn)}
    };
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
          window.__KSP_AGENT_ATTACH_COUNT__ += 1;
          const options = window.__KSP_MOCK_OPTIONS__ || {};
          if (options.failFirstAgentAttach && window.__KSP_AGENT_ATTACH_COUNT__ === 1) {
            this.onmessage?.({ data: JSON.stringify({
              type: "error",
              task_id: frame.task_id,
              code: "session_not_found",
              message: "agent session not found: " + frame.task_id
            }) });
            return;
          }
          const events = [
            { seq: 1, event: { type: "turn_started", model: "claude-test" } },
            { seq: 2, event: { type: "assistant_text", text: options.recoveredText || "Hello **themed** view", truncated: false } },
            { seq: 3, event: { type: "tool_call", call_id: "call-1", tool_name: "Bash", input: { command: "pnpm test" } } },
            { seq: 4, event: { type: "tool_result", call_id: "call-1", output: "passed", truncated: false, is_error: false } },
            { seq: 5, event: { type: "permission_request", request_id: "perm-1", tool_name: "Edit", input: { file_path: "README.md" } } },
            { seq: 6, event: { type: "diagnostic", message: "debug stderr" } }
          ];
          if (!options.activeTurn) {
            events.push({ seq: 7, event: { type: "turn_completed", status: "success", stats: { duration_ms: 1200, num_turns: 1, total_cost_usd: 0.01 } } });
          }
          this.onmessage?.({ data: JSON.stringify({
            type: "agent_snapshot",
            task_id: frame.task_id,
            next_seq: events.length + 1,
            events
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

async function waitForComposerFocus(client: WebDriverClient, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastActive = "";

  while (Date.now() < deadline) {
    const result = await client.executeSync<{ focused: boolean; active: string }>(
      `const composer = document.querySelector('[data-testid="agent-composer"]');
       const active = document.activeElement;
       return {
         focused: Boolean(composer && active === composer),
         active: active ? (active.getAttribute('data-testid') || active.getAttribute('aria-label') || active.className || active.tagName) : ''
       };`,
    );
    if (result.focused) return;
    lastActive = result.active;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for agent composer focus; active element was ${lastActive}`);
}

describe("themed agent view", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("themed-agent-view-test");
    testRepoPath = await realpath(fixtureRepoRoot);
    await mkdir(join(testRepoPath, ".kanna"), { recursive: true });
    await importTestRepo(client, testRepoPath, "themed-agent-view-test");
    await client.executeSync(installMockKspScript());
    await client.executeSync("window.__KANNA_E2E__.resetStreamClient?.();");
  });

  afterAll(async () => {
    // The mock KSP replaces `window.WebSocket` for the whole app instance, so
    // leaving it installed silently starves every later file's terminals.
    await client.executeSync(
      `if (window.__KSP_REAL_WEBSOCKET__) {
         window.WebSocket = window.__KSP_REAL_WEBSOCKET__;
         delete window.__KSP_REAL_WEBSOCKET__;
       }
       window.__KANNA_E2E__.resetStreamClient?.();
       return true;`,
    ).catch(() => undefined);
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
         id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity, created_at, updated_at
       ) VALUES (?, ?, 'Theme this task', 'default', 'in progress', 'task-themed-agent-task', 'agent', 'claude', 'working', datetime('now'), datetime('now'))`,
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
    const selectResult = await callVueMethod(client, "selectSidebarItemById", taskId);
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
    await client.waitForElement('[data-testid="agent-composer"]', 5_000);
    await waitForComposerFocus(client);

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
       composer.focus();`,
    );
    await waitForComposerFocus(client);
    await client.click(await client.waitForElement(".send-button", 2_000));
    await waitForComposerFocus(client);
    const inputFrame = await client.executeSync<{ type: string; task_id: string; text: string } | undefined>(
      `return window.__KSP_SENT__.find((frame) => frame.type === "agent_input");`,
    );
    expect(inputFrame).toEqual({
      type: "agent_input",
      task_id: taskId,
      text: "Please continue",
    });

    await client.click(await client.waitForText(".permission-actions button", "Allow", 2_000));
    await client.click(await client.waitForText(".permission-actions button", "Deny", 2_000));
    const sentTypesBeforeStop = await client.executeSync<string[]>("return window.__KSP_SENT__.map((frame) => frame.type);");
    expect(sentTypesBeforeStop).toContain("agent_input");
    expect(sentTypesBeforeStop).toContain("agent_permission");

    await client.executeSync(installMockKspScript({ activeTurn: true }));
    await client.executeSync("window.__KANNA_E2E__.resetStreamClient?.();");
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity, created_at, updated_at
       ) VALUES (?, ?, 'Stop this task', 'default', 'in progress', 'task-themed-agent-running-task', 'agent', 'claude', 'working', datetime('now'), datetime('now'))`,
      [runningTaskId, repoId],
    );
    await execDb(
      client,
      `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
       VALUES (?, ?, ?, 'agent', ?, ?)`,
      [`agent-${runningTaskId}`, repoId, runningTaskId, testRepoPath, runningTaskId],
    );
    await mkdir(join(testRepoPath, ".kanna-worktrees", "task-themed-agent-running-task"), { recursive: true });
    const loadRunningResult = await callVueMethod(client, "loadItems");
    if (isVueCallError(loadRunningResult)) throw new Error(loadRunningResult.__error);
    const selectRunningResult = await callVueMethod(client, "selectSidebarItemById", runningTaskId);
    if (isVueCallError(selectRunningResult)) throw new Error(selectRunningResult.__error);
    const runningSelectedState = await client.executeSync<{
      selectedItemId: string | null;
      currentItem: { id: string; agent_type: string | null; stage: string | null } | null;
    }>(
      `const store = window.__KANNA_E2E__.setupState.store;
       return {
         selectedItemId: store.selectedItemId,
         currentItem: store.currentItem ? {
           id: store.currentItem.id,
           agent_type: store.currentItem.agent_type,
           stage: store.currentItem.stage,
         } : null
       };`,
    );
    expect(runningSelectedState).toEqual(expect.objectContaining({
      selectedItemId: runningTaskId,
      currentItem: expect.objectContaining({ id: runningTaskId, agent_type: "agent" }),
    }));
    await client.waitForElement(".stop-button", 5_000);
    await waitForComposerFocus(client);
    await client.click(await client.waitForElement(".stop-button", 2_000));
    await waitForComposerFocus(client);

    const interruptFrame = await client.executeSync<{ type: string; task_id: string } | undefined>(
      `return window.__KSP_SENT__.find((frame) => frame.type === "agent_interrupt");`,
    );
    expect(interruptFrame).toEqual({
      type: "agent_interrupt",
      task_id: runningTaskId,
    });

    await client.executeSync(installMockKspScript());
    await client.executeSync("window.__KANNA_E2E__.resetStreamClient?.();");
    await client.executeSync(
      `const store = window.__KANNA_E2E__.setupState.store;
       store.$patch({ selectedItemId: null });
       setTimeout(() => { store.$patch({ selectedItemId: ${JSON.stringify(taskId)} }); }, 0);`,
    );
    await client.waitForText('[data-testid="agent-message-view"]', "Hello themed view", 5_000);
  });

  it("recovers a missing headless agent session and reattaches to the recovered snapshot", async () => {
    const repoId = await client.executeSync<string>(
      `return window.__KANNA_E2E__.setupState.store.repos.find((repo) => repo.path === ${JSON.stringify(testRepoPath)})?.id;`,
    );
    expect(repoId).toBeTruthy();

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider,
         activity, agent_spawn_options, created_at, updated_at
       ) VALUES (?, ?, 'Recover this task', 'default', 'in progress', 'task-themed-agent-recovery-task',
         'agent', 'claude', 'working', ?, datetime('now'), datetime('now'))`,
      [
        recoveryTaskId,
        repoId,
        JSON.stringify({
          model: "claude-sonnet-test",
          permissionMode: "dontAsk",
          allowedTools: ["Read", "Bash"],
          disallowedTools: ["WebFetch"],
          maxTurns: 5,
          maxBudgetUsd: 2.25,
        }),
      ],
    );
    await execDb(
      client,
      `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
       VALUES (?, ?, ?, 'agent', ?, ?)`,
      [`agent-${recoveryTaskId}`, repoId, recoveryTaskId, testRepoPath, recoveryTaskId],
    );
    const worktreeRoot = join(testRepoPath, ".kanna-worktrees", "task-themed-agent-recovery-task");
    await mkdir(worktreeRoot, { recursive: true });

    await client.executeSync(installMockKspScript({
      failFirstAgentAttach: true,
      recoveredText: "Recovered **agent** snapshot",
    }));
    await client.executeSync("window.__KANNA_E2E__.resetStreamClient?.();");
    await client.executeSync("window.__KANNA_E2E__.invokes.clear();");

    // Recovery is a server action now (`POST /v1/tasks/{id}/actions/resume`),
    // not the desktop-only `spawn_agent_session` invoke this used to assert —
    // the agent spawn options it carried are resolved server-side and covered
    // by the server's own tests. What stays browser-visible, and is what this
    // E2E is for, is: a missing agent session asks the server to resume THIS
    // task, and the view reattaches to the recovered snapshot rather than
    // stranding the run off-screen. The response is served locally because a
    // seeded fixture task has no real agent session for the server to resume.
    await client.executeSync(
      `const originalFetch = globalThis.fetch;
       const callOriginalFetch = originalFetch.bind(globalThis);
       const resumePath = ${JSON.stringify(`/v1/tasks/${recoveryTaskId}/actions/resume`)};
       const spy = { originalFetch, calls: [] };
       window.__KANNA_RESUME_SPY__ = spy;
       globalThis.fetch = async (input, init) => {
         const url = typeof input === "string"
           ? input
           : input instanceof URL
             ? input.href
             : input.url;
         const method = String(
           init?.method ?? (input instanceof Request ? input.method : "GET")
         ).toUpperCase();
         const path = new URL(url, window.location.href).pathname;
         if (method === "POST" && path === resumePath) {
           spy.calls.push(path);
           return new Response(JSON.stringify({ taskId: ${JSON.stringify(recoveryTaskId)} }), {
             status: 200,
             headers: { "content-type": "application/json" },
           });
         }
         return callOriginalFetch(input, init);
       };
       return true;`,
    );

    try {
      const loadResult = await callVueMethod(client, "loadItems");
      if (isVueCallError(loadResult)) throw new Error(loadResult.__error);
      const selectResult = await callVueMethod(client, "selectSidebarItemById", recoveryTaskId);
      if (isVueCallError(selectResult)) throw new Error(selectResult.__error);

      const resumeDeadline = Date.now() + 10_000;
      let resumeCalls = 0;
      while (Date.now() < resumeDeadline) {
        resumeCalls = await client.executeSync<number>(
          "return window.__KANNA_RESUME_SPY__?.calls.length ?? 0;",
        );
        if (resumeCalls > 0) break;
        await sleep(100);
      }
      expect(resumeCalls).toBeGreaterThanOrEqual(1);

      // The desktop holds the recovery pending until the daemon names the new
      // incarnation, so stand one up under the task's session id the way a
      // real respawn would.
      await tauriInvoke(client, "spawn_session", {
        sessionId: recoveryTaskId,
        cwd: testRepoPath,
        executable: "/bin/zsh",
        args: ["-c", "while true; do sleep 60; done"],
        env: {},
        cols: 80,
        rows: 24,
      });

      await client.waitForText('[data-testid="agent-message-view"]', "Recovered agent snapshot", 15_000);
      const attachCount = await client.executeSync<number>("return window.__KSP_AGENT_ATTACH_COUNT__;");
      expect(attachCount).toBeGreaterThanOrEqual(2);
    } finally {
      await client.executeSync(
        `const spy = window.__KANNA_RESUME_SPY__;
         if (spy) globalThis.fetch = spy.originalFetch;
         delete window.__KANNA_RESUME_SPY__;
         return true;`,
      ).catch(() => undefined);
      await tauriInvoke(client, "kill_session", { sessionId: recoveryTaskId }).catch(() => undefined);
    }
  });

  it("renders assistant image links inline and opens them in the app image preview", async () => {
    const imageUrl = "https://example.com/artifacts/simple-paper-boat.png";
    const repoId = await client.executeSync<string>(
      `return window.__KANNA_E2E__.setupState.store.repos.find((repo) => repo.path === ${JSON.stringify(testRepoPath)})?.id;`,
    );
    expect(repoId).toBeTruthy();

    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider, activity, created_at, updated_at
       ) VALUES (?, ?, 'Render an image link', 'default', 'in progress', 'task-themed-agent-image-task',
         'agent', 'claude', 'working', datetime('now'), datetime('now'))`,
      [imageTaskId, repoId],
    );
    await execDb(
      client,
      `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
       VALUES (?, ?, ?, 'agent', ?, ?)`,
      [`agent-${imageTaskId}`, repoId, imageTaskId, testRepoPath, imageTaskId],
    );
    await mkdir(join(testRepoPath, ".kanna-worktrees", "task-themed-agent-image-task"), { recursive: true });

    await client.executeSync(installMockKspScript({
      recoveredText: `Screenshot artifact: ${imageUrl}`,
    }));
    await client.executeSync("window.__KANNA_E2E__.resetStreamClient?.();");

    const loadResult = await callVueMethod(client, "loadItems");
    if (isVueCallError(loadResult)) throw new Error(loadResult.__error);
    const selectResult = await callVueMethod(client, "selectSidebarItemById", imageTaskId);
    if (isVueCallError(selectResult)) throw new Error(selectResult.__error);

    await client.waitForElement(".agent-image-link-preview img", 5_000);
    const inlinePreview = await client.executeSync<{
      imageSrc: string | null;
      linkHrefs: string[];
      rawLinkCount: number;
    }>(
      `const preview = document.querySelector(".agent-image-link-preview");
       return {
         imageSrc: preview?.querySelector("img")?.getAttribute("src") ?? null,
         linkHrefs: Array.from(preview?.querySelectorAll("a") ?? []).map((link) => link.getAttribute("href")),
         rawLinkCount: Array.from(document.querySelectorAll('[data-testid="agent-message-view"] a'))
           .filter((link) => link.textContent === ${JSON.stringify(imageUrl)} && !link.closest(".agent-image-link-preview")).length,
       };`,
    );
    expect(inlinePreview.imageSrc).toBe(imageUrl);
    expect(inlinePreview.linkHrefs).toEqual([imageUrl, imageUrl]);
    expect(inlinePreview.rawLinkCount).toBe(0);

    await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
    await client.click(await client.waitForElement(".agent-image-link-preview-media", 2_000));
    await client.waitForElement(".image-preview-modal img", 5_000);

    const modalState = await client.executeSync<{
      sourceLabel: string | null;
      imageSrc: string | null;
      readerCalls: number;
    }>(
      `return {
         sourceLabel: document.querySelector(".image-preview-modal .image-source")?.textContent ?? null,
         imageSrc: document.querySelector(".image-preview-modal img")?.getAttribute("src") ?? null,
         readerCalls: window.__KANNA_E2E__.invokes.getAll()
           .filter((call) => call.cmd === "read_image_file_data_url").length,
       };`,
    );

    expect(modalState).toEqual({
      sourceLabel: imageUrl,
      imageSrc: imageUrl,
      readerCalls: 0,
    });
  });
});
