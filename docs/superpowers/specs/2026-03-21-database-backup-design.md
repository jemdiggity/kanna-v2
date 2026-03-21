# Database Backup Feature — Design Spec

## Motivation

Protect against data loss from corruption, accidental deletion, or bad migrations. The database contains task metadata, repo references, settings, and pipeline state — losing it means losing the full history of managed work.

## Requirements

- Automatic backup on app startup (before migrations)
- Periodic backup every 4 hours while the app is running
- Backups stored in the same directory as the database file
- Time-based retention: delete backups older than 7 days
- Completely silent — no UI, console logging only
- Sensible hardcoded defaults, no user-configurable settings
- Never block app startup or normal operation on backup failure

## Approach

Hybrid frontend + Rust implementation. Timing and orchestration live in a Vue composable (`useBackup`). File operations (copy, list, delete, path resolution) are handled by new Rust Tauri commands in the existing `commands/fs.rs` module. This avoids adding `@tauri-apps/plugin-fs` (which would require plugin registration, Cargo dependency, and Tauri v2 scoped permissions) while keeping the orchestration pattern consistent with existing composables.

## Design

### Database Path Resolution

`tauri-plugin-sql` resolves `sqlite:kanna-v2.db` to the app's data directory internally (`~/Library/Application Support/Kanna/` on macOS). The frontend never sees the absolute path. To bridge this gap:

- Add a new Rust Tauri command `get_app_data_dir(app: AppHandle) -> String` that returns the app's data directory path via `app.path().app_data_dir()`
- The composable constructs the full DB path: `{appDataDir}/{dbName}`
- This works for both default (`kanna-v2.db`) and worktree (`kanna-wt-*.db`) databases, since `dbName` is already resolved in `App.vue` before the backup runs

### Rust Commands

Add to `apps/desktop/src-tauri/src/commands/fs.rs`:

- **`get_app_data_dir(app: AppHandle) -> Result<String, String>`** — returns the absolute path to the app data directory. Note: `AppHandle` is injected by the Tauri runtime automatically — the frontend calls `invoke("get_app_data_dir")` with no arguments.
- **`copy_file(src: String, dst: String) -> Result<(), String>`** — copies a file. Used for the DB backup.
- **`remove_file(path: String) -> Result<(), String>`** — deletes a file. Used for retention cleanup.
- **`list_dir(path: String) -> Result<Vec<String>, String>`** — lists filenames (non-recursive) in a directory. Used to find existing backups. Note: the existing `list_files` command is a recursive repo walker with skip rules for `.git`, `node_modules`, etc. — it is not suitable for flat directory listing.

These are generic filesystem utilities consistent with the existing `file_exists`, `read_text_file`, and `write_text_file` commands.

### Backup Mechanism

New composable: `apps/desktop/src/composables/useBackup.ts`

Exports:
- **`backupOnStartup(dbName: string)`** — called from `App.vue` before `runMigrations()`. Resolves the full DB path via `get_app_data_dir` + `dbName`. Checks if the DB file exists. If it does, copies it to `{dbPath}.backup-{timestamp}`. On failure, logs to console and continues.
- **`startPeriodicBackup(dbName: string, db: DbHandle, intervalMs: number)`** — starts a `setInterval` timer. Called after full app initialization. Accepts the open `DbHandle` so it can flush WAL before copying. Returns a cleanup function to clear the interval on unmount.

Both use a shared `createBackup(dbName: string, db?: DbHandle)` function that performs the backup and triggers retention cleanup.

**Backup filename format:** `kanna-v2.db.backup-2026-03-21T10-30-00`
- ISO timestamp with colons replaced by hyphens for filesystem safety

### WAL Safety

SQLite may use WAL mode, which means the database state spans three files: `*.db`, `*-wal`, `*-shm`. A raw copy of just the `.db` file could produce an inconsistent backup.

**Startup backup (before DB connection opens):** No WAL risk. If `-wal` and `-shm` files exist from a previous session, SQLite hasn't opened them yet. Copy all three files (`*.db`, `*-wal`, `*-shm`) — if the sidecar files exist, include them; if not, just copy the main file. This produces a restorable set.

