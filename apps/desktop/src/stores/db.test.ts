import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../types/kanna";

const readEnvVarMock = vi.fn<(name: string) => Promise<string>>(async () => "");
const migrateLegacyDatabaseIfNeededMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("../composables/useBackup", () => ({
  migrateLegacyDatabaseIfNeeded: migrateLegacyDatabaseIfNeededMock,
}));

vi.mock("../invoke", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_env_var") {
      return readEnvVarMock(String(args?.name ?? ""));
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  }),
}));

describe("desktop DB bootstrap boundary", () => {
  let runMigrations: typeof import("./db")["runMigrations"];
  let resolveDbName: typeof import("./db")["resolveDbName"];
  let loadDatabase: typeof import("./db")["loadDatabase"];

  beforeAll(async () => {
    ({ runMigrations, resolveDbName, loadDatabase } = await import("./db"));
  });

  beforeEach(() => {
    readEnvVarMock.mockReset();
    readEnvVarMock.mockResolvedValue("");
    migrateLegacyDatabaseIfNeededMock.mockClear();
  });

  it("prefers explicit KANNA_DB_NAME over the default name", async () => {
    readEnvVarMock.mockImplementation(async (name: string) => {
      if (name === "KANNA_DB_NAME") return "kanna-handoff-shared.db";
      return "";
    });

    await expect(resolveDbName()).resolves.toBe("kanna-handoff-shared.db");
  });

  it("falls back to the default database name when KANNA_DB_NAME is unset", async () => {
    await expect(resolveDbName()).resolves.toBe("kanna-v2.db");
  });

  it("loads only the compatibility DB handle and never imports plugin-sql", async () => {
    const loaded = await loadDatabase();

    expect(loaded.dbName).toBe("kanna-v2.db");
    expect(migrateLegacyDatabaseIfNeededMock).toHaveBeenCalledWith("kanna-v2.db");
    await expect(loaded.db.execute("SELECT 1")).rejects.toThrow(/frontend SQLite access is disabled/);
  });

  it("keeps runMigrations as a no-op when the server migration marker exists", async () => {
    const db = {
      execute: vi.fn(async () => ({ rowsAffected: 0 })),
      select: vi.fn(async () => [{ id: "026_stage_run_resume" }]),
    } satisfies DbHandle;

    await expect(runMigrations(db)).resolves.toBeUndefined();

    expect(db.select).toHaveBeenCalledWith(
      "SELECT id FROM schema_migrations WHERE id = ?",
      ["026_stage_run_resume"],
    );
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("logs and skips legacy migrations when the marker probe fails unexpectedly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      execute: vi.fn(async () => ({ rowsAffected: 0 })),
      select: vi.fn(async () => {
        throw new Error("database is locked");
      }),
    } satisfies DbHandle;

    try {
      await expect(runMigrations(db)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "[db] server schema marker probe failed; skipping legacy frontend migrations:",
        expect.any(Error),
      );
      expect(db.execute).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the temporary frontend migration fallback when the server marker is absent", async () => {
    const appliedMigrations: string[] = [];
    const db = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (/INSERT INTO schema_migrations/i.test(sql)) {
          appliedMigrations.push(String(params[0]));
        }
        return { rowsAffected: 1 };
      }),
      select: vi.fn(async <T>(sql: string, params: unknown[] = []) => {
        if (/FROM schema_migrations/i.test(sql)) {
          const migrationId = String(params[0]);
          return appliedMigrations.includes(migrationId)
            ? ([{ id: migrationId }] as T[])
            : [];
        }
        return [];
      }),
    } satisfies DbHandle;

    await expect(runMigrations(db)).resolves.toBeUndefined();

    expect(appliedMigrations[0]).toBe("001_default_settings");
    expect(appliedMigrations).toContain("026_stage_run_resume");
    expect(appliedMigrations.at(-1)).toBe("026_stage_run_resume");
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations"));
  });
});
