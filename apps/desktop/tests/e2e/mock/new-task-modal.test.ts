import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript, buildSelectorKeydownScript } from "../helpers/keyboard";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { waitForTaskCreated } from "../helpers/taskCreation";

const execFileAsync = promisify(execFile);
const OPENCODE_COMPLETION_MARKER = "OpenCode E2E process stream complete";

interface DaemonSessionInfo {
  session_id?: string;
  state?: string;
  status?: string;
  kind?: string;
}

interface StoredTaskSummary {
  id: string;
  agent_provider: string | null;
  agent_type: string | null;
}

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, ...args]);
}

async function openNewTaskModal(client: WebDriverClient): Promise<void> {
  const modalResult = await callVueMethod(client, "keyboardActions.newTask");
  expect(modalResult).toBeNull();
  await client.waitForElement(".modal-overlay", 5_000);
}

async function agentChoiceLabel(client: WebDriverClient): Promise<string> {
  return client.executeSync<string>(
    `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
  );
}

async function cycleToAgentChoice(
  client: WebDriverClient,
  expectedLabel: string,
  maxClicks = 8,
): Promise<void> {
  for (let i = 0; i < maxClicks; i += 1) {
    if (await agentChoiceLabel(client) === expectedLabel) return;
    await client.click(await client.waitForElement(".agent-provider", 2_000));
  }

  expect(await agentChoiceLabel(client)).toBe(expectedLabel);
}

async function submitTaskFromModal(
  client: WebDriverClient,
  prompt: string,
): Promise<void> {
  const promptInput = await client.waitForElement(".prompt-input", 2_000);
  await client.sendKeys(promptInput, prompt);
  const selection = await client.executeSync<{
    agentLabel: string;
    pipeline: string;
    baseBranch: string;
  }>(
    `return {
       agentLabel: document.querySelector(".agent-provider")?.textContent?.trim() ?? "",
       pipeline: document.querySelector('[data-testid="pipeline-value"]')?.textContent?.trim() ?? "",
       baseBranch: document.querySelector('[data-testid="base-branch-value"]')?.textContent?.trim() ?? "",
     };`,
  );
  const agentLabel = selection.agentLabel.toLowerCase();
  const agentProvider = agentLabel.replace(/\s+sdk$/, "");
  const agentType = agentLabel.endsWith(" sdk") ? "agent" : "pty";
  const result = await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const ctx = window.__KANNA_E2E__?.setupState;
     Promise.resolve(ctx?.appTaskCreation?.handleNewTaskSubmit?.(
       ${JSON.stringify(prompt)},
       ${JSON.stringify(agentProvider)},
       ${JSON.stringify(selection.pipeline)},
       ${JSON.stringify(selection.baseBranch)},
       ${JSON.stringify(agentType)}
     ))
       .then(() => cb("ok"))
       .catch((e) => cb("err:" + (e?.message || String(e))));`,
  );
  expect(result).toBe("ok");
}

async function resetRecentAgentChoices(client: WebDriverClient): Promise<void> {
  await execDb(client, "DELETE FROM settings WHERE key = ?", ["recentAgentChoices"]);
  const result = await callVueMethod(client, "appPreferences.handlePreferenceUpdate", "recentAgentChoices", "[]");
  expect(result).toBeNull();
}

async function resetDefaultAgentPreference(client: WebDriverClient): Promise<void> {
  expect(await callVueMethod(client, "appPreferences.handlePreferenceUpdate", "defaultAgentProvider", "claude")).toBeNull();
  expect(await callVueMethod(client, "appPreferences.handlePreferenceUpdate", "defaultAgentType", "pty")).toBeNull();
}

async function recentAgentChoicesSetting(client: WebDriverClient): Promise<unknown[]> {
  const rows = (await queryDb(
    client,
    "SELECT value FROM settings WHERE key = ?",
    ["recentAgentChoices"],
  )) as Array<{ value: string }>;
  return JSON.parse(rows[0]?.value ?? "[]") as unknown[];
}

async function waitForRecentAgentChoicesSetting(
  client: WebDriverClient,
  expected: unknown[],
  timeoutMs = 5_000,
): Promise<unknown[]> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown[] = [];

  while (Date.now() < deadline) {
    last = await recentAgentChoicesSetting(client);
    if (JSON.stringify(last) === JSON.stringify(expected)) {
      return last;
    }
    await sleep(100);
  }

  throw new Error(`timed out waiting for recentAgentChoices ${JSON.stringify(expected)}, last value: ${JSON.stringify(last)}`);
}

