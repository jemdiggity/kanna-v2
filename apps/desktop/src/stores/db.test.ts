import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@kanna/db";

const readEnvVarMock = vi.fn<(name: string) => Promise<string>>(async () => "");
const backupOnStartupMock = vi.hoisted(() => vi.fn(async () => {}));
const migrateLegacyDatabaseIfNeededMock = vi.hoisted(() => vi.fn(async () => {}));
const pluginSqlState = vi.hoisted(() => ({
  load: vi.fn(async () => ({
    execute: vi.fn(async () => ({ rowsAffected: 0 })),
    select: vi.fn(async () => [{ quick_check: "ok" }]),
  })),
}));

vi.mock("../tauri-mock", () => ({
  isTauri: true,
  getMockDatabase: vi.fn(),
}));

vi.mock("../composables/useBackup", () => ({
  backupOnStartup: backupOnStartupMock,
  migrateLegacyDatabaseIfNeeded: migrateLegacyDatabaseIfNeededMock,
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: pluginSqlState.load,
  },
}));

vi.mock("../invoke", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_env_var") {
      return readEnvVarMock(String(args?.name ?? ""));
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  }),
}));

interface PipelineItemRow {
  stage: string;
  tags: string;
  closed_at: string | null;
  previous_stage?: string | null;
  teardown_started_at?: string | null;
  updated_at?: string | null;
}

interface SchemaMigrationRow {
  id: string;
}

interface RepoRow {
  id: string;
  created_at: string;
  sort_order: number | null;
}

