/**
 * Test seed data — populates the test DB with realistic records for E2E tests.
 *
 * Usage:
 *   import { seedDatabase, SEED } from "./seed";
 *   await seedDatabase(client);
 *   // reference items by ID: SEED.repos.app.id, SEED.tasks.authRefactor.id, etc.
 */
import { WebDriverClient } from "./webdriver";
import { execDb } from "./vue";
import { resetDatabase } from "./reset";

// ── Deterministic IDs ───────────────────────────────────────────────────────

const REPO_APP = "repo-seed-app";
const REPO_API = "repo-seed-api";

const TASK_AUTH = "task-seed-auth-refactor";
const TASK_DASH = "task-seed-dashboard";
const TASK_ONBOARD = "task-seed-onboarding";
const TASK_PERF = "task-seed-perf-audit";
const TASK_SEARCH = "task-seed-search";
const TASK_NOTIF = "task-seed-notifications";
const TASK_BLOCKED = "task-seed-blocked-migration";
const TASK_DONE = "task-seed-done-cleanup";

const WT_AUTH = "wt-seed-auth";
const WT_DASH = "wt-seed-dashboard";
const WT_SEARCH = "wt-seed-search";

const TS_AUTH = "ts-seed-auth";
const TS_DASH = "ts-seed-dashboard";
const TS_SEARCH = "ts-seed-search";

const AR_AUTH = "ar-seed-auth";
const AR_DASH = "ar-seed-dashboard";
const AR_DONE = "ar-seed-done";
const AR_FAILED = "ar-seed-failed";

// ── Exported handle for referencing seed IDs in tests ───────────────────────

export const SEED = {
  repos: {
    app: { id: REPO_APP, name: "example-app", path: "/Users/test/example-app" },
    api: { id: REPO_API, name: "example-api", path: "/Users/test/example-api" },
  },
  tasks: {
    authRefactor: { id: TASK_AUTH },
    dashboard: { id: TASK_DASH },
    onboarding: { id: TASK_ONBOARD },
    perfAudit: { id: TASK_PERF },
    search: { id: TASK_SEARCH },
    notifications: { id: TASK_NOTIF },
    blockedMigration: { id: TASK_BLOCKED },
    doneCleanup: { id: TASK_DONE },
  },
  worktrees: {
    auth: { id: WT_AUTH },
    dashboard: { id: WT_DASH },
    search: { id: WT_SEARCH },
  },
  terminalSessions: {
    auth: { id: TS_AUTH },
    dashboard: { id: TS_DASH },
    search: { id: TS_SEARCH },
  },
  agentRuns: {
    auth: { id: AR_AUTH },
    dashboard: { id: AR_DASH },
    done: { id: AR_DONE },
    failed: { id: AR_FAILED },
  },
} as const;

