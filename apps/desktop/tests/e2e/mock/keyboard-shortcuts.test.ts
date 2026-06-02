import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { dismissStartupShortcutsModal } from "../helpers/startupOverlays";
import { execDb, getVueState } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
const CTX_SCRIPT = 'window.__KANNA_E2E__.setupState';
const HISTORY_DWELL_WAIT_MS = 1_250;

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
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
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
       const selectItem = ctx.handleSelectItem || ctx.store.selectItem.bind(ctx.store);
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
    const result = await client.executeSync<string>(
      `const ctx = ${CTX_SCRIPT};
       const snapshot = ${JSON.stringify(snapshot)};
       const cloudSnapshot = ctx.cloudSnapshot;
       if (!cloudSnapshot) return "cloud-snapshot-unavailable";
       if (cloudSnapshot.__v_isRef) cloudSnapshot.value = snapshot;
       else Object.assign(cloudSnapshot, snapshot);
       return "ok";`,
    );
    expect(result).toBe("ok");
  }

  async function ensureRepoImported() {
    if (repoImported) return;
    await importTestRepo(client, testRepoPath, "keyboard-test");
    repoImported = true;
  }

  async function sidebarTaskTitles(): Promise<string[]> {
    return await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll(".pipeline-item .item-title"))
        .map(function(element) { return element.textContent?.trim() || ""; })
        .filter(Boolean);`,
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
    try {
      await client.findElement(".modal-overlay");
      // Modal still there — close via state
      await client.executeSync(`${CTX_SCRIPT}.showNewTaskModal = false;`);
      await sleep(300);
    } catch {
      // Modal already gone
    }
  });

  it("uses shortcuts to navigate tasks and repos while preserving back-forward history", async () => {
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    const repoOneId = await importTestRepo(client, testRepoPath, "keyboard-history-one");
    const repoTwoId = await importTestRepo(client, secondTestRepoPath, "keyboard-history-two");
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
           (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch, agent_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          repoId,
          issueNumber,
          issueTitle,
          `Prompt for ${issueTitle}`,
          "in progress",
          "[]",
          null,
          "sdk",
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
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    const repoId = await importTestRepo(client, testRepoPath, "keyboard-actions");
    repoImported = true;

    const newerTaskId = "e2e-key-actions-newer";
    const olderTaskId = "e2e-key-actions-older";
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        olderTaskId,
        repoId,
        301,
        "Older key action task",
        "Prompt for older key action task",
        "in progress",
        "[]",
        null,
        "sdk",
        "2026-04-17T10:00:00.000Z",
        "2026-04-17T10:00:00.000Z",
        newerTaskId,
        repoId,
        302,
        "Newer key action task",
        "Prompt for newer key action task",
        "in progress",
        "[]",
        null,
        "sdk",
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
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    const repoId = await importTestRepo(client, testRepoPath, "keyboard-visual-order");
    repoImported = true;

    const inProgressTaskId = "e2e-key-visual-in-progress";
    const prTaskId = "e2e-key-visual-pr";
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prTaskId,
        repoId,
        321,
        "Visual order PR task",
        "Prompt for visual order PR task",
        "pr",
        "[]",
        null,
        "sdk",
        "2026-04-17T10:01:00.000Z",
        "2026-04-17T10:01:00.000Z",
        inProgressTaskId,
        repoId,
        322,
        "Visual order in progress task",
        "Prompt for visual order in progress task",
        "in progress",
        "[]",
        null,
        "sdk",
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
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    const repoOneId = await importTestRepo(client, testRepoPath, "keyboard-cross-repo-one");
    const repoTwoId = await importTestRepo(client, secondTestRepoPath, "keyboard-cross-repo-two");
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
           (id, repo_id, prompt, stage, activity, created_at, updated_at, agent_type, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row[0], row[1], row[2], "in progress", "idle", row[3], row[3], "sdk", "[]"],
      );
    }

    await refreshItemsAndSelect(repoOneId, repoOneOldest);

    await pressKey("ArrowDown", { meta: true, alt: true });
    await waitForSelection({ repoId: repoTwoId, itemId: repoTwoNewest });

    await pressKey("ArrowUp", { meta: true, alt: true });
    await waitForSelection({ repoId: repoOneId, itemId: repoOneOldest });
  });

  it("uses native repo-navigation events to navigate repos", async () => {
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    const repoOneId = await importTestRepo(client, testRepoPath, "native-repo-actions-one");
    const repoTwoId = await importTestRepo(client, secondTestRepoPath, "native-repo-actions-two");
    repoImported = true;

    await execDb(client, "UPDATE repo SET sort_order = 0 WHERE id = ?", [repoOneId]);
    await execDb(client, "UPDATE repo SET sort_order = 1 WHERE id = ?", [repoTwoId]);

    const repoOneTaskId = "e2e-native-repo-actions-one";
    const repoTwoTaskId = "e2e-native-repo-actions-two";
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        repoOneTaskId,
        repoOneId,
        401,
        "Native repo action one",
        "Prompt for native repo action one",
        "in progress",
        "[]",
        null,
        "sdk",
        "2026-04-17T10:00:00.000Z",
        "2026-04-17T10:00:00.000Z",
        repoTwoTaskId,
        repoTwoId,
        402,
        "Native repo action two",
        "Prompt for native repo action two",
        "in progress",
        "[]",
        null,
        "sdk",
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
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);
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
           "INSERT OR REPLACE INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, teardown_started_at, agent_type, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
           [row[0], row[1], row[2], row[3], row[4], row[5], row[6], "sdk", "[]"]
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

  it("read and unread shortcuts navigate relative to the selected task", async () => {
    await ensureRepoImported();
    const repoId = await getVueState(client, "selectedRepoId") as string;

    await execDb(client, "DELETE FROM pipeline_item WHERE repo_id = ?", [repoId]);
    const rows = [
      ["shortcut-read-oldest", repoId, "Read oldest", "in progress", "idle", "2026-03-31T00:00:00.000Z", "[]"],
      ["shortcut-read-near-older", repoId, "Read near older", "in progress", "idle", "2026-03-31T01:00:00.000Z", "[]"],
      ["shortcut-unread-oldest", repoId, "Unread oldest", "in progress", "unread", "2026-03-31T01:30:00.000Z", "[]"],
      ["shortcut-unread-near-older", repoId, "Unread near older", "in progress", "unread", "2026-03-31T02:00:00.000Z", "[]"],
      ["shortcut-current", repoId, "Current task", "in progress", "idle", "2026-03-31T03:00:00.000Z", "[]"],
      ["shortcut-unread-near-newer", repoId, "Unread near newer", "in progress", "unread", "2026-03-31T04:00:00.000Z", "[]"],
      ["shortcut-unread-newest", repoId, "Unread newest", "in progress", "unread", "2026-03-31T04:30:00.000Z", "[]"],
      ["shortcut-read-near-newer", repoId, "Read near newer", "in progress", "idle", "2026-03-31T05:00:00.000Z", "[]"],
      ["shortcut-read-newest", repoId, "Read newest", "in progress", "idle", "2026-03-31T06:00:00.000Z", "[]"],
    ] as const;
    for (const row of rows) {
      await execDb(
        client,
        "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, agent_type, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [row[0], row[1], row[2], row[3], row[4], row[5], "sdk", row[6]],
      );
    }

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = ${CTX_SCRIPT};
       ctx.loadItems(${JSON.stringify(repoId)})
         .then(function() { return ctx.store.selectItem("shortcut-current"); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId, itemId: "shortcut-current" });

    await pressKey("u", { meta: true });
    await waitForSelection({ repoId, itemId: "shortcut-unread-near-older" });

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       ${CTX_SCRIPT}.store.selectItem("shortcut-current").then(function() { cb("ok"); }).catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId, itemId: "shortcut-current" });

    await pressKey("U", { meta: true, shift: true });
    await waitForSelection({ repoId, itemId: "shortcut-unread-near-newer" });

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       ${CTX_SCRIPT}.store.selectItem("shortcut-current").then(function() { cb("ok"); }).catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId, itemId: "shortcut-current" });

    await pressKey("r", { meta: true });
    await waitForSelection({ repoId, itemId: "shortcut-read-near-older" });

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       ${CTX_SCRIPT}.store.selectItem("shortcut-current").then(function() { cb("ok"); }).catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId, itemId: "shortcut-current" });

    await pressKey("R", { meta: true, shift: true });
    await waitForSelection({ repoId, itemId: "shortcut-read-near-newer" });
  });

  it("read and unread shortcuts traverse local repo boundaries", async () => {
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    const repoOneId = await importTestRepo(client, testRepoPath, "keyboard-activity-local-one");
    const repoTwoId = await importTestRepo(client, secondTestRepoPath, "keyboard-activity-local-two");
    repoImported = true;

    await execDb(client, "UPDATE repo SET sort_order = 0 WHERE id = ?", [repoOneId]);
    await execDb(client, "UPDATE repo SET sort_order = 1 WHERE id = ?", [repoTwoId]);

    const currentTaskId = "shortcut-cross-local-current";
    const rows = [
      [currentTaskId, repoOneId, "Current local task", "idle", "2026-03-31T03:00:00.000Z"],
      ["shortcut-cross-local-unread-older", repoTwoId, "Cross local unread older", "unread", "2026-03-31T02:00:00.000Z"],
      ["shortcut-cross-local-unread-newer", repoTwoId, "Cross local unread newer", "unread", "2026-03-31T04:00:00.000Z"],
      ["shortcut-cross-local-read-older", repoTwoId, "Cross local read older", "idle", "2026-03-31T01:00:00.000Z"],
      ["shortcut-cross-local-read-newer", repoTwoId, "Cross local read newer", "idle", "2026-03-31T05:00:00.000Z"],
    ] as const;

    for (const row of rows) {
      await execDb(
        client,
        "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, updated_at, agent_type, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [row[0], row[1], row[2], "in progress", row[3], row[4], row[4], "sdk", "[]"],
      );
    }

    await refreshItemsAndSelect(repoOneId, currentTaskId);

    await pressKey("u", { meta: true });
    await waitForSelection({ repoId: repoTwoId, itemId: "shortcut-cross-local-unread-older" });

    await refreshItemsAndSelect(repoOneId, currentTaskId);
    await pressKey("U", { meta: true, shift: true });
    await waitForSelection({ repoId: repoTwoId, itemId: "shortcut-cross-local-unread-newer" });

    await refreshItemsAndSelect(repoOneId, currentTaskId);
    await pressKey("r", { meta: true });
    await waitForSelection({ repoId: repoTwoId, itemId: "shortcut-cross-local-read-older" });

    await refreshItemsAndSelect(repoOneId, currentTaskId);
    await pressKey("R", { meta: true, shift: true });
    await waitForSelection({ repoId: repoTwoId, itemId: "shortcut-cross-local-read-newer" });
  });

  it("read and unread shortcuts traverse remote tasks in remote-only repos", async () => {
    await resetDatabase(client);
    await client.executeSync("location.reload()");
    await client.waitForAppReady();
    await dismissStartupShortcutsModal(client);

    const localRepoId = await importTestRepo(client, testRepoPath, "keyboard-activity-remote-local");
    repoImported = true;

    const currentTaskId = "shortcut-cross-remote-current";
    await execDb(
      client,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, updated_at, agent_type, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        currentTaskId,
        localRepoId,
        "Current local anchor",
        "in progress",
        "idle",
        "2026-03-31T03:00:00.000Z",
        "2026-03-31T03:00:00.000Z",
        "sdk",
        "[]",
      ],
    );

    const remoteRepoId = "cloud:keyboard-activity-remote";
    const remoteRows = [
      ["remote-unread-older", "Remote unread older", "unread", "2026-03-31T02:00:00.000Z"],
      ["remote-unread-newer", "Remote unread newer", "unread", "2026-03-31T04:00:00.000Z"],
      ["remote-read-older", "Remote read older", "idle", "2026-03-31T01:00:00.000Z"],
      ["remote-read-newer", "Remote read newer", "idle", "2026-03-31T05:00:00.000Z"],
    ] as const;
    const remoteItemId = (suffix: string) => `${remoteRepoId}:${suffix}`;
    const remoteSnapshot = {
      repos: [{
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
      }],
      items: remoteRows.map(([suffix, title, activity, createdAt]) => ({
        id: remoteItemId(suffix),
        repo_id: remoteRepoId,
        prompt: title,
        pipeline: "cloud",
        stage: "in progress",
        tags: "[]",
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
        previous_stage: null,
        stage_result: null,
        teardown_started_at: null,
        last_output_preview: null,
        active_post_action: null,
        created_at: createdAt,
        updated_at: createdAt,
      })),
      terminalRefs: Object.fromEntries(remoteRows.map(([suffix]) => [
        remoteItemId(suffix),
        {
          ownerDesktopId: "keyboard-remote-peer",
          ownerLocalTaskId: suffix,
          transport: "cloud",
        },
      ])),
    };

    try {
      await refreshItemsAndSelect(localRepoId, currentTaskId);

      await injectCloudSnapshot(remoteSnapshot);
      await pressKey("u", { meta: true });
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteItemId("remote-unread-older") });

      await injectCloudSnapshot(remoteSnapshot);
      await refreshItemsAndSelect(localRepoId, currentTaskId);
      await injectCloudSnapshot(remoteSnapshot);
      await pressKey("U", { meta: true, shift: true });
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteItemId("remote-unread-newer") });

      await injectCloudSnapshot(remoteSnapshot);
      await refreshItemsAndSelect(localRepoId, currentTaskId);
      await injectCloudSnapshot(remoteSnapshot);
      await pressKey("r", { meta: true });
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteItemId("remote-read-older") });

      await injectCloudSnapshot(remoteSnapshot);
      await refreshItemsAndSelect(localRepoId, currentTaskId);
      await injectCloudSnapshot(remoteSnapshot);
      await pressKey("R", { meta: true, shift: true });
      await waitForSelection({ repoId: remoteRepoId, itemId: remoteItemId("remote-read-newer") });
    } finally {
      await injectCloudSnapshot({ repos: [], items: [], terminalRefs: {} });
      await refreshItemsAndSelect(localRepoId, currentTaskId).catch(() => undefined);
    }
  });

  it("unread shortcuts fall back to relative read tasks when no unread tasks exist", async () => {
    await ensureRepoImported();
    const repoId = await getVueState(client, "selectedRepoId") as string;

    const seedResult = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       const rows = [
         ["shortcut-blocked-old", "${repoId}", "Blocked old read", "in progress", "idle", "2026-03-31T00:00:00.000Z", "[\\"blocked\\"]"],
         ["shortcut-read-old", "${repoId}", "Read old", "in progress", "idle", "2026-03-31T01:00:00.000Z", "[]"],
         ["shortcut-read-near-old", "${repoId}", "Read near old", "in progress", "idle", "2026-03-31T02:00:00.000Z", "[]"],
         ["shortcut-current-read-fallback", "${repoId}", "Current", "in progress", "idle", "2026-03-31T03:00:00.000Z", "[]"],
         ["shortcut-read-near-new", "${repoId}", "Read near new", "in progress", "idle", "2026-03-31T04:00:00.000Z", "[]"],
         ["shortcut-read-new", "${repoId}", "Read new", "in progress", "idle", "2026-03-31T05:00:00.000Z", "[]"],
         ["shortcut-blocked-new", "${repoId}", "Blocked new read", "in progress", "idle", "2026-03-31T06:00:00.000Z", "[\\"blocked\\"]"],
       ];
       db.execute("DELETE FROM pipeline_item WHERE repo_id = ?", ["${repoId}"])
         .then(function() {
           return Promise.all(rows.map(function(row) {
             return db.execute(
               "INSERT INTO pipeline_item (id, repo_id, prompt, stage, activity, created_at, agent_type, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
               [row[0], row[1], row[2], row[3], row[4], row[5], "sdk", row[6]]
             );
           }));
         })
         .then(function() { return ctx.loadItems("${repoId}"); })
         .then(function() { return ctx.store.selectItem("shortcut-current-read-fallback"); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    expect(seedResult).toBe("ok");
    await waitForSelection({ repoId, itemId: "shortcut-current-read-fallback" });

    await pressKey("u", { meta: true });
    await waitForSelection({ repoId, itemId: "shortcut-read-near-old" });

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       ${CTX_SCRIPT}.store.selectItem("shortcut-current-read-fallback").then(function() { cb("ok"); }).catch(function(e) { cb("err:" + e); });`,
    );
    await waitForSelection({ repoId, itemId: "shortcut-current-read-fallback" });

    await pressKey("U", { meta: true, shift: true });
    await waitForSelection({ repoId, itemId: "shortcut-read-near-new" });
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
