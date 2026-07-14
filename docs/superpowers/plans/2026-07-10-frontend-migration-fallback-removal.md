# Frontend Migration Fallback Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the expired frontend schema-migration fallback while preserving server-owned migrations, the frontend database facade, and E2E SQL access.

**Architecture:** `kanna-server` remains the sole schema owner. The frontend retains only database-name resolution, legacy file-location copying, and its disabled/DEV-E2E `DbHandle` facade.

**Tech Stack:** Vue 3, TypeScript, Vitest, Rust SQLite migration tests.

---

### Task 1: Enforce and Remove the Frontend Migration Boundary

**Files:**
- Modify: `apps/desktop/src/stores/serverBoundary.test.ts`
- Modify: `apps/desktop/src/stores/db.test.ts`
- Modify: `apps/desktop/src/stores/db.ts`
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Add a failing ownership regression test**

Remove `"stores/db.ts"` from `ALLOWED_DB_BOUNDARY_FILES` in `serverBoundary.test.ts`, rename the carve-out test to refer to documented boundary adapters, and add:

```ts
it("keeps SQLite schema migration ownership out of the desktop frontend", () => {
  const forbidden = [
    { file: resolve(SRC_ROOT, "main.ts"), needle: "runMigrations" },
    { file: resolve(SRC_ROOT, "stores", "db.ts"), needle: "runMigrations" },
    { file: resolve(SRC_ROOT, "stores", "db.ts"), needle: "checkDatabaseHealth" },
    { file: resolve(SRC_ROOT, "stores", "db.ts"), needle: "schema_migrations" },
  ];

  const violations = forbidden
    .filter(({ file, needle }) => readFileSync(file, "utf8").includes(needle))
    .map(({ file, needle }) => `${relative(REPO_ROOT, file)} contains ${needle}`);

  expect(violations).toEqual([]);
});
```

- [ ] **Step 2: Verify the ownership test is red**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/serverBoundary.test.ts
```

Expected: FAIL with matches in `main.ts` and `stores/db.ts`.

- [ ] **Step 3: Retire obsolete migration tests**

In `apps/desktop/src/stores/db.test.ts`, remove the `DbHandle` type import, `runMigrations` dynamic import, and the three tests covering marker no-op, probe-failure logging, and legacy frontend migration execution. Keep both `resolveDbName` tests and replace the facade assertion with:

```ts
it("loads the server-owned database facade without opening frontend SQLite", async () => {
  const loaded = await loadDatabase();

  expect(loaded.dbName).toBe("kanna-v2.db");
  expect(migrateLegacyDatabaseIfNeededMock).toHaveBeenCalledWith("kanna-v2.db");
  await expect(loaded.db.execute("SELECT 1")).rejects.toThrow(
    /frontend SQLite access is disabled/,
  );
});
```

- [ ] **Step 4: Delete the fallback implementation**

From `apps/desktop/src/stores/db.ts`, delete `AppliedMigrationRow`, migration marker constants, `checkDatabaseHealth`, `runMigrations`, and `runLegacyFrontendMigrations`. Retain `e2eSqlRequest`, `frontendSqlDisabledDb`, `resolveDbName`, and this complete loader:

```ts
export async function loadDatabase(): Promise<{ db: DbHandle; dbName: string }> {
  const dbName = await resolveDbName();
  debugLog("[db] using server-owned database:", dbName);
  await migrateLegacyDatabaseIfNeeded(dbName);
  return { db: frontendSqlDisabledDb, dbName };
}
```

- [ ] **Step 5: Remove startup wiring**

Change the `apps/desktop/src/main.ts` import to:

```ts
import { loadDatabase } from "./stores/db";
```

Delete:

```ts
await runMigrations(db);
```

- [ ] **Step 6: Verify focused behavior**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/db.test.ts src/stores/serverBoundary.test.ts
rg -n "runMigrations|runLegacyFrontendMigrations|checkDatabaseHealth|schema_migrations" \
  apps/desktop/src/main.ts apps/desktop/src/stores/db.ts
```

Expected: both test files pass; `rg` prints no matches and exits 1.

- [ ] **Step 7: Verify server ownership and desktop build**

Run:

```bash
cargo test -p kanna-server db::tests::open_ -- --test-threads=1
pnpm --dir apps/desktop build
git diff --check
```

Expected: the Rust legacy/fresh migration tests pass, desktop typecheck/build succeeds, and the diff is clean.

- [ ] **Step 8: Commit**

```bash
git add \
  apps/desktop/src/main.ts \
  apps/desktop/src/stores/db.ts \
  apps/desktop/src/stores/db.test.ts \
  apps/desktop/src/stores/serverBoundary.test.ts
git commit -m "refactor: remove frontend migration fallback"
```

- [ ] **Step 9: Run the server-ownership E2E when the worktree app is available**

```bash
./kd dev up
pnpm --dir apps/desktop test:e2e -- mock/server-migration-phase4.test.ts
./kd dev down
```

Expected: the fresh profile boots and the server-schema-ownership test passes. Always run `./kd dev down` after the attempt, including after a failed test.
