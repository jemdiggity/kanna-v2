import { invoke } from "../invoke";
import { createDesktopBackup } from "../services/desktopServerClient";
import { isTauri } from "../tauri-mock";
import type { Ref } from "vue";
import type { DbHandle } from "../types/kanna";

const RETENTION_DAYS = 7;
const BACKUP_SUFFIX_REGEX = /\.backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-\d+)?$/;
const scheduledStartupBackups = new Set<string>();

function backupTimestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
}

function parseBackupTimestamp(filename: string): Date | null {
  const match = filename.match(BACKUP_SUFFIX_REGEX);
  if (!match) return null;
  // Restore colons: 2026-03-21T10-30-00 → 2026-03-21T10:30:00
  const isoStr = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3");
  // The server deliberately emits its backup names in UTC. Date strings
  // without an offset are interpreted as local time, which can expire a
  // seven-day-old backup hours early outside UTC.
  const d = new Date(`${isoStr}Z`);
  return isNaN(d.getTime()) ? null : d;
}

async function resolveDbPath(dbName: string): Promise<string> {
  const appDataDir = await invoke<string>("get_app_data_dir");
  return `${appDataDir}/${dbName}`;
}

export async function createBackup(
  dbName: string,
  _db?: DbHandle | null
): Promise<void> {
  const { backupPath } = await createDesktopBackup();

  console.info(`[backup] created: ${backupPath}`);

  // Run retention cleanup
  await cleanOldBackups(dbName, backupDirectory(backupPath));
}

function backupDirectory(backupPath: string): string {
  const separator = Math.max(backupPath.lastIndexOf("/"), backupPath.lastIndexOf("\\"));
  return separator < 0 ? "." : backupPath.slice(0, separator);
}

export async function cleanOldBackups(dbName: string, directory?: string): Promise<void> {
  const backupDir = directory ?? await invoke<string>("get_app_data_dir");
  const files = await invoke<string[]>("list_dir", { path: backupDir });
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const prefix = `${dbName}.backup-`;

  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    // Skip sidecar files — they'll be cleaned with their main backup
    if (file.endsWith("-wal") || file.endsWith("-shm")) continue;

    const ts = parseBackupTimestamp(file);
    if (!ts || ts >= cutoff) continue;

    const fullPath = `${backupDir}/${file}`;
    try {
      await invoke("remove_file", { path: fullPath });
      // Also remove sidecars
      await invoke("remove_file", { path: `${fullPath}-wal` }).catch((error) => {
        console.debug(`[backup] sidecar WAL cleanup skipped for ${file}:`, error);
      });
      await invoke("remove_file", { path: `${fullPath}-shm` }).catch((error) => {
        console.debug(`[backup] sidecar SHM cleanup skipped for ${file}:`, error);
      });
      console.info(`[backup] cleaned old backup: ${file}`);
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

export function scheduleStartupBackup(dbName: string): void {
  if (!isTauri || scheduledStartupBackups.has(dbName)) return;
  scheduledStartupBackups.add(dbName);

  const run = () => {
    void backupOnStartup(dbName);
  };

  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => window.setTimeout(run, 0));
    return;
  }

  setTimeout(run, 0);
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
