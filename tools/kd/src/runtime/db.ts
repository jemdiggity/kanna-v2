import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { CommandRunner } from "./process";

export interface DevDbTarget {
  dbName: string;
  dbPath: string;
}

const productionDbName = "kanna-v2.db";

function resolvedDatabasePath(path: string, depth = 0): string {
  if (depth > 128) throw new Error("REFUSED: database path has too many symbolic links or ancestors.");
  // Preserve symlink/.. traversal until the filesystem resolves it.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      const link = readlinkSync(absolute);
      return resolvedDatabasePath(isAbsolute(link) ? link : `${dirname(absolute)}/${link}`, depth + 1);
    }
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(resolvedDatabasePath(parent, depth + 1), basename(absolute));
  }
}

function fileIdentity(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export function assertNotProductionDb(target: DevDbTarget): void {
  if (!target.dbPath || target.dbPath.startsWith("file:")) {
    throw new Error("REFUSED: database access requires a nonempty filesystem path.");
  }
  const path = resolvedDatabasePath(target.dbPath);
  const identity = fileIdentity(path);
  const home = userInfo().homedir;
  const productionAlias = identity !== undefined &&
    [join(home, "Library", "Application Support"), join(home, ".local", "share")].some(root =>
      ["build.kanna", "com.kanna.app"].some(bundle =>
        fileIdentity(join(root, bundle, productionDbName)) === identity));
  if (target.dbName === productionDbName || basename(path).toLowerCase() === productionDbName || productionAlias) {
    throw new Error(
      "REFUSED: kd will not start, reset, or seed against the production database (kanna-v2.db). Run from a worktree or set KANNA_DB_NAME to a non-production name."
    );
  }
}

export function deleteSqliteDb(dbPath: string): void {
  assertNotProductionDb({ dbName: basename(dbPath), dbPath });
  mkdirSync(dirname(dbPath), { recursive: true });
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

export async function resetSqliteDb(runner: CommandRunner, target: DevDbTarget): Promise<void> {
  assertNotProductionDb(target);
  deleteSqliteDb(target.dbPath);
  const result = await runner.run("sqlite3", [target.dbPath, "PRAGMA user_version;"]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to initialize ${target.dbPath}: ${result.stderr}`);
  }
}

export async function seedSqliteDb(runner: CommandRunner, repoRoot: string, dbPath: string): Promise<void> {
  assertNotProductionDb({ dbName: basename(dbPath), dbPath });
  const seedPath = join(repoRoot, "apps", "desktop", "tests", "e2e", "seed.sql");
  const result = await runner.run("sqlite3", [dbPath, `.read ${seedPath}`]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to seed ${dbPath}: ${result.stderr}`);
  }
}
