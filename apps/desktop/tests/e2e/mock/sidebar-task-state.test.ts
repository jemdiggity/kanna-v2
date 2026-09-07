import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { seedDatabase } from "../helpers/seed";
import { execDb } from "../helpers/vue";

interface SidebarRowPresentation {
  title: string;
  fontStyle: string;
  color: string;
  unread: boolean;
}

describe("sidebar runtime and read state", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
    await seedDatabase(client);
    await execDb(
      client,
      `INSERT INTO pipeline_item
         (id, repo_id, issue_title, prompt, pipeline, stage, activity,
          runtime_status, agent_provider, created_at, updated_at)
       VALUES
         ('task-state-waiting', 'repo-seed-app', 'Waiting for operator',
          'Waiting for operator', 'default', 'in progress', 'idle', 'waiting',
          'claude', datetime('now'), datetime('now'))`,
    );
    await client.reload();
    await client.waitForText(".sidebar", "Refactor auth middleware");
    await client.executeSync(
      `const ctx = window.__KANNA_E2E__.setupState;
       const items = ctx.store.items?.value ?? ctx.store.items;
       const states = {
         'task-seed-auth-refactor': ['unread', 'busy', 'unread'],
         'task-seed-perf-audit': ['working', 'busy', 'read'],
         'task-seed-onboarding': ['unread', 'idle', 'unread'],
         'task-state-waiting': ['idle', 'waiting', 'read'],
       };
       for (const item of items) {
         const state = states[item.id];
         if (!state) continue;
         [item.activity, item.runtime_state, item.read_state] = state;
       }`,
    );
    await sleep(250);
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("renders runtime as the primary style and unread as a separate dot", async () => {
    const rows = await client.executeSync<Record<string, SidebarRowPresentation>>(
      `return Object.fromEntries([
        ['busyUnread', 'task-seed-auth-refactor'],
        ['busyRead', 'task-seed-perf-audit'],
        ['idleUnread', 'task-seed-onboarding'],
        ['waiting', 'task-state-waiting'],
        ['blocked', 'task-seed-blocked-migration'],
      ].map(([key, id]) => {
        const row = document.querySelector('[data-task-id="' + id + '"]');
        const title = row?.querySelector('.item-title');
        if (!row || !title) throw new Error('missing sidebar row ' + id);
        const style = getComputedStyle(title);
        return [key, {
          title: title.textContent.trim(),
          fontStyle: style.fontStyle,
          color: style.color,
          unread: Boolean(row.querySelector('.unread-task-dot')),
        }];
      }));`,
    );

    expect(rows.busyUnread).toMatchObject({ fontStyle: "italic", unread: true });
    expect(rows.busyRead).toMatchObject({ fontStyle: "italic", unread: false });
    expect(rows.idleUnread).toMatchObject({ fontStyle: "normal", unread: true });
    expect(rows.waiting).toMatchObject({ fontStyle: "normal", unread: false });
    expect(rows.blocked.fontStyle).toBe("normal");
    expect(rows.blocked.color).not.toBe(rows.idleUnread.color);

    const screenshotDir = resolve(
      process.cwd(),
      "../..",
      "docs/task-screenshots/79ceeca2-screenshots",
    );
    await mkdir(screenshotDir, { recursive: true });
    await client.screenshot(resolve(screenshotDir, "sidebar-runtime-read-states.png"));
  });
});
