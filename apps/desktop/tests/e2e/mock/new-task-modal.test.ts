import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { waitForTaskCreated } from "../helpers/taskCreation";

describe("new task modal", () => {
  const client = new WebDriverClient();
  let fixtureRepoRoot = "";
  let testRepoPath = "";

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    fixtureRepoRoot = await createFixtureRepo("new-task-modal-test");
    testRepoPath = fixtureRepoRoot;

    const kannaDir = join(testRepoPath, ".kanna");
    const pipelinesDir = join(kannaDir, "pipelines");
    await mkdir(pipelinesDir, { recursive: true });
    await writeFile(join(kannaDir, "config.json"), JSON.stringify({ pipeline: "qa-review" }));
    await writeFile(
      join(pipelinesDir, "default.json"),
      JSON.stringify({ name: "default", stages: [{ name: "in progress", agent: "claude" }] }),
    );
    await writeFile(
      join(pipelinesDir, "qa-review.json"),
      JSON.stringify({ name: "qa-review", stages: [{ name: "in progress", agent: "claude" }] }),
    );

    await importTestRepo(client, testRepoPath, "new-task-modal-test");
  });

  afterAll(async () => {
    if (testRepoPath) {
      await cleanupWorktrees(client, testRepoPath);
    }
    await cleanupFixtureRepos(fixtureRepoRoot ? [fixtureRepoRoot] : []);
    await client.deleteSession();
  });

  it("opens the pipeline selector as a compact dropdown matching the base branch selector", async () => {
    const modalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(modalResult).toBeNull();

    const toggle = await client.waitForElement('[data-testid="pipeline-toggle"]', 5_000);
    await client.click(toggle);
    await client.waitForElement('[data-testid="pipeline-dropdown"]', 2_000);

    const snapshot = await client.executeSync<{
      dropdownClasses: string[];
      optionsClasses: string[];
      optionsStyle: string;
      text: string;
      legacyPickerExists: boolean;
    }>(
      `const dropdown = document.querySelector('[data-testid="pipeline-dropdown"]');
       const options = document.querySelector('[data-testid="pipeline-options"]');
       return {
         dropdownClasses: dropdown ? Array.from(dropdown.classList) : [],
         optionsClasses: options ? Array.from(options.classList) : [],
         optionsStyle: options?.getAttribute("style") ?? "",
         text: dropdown?.textContent ?? "",
         legacyPickerExists: Boolean(document.querySelector(".base-branch-picker")),
       };`
    );

    expect(snapshot.dropdownClasses).toContain("base-branch-dropdown");
    expect(snapshot.optionsClasses).toContain("base-branch-options");
    expect(snapshot.optionsStyle).toContain("max-height");
    expect(snapshot.text).toContain("qa-review");
    expect(snapshot.legacyPickerExists).toBe(false);

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  });

  it("creates Claude tasks in chat mode by default and CLI mode as PTY mode", async () => {
    const themedPrompt = "Create themed Claude task";
    const directCliPrompt = "Create direct Claude task";

    const modalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(modalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    const defaultMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(defaultMode).toBe("claude sdk");

    const promptInput = await client.waitForElement(".prompt-input", 2_000);
    await client.sendKeys(promptInput, themedPrompt);
    await client.click(await client.waitForElement(".modal-actions .btn-primary", 2_000));
    expect(await waitForTaskCreated(client, themedPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "agent",
    }));

    const directModalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(directModalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);
    await client.click(await client.waitForElement(".agent-provider", 2_000));

    const directMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(directMode).toBe("claude");

    const directPromptInput = await client.waitForElement(".prompt-input", 2_000);
    await client.sendKeys(directPromptInput, directCliPrompt);
    await client.click(await client.waitForElement(".modal-actions .btn-primary", 2_000));
    expect(await waitForTaskCreated(client, directCliPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "pty",
    }));
  });

  it("shows CLI choices for providers without chat mode", async () => {
    const modalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(modalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    await client.click(await client.waitForElement(".agent-provider", 2_000));
    await client.click(await client.waitForElement(".agent-provider", 2_000));

    const providerLabel = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(providerLabel).toBe("copilot");

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  });
});
