import { describe, it, expect, beforeEach, mock } from "bun:test";

// Track all invoke calls
let invokeCalls: { cmd: string; args: any }[] = [];
let invokeResults: Record<string, any> = {};

// Mock the invoke module
mock.module("../invoke", () => ({
  invoke: async (cmd: string, args?: any) => {
    invokeCalls.push({ cmd, args });
    const key = cmd;
    if (key in invokeResults) {
      const val = invokeResults[key];
      if (typeof val === "function") return val(args);
      return val;
    }
    return undefined;
  },
}));

// Mock tauri-mock to report as Tauri environment
mock.module("../tauri-mock", () => ({
  isTauri: true,
}));

// Import after mocks are set up
const { parseBackupTimestamp, backupTimestamp, createBackup, cleanOldBackups, backupOnStartup } = await import("./useBackup");

describe("useBackup", () => {
  beforeEach(() => {
    invokeCalls = [];
    invokeResults = {
      get_app_data_dir: "/mock/data/dir",
      file_exists: true,
      copy_file: undefined,
      remove_file: undefined,
      list_dir: [],
    };
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
    it("copies the DB file with a backup timestamp", async () => {
      await createBackup("kanna-v2.db");

      const copyCall = invokeCalls.find((c) => c.cmd === "copy_file" && !c.args.src.includes("-wal") && !c.args.src.includes("-shm"));
      expect(copyCall).toBeTruthy();
      expect(copyCall!.args.src).toBe("/mock/data/dir/kanna-v2.db");
      expect(copyCall!.args.dst).toMatch(/\/mock\/data\/dir\/kanna-v2\.db\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    it("checks for WAL and SHM sidecars", async () => {
      await createBackup("kanna-v2.db");

      const walCheck = invokeCalls.find(
        (c) => c.cmd === "file_exists" && c.args.path?.includes("-wal")
      );
      const shmCheck = invokeCalls.find(
        (c) => c.cmd === "file_exists" && c.args.path?.includes("-shm")
      );
      expect(walCheck).toBeTruthy();
      expect(shmCheck).toBeTruthy();
    });

    it("copies WAL sidecar when it exists", async () => {
      invokeResults.file_exists = (args: any) => {
        // All files exist
        return true;
      };
      await createBackup("kanna-v2.db");

      const walCopy = invokeCalls.find(
        (c) => c.cmd === "copy_file" && c.args.src?.includes("-wal")
      );
      expect(walCopy).toBeTruthy();
      expect(walCopy!.args.src).toBe("/mock/data/dir/kanna-v2.db-wal");
    });

    it("skips backup if DB file does not exist", async () => {
      invokeResults.file_exists = false;
      await createBackup("kanna-v2.db");

      const copyCall = invokeCalls.find((c) => c.cmd === "copy_file");
      expect(copyCall).toBeUndefined();
    });

    it("flushes WAL when db handle is provided", async () => {
      const mockDb = {
        execute: mock(async () => ({ rowsAffected: 0 })),
        select: mock(async () => []),
      };
      await createBackup("kanna-v2.db", mockDb as any);

      expect(mockDb.execute).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE)");
    });

    it("triggers cleanup after backup", async () => {
      await createBackup("kanna-v2.db");

      // Should call list_dir for cleanup
      const listCall = invokeCalls.find((c) => c.cmd === "list_dir");
      expect(listCall).toBeTruthy();
    });
  });

  describe("cleanOldBackups", () => {
    it("removes backups older than 7 days", async () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const oldTs = oldDate.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");

      invokeResults.list_dir = [
        `kanna-v2.db.backup-${oldTs}`,
        `kanna-v2.db.backup-${oldTs}-wal`,
        `kanna-v2.db.backup-${oldTs}-shm`,
      ];

      await cleanOldBackups("kanna-v2.db");

      const removeCalls = invokeCalls.filter((c) => c.cmd === "remove_file");
      // Should remove the main backup + attempt wal + shm
      expect(removeCalls.length).toBeGreaterThanOrEqual(1);
      expect(removeCalls[0].args.path).toContain("backup-");
    });

    it("keeps recent backups", async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const recentTs = recentDate.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");

      invokeResults.list_dir = [
        `kanna-v2.db.backup-${recentTs}`,
      ];

      await cleanOldBackups("kanna-v2.db");

      const removeCalls = invokeCalls.filter((c) => c.cmd === "remove_file");
      expect(removeCalls.length).toBe(0);
    });

    it("skips sidecar files (cleaned with main backup)", async () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const oldTs = oldDate.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");

      invokeResults.list_dir = [
        `kanna-v2.db.backup-${oldTs}-wal`,
        `kanna-v2.db.backup-${oldTs}-shm`,
      ];

      await cleanOldBackups("kanna-v2.db");

      // Sidecar-only entries should be skipped (they don't match the backup pattern)
      const removeCalls = invokeCalls.filter((c) => c.cmd === "remove_file");
      expect(removeCalls.length).toBe(0);
    });

    it("ignores non-backup files", async () => {
      invokeResults.list_dir = [
        "kanna-v2.db",
        "kanna-v2.db-wal",
        "some-other-file.txt",
      ];

      await cleanOldBackups("kanna-v2.db");

      const removeCalls = invokeCalls.filter((c) => c.cmd === "remove_file");
      expect(removeCalls.length).toBe(0);
    });
  });

  describe("backupOnStartup", () => {
    it("calls createBackup", async () => {
      await backupOnStartup("kanna-v2.db");

      const copyCall = invokeCalls.find((c) => c.cmd === "copy_file");
      expect(copyCall).toBeTruthy();
    });

    it("does not throw on failure", async () => {
      invokeResults.get_app_data_dir = () => {
        throw new Error("simulated failure");
      };

      // Should not throw
      await backupOnStartup("kanna-v2.db");
    });
  });
});
