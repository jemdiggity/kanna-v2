import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  let resolveDbName: typeof import("./db")["resolveDbName"];
  let loadDatabase: typeof import("./db")["loadDatabase"];

  beforeAll(async () => {
    ({ resolveDbName, loadDatabase } = await import("./db"));
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

  it("loads the server-owned database facade without opening frontend SQLite", async () => {
    const loaded = await loadDatabase();

    expect(loaded.dbName).toBe("kanna-v2.db");
    expect(migrateLegacyDatabaseIfNeededMock).toHaveBeenCalledWith("kanna-v2.db");
    await expect(loaded.db.execute("SELECT 1")).rejects.toThrow(
      /frontend SQLite access is disabled/,
    );
  });
});
