import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo } from "../helpers/reset";
import { execDb } from "../helpers/vue";
import { cleanupFixtureRepos, createSeedFixtureRepo } from "../helpers/fixture-repo";

// The agent's full-screen TUI holds the alternate screen, so setup-script
// output and carried-over prior-stage history sit in a normal buffer xterm
// cannot scroll into. The "Earlier output" chip is the access path to it, and
// it must survive this branch's removal of the neighbouring mentioned-files
// chip that shared its container.
const SETUP_ROWS = 60;
const TOOL_CHIP = ".terminal-tools .terminal-tool-chip";
const HISTORY_OVERLAY = ".terminal-history-overlay";

describe("terminal earlier output", () => {
  const client = new WebDriverClient();
  let fixtureRepoPath = "";
  let repoId = "";
  const taskId = "e2e-terminal-earlier-output";
  const branch = "task-e2e-terminal-earlier-output";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoPath = await createSeedFixtureRepo("task-switch-minimal");
    repoId = await importTestRepo(client, fixtureRepoPath, "terminal-earlier-output-fixture");
  });

  afterAll(async () => {
    await cleanupFixtureRepos(fixtureRepoPath ? [fixtureRepoPath] : []);
    await client.deleteSession();
  });

  async function selectAgentTerminal(): Promise<void> {
    await mkdir(join(fixtureRepoPath, ".kanna-worktrees", branch), { recursive: true });
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_number, issue_title, prompt, stage, branch, agent_type, agent_provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        repoId,
        811,
        "Earlier output access",
        "Run a full-screen agent over setup output",
        "in progress",
        branch,
        "pty",
        "claude",
        "2026-09-08T10:00:00.000Z",
        "2026-09-08T10:00:00.000Z",
      ],
    );

    // Importing the fixture repo leaves its own setup task selected and still
    // running, and that selection wins over a single selectItem call. Keep
    // asking until this task owns the terminal view.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
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
      const registered = await client.executeSync<boolean>(
        `return window.__KANNA_E2E__.terminalBuffers?.sessionIds().includes(${JSON.stringify(taskId)}) === true;`,
      );
      if (registered) {
        await client.waitForElement(".terminal-container .xterm-helper-textarea", 10_000);
        return;
      }
      await sleep(500);
    }
    throw new Error(`terminal buffer ${taskId} was not registered`);
  }

  async function writeToTerminal(data: string): Promise<void> {
    await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       window.__KANNA_E2E__.terminalBuffers.write(
         ${JSON.stringify(taskId)},
         ${JSON.stringify(data)},
         function() { cb("ok"); }
       );`,
    );
  }

  async function chipLabels(): Promise<string[]> {
    return await client.executeSync<string[]>(
      `return Array.from(document.querySelectorAll(${JSON.stringify(TOOL_CHIP)}))
         .map(function(chip) { return (chip.textContent || "").trim(); });`,
    );
  }

  async function captureEvidence(name: string): Promise<void> {
    const evidenceDir = process.env.KANNA_VISUAL_EVIDENCE_DIR;
    if (!evidenceDir) return;
    await mkdir(evidenceDir, { recursive: true });
    await client.executeSync(
      `document.querySelectorAll(".toast-dismiss").forEach(function(button) { button.click(); });
       if (window.__KANNA_E2E__.terminalBuffers?.sessionIds().includes(${JSON.stringify(taskId)})) {
         window.__KANNA_E2E__.terminalBuffers.refresh(${JSON.stringify(taskId)});
       }`,
    );
    // Let the WebGL renderer finish repainting before the frame is grabbed.
    await sleep(400);
    await client.screenshot(join(evidenceDir, name));
  }

  it("offers earlier output, and only that, once the TUI hides the normal buffer", async () => {
    await selectAgentTerminal();

    // Nothing is hidden while the normal buffer is the one on screen: xterm
    // scrolls it, so the chip has no reason to exist yet.
    expect(await chipLabels()).toEqual([]);

    const setup = Array.from(
      { length: SETUP_ROWS },
      (_, index) => `setup line ${index + 1}`,
    ).join("\r\n");
    await writeToTerminal(`${setup}\r\n`);
    expect(await chipLabels()).toEqual([]);

    // The agent's TUI takes the alternate screen, hiding everything above it.
    await writeToTerminal("\u001b[?1049h\u001b[H\u001b[2JAgent TUI is running\r\n> ");
    await client.waitForElement(TOOL_CHIP, 5_000);

    // The live view is the alternate screen: the TUI's own text, and none of
    // the setup output behind it.
    const altBuffer = await client.executeSync<string[]>(
      `return window.__KANNA_E2E__.terminalBuffers.lines(${JSON.stringify(taskId)});`,
    );
    expect(altBuffer.some((line) => line.includes("Agent TUI is running"))).toBe(true);
    expect(altBuffer.some((line) => line.includes("setup line"))).toBe(false);

    // The mentioned-files chip shared this container and is gone; the earlier
    // output chip is what remains.
    expect(await chipLabels()).toEqual(["Earlier output"]);
    expect(
      await client.executeSync<number>(
        `return document.querySelectorAll('[data-testid="mentioned-files-open"]').length;`,
      ),
    ).toBe(0);
    await captureEvidence("desktop-earlier-output-chip.png");

    await client.click(await client.findElement(TOOL_CHIP));
    await client.waitForElement(HISTORY_OVERLAY, 5_000);

    const overlay = await client.executeSync<{ header: string; body: string }>(
      `return {
         header: (document.querySelector(".terminal-history-header span")?.textContent || "").trim(),
         body: document.querySelector(".terminal-history-body")?.textContent || "",
       };`,
    );
    expect(overlay.header).toContain("Earlier output");
    expect(overlay.body).toContain("setup line 1");
    expect(overlay.body).toContain(`setup line ${SETUP_ROWS}`);
    expect(overlay.body).not.toContain("Agent TUI is running");
    await captureEvidence("desktop-earlier-output-overlay.png");

    await client.click(await client.findElement(".terminal-history-close"));
    await client.waitForNoElement(HISTORY_OVERLAY, 5_000);
    expect(await chipLabels()).toEqual(["Earlier output"]);
  });

  it("withdraws the chip when the TUI leaves the alternate screen", async () => {
    await writeToTerminal("\u001b[?1049l");
    await client.waitForNoElement(TOOL_CHIP, 5_000);

    expect(await chipLabels()).toEqual([]);
  });
});
