import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { getVueState, tauriInvoke } from "../helpers/vue";
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
  if (!rawValue) return 1500;
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
  const isOpen = await client.executeSync<boolean>(
    `return Boolean(document.querySelector(".diff-view"));`
  );
  if (!isOpen) return;
  await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
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

describe("diff view", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("diff-test");
    testRepoPath = fixtureRepoRoot;
    await importTestRepo(client, testRepoPath, "diff-test");

    // Create a task with worktree but no Claude session (SDK mode, will fail gracefully)
    const repoId = await getVueState(client, "selectedRepoId") as string;
    const id = crypto.randomUUID();
    const branch = `task-${id}`;
    const worktreePath = `${testRepoPath}/.kanna-worktrees/${branch}`;

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
         ["${id}", "${repoId}", "Say OK", "in progress", "${branch}", "sdk"])
         .then(function() { return ctx.loadItems("${repoId}"); })
         .then(function() { ctx.handleSelectItem("${id}"); return ctx.refreshAllItems(); })
         .then(function() { cb("ok"); })
         .catch(function(e) { cb("err:" + e); });`
    );
    await client.waitForText(".sidebar", "Say OK");
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
    const branch = await client.executeSync<string | null>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const item = ctx.selectedItem();
       return item ? (item.branch?.value || item.branch) : null;`
    );
    if (!branch) {
      console.warn("No task selected, skipping diff content test");
      return;
    }

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

  it("skips an oversized diff line while rendering a normal changed file", async () => {
    const branch = await client.executeSync<string | null>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const item = ctx.selectedItem();
       return item ? (item.branch?.value || item.branch) : null;`
    );
    if (!branch) {
      throw new Error("expected selected task to have a worktree branch");
    }

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
       }, 10000);
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

  it("keeps the sticky diff file header flush with the diff scroller", async () => {
    const branch = await client.executeSync<string | null>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const item = ctx.selectedItem();
       return item ? (item.branch?.value || item.branch) : null;`
    );
    if (!branch) {
      throw new Error("expected selected task to have a worktree branch");
    }

    const worktreePath = `${testRepoPath}/.kanna-worktrees/${branch}`;

    await tauriInvoke(client, "run_script", {
      script: "for i in $(seq 1 120); do printf '# sticky visual e2e %03d\\n' \"$i\"; done >> VERSION",
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
       const measure = () => {
         const container = document.querySelector(".diff-container");
         const wrappers = Array.from(document.querySelectorAll(".diff-file"));
         const renderedWrappers = wrappers.filter((element) =>
           element.querySelector(".diff-file-header") &&
           element.querySelector("diffs-container") &&
           element.getBoundingClientRect().height > 140
         );
         const wrapper = renderedWrappers[0];
         const header = wrapper?.querySelector(".diff-file-header");
         if (!(container instanceof HTMLElement) || !(wrapper instanceof HTMLElement) || !(header instanceof HTMLElement)) return;

         container.scrollTop = wrapper.offsetTop + 40;
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
             renderedHeaderCount: renderedWrappers.length,
             wrapperHeight: wrapper.getBoundingClientRect().height,
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
               element.querySelector("diffs-container") &&
               element.getBoundingClientRect().height > 140
             ).length,
           headerLabels: Array.from(document.querySelectorAll(".diff-file-header"))
             .map((element) => element.getAttribute("title") || element.textContent || ""),
         });
       }, 10000);
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

      await clickDiffToolbarButton(client, "None");
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

  it("shows first diff content before rendering an entire broad diff", async () => {
    const branch = await client.executeSync<string | null>(
      `const ctx = window.__KANNA_E2E__.setupState;
       const item = ctx.selectedItem();
       return item ? (item.branch?.value || item.branch) : null;`
    );
    if (!branch) {
      throw new Error("expected selected task to have a worktree branch");
    }

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
         );
         const firstRendered = renderedContainers.find((container) => {
           const text = container.shadowRoot?.textContent || container.textContent || "";
           return text.includes("perf lockfile");
         });
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
  });
});
