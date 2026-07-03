import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";
import { callVueMethod, execDb } from "../helpers/vue";

describe("file preview", () => {
  const client = new WebDriverClient();
  let fixtureRepoPath = "";
  let fixtureRepoId = "";

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

  async function previewedFilePath(): Promise<string> {
    const element = await client.waitForElement(".preview-modal .file-path", 5000);
    return await client.getText(element);
  }

  async function isPreviewVisible(): Promise<boolean> {
    return await client.executeSync<boolean>(
      `const modal = document.querySelector(".preview-modal");
       if (!modal) return false;
       const rect = modal.getBoundingClientRect();
       const style = getComputedStyle(modal);
       return style.display !== "none" &&
         style.visibility !== "hidden" &&
         rect.width > 0 &&
         rect.height > 0;`,
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

  async function selectTask(taskId: string): Promise<void> {
    const result = await callVueMethod(client, "store.selectItem", taskId);
    if (isVueCallError(result)) {
      throw new Error(result.__error);
    }
  }

  it("opens the picker from preview, selects another file, and recalls it with Option+Command+P", async () => {
    await pressKey("p", { meta: true });
    await client.waitForElement(".picker-modal", 5000);

    const firstFile = await client.waitForText(".file-item", "src/index.txt", 5000);
    await client.click(firstFile);

    expect(await previewedFilePath()).toBe("src/index.txt");

    await pressKey("p", { meta: true });
    await client.waitForElement(".picker-modal", 5000);

    const secondFile = await client.waitForText(".file-item", "README.md", 5000);
    await client.click(secondFile);

    expect(await previewedFilePath()).toBe("README.md");
    await waitForPickerHidden();

    await pressKey("p", { meta: true });
    await waitForPickerVisible();

    await pressKey("Escape");
    await client.waitForNoElement(".picker-modal", 5000);
    expect(await previewedFilePath()).toBe("README.md");

    await pressKey("Escape");
    await client.waitForNoElement(".preview-modal", 5000);
    await client.waitForNoElement(".picker-modal", 5000);

    await pressKey("π", { meta: true, alt: true, code: "KeyP" });
    expect(await previewedFilePath()).toBe("README.md");

    const modeBadge = await client.waitForElement(".preview-modal .mode-badge", 5000);
    await client.click(modeBadge);
    await waitForRenderedMarkdown();
    expect(await client.getText(modeBadge)).toBe("Rendered");

    await pressKey("π", { meta: true, alt: true, code: "KeyP" });
    await waitForPreviewHidden();

    await pressKey("π", { meta: true, alt: true, code: "KeyP" });
    await waitForPreviewVisible();
    expect(await previewedFilePath()).toBe("README.md");
    const restoredModeBadge = await client.waitForElement(".preview-modal .mode-badge", 5000);
    expect(await client.getText(restoredModeBadge)).toBe("Rendered");
    await waitForRenderedMarkdown();
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
    const readme = await client.waitForText(".file-item", "README.md", 5000);
    await client.click(readme);
    expect(await previewedFilePath()).toBe("README.md");

    await pressKey("Escape");
    await client.waitForNoElement(".preview-modal", 5000);

    await selectTask(taskBId);
    await pressKey("π", { meta: true, alt: true, code: "KeyP" });
    await client.waitForElement(".picker-modal", 5000);
    expect(await isPreviewVisible()).toBe(false);

    const indexFile = await client.waitForText(".file-item", "src/index.txt", 5000);
    await client.click(indexFile);
    expect(await previewedFilePath()).toBe("src/index.txt");

    await pressKey("Escape");
    await client.waitForNoElement(".preview-modal", 5000);

    await selectTask(taskAId);
    await pressKey("π", { meta: true, alt: true, code: "KeyP" });
    expect(await previewedFilePath()).toBe("README.md");
  });

  it("preserves picker scroll position while preview hides and resumes it", async () => {
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

    await client.executeSync(
      `const overlay = document.querySelector(".preview-modal")?.parentElement;
       if (!(overlay instanceof HTMLElement)) {
         throw new Error("preview overlay was not rendered");
       }
       overlay.dispatchEvent(new MouseEvent("click", {
         bubbles: true,
         cancelable: true,
         view: window,
       }));`,
    );
    await waitForPreviewHidden();
    await waitForPickerVisible();
    expect(await pickerScrollTop()).toBe(320);

    await pressKey("Escape");
    await client.waitForNoElement(".picker-modal", 5000);
  });
});
