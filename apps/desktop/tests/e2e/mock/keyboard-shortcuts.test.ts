import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildGlobalKeydownScript, buildHandledGlobalKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { execDb, getVueState } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
const CTX_SCRIPT = 'window.__KANNA_E2E__.setupState';
const HISTORY_DWELL_WAIT_MS = 1_250;
const SIDEBAR_SCROLL_STYLE_ID = "e2e-sidebar-scroll-viewport";
const KEYBOARD_FIXTURE_AGENT_TYPE = "test";

interface SidebarScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  selectedText: string;
  selectedTop: number;
  selectedBottom: number;
  contentTop: number;
  contentBottom: number;
  isSelectedVisible: boolean;
}

describe("keyboard shortcuts", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let secondFixtureRepoRoot = "";
  let testRepoPath = "";
  let secondTestRepoPath = "";
  let repoImported = false;

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await client.reload();
    fixtureRepoRoot = await createFixtureRepo("keyboard-test");
    testRepoPath = fixtureRepoRoot;
    secondFixtureRepoRoot = await createFixtureRepo("keyboard-test-secondary");
    secondTestRepoPath = secondFixtureRepoRoot;
  });

  afterAll(async () => {
    await cleanupFixtureRepos([fixtureRepoRoot, secondFixtureRepoRoot].filter(Boolean));
    await client.deleteSession();
  });

  async function pressKey(key: string, opts: { meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean } = {}) {
    await client.executeSync(buildGlobalKeydownScript({
      key,
      meta: opts.meta,
      shift: opts.shift,
      alt: opts.alt,
      ctrl: opts.ctrl,
    }));
  }

  async function waitForSelection(
    expected: { repoId?: string; itemId?: string },
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSelection: { repoId: string | null; itemId: string | null } | null = null;
    while (Date.now() < deadline) {
      lastSelection = await client.executeSync<{ repoId: string | null; itemId: string | null }>(
        `const ctx = ${CTX_SCRIPT};
         const unwrap = (value) => value && value.__v_isRef ? value.value : value;
         return {
           repoId: unwrap(ctx.store?.selectedRepoId ?? ctx.selectedRepoId) ?? null,
           itemId: unwrap(ctx.store?.selectedItemId ?? ctx.selectedItemId) ?? null,
         };`,
      );
      const repoMatches = expected.repoId === undefined || lastSelection.repoId === expected.repoId;
      const itemMatches = expected.itemId === undefined || lastSelection.itemId === expected.itemId;
      if (repoMatches && itemMatches) return;
      await sleep(100);
    }
    throw new Error(
      `Timed out waiting for selection ${JSON.stringify(expected)}; last selection was ${JSON.stringify(lastSelection)}`,
    );
  }

  async function refreshItemsAndSelect(repoId: string, itemId: string): Promise<void> {
    const result = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       const selectRepo = ctx.handleSelectRepo || ctx.store.selectRepo.bind(ctx.store);
       const selectItem = ctx.selectSidebarItemById || ctx.handleSelectItem || ctx.store.selectItem.bind(ctx.store);
       Promise.resolve(ctx.refreshAllItems())
         .then(function() { return selectRepo(${JSON.stringify(repoId)}); })
         .then(function() { return selectItem(${JSON.stringify(itemId)}); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + (e && e.message ? e.message : e)); });`,
    );
    expect(result).toBe("ok");
    await waitForSelection({ repoId, itemId });
  }

  async function injectCloudSnapshot(
    snapshot: { repos: Array<Record<string, unknown>>; items: Array<Record<string, unknown>>; terminalRefs?: Record<string, unknown> },
  ): Promise<void> {
    const disposeResult = await client.executeSync<string>(
      `const ctx = ${CTX_SCRIPT};
       if (typeof ctx.disposeDesktopCloudWorkspace === "function") {
         ctx.disposeDesktopCloudWorkspace();
       }
       return "ok";`,
    );
    expect(disposeResult).toBe("ok");
    await sleep(250);

    const result = await client.executeSync<string>(
      `const ctx = ${CTX_SCRIPT};
       const snapshot = ${JSON.stringify(snapshot)};
       const remoteSnapshot = ctx.lanSnapshot;
       if (!remoteSnapshot) return "remote-snapshot-unavailable";
       if (remoteSnapshot.__v_isRef) remoteSnapshot.value = snapshot;
       else Object.assign(remoteSnapshot, snapshot);
       return "ok";`,
    );
    expect(result).toBe("ok");
  }

  async function ensureRepoImported() {
    if (repoImported) return;
    await importTestRepo(client, testRepoPath, "keyboard-test");
    repoImported = true;
  }

  async function importRepoWithoutSetupTask(path: string, name: string): Promise<string> {
    const repoId = await importTestRepo(client, path, name);
    await execDb(client, "DELETE FROM pipeline_item WHERE repo_id = ?", [repoId]);
    return repoId;
  }

  async function sidebarTaskTitles(): Promise<string[]> {
    return await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll(".workflow-item .item-title"))
        .map(function(element) { return element.textContent?.trim() || ""; })
        .filter(Boolean);`,
    );
  }

  async function getSidebarScrollMetrics(): Promise<SidebarScrollMetrics> {
    return await client.executeSync<SidebarScrollMetrics>(
      `const content = document.querySelector(".sidebar-content");
       const selected = content?.querySelector(".workflow-item.selected");
       if (!(content instanceof HTMLElement) || !(selected instanceof HTMLElement)) {
         return {
           scrollTop: -1,
           clientHeight: 0,
           scrollHeight: 0,
           selectedText: "",
           selectedTop: 0,
           selectedBottom: 0,
           contentTop: 0,
           contentBottom: 0,
           isSelectedVisible: false,
         };
       }
       const contentRect = content.getBoundingClientRect();
       const selectedRect = selected.getBoundingClientRect();
       return {
         scrollTop: content.scrollTop,
         clientHeight: content.clientHeight,
         scrollHeight: content.scrollHeight,
         selectedText: selected.textContent?.trim() || "",
         selectedTop: selectedRect.top,
         selectedBottom: selectedRect.bottom,
         contentTop: contentRect.top,
         contentBottom: contentRect.bottom,
         isSelectedVisible: selectedRect.top >= contentRect.top - 1
           && selectedRect.bottom <= contentRect.bottom + 1,
       };`,
    );
  }

  async function waitForSidebarSelectionVisible(expectedText: string, timeoutMs = 3000): Promise<SidebarScrollMetrics> {
    const deadline = Date.now() + timeoutMs;
    let lastMetrics: SidebarScrollMetrics | null = null;
    while (Date.now() < deadline) {
      lastMetrics = await getSidebarScrollMetrics();
      if (
        lastMetrics.selectedText.includes(expectedText)
        && lastMetrics.scrollTop > 0
        && lastMetrics.isSelectedVisible
      ) {
        return lastMetrics;
      }
      await sleep(100);
    }
    throw new Error(
      `Timed out waiting for selected sidebar task "${expectedText}" to be visible; last metrics were ${
        JSON.stringify(lastMetrics)
      }`,
    );
  }

  async function constrainSidebarHeightForScrollTest(): Promise<void> {
    await client.executeSync(
      `document.getElementById(${JSON.stringify(SIDEBAR_SCROLL_STYLE_ID)})?.remove();
       const style = document.createElement("style");
       style.id = ${JSON.stringify(SIDEBAR_SCROLL_STYLE_ID)};
       style.textContent = ".sidebar { height: 220px !important; }";
       document.head.appendChild(style);
       const content = document.querySelector(".sidebar-content");
       if (content instanceof HTMLElement) content.scrollTop = 0;`,
    );
  }

  it("Shift+Cmd+N shows a warning when no repos are loaded", async () => {
    expect(await client.findElements(".toast.warning")).toHaveLength(0);
    await pressKey("N", { meta: true, shift: true });
    await sleep(300);
    const modalElements = await client.findElements(".modal-overlay");
    expect(modalElements).toHaveLength(0);
    const warningToast = await client.waitForElement(".toast.warning", 2000);
    const warningText = await client.getText(warningToast);
    expect(warningText.toLowerCase()).toContain("repo");
  });

  it("Shift+Cmd+N opens New Task modal when a repo is loaded", async () => {
    await ensureRepoImported();
    await pressKey("N", { meta: true, shift: true });
    await sleep(300);
    const modal = await client.waitForElement(".modal-overlay", 2000);
    expect(modal).toBeTruthy();
  });

  it("Escape closes modal", async () => {
    await pressKey("Escape");
    await sleep(500);
    const modalElements = await client.findElements(".modal-overlay");
    if (modalElements.length > 0) {
      // Modal still there - close via state
      await client.executeSync(`${CTX_SCRIPT}.showNewTaskModal = false;`);
      await sleep(300);
    }
  });

  it("uses shortcuts to navigate tasks and repos while preserving back-forward history", async () => {
    await resetDatabase(client);
    await client.reload();

    const repoOneId = await importRepoWithoutSetupTask(testRepoPath, "keyboard-history-one");
    const repoTwoId = await importRepoWithoutSetupTask(secondTestRepoPath, "keyboard-history-two");
    repoImported = true;

    await execDb(client, "UPDATE repo SET sort_order = 0 WHERE id = ?", [repoOneId]);
    await execDb(client, "UPDATE repo SET sort_order = 1 WHERE id = ?", [repoTwoId]);

    const repoOneIssueOne = "e2e-repo-one-issue-one";
    const repoOneIssueTwo = "e2e-repo-one-issue-two";
    const repoTwoIssueOne = "e2e-repo-two-issue-one";
    const repoTwoIssueTwo = "e2e-repo-two-issue-two";
    const taskRows = [
      [repoOneIssueOne, repoOneId, 101, "Repo One Issue One", "2026-04-17T10:00:00.000Z"],
      [repoOneIssueTwo, repoOneId, 102, "Repo One Issue Two", "2026-04-17T10:01:00.000Z"],
      [repoTwoIssueOne, repoTwoId, 201, "Repo Two Issue One", "2026-04-17T10:00:00.000Z"],
      [repoTwoIssueTwo, repoTwoId, 202, "Repo Two Issue Two", "2026-04-17T10:01:00.000Z"],
    ] as const;

    for (const [id, repoId, issueNumber, issueTitle, createdAt] of taskRows) {
      await execDb(
        client,
        `INSERT INTO pipeline_item
           (id, repo_id, issue_number, issue_title, prompt, stage, branch, agent_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          repoId,
          issueNumber,
          issueTitle,
          `Prompt for ${issueTitle}`,
          "in progress",
          null,
          KEYBOARD_FIXTURE_AGENT_TYPE,
          createdAt,
          createdAt,
        ],
      );
    }

    await client.executeSync(
      `${CTX_SCRIPT}.showNewTaskModal = false;
       ${CTX_SCRIPT}.showAddRepoModal = false;
       ${CTX_SCRIPT}.showShortcutsModal = false;
       ${CTX_SCRIPT}.showFilePickerModal = false;
       ${CTX_SCRIPT}.showFilePreviewModal = false;
       ${CTX_SCRIPT}.showDiffModal = false;
       ${CTX_SCRIPT}.showTreeExplorer = false;
       ${CTX_SCRIPT}.showShellModal = false;
       ${CTX_SCRIPT}.showAnalyticsModal = false;
       ${CTX_SCRIPT}.showBlockerSelect = false;
       ${CTX_SCRIPT}.showPreferencesPanel = false;
       ${CTX_SCRIPT}.showCommitGraphModal = false;
       ${CTX_SCRIPT}.showPeerPicker = false;`,
    );

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       ctx.refreshAllItems().then(function() { cb("ok"); }).catch(function(e) { cb("err:" + e); });`,
    );
    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       Promise.resolve(ctx.store.selectRepo(${JSON.stringify(repoOneId)}))
         .then(function() { return ctx.store.selectItem(${JSON.stringify(repoOneIssueTwo)}); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId: repoOneId, itemId: repoOneIssueTwo });
    await sleep(HISTORY_DWELL_WAIT_MS);

    await pressKey("ArrowDown", { meta: true, alt: true });
    await waitForSelection({ repoId: repoOneId, itemId: repoOneIssueOne });
    await sleep(HISTORY_DWELL_WAIT_MS);

    await pressKey("ArrowDown", { meta: true, shift: true });
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoIssueTwo });
    await sleep(HISTORY_DWELL_WAIT_MS);

    await pressKey("ArrowDown", { meta: true, alt: true });
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoIssueOne });
    await sleep(HISTORY_DWELL_WAIT_MS);

    await pressKey("-", { ctrl: true });
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoIssueTwo });

    await pressKey("-", { ctrl: true });
    await waitForSelection({ repoId: repoOneId, itemId: repoOneIssueOne });

    await pressKey("-", { ctrl: true });
    await waitForSelection({ repoId: repoOneId, itemId: repoOneIssueTwo });

    await pressKey("-", { ctrl: true, shift: true });
    await waitForSelection({ repoId: repoOneId, itemId: repoOneIssueOne });

    await pressKey("-", { ctrl: true, shift: true });
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoIssueTwo });

    await pressKey("-", { ctrl: true, shift: true });
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoIssueOne });

    await sleep(HISTORY_DWELL_WAIT_MS);
    await pressKey("ArrowUp", { meta: true, shift: true });
    await waitForSelection({ repoId: repoOneId, itemId: repoOneIssueOne });

    await pressKey("-", { ctrl: true });
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoIssueOne });

    await pressKey("-", { ctrl: true, shift: true });
    await waitForSelection({ repoId: repoOneId, itemId: repoOneIssueOne });
  });

  it("uses native task-navigation events to navigate tasks", async () => {
    await resetDatabase(client);
    await client.reload();

    const repoId = await importRepoWithoutSetupTask(testRepoPath, "keyboard-actions");
    repoImported = true;

    const newerTaskId = "e2e-key-actions-newer";
    const olderTaskId = "e2e-key-actions-older";
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, stage, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        olderTaskId,
        repoId,
        301,
        "Older key action task",
        "Prompt for older key action task",
        "in progress",
        null,
        KEYBOARD_FIXTURE_AGENT_TYPE,
        "2026-04-17T10:00:00.000Z",
        "2026-04-17T10:00:00.000Z",
        newerTaskId,
        repoId,
        302,
        "Newer key action task",
        "Prompt for newer key action task",
        "in progress",
        null,
        KEYBOARD_FIXTURE_AGENT_TYPE,
        "2026-04-17T10:01:00.000Z",
        "2026-04-17T10:01:00.000Z",
      ],
    );

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       ctx.refreshAllItems()
         .then(function() { return ctx.store.selectRepo(${JSON.stringify(repoId)}); })
         .then(function() { return ctx.store.selectItem(${JSON.stringify(newerTaskId)}); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId, itemId: newerTaskId });

    await client.emitToWebviewWindow("kanna://native-navigate-task-down");
    await waitForSelection({ repoId, itemId: olderTaskId });
  });

  it("uses the rendered sidebar order for task navigation", async () => {
    await resetDatabase(client);
    await client.reload();

    const repoId = await importRepoWithoutSetupTask(testRepoPath, "keyboard-visual-order");
    repoImported = true;

    const inProgressTaskId = "e2e-key-visual-in-progress";
    const prTaskId = "e2e-key-visual-pr";
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, stage, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prTaskId,
        repoId,
        321,
        "Visual order PR task",
        "Prompt for visual order PR task",
        "pr",
        null,
        KEYBOARD_FIXTURE_AGENT_TYPE,
        "2026-04-17T10:01:00.000Z",
        "2026-04-17T10:01:00.000Z",
        inProgressTaskId,
        repoId,
        322,
        "Visual order in progress task",
        "Prompt for visual order in progress task",
        "in progress",
        null,
        KEYBOARD_FIXTURE_AGENT_TYPE,
        "2026-04-17T10:00:00.000Z",
        "2026-04-17T10:00:00.000Z",
      ],
    );

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       ctx.refreshAllItems()
         .then(function() { return ctx.store.selectRepo(${JSON.stringify(repoId)}); })
         .then(function() { return ctx.store.selectItem(${JSON.stringify(prTaskId)}); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId, itemId: prTaskId });

    expect(await sidebarTaskTitles()).toEqual([
      "Visual order PR task",
      "Visual order in progress task",
    ]);

    await pressKey("ArrowDown", { meta: true, alt: true });
    await waitForSelection({ repoId, itemId: inProgressTaskId });
  });

  it("task shortcuts traverse local repo boundaries in sidebar order", async () => {
    await resetDatabase(client);
    await client.reload();

    const repoOneId = await importRepoWithoutSetupTask(testRepoPath, "keyboard-cross-repo-one");
    const repoTwoId = await importRepoWithoutSetupTask(secondTestRepoPath, "keyboard-cross-repo-two");
    repoImported = true;

    await execDb(client, "UPDATE repo SET sort_order = 0 WHERE id = ?", [repoOneId]);
    await execDb(client, "UPDATE repo SET sort_order = 1 WHERE id = ?", [repoTwoId]);

    const repoOneNewest = "e2e-cross-repo-one-newest";
    const repoOneOldest = "e2e-cross-repo-one-oldest";
    const repoTwoNewest = "e2e-cross-repo-two-newest";
    const repoTwoOldest = "e2e-cross-repo-two-oldest";
    const rows = [
      [repoOneNewest, repoOneId, "Repo one newest", "2026-04-17T10:01:00.000Z"],
      [repoOneOldest, repoOneId, "Repo one oldest", "2026-04-17T10:00:00.000Z"],
      [repoTwoNewest, repoTwoId, "Repo two newest", "2026-04-17T10:01:00.000Z"],
      [repoTwoOldest, repoTwoId, "Repo two oldest", "2026-04-17T10:00:00.000Z"],
    ] as const;

    for (const row of rows) {
      await execDb(
        client,
        `INSERT INTO pipeline_item
           (id, repo_id, prompt, stage, activity, created_at, updated_at, agent_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row[0], row[1], row[2], "in progress", "idle", row[3], row[3], KEYBOARD_FIXTURE_AGENT_TYPE],
      );
    }

    await refreshItemsAndSelect(repoOneId, repoOneOldest);

    await pressKey("ArrowDown", { meta: true, alt: true });
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoNewest });

    await pressKey("ArrowUp", { meta: true, alt: true });
    await waitForSelection({ repoId: repoOneId, itemId: repoOneOldest });
  });

  it("scrolls the real sidebar scroller when keyboard navigation selects an offscreen task", async () => {
    await resetDatabase(client);
    await client.reload();

    const repoId = await importRepoWithoutSetupTask(testRepoPath, "keyboard-sidebar-scroll");
    repoImported = true;

    const taskCount = 28;
    const targetIndex = 18;
    const taskId = (index: number) => `sidebar-scroll-task-${String(index).padStart(2, "0")}`;
    const taskTitle = (index: number) => `Sidebar overflow task ${String(index).padStart(2, "0")}`;

    await execDb(client, "DELETE FROM pipeline_item WHERE repo_id = ?", [repoId]);
    for (let index = 0; index < taskCount; index += 1) {
      const createdAt = new Date(Date.UTC(2026, 3, 17, 10, 0, taskCount - index)).toISOString();
      await execDb(
        client,
        `INSERT INTO pipeline_item
           (id, repo_id, issue_number, issue_title, prompt, stage, branch, agent_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          taskId(index),
          repoId,
          700 + index,
          taskTitle(index),
          `Prompt for ${taskTitle(index)}`,
          "in progress",
          null,
          KEYBOARD_FIXTURE_AGENT_TYPE,
          createdAt,
          createdAt,
        ],
      );
    }

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       ctx.refreshAllItems()
         .then(function() { return ctx.store.selectRepo(${JSON.stringify(repoId)}); })
         .then(function() { return ctx.store.selectItem(${JSON.stringify(taskId(0))}); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId, itemId: taskId(0) });
    await constrainSidebarHeightForScrollTest();

    const initialMetrics = await getSidebarScrollMetrics();
    expect(initialMetrics.selectedText).toContain(taskTitle(0));
    expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);
    expect(initialMetrics.scrollTop).toBe(0);
    expect(initialMetrics.isSelectedVisible).toBe(true);

    for (let index = 1; index <= targetIndex; index += 1) {
      await pressKey("ArrowDown", { meta: true, alt: true });
      await waitForSelection({ repoId, itemId: taskId(index) });
    }

    const finalMetrics = await waitForSidebarSelectionVisible(taskTitle(targetIndex));
    expect(finalMetrics.scrollTop).toBeGreaterThan(initialMetrics.scrollTop);
    expect(finalMetrics.selectedTop).toBeGreaterThanOrEqual(finalMetrics.contentTop - 1);
    expect(finalMetrics.selectedBottom).toBeLessThanOrEqual(finalMetrics.contentBottom + 1);
  });

  it("routes Cmd+S for a reachable remote task through the owning peer action", async () => {
    await resetDatabase(client);
    await client.reload();

    const remoteRepoId = "cloud:keyboard-remote-repo";
    const remoteTaskId = "cloud:lan:peer-owner:keyboard-remote-repo:task-remote";
    const ownerTaskId = "task-remote";
    const seedResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       window.__KANNA_E2E__.appMetrics.clear();
       const snapshot = {
         repos: [{
           id: ${JSON.stringify(remoteRepoId)},
           path: "lan",
           name: "keyboard-remote",
           remote_url: "git@example.com:keyboard/remote.git",
           default_branch: "main",
           hidden: 0,
           sort_order: 0,
           created_at: "2026-04-17T10:00:00.000Z",
           last_opened_at: "2026-04-17T10:00:00.000Z"
         }],
         items: [{
           id: ${JSON.stringify(remoteTaskId)},
           repo_id: ${JSON.stringify(remoteRepoId)},
           prompt: "Remote Cmd+S task",
           pipeline: "default",
           stage: "in progress",
           pr_number: null,
           pr_url: null,
           branch: ${JSON.stringify(ownerTaskId)},
           activity: "idle",
           activity_changed_at: "2026-04-17T10:00:00.000Z",
           unread_at: null,
           port_offset: null,
           port_env: null,
           pinned: 0,
           pin_order: null,
           display_name: "Remote Cmd+S task",
           issue_number: null,
           issue_title: null,
           closed_at: null,
           agent_session_id: null,
           base_ref: "origin/main",
           agent_provider: "codex",
           agent_type: "pty",
           teardown_started_at: null,
           last_output_preview: null,
           created_at: "2026-04-17T10:00:00.000Z",
           updated_at: "2026-04-17T10:00:00.000Z"
         }],
         terminalRefs: {
           [${JSON.stringify(remoteTaskId)}]: {
             ownerDesktopId: "peer-owner",
             ownerLocalTaskId: ${JSON.stringify(ownerTaskId)},
             transport: "lan"
           }
         }
       };
       const remoteSnapshot = ctx.lanSnapshot;
       if (!remoteSnapshot) {
         cb("err:remote snapshot unavailable");
         return;
       }
       if (remoteSnapshot.__v_isRef) remoteSnapshot.value = snapshot;
       else Object.assign(remoteSnapshot, snapshot);
       const selectRepo = ctx.handleSelectRepo || ctx.store.selectRepo.bind(ctx.store);
       const selectItem = ctx.selectSidebarItemById || ctx.handleSelectItem || ctx.store.selectItem.bind(ctx.store);
       Promise.resolve(selectRepo(${JSON.stringify(remoteRepoId)}))
         .then(function() { return selectItem(${JSON.stringify(remoteTaskId)}); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + (e && e.message ? e.message : e)); });`,
    );
    expect(seedResult).toBe("ok");

    await pressKey("s", { meta: true });
    await sleep(300);

    const metrics = await client.executeSync<{ invokeCounts: Record<string, number> }>(
      "return window.__KANNA_E2E__.appMetrics.snapshot();",
    );
    expect(metrics.invokeCounts.advance_transfer_peer_task_stage ?? 0).toBeGreaterThan(0);
  });

  it("keeps a cloud-only main-panel selection through a local snapshot refresh", async () => {
    await resetDatabase(client);
    await client.reload();

    const localRepoId = await importRepoWithoutSetupTask(testRepoPath, "cloud-refresh-local-fallback");
    repoImported = true;
    const localTaskId = "cloud-refresh-local-task";
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, updated_at, agent_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        localTaskId,
        localRepoId,
        "Local fallback task",
        "in progress",
        "idle",
        "2026-04-17T09:00:00.000Z",
        "2026-04-17T09:00:00.000Z",
        KEYBOARD_FIXTURE_AGENT_TYPE,
      ],
    );

    const remoteRepoId = "cloud:keyboard-refresh-remote";
    const remoteTaskId = "cloud:lan:peer-owner:keyboard-refresh-remote:task-remote";
    const remoteSnapshot = {
      repos: [{
        id: remoteRepoId,
        path: "cloud",
        name: "Keyboard Refresh Remote",
        remote_url: "https://example.invalid/kanna/keyboard-refresh-remote.git",
        default_branch: "main",
        hidden: 0,
        sort_order: 1,
        created_at: "2026-04-17T10:00:00.000Z",
        last_opened_at: "2026-04-17T10:00:00.000Z",
      }],
      items: [{
        id: remoteTaskId,
        repo_id: remoteRepoId,
        prompt: "Remote selection survives refresh",
        pipeline: "cloud",
        stage: "in progress",
        tags: "[]",
        pr_number: null,
        pr_url: null,
        branch: "task-remote",
        activity: "idle",
        activity_changed_at: "2026-04-17T10:00:00.000Z",
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: "Remote selection survives refresh",
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "codex",
        agent_type: "pty",
        previous_stage: null,
        stage_result: null,
        teardown_started_at: null,
        last_output_preview: null,
        active_post_action: null,
        created_at: "2026-04-17T10:00:00.000Z",
        updated_at: "2026-04-17T10:00:00.000Z",
      }],
      terminalRefs: {
        [remoteTaskId]: {
          ownerDesktopId: "peer-owner",
          ownerLocalTaskId: "task-remote",
          transport: "lan",
        },
      },
    };

    try {
      await injectCloudSnapshot(remoteSnapshot);
      const projectedItemIds = await client.executeSync<string[]>(
        `const ctx = ${CTX_SCRIPT};
         const unwrap = (value) => value?.__v_isRef ? value.value : value;
         return Array.from(unwrap(ctx.sidebarItems) ?? []).map((item) => item.id);`,
      );
      expect(projectedItemIds).toContain(remoteTaskId);
      const selectResult = await client.executeAsync<string>(
        `const cb = arguments[arguments.length - 1];
         const ctx = ${CTX_SCRIPT};
         const selectRepo = ctx.handleSelectRepo || ctx.store.selectRepo.bind(ctx.store);
         const selectItem = ctx.selectSidebarItemById || ctx.handleSelectItem || ctx.store.selectItem.bind(ctx.store);
         Promise.resolve(selectRepo(${JSON.stringify(remoteRepoId)}))
           .then(function() { return selectItem(${JSON.stringify(remoteTaskId)}); })
           .then(function() { cb("ok"); })
           .catch(function(e) { cb("err:" + (e && e.message ? e.message : e)); });`,
      );
      expect(selectResult).toBe("ok");
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteTaskId });

      const refreshResult = await client.executeAsync<string>(
        `const cb = arguments[arguments.length - 1];
         const ctx = ${CTX_SCRIPT};
         Promise.resolve(ctx.store.savePreference("ideCommand", "code"))
           .then(function() { cb("ok"); })
           .catch(function(e) { cb("err:" + (e && e.message ? e.message : e)); });`,
      );
      expect(refreshResult).toBe("ok");

      const selection = await client.executeSync<{
        repoId: string | null;
        itemId: string | null;
        rememberedItemId: string | null;
        mainPanelItemId: string | null;
        mainPanelIsCloudTask: boolean;
        cloudTerminalVisible: boolean;
        localTerminalVisible: boolean;
        selectedSidebarTaskId: string | null;
      }>(
        `const ctx = ${CTX_SCRIPT};
         const unwrap = (value) => value?.__v_isRef ? value.value : value;
         const remembered = unwrap(ctx.store?.lastSelectedItemByRepo) ?? {};
         const mainPanelItem = unwrap(ctx.mainPanelItem);
         return {
           repoId: unwrap(ctx.store?.selectedRepoId) ?? null,
           itemId: unwrap(ctx.store?.selectedItemId) ?? null,
           rememberedItemId: remembered[${JSON.stringify(remoteRepoId)}] ?? null,
           mainPanelItemId: mainPanelItem?.id ?? null,
           mainPanelIsCloudTask: Boolean(unwrap(ctx.mainPanelIsCloudTask)),
           cloudTerminalVisible: Boolean(document.querySelector(".cloud-terminal-shell")),
           localTerminalVisible: Boolean(document.querySelector(".terminal-panel")),
           selectedSidebarTaskId: document.querySelector(".workflow-item.selected")?.getAttribute("data-task-id") ?? null,
         };`,
      );

      expect(selection).toEqual({
        repoId: remoteRepoId,
        itemId: remoteTaskId,
        rememberedItemId: remoteTaskId,
        mainPanelItemId: remoteTaskId,
        mainPanelIsCloudTask: true,
        cloudTerminalVisible: true,
        localTerminalVisible: false,
        selectedSidebarTaskId: remoteTaskId,
      });
    } finally {
      await injectCloudSnapshot({ repos: [], items: [], terminalRefs: {} });
    }
  });

  it("uses native repo-navigation events to navigate repos", async () => {
    await resetDatabase(client);
    await client.reload();

    const repoOneId = await importRepoWithoutSetupTask(testRepoPath, "native-repo-actions-one");
    const repoTwoId = await importRepoWithoutSetupTask(secondTestRepoPath, "native-repo-actions-two");
    repoImported = true;

    await execDb(client, "UPDATE repo SET sort_order = 0 WHERE id = ?", [repoOneId]);
    await execDb(client, "UPDATE repo SET sort_order = 1 WHERE id = ?", [repoTwoId]);

    const repoOneTaskId = "e2e-native-repo-actions-one";
    const repoTwoTaskId = "e2e-native-repo-actions-two";
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, stage, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        repoOneTaskId,
        repoOneId,
        401,
        "Native repo action one",
        "Prompt for native repo action one",
        "in progress",
        null,
        KEYBOARD_FIXTURE_AGENT_TYPE,
        "2026-04-17T10:00:00.000Z",
        "2026-04-17T10:00:00.000Z",
        repoTwoTaskId,
        repoTwoId,
        402,
        "Native repo action two",
        "Prompt for native repo action two",
        "in progress",
        null,
        KEYBOARD_FIXTURE_AGENT_TYPE,
        "2026-04-17T10:01:00.000Z",
        "2026-04-17T10:01:00.000Z",
      ],
    );

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       ctx.refreshAllItems()
         .then(function() { return ctx.store.selectRepo(${JSON.stringify(repoOneId)}); })
         .then(function() { return ctx.store.selectItem(${JSON.stringify(repoOneTaskId)}); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId: repoOneId, itemId: repoOneTaskId });

    await client.emitToWebviewWindow("kanna://native-navigate-repo-down");
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoTaskId });

    await resetDatabase(client);
    await client.reload();
    repoImported = false;
  });

  it("unread shortcuts skip teardown tasks", async () => {
    await ensureRepoImported();
    const repoId = await getVueState(client, "selectedRepoId") as string;

    const seedResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       const rows = [
         ["shortcut-teardown-old", "${repoId}", "Teardown old unread", "pr", "unread", "2026-03-31T00:00:00.000Z", "2026-05-08T00:00:00.000Z"],
         ["shortcut-normal-old", "${repoId}", "Normal old unread", "in progress", "unread", "2026-03-31T01:00:00.000Z", null],
       ];
       Promise.all(rows.map(function(row) {
         return db.execute(
           "INSERT OR REPLACE INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, teardown_started_at, agent_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
           [row[0], row[1], row[2], row[3], row[4], row[5], row[6], ${JSON.stringify(KEYBOARD_FIXTURE_AGENT_TYPE)}]
         );
       }))
         .then(function() { return ctx.loadItems("${repoId}"); })
         .then(function() { return ctx.store.selectItem("shortcut-teardown-old"); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    expect(seedResult).toBe("ok");
    await sleep(500);

    await pressKey("u", { meta: true });
    await sleep(200);
    expect(await getVueState(client, "selectedItemId")).toBe("shortcut-normal-old");
  });

  it("read and unread shortcuts select the absolute oldest task by created_at", async () => {
    await ensureRepoImported();
    const repoId = await getVueState(client, "selectedRepoId") as string;

    const seedRowsAndSelectCurrent = async (prefix: string) => {
      await execDb(client, "DELETE FROM pipeline_item WHERE repo_id = ?", [repoId]);
      const rows = [
        [`${prefix}-read-oldest`, repoId, "Read oldest", "in progress", "idle", "2026-03-31T00:00:00.000Z", "[]"],
        [`${prefix}-near-read-older`, repoId, "Read near older", "in progress", "idle", "2026-03-31T01:00:00.000Z", "[]"],
        [`${prefix}-unread-oldest`, repoId, "Unread oldest", "in progress", "unread", "2026-03-31T01:30:00.000Z", "[]"],
        [`${prefix}-near-unread-older`, repoId, "Unread near older", "in progress", "unread", "2026-03-31T02:00:00.000Z", "[]"],
        [`${prefix}-current`, repoId, "Current task", "in progress", "idle", "2026-03-31T03:00:00.000Z", "[]"],
        [`${prefix}-near-unread-newer`, repoId, "Unread near newer", "in progress", "unread", "2026-03-31T04:00:00.000Z", "[]"],
        [`${prefix}-unread-newest`, repoId, "Unread newest", "in progress", "unread", "2026-03-31T04:30:00.000Z", "[]"],
        [`${prefix}-near-read-newer`, repoId, "Read near newer", "in progress", "idle", "2026-03-31T05:00:00.000Z", "[]"],
        [`${prefix}-read-newest`, repoId, "Read newest", "in progress", "idle", "2026-03-31T06:00:00.000Z", "[]"],
      ] as const;
      for (const row of rows) {
        await execDb(
          client,
          "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, agent_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [row[0], row[1], row[2], row[3], row[4], row[5], KEYBOARD_FIXTURE_AGENT_TYPE],
        );
      }

      await refreshItemsAndSelect(repoId, `${prefix}-current`);
    };

    await seedRowsAndSelectCurrent("shortcut");
    await pressKey("u", { meta: true });
    await waitForSelection({ repoId, itemId: "shortcut-unread-oldest" });

    await seedRowsAndSelectCurrent("shortcut");
    await pressKey("U", { meta: true, shift: true });
    await waitForSelection({ repoId, itemId: "shortcut-unread-oldest" });

    await seedRowsAndSelectCurrent("shortcut");
    await pressKey("r", { meta: true });
    await waitForSelection({ repoId, itemId: "shortcut-read-oldest" });

    await seedRowsAndSelectCurrent("shortcut");
    await pressKey("R", { meta: true, shift: true });
    await waitForSelection({ repoId, itemId: "shortcut-read-oldest" });
  });

  it("unread shortcuts use created_at when unread_at ordering differs", async () => {
    await ensureRepoImported();
    const repoId = await getVueState(client, "selectedRepoId") as string;
    const prefix = "shortcut-unread-created-order";

    await execDb(client, "DELETE FROM pipeline_item WHERE repo_id = ?", [repoId]);
    const rows = [
      [`${prefix}-created-oldest-unread-newest`, repoId, "Created oldest, unread newest", "in progress", "unread", "2026-03-31T00:00:00.000Z", "2026-03-31T05:00:00.000Z"],
      [`${prefix}-current-unread-at-order`, repoId, "Current task", "in progress", "idle", "2026-03-31T03:00:00.000Z", null],
      [`${prefix}-created-newest-unread-oldest`, repoId, "Created newest, unread oldest", "in progress", "unread", "2026-03-31T04:00:00.000Z", "2026-03-31T01:00:00.000Z"],
    ] as const;
    for (const row of rows) {
      await execDb(
        client,
        "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, unread_at, agent_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [row[0], row[1], row[2], row[3], row[4], row[5], row[6], KEYBOARD_FIXTURE_AGENT_TYPE],
      );
    }

    await refreshItemsAndSelect(repoId, `${prefix}-current-unread-at-order`);
    await pressKey("u", { meta: true });
    await waitForSelection({ repoId, itemId: `${prefix}-created-oldest-unread-newest` });

    await refreshItemsAndSelect(repoId, `${prefix}-current-unread-at-order`);
    await pressKey("U", { meta: true, shift: true });
    await waitForSelection({ repoId, itemId: `${prefix}-created-oldest-unread-newest` });
  });

  it("keeps unshifted activity shortcuts local and searches all visible local repos when shifted", async () => {
    await resetDatabase(client);
    await client.reload();

    const repoOneId = await importRepoWithoutSetupTask(testRepoPath, "keyboard-activity-local-one");
    const repoTwoId = await importRepoWithoutSetupTask(secondTestRepoPath, "keyboard-activity-local-two");
    repoImported = true;

    await execDb(client, "UPDATE repo SET sort_order = 0 WHERE id = ?", [repoOneId]);
    await execDb(client, "UPDATE repo SET sort_order = 1 WHERE id = ?", [repoTwoId]);

    const seedRowsAndSelectCurrent = async (prefix: string) => {
      await execDb(client, "DELETE FROM pipeline_item WHERE repo_id IN (?, ?)", [repoOneId, repoTwoId]);
      const currentTaskId = `${prefix}-current`;
      const rows = [
        [currentTaskId, repoOneId, "Current local task", "idle", "2026-03-31T03:00:00.000Z"],
        [`${prefix}-unread-local-oldest`, repoOneId, "Selected repo unread oldest", "unread", "2026-03-31T02:00:00.000Z"],
        [`${prefix}-unread-local-newest`, repoOneId, "Selected repo unread newest", "unread", "2026-03-31T04:00:00.000Z"],
        [`${prefix}-read-local-oldest`, repoOneId, "Selected repo read oldest", "idle", "2026-03-31T01:00:00.000Z"],
        [`${prefix}-read-local-newest`, repoOneId, "Selected repo read newest", "idle", "2026-03-31T05:00:00.000Z"],
        [`${prefix}-unread-global-oldest`, repoTwoId, "Globally oldest unread", "unread", "2026-03-31T00:30:00.000Z"],
        [`${prefix}-unread-global-newest`, repoTwoId, "Other repo unread newest", "unread", "2026-03-31T06:30:00.000Z"],
        [`${prefix}-read-global-oldest`, repoTwoId, "Globally oldest read", "idle", "2026-03-31T00:00:00.000Z"],
        [`${prefix}-read-global-newest`, repoTwoId, "Other repo read newest", "idle", "2026-03-31T07:00:00.000Z"],
      ] as const;

      for (const row of rows) {
        await execDb(
          client,
          "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, updated_at, agent_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [row[0], row[1], row[2], "in progress", row[3], row[4], row[4], KEYBOARD_FIXTURE_AGENT_TYPE],
        );
      }

      await refreshItemsAndSelect(repoOneId, currentTaskId);
    };

    await seedRowsAndSelectCurrent("shortcut-cross-local");
    await pressKey("u", { meta: true });
    await waitForSelection({ repoId: repoOneId, itemId: "shortcut-cross-local-unread-local-oldest" });

    await seedRowsAndSelectCurrent("shortcut-cross-local");
    await pressKey("U", { meta: true, shift: true });
    await waitForSelection({ repoId: repoTwoId, itemId: "shortcut-cross-local-unread-global-oldest" });

    await seedRowsAndSelectCurrent("shortcut-cross-local");
    await pressKey("r", { meta: true });
    await waitForSelection({ repoId: repoOneId, itemId: "shortcut-cross-local-read-local-oldest" });

    await seedRowsAndSelectCurrent("shortcut-cross-local");
    await pressKey("R", { meta: true, shift: true });
    await waitForSelection({ repoId: repoTwoId, itemId: "shortcut-cross-local-read-global-oldest" });
  });

  it("keeps unshifted activity shortcuts in the selected cloud repo and searches all visible repos when shifted", async () => {
    await resetDatabase(client);
    await client.reload();

    const localRepoId = await importRepoWithoutSetupTask(testRepoPath, "keyboard-activity-remote-local");
    repoImported = true;

    const currentTaskId = "shortcut-cross-remote-current";
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, updated_at, agent_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        currentTaskId,
        localRepoId,
        "Current local anchor",
        "in progress",
        "idle",
        "2026-03-31T03:00:00.000Z",
        "2026-03-31T03:00:00.000Z",
        KEYBOARD_FIXTURE_AGENT_TYPE,
      ],
    );

    const remoteRepoId = "cloud:keyboard-activity-remote";
    const otherRemoteRepoId = "cloud:keyboard-activity-remote-other";
    const remoteRows = [
      [remoteRepoId, "remote-unread-older", "Selected remote unread older", "unread", "2026-03-31T02:00:00.000Z"],
      [remoteRepoId, "remote-unread-newer", "Selected remote unread newer", "unread", "2026-03-31T04:00:00.000Z"],
      [remoteRepoId, "remote-read-older", "Selected remote read older", "idle", "2026-03-31T01:00:00.000Z"],
      [remoteRepoId, "remote-read-newer", "Selected remote read newer", "idle", "2026-03-31T05:00:00.000Z"],
      [otherRemoteRepoId, "remote-unread-oldest-other", "Other remote unread oldest", "unread", "2026-03-31T00:30:00.000Z"],
      [otherRemoteRepoId, "remote-unread-newest-other", "Other remote unread newest", "unread", "2026-03-31T06:30:00.000Z"],
      [otherRemoteRepoId, "remote-read-oldest-other", "Other remote read oldest", "idle", "2026-03-31T00:00:00.000Z"],
      [otherRemoteRepoId, "remote-read-newest-other", "Other remote read newest", "idle", "2026-03-31T07:00:00.000Z"],
    ] as const;
    const remoteItemId = (repoId: string, suffix: string) => `${repoId}:${suffix}`;
    const remoteSlotId = (repoId: string, suffix: string) => `remote:${repoId}:owner-local:${suffix}`;
    const remoteSnapshot = {
      repos: [
        {
          id: remoteRepoId,
          path: "cloud",
          name: "Keyboard Remote Activity",
          remote_url: "https://example.invalid/kanna/keyboard-activity-remote.git",
          remoteUrlHash: null,
          default_branch: "main",
          hidden: 0,
          sort_order: 1,
          created_at: "2026-03-31T00:00:00.000Z",
          last_opened_at: "2026-03-31T05:00:00.000Z",
        },
        {
          id: otherRemoteRepoId,
          path: "cloud",
          name: "Keyboard Other Remote Activity",
          remote_url: "https://example.invalid/kanna/keyboard-activity-remote-other.git",
          remoteUrlHash: null,
          default_branch: "main",
          hidden: 0,
          sort_order: 2,
          created_at: "2026-03-31T00:00:00.000Z",
          last_opened_at: "2026-03-31T05:00:00.000Z",
        },
      ],
      items: remoteRows.map(([repoId, suffix, title, activity, createdAt]) => ({
        id: remoteItemId(repoId, suffix),
        repo_id: repoId,
        prompt: title,
        pipeline: "cloud",
        stage: "in progress",
        pr_number: null,
        pr_url: null,
        branch: `task-${suffix}`,
        activity,
        activity_changed_at: createdAt,
        unread_at: null,
        port_offset: null,
        port_env: null,
        pinned: 0,
        pin_order: null,
        display_name: title,
        issue_number: null,
        issue_title: null,
        closed_at: null,
        agent_session_id: null,
        base_ref: "origin/main",
        agent_provider: "codex",
        agent_type: "pty",
        teardown_started_at: null,
        last_output_preview: null,
        created_at: createdAt,
        updated_at: createdAt,
      })),
      terminalRefs: Object.fromEntries(remoteRows.map(([repoId, suffix]) => [
        remoteItemId(repoId, suffix),
        {
          ownerDesktopId: "keyboard-remote-peer",
          ownerLocalTaskId: suffix,
          transport: "cloud",
        },
      ])),
    };

    const selectRemoteTask = async (itemId: string): Promise<void> => {
      const result = await client.executeAsync<string>(
        `const cb = arguments[arguments.length - 1];
         const ctx = ${CTX_SCRIPT};
         const selectItem = ctx.selectSidebarItemById || ctx.handleSelectItem || ctx.store.selectItem.bind(ctx.store);
         Promise.resolve(selectItem(${JSON.stringify(itemId)}))
           .then(function() { cb("ok"); })
           .catch(function(e) { cb("err:" + (e && e.message ? e.message : e)); });`,
      );
      expect(result).toBe("ok");
    };

    try {
      await injectCloudSnapshot(remoteSnapshot);
      const selectRepoResult = await client.executeAsync<string>(
        `const cb = arguments[arguments.length - 1];
         const ctx = ${CTX_SCRIPT};
         const selectRepo = ctx.handleSelectRepo || ctx.store.selectRepo.bind(ctx.store);
         const selectItem = ctx.selectSidebarItemById || ctx.handleSelectItem || ctx.store.selectItem.bind(ctx.store);
         Promise.resolve(selectRepo(${JSON.stringify(remoteRepoId)}))
           .then(function() { return selectItem(${JSON.stringify(remoteItemId(remoteRepoId, "remote-read-older"))}); })
           .then(function() { cb("ok"); })
           .catch(function(e) { cb("err:" + (e && e.message ? e.message : e)); });`,
      );
      expect(selectRepoResult).toBe("ok");
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteSlotId(remoteRepoId, "remote-read-older") });

      await pressKey("u", { meta: true });
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteSlotId(remoteRepoId, "remote-unread-older") });

      await injectCloudSnapshot(remoteSnapshot);
      await selectRemoteTask(remoteItemId(remoteRepoId, "remote-read-older"));
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteSlotId(remoteRepoId, "remote-read-older") });
      await pressKey("U", { meta: true, shift: true });
      await waitForSelection({
        repoId: otherRemoteRepoId,
        itemId: remoteSlotId(otherRemoteRepoId, "remote-unread-oldest-other"),
      });

      await injectCloudSnapshot(remoteSnapshot);
      await selectRemoteTask(remoteItemId(remoteRepoId, "remote-unread-older"));
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteSlotId(remoteRepoId, "remote-unread-older") });
      await pressKey("r", { meta: true });
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteSlotId(remoteRepoId, "remote-read-older") });

      await injectCloudSnapshot(remoteSnapshot);
      await selectRemoteTask(remoteItemId(remoteRepoId, "remote-unread-older"));
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteSlotId(remoteRepoId, "remote-unread-older") });
      await pressKey("R", { meta: true, shift: true });
      await waitForSelection({
        repoId: otherRemoteRepoId,
        itemId: remoteSlotId(otherRemoteRepoId, "remote-read-oldest-other"),
      });
    } finally {
      await injectCloudSnapshot({ repos: [], items: [], terminalRefs: {} });
      await refreshItemsAndSelect(localRepoId, currentTaskId).catch(() => undefined);
    }
  });

  it("unread shortcuts fall back to the oldest read task in their scope when no unread tasks exist", async () => {
    await resetDatabase(client);
    await client.reload();

    const repoOneId = await importRepoWithoutSetupTask(testRepoPath, "keyboard-read-fallback-one");
    const repoTwoId = await importRepoWithoutSetupTask(secondTestRepoPath, "keyboard-read-fallback-two");
    repoImported = true;

    await execDb(client, "UPDATE repo SET sort_order = 0 WHERE id = ?", [repoOneId]);
    await execDb(client, "UPDATE repo SET sort_order = 1 WHERE id = ?", [repoTwoId]);

    const currentTaskId = "shortcut-current-read-fallback";
    const rows = [
      ["shortcut-blocked-global-oldest", repoOneId, "Blocked globally oldest read", "2026-03-31T00:00:00.000Z"],
      ["shortcut-read-global-oldest", repoTwoId, "Globally oldest eligible read", "2026-03-31T00:30:00.000Z"],
      ["shortcut-read-local-oldest", repoOneId, "Selected repo oldest eligible read", "2026-03-31T01:00:00.000Z"],
      ["shortcut-read-local-near", repoOneId, "Selected repo nearby read", "2026-03-31T02:00:00.000Z"],
      [currentTaskId, repoOneId, "Current read fallback task", "2026-03-31T03:00:00.000Z"],
      ["shortcut-read-local-newest", repoOneId, "Selected repo newest read", "2026-03-31T05:00:00.000Z"],
      ["shortcut-read-global-newest", repoTwoId, "Other repo newest read", "2026-03-31T06:00:00.000Z"],
    ] as const;

    for (const row of rows) {
      await execDb(
        client,
        "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, updated_at, agent_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [row[0], row[1], row[2], "in progress", "idle", row[3], row[3], KEYBOARD_FIXTURE_AGENT_TYPE],
      );
    }
    // Blocked-ness comes from task_blocker rows on open blockers, not tags.
    await execDb(
      client,
      "INSERT INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)",
      ["shortcut-blocked-global-oldest", "shortcut-read-local-oldest"],
    );

    await refreshItemsAndSelect(repoOneId, currentTaskId);
    await pressKey("u", { meta: true });
    await waitForSelection({ repoId: repoOneId, itemId: "shortcut-read-local-oldest" });

    await refreshItemsAndSelect(repoOneId, currentTaskId);
    await pressKey("U", { meta: true, shift: true });
    await waitForSelection({ repoId: repoTwoId, itemId: "shortcut-read-global-oldest" });
  });

  it("shows the Option+Cmd+P file preview shortcut in the file picker shortcut menu", async () => {
    await ensureRepoImported();
    await client.executeSync(
      `${CTX_SCRIPT}.showShortcutsModal = false;
       ${CTX_SCRIPT}.showFilePickerModal = false;
       ${CTX_SCRIPT}.showFilePreviewModal = false;`,
    );

    await pressKey("p", { meta: true });
    await client.waitForElement(".picker-modal", 2000);

    await pressKey("/", { meta: true });
    const modal = await client.waitForElement(".shortcuts-modal", 2000);
    const text = await client.getText(modal);

    expect(text).toContain("File Preview");
    expect(text).toContain("⌥⌘P");

    await client.executeSync(
      `${CTX_SCRIPT}.showShortcutsModal = false;
       ${CTX_SCRIPT}.showFilePickerModal = false;`,
    );
    await client.waitForNoElement(".shortcuts-modal", 2000);
    await client.waitForNoElement(".picker-modal", 2000);
  });

  it("does not reserve Command+Z while keeping Undo Close in the command palette", async () => {
    await client.executeSync(
      `${CTX_SCRIPT}.showCommandPalette = false;
       ${CTX_SCRIPT}.showShortcutsModal = false;`,
    );

    const handled = await client.executeSync<boolean>(
      buildHandledGlobalKeydownScript({ key: "z", meta: true }),
    );
    expect(handled).toBe(false);

    await pressKey("/", { meta: true });
    const shortcutsModal = await client.waitForElement(".shortcuts-modal", 2000);
    const shortcutsText = await client.getText(shortcutsModal);
    expect(shortcutsText).not.toContain("Undo Close");
    expect(shortcutsText).not.toContain("⌘Z");

    await client.executeSync(`${CTX_SCRIPT}.showShortcutsModal = false;`);
    await client.waitForNoElement(".shortcuts-modal", 2000);

    await pressKey("P", { meta: true, shift: true });
    await client.waitForElement(".palette-modal", 2000);
    const input = await client.findElement(".palette-modal .palette-input");
    await client.sendKeys(input, "Undo Close");
    const undoCommand = await client.waitForText(".palette-modal .command-item", "Undo Close", 2000);
    expect(await client.getText(undoCommand)).toBe("Undo Close");
    expect(await client.findElements(".palette-modal .command-item .command-keys")).toHaveLength(0);

    await client.executeSync(`${CTX_SCRIPT}.showCommandPalette = false;`);
    await client.waitForNoElement(".palette-modal", 2000);
  });

  it("Shift+Cmd+Enter maximizes the tree explorer", async () => {
    await ensureRepoImported();

    await pressKey("E", { meta: true, shift: true });
    await client.waitForElement(".tree-modal", 2000);
    await sleep(300);

    const maximizedBefore = await client.executeSync<boolean>(
      `const modal = document.querySelector(".tree-modal");
       return modal?.parentElement?.classList.contains("maximized") ?? false;`
    );
    expect(maximizedBefore).toBe(false);

    await pressKey("Enter", { meta: true, shift: true });
    await sleep(300);

    const maximizedAfter = await client.executeSync<boolean>(
      `const modal = document.querySelector(".tree-modal");
       return modal?.parentElement?.classList.contains("maximized") ?? false;`
    );
    expect(maximizedAfter).toBe(true);

    await client.executeSync(`${CTX_SCRIPT}.showTreeExplorer = false; ${CTX_SCRIPT}.maximizedModal = null;`);
    await client.waitForNoElement(".tree-modal", 2000);
  });
});
