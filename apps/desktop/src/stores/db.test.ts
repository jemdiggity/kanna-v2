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
});
