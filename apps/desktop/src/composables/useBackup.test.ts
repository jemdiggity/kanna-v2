import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface InvokeCall {
  cmd: string;
  args: unknown;
}

const testState = {
  invokeCalls: [] as InvokeCall[],
  invokeResults: {} as Record<string, unknown>,
};

// Mock the invoke module
vi.mock("../invoke", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    testState.invokeCalls.push({ cmd, args });
    const key = cmd;
    if (key in testState.invokeResults) {
      const val = testState.invokeResults[key];
      if (typeof val === "function") return val(args);
      return val;
    }
    return undefined;
  },
}));

// Mock tauri-mock to report as Tauri environment
vi.mock("../tauri-mock", () => ({
  isTauri: true,
}));

// Import after mocks are set up
const {
  parseBackupTimestamp,
  backupTimestamp,
  createBackup,
  cleanOldBackups,
  backupOnStartup,
  scheduleStartupBackup,
  migrateLegacyDatabaseIfNeeded,
} = await import("./useBackup");

describe("useBackup", () => {
  beforeEach(() => {
    vi.useRealTimers();
    testState.invokeCalls = [];
    testState.invokeResults = {
      get_app_data_dir: "/mock/data/dir",
      file_exists: true,
      copy_file: undefined,
      remove_file: undefined,
      list_dir: [],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("parseBackupTimestamp", () => {
    it("parses a valid backup filename", () => {
      const ts = parseBackupTimestamp("kanna-v2.db.backup-2026-03-21T10-30-00");
      expect(ts).toBeInstanceOf(Date);
      expect(ts!.getFullYear()).toBe(2026);
      expect(ts!.getMonth()).toBe(2); // March = 2
      expect(ts!.getDate()).toBe(21);
      expect(ts!.getHours()).toBe(10);
      expect(ts!.getMinutes()).toBe(30);
    });

    it("parses a valid backup filename with a collision suffix", () => {
      const ts = parseBackupTimestamp("kanna-v2.db.backup-2026-03-21T10-30-00-1");
      expect(ts).toBeInstanceOf(Date);
      expect(ts!.getFullYear()).toBe(2026);
      expect(ts!.getMinutes()).toBe(30);
    });

    it("returns null for non-backup filenames", () => {
      expect(parseBackupTimestamp("kanna-v2.db")).toBeNull();
      expect(parseBackupTimestamp("random-file.txt")).toBeNull();
    });

    it("returns null for invalid timestamps", () => {
      expect(parseBackupTimestamp("kanna-v2.db.backup-not-a-date")).toBeNull();
    });
  });

  describe("backupTimestamp", () => {
    it("returns an ISO-like timestamp with hyphens instead of colons", () => {
      const ts = backupTimestamp();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
      // Should not contain colons
      expect(ts).not.toContain(":");
    });
  });

  describe("createBackup", () => {
    it("creates the backup through the SQLite backup command", async () => {
      await createBackup("kanna-v2.db");

      const backupCall = testState.invokeCalls.find((c) => c.cmd === "backup_sqlite_database");
      expect(backupCall).toBeTruthy();
      expect(backupCall!.args).toEqual({ dbName: "kanna-v2.db" });
    });

    it("does not copy WAL and SHM sidecars from a live database", async () => {
      await createBackup("kanna-v2.db");

      const liveCopyCall = testState.invokeCalls.find((c) =>
        c.cmd === "copy_file" && String((c.args as { src?: string }).src).includes("kanna-v2.db")
      );
      expect(liveCopyCall).toBeUndefined();
    });

    it("skips backup if DB file does not exist", async () => {
      testState.invokeResults.file_exists = false;
      await createBackup("kanna-v2.db");

      const backupCall = testState.invokeCalls.find((c) => c.cmd === "backup_sqlite_database");
      expect(backupCall).toBeUndefined();
    });

    it("does not truncate WAL while an independent server writer may be active", async () => {
      const mockDb = {
        execute: vi.fn(async () => ({ rowsAffected: 0 })),
        select: vi.fn(async () => []),
      };
      await createBackup("kanna-v2.db", mockDb as never);

      expect(mockDb.execute).not.toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE)");
    });

    it("triggers cleanup after backup", async () => {
      await createBackup("kanna-v2.db");

      // Should call list_dir for cleanup
      const listCall = testState.invokeCalls.find((c) => c.cmd === "list_dir");
      expect(listCall).toBeTruthy();
    });
  });

  describe("migrateLegacyDatabaseIfNeeded", () => {
    it("copies a legacy database into the current app data dir", async () => {
      testState.invokeResults.get_app_data_dir = "/mock/data/build.kanna";
      testState.invokeResults.file_exists = ({ path }: { path: string }) =>
        path === "/mock/data/com.kanna.app/kanna-v2.db" ||
        path === "/mock/data/com.kanna.app/kanna-v2.db-wal";

      await migrateLegacyDatabaseIfNeeded("kanna-v2.db");

      const ensureDirCall = testState.invokeCalls.find((c) => c.cmd === "ensure_directory");
      expect((ensureDirCall?.args as { path: string }).path).toBe("/mock/data/build.kanna");

      const copyCalls = testState.invokeCalls.filter((c) => c.cmd === "copy_file");
      expect(copyCalls).toEqual([
        {
          cmd: "copy_file",
          args: {
            src: "/mock/data/com.kanna.app/kanna-v2.db",
            dst: "/mock/data/build.kanna/kanna-v2.db",
          },
        },
        {
          cmd: "copy_file",
          args: {
            src: "/mock/data/com.kanna.app/kanna-v2.db-wal",
            dst: "/mock/data/build.kanna/kanna-v2.db-wal",
          },
        },
      ]);
    });

    it("skips migration when the current database already exists", async () => {
      testState.invokeResults.get_app_data_dir = "/mock/data/build.kanna";
      testState.invokeResults.file_exists = ({ path }: { path: string }) =>
        path === "/mock/data/build.kanna/kanna-v2.db";

      await migrateLegacyDatabaseIfNeeded("kanna-v2.db");

      const copyCall = testState.invokeCalls.find((c) => c.cmd === "copy_file");
      expect(copyCall).toBeUndefined();
    });

    it("skips migration when there is no legacy database to copy", async () => {
      testState.invokeResults.get_app_data_dir = "/mock/data/build.kanna";
      testState.invokeResults.file_exists = false;

      await migrateLegacyDatabaseIfNeeded("kanna-v2.db");

      const copyCall = testState.invokeCalls.find((c) => c.cmd === "copy_file");
      expect(copyCall).toBeUndefined();
    });
  });

  describe("cleanOldBackups", () => {
    it("removes backups older than 7 days", async () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const oldTs = oldDate.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");

      testState.invokeResults.list_dir = [
        `kanna-v2.db.backup-${oldTs}`,
        `kanna-v2.db.backup-${oldTs}-wal`,
        `kanna-v2.db.backup-${oldTs}-shm`,
      ];

      await cleanOldBackups("kanna-v2.db");

      const removeCalls = testState.invokeCalls.filter((c) => c.cmd === "remove_file");
      // Should remove the main backup + attempt wal + shm
      expect(removeCalls.length).toBeGreaterThanOrEqual(1);
      expect((removeCalls[0].args as { path: string }).path).toContain("backup-");
    });

    it("keeps recent backups", async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const recentTs = recentDate.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");

      testState.invokeResults.list_dir = [
        `kanna-v2.db.backup-${recentTs}`,
      ];

      await cleanOldBackups("kanna-v2.db");

      const removeCalls = testState.invokeCalls.filter((c) => c.cmd === "remove_file");
      expect(removeCalls.length).toBe(0);
    });

    it("skips sidecar files (cleaned with main backup)", async () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const oldTs = oldDate.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");

      testState.invokeResults.list_dir = [
        `kanna-v2.db.backup-${oldTs}-wal`,
        `kanna-v2.db.backup-${oldTs}-shm`,
      ];

      await cleanOldBackups("kanna-v2.db");

      // Sidecar-only entries should be skipped (they don't match the backup pattern)
      const removeCalls = testState.invokeCalls.filter((c) => c.cmd === "remove_file");
      expect(removeCalls.length).toBe(0);
    });

    it("ignores non-backup files", async () => {
      testState.invokeResults.list_dir = [
        "kanna-v2.db",
        "kanna-v2.db-wal",
        "some-other-file.txt",
      ];

      await cleanOldBackups("kanna-v2.db");

      const removeCalls = testState.invokeCalls.filter((c) => c.cmd === "remove_file");
      expect(removeCalls.length).toBe(0);
    });
  });

  describe("backupOnStartup", () => {
    it("calls createBackup", async () => {
      await backupOnStartup("kanna-v2.db");

      const backupCall = testState.invokeCalls.find((c) => c.cmd === "backup_sqlite_database");
      expect(backupCall).toBeTruthy();
    });

    it("does not throw on failure", async () => {
      testState.invokeResults.get_app_data_dir = () => {
        throw new Error("simulated failure");
      };

      // Should not throw
      await backupOnStartup("kanna-v2.db");
    });
  });

  describe("scheduleStartupBackup", () => {
    it("defers and deduplicates startup backups for a database name", async () => {
      vi.useFakeTimers();
      const requestAnimationFrameSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback) => {
          callback(0);
          return 1;
        });

      scheduleStartupBackup("kanna-v2-scheduled.db");
      scheduleStartupBackup("kanna-v2-scheduled.db");

      expect(testState.invokeCalls.find((c) => c.cmd === "backup_sqlite_database")).toBeUndefined();

      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => {
        const backupCalls = testState.invokeCalls.filter((c) => c.cmd === "backup_sqlite_database");
        expect(backupCalls).toHaveLength(1);
      });

      const backupCalls = testState.invokeCalls.filter((c) => c.cmd === "backup_sqlite_database");
      expect(backupCalls[0]!.args).toEqual({ dbName: "kanna-v2-scheduled.db" });

      requestAnimationFrameSpy.mockRestore();
    });
  });
});
