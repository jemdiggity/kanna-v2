import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AGENT_PROVIDER_SPECS, type AgentProvider } from "@kanna/agent-protocol";
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

async function holdNewTaskOptionRequests(
  client: WebDriverClient,
  repoId: string,
  responses: Record<string, unknown> = {},
): Promise<void> {
  await client.executeSync(
    `const originalFetch = globalThis.fetch;
     const callOriginalFetch = originalFetch.bind(globalThis);
     let releaseOptionRequests;
     const optionRequestGate = new Promise((resolve) => { releaseOptionRequests = resolve; });
     const heldPaths = new Set([
       ${JSON.stringify(`/v1/repos/${encodeURIComponent(repoId)}/kanna-definitions`)},
       ${JSON.stringify(`/v1/repos/${encodeURIComponent(repoId)}/agent-providers`)},
       ${JSON.stringify(`/v1/repos/${encodeURIComponent(repoId)}/recent-workflows`)},
     ]);
     const responses = new Map(Object.entries(${JSON.stringify(responses)}));
     const gate = {
       originalFetch,
       heldPaths,
       requestsHeld: [],
       released: false,
       release() {
         if (this.released) return;
         this.released = true;
         releaseOptionRequests();
       },
     };
     window.__KANNA_NEW_TASK_OPTIONS_GATE__ = gate;
     globalThis.fetch = async (input, init) => {
       const url = typeof input === "string"
         ? input
         : input instanceof URL
           ? input.href
           : input.url;
       const path = new URL(url, window.location.href).pathname;
       if (heldPaths.has(path)) {
         gate.requestsHeld.push(path);
         await optionRequestGate;
         if (responses.has(path)) {
           return new Response(JSON.stringify(responses.get(path)), {
             status: 200,
             headers: { "content-type": "application/json" },
           });
         }
       }
       return callOriginalFetch(input, init);
     };
     return true;`,
  );
}

async function releaseNewTaskOptionRequests(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `window.__KANNA_NEW_TASK_OPTIONS_GATE__?.release(); return true;`,
  );
}

async function waitForHeldNewTaskOptionRequests(
  client: WebDriverClient,
  expectedPaths: string[],
  timeoutMs = 5_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let heldPaths: string[] = [];

  while (Date.now() < deadline) {
    heldPaths = await client.executeSync<string[]>(
      `return Array.from(window.__KANNA_NEW_TASK_OPTIONS_GATE__?.requestsHeld ?? []);`,
    );
    if (expectedPaths.every((path) => heldPaths.includes(path))) return heldPaths;
    await sleep(50);
  }

  throw new Error(
    `timed out waiting for held New Task option requests ${JSON.stringify(expectedPaths)}; held ${JSON.stringify(heldPaths)}`,
  );
}

async function restoreNewTaskOptionRequests(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `const gate = window.__KANNA_NEW_TASK_OPTIONS_GATE__;
     if (gate) {
       gate.release?.();
       globalThis.fetch = gate.originalFetch;
     }
     delete window.__KANNA_NEW_TASK_OPTIONS_GATE__;
     return true;`,
  );
}

/**
 * Hold the modal's origin refresh so the list it renders from the refs on disk,
 * the operator's choice, and the refreshed list are three observable steps
 * rather than one race. Only `fetch-origin` is held: the reads that populate
 * the modal must still answer, because the point is that they answer first.
 */
async function holdOriginRefreshRequests(
  client: WebDriverClient,
  repoId: string,
): Promise<void> {
  await client.executeSync(
    `const originalFetch = globalThis.fetch;
     const callOriginalFetch = originalFetch.bind(globalThis);
     let releaseRefresh;
     const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
     const heldPath = ${JSON.stringify(`/v1/repos/${encodeURIComponent(repoId)}/fetch-origin`)};
     const gate = {
       originalFetch,
       requestsHeld: [],
       released: false,
       release() {
         if (this.released) return;
         this.released = true;
         releaseRefresh();
       },
     };
     window.__KANNA_ORIGIN_REFRESH_GATE__ = gate;
     globalThis.fetch = async (input, init) => {
       const url = typeof input === "string"
         ? input
         : input instanceof URL
           ? input.href
           : input.url;
       const path = new URL(url, window.location.href).pathname;
       if (path === heldPath) {
         gate.requestsHeld.push(path);
         await refreshGate;
       }
       return callOriginalFetch(input, init);
     };
     return true;`,
  );
}

