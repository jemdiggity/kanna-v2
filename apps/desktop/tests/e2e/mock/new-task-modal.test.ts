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
import { waitForTaskCreated } from "../helpers/taskCreation";

const execFileAsync = promisify(execFile);
const TASK_HANDOFF_SENTINEL = "E2E_INITIALIZATION_DURABLE_HANDOFF";

interface ToastSnapshot {
  kind: "info" | "warning" | "error" | "unknown";
  text: string;
}

interface TaskHandoffSnapshot {
  selectedItemId: string | null;
  selectedItemIdForPersistence: string | null;
  currentItemId: string | null;
  initializingTaskItems: Array<{
    id: string;
    taskId: string | null;
  }>;
  terminalIds: string[];
  observedTerminalIds: string[];
  invokes: Array<{ cmd: string; args?: unknown }>;
  terminalAttaches: Array<{
    type: "attach";
    kind: "terminal";
    task_id: string;
  }>;
  observedToasts: ToastSnapshot[];
  toasts: ToastSnapshot[];
}

interface TaskHandoffResult extends TaskHandoffSnapshot {
  daemonSessionIds: string[];
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

async function waitForAgentChoiceLabel(
  client: WebDriverClient,
  expectedLabel: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let label = "";
  while (Date.now() < deadline) {
    label = await agentChoiceLabel(client);
    if (label === expectedLabel) return label;
    await sleep(50);
  }
  throw new Error(`timed out waiting for agent choice ${expectedLabel}, last label: ${label}`);
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
  options: { waitForInitialization?: boolean } = {},
): Promise<void> {
  const promptInput = await client.waitForElement(".prompt-input", 2_000);
  await client.sendKeys(promptInput, prompt);
  const createButton = await client.waitForElement(
    ".modal-overlay .btn-primary:not(:disabled)",
    2_000,
  );
  await client.click(createButton);
  await client.waitForNoElement(".modal-overlay", 5_000);
  if (options.waitForInitialization === false) return;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const initializingCount = await client.executeSync<number>(
      `const store = window.__KANNA_E2E__?.setupState?.store;
       const value = store?.initializingTaskItems;
       const items = value?.__v_isRef ? value.value : value;
       return Array.from(items ?? []).length;`,
    );
    if (initializingCount === 0) {
      // Let the submit continuation finish recording the recent agent choice
      // and clear its in-flight guard before another modal submit can start.
      await sleep(100);
      return;
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for modal-created task initialization to finish");
}

async function captureTaskHandoffSnapshot(
  client: WebDriverClient,
): Promise<TaskHandoffSnapshot> {
  return client.executeSync<TaskHandoffSnapshot>(
    `const ctx = window.__KANNA_E2E__?.setupState;
     const store = ctx?.store;
     const unwrap = (value) => value?.__v_isRef ? value.value : value;
     const initializingTaskItems = Array.from(unwrap(store?.initializingTaskItems) ?? []);
     const currentItem = unwrap(store?.currentItem);
     const trace = window.__KANNA_E2E_TASK_HANDOFF_TRACE__;
     const toasts = Array.from(document.querySelectorAll(".toast")).map((toast) => ({
       kind: toast.classList.contains("error")
         ? "error"
         : toast.classList.contains("warning")
           ? "warning"
           : toast.classList.contains("info")
             ? "info"
             : "unknown",
       text: toast.querySelector(".toast-message")?.textContent ?? "",
     }));
     return {
       selectedItemId: unwrap(store?.selectedItemId) ?? null,
       selectedItemIdForPersistence: unwrap(store?.selectedItemIdForPersistence) ?? null,
       currentItemId: currentItem?.id ?? null,
       initializingTaskItems: initializingTaskItems.map((item) => ({
         id: item.id,
         taskId: item.taskId ?? null,
       })),
       terminalIds: window.__KANNA_E2E__?.terminalBuffers?.sessionIds?.() ?? [],
       observedTerminalIds: trace?.observedTerminalIds ?? [],
       invokes: window.__KANNA_E2E__?.invokes?.getAll?.() ?? [],
       terminalAttaches: trace?.terminalAttaches ?? [],
       observedToasts: trace?.observedToasts ?? [],
       toasts,
     };`,
  );
}

async function installTaskHandoffTrace(
  client: WebDriverClient,
): Promise<void> {
  const result = await client.executeSync<string>(
    `window.__KANNA_E2E_TASK_HANDOFF_TRACE__?.restore?.();
     window.__KANNA_E2E__?.invokes?.clear?.();
     const originalSend = WebSocket.prototype.send;
     const terminalAttaches = [];
     const baselineTerminalIds = new Set(window.__KANNA_E2E__?.terminalBuffers?.sessionIds?.() ?? []);
     const observedTerminalIds = [];
     const observedTerminalIdSet = new Set();
     const observedToasts = [];
     const observedToastNodes = new WeakSet();
     const sampleTerminalIds = () => {
       for (const sessionId of window.__KANNA_E2E__?.terminalBuffers?.sessionIds?.() ?? []) {
         if (baselineTerminalIds.has(sessionId) || observedTerminalIdSet.has(sessionId)) continue;
         observedTerminalIdSet.add(sessionId);
         observedTerminalIds.push(sessionId);
       }
     };
     const terminalIdPoller = setInterval(sampleTerminalIds, 10);
     WebSocket.prototype.send = function(data) {
       if (typeof data === "string") {
         try {
           const frame = JSON.parse(data);
           if (frame?.type === "attach" && frame?.kind === "terminal") {
             terminalAttaches.push({
               type: frame.type,
               kind: frame.kind,
               task_id: frame.task_id,
             });
           }
         } catch {
           // Non-JSON WebSocket traffic is unrelated to KSP attachment frames.
         }
       }
       return originalSend.apply(this, arguments);
     };
     const recordToast = (toast) => {
       if (!(toast instanceof Element) || observedToastNodes.has(toast)) return;
       observedToastNodes.add(toast);
       observedToasts.push({
         kind: toast.classList.contains("error")
           ? "error"
           : toast.classList.contains("warning")
             ? "warning"
             : toast.classList.contains("info")
               ? "info"
               : "unknown",
         text: toast.querySelector(".toast-message")?.textContent ?? "",
       });
     };
     const toastObserver = new MutationObserver((records) => {
       for (const record of records) {
         for (const node of record.addedNodes) {
           if (!(node instanceof Element)) continue;
           if (node.matches(".toast")) recordToast(node);
           for (const toast of node.querySelectorAll?.(".toast") ?? []) recordToast(toast);
         }
       }
     });
     toastObserver.observe(document.body, { childList: true, subtree: true });
     window.__KANNA_E2E_TASK_HANDOFF_TRACE__ = {
       terminalAttaches,
       observedTerminalIds,
       observedToasts,
       restore() {
         sampleTerminalIds();
         clearInterval(terminalIdPoller);
         toastObserver.disconnect();
         WebSocket.prototype.send = originalSend;
       },
     };
     return "ok";`,
  );
  expect(result).toBe("ok");
}

async function restoreTaskHandoffTrace(
  client: WebDriverClient,
): Promise<void> {
  await client.executeSync(
    `window.__KANNA_E2E_TASK_HANDOFF_TRACE__?.restore?.();
     delete window.__KANNA_E2E_TASK_HANDOFF_TRACE__;`,
  ).catch(() => undefined);
}

async function waitForDurableTaskHandoff(
  client: WebDriverClient,
  taskId: string,
  timeoutMs = 30_000,
): Promise<TaskHandoffResult> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: TaskHandoffSnapshot | null = null;
  let lastDaemonSessions: unknown = null;

  while (Date.now() < deadline) {
    lastSnapshot = await captureTaskHandoffSnapshot(client);
    lastDaemonSessions = await tauriInvoke(client, "list_sessions");
    const terminalText = await client.executeSync<string>(
      `const buffers = window.__KANNA_E2E__?.terminalBuffers;
       if (!buffers?.sessionIds?.().includes(${JSON.stringify(taskId)})) return "";
       try {
         return buffers.lines(${JSON.stringify(taskId)}).join("\\n");
       } catch {
         return "";
       }`,
    );
    const daemonSessionIds = Array.isArray(lastDaemonSessions)
      ? lastDaemonSessions
        .map((session) => session?.session_id ?? session?.sessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === "string")
      : [];
    if (
      lastSnapshot.selectedItemId === taskId
      && lastSnapshot.currentItemId === taskId
      && lastSnapshot.initializingTaskItems.length === 0
      && lastSnapshot.terminalIds.includes(taskId)
      && lastSnapshot.terminalAttaches.some((frame) => frame.task_id === taskId)
      && daemonSessionIds.includes(taskId)
      && terminalText.includes("fake new task modal claude complete")
    ) {
      // KSP attachment is asynchronous. Observe the known PTY output first,
      // then leave time for a late attach failure/toast before taking the
      // assertion snapshot.
      await sleep(500);
      const settledSnapshot = await captureTaskHandoffSnapshot(client);
      const settledDaemonSessions = await tauriInvoke(client, "list_sessions");
      const settledDaemonSessionIds = Array.isArray(settledDaemonSessions)
        ? settledDaemonSessions
          .map((session) => session?.session_id ?? session?.sessionId)
          .filter((sessionId): sessionId is string => typeof sessionId === "string")
        : [];
      if (
        settledSnapshot.selectedItemId === taskId
        && settledSnapshot.currentItemId === taskId
        && settledSnapshot.initializingTaskItems.length === 0
        && settledSnapshot.terminalIds.includes(taskId)
        && settledDaemonSessionIds.includes(taskId)
      ) {
        return { ...settledSnapshot, daemonSessionIds: settledDaemonSessionIds };
      }
      lastSnapshot = settledSnapshot;
      lastDaemonSessions = settledDaemonSessions;
    }
    await sleep(100);
  }

  throw new Error(
    `timed out waiting for durable task handoff ${taskId}; `
    + `ui=${JSON.stringify(lastSnapshot)} daemon=${JSON.stringify(lastDaemonSessions)}`,
  );
}

function isTerminalSessionInvoke(command: string): boolean {
  return /(^|_)(session|terminal)($|_)/.test(command)
    || ["send_input", "resize_session", "signal_session", "kill_session"].includes(command);
}

function toastKey(toast: ToastSnapshot): string {
  return `${toast.kind}\u0000${toast.text}`;
}

function withoutBaselineToasts(
  current: ToastSnapshot[],
  baseline: ToastSnapshot[],
): ToastSnapshot[] {
  const baselineCounts = new Map<string, number>();
  for (const toast of baseline) {
    const key = toastKey(toast);
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
  }

  return current.filter((toast) => {
    const key = toastKey(toast);
    const remaining = baselineCounts.get(key) ?? 0;
    if (remaining === 0) return true;
    baselineCounts.set(key, remaining - 1);
    return false;
  });
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
        "case \"$*\" in",
        "  *--output-format*) ;;",
        "  *)",
        "    trap 'exit 0' HUP INT TERM",
        "    while :; do sleep 1; done",
        "    ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(join(fakeBinDir, "claude"), 0o755);
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
    expect(await waitForAgentChoiceLabel(client, "claude sdk")).toBe("claude sdk");

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
    expect(await waitForAgentChoiceLabel(client, "claude")).toBe("claude");
    await client.click(await client.waitForElement(".agent-provider", 2_000));
    expect(await agentChoiceLabel(client)).toBe("claude sdk");
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  });

  it("hands a modal-created PTY task from its initializer to only the durable terminal id", async () => {
    await resetDefaultAgentPreference(client);
    await openNewTaskModal(client);
    await cycleToAgentChoice(client, "claude");

    const baseline = await captureTaskHandoffSnapshot(client);
    await installTaskHandoffTrace(client);
    const prompt = `${TASK_HANDOFF_SENTINEL}: keep the fake Claude PTY alive during handoff`;

    try {
      await submitTaskFromModal(client, prompt, { waitForInitialization: false });
      const task = await waitForTaskCreated(client, prompt, 20_000);
      expect(task.id).not.toMatch(/^create:/);

      const handoff = await waitForDurableTaskHandoff(client, task.id, 30_000);
      expect(handoff.selectedItemId).toBe(task.id);
      expect(handoff.selectedItemIdForPersistence).toBe(task.id);
      expect(handoff.currentItemId).toBe(task.id);
      expect(handoff.initializingTaskItems).toEqual([]);

      const baselineTerminalIds = new Set(baseline.terminalIds);
      const newTerminalIds = [...new Set([
        ...handoff.terminalIds.filter((id) => !baselineTerminalIds.has(id)),
        ...handoff.observedTerminalIds,
      ])];
      expect(newTerminalIds).toContain(task.id);
      expect(newTerminalIds.filter((id) => id.startsWith("create:"))).toEqual([]);

      const terminalSessionInvokes = handoff.invokes.filter((call) => isTerminalSessionInvoke(call.cmd));
      expect(JSON.stringify(terminalSessionInvokes)).not.toContain("create:");
      expect(handoff.daemonSessionIds).toContain(task.id);
      expect(handoff.daemonSessionIds.filter((id) => id.startsWith("create:"))).toEqual([]);

      expect(handoff.terminalAttaches.length).toBeGreaterThan(0);
      expect(handoff.terminalAttaches.every((frame) => (
        frame.type === "attach"
        && frame.kind === "terminal"
        && frame.task_id === task.id
      ))).toBe(true);

      const newVisibleToasts = withoutBaselineToasts(handoff.toasts, baseline.toasts);
      const newToasts = [...handoff.observedToasts, ...newVisibleToasts];
      expect(newToasts.filter((toast) => (
        toast.kind === "warning"
        && toast.text.toLowerCase().includes("terminal session could not be reattached")
      ))).toEqual([]);
      expect(newToasts.filter((toast) => toast.kind === "error")).toEqual([]);
    } finally {
      await restoreTaskHandoffTrace(client);
    }
  }, 90_000);
});