// ── Timestamps (spread over the last 7 days) ───────────────────────────────

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function hoursAgo(n: number): string {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// ── Seed logic ──────────────────────────────────────────────────────────────

export async function seedDatabase(client: WebDriverClient): Promise<void> {
  await resetDatabase(client);

  // ── Repos ───────────────────────────────────────────────────────────────
  await execDb(
    client,
    `INSERT INTO repo (id, path, name, default_branch, hidden, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [REPO_APP, "/Users/test/example-app", "example-app", "main", 0, daysAgo(30), hoursAgo(1)]
  );
  await execDb(
    client,
    `INSERT INTO repo (id, path, name, default_branch, hidden, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [REPO_API, "/Users/test/example-api", "example-api", "main", 1, daysAgo(60), daysAgo(14)]
  );

  // ── Pipeline items ──────────────────────────────────────────────────────

  // 1. Auth refactor — in progress, working, pinned
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, stage, branch,
        agent_type, activity, activity_changed_at, pinned, pin_order,
        port_offset, port_env, base_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TASK_AUTH, REPO_APP, 42, "Refactor auth middleware",
      "Refactor the auth middleware to use the new token validation library",
      "in progress", "task-seed-auth-refactor",
      "claude", "working", hoursAgo(0.5), 1, 1,
      1, '{"KANNA_DEV_PORT":"1421"}', "origin/main", daysAgo(3), hoursAgo(0.5),
    ]
  );

  // 2. Dashboard — in progress, idle, pinned
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, stage, branch,
        agent_type, activity, activity_changed_at, pinned, pin_order,
        port_offset, port_env, base_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TASK_DASH, REPO_APP, 51, "Analytics dashboard",
      "Build the operator analytics dashboard with time-series charts",
      "in progress", "task-seed-dashboard",
      "claude", "idle", hoursAgo(6), 1, 2,
      2, '{"KANNA_DEV_PORT":"1422"}', "origin/main", daysAgo(5), hoursAgo(6),
    ]
  );

  // 3. Onboarding flow — in progress, unread
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, stage, branch,
        agent_type, activity, activity_changed_at, unread_at, base_ref,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TASK_ONBOARD, REPO_APP, 55, "First-run onboarding",
      "Create a first-run onboarding flow that walks users through importing a repo",
      "in progress", "task-seed-onboarding",
      "claude", "unread", hoursAgo(2), hoursAgo(2), "origin/main",
      daysAgo(2), hoursAgo(2),
    ]
  );

  // 4. Perf audit — has PR
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, stage, branch,
        agent_type, activity, pr_number, pr_url, base_ref,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TASK_PERF, REPO_APP, 38, "Performance audit",
      "Audit frontend rendering performance and fix the top 3 bottlenecks",
      "pr", "task-seed-perf-audit",
      "claude", "idle", 67, "https://github.com/test/example-app/pull/67", "origin/main",
      daysAgo(7), daysAgo(1),
    ]
  );

  // 5. Search — in progress, working (on api repo)
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, stage, branch,
        agent_type, activity, activity_changed_at,
        port_offset, port_env, base_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TASK_SEARCH, REPO_API, 12, "Full-text search",
      "Implement full-text search across task prompts and issue titles",
      "in progress", "task-seed-search",
      "claude", "working", hoursAgo(1),
      3, '{"KANNA_DEV_PORT":"1423"}', "origin/main", daysAgo(4), hoursAgo(1),
    ]
  );

  await execDb(
    client,
    `INSERT INTO task_port (port, pipeline_item_id, env_name) VALUES (?, ?, ?)`,
    [1421, TASK_AUTH, "KANNA_DEV_PORT"],
  );
  await execDb(
    client,
    `INSERT INTO task_port (port, pipeline_item_id, env_name) VALUES (?, ?, ?)`,
    [1422, TASK_DASH, "KANNA_DEV_PORT"],
  );
  await execDb(
    client,
    `INSERT INTO task_port (port, pipeline_item_id, env_name) VALUES (?, ?, ?)`,
    [1423, TASK_SEARCH, "KANNA_DEV_PORT"],
  );

  // 6. Notifications — merged and closed (closed_at set; stage keeps its
  // last real value under the durable model)
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, stage, branch,
        agent_type, activity, pr_number, pr_url, closed_at, base_ref,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TASK_NOTIF, REPO_APP, 30, "Desktop notifications",
      "Add native desktop notifications when agent runs complete",
      "pr", "task-seed-notifications",
      "claude", "idle", 52, "https://github.com/test/example-app/pull/52", daysAgo(2), "origin/main",
      daysAgo(10), daysAgo(2),
    ]
  );

  // 7. Blocked migration — blocked by auth refactor
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, issue_number, issue_title, prompt, stage, branch,
        agent_type, activity, display_name,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TASK_BLOCKED, REPO_APP, 60, "DB schema migration v3",
      "Run the v3 schema migration after auth refactor lands",
      "in progress", "task-seed-blocked-migration",
      "claude", "idle", "Schema migration (blocked)",
      daysAgo(1), daysAgo(1),
    ]
  );

  // 8. Done cleanup — closed (closed_at is the sole done indicator)
  await execDb(
    client,
    `INSERT INTO pipeline_item
       (id, repo_id, issue_title, prompt, stage,
        agent_type, activity, closed_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TASK_DONE, REPO_APP, "Remove deprecated helpers",
      "Clean up unused helper functions from the utils module",
      "in progress",
      "claude", "idle", daysAgo(5),
      daysAgo(8), daysAgo(5),
    ]
  );

  // ── Worktrees ───────────────────────────────────────────────────────────

  await execDb(
    client,
    `INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at) VALUES (?, ?, ?, ?, ?)`,
    [WT_AUTH, TASK_AUTH, "/Users/test/example-app/.kanna-worktrees/task-seed-auth-refactor", "task-seed-auth-refactor", daysAgo(3)]
  );
  await execDb(
    client,
    `INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at) VALUES (?, ?, ?, ?, ?)`,
    [WT_DASH, TASK_DASH, "/Users/test/example-app/.kanna-worktrees/task-seed-dashboard", "task-seed-dashboard", daysAgo(5)]
  );
  await execDb(
    client,
    `INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at) VALUES (?, ?, ?, ?, ?)`,
    [WT_SEARCH, TASK_SEARCH, "/Users/test/example-api/.kanna-worktrees/task-seed-search", "task-seed-search", daysAgo(4)]
  );

  // ── Terminal sessions ───────────────────────────────────────────────────

  await execDb(
    client,
    `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [TS_AUTH, REPO_APP, TASK_AUTH, "claude", "/Users/test/example-app/.kanna-worktrees/task-seed-auth-refactor", "daemon-sess-1", daysAgo(3)]
  );
  await execDb(
    client,
    `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [TS_DASH, REPO_APP, TASK_DASH, "claude", "/Users/test/example-app/.kanna-worktrees/task-seed-dashboard", "daemon-sess-2", daysAgo(5)]
  );
  await execDb(
    client,
    `INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [TS_SEARCH, REPO_API, TASK_SEARCH, "claude", "/Users/test/example-api/.kanna-worktrees/task-seed-search", "daemon-sess-3", daysAgo(4)]
  );

  // ── Agent runs ──────────────────────────────────────────────────────────

  // Running
  await execDb(
    client,
    `INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [AR_AUTH, REPO_APP, "claude", 42, "running", hoursAgo(0.5)]
  );

  // Running (older)
  await execDb(
    client,
    `INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [AR_DASH, REPO_APP, "claude", 51, "running", hoursAgo(6)]
  );

  // Completed
  await execDb(
    client,
    `INSERT INTO agent_run (id, repo_id, agent_type, issue_number, pr_number, status, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [AR_DONE, REPO_APP, "claude", 30, 52, "completed", daysAgo(10), daysAgo(9)]
  );

  // Failed
  await execDb(
    client,
    `INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at, finished_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [AR_FAILED, REPO_APP, "claude", 38, "failed", daysAgo(8), daysAgo(8), "Claude CLI exited with code 1: context window exceeded"]
  );

  // ── Task blockers ─────────────────────────────────────────────────────

  await execDb(
    client,
    `INSERT INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)`,
    [TASK_BLOCKED, TASK_AUTH]
  );

  // ── Activity log ──────────────────────────────────────────────────────
  // Accumulator schema (db.ts migration 004): one row per
  // (pipeline_item_id, activity) holding total seconds in that activity.

  const activityTotals: Array<[string, string, number]> = [
    [TASK_AUTH, "working", 12600],
    [TASK_AUTH, "idle", 3600],
    [TASK_DASH, "working", 18000],
    [TASK_DASH, "idle", 9000],
    [TASK_ONBOARD, "working", 7200],
    [TASK_ONBOARD, "unread", 1800],
  ];
  for (const [itemId, activity, seconds] of activityTotals) {
    await execDb(
      client,
      `INSERT INTO activity_log (pipeline_item_id, activity, seconds) VALUES (?, ?, ?)`,
      [itemId, activity, seconds]
    );
  }

  // ── Operator events ───────────────────────────────────────────────────

  await execDb(
    client,
    `INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at) VALUES (?, ?, ?, ?)`,
    ["task_selected", TASK_AUTH, REPO_APP, hoursAgo(1)]
  );
  await execDb(
    client,
    `INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at) VALUES (?, ?, ?, ?)`,
    ["app_blur", null, REPO_APP, hoursAgo(0.75)]
  );
  await execDb(
    client,
    `INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at) VALUES (?, ?, ?, ?)`,
    ["app_focus", null, REPO_APP, hoursAgo(0.5)]
  );
  await execDb(
    client,
    `INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at) VALUES (?, ?, ?, ?)`,
    ["task_selected", TASK_DASH, REPO_APP, daysAgo(1)]
  );
}
