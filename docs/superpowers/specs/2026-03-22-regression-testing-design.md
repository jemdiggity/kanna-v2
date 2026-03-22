# Regression Testing: Store-First Unit Tests

**Date:** 2026-03-22
**Status:** Draft
**Goal:** Catch regressions before merge at 100 PRs/day velocity, under 2 minutes total suite time.

## Context

Kanna merges ~100 PRs/day, mostly from Claude Code agents in worktrees. There is no CI pipeline — tests exist but nothing runs them automatically. The Merge Queue agent merges PRs sequentially and can run test scripts from `.kanna/config.json` before each merge.

Analysis of 8 open PRs shows the `kanna.ts` Pinia store is the hotspot — touched by 60%+ of PRs. Regressions are frontend state bugs: wrong sort order, stuck activity indicators, race conditions with `computedAsync`, broken task lifecycle transitions.

## Approach

**Store-first unit tests** — test the `useKannaStore` Pinia store directly with a mock `DbHandle` and mocked Tauri APIs. No browser, no Tauri, no daemon needed. Tests run with `bun test` in <30 seconds.

### Why not component tests or E2E?

- Component tests (Vue Test Utils) are slower, more brittle, and require DOM setup. The bugs we're catching are state logic, not rendering.
- E2E tests (WebDriver) require a running app. Too slow for the merge queue.
- Both can be added later as a second layer.

## Test Infrastructure

### File

`apps/desktop/src/stores/kanna.test.ts`

### Test runner

`bun:test` — consistent with existing composable tests in `apps/desktop`.

### Setup pattern

```typescript
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock Tauri APIs before importing store
mock.module("../invoke", () => ({ invoke: mockInvoke }));
mock.module("../listen", () => ({ listen: mockListen }));
mock.module("../tauri-mock", () => ({ isTauri: false }));

const { useKannaStore } = await import("./kanna");
```

### Mock DbHandle

Extend the existing `createMockDb()` pattern from `packages/db/src/queries.test.ts` to handle:
- `activity_log` table (INSERT on activity changes)
- `task_blocker` table (INSERT, DELETE, SELECT with JOIN)
- Raw SQL the store uses directly (e.g., `SELECT * FROM pipeline_item WHERE activity = 'working'`, `DELETE FROM pipeline_item WHERE id = ?`, `UPDATE pipeline_item SET branch = ? ...`)

### Flushing `computedAsync`

The store's `repos` and `items` are `computedAsync` values. After any `bump()`, both Vue reactivity and the microtask queue must flush. Since `items` depends on `repos` (cascading async), multiple rounds are needed:

```typescript
async function flushAsync(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise(r => setTimeout(r, 0));
  }
}
```

### Module-level `_db`

The store holds `_db` as a module-level `let` variable, set by `init()`. This is NOT reactive and persists across tests. Each test must call `store.init(mockDb)` to overwrite it. `setActivePinia(createPinia())` resets store refs but not `_db`.

### Mock `invoke`

Track calls for assertion. Return sensible defaults:

```typescript
let invokeCalls: { cmd: string; args: any }[] = [];
const invokeResults: Record<string, any> = {
  which_binary: "/usr/local/bin/kanna-hook",
  read_text_file: "",
  git_worktree_add: {},
  git_worktree_remove: {},
  kill_session: {},
  spawn_session: {},
  run_script: "",
  git_app_info: { branch: "main", commit_hash: "abc", version: "0.0.1" },
};

async function mockInvoke(cmd: string, args?: any) {
  invokeCalls.push({ cmd, args });
  return invokeResults[cmd] ?? {};
}
```

### Mock `listen`

Capture handlers so tests can emit events:

```typescript
const eventHandlers: Record<string, ((event: any) => void)[]> = {};

async function mockListen(event: string, handler: (event: any) => void) {
  if (!eventHandlers[event]) eventHandlers[event] = [];
  eventHandlers[event].push(handler);
  return () => {};
}

function emitEvent(event: string, payload: any) {
  for (const handler of eventHandlers[event] ?? []) {
    handler({ payload });
  }
}
```

## Test Cases