async function waitForHeldOriginRefreshRequest(
  client: WebDriverClient,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const held = await client.executeSync<string[]>(
      `return Array.from(window.__KANNA_ORIGIN_REFRESH_GATE__?.requestsHeld ?? []);`,
    );
    if (held.length > 0) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for the new task modal to request an origin refresh");
}

async function releaseOriginRefreshRequests(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `window.__KANNA_ORIGIN_REFRESH_GATE__?.release(); return true;`,
  );
}

async function restoreOriginRefreshRequests(client: WebDriverClient): Promise<void> {
  await client.executeSync(
    `const gate = window.__KANNA_ORIGIN_REFRESH_GATE__;
     if (gate) {
       gate.release?.();
       globalThis.fetch = gate.originalFetch;
     }
     delete window.__KANNA_ORIGIN_REFRESH_GATE__;
     return true;`,
  );
}

/** The workflow names the picker is currently offering. Requires it open. */
async function workflowOptionNames(client: WebDriverClient): Promise<string[]> {
  return await client.executeSync<string[]>(
    `return Array.from(document.querySelectorAll('[data-testid^="workflow-option-"]'))
       .map((option) => option.textContent?.trim() ?? "");`,
  );
}

async function openWorkflowPicker(client: WebDriverClient): Promise<void> {
  await client.click(await client.waitForElement('[data-testid="workflow-toggle"]', 2_000));
  await client.waitForElement('[data-testid="workflow-options"]', 2_000);
}

async function selectedWorkflowName(client: WebDriverClient): Promise<string> {
  return await client.executeSync<string>(
    `return document.querySelector('[data-testid="workflow-value"]')?.textContent?.trim() ?? "";`,
  );
}

