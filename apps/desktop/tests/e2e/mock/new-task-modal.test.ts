import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, queryDb } from "../helpers/vue";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import { buildGlobalKeydownScript, buildSelectorKeydownScript } from "../helpers/keyboard";
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

  async function setDefaultAgentPreference(value: "claude-sdk" | "codex-sdk") {
    await client.executeSync(buildGlobalKeydownScript({ key: ",", meta: true }));
    await client.waitForElement(".prefs-panel", 2_000);

    await client.executeSync(`
      const select = document.querySelector('[data-testid="default-agent-select"]');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `);

    const expectedProvider = value.replace("-sdk", "");
    const deadline = Date.now() + 5_000;
    let persistedSettings: Record<string, string> = {};
    while (Date.now() < deadline) {
      const rows = await queryDb(
        client,
        "SELECT key, value FROM settings WHERE key IN ('defaultAgentProvider', 'defaultAgentType')",
      ) as Array<{ key: string; value: string }>;
      persistedSettings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      if (persistedSettings.defaultAgentProvider === expectedProvider && persistedSettings.defaultAgentType === "agent") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(persistedSettings).toMatchObject({
      defaultAgentProvider: expectedProvider,
      defaultAgentType: "agent",
    });

    await client.executeSync(buildSelectorKeydownScript(".modal-overlay", { key: "Escape" }));
    await client.waitForNoElement(".prefs-panel", 2_000);
  }

  async function cycleAgentTo(label: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await client.executeSync<string>(
        `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
      );
      if (current === label) return;
      await client.click(await client.waitForElement(".agent-provider", 2_000));
    }
    const current = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    throw new Error(`agent choice did not reach ${label}; current=${current}`);
  }

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

  it("creates Claude tasks in CLI mode by default and SDK mode as chat mode", async () => {
    const cliPrompt = "Create CLI Claude task";
    const sdkPrompt = "Create SDK Claude task";

    const modalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(modalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    const defaultMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(defaultMode).toBe("claude");

    const promptInput = await client.waitForElement(".prompt-input", 2_000);
    await client.sendKeys(promptInput, cliPrompt);
    await client.click(await client.waitForElement(".modal-actions .btn-primary", 2_000));
    expect(await waitForTaskCreated(client, cliPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "pty",
    }));

    const directModalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(directModalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);
    await cycleAgentTo("claude sdk");

    const directMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(directMode).toBe("claude sdk");

    const sdkPromptInput = await client.waitForElement(".prompt-input", 2_000);
    await client.sendKeys(sdkPromptInput, sdkPrompt);
    await client.click(await client.waitForElement(".modal-actions .btn-primary", 2_000));
    expect(await waitForTaskCreated(client, sdkPrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "agent",
    }));
  });

  it("cycles through installed agents alphabetically", async () => {
    const modalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(modalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    await client.click(await client.waitForElement(".agent-provider", 2_000));

    const providerLabel = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(providerLabel).toBe("codex");

    await client.executeSync(buildGlobalKeydownScript({ key: "Escape" }));
  });

  it("uses the persisted sdk default agent preference when creating tasks", async () => {
    const codexPrompt = "Create persisted Codex SDK task";
    const claudePrompt = "Create persisted Claude SDK task";

    await setDefaultAgentPreference("codex-sdk");

    const codexModalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(codexModalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    const codexMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(codexMode).toBe("codex sdk");

    await client.sendKeys(await client.waitForElement(".prompt-input", 2_000), codexPrompt);
    await client.click(await client.waitForElement(".modal-actions .btn-primary", 2_000));
    expect(await waitForTaskCreated(client, codexPrompt)).toEqual(expect.objectContaining({
      agent_provider: "codex",
      agent_type: "agent",
    }));

    await setDefaultAgentPreference("claude-sdk");

    const claudeModalResult = await callVueMethod(client, "keyboardActions.newTask");
    expect(claudeModalResult).toBeNull();
    await client.waitForElement(".modal-overlay", 5_000);

    const claudeMode = await client.executeSync<string>(
      `return document.querySelector(".agent-provider")?.textContent?.trim() ?? "";`,
    );
    expect(claudeMode).toBe("claude sdk");

    await client.sendKeys(await client.waitForElement(".prompt-input", 2_000), claudePrompt);
    await client.click(await client.waitForElement(".modal-actions .btn-primary", 2_000));
    expect(await waitForTaskCreated(client, claudePrompt)).toEqual(expect.objectContaining({
      agent_provider: "claude",
      agent_type: "agent",
    }));
  });
});
