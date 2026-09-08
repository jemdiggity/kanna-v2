import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { execDb } from "../helpers/vue";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, ...args]);
}

describe("terminal file links", () => {
  const client = new WebDriverClient();
  let fixtureRepoPath = "";
  let repoId = "";

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
    await git(fixtureRepoPath, ["add", "apps/desktop/src/App.vue"]);
    await git(fixtureRepoPath, ["commit", "-m", "test: add terminal file link target"]);
    await git(fixtureRepoPath, ["push", "origin", "main"]);

    repoId = await importTestRepo(client, fixtureRepoPath, "terminal-file-links-fixture");
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
           image.getAttribute("src")?.startsWith("data:image/png;base64,") === true &&
           image.complete &&
           image.naturalWidth > 0 &&
           image.naturalHeight > 0;`,
      );
      if (visible) return;
      await sleep(200);
    }
    const imageState = await client.executeSync(
      `const image = document.querySelector(".image-preview-modal img");
       return image ? {
         complete: image.complete,
         naturalWidth: image.naturalWidth,
         naturalHeight: image.naturalHeight,
         srcPrefix: image.getAttribute("src")?.slice(0, 32) ?? null,
       } : null;`,
    );
    throw new Error(`image preview modal did not decode a data URL image: ${JSON.stringify(imageState)}`);
  }

  async function createAndSelectAgentTerminal(taskId: string, branch: string): Promise<void> {
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, stage, branch, agent_type, agent_provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        repoId,
        701,
        "Latest terminal file shortcut",
        "Mention fixture files",
        "in progress",
        branch,
        "pty",
        "claude",
        "2026-07-12T10:00:00.000Z",
        "2026-07-12T10:00:00.000Z",
      ],
    );

    const selected = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__.setupState;
       Promise.resolve(ctx.refreshAllItems())
         .then(function() { return ctx.store.selectRepo(${JSON.stringify(repoId)}); })
         .then(function() { return ctx.store.selectItem(${JSON.stringify(taskId)}); })
         .then(function() { cb("ok"); })
         .catch(function(error) { cb("err:" + error); });`,
    );
    expect(selected).toBe("ok");
    await client.waitForElement(".terminal-container .xterm-helper-textarea", 10_000);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const registered = await client.executeSync<boolean>(
        `return window.__KANNA_E2E__.terminalBuffers?.sessionIds().includes(${JSON.stringify(taskId)}) === true;`,
      );
      if (registered) return;
      await sleep(100);
    }
    throw new Error(`terminal buffer ${taskId} was not registered`);
  }

  it("opens the newest valid agent file with Cmd+L while the terminal has focus", async () => {
    const taskId = "e2e-latest-terminal-file";
    const branch = "task-e2e-latest-terminal-file";
    const worktreePath = join(fixtureRepoPath, ".kanna-worktrees", branch);
    await mkdir(join(worktreePath, "apps", "desktop", "src"), { recursive: true });
    await writeFile(
      join(worktreePath, "apps", "desktop", "src", "Older.vue"),
      "<!-- older valid mention -->\n",
      "utf8",
    );
    await writeFile(
      join(worktreePath, "apps", "desktop", "src", "Newest.vue"),
      Array.from({ length: 24 }, (_, index) => index === 18
        ? "<!-- newest valid line target -->"
        : `<!-- newest fixture line ${index + 1} -->`).join("\n"),
      "utf8",
    );
    await createAndSelectAgentTerminal(taskId, branch);

    await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
    const output = [
      "Changed apps/desktop/src/Older.vue:1",
      "Design captured at apps/desktop/src/Newest.vue:19",
      "Ignore missing apps/desktop/src/DoesNotExist.vue:7",
    ].join("\r\n");
    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       window.__KANNA_E2E__.terminalBuffers.write(
         ${JSON.stringify(taskId)},
         ${JSON.stringify(output)},
         function() { cb("ok"); }
       );`,
    );

    const terminalInput = await client.findElement(".terminal-container .xterm-helper-textarea");
    await client.click(terminalInput);
    await client.pressShortcut(["Meta", "l"]);

    await waitForPreviewVisible();
    expect(await previewedFilePath()).toBe("apps/desktop/src/Newest.vue");
    await waitForLineTarget(19);
    await waitForPreviewText("newest valid line target");

    const existenceChecks = await client.executeSync<string[]>(
      `return window.__KANNA_E2E__.invokes.getAll()
         .filter(function(call) { return call.cmd === "file_exists"; })
         .map(function(call) { return call.args.path; });`,
    );
    expect(existenceChecks.some((path) => path.endsWith("/apps/desktop/src/DoesNotExist.vue"))).toBe(true);
    expect(existenceChecks.some((path) => path.endsWith("/apps/desktop/src/Newest.vue"))).toBe(true);
  });

  it("shows feedback when Cmd+L finds no file mention in the focused agent terminal", async () => {
    const taskId = "e2e-terminal-without-file";
    const branch = "task-e2e-terminal-without-file";
    const worktreePath = join(fixtureRepoPath, ".kanna-worktrees", branch);
    await mkdir(join(worktreePath, "apps", "desktop", "src"), { recursive: true });
    await writeFile(
      join(worktreePath, "apps", "desktop", "src", "App.vue"),
      Array.from({ length: 40 }, (_, index) => index === 30
        ? "<!-- line 31 target from terminal file link -->"
        : `<!-- fixture line ${index + 1} -->`).join("\n"),
      "utf8",
    );
    await createAndSelectAgentTerminal(taskId, branch);

    const terminalInput = await client.findElement(".terminal-container .xterm-helper-textarea");
    await client.click(terminalInput);
    await client.pressShortcut(["Meta", "l"]);

    await client.waitForText(".toast.info", "No file link found", 5_000);
  });

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

  it("previews a remote task file link from the payload without reading local disk", async () => {
    await client.executeSync(
      `document.dispatchEvent(new KeyboardEvent("keydown", {
         key: "Escape",
         bubbles: true,
         cancelable: true,
       }));`,
    );
    await client.waitForNoElement(".preview-modal", 5_000);

    // This path exists in no worktree on this machine. A task owned by another
    // desktop is streamed through CloudTerminalView, whose link provider reads
    // the file over the relay/LAN transport and hands the snapshot to the
    // preview. Anything rendered here therefore came from the payload, not from
    // a local filesystem read.
    const remotePath = "src/remote-only/OwnedByAnotherDesktop.ts";
    const remoteContent = [
      "// line 1 of the remote-owned file",
      "// line 2 of the remote-owned file",
      "export const remoteOnlyMarker = \"served from the owning desktop\";",
      "// line 4 of the remote-owned file",
    ].join("\n");

    await client.executeSync("window.__KANNA_E2E__.invokes.clear();");
    await client.executeSync(
      `// xterm link providers expose buffer ranges and activation callbacks rather
       // than stable DOM anchors, so this covers the same document-level activation
       // path the remote provider dispatches after its unit tests verify detection,
       // caching, and cmd+click activation.
       document.dispatchEvent(new CustomEvent("file-link-activate", {
         bubbles: true,
         detail: {
           path: ${JSON.stringify(remotePath)},
           line: 3,
           remoteContent: ${JSON.stringify(remoteContent)},
         },
       }));`,
    );

    await waitForPreviewVisible();
    expect(await previewedFilePath()).toBe(remotePath);
    await waitForLineTarget(3);
    await waitForPreviewText("served from the owning desktop");

    const previewState = await client.executeSync<{
      localReads: string[];
      openInIdeButtons: number;
      renderedLine: string | null;
    }>(
      `const calls = window.__KANNA_E2E__.invokes.getAll();
       return {
         localReads: calls
           .filter(function(call) { return call.cmd === "read_text_file"; })
           .map(function(call) { return call.args.path; }),
         openInIdeButtons: document.querySelectorAll(".preview-modal .btn-open").length,
         renderedLine: document.querySelector('.preview-modal [data-line="3"]')?.textContent ?? null,
       };`,
    );

    expect(previewState.localReads).toEqual([]);
    // Open in IDE would shell out against a path that does not exist here.
    expect(previewState.openInIdeButtons).toBe(0);
    expect(previewState.renderedLine).toContain("served from the owning desktop");
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
      naturalWidth: number | null;
      naturalHeight: number | null;
      readerCall: { cmd: string; args: { path: string } } | null;
    }>(
      `const calls = window.__KANNA_E2E__.invokes.getAll();
       const readerCall = calls.find((call) => call.cmd === "read_image_file_data_url");
       const image = document.querySelector(".image-preview-modal img");
       return {
         textPreviewOpen: Boolean(document.querySelector(".preview-modal")),
         sourceLabel: document.querySelector(".image-preview-modal .image-source")?.textContent ?? null,
         imageSrc: image?.getAttribute("src") ?? null,
         naturalWidth: image?.naturalWidth ?? null,
         naturalHeight: image?.naturalHeight ?? null,
         readerCall: readerCall ? JSON.parse(JSON.stringify(readerCall)) : null,
       };`,
    );

    expect(previewState.textPreviewOpen).toBe(false);
    expect(previewState.sourceLabel).toBe(imagePath);
    expect(previewState.imageSrc).toMatch(/^data:image\/png;base64,/);
    expect(previewState.naturalWidth).toBeGreaterThan(0);
    expect(previewState.naturalHeight).toBeGreaterThan(0);
    expect(previewState.readerCall).toEqual({
      cmd: "read_image_file_data_url",
      args: { path: imagePath },
    });
  });
});
