import { resolve } from "path";
import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { WebDriverClient } from "../helpers/webdriver";
import { resetDatabase, importTestRepo, cleanupWorktrees } from "../helpers/reset";
import { callVueMethod, getVueState } from "../helpers/vue";

setDefaultTimeout(65_000);

const TEST_REPO_PATH = resolve(import.meta.dir, "../../../..");

describe("task lifecycle", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await resetDatabase(client);
    await importTestRepo(client, TEST_REPO_PATH, "lifecycle-test");
  });

  afterAll(async () => {
    await cleanupWorktrees(client, TEST_REPO_PATH);
    await client.deleteSession();
  });

  it("logs when the new task becomes visible in store state", async () => {
    const result = await client.executeAsync<string[] | string>(
      `const cb = arguments[arguments.length - 1];
       try {
         const logs = [];
         const originalLog = console.log;
         console.log = function(...args) {
           const line = args.map(function(arg) {
             return typeof arg === "string" ? arg : JSON.stringify(arg);
           }).join(" ");
           logs.push(line);
           return originalLog.apply(this, args);
         };
         const ctx = document.getElementById("app").__vue_app__._instance.setupState;
         const repoId = ctx.selectedRepoId.value || ctx.selectedRepoId;
         const repos = ctx.repos.value || ctx.repos;
         const repo = repos.find(function(r) { return r.id === repoId; });
         if (!repo) {
           console.log = originalLog;
           cb("no repo");
           return;
         }
         ctx.createItem(repoId, repo.path, "Measure visibility", "sdk")
           .then(async function() {
             const deadline = Date.now() + 5000;
             while (Date.now() < deadline) {
               if (logs.some(function(line) { return line.includes("[perf:createItem] items refresh -> visible:"); })) {
                 console.log = originalLog;
                 cb(logs);
                 return;
               }
               await new Promise(function(resolve) { setTimeout(resolve, 50); });
             }
             console.log = originalLog;
             cb(logs);
           })
           .catch(function(e) {
             console.log = originalLog;
             cb("err:" + e);
           });
       } catch(e) { cb("outer:" + e); }`
    );

    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).some((line) => line.includes("[perf:createItem] items refresh -> visible:"))).toBe(true);
  });

  it("creates a task that appears in sidebar", async () => {
    // Use SDK mode so we can verify AgentView output (PTY mode shows TerminalView)
    const result = await client.executeAsync<string>(
      `const cb = arguments[arguments.length - 1];
       try {
         const ctx = document.getElementById("app").__vue_app__._instance.setupState;
         const repoId = ctx.selectedRepoId.value || ctx.selectedRepoId;
         const repos = ctx.repos.value || ctx.repos;
         const repo = repos.find(function(r) { return r.id === repoId; });
         if (!repo) { cb("no repo"); return; }
         ctx.createItem(repoId, repo.path, "Say OK", "sdk")
           .then(function() { cb("ok"); })
           .catch(function(e) { cb("err:" + e); });
       } catch(e) { cb("outer:" + e); }`
    );

    // Task should appear in sidebar with In Progress badge
    const el = await client.waitForText(".sidebar", "In Progress");
    expect(el).toBeTruthy();
  });

  it("shows task header with prompt text", async () => {
    const el = await client.waitForText(".task-header", "Say OK");
    expect(el).toBeTruthy();
  });

  it("shows Agent tab as active", async () => {
    const activeTab = await client.findElement(".tab.active");
    const text = await client.getText(activeTab);
    expect(text.trim()).toBe("Agent");
  });

  it("shows agent output after Claude responds", async () => {
    // Wait for at least one message block to appear (up to 60s for real Claude)
    const el = await client.waitForElement(".agent-view .message-block", 60000);
    expect(el).toBeTruthy();
  }, 65000);

  it("shows result block when completed", async () => {
    const el = await client.waitForElement(".result-block", 60000);
    const text = await client.getText(el);
    expect(text).toContain("Completed");
  }, 65000);

  it("closes task and updates stage", async () => {
    // Find and click the Close button
    const buttons = await client.findElements("button");
    for (const id of buttons) {
      const text = await client.getText(id);
      if (text.trim() === "Close") {
        await client.click(id);
        break;
      }
    }

    // Stage should update to Closed in sidebar
    await Bun.sleep(500);
    const el = await client.waitForText(".sidebar", "Closed");
    expect(el).toBeTruthy();
  });
});
