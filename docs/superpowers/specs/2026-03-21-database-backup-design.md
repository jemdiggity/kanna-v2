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

Frontend-only implementation via a new `useBackup()` composable, using Tauri's filesystem plugin (`@tauri-apps/plugin-fs`) to copy the database file. This follows the existing pattern where all DB access is frontend-driven.

## Design

### Backup Mechanism

New composable: `apps/desktop/src/composables/useBackup.ts`

Exports:
- **`backupOnStartup(dbPath: string)`** — called from `App.vue` before `runMigrations()`. Copies the DB file to `{dbPath}.backup-{timestamp}`. If the copy fails, logs to console and continues.
- **`startPeriodicBackup(dbPath: string, intervalMs: number)`** — starts a `setInterval` timer. Called after full app initialization. Returns a cleanup function to clear the interval on unmount.

Both use a shared `createBackup(dbPath: string)` function that performs the file copy and triggers retention cleanup.

**Backup filename format:** `kanna-v2.db.backup-2026-03-21T10-30-00`
- ISO timestamp with colons replaced by hyphens for filesystem safety

### Retention & Cleanup

After each successful backup, `cleanOldBackups(dbPath: string)` runs:

1. Lists all files in the DB directory matching `{dbName}.backup-*`
2. Parses the timestamp from each filename
3. Deletes any backup older than 7 days
4. If deletion fails for a file, logs and skips

Retention window: 7 days (hardcoded). With 4-hour intervals, this yields ~42 backup files maximum. The DB is task metadata only (typically <1MB), so disk usage is negligible.

### Integration Points

**Startup (`App.vue` `onMounted`):**
- Call `backupOnStartup(dbPath)` before `runMigrations()`
- DB path is already resolved at this point (from `KANNA_DB_NAME` / worktree detection)

**Periodic timer:**
- After full initialization (migrations, repo loading), call `startPeriodicBackup(dbPath, 4 * 60 * 60 * 1000)`
- Cleanup function called in `onUnmounted` to clear the interval

**Worktree databases:**
- No special handling needed — each instance resolves its own `dbPath` before backup runs
- Worktree DBs (`kanna-wt-*.db`) get their own independent backup files

**No UI changes.** Silent operation, console logging only.

### Error Handling & Edge Cases

| Scenario | Behavior |
|---|---|
| DB file doesn't exist (first launch) | `backupOnStartup` checks existence, skips silently |
| Concurrent writes during periodic backup | Flush WAL with `wal_checkpoint(TRUNCATE)` before copy |
| Startup backup (no DB connection open) | No WAL risk, direct file copy is safe |
| Permissions error on copy/delete | Log to console, continue normally |
| Disk space | ~42 files x <1MB = negligible |

### Testing

Unit tests for `useBackup()`:
- `createBackup` copies the file with correct naming convention
- `cleanOldBackups` deletes files older than 7 days, preserves recent ones
- `backupOnStartup` skips gracefully when DB file doesn't exist
- Filename timestamp parsing handles the expected format

Tests use Tauri filesystem mock or direct Node fs via vitest. No E2E tests needed — no UI surface.

## Files to Create/Modify

| File | Action |
|---|---|
| `apps/desktop/src/composables/useBackup.ts` | Create — backup composable |
| `apps/desktop/src/App.vue` | Modify — add startup and periodic backup calls |
| `apps/desktop/src/composables/useBackup.test.ts` | Create — unit tests |