### High risk: sorting & activity state (~8 tests)

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 1 | Pinned items sort first by `pin_order` | 3 items, pin 2 | `sorted[0]` and `sorted[1]` are pinned in order |
| 2 | Unpinned items group by stage: pr, merge, in_progress | 3 unpinned items, one per stage | PR first, then merge, then in_progress |
| 3 | Within a stage, sort by activity (working > unread > idle) | 3 items same stage, different activity | Working first, idle last |
| 4 | Done items excluded from sorted list | 1 done item | Absent from `sortedItemsForCurrentRepo` |
| 5 | `selectItem` transitions unread to idle | Seed unread item, select | Activity = idle, DB write occurred |
| 6 | `selectItem` skips idle items (no redundant DB write) | Seed idle item, select | No `updatePipelineItemActivity` call |
| 7 | `_handleAgentFinished` sets idle when item is selected | Select item, fire handler | Activity = idle |
| 8 | `_handleAgentFinished` sets unread when item is NOT selected | Select different item, fire handler | Activity = unread |

### High risk: init & hook events (~8 tests)

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 9 | `init` transitions stale working items to unread | Seed working item, call init | Activity = unread |
| 10 | `init` GCs done tasks older than `gcAfterDays` | Seed old done item (updated_at 10 days ago) | Item deleted from DB |
| 11 | `init` preserves recent done tasks | Seed done item (updated_at today) | Item still in DB |
| 12 | `init` auto-starts blocked tasks whose blockers are done | Seed blocked item + done blocker | Stage = in_progress, PTY spawned |
| 13 | `init` restores persisted selection | Seed `selected_repo_id` and `selected_item_id` settings | `selectedRepoId` and `selectedItemId` match |
| 14 | Hook "Stop" fires `_handleAgentFinished` | Emit `hook_event` with event=Stop | Activity changes |
| 15 | Hook "PostToolUse" sets working | Emit `hook_event` with event=PostToolUse | Activity = working |
| 16 | Hook "WaitingForInput" sets unread | Emit `hook_event` with event=WaitingForInput | Activity = unread |

### Medium risk: task lifecycle (~8 tests)

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 17 | `closeTask` transitions item to done | Select item, close | Stage = done |
| 18 | `closeTask` selects next idle item | 2 items, close first | `selectedItemId` = second item |
| 19 | `closeTask` unblocks dependent tasks | Close blocker of blocked task | Blocked task starts |
| 20 | `blockTask` creates replacement with same prompt | Block item | New blocked item has original prompt |
| 21 | `blockTask` transfers dependents to replacement | A blocked by B, block B | A now blocked by B' |
| 22 | `checkUnblocked` waits for ALL blockers | 2 blockers, complete one | Still blocked |
| 23 | `createItem` assigns unique port offsets | Create 2 items | Different `port_offset` values |
| 24 | `importRepo` re-shows hidden repo | Hide repo, import same path | Unhidden, not duplicated |

### Lower risk: simple passthrough (~2 tests)

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 25 | Pin/unpin round-trip | Pin item, verify, unpin | `pinned` toggles correctly |
| 26 | Preference save/load | Save suspendAfterMinutes=15, reload | Value persisted and loaded |

**Total: ~26 tests**

## Integration with Merge Queue

Add `bun test` to `.kanna/config.json`'s `test` field:

```json
{
  "test": [
    "bun test"
  ]
}
```

The Merge Queue agent already discovers and runs these before each merge. No additional infrastructure needed.

## What this does NOT cover

- **CSS/layout regressions** (e.g., PR 112 terminal padding) — requires visual/E2E tests
- **Component wiring** (e.g., prop passing through TerminalTabs → TerminalView) — requires component tests
- **Daemon/PTY behavior** — requires Rust integration tests
- **Real Claude CLI interaction** — requires the CLI contract tests

These can be layered on later. The store tests catch the majority of bugs seen in current PRs.

## Implementation sequence

1. Create `kanna.test.ts` with mock infrastructure (DbHandle, invoke, listen, flushAsync)
2. Implement high-risk sorting/activity tests (tests 1-8)
3. Implement high-risk init/hook tests (tests 9-16)
4. Implement medium-risk lifecycle tests (tests 17-24)
5. Implement lower-risk passthrough tests (tests 25-26)
6. Add `"test": ["bun test"]` to `.kanna/config.json`
7. Verify full suite runs under 30 seconds
