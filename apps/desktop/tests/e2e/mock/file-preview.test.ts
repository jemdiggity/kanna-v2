import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { callVueMethod, execDb, tauriInvoke, closeMainTabsScript } from "../helpers/vue";

describe("file preview", () => {
  const client = new WebDriverClient();
  let fixtureRepoPath = "";
  let fixtureRepoId = "";
  const primaryTaskId = "file-preview-primary-task";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoPath = await createSeedFixtureRepo("task-switch-minimal");
    const scrollFixtureDir = join(fixtureRepoPath, "docs", "scroll");
    await mkdir(scrollFixtureDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 80 }, (_, index) => {
        const paddedIndex = String(index).padStart(2, "0");
        return writeFile(
          join(scrollFixtureDir, `entry-${paddedIndex}.md`),
          `# Scroll fixture ${paddedIndex}\n`,
          "utf8",
        );
      }),
    );
    fixtureRepoId = await importTestRepo(client, fixtureRepoPath, "file-preview-fixture");
    await execDb(
      client,
      `INSERT OR REPLACE INTO pipeline_item
         (id, repo_id, prompt, stage, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        primaryTaskId,
        fixtureRepoId,
        "File preview primary fixture task",
        "in progress",
        null,
        "agent",
        "2026-05-08T00:02:00.000Z",
        "2026-05-08T00:02:00.000Z",
      ],
    );
    const refreshResult = await callVueMethod(client, "refreshAllItems");
    if (isVueCallError(refreshResult)) {
      throw new Error(refreshResult.__error);
    }
    await selectTask(primaryTaskId);
  });

  afterAll(async () => {
    await cleanupFixtureRepos(fixtureRepoPath ? [fixtureRepoPath] : []);
    await client.deleteSession();
  });

  async function pressKey(
    key: string,
    opts: { code?: string; meta?: boolean; shift?: boolean; alt?: boolean } = {},
  ) {
    await client.executeSync(buildGlobalKeydownScript({
      key,
      code: opts.code,
      meta: opts.meta,
      shift: opts.shift,
      alt: opts.alt,
    }));
  }

  // Several files can be open at once now, so these read the view that is in
  // front rather than the first one in the DOM.
  const VISIBLE_PREVIEW = `(
    Array.from(document.querySelectorAll(".preview-modal")).find((view) => {
      const rect = view.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
  )`;

  async function previewedFilePath(): Promise<string> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const path = await client.executeSync<string>(
        `const overlay = ${VISIBLE_PREVIEW};
         return overlay?.querySelector(".file-path")?.textContent?.trim() ?? "";`,
      );
      if (path) return path;
      await sleep(150);
    }
    const diagnostic = await client.executeSync<string>(
      `return JSON.stringify({
         previews: Array.from(document.querySelectorAll(".preview-modal")).map((view) => {
           const rect = view.getBoundingClientRect();
           return { w: rect.width, h: rect.height, path: view.querySelector(".file-path")?.textContent };
         }),
         tabs: Array.from(document.querySelectorAll('[data-testid^="main-tab-"]'))
           .map((tab) => tab.getAttribute("data-testid")),
         panel: (() => { const p = document.querySelector(".main-panel")?.getBoundingClientRect();
           return p ? { w: p.width, h: p.height } : null; })(),
       });`,
    );
    throw new Error(`no file preview is in front: ${diagnostic}`);
  }

  async function isPreviewVisible(): Promise<boolean> {
    return await client.executeSync<boolean>(
      `return Boolean(${VISIBLE_PREVIEW});`,
    );
  }

  async function isPickerVisible(): Promise<boolean> {
    return await client.executeSync<boolean>(
      `const modal = document.querySelector(".picker-modal");
       if (!modal) return false;
       const rect = modal.getBoundingClientRect();
       const style = getComputedStyle(modal);
       return style.display !== "none" &&
         style.visibility !== "hidden" &&
         rect.width > 0 &&
         rect.height > 0;`,
    );
  }

  async function waitForPreviewHidden(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await isPreviewVisible())) return;
      await sleep(200);
    }
    throw new Error("preview modal remained visible");
  }

  async function waitForPreviewVisible(): Promise<void> {
    await client.waitForElement(".preview-modal", 5000);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await isPreviewVisible()) return;
      await sleep(200);
    }
    throw new Error("preview modal did not become visible");
  }

  async function waitForPickerHidden(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await isPickerVisible())) return;
      await sleep(200);
    }
    throw new Error("picker modal remained visible");
  }

  async function waitForPickerVisible(): Promise<void> {
    await client.waitForElement(".picker-modal", 5000);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await isPickerVisible()) return;
      await sleep(200);
    }
    throw new Error("picker modal did not become visible");
  }

  async function setPickerScrollTop(scrollTop: number): Promise<number> {
    return await client.executeSync<number>(
      `const list = document.querySelector(".file-list");
       if (!(list instanceof HTMLElement)) return -1;
       list.scrollTop = ${scrollTop};
       return list.scrollTop;`,
    );
  }

  async function pickerScrollTop(): Promise<number> {
    return await client.executeSync<number>(
      `const list = document.querySelector(".file-list");
       return list instanceof HTMLElement ? list.scrollTop : -1;`,
    );
  }

  async function filterPickerTo(query: string): Promise<void> {
    await client.executeSync(
      `const input = document.querySelector(".picker-input");
       if (!(input instanceof HTMLInputElement)) throw new Error("picker input missing");
       input.value = ${JSON.stringify(query)};
       input.dispatchEvent(new Event("input", { bubbles: true }));
       return true;`,
    );
  }

  async function openFileTabPaths(): Promise<string[]> {
    return await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll('[data-testid^="main-tab-file:"]'))
        .map((tab) => (tab.getAttribute("data-testid") || "").replace(/^main-tab-file:/, ""));`
    );
  }

  async function clickMainTab(id: string): Promise<void> {
    await client.executeSync(
      `document.querySelector('[data-testid="main-tab-' + ${JSON.stringify(id)} + '"]')?.click();
       return true;`,
    );
  }

  async function frontModeBadgeText(): Promise<string> {
    return await client.executeSync<string>(
      `const overlay = ${VISIBLE_PREVIEW};
       return overlay?.querySelector(".mode-badge")?.textContent?.trim() ?? "";`,
    );
  }

  async function clickFrontModeBadge(): Promise<void> {
    await client.executeSync(
      `const overlay = ${VISIBLE_PREVIEW};
       const badge = overlay?.querySelector(".mode-badge");
       if (!(badge instanceof HTMLElement)) throw new Error("no mode badge in the front preview");
       badge.click();
       return true;`,
    );
  }

  async function waitForRenderedMarkdown(): Promise<void> {
    await client.waitForElement(".preview-content.markdown-rendered h1", 5000);
  }

  function isVueCallError(result: unknown): result is { __error: string } {
    return Boolean(
      result &&
      typeof result === "object" &&
      "__error" in result &&
      typeof (result as { __error?: unknown }).__error === "string",
    );
  }

  /**
   * Select a seeded task and prove it took.
   *
   * The fixture repo ships no `.kanna`, so importing it launches a setup task
   * that becomes the current item — and `store.selectItem` returns quietly
   * when the seeded id resolves to no sidebar slot yet. Left unchecked the
   * file picker then points at the setup task's worktree instead of the repo.
   */
  async function selectTask(taskId: string): Promise<void> {
    const slotDeadline = Date.now() + 10_000;
    let slotKnown = false;
    while (Date.now() < slotDeadline) {
      slotKnown = await client.executeSync<boolean>(
        `const ctx = window.__KANNA_E2E__.setupState;
         const unwrap = (value) => value && value.__v_isRef ? value.value : value;
         return Array.from(unwrap(ctx.store.taskUiSlots) ?? [])
           .some((slot) => slot.task_id === ${JSON.stringify(taskId)});`,
      );
      if (slotKnown) break;
      await sleep(100);
    }
    expect(slotKnown, `seeded task ${taskId} never reached the sidebar slots`).toBe(true);

    const result = await callVueMethod(client, "store.selectItem", taskId);
    if (isVueCallError(result)) {
      throw new Error(result.__error);
    }

    const selectedDeadline = Date.now() + 5_000;
    let selectedTaskId: string | null = null;
    while (Date.now() < selectedDeadline) {
      selectedTaskId = await client.executeSync<string | null>(
        "return window.__KANNA_E2E__.setupState.store.selectedTaskId ?? null;",
      );
      if (selectedTaskId === taskId) return;
      await sleep(100);
    }
    throw new Error(`timed out selecting ${taskId}; selected task was ${JSON.stringify(selectedTaskId)}`);
  }

  /**
   * The picker lists only its first 100 paths until it is filtered, and the
   * scroll fixtures push most of the repo past that cut, so narrow to the
   * wanted file rather than scanning an arbitrary window — and when it still
   * misses, report what the picker actually listed so a genuine absence can
   * be told from a slow load.
   */
  async function pickFileFromPicker(path: string): Promise<void> {
    await filterPickerTo(path);
    const element = await client.waitForText(".file-item", path, 15000)
      .catch(async (error: unknown) => {
        const listed = await client.executeSync<{
          query: string;
          items: string[];
          selectedRepoPath: string | null;
          currentBranch: string | null;
        }>(
          `const ctx = window.__KANNA_E2E__.setupState;
           const unwrap = (value) => value && value.__v_isRef ? value.value : value;
           return {
             query: document.querySelector(".picker-modal .picker-input")?.value ?? "",
             items: Array.from(document.querySelectorAll(".picker-modal .file-item"))
               .map((item) => (item.textContent || "").trim()),
             selectedRepoPath: unwrap(ctx.store?.selectedRepo)?.path ?? null,
             currentBranch: unwrap(ctx.store?.currentItem)?.branch ?? null,
           };`,
        ).catch(() => ({
          query: "<unavailable>",
          items: [] as string[],
          selectedRepoPath: null,
          currentBranch: null,
        }));
        const backendFiles = listed.selectedRepoPath
          ? await tauriInvoke(client, "list_files", { path: listed.selectedRepoPath })
            .catch((listError: unknown) => ({ __error: String(listError) }))
          : null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; picker query ${JSON.stringify(listed.query)} listed ${listed.items.length} entries: ${JSON.stringify(listed.items.slice(0, 20))}; selectedRepoPath=${JSON.stringify(listed.selectedRepoPath)} currentBranch=${JSON.stringify(listed.currentBranch)}; list_files: ${JSON.stringify(Array.isArray(backendFiles) ? backendFiles.slice(0, 20) : backendFiles)}`,
        );
      });
    await client.click(element);
  }

  it("opens each picked file as its own tab and recalls one with Option+Command+P", async () => {
    await pressKey("p", { meta: true });
    await client.waitForElement(".picker-modal", 5000);

    await pickFileFromPicker("src/index.txt");
    expect(await previewedFilePath()).toBe("src/index.txt");
    // The picker hands the file over and leaves: it is a launcher for the
    // view, not a layer under it.
    await waitForPickerHidden();

    await pressKey("p", { meta: true });
    await waitForPickerVisible();
    await pickFileFromPicker("README.md");
    expect(await previewedFilePath()).toBe("README.md");
    await waitForPickerHidden();

    // Both files are open at once, which the single preview modal could not do.
    expect(await openFileTabPaths()).toEqual(["src/index.txt", "README.md"]);

    // Markdown previews open rendered (`DEFAULT_MARKDOWN_PREVIEW_MODE`), so
    // toggle away and back to leave the badge on a mode the user chose.
    await waitForRenderedMarkdown();
    expect(await frontModeBadgeText()).toBe("Rendered");
    await clickFrontModeBadge();
    await client.waitForNoElement(".preview-content.markdown-rendered", 5000);
    expect(await frontModeBadgeText()).toBe("Raw");
    await clickFrontModeBadge();
    await waitForRenderedMarkdown();
    expect(await frontModeBadgeText()).toBe("Rendered");

    // Bringing another tab forward and coming back is what hiding and
    // reshowing the one modal used to be: the view keeps the chosen mode.
    await clickMainTab("file:src/index.txt");
    expect(await previewedFilePath()).toBe("src/index.txt");
    await clickMainTab("file:README.md");
    expect(await previewedFilePath()).toBe("README.md");
    expect(await frontModeBadgeText()).toBe("Rendered");
    await waitForRenderedMarkdown();

    // ⌥⌘P brings a file forward; it never closes one.
    await pressKey("d", { meta: true });
    await waitForPreviewHidden();
    await pressKey("π", { meta: true, alt: true, code: "KeyP" });
    expect(await openFileTabPaths()).toEqual(["src/index.txt", "README.md"]);
    await waitForPreviewVisible();

    // Recall with nothing open is the next test's subject, which states its
    // selection explicitly; this one just leaves a clean tab set behind.
    await client.executeSync(closeMainTabsScript(["file", "diff"]));
    await sleep(300);
    expect(await openFileTabPaths()).toEqual([]);
  });

  it("keeps file preview recall scoped to the selected task", async () => {
    await pressKey("Escape");
    await client.waitForNoElement(".picker-modal", 5000);
    await client.waitForNoElement(".preview-modal", 5000);

    const taskAId = "file-preview-recall-task-a";
    const taskBId = "file-preview-recall-task-b";
    await execDb(
      client,
      `INSERT OR REPLACE INTO pipeline_item
         (id, repo_id, prompt, stage, branch, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskAId,
        fixtureRepoId,
        "File preview recall task A",
        "in progress",
        null,
        "agent",
        "2026-05-08T00:00:00.000Z",
        "2026-05-08T00:00:00.000Z",
        taskBId,
        fixtureRepoId,
        "File preview recall task B",
        "in progress",
        null,
        "agent",
        "2026-05-08T00:01:00.000Z",
        "2026-05-08T00:01:00.000Z",
      ],
    );

    const refreshResult = await callVueMethod(client, "refreshAllItems");
    if (isVueCallError(refreshResult)) {
      throw new Error(refreshResult.__error);
    }

    await selectTask(taskAId);
    await pressKey("p", { meta: true });
    await client.waitForElement(".picker-modal", 5000);
    const readme = await client.waitForText(".file-item", "README.md", 15000);
    await client.click(readme);
    expect(await previewedFilePath()).toBe("README.md");

    await pressKey("Escape");
    await client.waitForNoElement(".preview-modal", 5000);

    await selectTask(taskBId);
    await pressKey("π", { meta: true, alt: true, code: "KeyP" });
    await client.waitForElement(".picker-modal", 5000);
    expect(await isPreviewVisible()).toBe(false);

    const indexFile = await client.waitForText(".file-item", "src/index.txt", 15000);
    await client.click(indexFile);
    expect(await previewedFilePath()).toBe("src/index.txt");

    await pressKey("Escape");
    await client.waitForNoElement(".preview-modal", 5000);

    await selectTask(taskAId);
    await pressKey("π", { meta: true, alt: true, code: "KeyP" });
    expect(await previewedFilePath()).toBe("README.md");
  });

  it("keeps a file tab's scroll position while another tab is in front", async () => {
    // Earlier tests leave their own file tabs open — that is the point of
    // tabs — so this one starts from a clean tab set.
    await client.executeSync(closeMainTabsScript(["file", "diff"]));
    await pressKey("p", { meta: true });
    await waitForPickerVisible();

    expect(await setPickerScrollTop(320)).toBeGreaterThan(0);

    await client.executeSync(
      `const item = Array.from(document.querySelectorAll(".file-item"))
         .find((element) => element.textContent?.includes("docs/scroll/entry-30.md"));
       if (!(item instanceof HTMLElement)) {
         throw new Error("scroll fixture file item was not rendered");
       }
       item.click();`,
    );

    await waitForPreviewVisible();
    await waitForPickerHidden();

    const scrolled = await client.executeSync<number>(
      `const content = ${VISIBLE_PREVIEW}?.querySelector(".preview-content");
       if (!(content instanceof HTMLElement)) return -1;
       content.scrollTop = 64;
       return content.scrollTop;`,
    );

    await pressKey("d", { meta: true });
    await waitForPreviewHidden();
    await clickMainTab("file:docs/scroll/entry-30.md");
    await waitForPreviewVisible();

    // The view was hidden, never rebuilt, so the reader comes back to where
    // they were rather than to the top of the file.
    expect(await client.executeSync<number>(
      `const content = ${VISIBLE_PREVIEW}?.querySelector(".preview-content");
       return content instanceof HTMLElement ? content.scrollTop : -1;`,
    )).toBe(scrolled);

    await pressKey("Escape");
    await client.waitForNoElement('[data-testid="main-tab-file:docs/scroll/entry-30.md"]', 5000);
  });
});
