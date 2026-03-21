import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import type { Ref } from "vue";
import type { DbHandle } from "@kanna/db";

const RETENTION_DAYS = 7;
const BACKUP_SUFFIX_REGEX = /\.backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/;

function backupTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
}

function parseBackupTimestamp(filename: string): Date | null {
  const match = filename.match(BACKUP_SUFFIX_REGEX);
  if (!match) return null;
  // Restore colons: 2026-03-21T10-30-00 → 2026-03-21T10:30:00
  const isoStr = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3");
  const d = new Date(isoStr);
  return isNaN(d.getTime()) ? null : d;
}

async function copyIfExists(src: string, dst: string): Promise<void> {
  const exists = await invoke<boolean>("file_exists", { path: src });
  if (exists) {
    await invoke("copy_file", { src, dst });
  }
}

async function resolveDbPath(dbName: string): Promise<string> {
  const appDataDir = await invoke<string>("get_app_data_dir");
  return `${appDataDir}/${dbName}`;
}

export async function createBackup(
  dbName: string,
  db?: DbHandle | null
): Promise<void> {
  const dbPath = await resolveDbPath(dbName);
  const exists = await invoke<boolean>("file_exists", { path: dbPath });
  if (!exists) return;

  // Flush WAL if we have an open connection
  if (db) {
    try {
      await db.execute("PRAGMA wal_checkpoint(PASSIVE)");
    } catch (e) {
      console.warn("[backup] WAL checkpoint failed (non-fatal):", e);
    }
  }

  const ts = backupTimestamp();
  const backupPath = `${dbPath}.backup-${ts}`;

  // Copy main DB file
  await invoke("copy_file", { src: dbPath, dst: backupPath });

  // Copy WAL/SHM sidecars if they exist
  await copyIfExists(`${dbPath}-wal`, `${backupPath}-wal`);
  await copyIfExists(`${dbPath}-shm`, `${backupPath}-shm`);

  console.log(`[backup] created: ${backupPath}`);

  // Run retention cleanup
  await cleanOldBackups(dbName);
}

export async function cleanOldBackups(dbName: string): Promise<void> {
  const appDataDir = await invoke<string>("get_app_data_dir");
  const files = await invoke<string[]>("list_dir", { path: appDataDir });
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const prefix = `${dbName}.backup-`;

  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    // Skip sidecar files — they'll be cleaned with their main backup
    if (file.endsWith("-wal") || file.endsWith("-shm")) continue;

    const ts = parseBackupTimestamp(file);
    if (!ts || ts >= cutoff) continue;

    const fullPath = `${appDataDir}/${file}`;
    try {
      await invoke("remove_file", { path: fullPath });
      // Also remove sidecars
      await invoke("remove_file", { path: `${fullPath}-wal` }).catch(() => {});
      await invoke("remove_file", { path: `${fullPath}-shm` }).catch(() => {});
      console.log(`[backup] cleaned old backup: ${file}`);
    } catch (e) {
      console.warn(`[backup] failed to remove ${file}:`, e);
    }
  }
}

export async function backupOnStartup(dbName: string): Promise<void> {
  if (!isTauri) return;
  try {
    await createBackup(dbName);
  } catch (e) {
    console.error("[backup] startup backup failed (non-fatal):", e);
  }
}

export function startPeriodicBackup(
  dbName: string,
  db: Ref<DbHandle | null>,
  intervalMs: number = 4 * 60 * 60 * 1000
): () => void {
  if (!isTauri) return () => {};

  const id = setInterval(async () => {
    try {
      await createBackup(dbName, db.value);
    } catch (e) {
      console.error("[backup] periodic backup failed (non-fatal):", e);
    }
  }, intervalMs);

  return () => clearInterval(id);
}

// Exported for testing
export { parseBackupTimestamp, backupTimestamp, resolveDbPath };
