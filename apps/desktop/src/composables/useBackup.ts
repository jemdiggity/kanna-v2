import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import type { Ref } from "vue";
import type { DbHandle } from "../types/kanna";

const RETENTION_DAYS = 7;
const BACKUP_SUFFIX_REGEX = /\.backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-\d+)?$/;
const LEGACY_APP_DATA_DIR_NAME = "com.kanna.app";
const scheduledStartupBackups = new Set<string>();

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

function resolveSiblingDir(path: string, siblingName: string): string | null {
  const normalized = path.replace(/\/+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) return null;
  return `${normalized.slice(0, slashIndex + 1)}${siblingName}`;
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

export async function migrateLegacyDatabaseIfNeeded(dbName: string): Promise<void> {
  const appDataDir = await invoke<string>("get_app_data_dir");
  const legacyAppDataDir = resolveSiblingDir(appDataDir, LEGACY_APP_DATA_DIR_NAME);
  if (!legacyAppDataDir || legacyAppDataDir === appDataDir) return;

  const dbPath = `${appDataDir}/${dbName}`;
  const currentExists = await invoke<boolean>("file_exists", { path: dbPath });
  if (currentExists) return;

  const legacyDbPath = `${legacyAppDataDir}/${dbName}`;
  const legacyExists = await invoke<boolean>("file_exists", { path: legacyDbPath });
  if (!legacyExists) return;

  await invoke("ensure_directory", { path: appDataDir });
  await invoke("copy_file", { src: legacyDbPath, dst: dbPath });
  await copyIfExists(`${legacyDbPath}-wal`, `${dbPath}-wal`);
  await copyIfExists(`${legacyDbPath}-shm`, `${dbPath}-shm`);

  console.info(`[db] migrated legacy database: ${legacyDbPath} -> ${dbPath}`);
}

export async function createBackup(
  dbName: string,
  _db?: DbHandle | null
): Promise<void> {
  const dbPath = await resolveDbPath(dbName);
  const exists = await invoke<boolean>("file_exists", { path: dbPath });
  if (!exists) return;

  const backupPath = await invoke<string>("backup_sqlite_database", { dbName });

  console.info(`[backup] created: ${backupPath}`);

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
export { parseBackupTimestamp, backupTimestamp, resolveDbPath, resolveSiblingDir };