async function waitForIdleAgentSession(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 10_000,
): Promise<DaemonSessionInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastSession: DaemonSessionInfo | undefined;

  while (Date.now() < deadline) {
    const result = await tauriInvoke(client, "list_sessions");
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(`list_sessions failed: ${String(result.__error)}`);
    }
    const sessions = Array.isArray(result) ? result as DaemonSessionInfo[] : [];
    lastSession = sessions.find((session) => session.session_id === taskId);
    if (
      lastSession?.state === "Active"
      && lastSession.status === "idle"
      && lastSession.kind === "agent"
    ) {
      return lastSession;
    }
    await sleep(100);
  }

  throw new Error(
    `timed out waiting for idle agent session ${taskId}; last session: ${JSON.stringify(lastSession)}`,
  );
}

async function waitForTaskInStore(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 10_000,
): Promise<StoredTaskSummary> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const task = await client.executeSync<StoredTaskSummary | null>(
      `const store = window.__KANNA_E2E__?.setupState?.store;
       const items = store?.items?.value ?? store?.items ?? [];
       const item = Array.from(items).find((candidate) => candidate.id === ${JSON.stringify(taskId)});
       return item ? {
         id: item.id,
         agent_provider: item.agent_provider ?? null,
         agent_type: item.agent_type ?? null,
       } : null;`,
    );
    if (task) return task;
    await sleep(100);
  }

  throw new Error(`timed out waiting for task ${taskId} in the reloaded app store`);
}

async function reloadApp(client: WebDriverClient, timeoutMs = 15_000): Promise<void> {
  const marker = `new-task-modal-reload-${Date.now()}`;
  await client.executeSync(
    `window.__KANNA_NEW_TASK_MODAL_RELOAD__ = ${JSON.stringify(marker)}; location.reload();`,
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const navigationCompleted = await client.executeSync<boolean>(
        `return window.__KANNA_NEW_TASK_MODAL_RELOAD__ !== ${JSON.stringify(marker)};`,
      );
      if (navigationCompleted) {
        await client.waitForAppReady(timeoutMs);
        return;
      }
    } catch {
      // The WebView is between documents; keep polling for the new app.
    }
    await sleep(100);
  }

  throw new Error("timed out waiting for the app reload to replace the current document");
}

