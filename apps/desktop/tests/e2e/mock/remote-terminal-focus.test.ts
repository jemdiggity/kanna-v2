import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import {
  cleanupWorktrees,
  importTestRepoDirect,
  resetDatabase,
} from "../helpers/reset";
import { execDb, tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

const localTaskId = "e2e-local-terminal-focus";
const remoteRepoId = "cloud:remote-terminal-focus-repo";
const remoteTaskId = "cloud:remote-terminal-focus-task";

function remoteSnapshot() {
  return {
    repos: [{
      id: remoteRepoId,
      path: "cloud",
      name: "Remote Terminal Focus",
      default_branch: "main",
      remote_url: "https://example.invalid/kanna/remote-terminal-focus.git",
      remote_url_hash: "remote-terminal-focus-hash",
      hidden: 0,
      sort_order: 1,
      created_at: "2026-09-03T00:00:00.000Z",
      last_opened_at: "2026-09-03T00:00:00.000Z",
    }],
    items: [{
      id: remoteTaskId,
      repo_id: remoteRepoId,
      prompt: "Remote terminal focus task",
      display_name: "Remote terminal focus task",
      pipeline: "default",
      pipeline_def: null,
      stage: "in progress",
      branch: "task-remote-terminal-focus",
      pr_number: null,
      pr_url: null,
      closed_at: null,
      agent_type: "pty",
      agent_provider: "codex",
      activity: "idle",
      activity_revision: 1,
      transition_revision: "run-remote-terminal-focus-1",
      activity_changed_at: "2026-09-03T00:00:00.000Z",
      unread_at: null,
      port_offset: null,
      port_env: null,
      pinned: 0,
      pin_order: null,
      base_ref: "origin/main",
      agent_session_id: null,
      teardown_started_at: null,
      parent_task_id: null,
      notify_task_id: null,
      notified_at: null,
      issue_number: null,
      issue_title: null,
      last_output_preview: null,
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z",
    }],
    terminalRefs: {
      [remoteTaskId]: {
        ownerDesktopId: "peer-terminal-focus",
        ownerLocalRepoId: "remote-terminal-focus-repo",
        ownerLocalTaskId: "remote-terminal-focus-task",
        transport: "cloud",
      },
    },
    blockedByTaskIds: {},
    transferMachines: [],
  };
}

async function waitForFocusedTerminal(
  client: WebDriverClient,
  selector: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown = null;
  while (Date.now() < deadline) {
    lastState = await client.executeSync<{
      activeClass: string | null;
      exists: boolean;
      focused: boolean;
    }>(
      `const target = document.querySelector(${JSON.stringify(selector)});
       return {
         activeClass: document.activeElement?.className ?? null,
         exists: target instanceof HTMLElement,
         focused: target instanceof HTMLElement && document.activeElement === target,
       };`,
    );
    if (
      typeof lastState === "object"
      && lastState !== null
      && "focused" in lastState
      && lastState.focused === true
    ) {
      return;
    }
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for ${selector} to receive focus; last state=${JSON.stringify(lastState)}`,
  );
}

describe("remote terminal focus", () => {
  const client = new WebDriverClient();
  let fixtureRepoPath = "";
  let localRepoId = "";
  let localSessionSpawned = false;

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoPath = await createFixtureRepo("remote-terminal-focus");
    localRepoId = await importTestRepoDirect(
      client,
      fixtureRepoPath,
      "Local Terminal Focus",
    );
    await execDb(
      client,
      `INSERT INTO pipeline_item (
         id, repo_id, prompt, pipeline, stage, branch,
         agent_type, agent_provider, activity, created_at, updated_at
       ) VALUES (?, ?, ?, 'default', 'in progress', NULL, 'pty', 'codex', 'idle', ?, ?)`,
      [
        localTaskId,
        localRepoId,
        "Local terminal focus task",
        "2026-09-03T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
      ],
    );
    await tauriInvoke(client, "spawn_session", {
      sessionId: localTaskId,
      cwd: fixtureRepoPath,
      executable: "/bin/cat",
      args: [],
      env: {},
      cols: 80,
      rows: 24,
      agentProvider: "codex",
    });
    localSessionSpawned = true;
    const setupResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(ctx.refreshAllItems())
         .then(function() {
           ctx.__e2eInjectRemoteSnapshot(
             "cloud",
             ${JSON.stringify(remoteSnapshot())},
           );
           cb("ok");
         })
         .catch(function(error) { cb("err:" + error); });`,
    );
    expect(setupResult).toBe("ok");
  });

  afterAll(async () => {
    if (localSessionSpawned) {
      await tauriInvoke(client, "kill_session", { sessionId: localTaskId }).catch(() => null);
    }
    if (fixtureRepoPath) {
      await cleanupWorktrees(client, fixtureRepoPath).catch(() => undefined);
      await cleanupFixtureRepos([fixtureRepoPath]);
    }
    await client.deleteSession();
  });

  it("focuses local and remote xterm inputs when their sidebar rows are selected", async () => {
    const localRowSelector = `.sidebar .workflow-item[data-task-id="${localTaskId}"]`;
    const remoteRowSelector = `.sidebar .workflow-item[data-task-id="${remoteTaskId}"]`;
    const localTextareaSelector = ".terminal-panel .xterm-helper-textarea";
    const remoteTextareaSelector = ".cloud-terminal-shell .xterm-helper-textarea";

    const initialRemoteRow = await client.waitForElement(remoteRowSelector, 5_000);
    await client.click(initialRemoteRow);
    await waitForFocusedTerminal(client, remoteTextareaSelector);

    const localRow = await client.waitForElement(localRowSelector, 5_000);
    await client.click(localRow);
    await client.waitForElement(`${localRowSelector}.selected`, 5_000);
    await waitForFocusedTerminal(client, localTextareaSelector);

    const remoteRow = await client.waitForElement(remoteRowSelector, 5_000);
    await client.click(remoteRow);
    await client.waitForElement(`${remoteRowSelector}.selected`, 5_000);
    await waitForFocusedTerminal(client, remoteTextareaSelector);

    // The mentioned-files control sat beside the companion control at
    // right: 138px; only the companion control is left on this shell.
    const controls = await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll(".cloud-terminal-shell > button"))
         .map(function(button) { return button.className; });`,
    );
    expect(controls).toEqual(["open-companion-control"]);

    const evidenceDir = process.env.KANNA_VISUAL_EVIDENCE_DIR;
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await client.screenshot(join(evidenceDir, "desktop-cloud-terminal-controls.png"));
    }
  });
});
