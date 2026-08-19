import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { execDb, getVueState, queryDb, tauriInvoke } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { appendE2ePerfSummaryLine, formatDiffPerfSummary } from "../helpers/perfOutput";
import { buildGlobalKeydownScript } from "../helpers/keyboard";

function getDiffPerfFileCount(): number {
  const rawValue = process.env.KANNA_E2E_DIFF_PERF_FILES;
  if (!rawValue) return 20;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`KANNA_E2E_DIFF_PERF_FILES must be a positive integer, got: ${rawValue}`);
  }
  return parsed;
}

function getDiffPerfLinesPerFile(): number {
  const rawValue = process.env.KANNA_E2E_DIFF_PERF_LINES_PER_FILE;
  if (!rawValue) return 1500;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`KANNA_E2E_DIFF_PERF_LINES_PER_FILE must be a positive integer, got: ${rawValue}`);
  }
  return parsed;
}

function getDiffFirstContentThresholdMs(): number {
  const rawValue = process.env.KANNA_E2E_DIFF_FIRST_CONTENT_MS;
  if (!rawValue) return 15000;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`KANNA_E2E_DIFF_FIRST_CONTENT_MS must be a positive integer, got: ${rawValue}`);
  }
  return parsed;
}

async function getSelectedWorktreePath(
  client: WebDriverClient,
  testRepoPath: string,
): Promise<string> {
  const branch = await client.executeSync<string | null>(
    `const ctx = window.__KANNA_E2E__.setupState;
     const item = ctx.selectedItem();
     return item ? (item.branch?.value || item.branch) : null;`
  );
  if (!branch) {
    throw new Error("expected selected task to have a worktree branch");
  }
  return `${testRepoPath}/.kanna-worktrees/${branch}`;
}

async function closeDiffModalIfOpen(client: WebDriverClient): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const isOpen = await client.executeSync<boolean>(
      `return Boolean(document.querySelector(".diff-view"));`
    );
    if (!isOpen) return;
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await sleep(100);
  }
  await client.waitForNoElement(".diff-view", 2_000);
}

async function openDiffModal(client: WebDriverClient): Promise<void> {
  await closeDiffModalIfOpen(client);
  await client.executeSync(buildGlobalKeydownScript({ key: "d", meta: true }));
  await client.waitForElement(".diff-view", 5_000);
}

async function resetSelectedDiffViewState(client: WebDriverClient): Promise<void> {
  await closeDiffModalIfOpen(client);
  await client.executeSync(
    `const ctx = window.__KANNA_E2E__.setupState;
     const keyRef = ctx.currentDiffViewKey;
     const key = keyRef?.__v_isRef ? keyRef.value : keyRef;
     if (key && ctx.diffViewStates) {
       delete ctx.diffViewStates[key];
     }`
  );
}

async function clickDiffToolbarButton(client: WebDriverClient, label: string): Promise<void> {
  const clicked = await client.executeSync<boolean>(
    `const label = ${JSON.stringify(label)};
     const buttons = Array.from(document.querySelectorAll(".diff-toolbar button"));
     const button = buttons.find((element) => (element.textContent || "").trim() === label);
     if (!(button instanceof HTMLButtonElement)) return false;
     button.click();
     return true;`
  );
  if (!clicked) {
    throw new Error(`diff toolbar button not found: ${label}`);
  }
}

async function getContextToggleState(
  client: WebDriverClient,
): Promise<{ text: string; active: boolean }> {
  const state = await client.executeSync<{ text: string; active: boolean } | null>(
    `const button = document.querySelector(".diff-toolbar .context-toggle");
     if (!(button instanceof HTMLButtonElement)) return null;
     return {
       text: (button.textContent || "").trim(),
       active: button.classList.contains("active"),
     };`
  );
  if (!state) {
    throw new Error("diff context toggle not found");
  }
  return state;
}

async function setDiffScope(client: WebDriverClient, scope: "Working" | "Branch"): Promise<void> {
  const active = await client.executeSync<boolean>(
    `const scope = ${JSON.stringify(scope)};
     const button = Array.from(document.querySelectorAll(".scope-selector button"))
       .find((element) => (element.textContent || "").trim() === scope);
     return button?.classList.contains("active") ?? false;`
  );
  if (active) return;
  await clickDiffToolbarButton(client, scope);
}