**Periodic backup (DB connection is open):** Issue `PRAGMA wal_checkpoint(PASSIVE)` via the open `DbHandle` before copying. `PASSIVE` checkpoints as much as possible without blocking writers — it won't wait for locks, so it can't cause hangs. Then copy all three files. This is best-effort: in the unlikely event of a concurrent write during the copy, the backup may not be perfectly consistent, but for a <1MB metadata database with low write frequency, the risk is negligible and acceptable.

### Retention & Cleanup

After each successful backup, `cleanOldBackups(dbName: string)` runs:

1. Calls `get_app_data_dir` to get the directory
2. Calls `list_dir` to list all files
3. Filters for files matching `{dbName}.backup-*`
4. Parses the timestamp from each filename
5. Calls `remove_file` for any backup older than 7 days (including its `-wal` and `-shm` sidecars if present)
6. If deletion fails for a file, logs and skips

Retention window: 7 days (hardcoded). With 4-hour intervals plus one per startup, this yields roughly 42-50 backup sets maximum. The DB is task metadata only (typically <1MB per set), so disk usage is negligible.

### Integration Points

**Startup (`App.vue` `onMounted`):**
- After resolving `dbName` but before `Database.load()` and `runMigrations()`, call `await backupOnStartup(dbName)` — must be awaited to ensure the backup completes before the DB is opened and migrations run
- This ensures a pre-migration snapshot exists

**Periodic timer:**
- After full initialization (migrations, repo loading), call `startPeriodicBackup(dbName, db.value, 4 * 60 * 60 * 1000)`
- Cleanup function called in `onUnmounted` to clear the interval

**Worktree databases:**
- No special handling needed — `dbName` is already resolved per-instance (`kanna-wt-{suffix}.db`) before backup runs
- Each instance backs up its own DB independently

**No UI changes.** Silent operation, console logging only.

### Error Handling & Edge Cases

| Scenario | Behavior |
|---|---|
| DB file doesn't exist (first launch) | `backupOnStartup` checks via `file_exists`, skips silently |
| Concurrent writes during periodic backup | `PASSIVE` checkpoint + copy all 3 files (best-effort) |
| Startup backup (no DB connection open) | Copy all files (`.db` + `-wal`/`-shm` if present), no WAL risk |
| `-wal`/`-shm` files don't exist | Copy only the `.db` file — this is fine, DB is self-contained |
| Permissions error on copy/delete | Log to console, continue normally |
| Disk space | ~50 sets x <1MB = negligible |
| Browser mock mode (non-Tauri) | Skip all backup operations — `isTauri` guard |

### Testing

**Rust command tests** (`apps/desktop/src-tauri/src/commands/fs.rs`):
- `copy_file` copies a file correctly
- `remove_file` deletes a file
- `list_dir` returns filenames
- `get_app_data_dir` returns a valid path

These are simple filesystem operations — standard Rust unit tests with temp directories.

**Composable tests** (`apps/desktop/src/composables/useBackup.test.ts`):
- Mock the Tauri `invoke` function (same pattern used by existing composable tests)
- `createBackup` invokes `copy_file` with correct source/destination naming
- `cleanOldBackups` invokes `remove_file` for old backups, keeps recent ones
- `backupOnStartup` skips when `file_exists` returns false
- Timestamp parsing handles the expected filename format
- WAL/SHM sidecars are included when they exist

No E2E tests needed — no UI surface.

## Files to Create/Modify

| File | Action |
|---|---|
| `apps/desktop/src/composables/useBackup.ts` | Create — backup composable |
| `apps/desktop/src/composables/useBackup.test.ts` | Create — unit tests |
| `apps/desktop/src-tauri/src/commands/fs.rs` | Modify — add `get_app_data_dir`, `copy_file`, `remove_file`, `list_dir` commands |
| `apps/desktop/src-tauri/src/lib.rs` | Modify — register new commands in the invoke handler |
| `apps/desktop/src/App.vue` | Modify — add startup and periodic backup calls |
| `apps/desktop/src/invoke.ts` | Modify — add type declarations for new invoke commands (if typed) |
