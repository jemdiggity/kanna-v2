import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNotProductionDb, deleteSqliteDb, seedSqliteDb, resetSqliteDb } from "../src/runtime/db";
import type { CommandRunner } from "../src/runtime/process";

describe("dev database safety", () => {
  it("refuses production database names and paths", () => {
    expect(() => assertNotProductionDb({ dbName: "kanna-v2.db", dbPath: "/tmp/dev.db" })).toThrow(
      "production database"
    );
    expect(() => assertNotProductionDb({ dbName: "dev.db", dbPath: "/Users/test/Library/Application Support/build.kanna/kanna-v2.db" })).toThrow(
      "production database"
    );
  });

  it("deletes sqlite sidecars and recreates an openable dev database before startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-db-"));
    const dbPath = join(dir, "dev.db");
    writeFileSync(dbPath, "old");
    writeFileSync(`${dbPath}-wal`, "wal");
    writeFileSync(`${dbPath}-shm`, "shm");
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        writeFileSync(dbPath, "");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await resetSqliteDb(runner, { dbName: "dev.db", dbPath });

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(calls).toEqual([`sqlite3 ${dbPath} PRAGMA user_version;`]);
  });

  it("refuses production at the direct delete and seed boundaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-db-guard-"));
    const dbPath = join(dir, "kanna-v2.db");
    writeFileSync(dbPath, "owner data");
    const runner: CommandRunner = {
      async run() { throw new Error("must never execute SQLite"); }
    };
    expect(() => deleteSqliteDb(dbPath)).toThrow("production database");
    await expect(seedSqliteDb(runner, dir, dbPath)).rejects.toThrow("production database");
    expect(readFileSync(dbPath, "utf8")).toBe("owner data");
    rmSync(dir, { recursive: true });
  });

  it("refuses aliases even before the production file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-db-alias-"));
    const production = join(dir, "kanna-v2.db");
    const alias = join(dir, "dev.db");
    symlinkSync(production, alias);
    expect(() => deleteSqliteDb(alias)).toThrow("production database");
    writeFileSync(production, "owner data");
    expect(() => deleteSqliteDb(alias)).toThrow("production database");
    expect(readFileSync(production, "utf8")).toBe("owner data");
    rmSync(dir, { recursive: true });
  });
  it("resolves symlink parents before interpreting dot-dot", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-db-parent-alias-"));
    const parent = join(dir, "real", "parent");
    mkdirSync(join(parent, "child"), { recursive: true });
    writeFileSync(join(parent, "kanna-v2.db"), "owner data");
    symlinkSync("kanna-v2.db", join(parent, "dev.db"));
    symlinkSync(join(parent, "child"), join(dir, "alias"));
    expect(() => assertNotProductionDb({
      dbName: "dev.db", dbPath: `${dir}/alias/../dev.db`
    })).toThrow("production database");
    rmSync(dir, { recursive: true });
  });
});