interface SettingRow {
  key: string;
  value: string;
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function createMigrationDb(
  initialRows: PipelineItemRow[],
  initialRepos: RepoRow[] = [],
): DbHandle & {
  pipelineItems: PipelineItemRow[];
  repos: RepoRow[];
  settings: SettingRow[];
  schemaMigrations: SchemaMigrationRow[];
  activityLogDrops: number;
} {
  const pipelineItems = initialRows.map((row) => ({ ...row }));
  const repos = initialRepos.map((repo) => ({ ...repo }));
  const settings: SettingRow[] = [];
  const schemaMigrations: SchemaMigrationRow[] = [];
  let activityLogDrops = 0;

  return {
    pipelineItems,
    repos,
    settings,
    schemaMigrations,
    get activityLogDrops() {
      return activityLogDrops;
    },
    async execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }> {
      const sql = normalizeSql(query);

      if (sql.startsWith("INSERT INTO schema_migrations")) {
        const [id] = bindValues as [string];
        if (!schemaMigrations.some((migration) => migration.id === id)) {
          schemaMigrations.push({ id });
        }
      } else if (sql === "ALTER TABLE repo ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0") {
        for (const repo of repos) {
          repo.sort_order = 0;
        }
      } else if (sql === "UPDATE repo SET sort_order = ? WHERE id = ?") {
        const [sortOrder, id] = bindValues as [number, string];
        const repo = repos.find((candidate) => candidate.id === id);
        if (repo) repo.sort_order = sortOrder;
      } else if (sql === "DROP TABLE IF EXISTS activity_log") {
        activityLogDrops++;
      } else if (sql === "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)") {
        const [key, value] = bindValues as [string, string];
        if (!settings.some((setting) => setting.key === key)) {
          settings.push({ key, value });
        }
      } else if (sql.startsWith("INSERT OR IGNORE INTO settings (key, value) VALUES")) {
        const matches = [...query.matchAll(/\('([^']+)', '([^']+)'\)/g)];
        for (const [, key, value] of matches) {
          if (!settings.some((setting) => setting.key === key)) {
            settings.push({ key, value });
          }
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued'`) {
        for (const item of pipelineItems) {
          if (item.stage === "queued") item.stage = "in_progress";
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'done' WHERE stage IN ('needs_review', 'merged', 'closed')`) {
        for (const item of pipelineItems) {
          if (["needs_review", "merged", "closed"].includes(item.stage)) item.stage = "done";
        }
      } else if (sql === `UPDATE pipeline_item SET tags = '["done"]' WHERE stage = 'done' AND tags = '[]'`) {
        for (const item of pipelineItems) {
          if (item.stage === "done" && item.tags === "[]") item.tags = `["done"]`;
        }
      } else if (sql === `UPDATE pipeline_item SET tags = '["pr"]' WHERE stage = 'pr' AND tags = '[]'`) {
        for (const item of pipelineItems) {
          if (item.stage === "pr" && item.tags === "[]") item.tags = `["pr"]`;
        }
      } else if (sql === `UPDATE pipeline_item SET tags = '["merge"]' WHERE stage = 'merge' AND tags = '[]'`) {
        for (const item of pipelineItems) {
          if (item.stage === "merge" && item.tags === "[]") item.tags = `["merge"]`;
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'merge' AND closed_at IS NULL`) {
        for (const item of pipelineItems) {
          if (item.stage === "merge" && item.closed_at === null) item.stage = "in_progress";
        }
      } else if (sql === `UPDATE pipeline_item SET tags = '["blocked"]' WHERE stage = 'blocked' AND tags = '[]'`) {
        for (const item of pipelineItems) {
          if (item.stage === "blocked" && item.tags === "[]") item.tags = `["blocked"]`;
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'in progress' WHERE tags LIKE '%"in progress"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy')`) {
        for (const item of pipelineItems) {
          if (item.closed_at === null && item.tags.includes(`"in progress"`) && ["in_progress", "legacy"].includes(item.stage)) item.stage = "in progress";
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'pr' WHERE tags LIKE '%"pr"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy')`) {
        for (const item of pipelineItems) {
          if (item.closed_at === null && item.tags.includes(`"pr"`) && ["in_progress", "legacy"].includes(item.stage)) item.stage = "pr";
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'in progress' WHERE tags LIKE '%"merge"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy', 'merge')`) {
        for (const item of pipelineItems) {
          if (item.closed_at === null && item.tags.includes(`"merge"`) && ["in_progress", "legacy", "merge"].includes(item.stage)) item.stage = "in progress";
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'in_progress'`) {
        for (const item of pipelineItems) {
          if (item.stage === "in_progress") item.stage = "in progress";
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'merge' AND closed_at IS NULL`) {
        for (const item of pipelineItems) {
          if (item.stage === "merge" && item.closed_at === null) item.stage = "in progress";
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'legacy'`) {
        for (const item of pipelineItems) {
          if (item.stage === "legacy") item.stage = "in progress";
        }
      } else if (sql === `UPDATE pipeline_item SET stage = 'teardown' WHERE stage = 'torndown'`) {
        for (const item of pipelineItems) {
          if (item.stage === "torndown") item.stage = "teardown";
        }
      } else if (sql === "UPDATE pipeline_item SET teardown_started_at = COALESCE(teardown_started_at, updated_at, datetime('now')), stage = COALESCE(previous_stage, 'in progress'), updated_at = datetime('now') WHERE stage IN ('teardown', 'torndown') AND closed_at IS NULL") {
        for (const item of pipelineItems) {
          if (["teardown", "torndown"].includes(item.stage) && item.closed_at === null) {
            item.teardown_started_at = item.teardown_started_at ?? item.updated_at ?? "now";
            item.stage = item.previous_stage ?? "in progress";
            item.updated_at = "now";
          }
        }
      }

      return { rowsAffected: 1 };
    },
    async select<T>(query: string, bindValues?: unknown[]): Promise<T[]> {
      const sql = normalizeSql(query).toUpperCase();

      if (sql.startsWith("SELECT ID FROM SCHEMA_MIGRATIONS WHERE ID = ?")) {
        const [id] = bindValues as [string];
        return schemaMigrations.filter((migration) => migration.id === id) as unknown as T[];
      }

      if (sql === "SELECT ID FROM REPO ORDER BY CREATED_AT ASC") {
        return [...repos]
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((repo) => ({ id: repo.id })) as unknown as T[];
      }

      return [];
    },
  };
}

describe("runMigrations", () => {
  let runMigrations: typeof import("./db")["runMigrations"];
  let checkDatabaseHealth: typeof import("./db")["checkDatabaseHealth"];
  let resolveDbName: typeof import("./db")["resolveDbName"];
  let loadDatabase: typeof import("./db")["loadDatabase"];
  let db: ReturnType<typeof createMigrationDb>;

  beforeAll(async () => {
    ({ runMigrations, checkDatabaseHealth, resolveDbName, loadDatabase } = await import("./db"));
  });

  beforeEach(() => {
    db = createMigrationDb([]);
    readEnvVarMock.mockReset();
    readEnvVarMock.mockResolvedValue("");
    backupOnStartupMock.mockClear();
    migrateLegacyDatabaseIfNeededMock.mockClear();
    pluginSqlState.load.mockClear();
  });

  it("prefers explicit KANNA_DB_NAME over worktree-derived names", async () => {
    readEnvVarMock.mockImplementation(async (name: string) => {
      if (name === "KANNA_DB_NAME") return "kanna-handoff-shared.db";
      return "";
    });

    await expect(resolveDbName()).resolves.toBe("kanna-handoff-shared.db");
  });

  it("falls back to the default database name when KANNA_DB_NAME is unset", async () => {
    await expect(resolveDbName()).resolves.toBe("kanna-v2.db");
  });

  it("loads the database without waiting for startup backup work", async () => {
    const loaded = await loadDatabase();

    expect(loaded.dbName).toBe("kanna-v2.db");
    expect(migrateLegacyDatabaseIfNeededMock).toHaveBeenCalledWith("kanna-v2.db");
    expect(pluginSqlState.load).toHaveBeenCalledWith("sqlite:kanna-v2.db");
    expect(backupOnStartupMock).not.toHaveBeenCalled();
  });

  it("passes startup health checks when quick_check returns ok", async () => {
    const checkedDb = {
      execute: vi.fn(async () => ({ rowsAffected: 0 })),
      select: vi.fn(async () => [{ quick_check: "ok" }]),
    } satisfies DbHandle;

    await expect(checkDatabaseHealth(checkedDb, "startup")).resolves.toBeUndefined();

    expect(checkedDb.select).toHaveBeenCalledWith("PRAGMA quick_check");
  });

  it("surfaces clear recovery guidance when quick_check reports corruption", async () => {
    const checkedDb = {
      execute: vi.fn(async () => ({ rowsAffected: 0 })),
      select: vi.fn(async () => [{ quick_check: "*** in database main *** On tree page 12 cell 0" }]),
    } satisfies DbHandle;

    await expect(checkDatabaseHealth(checkedDb, "startup")).rejects.toThrow(
      /Database health check failed during startup.*restore from a recent backup/s,
    );
  });

  it("records one-time data migrations so repeated startup does not reapply them", async () => {
    await runMigrations(db);
    await runMigrations(db);

    expect(db.activityLogDrops).toBe(1);
    expect(db.schemaMigrations.length).toBeGreaterThan(0);
  });

  it("adds default theme preferences for existing databases", async () => {
    await runMigrations(db);

    expect(db.settings).toEqual(
      expect.arrayContaining([
        { key: "appTheme", value: "dark" },
        { key: "codeTheme", value: "match" },
        { key: "agentMessageStyle", value: "chat" },
      ]),
    );
    expect(db.schemaMigrations).toContainEqual({ id: "017_theme_preferences" });
    expect(db.schemaMigrations).toContainEqual({ id: "019_agent_message_style_preference" });
  });

  it("does not overwrite a canonical pr stage from stale legacy tags", async () => {
    db = createMigrationDb([
      { stage: "pr", tags: `["in progress"]`, closed_at: null },
    ]);

    await runMigrations(db);

    expect(db.pipelineItems[0]?.stage).toBe("pr");
  });

  it("still migrates genuinely legacy rows from tags", async () => {
    db = createMigrationDb([
      { stage: "in_progress", tags: `["pr"]`, closed_at: null },
      { stage: "legacy", tags: `["merge"]`, closed_at: null },
      { stage: "merge", tags: `["merge"]`, closed_at: null },
    ]);

    await runMigrations(db);

    expect(db.pipelineItems[0]?.stage).toBe("pr");
    expect(db.pipelineItems[1]?.stage).toBe("in progress");
    expect(db.pipelineItems[2]?.stage).toBe("in progress");
  });

  it("normalizes open merge-stage rows even when older stage migrations already ran", async () => {
    db = createMigrationDb([
      { stage: "merge", tags: `["merge"]`, closed_at: null },
      { stage: "merge", tags: `["merge"]`, closed_at: "2026-05-02T00:00:00.000Z" },
    ]);
    db.schemaMigrations.push(
      { id: "003_legacy_stage_to_tags_backfill" },
      { id: "008_tags_to_stage_backfill" },
    );

    await runMigrations(db);

    expect(db.pipelineItems[0]).toMatchObject({
      stage: "in progress",
      tags: `["merge"]`,
      closed_at: null,
    });
    expect(db.pipelineItems[1]?.stage).toBe("merge");
  });

  it("migrates open legacy torndown rows to teardown state", async () => {
    db = createMigrationDb([
      { stage: "torndown", tags: "[]", closed_at: null },
    ]);

    await runMigrations(db);

    expect(db.pipelineItems[0]).toMatchObject({
      stage: "in progress",
      teardown_started_at: "now",
    });
  });

  it("migrates open teardown stage rows to teardown state while preserving their prior stage", async () => {
    db = createMigrationDb([
      {
        stage: "teardown",
        previous_stage: "pr",
        tags: "[]",
        closed_at: null,
        updated_at: "2026-05-01T00:00:00.000Z",
      },
      {
        stage: "teardown",
        previous_stage: "merge",
        tags: "[]",
        closed_at: "2026-05-02T00:00:00.000Z",
      },
    ]);

    await runMigrations(db);

    expect(db.pipelineItems[0]).toMatchObject({
      stage: "pr",
      teardown_started_at: "2026-05-01T00:00:00.000Z",
    });
    expect(db.pipelineItems[1]?.stage).toBe("teardown");
    expect(db.pipelineItems[1]?.teardown_started_at).toBeUndefined();
  });

  it("backfills repo sort_order by creation time for existing databases", async () => {
    db = createMigrationDb([], [
      { id: "repo-newer", created_at: "2026-01-03T00:00:00.000Z", sort_order: null },
      { id: "repo-older", created_at: "2026-01-01T00:00:00.000Z", sort_order: null },
      { id: "repo-middle", created_at: "2026-01-02T00:00:00.000Z", sort_order: null },
    ]);

    await runMigrations(db);

    expect(db.repos).toEqual([
      { id: "repo-newer", created_at: "2026-01-03T00:00:00.000Z", sort_order: 2 },
      { id: "repo-older", created_at: "2026-01-01T00:00:00.000Z", sort_order: 0 },
      { id: "repo-middle", created_at: "2026-01-02T00:00:00.000Z", sort_order: 1 },
    ]);
  });
});