async function openNewTaskModal(client: WebDriverClient): Promise<void> {
  const modalResult = await callVueMethod(client, "keyboardActions.newTask");
  expect(modalResult).toBeNull();
  await client.waitForElement(".modal-overlay", 5_000);
  await client.waitForNoElement('[data-testid="task-options-loading"]', 10_000);
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

async function listAgentChoices(
  client: WebDriverClient,
  maxChoices = 12,
): Promise<string[]> {
  const first = await agentChoiceLabel(client);
  const choices = [first];

  for (let i = 1; i < maxChoices; i += 1) {
    await client.click(await client.waitForElement(".agent-provider", 2_000));
    const current = await agentChoiceLabel(client);
    if (current === first) return choices;
    choices.push(current);
  }

  throw new Error(`agent choices did not cycle back to ${first}: ${choices.join(", ")}`);
}

async function submitTaskFromModal(
  client: WebDriverClient,
  prompt: string,
): Promise<void> {
  const promptInput = await client.waitForElement(".prompt-input", 2_000);
  await client.sendKeys(promptInput, prompt);
  const selection = await client.executeSync<{
    agentLabel: string;
    workflow: string;
    baseBranch: string;
  }>(
    `return {
       agentLabel: document.querySelector(".agent-provider")?.textContent?.trim() ?? "",
       workflow: document.querySelector('[data-testid="workflow-value"]')?.textContent?.trim() ?? "",
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
       ${JSON.stringify(selection.workflow)},
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
  let repoId = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("new-task-modal-test");
    testRepoPath = fixtureRepoRoot;

    const kannaDir = join(testRepoPath, ".kanna");
    const workflowsDir = join(kannaDir, "workflows");
    const fakeBinDir = join(kannaDir, "fake-bin");
    await mkdir(workflowsDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(
      join(kannaDir, "config.json"),
      // Deliberately the retired `pipeline` key: repo configs written before
      // the workflow rename must still resolve through the whole stack.
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
      join(workflowsDir, "default.json"),
      JSON.stringify({ name: "default", stages: [{ name: "in progress", transition: "manual", agent_provider: "claude" }] }),
    );
    await writeFile(
      join(workflowsDir, "qa-review.json"),
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

    repoId = await importTestRepo(client, testRepoPath, "new-task-modal-test");
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

    // Preferences is a tab, not an overlay: Escape goes to the window and the
    // dismiss handler routes it to the tab in front.
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
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

  it("renders an editable New Task modal while repository options are unresolved", async () => {
    const definitionsPath = `/v1/repos/${encodeURIComponent(repoId)}/kanna-definitions`;
    const providersPath = `/v1/repos/${encodeURIComponent(repoId)}/agent-providers`;
    const recentWorkflowsPath = `/v1/repos/${encodeURIComponent(repoId)}/recent-workflows`;
    await holdNewTaskOptionRequests(client, repoId);

    try {
      await client.executeSync(buildGlobalKeydownScript({ key: "N", meta: true, shift: true }));

      const loading = await client.waitForElement('[data-testid="task-options-loading"]', 5_000);
      expect(loading).toBeTruthy();
      // The sticky-workflow lookup is held alongside the other option requests,
      // so the modal has to leave its loading state on the slowest of them.
      await waitForHeldNewTaskOptionRequests(client, [
        definitionsPath,
        providersPath,
        recentWorkflowsPath,
      ]);
      const prompt = await client.waitForElement(".prompt-input", 2_000);
      await client.sendKeys(prompt, "Prompt remains editable while options load");

      const pendingState = await client.executeSync<{
        heading: string;
        prompt: string;
        requestsHeld: string[];
        createDisabled: boolean;
        agentDisabled: boolean;
        workflowDisabled: boolean;
        baseBranchDisabled: boolean;
        baseBranch: string;
        baseBranchInvalid: boolean;
      }>(
        `const gate = window.__KANNA_NEW_TASK_OPTIONS_GATE__;
         return {
           heading: document.querySelector(".modal-header h3")?.textContent?.trim() ?? "",
           prompt: document.querySelector(".prompt-input")?.value ?? "",
           requestsHeld: Array.from(gate?.requestsHeld ?? []),
           createDisabled: document.querySelector(".modal-overlay .btn-primary")?.disabled === true,
           agentDisabled: document.querySelector(".agent-provider")?.disabled === true,
           workflowDisabled: document.querySelector('[data-testid="workflow-toggle"]')?.disabled === true,
           baseBranchDisabled: document.querySelector('[data-testid="base-branch-toggle"]')?.disabled === true,
           baseBranch: document.querySelector('[data-testid="base-branch-value"]')?.textContent?.trim() ?? "",
           baseBranchInvalid: document.querySelector('[data-testid="base-branch-value"]')?.classList.contains("invalid") === true,
         };`,
      );
      expect(pendingState).toEqual({
        heading: "New Task",
        prompt: "Prompt remains editable while options load",
        requestsHeld: expect.arrayContaining([
          definitionsPath,
          providersPath,
        ]),
        createDisabled: true,
        agentDisabled: true,
        workflowDisabled: true,
        baseBranchDisabled: true,
        baseBranch: "Loading task options…",
        baseBranchInvalid: false,
      });

      await releaseNewTaskOptionRequests(client);
      await client.waitForNoElement('[data-testid="task-options-loading"]', 10_000);

      const loadedState = await client.executeSync<{
        prompt: string;
        workflow: string;
        baseBranch: string;
        createDisabled: boolean;
        agentDisabled: boolean;
        workflowDisabled: boolean;
        baseBranchDisabled: boolean;
      }>(
        `return {
           prompt: document.querySelector(".prompt-input")?.value ?? "",
           workflow: document.querySelector('[data-testid="workflow-value"]')?.textContent?.trim() ?? "",
           baseBranch: document.querySelector('[data-testid="base-branch-value"]')?.textContent?.trim() ?? "",
           createDisabled: document.querySelector(".modal-overlay .btn-primary")?.disabled === true,
           agentDisabled: document.querySelector(".agent-provider")?.disabled === true,
           workflowDisabled: document.querySelector('[data-testid="workflow-toggle"]')?.disabled === true,
           baseBranchDisabled: document.querySelector('[data-testid="base-branch-toggle"]')?.disabled === true,
         };`,
      );
      expect(loadedState).toEqual({
        prompt: "Prompt remains editable while options load",
        workflow: "qa-review",
        baseBranch: expect.any(String),
        createDisabled: false,
        agentDisabled: false,
        workflowDisabled: false,
        baseBranchDisabled: false,
      });
      expect(loadedState.baseBranch.length).toBeGreaterThan(0);

      await client.executeSync(
        buildSelectorKeydownScript(".prompt-input", { key: "Enter", meta: true }),
      );
      const created = await waitForTaskCreated(client, "Prompt remains editable while options load");
      const taskRows = await queryDb(
        client,
        "SELECT pipeline FROM pipeline_item WHERE id = ?",
        [created.id],
      ) as Array<{ pipeline: string }>;
      expect(taskRows[0]?.pipeline).toBe("qa-review");
    } finally {
      await restoreNewTaskOptionRequests(client).catch(() => undefined);
      await client.executeSync(
        buildSelectorKeydownScript(".modal-overlay .modal", { key: "Escape" }),
      ).catch(() => undefined);
      await client.waitForNoElement(".modal-overlay", 5_000);
    }
  });

  it("shows cached repository options immediately while a reopen refresh is held", async () => {
    const definitionsPath = `/v1/repos/${encodeURIComponent(repoId)}/kanna-definitions`;
    const providersPath = `/v1/repos/${encodeURIComponent(repoId)}/agent-providers`;
    const recentWorkflowsPath = `/v1/repos/${encodeURIComponent(repoId)}/recent-workflows`;
    let optionRequestsHeld = false;
    let trunkBranchCreated = false;

    try {
      await reloadApp(client);
      await dismissStartupShortcutsModal(client);
      await openNewTaskModal(client);
      expect(await client.executeSync<string>(
        `return document.querySelector('[data-testid="workflow-value"]')?.textContent?.trim() ?? "";`,
      )).toBe("qa-review");
      expect(await client.executeSync<string>(
        `return document.querySelector('[data-testid="base-branch-value"]')?.textContent?.trim() ?? "";`,
      )).toBe("origin/main");
      await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
      await client.waitForNoElement(".modal-overlay", 5_000);

      await git(testRepoPath, ["branch", "trunk"]);
      trunkBranchCreated = true;
      await git(testRepoPath, ["push", "origin", "trunk"]);
      await git(testRepoPath, ["remote", "set-head", "origin", "trunk"]);

      await holdNewTaskOptionRequests(client, repoId, {
        [definitionsPath]: {
          revision: "refreshed-revision",
          refName: "origin/trunk",
          config: { workflow: "release" },
          defaultWorkflow: "release",
          workflows: ["default", "qa-review", "release"],
        },
        // A repo's most recently used workflow outranks its configured
        // default, so an empty history is the precondition for observing the
        // refreshed manifest default at all.
        [recentWorkflowsPath]: { workflows: [] },
      });
      optionRequestsHeld = true;
      await client.executeSync(buildGlobalKeydownScript({ key: "N", meta: true, shift: true }));
      await client.waitForElement('[data-testid="task-options-loading"]', 5_000);
      await waitForHeldNewTaskOptionRequests(client, [
        definitionsPath,
        providersPath,
        recentWorkflowsPath,
      ]);

      const cachedState = await client.executeSync<{
        requestsHeld: string[];
        workflow: string;
        baseBranch: string;
        baseBranchInvalid: boolean;
      }>(
        `const gate = window.__KANNA_NEW_TASK_OPTIONS_GATE__;
         return {
           requestsHeld: Array.from(gate?.requestsHeld ?? []),
           workflow: document.querySelector('[data-testid="workflow-value"]')?.textContent?.trim() ?? "",
           baseBranch: document.querySelector('[data-testid="base-branch-value"]')?.textContent?.trim() ?? "",
           baseBranchInvalid: document.querySelector('[data-testid="base-branch-value"]')?.classList.contains("invalid") === true,
         };`,
      );
      expect(cachedState).toEqual({
        requestsHeld: expect.arrayContaining([
          definitionsPath,
          providersPath,
        ]),
        workflow: "qa-review",
        baseBranch: "origin/main",
        baseBranchInvalid: false,
      });

      await releaseNewTaskOptionRequests(client);
      await client.waitForNoElement('[data-testid="task-options-loading"]', 10_000);
      await client.waitForText('[data-testid="workflow-value"]', "release", 5_000);
      await client.waitForText('[data-testid="base-branch-value"]', "origin/trunk", 5_000);
      await client.click(await client.waitForElement('[data-testid="workflow-toggle"]', 2_000));
      await client.click(await client.waitForElement('[data-testid="base-branch-toggle"]', 2_000));

      const refreshedState = await client.executeSync<{
        workflow: string;
        workflowOptions: string[];
        baseBranch: string;
        baseBranchOptions: string[];
      }>(
        `return {
           workflow: document.querySelector('[data-testid="workflow-value"]')?.textContent?.trim() ?? "",
           workflowOptions: Array.from(document.querySelectorAll('[data-testid^="workflow-option-"]'))
             .map((option) => option.textContent?.trim() ?? ""),
           baseBranch: document.querySelector('[data-testid="base-branch-value"]')?.textContent?.trim() ?? "",
           baseBranchOptions: Array.from(document.querySelectorAll('[data-testid^="base-branch-option-"]'))
             .map((option) => option.textContent?.trim() ?? ""),
         };`,
      );
      expect(refreshedState).toEqual({
        workflow: "release",
        workflowOptions: expect.arrayContaining(["default", "qa-review", "release"]),
        baseBranch: "origin/trunk",
        baseBranchOptions: expect.arrayContaining(["origin/trunk", "trunk"]),
      });
    } finally {
      if (optionRequestsHeld) {
        await restoreNewTaskOptionRequests(client).catch(() => undefined);
      }
      await client.executeSync(buildGlobalKeydownScript({ key: "Escape" })).catch(() => undefined);
      await client.waitForNoElement(".modal-overlay", 5_000);
      if (trunkBranchCreated) {
        await git(testRepoPath, ["remote", "set-head", "origin", "main"]).catch(() => undefined);
        await git(testRepoPath, ["push", "origin", "--delete", "trunk"]).catch(() => undefined);
        await git(testRepoPath, ["branch", "-D", "trunk"]).catch(() => undefined);
      }
    }
  });

  it("opens the workflow selector as a compact dropdown matching the base branch selector", async () => {
    await openNewTaskModal(client);

    const toggle = await client.waitForElement('[data-testid="workflow-toggle"]', 5_000);
    await client.click(toggle);
    await client.waitForElement('[data-testid="workflow-dropdown"]', 2_000);

    const snapshot = await client.executeSync<{
      dropdownClasses: string[];
      optionsClasses: string[];
      optionsStyle: string;
      text: string;
      legacyPickerExists: boolean;
    }>(
      `const dropdown = document.querySelector('[data-testid="workflow-dropdown"]');
       const options = document.querySelector('[data-testid="workflow-options"]');
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

    await openNewTaskModal(client);

    const defaultMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(defaultMode).toBe("claude");

    await submitTaskFromModal(client, cliPrompt);
    expect(await waitForTaskCreated(client, cliPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "pty",
    }));

    await openNewTaskModal(client);
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

    // This file runs with agent-provider isolation, which shadows every
    // provider executable with a blocked stub so no real CLI can launch —
    // which also makes every provider resolvable regardless of what this
    // machine has installed. Asserting a fixed provider list here therefore
    // asserts the machine, not the app; which providers a repo offers is
    // covered directly in `useAppTaskCreation.test.ts`. What this E2E proves
    // is the relationship: the picker offers exactly the providers the server
    // reports available, plus an SDK choice for each headless-capable one.
    const repoProviders = await client.executeSync<string[]>(
      `const providers = window.__KANNA_E2E__?.setupState?.appTaskCreation?.availableAgentProviders;
       return Array.from(providers?.value ?? providers ?? []);`,
    );
    // The repo's own fake-bin backs these two, so they are available on any machine.
    expect(repoProviders).toContain("claude");
    expect(repoProviders).toContain("opencode");

    const headlessProviders = new Set(
      AGENT_PROVIDER_SPECS.filter(({ supports_headless }) => supports_headless).map(({ id }) => id),
    );
    // The picker owns its own ordering; what matters is the membership.
    const choices = await listAgentChoices(client);
    expect([...choices].sort()).toEqual([
      ...repoProviders,
      ...repoProviders
        .filter((provider) => headlessProviders.has(provider as AgentProvider))
        .map((provider) => `${provider} sdk`),
    ].sort());

    await cycleToAgentChoice(client, "opencode sdk");
    await submitTaskFromModal(client, prompt);

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
    expect(await callVueMethod(client, "store.selectItem", created.id)).toBeNull();
    await client.waitForText(
      '[data-testid="agent-message-view"]',
      OPENCODE_COMPLETION_MARKER,
      10_000,
    );
    await client.waitForText('[data-testid="agent-message-view"]', "Turn success", 10_000);
  });

  it("cycles through installed agents alphabetically", async () => {
    await resetRecentAgentChoices(client);

    await openNewTaskModal(client);

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

    await openNewTaskModal(client);

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

    const opencodeSdkPrompt = "Remember opencode sdk as the recent task agent";
    await cycleToAgentChoice(client, "opencode sdk");
    await submitTaskFromModal(client, opencodeSdkPrompt);
    expect(await waitForTaskCreated(client, opencodeSdkPrompt)).toEqual(expect.objectContaining({
      agent_provider: "opencode",
      agent_type: "agent",
    }));
    expect(await waitForRecentAgentChoicesSetting(client, [
      { provider: "opencode", executionType: "agent" },
      { provider: "claude", executionType: "agent" },
    ])).toEqual([
      { provider: "opencode", executionType: "agent" },
      { provider: "claude", executionType: "agent" },
    ]);

    await openNewTaskModal(client);
    expect(await agentChoiceLabel(client)).toBe("opencode sdk");
    await client.click(await client.waitForElement(".agent-provider", 2_000));
    expect(await agentChoiceLabel(client)).toBe("claude sdk");
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  });

  it("creates a dormant task blocked by an existing task through the blocked-by picker", async () => {
    const blockerPrompt = "Blocked-by picker blocker task";
    const dependentPrompt = "Blocked-by picker dependent task";

    await openNewTaskModal(client);
    await cycleToAgentChoice(client, "claude");
    await submitTaskFromModal(client, blockerPrompt);
    const blockerTask = await waitForTaskCreated(client, blockerPrompt);
    await waitForTaskInStore(client, blockerTask.id);

    await openNewTaskModal(client);
    const promptInput = await client.waitForElement(".prompt-input", 2_000);
    await client.sendKeys(promptInput, dependentPrompt);

    expect(await client.executeSync<string>(
      `return document.querySelector('[data-testid="blocked-by-value"]')?.textContent?.trim() ?? "";`,
    )).toBe("None");

    await client.click(await client.waitForElement('[data-testid="blocked-by-toggle"]', 2_000));
    const pickerInput = await client.waitForElement(".inline-input", 2_000);
    await client.sendKeys(pickerInput, "Blocked-by picker blocker");
    await client.click(await client.waitForElement(".command-item", 2_000));
    await client.executeSync(buildSelectorKeydownScript(".inline-input", { key: "Enter" }));
    await client.waitForNoElement(".inline-input", 2_000);

    expect(await client.executeSync<string>(
      `return document.querySelector('[data-testid="blocked-by-value"]')?.textContent?.trim() ?? "";`,
    )).toBe(blockerPrompt);

    await client.click(await client.waitForElement(".modal-overlay .btn-primary", 2_000));
    const dependentTask = await waitForTaskCreated(client, dependentPrompt);

    const blockerRows = await queryDb(
      client,
      "SELECT blocker_item_id FROM task_blocker WHERE blocked_item_id = ?",
      [dependentTask.id],
    ) as Array<{ blocker_item_id: string }>;
    expect(blockerRows).toEqual([{ blocker_item_id: blockerTask.id }]);

    // The blocker is still open, so the dependent task takes the dormant
    // creation path: no worktree until the blocker resolves.
    const worktreeRows = await queryDb(
      client,
      "SELECT id FROM worktree WHERE pipeline_item_id = ?",
      [dependentTask.id],
    );
    expect(worktreeRows).toEqual([]);
  });

  async function selectWorkflow(workflow: string): Promise<void> {
    await client.click(await client.waitForElement('[data-testid="workflow-toggle"]', 2_000));
    await client.click(
      await client.waitForElement(`[data-testid="workflow-option-${workflow}"]`, 2_000),
    );
    await client.waitForText('[data-testid="workflow-value"]', workflow, 2_000);
  }

  it("defaults New Task to the workflow this repository last created a task with", async () => {
    // Every task so far used the repo's configured default.
    await openNewTaskModal(client);
    expect(await client.executeSync<string>(
      `return document.querySelector('[data-testid="workflow-value"]')?.textContent?.trim() ?? "";`,
    )).toBe("qa-review");

    const stickyPrompt = "Sticky workflow picks default";
    await selectWorkflow("default");
    await submitTaskFromModal(client, stickyPrompt);
    const stickyTask = await waitForTaskCreated(client, stickyPrompt);
    expect(await queryDb(
      client,
      "SELECT pipeline FROM pipeline_item WHERE id = ?",
      [stickyTask.id],
    )).toEqual([{ pipeline: "default" }]);

    await openNewTaskModal(client);
    await client.waitForText('[data-testid="workflow-value"]', "default", 5_000);
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".modal-overlay", 5_000);
  });

  it("remembers the workflow of a create whose response was lost, past a close and a restart", async () => {
    const lostPrompt = "Sticky workflow survives a lost create response";

    // A create that commits its task row server-side but never delivers the
    // response to this window.
    await client.executeSync(
      `const originalFetch = globalThis.fetch;
       const callOriginalFetch = originalFetch.bind(globalThis);
       window.__KANNA_LOST_CREATE_RESPONSE__ = { originalFetch };
       globalThis.fetch = async (input, init) => {
         const url = typeof input === "string"
           ? input
           : input instanceof URL
             ? input.href
             : input.url;
         const path = new URL(url, window.location.href).pathname;
         const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET") ?? "GET").toUpperCase();
         const response = await callOriginalFetch(input, init);
         if (path === "/v1/tasks" && method === "POST") {
           throw new TypeError("simulated create response loss");
         }
         return response;
       };
       return true;`,
    );

    let lostTaskId = "";
    try {
      await openNewTaskModal(client);
      await client.waitForText('[data-testid="workflow-value"]', "default", 5_000);
      await selectWorkflow("qa-review");

      const promptInput = await client.waitForElement(".prompt-input", 2_000);
      await client.sendKeys(promptInput, lostPrompt);
      const submitOutcome = await client.executeAsync<string>(
        `const cb = arguments[arguments.length - 1];
         const ctx = window.__KANNA_E2E__?.setupState;
         Promise.resolve(ctx?.appTaskCreation?.handleNewTaskSubmit?.(
           ${JSON.stringify(lostPrompt)},
           "claude",
           "qa-review",
           document.querySelector('[data-testid="base-branch-value"]')?.textContent?.trim() ?? "",
           "pty"
         ))
           .then(() => cb("settled"))
           .catch((e) => cb("err:" + (e?.message || String(e))));`,
      );
      // handleNewTaskSubmit reports the failure through a toast rather than
      // rejecting, so the window genuinely never learns the task id.
      expect(submitOutcome).toBe("settled");

      const lostTask = await waitForTaskCreated(client, lostPrompt);
      lostTaskId = lostTask.id;
      expect(await queryDb(
        client,
        "SELECT pipeline FROM pipeline_item WHERE id = ?",
        [lostTaskId],
      )).toEqual([{ pipeline: "qa-review" }]);
    } finally {
      await client.executeSync(
        `const saved = window.__KANNA_LOST_CREATE_RESPONSE__;
         if (saved) globalThis.fetch = saved.originalFetch;
         delete window.__KANNA_LOST_CREATE_RESPONSE__;
         return true;`,
      ).catch(() => undefined);
      await client.executeSync(buildGlobalKeydownScript({ key: "Escape" })).catch(() => undefined);
      await client.waitForNoElement(".modal-overlay", 5_000).catch(() => undefined);
    }

    // Closed before the restart: the desktop snapshot drops closed tasks, so
    // only the durable rows can still answer what workflow it used.
    await waitForTaskInStore(client, lostTaskId);
    expect(await callVueMethod(client, "store.closeTask", lostTaskId, { selectNext: false })).toBe(true);
    const closedRows = await queryDb(
      client,
      "SELECT closed_at FROM pipeline_item WHERE id = ?",
      [lostTaskId],
    ) as Array<{ closed_at: string | null }>;
    expect(closedRows[0]?.closed_at).toBeTruthy();

    await reloadApp(client);
    await dismissStartupShortcutsModal(client);
    await openNewTaskModal(client);
    await client.waitForText('[data-testid="workflow-value"]', "qa-review", 5_000);
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".modal-overlay", 5_000);
  });

  // Publishes to the fixture origin and leaves it published, so it runs last:
  // a test added after this one would inherit the extra workflow.
  it("offers a workflow pushed to origin after the modal is already on screen", async () => {
    // Definition reads resolve from the remote-tracking refs already on disk,
    // so a workflow pushed since the last fetch can only reach this picker if
    // the modal fetches origin itself and re-reads behind its own render.
    const pushedWorkflow = "pushed-review";
    const originPath = join(dirname(testRepoPath), `${basename(testRepoPath)}-origin.git`);
    const publisherPath = join(dirname(testRepoPath), "pushed-workflow-publisher");
    let refreshRequestsHeld = false;

    try {
      await openNewTaskModal(client);
      await openWorkflowPicker(client);
      expect(await workflowOptionNames(client)).not.toContain(pushedWorkflow);
      await client.click(await client.waitForElement('[data-testid="workflow-toggle"]', 2_000));
      await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
      await client.waitForNoElement(".modal-overlay", 5_000);

      // Publish from a second clone. Pushing from the imported repo would move
      // its own remote-tracking ref, which is the very thing that has to be
      // stale for this test to mean anything.
      await execFileAsync("git", ["clone", originPath, publisherPath]);
      await git(publisherPath, ["config", "user.name", "Kanna E2E"]);
      await git(publisherPath, ["config", "user.email", "kanna-e2e@example.com"]);
      await mkdir(join(publisherPath, ".kanna", "workflows"), { recursive: true });
      await writeFile(
        join(publisherPath, ".kanna", "workflows", `${pushedWorkflow}.json`),
        JSON.stringify({
          name: pushedWorkflow,
          stages: [{ name: "in progress", transition: "manual", agent_provider: "claude" }],
        }),
      );
      await git(publisherPath, ["add", ".kanna"]);
      await git(publisherPath, ["commit", "-m", "test: publish a workflow the desktop repo has not fetched"]);
      await git(publisherPath, ["push", "origin", "main"]);

      await holdOriginRefreshRequests(client, repoId);
      refreshRequestsHeld = true;

      await openNewTaskModal(client);
      await openWorkflowPicker(client);
      // The modal is usable before anything reaches the network, and what it
      // offers at this point is exactly what the refs on disk hold.
      expect(await workflowOptionNames(client)).not.toContain(pushedWorkflow);

      // Choose a workflow that is not the repo's default, so a refresh that
      // reset the selection would be visible.
      await client.click(await client.waitForElement('[data-testid="workflow-option-default"]', 2_000));
      expect(await selectedWorkflowName(client)).toBe("default");

      await waitForHeldOriginRefreshRequest(client);
      await releaseOriginRefreshRequests(client);

      // Only a real fetch-origin round trip and re-read can put this option in
      // the picker: nothing in this test stubs the definitions route.
      await client.waitForElement('[data-testid="workflow-toggle"]', 2_000);
      await openWorkflowPicker(client);
      await client.waitForElement(`[data-testid="workflow-option-${pushedWorkflow}"]`, 10_000);
      expect(await workflowOptionNames(client)).toContain(pushedWorkflow);

      // The refresh brought new choices without moving the one already made.
      expect(await selectedWorkflowName(client)).toBe("default");
    } finally {
      if (refreshRequestsHeld) {
        await restoreOriginRefreshRequests(client).catch(() => undefined);
      }
      await client.executeSync(buildGlobalKeydownScript({ key: "Escape" })).catch(() => undefined);
      await client.waitForNoElement(".modal-overlay", 5_000).catch(() => undefined);
    }
  });
});