describe("new task modal", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("new-task-modal-test");
    testRepoPath = fixtureRepoRoot;

    const kannaDir = join(testRepoPath, ".kanna");
    const pipelinesDir = join(kannaDir, "pipelines");
    const fakeBinDir = join(kannaDir, "fake-bin");
    await mkdir(pipelinesDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(
      join(kannaDir, "config.json"),
      JSON.stringify({
        pipeline: "qa-review",
        workspace: {
          path: {
            prepend: [".kanna/fake-bin"],
          },
        },
      }),
    );
    await writeFile(
      join(pipelinesDir, "default.json"),
      JSON.stringify({ name: "default", stages: [{ name: "in progress", transition: "manual", agent_provider: "claude" }] }),
    );
    await writeFile(
      join(pipelinesDir, "qa-review.json"),
      JSON.stringify({ name: "qa-review", stages: [{ name: "in progress", transition: "manual", agent_provider: "claude" }] }),
    );
    await writeFile(
      join(fakeBinDir, "claude"),
      [
        "#!/bin/sh",
        "mkdir -p .kanna",
        "printf '%s\\n' \"$@\" > .kanna/new-task-modal-claude-args.txt",
        "printf 'fake new task modal claude complete\\n'",
        "",
      ].join("\n"),
    );
    await chmod(join(fakeBinDir, "claude"), 0o755);
    const opencodeEvents = [
      {
        type: "step_start",
        sessionID: "fake-new-task-modal-opencode",
        timestamp: 1,
        part: {
          type: "step-start",
          id: "step-new-task-modal",
          sessionID: "fake-new-task-modal-opencode",
          messageID: "message-new-task-modal",
        },
      },
      {
        type: "text",
        sessionID: "fake-new-task-modal-opencode",
        timestamp: 2,
        part: {
          type: "text",
          id: "text-new-task-modal",
          sessionID: "fake-new-task-modal-opencode",
          messageID: "message-new-task-modal",
          text: OPENCODE_COMPLETION_MARKER,
        },
      },
      {
        type: "step_finish",
        sessionID: "fake-new-task-modal-opencode",
        timestamp: 3,
        part: {
          type: "step-finish",
          id: "finish-new-task-modal",
          sessionID: "fake-new-task-modal-opencode",
          messageID: "message-new-task-modal",
          reason: "stop",
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    ];
    await writeFile(
      join(fakeBinDir, "opencode"),
      [
        "#!/bin/sh",
        "mkdir -p .kanna",
        "printf '%s\\n' \"$@\" > .kanna/new-task-modal-opencode-args.txt",
        ...opencodeEvents.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`),
        "",
      ].join("\n"),
    );
    await chmod(join(fakeBinDir, "opencode"), 0o755);
    await git(testRepoPath, ["add", ".kanna"]);
    await git(testRepoPath, ["commit", "-m", "test: add new task modal fixtures"]);
    await git(testRepoPath, ["push", "origin", "main"]);

    await importTestRepo(client, testRepoPath, "new-task-modal-test");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  async function setDefaultAgentPreference(value: "claude-sdk" | "codex-sdk") {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);

    await client.executeSync(`
      const select = document.querySelector('[data-testid="default-agent-select"]');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `);

    const expectedProvider = value.replace("-sdk", "");
    const deadline = Date.now() + 5_000;
    let persistedSettings: Record<string, string> = {};
    while (Date.now() < deadline) {
      const rows = await queryDb(
        client,
        "SELECT key, value FROM settings WHERE key IN ('defaultAgentProvider', 'defaultAgentType')",
      ) as Array<{ key: string; value: string }>;
      persistedSettings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      if (persistedSettings.defaultAgentProvider === expectedProvider && persistedSettings.defaultAgentType === "agent") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(persistedSettings).toMatchObject({
      defaultAgentProvider: expectedProvider,
      defaultAgentType: "agent",
    });

    await client.executeSync(buildSelectorKeydownScript(".modal-overlay", { key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);
  }

  async function cycleAgentTo(label: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await client.executeSync<string>(
        `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
      );
      if (current === label) return;
      await client.click(await client.waitForElement(".agent-provider", 2_000));
    }
    const current = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    throw new Error(`agent choice did not reach ${label}; current=${current}`);
  }

  it("opens the pipeline selector as a compact dropdown matching the base branch selector", async () => {
    const modalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(modalResult).toBeNull();

    const toggle = await client.waitForElement('[data-testid="pipeline-toggle"]', 5_000);
    await client.click(toggle);
    await client.waitForElement('[data-testid="pipeline-dropdown"]', 2_000);

    const snapshot = await client.executeSync<{
      dropdownClasses: string[];
      optionsClasses: string[];
      optionsStyle: string;
      text: string;
      legacyPickerExists: boolean;
    }>(
      `const dropdown = document.querySelector('[data-testid="pipeline-dropdown"]');
       const options = document.querySelector('[data-testid="pipeline-options"]');
       return {
         dropdownClasses: dropdown ? Array.from(dropdown.classList) : [],
         optionsClasses: options ? Array.from(options.classList) : [],
         optionsStyle: options?.getAttribute("style") ?? "",
         text: dropdown?.textContent ?? "",
         legacyPickerExists: Boolean(document.querySelector(".base-branch-picker")),
       };`
    );

    expect(snapshot.dropdownClasses).toContain("base-branch-dropdown");
    expect(snapshot.optionsClasses).toContain("base-branch-options");
    expect(snapshot.optionsStyle).toContain("max-height");
    expect(snapshot.text).toContain("qa-review");
    expect(snapshot.legacyPickerExists).toBe(false);

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  });

  it("creates Claude tasks in CLI mode by default and SDK mode as chat mode", async () => {
    const cliPrompt = "Create CLI Claude task";
    const sdkPrompt = "Create SDK Claude task";

    const modalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(modalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    const defaultMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(defaultMode).toBe("claude");

    await submitTaskFromModal(client, cliPrompt);
    expect(await waitForTaskCreated(client, cliPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "pty",
    }));

    const directModalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(directModalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);
    await cycleAgentTo("claude sdk");

    const directMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(directMode).toBe("claude sdk");

    await submitTaskFromModal(client, sdkPrompt);
    expect(await waitForTaskCreated(client, sdkPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "agent",
    }));
  });

  it("creates OpenCode SDK tasks as headless agent tasks", async () => {
    const prompt = "Create SDK OpenCode task";

    await resetRecentAgentChoices(client);
    await resetDefaultAgentPreference(client);
    await openNewTaskModal(client);
    await cycleToAgentChoice(client, "opencode sdk");
    const promptInput = await client.waitForElement(".prompt-input", 2_000);
    await client.sendKeys(promptInput, prompt);
    await client.click(await client.waitForElement(".modal-overlay .btn-primary:not(:disabled)", 2_000));
    await client.waitForNoElement(".modal-overlay", 5_000);

    const created = await waitForTaskCreated(client, prompt);
    expect(created).toEqual(expect.objectContaining({
      agent_provider: "opencode",
      agent_type: "agent",
    }));

    await client.waitForElement('[data-testid="agent-message-view"]', 10_000);
    await client.waitForText(
      '[data-testid="agent-message-view"]',
      OPENCODE_COMPLETION_MARKER,
      10_000,
    );
    await client.waitForText('[data-testid="agent-message-view"]', "Turn success", 10_000);
    expect(await waitForIdleAgentSession(client, created.id)).toEqual(expect.objectContaining({
      session_id: created.id,
      state: "Active",
      status: "idle",
      kind: "agent",
    }));

    await reloadApp(client);
    await dismissStartupShortcutsModal(client);
    expect(await waitForTaskInStore(client, created.id)).toEqual({
      id: created.id,
      agent_provider: "opencode",
      agent_type: "agent",
    });
    expect(await callVueMethod(client, "handleSelectItem", created.id)).toBeNull();
    await client.waitForText(
      '[data-testid="agent-message-view"]',
      OPENCODE_COMPLETION_MARKER,
      10_000,
    );
    await client.waitForText('[data-testid="agent-message-view"]', "Turn success", 10_000);
  });

  it("cycles through installed agents alphabetically", async () => {
    await resetRecentAgentChoices(client);

    const modalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(modalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    await client.click(await client.waitForElement(".agent-provider", 2_000));

    const providerLabel = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(providerLabel).not.toBe("claude");

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  });

  it("uses the persisted sdk default agent preference when creating tasks", async () => {
    await resetRecentAgentChoices(client);

    const claudePrompt = "Create persisted Claude SDK task";

    await setDefaultAgentPreference("claude-sdk");

    const claudeModalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(claudeModalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    const claudeMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(claudeMode).toBe("claude sdk");

    await submitTaskFromModal(client, claudePrompt);
    expect(await waitForTaskCreated(client, claudePrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "agent",
    }));
  });

  it("persists recent exact agent choices and opens the remounted modal with them first", async () => {
    await resetRecentAgentChoices(client);
    await resetDefaultAgentPreference(client);

    const claudeSdkPrompt = "Remember claude sdk as the recent task agent";
    await openNewTaskModal(client);
    await cycleToAgentChoice(client, "claude sdk");
    await submitTaskFromModal(client, claudeSdkPrompt);
    expect(await waitForTaskCreated(client, claudeSdkPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "agent",
    }));
    expect(await waitForRecentAgentChoicesSetting(client, [
      { provider: "claude", executionType: "agent" },
    ])).toEqual([
      { provider: "claude", executionType: "agent" },
    ]);

    await openNewTaskModal(client);
    expect(await agentChoiceLabel(client)).toBe("claude sdk");

    const claudeCliPrompt = "Remember claude cli as the recent task agent";
    await cycleToAgentChoice(client, "claude");
    await submitTaskFromModal(client, claudeCliPrompt);
    expect(await waitForTaskCreated(client, claudeCliPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "pty",
    }));
    expect(await waitForRecentAgentChoicesSetting(client, [
      { provider: "claude", executionType: "pty" },
      { provider: "claude", executionType: "agent" },
    ])).toEqual([
      { provider: "claude", executionType: "pty" },
      { provider: "claude", executionType: "agent" },
    ]);

    await openNewTaskModal(client);
    expect(await agentChoiceLabel(client)).toBe("claude");
    await client.click(await client.waitForElement(".agent-provider", 2_000));
    expect(await agentChoiceLabel(client)).toBe("claude sdk");
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  });
});
