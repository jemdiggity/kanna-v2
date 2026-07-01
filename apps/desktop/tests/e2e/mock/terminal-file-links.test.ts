import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";

describe("terminal file links", () => {
  const client = new WebDriverClient();
  let fixtureRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoPath = await createSeedFixtureRepo("task-switch-minimal");

    const appVuePath = join(fixtureRepoPath, "apps", "desktop", "src", "App.vue");
    await mkdir(join(fixtureRepoPath, "apps", "desktop", "src"), { recursive: true });
    await writeFile(
      appVuePath,
      Array.from({ length: 40 }, (_, index) => {
        const line = index + 1;
        return line === 31
          ? "<!-- line 31 target from terminal file link -->"
          : `<!-- fixture line ${line} -->`;
      }).join("\n"),
      "utf8",
    );

    await importTestRepo(client, fixtureRepoPath, "terminal-file-links-fixture");
  });

  afterAll(async () => {
    await cleanupFixtureRepos(fixtureRepoPath ? [fixtureRepoPath] : []);
    await client.deleteSession();
  });

  async function previewedFilePath(): Promise<string> {
    const element = await client.waitForElement(".preview-modal .file-path", 5000);
    return await client.getText(element);
  }

  async function waitForLineTarget(line: number): Promise<void> {
    const selector = `.preview-modal .preview-content.with-line-numbers [data-line="${line}"]`;
    await client.waitForElement(selector, 10_000);
  }

  async function waitForPreviewText(text: string): Promise<void> {
    await client.waitForText(".preview-modal .preview-content", text, 10_000);
  }

  async function waitForPreviewVisible(): Promise<void> {
    await client.waitForElement(".preview-modal", 5000);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const visible = await client.executeSync<boolean>(
        `const modal = document.querySelector(".preview-modal");
         if (!modal) return false;
         const rect = modal.getBoundingClientRect();
         const style = getComputedStyle(modal);
         return style.display !== "none" &&
           style.visibility !== "hidden" &&
           rect.width > 0 &&
           rect.height > 0;`,
      );
      if (visible) return;
      await sleep(200);
    }
    throw new Error("preview modal did not become visible");
  }

  async function waitForImagePreviewVisible(): Promise<void> {
    await client.waitForElement(".image-preview-modal", 5000);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const visible = await client.executeSync<boolean>(
        `const modal = document.querySelector(".image-preview-modal");
         const image = modal?.querySelector("img");
         if (!modal || !image) return false;
         const rect = modal.getBoundingClientRect();
         const style = getComputedStyle(modal);
         return style.display !== "none" &&
           style.visibility !== "hidden" &&
           rect.width > 0 &&
           rect.height > 0 &&
           image.getAttribute("src")?.startsWith("data:image/png;base64,") === true;`,
      );
      if (visible) return;
      await sleep(200);
    }
    throw new Error("image preview modal did not render a data URL image");
  }

  it("opens the preview for a Copilot-style terminal file link activation", async () => {
    const activation = await client.executeSync<{
      copilotOutput: string;
      xtermDomLinks: number;
    }>(
      `const copilotOutput = "Updated README.md and apps/desktop/src/App.vue:31";
       // xterm link providers expose buffer ranges and activation callbacks rather than
       // stable DOM anchors. The mock WebDriver harness has no xterm hit-test/test hook
       // that can resolve this text range into a clickable coordinate, so this E2E covers
       // the document-level activation path that terminalFileLinks dispatches after its
       // composable-level tests have verified Copilot-style link detection.
       const xtermDomLinks = document.querySelectorAll(".xterm a, .xterm-link, .xterm-link-layer a").length;
       document.dispatchEvent(new CustomEvent("file-link-activate", {
         bubbles: true,
         detail: { path: "apps/desktop/src/App.vue", line: 31 },
       }));
       return { copilotOutput, xtermDomLinks };`,
    );

    expect(activation.copilotOutput).toBe("Updated README.md and apps/desktop/src/App.vue:31");
    expect(activation.xtermDomLinks).toBe(0);
    await waitForPreviewVisible();
    expect(await previewedFilePath()).toBe("apps/desktop/src/App.vue");
    await waitForLineTarget(31);
    await waitForPreviewText("line 31 target from terminal file link");

    const highlightedLine = await client.executeSync<string | null>(
      `return document.querySelector('.preview-modal [data-line="31"]')?.textContent ?? null;`,
    );
    expect(highlightedLine).toContain("line 31 target from terminal file link");
  });

  it("opens a local task worktree image link in the image preview through the backend reader", async () => {
    await client.executeSync(
      `document.dispatchEvent(new KeyboardEvent("keydown", {
         key: "Escape",
         bubbles: true,
         cancelable: true,
       }));`,
    );
    await client.waitForNoElement(".preview-modal", 5_000);

    const taskWorktreePath = join(fixtureRepoPath, ".kanna-worktrees", "task-terminal-image-links");
    const imagePath = join(taskWorktreePath, "simple-paper-boat.png");
    await mkdir(taskWorktreePath, { recursive: true });
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
    await client.executeSync(
      `// xterm link providers expose buffer ranges and activation callbacks rather than
       // stable DOM anchors. This dispatch covers the same document-level activation
       // path used by terminalFileLinks after composable tests verify image path detection.
       document.dispatchEvent(new CustomEvent("image-link-activate", {
         bubbles: true,
         detail: { url: ${JSON.stringify(imagePath)} },
       }));`,
    );

    await waitForImagePreviewVisible();
    const previewState = await client.executeSync<{
      textPreviewOpen: boolean;
      sourceLabel: string | null;
      imageSrc: string | null;
      readerCall: { cmd: string; args: { path: string } } | null;
    }>(
      `const calls = window.__KANNA_E2E__.invokes.getAll();
       const readerCall = calls.find((call) => call.cmd === "read_image_file_data_url");
       return {
         textPreviewOpen: Boolean(document.querySelector(".preview-modal")),
         sourceLabel: document.querySelector(".image-preview-modal .image-source")?.textContent ?? null,
         imageSrc: document.querySelector(".image-preview-modal img")?.getAttribute("src") ?? null,
         readerCall: readerCall ? JSON.parse(JSON.stringify(readerCall)) : null,
       };`,
    );

    expect(previewState.textPreviewOpen).toBe(false);
    expect(previewState.sourceLabel).toBe(imagePath);
    expect(previewState.imageSrc).toMatch(/^data:image\/png;base64,/);
    expect(previewState.readerCall).toEqual({
      cmd: "read_image_file_data_url",
      args: { path: imagePath },
    });
  });
});