async function waitForDiffText(
  client: WebDriverClient,
  predicateSource: string,
  timeoutMs = 10_000,
): Promise<string> {
  return client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const predicate = new Function("text", ${JSON.stringify(predicateSource)});
     function collectText(node) {
       let text = "";
       if (node.nodeType === Node.TEXT_NODE) {
         text += node.textContent || "";
       }
       if (node instanceof Element || node instanceof ShadowRoot || node instanceof DocumentFragment) {
         if (node instanceof Element && node.shadowRoot) {
           text += collectText(node.shadowRoot);
         }
         for (const child of Array.from(node.childNodes)) {
           text += collectText(child);
         }
       }
       return text;
     }
     let done = false;
     const finish = (value) => {
       if (done) return;
       done = true;
       clearInterval(interval);
       clearTimeout(timeout);
       cb(value);
     };
     const read = () => {
       const container = document.querySelector(".diff-container");
       return container ? collectText(container) : "";
     };
     const check = () => {
       const text = read();
       if (predicate(text)) finish(text);
     };
     const interval = setInterval(check, 100);
     const timeout = setTimeout(() => finish("__TIMEOUT__\\n" + read()), ${timeoutMs});
     check();`
  );
}

async function waitForDiffScrollHeight(
  client: WebDriverClient,
  minScrollHeight: number,
  timeoutMs = 10_000,
): Promise<number> {
  const result = await client.executeAsync<number>(
    `const cb = arguments[arguments.length - 1];
     let done = false;
     const finish = (value) => {
       if (done) return;
       done = true;
       clearInterval(interval);
       clearTimeout(timeout);
       cb(value);
     };
     const check = () => {
       const container = document.querySelector(".diff-container");
       const scrollHeight = container instanceof HTMLElement ? container.scrollHeight : 0;
       if (scrollHeight >= ${minScrollHeight}) finish(scrollHeight);
     };
     const interval = setInterval(check, 100);
     const timeout = setTimeout(() => {
       const container = document.querySelector(".diff-container");
       finish(container instanceof HTMLElement ? container.scrollHeight : 0);
     }, ${timeoutMs});
     check();`
  );
  if (result < minScrollHeight) {
    throw new Error(`diff scrollHeight ${result} never reached ${minScrollHeight}`);
  }
  return result;
}

interface StageActionRecorderOptions {
  requestRevisionStatus?: number;
  requestRevisionBody?: string;
}

interface DiffLineViewportSnapshot {
  filePath: string;
  lineNumber: string;
  lineType: string | null;
  viewportOffset: number;
  scrollTop: number;
  scrollHeight: number;
  wrapperIndex: number;
  wrapperCount: number;
}

interface SettledDiffLineViewportSnapshot extends DiffLineViewportSnapshot {
  renderedFileCount: number;
  timedOut?: boolean;
}

async function installStageActionRecorder(
  client: WebDriverClient,
  options: StageActionRecorderOptions = {},
): Promise<void> {
  await client.executeSync(
    `window.__KANNA_NATIVE_REVIEW_ACTIONS__ = [];
     window.__KANNA_NATIVE_REVIEW_ADVANCE_COUNT__ = 0;
     window.__KANNA_NATIVE_REVIEW_OPTIONS__ = ${JSON.stringify(options)};
     if (!window.__KANNA_NATIVE_REVIEW_ORIGINAL_FETCH__) {
       window.__KANNA_NATIVE_REVIEW_ORIGINAL_FETCH__ = window.fetch.bind(window);
     }
     window.fetch = async function(input, init) {
       const url = String(input instanceof Request ? input.url : input);
       if (url.includes("/v1/tasks/") && url.includes("/actions/")) {
         const body = typeof init?.body === "string" ? init.body : "";
         window.__KANNA_NATIVE_REVIEW_ACTIONS__.push({
           url,
           method: init?.method || "GET",
           body,
         });
         const ctx = window.__KANNA_E2E__.setupState;
         const item = ctx.selectedItem();
         const db = ctx.db.value || ctx.db;
         const recorderOptions = window.__KANNA_NATIVE_REVIEW_OPTIONS__ || {};
         if (item && url.endsWith("/actions/request-revision")) {
           const status = recorderOptions.requestRevisionStatus || 200;
           if (status < 200 || status >= 300) {
             return new Response(recorderOptions.requestRevisionBody || "request revision failed", {
               status,
               headers: { "content-type": "text/plain" },
             });
           }
           await db.execute("UPDATE pipeline_item SET stage = ? WHERE id = ?", ["in progress", item.id]);
         } else if (item && url.endsWith("/actions/advance-stage")) {
           window.__KANNA_NATIVE_REVIEW_ADVANCE_COUNT__ += 1;
           // Model the production engine: a current stage with a post parks
           // the task (stage and closed_at unchanged) behind a running post
           // stage_run; the post's own completion performs the transition.
           // A final stage without a post closes on advance; other stages
           // move forward.
           let pinnedStage = null;
           try {
             const def = JSON.parse(item.pipeline_def || "null");
             pinnedStage = (def?.stages || []).find((stage) => stage.name === item.stage) || null;
           } catch {}
           if (pinnedStage?.post) {
             await db.execute(
               "INSERT INTO stage_run (id, task_id, stage, kind, agent, status) VALUES (?, ?, ?, 'post', ?, 'running')",
               ["e2e-post-" + item.id, item.id, pinnedStage.post.name, pinnedStage.post.agent || null],
             );
           } else if (item.stage === "pr") {
             await db.execute("UPDATE pipeline_item SET closed_at = ? WHERE id = ?", [new Date().toISOString(), item.id]);
           } else {
             await db.execute("UPDATE pipeline_item SET stage = ? WHERE id = ?", ["pr", item.id]);
           }
         }
         return new Response(JSON.stringify({ taskId: item?.id || "unknown" }), {
           status: 200,
           headers: { "content-type": "application/json" },
         });
       }
       return window.__KANNA_NATIVE_REVIEW_ORIGINAL_FETCH__(input, init);
     };`
  );
}

async function waitForRecordedStageActions(
  client: WebDriverClient,
  count: number,
): Promise<Array<{ url: string; method: string; body: string }>> {
  return client.executeAsync<Array<{ url: string; method: string; body: string }>>(
    `const cb = arguments[arguments.length - 1];
     const expected = ${count};
     let done = false;
     const read = () => window.__KANNA_NATIVE_REVIEW_ACTIONS__ || [];
     const finish = (value) => {
       if (done) return;
       done = true;
       clearInterval(interval);
       clearTimeout(timeout);
       cb(value);
     };
     const check = () => {
       const calls = read();
       if (calls.length >= expected) finish(calls);
     };
     const interval = setInterval(check, 100);
     const timeout = setTimeout(() => finish(read()), 10000);
     check();`
  );
}

async function clickRenderedDiffLineNumber(
  client: WebDriverClient,
  filePath: string,
  lineNumber: number,
): Promise<void> {
  const result = await client.executeAsync<{ clicked: boolean; debug: string }>(
    `const cb = arguments[arguments.length - 1];
     const filePath = ${JSON.stringify(filePath)};
     const lineNumber = ${lineNumber};
     const expectedText = String(lineNumber);
     const collectText = (element) => (element.textContent || "").trim();
     const findWrapper = () => {
       const wrappers = Array.from(document.querySelectorAll(".diff-container .diff-file"));
       return wrappers.find((candidate) => {
         const header = candidate.querySelector(".diff-file-header");
         return (header?.getAttribute("title") || header?.textContent || "") === filePath;
       });
     };
     const findLineNumberElement = (wrapper) => {
       const containers = Array.from(wrapper.querySelectorAll("diffs-container"));
       for (const container of containers) {
         const root = container.shadowRoot;
         if (!root) continue;
         const numbers = Array.from(root.querySelectorAll("[data-line-number-content]"));
         const match = numbers.find((element) => collectText(element) === expectedText);
         if (match instanceof HTMLElement) return match;
       }
       return null;
     };
     let done = false;
     const finish = (value) => {
       if (done) return;
       done = true;
       clearInterval(interval);
       clearTimeout(timeout);
       cb(value);
     };
     const tryClick = () => {
       const wrapper = findWrapper();
       if (!(wrapper instanceof HTMLElement)) return;
       const lineNumberElement = findLineNumberElement(wrapper);
       if (!(lineNumberElement instanceof HTMLElement)) return;
       lineNumberElement.dispatchEvent(new MouseEvent("click", {
         bubbles: true,
         cancelable: true,
         composed: true,
         view: window,
       }));
       finish({ clicked: true, debug: "" });
     };
     const interval = setInterval(tryClick, 50);
     const timeout = setTimeout(() => {
       const wrapper = findWrapper();
       const available = wrapper
         ? Array.from(wrapper.querySelectorAll("diffs-container"))
             .flatMap((container) => container.shadowRoot
               ? Array.from(container.shadowRoot.querySelectorAll("[data-line-number-content]"))
                   .map((element) => collectText(element)).filter(Boolean)
               : [])
             .slice(0, 40)
         : [];
       finish({ clicked: false, debug: JSON.stringify({ filePath, lineNumber, available }) });
     }, 10000);
     tryClick();`
  );
  if (!result.clicked) {
    throw new Error(`failed to click rendered diff line ${filePath}:${lineNumber}: ${result.debug}`);
  }
  await client.waitForElement(".review-composer", 2_000);
}

async function addReviewCommentThroughDiffUi(
  client: WebDriverClient,
  filePath: string,
  lineNumber: number,
  note: string,
): Promise<void> {
  await clickRenderedDiffLineNumber(client, filePath, lineNumber);
  const textarea = await client.findElement(".review-composer textarea");
  await client.sendKeys(textarea, note);
  await client.click(await client.findElement(".review-composer-actions .primary"));
}

async function waitForReviewCommentCount(client: WebDriverClient, expectedCount: number): Promise<void> {
  await client.executeAsync<string>(
    `const cb = arguments[arguments.length - 1];
     const expectedCount = ${expectedCount};
     const readCount = () => {
       const ctx = window.__KANNA_E2E__.setupState;
       const stateRef = ctx.appModals?.currentDiffViewState || ctx.currentDiffViewState;
       const state = stateRef?.__v_isRef ? stateRef.value : stateRef;
       return (state?.reviewComments || []).length;
     };
     let done = false;
     const finish = (value) => {
       if (done) return;
       done = true;
       clearInterval(interval);
       clearTimeout(timeout);
       cb(value);
     };
     const check = () => {
       const count = readCount();
       if (count === expectedCount) finish("ok");
     };
     const interval = setInterval(check, 50);
     const timeout = setTimeout(() => finish("count:" + readCount()), 3000);
     check();`
  ).then((result) => {
    if (result !== "ok") {
      throw new Error(`timed out waiting for ${expectedCount} review comments: ${result}`);
    }
  });
}

async function ensureCommentDrawerOpen(client: WebDriverClient): Promise<void> {
  const isOpen = await client.executeSync<boolean>(
    `return Boolean(document.querySelector(".comment-drawer"));`
  );
  if (isOpen) return;
  await client.executeSync(buildGlobalKeydownScript({ key: "c" }));
  await client.waitForElement(".comment-drawer", 2_000);
}

async function clickCommentDrawerAnchor(client: WebDriverClient, anchorText: string): Promise<void> {
  const clicked = await client.executeSync<boolean>(
    `const anchorText = ${JSON.stringify(anchorText)};
     const anchors = Array.from(document.querySelectorAll(".comment-drawer .comment-anchor"));
     const anchor = anchors.find((element) => (element.textContent || "").trim() === anchorText);
     if (!(anchor instanceof HTMLButtonElement)) return false;
     anchor.click();
     return true;`
  );
  if (!clicked) {
    throw new Error(`comment drawer anchor not found: ${anchorText}`);
  }
}

describe("diff view", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";
  let taskWorktreePath = "";
  let taskWorktreeBaselineRef = "";

  async function getSelectedTaskBranch(): Promise<string> {
    const branch = await client.executeSync<string | null>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const item = ctx.selectedItem();
       return item ? (item.branch?.value || item.branch) : null;`
    );
    if (!branch) {
      throw new Error("expected selected task to have a worktree branch");
    }
    return branch;
  }

  async function resetTaskWorktreeDiffState(): Promise<void> {
    if (!taskWorktreePath || !taskWorktreeBaselineRef) return;

    await client.executeSync(
      `const ctx = window.__KANNA_E2E__.setupState;
       const setRef = (key, value) => {
         const current = ctx?.[key];
         if (current?.__v_isRef) current.value = value;
         else if (ctx && key in ctx) ctx[key] = value;
       };
       setRef("showDiffModal", false);
       setRef("maximizedModal", null);
       const key = ctx?.currentDiffViewKey?.value ?? ctx?.currentDiffViewKey;
       const resetState = {
         scope: "working",
         scrollPositions: { working: 0, branch: 0 },
         reviewComments: [],
         reviewHeadCommit: undefined,
       };
       if (typeof ctx?.appModals?.updateCurrentDiffViewState === "function") {
         ctx.appModals.updateCurrentDiffViewState(resetState);
       }
       if (key && ctx?.diffViewStates) {
         ctx.diffViewStates[key] = resetState;
       }`
    ).catch(() => undefined);
    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const item = ctx.selectedItem?.();
       const db = ctx.db.value || ctx.db;
       if (!item) { cb("ok"); return; }
       db.execute("UPDATE pipeline_item SET stage = ? WHERE id = ?", ["in progress", item.id])
         .then(function() { return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    ).catch(() => undefined);
    await client.waitForNoElement(".diff-view", 2_000).catch(() => undefined);
    await tauriInvoke(client, "run_script", {
      script: [
        'git reset --hard "$KANNA_E2E_DIFF_BASELINE_REF"',
        "git clean -fd -- .cargo diff-oversized diff-perf e2e-*.txt native-review-e2e",
      ].join("\n"),
      cwd: taskWorktreePath,
      env: {
        KANNA_E2E_DIFF_BASELINE_REF: taskWorktreeBaselineRef,
      },
    });
  }

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("diff-test");
    testRepoPath = fixtureRepoRoot;

    await tauriInvoke(client, "run_script", {
      script: [
        "cat > e2e-all-lines-context.txt <<'EOF'",
        "all-lines hidden top marker",
        "all-lines context 02",
        "all-lines context 03",
        "all-lines context 04",
        "all-lines context 05",
        "all-lines context 06",
        "all-lines context 07",
        "all-lines original center marker",
        "all-lines context 09",
        "all-lines context 10",
        "all-lines context 11",
        "all-lines context 12",
        "all-lines context 13",
        "all-lines context 14",
        "all-lines hidden bottom marker",
        "EOF",
        "git add e2e-all-lines-context.txt",
        "git commit -m 'add e2e all-lines context fixture'",
        "git push origin main",
      ].join("\n"),
      cwd: testRepoPath,
      env: {},
    });

    await importTestRepo(client, testRepoPath, "diff-test");

    // Create a task with worktree but no Claude session (Agent mode, will fail gracefully)
    const repoId = await getVueState(client, "selectedRepoId") as string;
    const id = crypto.randomUUID();
    const branch = `task-${id}`;
    const worktreePath = `${testRepoPath}/.kanna-worktrees/${branch}`;
    taskWorktreePath = worktreePath;

    // Internal setup only: diff tests need a deterministic worktree-backed task
    // without starting a real agent session.
    await tauriInvoke(client, "git_worktree_add", {
      repoPath: testRepoPath,
      branch,
      path: worktreePath,
    });

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       db.execute("INSERT INTO pipeline_item (id, repo_id, prompt, stage, branch, agent_type) VALUES (?, ?, ?, ?, ?, ?)",
         ["${id}", "${repoId}", "Say OK", "in progress", "${branch}", "agent"])
         .then(function() { return ctx.loadItems("${repoId}"); })
         .then(function() { ctx.handleSelectItem("${id}"); return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    await client.waitForText(".sidebar", "Say OK");

    const baselineRef = await tauriInvoke(client, "run_script", {
      script: "git rev-parse HEAD",
      cwd: taskWorktreePath,
      env: {},
    });
    if (typeof baselineRef !== "string" || baselineRef.trim().length === 0) {
      throw new Error(`expected worktree baseline ref, got: ${JSON.stringify(baselineRef)}`);
    }
    taskWorktreeBaselineRef = baselineRef.trim();
  });

  afterEach(async () => {
    await resetTaskWorktreeDiffState();
  });

  beforeEach(async () => {
    await resetTaskWorktreeDiffState();
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("opens the diff modal", async () => {
    await client.executeSync(buildGlobalKeydownScript({ key: "d", meta: true }));
    const diffView = await client.waitForElement(".diff-view", 5000);
    expect(diffView).toBeTruthy();
    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".diff-view", 2_000);
  });

  it("loads diff content after editing a tracked file", async () => {
    // Get the worktree path from the selected item
    const branch = await getSelectedTaskBranch();

    const worktreePath = `${testRepoPath}/.kanna-worktrees/${branch}`;

    // Modify a tracked file in the worktree so the working diff is guaranteed to pick it up.
    await tauriInvoke(client, "run_script", {
      script: "printf '\\n# diff test marker\\n' >> VERSION",
      cwd: worktreePath,
      env: {},
    });

    await client.executeSync(buildGlobalKeydownScript({ key: "d", meta: true }));

    const patch = await tauriInvoke(client, "git_diff", {
      repoPath: worktreePath,
      mode: "all",
    });
    expect(typeof patch).toBe("string");
    expect(String(patch)).toContain("# diff test marker");
  });

  it("expands Working diff hidden context lines from the toolbar", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);

    await tauriInvoke(client, "run_script", {
      script: [
        "cat > e2e-all-lines-context.txt <<'EOF'",
        "all-lines hidden top marker",
        "all-lines context 02",
        "all-lines context 03",
        "all-lines context 04",
        "all-lines context 05",
        "all-lines context 06",
        "all-lines context 07",
        "working all-lines changed center marker",
        "all-lines context 09",
        "all-lines context 10",
        "all-lines context 11",
        "all-lines context 12",
        "all-lines context 13",
        "all-lines context 14",
        "all-lines hidden bottom marker",
        "EOF",
      ].join("\n"),
      cwd: worktreePath,
      env: {},
    });

    await openDiffModal(client);
    await setDiffScope(client, "Working");

    const compactState = await getContextToggleState(client);
    expect(compactState).toEqual({ text: "Context", active: false });

    const compactText = await waitForDiffText(
      client,
      `return text.includes("working all-lines changed center marker")
        && !text.includes("all-lines hidden top marker")
        && !text.includes("all-lines hidden bottom marker");`,
    );
    expect(compactText).toContain("working all-lines changed center marker");
    expect(compactText).not.toContain("all-lines hidden top marker");
    expect(compactText).not.toContain("all-lines hidden bottom marker");

    await clickDiffToolbarButton(client, "Context");

    const allLinesText = await waitForDiffText(
      client,
      `return text.includes("working all-lines changed center marker")
        && text.includes("all-lines hidden top marker")
        && text.includes("all-lines hidden bottom marker");`,
    );
    expect(allLinesText).toContain("working all-lines changed center marker");
    expect(allLinesText).toContain("all-lines hidden top marker");
    expect(allLinesText).toContain("all-lines hidden bottom marker");

    const allLinesState = await getContextToggleState(client);
    expect(allLinesState).toEqual({ text: "All lines", active: true });
  });

  it("keeps a later file line fixed while real all-lines content renders above it", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    const targetFile = "e2e-scroll-anchor-14.txt";
    const fileCount = 18;

    await tauriInvoke(client, "run_script", {
      script: [
        "file_index=1",
        "while [ \"$file_index\" -le 18 ]; do",
        "  file_number=$(printf '%02d' \"$file_index\")",
        "  file_path=\"e2e-scroll-anchor-${file_number}.txt\"",
        "  : > \"$file_path\"",
        "  line_number=1",
        "  while [ \"$line_number\" -le 120 ]; do",
        "    printf 'anchor file %s line %03d original\\n' \"$file_number\" \"$line_number\" >> \"$file_path\"",
        "    line_number=$((line_number + 1))",
        "  done",
        "  file_index=$((file_index + 1))",
        "done",
        "git add e2e-scroll-anchor-*.txt",
        "git commit -m 'add e2e scroll anchor fixtures'",
        "file_index=1",
        "while [ \"$file_index\" -le 18 ]; do",
        "  file_number=$(printf '%02d' \"$file_index\")",
        "  file_path=\"e2e-scroll-anchor-${file_number}.txt\"",
        "  awk -v file_number=\"$file_number\" '",
        "    NR == 60 { printf \"anchor file %s line 060 changed\\n\", file_number; next }",
        "    { print }",
        "  ' \"$file_path\" > \"${file_path}.tmp\"",
        "  mv \"${file_path}.tmp\" \"$file_path\"",
        "  file_index=$((file_index + 1))",
        "done",
      ].join("\n"),
      cwd: worktreePath,
      env: {},
    });

    await openDiffModal(client);
    await setDiffScope(client, "Working");

    const compactText = await waitForDiffText(
      client,
      `return text.includes("anchor file 01 line 060 changed")
        && text.includes("anchor file 14 line 060 changed")
        && text.includes("anchor file 18 line 060 changed");`,
      20_000,
    );
    expect(compactText).toContain("anchor file 14 line 060 changed");

    const before = await client.executeAsync<DiffLineViewportSnapshot | null>(
      `const cb = arguments[arguments.length - 1];
       const targetFile = ${JSON.stringify(targetFile)};
       let scrolled = false;
       let done = false;
       const finish = (value) => {
         if (done) return;
         done = true;
         clearInterval(interval);
         clearTimeout(timeout);
         cb(value);
       };
       const findTarget = () => {
         const container = document.querySelector(".diff-container");
         if (!(container instanceof HTMLElement)) return null;
         const wrappers = Array.from(container.querySelectorAll(".diff-file"));
         const wrapperIndex = wrappers.findIndex((candidate) => {
           const header = candidate.querySelector(".diff-file-header");
           return (header?.getAttribute("title") || header?.textContent || "") === targetFile;
         });
         const wrapper = wrappers[wrapperIndex];
         if (!(wrapper instanceof HTMLElement)) return null;
         const lines = Array.from(wrapper.querySelectorAll("diffs-container"))
           .flatMap((host) => host.shadowRoot
             ? Array.from(host.shadowRoot.querySelectorAll("[data-line]"))
             : []);
         if (lines.length === 0) return null;
         return { container, wrappers, wrapper, wrapperIndex, lines };
       };
       const capture = () => {
         const target = findTarget();
         if (!target) return;
         const { container, wrappers, wrapper, wrapperIndex, lines } = target;
         if (!scrolled) {
           container.scrollTop = Math.min(
             wrapper.offsetTop + 20,
             Math.max(0, container.scrollHeight - container.clientHeight),
           );
           container.dispatchEvent(new Event("scroll", { bubbles: true }));
           scrolled = true;
           return;
         }
         const containerRect = container.getBoundingClientRect();
         const line = lines.find((candidate) => {
           const rect = candidate.getBoundingClientRect();
           return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
         });
         if (!(line instanceof HTMLElement)) return;
         const lineNumber = line.getAttribute("data-line");
         if (lineNumber == null) return;
         finish({
           filePath: targetFile,
           lineNumber,
           lineType: line.getAttribute("data-line-type"),
           viewportOffset: line.getBoundingClientRect().top - containerRect.top,
           scrollTop: container.scrollTop,
           scrollHeight: container.scrollHeight,
           wrapperIndex,
           wrapperCount: wrappers.length,
         });
       };
       const interval = setInterval(capture, 50);
       const timeout = setTimeout(() => finish(null), 10_000);
       capture();`
    );

    expect(before).not.toBeNull();
    expect(before!.filePath).toBe(targetFile);
    expect(before!.wrapperIndex).toBeGreaterThan(10);
    expect(before!.wrapperCount).toBeGreaterThanOrEqual(fileCount);
    expect(before!.scrollTop).toBeGreaterThan(0);

    await clickDiffToolbarButton(client, "Context");

    const allLinesText = await waitForDiffText(
      client,
      `return text.includes("anchor file 01 line 001 original")
        && text.includes("anchor file 14 line 001 original")
        && text.includes("anchor file 18 line 120 original");`,
      30_000,
    );
    expect(allLinesText).toContain("anchor file 14 line 001 original");

    const after = await client.executeAsync<SettledDiffLineViewportSnapshot>(
      `const cb = arguments[arguments.length - 1];
       const expected = ${JSON.stringify(before)};
       const expectedFileCount = ${before!.wrapperCount};
       let done = false;
       let stableSamples = 0;
       let previous = null;
       const finish = (value) => {
         if (done) return;
         done = true;
         clearInterval(interval);
         clearTimeout(timeout);
         cb(value);
       };
       const read = () => {
         const container = document.querySelector(".diff-container");
         if (!(container instanceof HTMLElement)) return null;
         const wrappers = Array.from(container.querySelectorAll(".diff-file"));
         const wrapperIndex = wrappers.findIndex((candidate) => {
           const header = candidate.querySelector(".diff-file-header");
           return (header?.getAttribute("title") || header?.textContent || "") === expected.filePath;
         });
         const wrapper = wrappers[wrapperIndex];
         if (!(wrapper instanceof HTMLElement)) return null;
         const renderedFileCount = wrappers.filter((candidate) =>
           Array.from(candidate.querySelectorAll("diffs-container"))
             .some((host) => Boolean(host.shadowRoot?.querySelector("[data-line]")))
         ).length;
         const lines = Array.from(wrapper.querySelectorAll("diffs-container"))
           .flatMap((host) => host.shadowRoot
             ? Array.from(host.shadowRoot.querySelectorAll("[data-line]"))
             : []);
         const line = lines.find((candidate) =>
           candidate.getAttribute("data-line") === expected.lineNumber
             && candidate.getAttribute("data-line-type") === expected.lineType
         );
         if (!(line instanceof HTMLElement)) return null;
         return {
           filePath: expected.filePath,
           lineNumber: line.getAttribute("data-line"),
           lineType: line.getAttribute("data-line-type"),
           viewportOffset:
             line.getBoundingClientRect().top - container.getBoundingClientRect().top,
           scrollTop: container.scrollTop,
           scrollHeight: container.scrollHeight,
           wrapperIndex,
           wrapperCount: wrappers.length,
           renderedFileCount,
         };
       };
       const check = () => {
         const current = read();
         if (!current || current.renderedFileCount !== expectedFileCount) {
           stableSamples = 0;
           previous = current;
           return;
         }
         const stable = previous
           && Math.abs(current.viewportOffset - previous.viewportOffset) <= 0.25
           && Math.abs(current.scrollTop - previous.scrollTop) <= 0.25
           && current.scrollHeight === previous.scrollHeight;
         stableSamples = stable ? stableSamples + 1 : 0;
         previous = current;
         if (stableSamples >= 3) finish(current);
       };
       const interval = setInterval(check, 50);
       const timeout = setTimeout(() => {
         finish({
           ...(read() || expected),
           renderedFileCount: read()?.renderedFileCount || 0,
           timedOut: true,
         });
       }, 30_000);
       check();`
    );

    if (after.timedOut) {
      throw new Error(`timed out waiting for anchored all-lines geometry: ${JSON.stringify(after)}`);
    }

    const allLinesState = await getContextToggleState(client);
    expect(allLinesState).toEqual({ text: "All lines", active: true });
    expect(after.filePath).toBe(before!.filePath);
    expect(after.lineNumber).toBe(before!.lineNumber);
    expect(after.lineType).toBe(before!.lineType);
    expect(Math.abs(after.viewportOffset - before!.viewportOffset)).toBeLessThanOrEqual(2);
    expect(after.scrollTop).toBeGreaterThan(before!.scrollTop + 1_000);
    expect(after.scrollHeight).toBeGreaterThan(before!.scrollHeight);
  });

  it("expands Branch diff hidden context lines with the keyboard shortcut", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);

    await tauriInvoke(client, "run_script", {
      script: [
        "cat > e2e-all-lines-context.txt <<'EOF'",
        "all-lines hidden top marker",
        "all-lines context 02",
        "all-lines context 03",
        "all-lines context 04",
        "all-lines context 05",
        "all-lines context 06",
        "all-lines context 07",
        "branch all-lines changed center marker",
        "all-lines context 09",
        "all-lines context 10",
        "all-lines context 11",
        "all-lines context 12",
        "all-lines context 13",
        "all-lines context 14",
        "all-lines hidden bottom marker",
        "EOF",
        "git add e2e-all-lines-context.txt",
        "git commit -m 'e2e branch all-lines context change'",
      ].join("\n"),
      cwd: worktreePath,
      env: {},
    });

    await openDiffModal(client);
    await setDiffScope(client, "Branch");

    const compactState = await getContextToggleState(client);
    expect(compactState).toEqual({ text: "Context", active: false });

    const compactText = await waitForDiffText(
      client,
      `return text.includes("branch all-lines changed center marker")
        && !text.includes("all-lines hidden top marker")
        && !text.includes("all-lines hidden bottom marker");`,
    );
    expect(compactText).toContain("branch all-lines changed center marker");
    expect(compactText).not.toContain("all-lines hidden top marker");
    expect(compactText).not.toContain("all-lines hidden bottom marker");

    await client.executeSync(buildGlobalKeydownScript({ key: "a" }));

    const allLinesText = await waitForDiffText(
      client,
      `return text.includes("branch all-lines changed center marker")
        && text.includes("all-lines hidden top marker")
        && text.includes("all-lines hidden bottom marker");`,
    );
    expect(allLinesText).toContain("branch all-lines changed center marker");
    expect(allLinesText).toContain("all-lines hidden top marker");
    expect(allLinesText).toContain("all-lines hidden bottom marker");

    const allLinesState = await getContextToggleState(client);
    expect(allLinesState).toEqual({ text: "All lines", active: true });
  });

  it("skips an oversized diff line while rendering a normal changed file", async () => {
    const branch = await getSelectedTaskBranch();

    const worktreePath = `${testRepoPath}/.kanna-worktrees/${branch}`;
    const oversizedScript = [
      "mkdir -p diff-oversized",
      "printf 'normal baseline\\n' > diff-oversized/normal.txt",
      "printf 'small baseline\\n' > diff-oversized/huge.txt",
      "git add diff-oversized/normal.txt diff-oversized/huge.txt",
      "git commit -m 'add oversized diff e2e fixtures'",
      "printf 'normal changed marker\\n' > diff-oversized/normal.txt",
      "awk 'BEGIN { for (i = 0; i < 260001; i++) printf \"x\"; printf \"\\n\" }' > diff-oversized/huge.txt",
    ].join("\n");

    await tauriInvoke(client, "run_script", {
      script: oversizedScript,
      cwd: worktreePath,
      env: {},
    });

    const patch = await tauriInvoke(client, "git_diff", {
      repoPath: worktreePath,
      mode: "all",
    });
    expect(typeof patch).toBe("string");
    expect(String(patch)).toContain("diff --git a/diff-oversized/normal.txt b/diff-oversized/normal.txt");
    expect(String(patch)).toContain("diff --git a/diff-oversized/huge.txt b/diff-oversized/huge.txt");

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".diff-view", 2_000);
    await sleep(250);
    await client.executeSync(buildGlobalKeydownScript({ key: "d", meta: true }));
    await client.waitForElement(".diff-view", 5_000);

    const result = await client.executeAsync<{
      normalHeaderVisible: boolean;
      normalRendered: boolean;
      oversizedHeaderVisible: boolean;
      oversizedSkipped: boolean;
      oversizedRendered: boolean;
      skippedText: string;
      timedOut?: boolean;
      headers?: string[];
    }>(
      `const cb = arguments[arguments.length - 1];
       let done = false;
       const finish = (value) => {
         if (done) return;
         done = true;
         clearInterval(interval);
         clearTimeout(timeout);
         cb(value);
       };
       const readWrapper = (path) => {
         const wrappers = Array.from(document.querySelectorAll(".diff-container .diff-file"));
         const wrapper = wrappers.find((candidate) => {
           const header = candidate.querySelector(".diff-file-header");
           return (header?.getAttribute("title") || header?.textContent || "") === path;
         });
         if (!wrapper) return null;
         const renderedText = Array.from(wrapper.querySelectorAll("diffs-container"))
           .map((container) => container.shadowRoot?.textContent || container.textContent || "")
           .join("\\n");
         const skipped = wrapper.querySelector(".diff-file-skipped");
         return {
           renderedText,
           skippedText: skipped?.textContent || "",
           hasRenderedContainer: Boolean(wrapper.querySelector("diffs-container")),
         };
       };
       const snapshot = () => {
         const normal = readWrapper("diff-oversized/normal.txt");
         const oversized = readWrapper("diff-oversized/huge.txt");
         return {
           normalHeaderVisible: Boolean(normal),
           normalRendered: Boolean(normal?.renderedText.includes("normal changed marker")),
           oversizedHeaderVisible: Boolean(oversized),
           oversizedSkipped: oversized?.skippedText === "Large diff omitted to keep the viewer responsive.",
           oversizedRendered: Boolean(oversized?.hasRenderedContainer),
           skippedText: oversized?.skippedText || "",
         };
       };
       const maybeFinish = () => {
         const current = snapshot();
         if (current.normalRendered && current.oversizedSkipped) finish(current);
       };
       const interval = setInterval(maybeFinish, 25);
       const timeout = setTimeout(() => {
         finish({
           ...snapshot(),
           timedOut: true,
           headers: Array.from(document.querySelectorAll(".diff-file-header"))
             .map((header) => header.getAttribute("title") || header.textContent || ""),
         });
       }, 30000);
       maybeFinish();`
    );

    if (result.timedOut) {
      throw new Error(`timed out waiting for oversized diff guard: ${JSON.stringify(result)}`);
    }

    expect(result.normalHeaderVisible).toBe(true);
    expect(result.normalRendered).toBe(true);
    expect(result.oversizedHeaderVisible).toBe(true);
    expect(result.oversizedSkipped).toBe(true);
    expect(result.oversizedRendered).toBe(false);
    expect(result.skippedText).toBe("Large diff omitted to keep the viewer responsive.");

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".diff-view", 2_000);
  });

  it("keeps diff content clear of the vertical scrollbar lane", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    const scrollbarFile = "e2e-scrollbar-gutter.txt";

    await tauriInvoke(client, "run_script", {
      script: `for i in $(seq 1 220); do printf '# scrollbar gutter e2e %03d\n' "$i"; done > ${scrollbarFile}`,
      cwd: worktreePath,
      env: {},
    });

    await openDiffModal(client);
    await waitForDiffText(client, `return text.includes(${JSON.stringify(scrollbarFile)});`);
    await waitForDiffScrollHeight(client, 1_200);

    const result = await client.executeSync<{
      hasVerticalOverflow: boolean;
      paddingInlineEnd: number;
      contentGap: number;
    } | null>(
      `const container = document.querySelector(".diff-container");
       const wrapper = Array.from(document.querySelectorAll(".diff-file")).find((element) => {
         const header = element.querySelector(".diff-file-header");
         return (header?.getAttribute("title") || header?.textContent || "") === ${JSON.stringify(scrollbarFile)};
       });
       if (!(container instanceof HTMLElement) || !(wrapper instanceof HTMLElement)) return null;
       const containerRect = container.getBoundingClientRect();
       const wrapperRect = wrapper.getBoundingClientRect();
       return {
         hasVerticalOverflow: container.scrollHeight > container.clientHeight,
         paddingInlineEnd: Number.parseFloat(getComputedStyle(container).paddingInlineEnd),
         contentGap: containerRect.right - wrapperRect.right,
       };`
    );

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.hasVerticalOverflow).toBe(true);
    expect(result.paddingInlineEnd).toBe(12);
    expect(result.contentGap).toBeGreaterThanOrEqual(result.paddingInlineEnd);
  });

  it("keeps the sticky diff file header flush with the diff scroller", async () => {
    const branch = await getSelectedTaskBranch();

    const worktreePath = `${testRepoPath}/.kanna-worktrees/${branch}`;

    const stickyFile = "e2e-sticky-diff.txt";

    await tauriInvoke(client, "run_script", {
      script: `for i in $(seq 1 220); do printf '# sticky visual e2e %03d\\n' "$i"; done > ${stickyFile}`,
      cwd: worktreePath,
      env: {},
    });

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
    await client.waitForNoElement(".diff-view", 2_000);
    await sleep(250);
    await client.executeSync(buildGlobalKeydownScript({ key: "d", meta: true }));
    await client.waitForElement(".diff-view", 5_000);

    const result = await client.executeAsync<{
      containerTop: number;
      headerTop: number;
      headerBottom: number;
      scrollTop: number;
      stickyTop: string;
      headerCount?: number;
      renderedHeaderCount?: number;
      headerLabels?: string[];
      wrapperHeight?: number;
      timedOut?: boolean;
    }>(
      `const cb = arguments[arguments.length - 1];
       let done = false;
       const finish = (value) => {
         if (done) return;
         done = true;
         clearInterval(interval);
         clearTimeout(timeout);
         cb(value);
       };
       const readWrapper = () => {
         const container = document.querySelector(".diff-container");
         const wrappers = Array.from(document.querySelectorAll(".diff-file"));
         const wrapper = wrappers.find((element) => {
           const header = element.querySelector(".diff-file-header");
           return (header?.getAttribute("title") || header?.textContent || "") === ${JSON.stringify(stickyFile)};
         });
         const header = wrapper?.querySelector(".diff-file-header");
         const renderedContainer = wrapper?.querySelector("diffs-container");
         return { container, wrapper, header, renderedContainer };
       };
       const measure = () => {
         const { container, wrapper, header, renderedContainer } = readWrapper();
         if (!container || !wrapper || !header) return;
         if (!renderedContainer) return;
         const beforeContainerRect = container.getBoundingClientRect();
         if (beforeContainerRect.height <= 0) return;
         if (container.scrollHeight <= container.clientHeight) return;

         container.scrollTop = Math.min(
           wrapper.offsetTop + 40,
           Math.max(0, container.scrollHeight - container.clientHeight)
         );
         setTimeout(() => {
           const containerRect = container.getBoundingClientRect();
           const headerRect = header.getBoundingClientRect();
           const headers = Array.from(document.querySelectorAll(".diff-file-header"));
           finish({
             containerTop: containerRect.top,
             headerTop: headerRect.top,
             headerBottom: headerRect.bottom,
             scrollTop: container.scrollTop,
             stickyTop: getComputedStyle(header).top,
             headerCount: headers.length,
             renderedHeaderCount: Array.from(document.querySelectorAll(".diff-file"))
               .filter((element) =>
                 element.querySelector(".diff-file-header") &&
                 element.querySelector("diffs-container")
               ).length,
             wrapperHeight: wrapper.getBoundingClientRect().height,
             containerScrollHeight: container.scrollHeight,
             containerClientHeight: container.clientHeight,
           });
         }, 50);
       };
       const interval = setInterval(measure, 25);
       const timeout = setTimeout(() => {
         finish({
           timedOut: true,
           containerTop: 0,
           headerTop: 0,
           headerBottom: 0,
           scrollTop: 0,
           stickyTop: "",
           headerCount: document.querySelectorAll(".diff-file-header").length,
           renderedHeaderCount: Array.from(document.querySelectorAll(".diff-file"))
             .filter((element) =>
               element.querySelector(".diff-file-header") &&
               element.querySelector("diffs-container")
             ).length,
           containerScrollHeight: document.querySelector(".diff-container")?.scrollHeight ?? 0,
           containerClientHeight: document.querySelector(".diff-container")?.clientHeight ?? 0,
           wrapperHeight: (() => {
             const wrapper = Array.from(document.querySelectorAll(".diff-file")).find((element) => {
               const header = element.querySelector(".diff-file-header");
               return (header?.getAttribute("title") || header?.textContent || "") === ${JSON.stringify(stickyFile)};
             });
             return wrapper instanceof HTMLElement ? wrapper.getBoundingClientRect().height : 0;
           })(),
           headerLabels: Array.from(document.querySelectorAll(".diff-file-header"))
             .map((element) => element.getAttribute("title") || element.textContent || ""),
         });
       }, 20000);
       measure();`
    );

    if (result.timedOut) {
      throw new Error(`timed out waiting for rendered sticky diff header: ${JSON.stringify(result)}`);
    }

    expect(result.scrollTop).toBeGreaterThan(0);
    expect(result.stickyTop).toBe("-1px");
    expect(result.headerTop).toBeLessThan(result.containerTop);
    expect(result.headerBottom).toBeGreaterThan(result.containerTop);
  });

  it("restores per-scope scroll positions when switching Working and Branch diffs", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    const scrollSetupScript = [
      "cat > e2e-scroll-branch.txt <<'EOF'",
      "branch scroll marker",
      "EOF",
      "for i in $(seq 1 260); do printf 'branch scroll line %03d\\n' \"$i\" >> e2e-scroll-branch.txt; done",
      "git add e2e-scroll-branch.txt",
      "git commit -m 'e2e branch scroll content'",
      "cat > e2e-scroll-working.txt <<'EOF'",
      "working scroll marker",
      "EOF",
      "for i in $(seq 1 260); do printf 'working scroll line %03d\\n' \"$i\" >> e2e-scroll-working.txt; done",
    ].join("\n");

    await tauriInvoke(client, "run_script", {
      script: scrollSetupScript,
      cwd: worktreePath,
      env: {},
    });

    try {
      await openDiffModal(client);
      await setDiffScope(client, "Working");
      await waitForDiffText(client, `return text.includes("working scroll marker");`);
      await waitForDiffScrollHeight(client, 1_200);

      const workingScrollTop = await client.executeSync<number>(
        `const container = document.querySelector(".diff-container");
         if (!(container instanceof HTMLElement)) return 0;
         container.scrollTop = 640;
         container.dispatchEvent(new Event("scroll", { bubbles: true }));
         return container.scrollTop;`
      );
      expect(workingScrollTop).toBeGreaterThan(0);

      await setDiffScope(client, "Branch");
      await waitForDiffText(client, `return text.includes("branch scroll marker");`);
      await waitForDiffScrollHeight(client, 1_200);

      const branchScrollTop = await client.executeSync<number>(
        `const container = document.querySelector(".diff-container");
         if (!(container instanceof HTMLElement)) return 0;
         container.scrollTop = 420;
         container.dispatchEvent(new Event("scroll", { bubbles: true }));
         return container.scrollTop;`
      );
      expect(branchScrollTop).toBeGreaterThan(0);

      await setDiffScope(client, "Working");
      await waitForDiffText(client, `return text.includes("working scroll marker");`);
      const restoredWorking = await client.executeAsync<number>(
        `const cb = arguments[arguments.length - 1];
         const expected = ${workingScrollTop};
         const read = () => {
           const container = document.querySelector(".diff-container");
           return container instanceof HTMLElement ? container.scrollTop : 0;
         };
         let done = false;
         const finish = (value) => {
           if (done) return;
           done = true;
           clearInterval(interval);
           clearTimeout(timeout);
           cb(value);
         };
         const check = () => {
           const current = read();
           if (Math.abs(current - expected) <= 2) finish(current);
         };
         const interval = setInterval(check, 50);
         const timeout = setTimeout(() => finish(read()), 3000);
         check();`
      );
      expect(Math.abs(restoredWorking - workingScrollTop)).toBeLessThanOrEqual(2);

      await setDiffScope(client, "Branch");
      await waitForDiffText(client, `return text.includes("branch scroll marker");`);
      const restoredBranch = await client.executeAsync<number>(
        `const cb = arguments[arguments.length - 1];
         const expected = ${branchScrollTop};
         const read = () => {
           const container = document.querySelector(".diff-container");
           return container instanceof HTMLElement ? container.scrollTop : 0;
         };
         let done = false;
         const finish = (value) => {
           if (done) return;
           done = true;
           clearInterval(interval);
           clearTimeout(timeout);
           cb(value);
         };
         const check = () => {
           const current = read();
           if (Math.abs(current - expected) <= 2) finish(current);
         };
         const interval = setInterval(check, 50);
         const timeout = setTimeout(() => finish(read()), 3000);
         check();`
      );
      expect(Math.abs(restoredBranch - branchScrollTop)).toBeLessThanOrEqual(2);
    } finally {
      await tauriInvoke(client, "run_script", {
        script: [
          "if [ \"$(git log -1 --pretty=%s)\" = 'e2e branch scroll content' ]; then git reset --hard HEAD~1; fi",
          "rm -f e2e-scroll-working.txt",
          "git clean -fd -- e2e-scroll-working.txt",
        ].join("\n"),
        cwd: worktreePath,
        env: {},
      });
    }
  });

  it("loads Branch include modes through the real git diff command path", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    const setupScript = [
      "cat > e2e-branch-include-committed.txt <<'EOF'",
      "committed branch include marker",
      "EOF",
      "cat > e2e-branch-include-unstaged.txt <<'EOF'",
      "unstaged base marker",
      "EOF",
      "git add e2e-branch-include-committed.txt e2e-branch-include-unstaged.txt",
      "git commit -m 'e2e branch include committed content'",
      "cat > e2e-branch-include-staged.txt <<'EOF'",
      "staged branch include marker",
      "EOF",
      "git add e2e-branch-include-staged.txt",
      "printf '\\nunstaged branch include marker\\n' >> e2e-branch-include-unstaged.txt",
      "cat > e2e-branch-include-untracked.txt <<'EOF'",
      "untracked branch include marker",
      "EOF",
    ].join("\n");

    await tauriInvoke(client, "run_script", {
      script: setupScript,
      cwd: worktreePath,
      env: {},
    });

    try {
      await openDiffModal(client);
      await setDiffScope(client, "Branch");

      const noneText = await waitForDiffText(
        client,
        `return text.includes("committed branch include marker")
          && !text.includes("staged branch include marker")
          && !text.includes("unstaged branch include marker")
          && !text.includes("untracked branch include marker");`,
      );
      expect(noneText).toContain("committed branch include marker");
      expect(noneText).not.toContain("staged branch include marker");
      expect(noneText).not.toContain("unstaged branch include marker");
      expect(noneText).not.toContain("untracked branch include marker");

      await clickDiffToolbarButton(client, "Committed");
      const stagedText = await waitForDiffText(
        client,
        `return text.includes("staged branch include marker")
          && !text.includes("unstaged branch include marker")
          && !text.includes("untracked branch include marker");`,
      );
      expect(stagedText).toContain("committed branch include marker");
      expect(stagedText).toContain("staged branch include marker");
      expect(stagedText).not.toContain("unstaged branch include marker");
      expect(stagedText).not.toContain("untracked branch include marker");

      await clickDiffToolbarButton(client, "Staged");
      const allText = await waitForDiffText(
        client,
        `return text.includes("staged branch include marker")
          && text.includes("unstaged branch include marker")
          && text.includes("untracked branch include marker");`,
      );
      expect(allText).toContain("committed branch include marker");
      expect(allText).toContain("staged branch include marker");
      expect(allText).toContain("unstaged branch include marker");
      expect(allText).toContain("untracked branch include marker");
    } finally {
      await tauriInvoke(client, "run_script", {
        script: [
          "git reset --hard HEAD",
          "if [ \"$(git log -1 --pretty=%s)\" = 'e2e branch include committed content' ]; then git reset --hard HEAD~1; fi",
          "git clean -fd -- e2e-branch-include-committed.txt e2e-branch-include-staged.txt e2e-branch-include-unstaged.txt e2e-branch-include-untracked.txt",
        ].join("\n"),
        cwd: worktreePath,
        env: {},
      });
    }
  });

  it("keeps the Branch diff on the task's own base after the PR stage renames and pushes the branch", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    const taskBranch = await getSelectedTaskBranch();
    const prBranch = "fix/e2e-pr-stage-rename";

    // The PR stage renames the task branch to a meaningful name and pushes it,
    // which points the branch upstream at its own remote copy. That copy holds
    // the same commits, so it must not become the diff base.
    await tauriInvoke(client, "run_script", {
      script: [
        "cat > e2e-pr-rename-committed.txt <<'EOF'",
        "pr rename committed marker",
        "EOF",
        "git add e2e-pr-rename-committed.txt",
        "git commit -m 'e2e pr rename committed content'",
        `git branch -m ${prBranch}`,
        "git push -u origin HEAD",
      ].join("\n"),
      cwd: worktreePath,
      env: {},
    });

    try {
      await openDiffModal(client);
      await setDiffScope(client, "Branch");

      const branchText = await waitForDiffText(
        client,
        `return text.includes("pr rename committed marker");`,
      );
      expect(branchText).toContain("pr rename committed marker");
    } finally {
      await tauriInvoke(client, "run_script", {
        script: [
          `git push origin --delete ${prBranch} || true`,
          `git branch -m ${taskBranch}`,
          "git branch --unset-upstream || true",
          "git reset --hard HEAD",
          "if [ \"$(git log -1 --pretty=%s)\" = 'e2e pr rename committed content' ]; then git reset --hard HEAD~1; fi",
          "git clean -fd -- e2e-pr-rename-committed.txt",
        ].join("\n"),
        cwd: worktreePath,
        env: {},
      });
    }
  });

  it("sends pending review comments as a request-revision prompt and approves via advance-stage", async () => {
    const taskId = await client.executeSync<string>(
      `const ctx = window.__KANNA_E2E__.setupState;
       return ctx.selectedItem().id;`
    );
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    await tauriInvoke(client, "run_script", {
      script: [
        "mkdir -p native-review-e2e",
        "cat > native-review-e2e/review.ts <<'EOF'",
        "export const marker001 = 'before-001';",
        "export const marker002 = 'before-002';",
        "export const marker003 = 'before-003';",
        "export const marker004 = 'before-004';",
        "export const marker005 = 'before-005';",
        "export const marker006 = 'before-006';",
        "export const marker007 = 'before-007';",
        "export const marker008 = 'before-008';",
        "export const marker009 = 'before-009';",
        "export const marker010 = 'before-010';",
        "export const marker011 = 'before-011';",
        "export const marker012 = 'before-012';",
        "export const marker013 = 'before-013';",
        "export const marker014 = 'before-014';",
        "export const marker015 = 'before-015';",
        "export const marker016 = 'before-016';",
        "export const marker017 = 'before-017';",
        "export const marker018 = 'before-018';",
        "export const marker019 = 'before-019';",
        "export const marker020 = 'before-020';",
        "export const marker021 = 'before-021';",
        "export const marker022 = 'before-022';",
        "export const marker023 = 'before-023';",
        "export const marker024 = 'before-024';",
        "export const marker025 = 'before-025';",
        "export const marker026 = 'before-026';",
        "export const marker027 = 'before-027';",
        "export const marker028 = 'before-028';",
        "export const marker029 = 'before-029';",
        "export const marker030 = 'before-030';",
        "export const marker031 = 'before-031';",
        "export const marker032 = 'before-032';",
        "export const marker033 = 'before-033';",
        "export const marker034 = 'before-034';",
        "export const marker035 = 'before-035';",
        "export const marker036 = 'before-036';",
        "export const marker037 = 'before-037';",
        "export const marker038 = 'before-038';",
        "export const marker039 = 'before-039';",
        "export const marker040 = 'before-040';",
        "export const marker041 = 'before-041';",
        "export const marker042 = 'before-042';",
        "export const marker043 = 'before-043';",
        "export const marker044 = 'before-044';",
        "export const marker045 = 'before-045';",
        "export const marker046 = 'before-046';",
        "export const marker047 = 'before-047';",
        "export const marker048 = 'before-048';",
        "export const marker049 = 'before-049';",
        "export const marker050 = 'before-050';",
        "export const marker051 = 'before-051';",
        "export const marker052 = 'before-052';",
        "export const marker053 = 'before-053';",
        "export const marker054 = 'before-054';",
        "export const marker055 = 'before-055';",
        "export const marker056 = 'before-056';",
        "export const marker057 = 'before-057';",
        "export const marker058 = 'before-058';",
        "export const marker059 = 'before-059';",
        "export const marker060 = 'before-060';",
        "export const marker061 = 'before-061';",
        "export const marker062 = 'before-062';",
        "export const marker063 = 'before-063';",
        "export const marker064 = 'before-064';",
        "export const marker065 = 'before-065';",
        "export const marker066 = 'before-066';",
        "export const marker067 = 'before-067';",
        "export const marker068 = 'before-068';",
        "export const marker069 = 'before-069';",
        "export const marker070 = 'before-070';",
        "export const marker071 = 'before-071';",
        "export const marker072 = 'before-072';",
        "export const marker073 = 'before-073';",
        "export const marker074 = 'before-074';",
        "export const marker075 = 'before-075';",
        "export const marker076 = 'before-076';",
        "export const marker077 = 'before-077';",
        "export const marker078 = 'before-078';",
        "export const marker079 = 'before-079';",
        "export const marker080 = 'before-080';",
        "export const marker081 = 'before-081';",
        "export const marker082 = 'before-082';",
        "export const marker083 = 'before-083';",
        "export const marker084 = 'before-084';",
        "export const marker085 = 'before-085';",
        "export const marker086 = 'before-086';",
        "export const marker087 = 'before-087';",
        "export const marker088 = 'before-088';",
        "export const marker089 = 'before-089';",
        "export const marker090 = 'before-090';",
        "EOF",
        "git add native-review-e2e/review.ts",
        "git commit -m 'e2e native review branch content'",
      ].join("\n"),
      cwd: worktreePath,
      env: {},
    });
    const headCommit = String(await tauriInvoke(client, "run_script", {
      script: "git rev-parse HEAD",
      cwd: worktreePath,
      env: {},
    })).trim();

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       const item = ctx.selectedItem();
       db.execute("UPDATE pipeline_item SET stage = ? WHERE id = ?", ["review", item.id])
         .then(function() { return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    await installStageActionRecorder(client);

    await openDiffModal(client);
    await setDiffScope(client, "Branch");
    await waitForDiffText(client, `return text.includes("native-review-e2e/review.ts");`);
    await addReviewCommentThroughDiffUi(
      client,
      "native-review-e2e/review.ts",
      2,
      "Change the second marker.",
    );
    await waitForReviewCommentCount(client, 1);
    await addReviewCommentThroughDiffUi(
      client,
      "native-review-e2e/review.ts",
      80,
      "Change the eightieth marker.",
    );
    await waitForReviewCommentCount(client, 2);

    await client.executeSync(buildGlobalKeydownScript({ key: "s", meta: true, shift: true }));
    await client.waitForElement(".summary-composer", 2_000);
    const summaryTextarea = await client.findElement(".summary-composer textarea");
    await client.sendKeys(summaryTextarea, "Please apply both review notes.");
    await client.click(await client.findElement(".summary-actions .primary"));

    const callsAfterRequest = await waitForRecordedStageActions(client, 1);
    const requestCall = callsAfterRequest[0];
    expect(requestCall.url).toContain(`/v1/tasks/${encodeURIComponent(taskId)}/actions/request-revision`);
    const requestPayload = JSON.parse(requestCall.body) as {
      targetStage: string;
      summary: string;
      prompt: string;
      origin: string;
    };
    expect(requestPayload.targetStage).toBe("in progress");
    // A revision the user asked for is exempt from the agent revision-round
    // budget and resets it, so the UI must mark its origin.
    expect(requestPayload.origin).toBe("human");
    expect(requestPayload.summary).toBe("Please apply both review notes.");
    expect(requestPayload.prompt).toContain(`Revision requested from review of task-${taskId} @ ${headCommit.slice(0, 8)} (branch diff vs main).`);
    expect(requestPayload.prompt).toContain("native-review-e2e/review.ts:2");
    expect(requestPayload.prompt).toContain("> export const marker002 = 'before-002';");
    expect(requestPayload.prompt).toContain("Change the second marker.");
    expect(requestPayload.prompt).toContain("native-review-e2e/review.ts:80");
    expect(requestPayload.prompt).toContain("> export const marker080 = 'before-080';");
    expect(requestPayload.prompt).toContain("Change the eightieth marker.");
    expect(requestPayload.prompt).toContain("Overall: Please apply both review notes.");

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       const item = ctx.selectedItem();
       db.execute("UPDATE pipeline_item SET stage = ? WHERE id = ?", ["review", item.id])
         .then(function() { return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    await openDiffModal(client);
    await setDiffScope(client, "Branch");
    await client.executeSync(buildGlobalKeydownScript({ key: "s", meta: true }));

    const callsAfterApprove = await waitForRecordedStageActions(client, 2);
    expect(callsAfterApprove[1].url).toContain(`/v1/tasks/${encodeURIComponent(taskId)}/actions/advance-stage`);
    expect(callsAfterApprove[1].method).toBe("POST");
  });

  const E2E_PR_APPROVE_WORKFLOW_DEF = JSON.stringify({
    name: "default",
    stages: [
      { name: "in progress", policy: { transition: "manual" } },
      { name: "review", policy: { transition: "auto" } },
      {
        name: "pr",
        policy: { transition: "manual" },
        post: { name: "approve", agent: "approve", prompt: "Approve $PREV_RESULT" },
      },
    ],
  });

  const E2E_PR_NO_POST_WORKFLOW_DEF = JSON.stringify({
    name: "custom",
    stages: [
      { name: "in progress", policy: { transition: "manual" } },
      { name: "pr", policy: { transition: "manual" } },
    ],
  });

  async function parkSelectedTaskAtPr(workflowDef: string): Promise<{ id: string }> {
    const task = await client.executeSync<{ id: string }>(
      `const ctx = window.__KANNA_E2E__.setupState;
       return { id: ctx.selectedItem().id };`
    );
    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       db.execute("UPDATE pipeline_item SET stage = ?, pipeline_def = ? WHERE id = ?", ["pr", ${JSON.stringify(workflowDef)}, ${JSON.stringify(task.id)}])
         .then(function() { return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    return task;
  }

  async function restoreSharedFixtureTask(taskId: string): Promise<void> {
    const result = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       (async () => {
         await db.execute("DELETE FROM stage_run WHERE id = ?", [${JSON.stringify(`e2e-post-${taskId}`)}]);
         await db.execute(
           "UPDATE pipeline_item SET closed_at = NULL, stage = ?, pipeline_def = NULL WHERE id = ?",
           ["in progress", ${JSON.stringify(taskId)}],
         );
         await ctx.refreshAllItems();
         cb("ok");
       })().catch(function(e) { cb("err:" + e); });`
    );
    expect(result).toBe("ok");
  }

  it("parks a pr-stage approve behind the running approve post and keeps approval single-flight", async () => {
    const task = await parkSelectedTaskAtPr(E2E_PR_APPROVE_WORKFLOW_DEF);
    await installStageActionRecorder(client);

    await openDiffModal(client);
    await client.waitForElement(".verdict-bar .approve", 2_000);
    const approveLabel = await client.executeSync<string>(
      `return document.querySelector(".verdict-bar .approve").textContent.trim();`
    );
    expect(approveLabel).toBe("Approve & Merge");
    await client.click(await client.findElement(".verdict-bar .approve"));

    const calls = await waitForRecordedStageActions(client, 1);
    expect(calls[0].url).toContain(`/v1/tasks/${encodeURIComponent(task.id)}/actions/advance-stage`);
    expect(calls[0].method).toBe("POST");

    // Production: the task stays open at pr while the approve post runs.
    const parkedState = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const taskId = ${JSON.stringify(task.id)};
       const read = () => {
         const items = ctx.store?.items?.value ?? ctx.store?.items ?? [];
         return (items || []).find((candidate) => candidate.id === taskId) || null;
       };
       const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
       (async () => {
         const deadline = Date.now() + 10000;
         while (Date.now() < deadline) {
           const item = read();
           if (item && item.has_running_post && item.closed_at == null && item.stage === "pr") {
             cb("parked-with-running-post");
             return;
           }
           await wait();
         }
         const item = read();
         cb("timeout: " + JSON.stringify(item && { stage: item.stage, closed_at: item.closed_at, has_running_post: item.has_running_post }));
       })().catch(function(e) { cb("err:" + e); });`
    );
    expect(parkedState).toBe("parked-with-running-post");

    // Single-flight: the approve button is disabled and a repeated click or
    // Cmd+S must not send a second ordinary advance while the post runs.
    const approveDisabled = await client.executeSync<boolean>(
      `return document.querySelector(".verdict-bar .approve").disabled;`
    );
    expect(approveDisabled).toBe(true);
    await client.executeSync(
      `document.querySelector(".verdict-bar .approve").click();`
    );
    await client.executeSync(buildGlobalKeydownScript({ key: "s", meta: true }));
    await sleep(500);
    const callsAfterRepeat = await waitForRecordedStageActions(client, 1);
    expect(callsAfterRepeat).toHaveLength(1);

    // The post's successful completion — not the advance — closes the task.
    const closedState = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       const taskId = ${JSON.stringify(task.id)};
       const isClosed = () => {
         const items = ctx.store?.items?.value ?? ctx.store?.items ?? [];
         const item = (items || []).find((candidate) => candidate.id === taskId);
         return !item || item.closed_at != null;
       };
       (async () => {
         await db.execute(
           "UPDATE stage_run SET status = 'succeeded', finished_at = datetime('now') WHERE id = ?",
           [${JSON.stringify(`e2e-post-${task.id}`)}],
         );
         await db.execute("UPDATE pipeline_item SET closed_at = ? WHERE id = ?", [new Date().toISOString(), taskId]);
         await ctx.refreshAllItems();
         cb(isClosed() ? "closed-after-post" : "still-open");
       })().catch(function(e) { cb("err:" + e); });`
    );
    expect(closedState).toBe("closed-after-post");

    await restoreSharedFixtureTask(task.id);
  });

  it("keeps approval generic and closing for pinned workflows without an approve post", async () => {
    const task = await parkSelectedTaskAtPr(E2E_PR_NO_POST_WORKFLOW_DEF);
    await installStageActionRecorder(client);

    await openDiffModal(client);
    await client.waitForElement(".verdict-bar .approve", 2_000);
    const approveLabel = await client.executeSync<string>(
      `return document.querySelector(".verdict-bar .approve").textContent.trim();`
    );
    expect(approveLabel).toBe("Approve");
    await client.click(await client.findElement(".verdict-bar .approve"));

    const calls = await waitForRecordedStageActions(client, 1);
    expect(calls[0].url).toContain(`/v1/tasks/${encodeURIComponent(task.id)}/actions/advance-stage`);

    // With no post on the pinned final stage, the advance itself closes the
    // task — approval never claims merge behavior it cannot deliver.
    const closedState = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const taskId = ${JSON.stringify(task.id)};
       const isClosed = () => {
         const items = ctx.store?.items?.value ?? ctx.store?.items ?? [];
         const item = (items || []).find((candidate) => candidate.id === taskId);
         return !item || item.closed_at != null;
       };
       const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
       (async () => {
         const deadline = Date.now() + 10000;
         while (!isClosed() && Date.now() < deadline) await wait();
         cb(isClosed() ? "closed" : "still-open");
       })().catch(function(e) { cb("err:" + e); });`
    );
    expect(closedState).toBe("closed");

    await restoreSharedFixtureTask(task.id);
  });

  it("keeps pending review comments and summary draft when request-revision fails", async () => {
    const taskId = await client.executeSync<string>(
      `const ctx = window.__KANNA_E2E__.setupState;
       return ctx.selectedItem().id;`
    );
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    await tauriInvoke(client, "run_script", {
      script: [
        "mkdir -p native-review-e2e",
        "for i in $(seq 1 40); do printf 'export const failingMarker%03d = \"before-%03d\";\\n' \"$i\" \"$i\"; done > native-review-e2e/failing-request.ts",
        "git add native-review-e2e/failing-request.ts",
        "git commit -m 'e2e native review failed request content'",
      ].join("\n"),
      cwd: worktreePath,
      env: {},
    });

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       const item = ctx.selectedItem();
       db.execute("UPDATE pipeline_item SET stage = ? WHERE id = ?", ["review", item.id])
         .then(function() { return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    await installStageActionRecorder(client, {
      requestRevisionStatus: 500,
      requestRevisionBody: "mock request revision failure",
    });

    await openDiffModal(client);
    await setDiffScope(client, "Branch");
    await waitForDiffText(client, `return text.includes("native-review-e2e/failing-request.ts");`);
    await addReviewCommentThroughDiffUi(
      client,
      "native-review-e2e/failing-request.ts",
      12,
      "Keep this note after the failed request.",
    );
    await waitForReviewCommentCount(client, 1);

    await client.executeSync(buildGlobalKeydownScript({ key: "s", meta: true, shift: true }));
    await client.waitForElement(".summary-composer", 2_000);
    const summaryTextarea = await client.findElement(".summary-composer textarea");
    await client.sendKeys(summaryTextarea, "This draft should survive.");
    await client.click(await client.findElement(".summary-actions .primary"));

    const calls = await waitForRecordedStageActions(client, 1);
    expect(calls[0].url).toContain(`/v1/tasks/${encodeURIComponent(taskId)}/actions/request-revision`);
    await client.waitForElement(".summary-composer", 2_000);
    await waitForReviewCommentCount(client, 1);
    const retainedDraft = await client.executeSync<string>(
      `const textarea = document.querySelector(".summary-composer textarea");
       return textarea instanceof HTMLTextAreaElement ? textarea.value : "";`
    );
    expect(retainedDraft).toBe("This draft should survive.");
    const retainedCommentText = await client.executeSync<string>(
      `return Array.from(document.querySelectorAll(".summary-comment"))
        .map((element) => element.textContent || "")
        .join("\\n");`
    );
    expect(retainedCommentText).toContain("native-review-e2e/failing-request.ts:12");
    expect(retainedCommentText).toContain("Keep this note after the failed request.");
  });

  it("jumps, edits, and deletes pending review comments from the drawer", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    await tauriInvoke(client, "run_script", {
      script: [
        "mkdir -p native-review-e2e",
        "for i in $(seq 1 120); do printf 'export const drawerMarker%03d = \"before-%03d\";\\n' \"$i\" \"$i\"; done > native-review-e2e/drawer.ts",
        "git add native-review-e2e/drawer.ts",
        "git commit -m 'e2e native review drawer content'",
      ].join("\n"),
      cwd: worktreePath,
      env: {},
    });

    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const db = ctx.db.value || ctx.db;
       const item = ctx.selectedItem();
       db.execute("UPDATE pipeline_item SET stage = ? WHERE id = ?", ["review", item.id])
         .then(function() { return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );

    await openDiffModal(client);
    await setDiffScope(client, "Branch");
    await waitForDiffText(client, `return text.includes("native-review-e2e/drawer.ts");`);
    await addReviewCommentThroughDiffUi(
      client,
      "native-review-e2e/drawer.ts",
      2,
      "Edit this note from the drawer.",
    );
    await waitForReviewCommentCount(client, 1);
    await addReviewCommentThroughDiffUi(
      client,
      "native-review-e2e/drawer.ts",
      100,
      "Delete this note from the drawer.",
    );
    await waitForReviewCommentCount(client, 2);
    await ensureCommentDrawerOpen(client);

    await clickCommentDrawerAnchor(client, "native-review-e2e/drawer.ts:100");
    const jumpedScrollTop = await client.executeAsync<number>(
      `const cb = arguments[arguments.length - 1];
       const read = () => {
         const container = document.querySelector(".diff-container");
         return container instanceof HTMLElement ? container.scrollTop : 0;
       };
       let done = false;
       const finish = (value) => {
         if (done) return;
         done = true;
         clearInterval(interval);
         clearTimeout(timeout);
         cb(value);
       };
       const interval = setInterval(() => {
         const top = read();
         if (top > 1000) finish(top);
       }, 50);
       const timeout = setTimeout(() => finish(read()), 3000);`
    );
    expect(jumpedScrollTop).toBeGreaterThan(1000);

    const drawerResult = await client.executeAsync<{ edited: boolean; deleted: boolean; count: number }>(
      `const cb = arguments[arguments.length - 1];
       const cards = Array.from(document.querySelectorAll(".comment-drawer .comment-card"));
       const editCard = cards.find((card) => (card.querySelector(".comment-anchor")?.textContent || "").includes("native-review-e2e/drawer.ts:2"));
       const deleteCard = cards.find((card) => (card.querySelector(".comment-anchor")?.textContent || "").includes("native-review-e2e/drawer.ts:100"));
       const textarea = editCard?.querySelector("textarea");
       if (textarea instanceof HTMLTextAreaElement) {
         const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
         valueSetter?.call(textarea, "Edited from the comment drawer.");
         textarea.dispatchEvent(new Event("input", { bubbles: true }));
       }
       setTimeout(() => {
         const deleteButton = Array.from(deleteCard?.querySelectorAll(".comment-actions button") || [])
           .find((button) => (button.textContent || "").includes("Delete"));
         if (deleteButton instanceof HTMLButtonElement) {
           deleteButton.click();
         }
         setTimeout(() => {
         const ctx = window.__KANNA_E2E__.setupState;
         const stateRef = ctx.appModals?.currentDiffViewState || ctx.currentDiffViewState;
         const state = stateRef?.__v_isRef ? stateRef.value : stateRef;
         const comments = state?.reviewComments || [];
         cb({
           edited: comments.some((comment) => comment.note === "Edited from the comment drawer."),
           deleted: comments.every((comment) => comment.startLine !== 100),
           count: comments.length,
         });
         }, 0);
       }, 0);`
    );
    expect(drawerResult).toEqual({ edited: true, deleted: true, count: 1 });
  });

  it("refreshes an open Branch diff after the task branch history is rewritten", async () => {
    const worktreePath = await getSelectedWorktreePath(client, testRepoPath);
    const setupBeforeScript = [
      "cat > e2e-branch-refresh-before.txt <<'EOF'",
      "branch refresh before rebase marker",
      "EOF",
      "git add e2e-branch-refresh-before.txt",
      "git commit -m 'e2e branch refresh before rewrite'",
    ].join("\n");

    await tauriInvoke(client, "run_script", {
      script: setupBeforeScript,
      cwd: worktreePath,
      env: {},
    });

    try {
      await openDiffModal(client);
      await setDiffScope(client, "Branch");
      await waitForDiffText(
        client,
        `return text.includes("branch refresh before rebase marker");`,
      );

      await tauriInvoke(client, "run_script", {
        script: [
          'git reset --hard "$KANNA_E2E_DIFF_BASELINE_REF"',
          "rm -f e2e-branch-refresh-before.txt",
          "cat > e2e-branch-refresh-after.txt <<'EOF'",
          "branch refresh after rebase marker",
          "EOF",
          "git add e2e-branch-refresh-after.txt",
          "git commit -m 'e2e branch refresh after rewrite'",
        ].join("\n"),
        cwd: worktreePath,
        env: {
          KANNA_E2E_DIFF_BASELINE_REF: taskWorktreeBaselineRef,
        },
      });

      await client.executeSync("window.dispatchEvent(new Event('focus'));");
      const refreshedText = await waitForDiffText(
        client,
        `return text.includes("branch refresh after rebase marker")
          && !text.includes("branch refresh before rebase marker");`,
      );

      expect(refreshedText).toContain("branch refresh after rebase marker");
      expect(refreshedText).not.toContain("branch refresh before rebase marker");
    } finally {
      await tauriInvoke(client, "run_script", {
        script: [
          'git reset --hard "$KANNA_E2E_DIFF_BASELINE_REF"',
          "git clean -fd -- e2e-branch-refresh-before.txt e2e-branch-refresh-after.txt",
        ].join("\n"),
        cwd: worktreePath,
        env: {
          KANNA_E2E_DIFF_BASELINE_REF: taskWorktreeBaselineRef,
        },
      });
    }
  });

  it("shows first diff content before rendering an entire broad diff", async () => {
    const branch = await getSelectedTaskBranch();

    const fileCount = getDiffPerfFileCount();
    const linesPerFile = getDiffPerfLinesPerFile();
    const thresholdMs = getDiffFirstContentThresholdMs();
    const totalChangedLines = fileCount * (linesPerFile + 1);
    const worktreePath = `${testRepoPath}/.kanna-worktrees/${branch}`;
    const createFilesScript = [
      "git add -A",
      "if ! git diff --cached --quiet; then git commit -m 'e2e diff perf baseline'; fi",
      "mkdir -p diff-perf",
      "rm -f diff-perf/Cargo-*.lock",
      `for i in $(seq 1 ${fileCount}); do`,
      "  file=$(printf 'diff-perf/Cargo-%04d.lock' \"$i\")",
      "  {",
      "    printf '# perf lockfile %04d\\n' \"$i\"",
      `    for j in $(seq 1 ${linesPerFile}); do printf '[[package]] name = \"crate-%04d-%04d\" version = \"1.0.%04d\" checksum = \"%032d\"\\n' \"$i\" \"$j\" \"$j\" \"$j\"; done`,
      "  } > \"$file\"",
      "done",
    ].join("\n");

    await tauriInvoke(client, "run_script", {
      script: createFilesScript,
      cwd: worktreePath,
      env: {},
    });

    await resetSelectedDiffViewState(client);
    await sleep(250);

    const result = await client.executeAsync<{
      firstContentMs: number;
      renderedContainerCount: number;
      fileWrapperCount: number;
      timedOut?: boolean;
    }>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       const startedAt = performance.now();
       let done = false;
       const perfFilePrefix = "diff-perf/Cargo-";
       let interval;
        const getPerfWrappers = () =>
          Array.from(document.querySelectorAll(".diff-container .diff-file")).filter((wrapper) => {
            const header = wrapper.querySelector(".diff-file-header");
            const label = header?.getAttribute("title") || header?.textContent || "";
            return label.startsWith(perfFilePrefix);
         });
       const getSnapshot = () => {
         const perfWrappers = getPerfWrappers();
         const renderedContainers = perfWrappers.flatMap((wrapper) =>
           Array.from(wrapper.querySelectorAll("diffs-container"))
         ).filter((container) => {
           const text = container.shadowRoot?.textContent || container.textContent || "";
           return text.includes("perf lockfile");
         });
         const firstRendered = renderedContainers[0];
         return {
           firstRendered,
           renderedContainerCount: renderedContainers.length,
           fileWrapperCount: perfWrappers.length,
         };
       };
       const finish = (value) => {
         if (done) return;
         done = true;
         clearInterval(interval);
         clearTimeout(timeout);
         cb(value);
       };
        const maybeFinish = () => {
          const snapshot = getSnapshot();
         if (!snapshot.firstRendered) return;
         finish({
           firstContentMs: performance.now() - startedAt,
           renderedContainerCount: snapshot.renderedContainerCount,
           fileWrapperCount: snapshot.fileWrapperCount,
         });
       };
       interval = setInterval(() => {
         maybeFinish();
       }, 10);
       const timeout = setTimeout(() => {
         const snapshot = getSnapshot();
         finish({
           timedOut: true,
           firstContentMs: performance.now() - startedAt,
           renderedContainerCount: snapshot.renderedContainerCount,
           fileWrapperCount: snapshot.fileWrapperCount,
         });
       }, 15000);
       window.dispatchEvent(new KeyboardEvent("keydown", {
         key: "d",
         metaKey: true,
         bubbles: true,
         cancelable: true
       }));`
    );

    await appendE2ePerfSummaryLine(formatDiffPerfSummary({
      fileCount,
      linesPerFile,
      totalChangedLines,
      thresholdMs,
      firstContentMs: result.firstContentMs,
      renderedContainerCount: result.renderedContainerCount,
      fileWrapperCount: result.fileWrapperCount,
    }));

    expect(result.timedOut).toBeUndefined();
    expect(result.firstContentMs).toBeLessThan(thresholdMs);
    expect(result.renderedContainerCount).toBeGreaterThan(0);
    expect(result.fileWrapperCount).toBeGreaterThan(0);
    expect(result.renderedContainerCount).toBeLessThanOrEqual(result.fileWrapperCount);
  });
});
