# Mobile Mentioned Files Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mobile terminal file strips with an efficient task-local MRU history exposed through `+ → Mentioned Files (n)`, including owner-side resolution of bare filenames.

**Architecture:** The generated xterm document incrementally tracks a bounded mention history and reports changes through the React Native bridge. `TaskScreen` owns that transient history and opens a native modal; the modal performs one authenticated owner request that resolves exact paths and bare basenames before using the existing file-content preview. The server performs an ignore-aware, bounded workspace walk only when resolution is requested.

**Tech Stack:** TypeScript, React Native, React Native WebView, xterm.js, Vitest, Rust, Axum, SQLite, `ignore` crate, Cargo/Bazel

---

## File Structure

### Create

- `apps/mobile/src/screens/terminalFileMentions.ts` — bounded bridge validation, count labels, and canonical row projection.
- `apps/mobile/src/screens/terminalFileMentions.test.ts` — pure mention validation/projection tests.
- `apps/mobile/src/screens/TaskMentionedFiles.tsx` — native loading/resolved/ambiguous/error modal.
- `apps/mobile/src/screens/TaskMentionedFiles.test.tsx` — modal state and stale-request tests.

### Modify

- `crates/kanna-server/Cargo.toml` — add the vendored pure-Rust `ignore` dependency.
- `Cargo.lock`, `crates/kanna-server/Cargo.lock` — record the server dependency for workspace and Bazel crate-universe builds.
- `crates/kanna-server/src/task_files.rs` — resolve exact and bare mentions with explicit bounds.
- `crates/kanna-server/src/http_api/task_files.rs` — capability-only resolve handler.
- `crates/kanna-server/src/http_api/router.rs` — register the POST route.
- `crates/kanna-server/src/http_api/tests/core_routes.rs` — route authentication and response tests.
- `apps/mobile/src/lib/api/types.ts` — request/response contracts.
- `apps/mobile/src/lib/api/client.ts` and tests — client forwarding.
- `apps/mobile/src/lib/transports/remoteTransport.ts` and tests — owner-routed POST request.
- `apps/mobile/src/lib/transports/lanTransport.ts` and tests — fail-closed implementation.
- `apps/mobile/src/lib/sources/cloudLanClient.ts` and tests — authenticated cloud fallback.
- `apps/mobile/src/state/mobileController.ts` and tests — controller method.
- `apps/mobile/src/appModel.ts`, `apps/mobile/src/App.test.tsx`, and `apps/mobile/src/App.component.test.tsx` — satisfy the expanded client surface.
- `apps/mobile/src/screens/buildTerminalDocument.ts` and tests — remove strips and add incremental MRU detection.
- `apps/mobile/src/screens/TerminalWebView.tsx` and tests — validate bridge history without rendering a strip.
- `apps/mobile/src/screens/taskActionMenu.ts` and tests — dynamic action label and action mapping.
- `apps/mobile/src/screens/TaskScreen.tsx` and tests — history ownership, modal/direct resolution, canonical preview.
- `apps/mobile/src/navigation/RootNavigator.tsx` and integration tests — durable-task resolver callback.
- `apps/mobile/src/e2eTestIds.ts`, `apps/mobile/e2e/helpers/selectors.ts`, and selector tests — native list selectors.
- `apps/mobile/e2e/helpers/relay-harness.ts` and tests — source, unique bare, and ambiguous fixtures.
- `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts` and helper tests — real `+` menu/list/preview journey.

## Task 1: Owner-Side Mention Resolver

**Files:**

- Modify: `crates/kanna-server/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `crates/kanna-server/Cargo.lock`
- Modify: `crates/kanna-server/src/task_files.rs`
- Test: `crates/kanna-server/src/task_files.rs`

- [ ] **Step 1: Write failing resolver tests**

Add fixture helpers for ignored files, symlinks, and batches, then add tests with these exact behavioral assertions:

```rust
#[test]
fn resolves_exact_and_unique_bare_mentions_in_request_order() {
    let fixture = TaskFileFixture::new();
    fixture.write("README.md", b"root");
    fixture.write("apps/mobile/src/screens/TaskScreen.tsx", b"screen");

    let result = resolve_task_file_mentions(
        &fixture.db,
        "task-1",
        vec![
            TaskFileMention { path: "TaskScreen.tsx".into(), line: Some(42) },
            TaskFileMention { path: "README.md".into(), line: None },
        ],
    ).unwrap();

    assert_eq!(result.mentions[0].matches, vec![
        TaskFileMatch { path: "apps/mobile/src/screens/TaskScreen.tsx".into() }
    ]);
    assert_eq!(result.mentions[0].line, Some(42));
    assert_eq!(result.mentions[1].matches, vec![
        TaskFileMatch { path: "README.md".into() }
    ]);
}

#[test]
fn returns_sorted_ambiguous_matches_and_excludes_ignored_and_symlinked_files() {
    let fixture = TaskFileFixture::new();
    fixture.write(".gitignore", b"generated/\n");
    fixture.write("a/shared.ts", b"a");
    fixture.write("b/shared.ts", b"b");
    fixture.write("generated/shared.ts", b"ignored");
    fixture.symlink_outside("linked/shared.ts");

    let result = resolve_task_file_mentions(
        &fixture.db,
        "task-1",
        vec![TaskFileMention { path: "shared.ts".into(), line: None }],
    ).unwrap();

    assert_eq!(
        result.mentions[0].matches.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(),
        vec!["a/shared.ts", "b/shared.ts"]
    );
}
```

Also cover:

```rust
assert!(matches!(
    resolve_task_file_mentions(&fixture.db, "task-1", vec![
        TaskFileMention { path: "../secret.ts".into(), line: None }
    ]),
    Err(TaskFileError::InvalidPath(_))
));

assert!(matches!(
    resolve_task_file_mentions(
        &fixture.db,
        "task-1",
        (0..=MAX_TASK_FILE_MENTIONS)
            .map(|index| TaskFileMention { path: format!("file-{index}.ts"), line: None })
            .collect()
    ),
    Err(TaskFileError::RequestTooLarge)
));
```

Add a test-only walk limit parameter so tests can prove `visited_limit` marks unresolved basename results `truncated: true` without creating 50,000 files.

- [ ] **Step 2: Run resolver tests and verify RED**

Run:

```bash
cargo test -p kanna-server task_files::tests::resolves_exact_and_unique_bare_mentions_in_request_order -- --exact
```

Expected: compilation fails because `resolve_task_file_mentions`, `TaskFileMention`, and `TaskFileMatch` do not exist.

- [ ] **Step 3: Add request/response types and limits**

In `task_files.rs`, add:

```rust
pub const MAX_TASK_FILE_MENTIONS: usize = 21;
const MAX_TASK_FILE_MENTION_PATH_BYTES: usize = 4 * 1024;
const MAX_TASK_FILE_MENTION_TOTAL_BYTES: usize = 32 * 1024;
const MAX_TASK_FILE_MENTION_MATCHES: usize = 10;
const MAX_TASK_FILE_WALK_ENTRIES: usize = 50_000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileMention {
    pub path: String,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileMatch {
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTaskFileMention {
    pub path: String,
    pub line: Option<u32>,
    pub matches: Vec<TaskFileMatch>,
    pub truncated: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileMentionResolution {
    pub mentions: Vec<ResolvedTaskFileMention>,
}
```

Add `TaskFileError::RequestTooLarge` with display text `too many task file mentions` and preserve existing error equality.

- [ ] **Step 4: Add the ignore-aware bounded resolver**

Add `ignore = "0.4"` to `crates/kanna-server/Cargo.toml`.

Implement:

```rust
pub fn resolve_task_file_mentions(
    db: &Db,
    task_or_branch_id: &str,
    mentions: Vec<TaskFileMention>,
) -> Result<TaskFileMentionResolution, TaskFileError> {
    resolve_task_file_mentions_with_limit(
        db,
        task_or_branch_id,
        mentions,
        MAX_TASK_FILE_WALK_ENTRIES,
    )
}
```

The private implementation must:

1. reject more than 21 records, any path over 4 KiB, or aggregate path bytes over 32 KiB;
2. resolve the durable task and current worktree through the same helpers as `read_task_file`;
3. normalize every request before walking, rejecting NUL and parent traversal;
4. try each normalized exact path through `open_task_file_from_root`;
5. retain exact regular-file matches and collect only missing single-component basenames;
6. run one `ignore::WalkBuilder` walk with `.follow_links(false)`, `.hidden(false)`, standard ignore filters, and an entry filter that excludes `.git` and `.kanna-worktrees`;
7. stop at the visit limit, cap each basename at 10 matches, sort matches lexically, and set `truncated` when either cap is reached;
8. leave missing nested paths with an empty `matches` array;
9. preserve request order and line numbers.

Use this filter shape so dot-source directories such as `.github` remain searchable:

```rust
let mut builder = ignore::WalkBuilder::new(root);
builder
    .follow_links(false)
    .hidden(false)
    .git_ignore(true)
    .git_global(true)
    .git_exclude(true)
    .filter_entry(|entry| {
        !matches!(
            entry.file_name().to_str(),
            Some(".git") | Some(".kanna-worktrees")
        )
    });
```

- [ ] **Step 5: Refresh Cargo locks**

Run:

```bash
cargo check -p kanna-server
task_lock_backup="$(mktemp)"
cp Cargo.lock "$task_lock_backup"
cargo generate-lockfile --manifest-path Cargo.server.toml
cp Cargo.lock crates/kanna-server/Cargo.lock
cp "$task_lock_backup" Cargo.lock
```

Expected: both lockfiles include `ignore` in the `kanna-server` dependency list; the root lock retains the full workspace graph.

- [ ] **Step 6: Run resolver tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server task_files::tests
```

Expected: all task-file tests pass, including exact read security tests and new resolver tests.

- [ ] **Step 7: Commit the resolver**

```bash
git add crates/kanna-server/Cargo.toml crates/kanna-server/src/task_files.rs Cargo.lock crates/kanna-server/Cargo.lock
git commit -m "feat(server): resolve mentioned task files"
```

## Task 2: Capability Route and Mobile API

**Files:**

- Modify: `crates/kanna-server/src/http_api/task_files.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/api/client.ts`
- Test: `apps/mobile/src/lib/api/client.test.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Test: `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Test: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/appModel.ts`
- Modify: `apps/mobile/src/App.test.tsx`

- [ ] **Step 1: Write failing authenticated route tests**

Extend `TaskFileRouteFixture` with `post_resolve`, `post_resolve_unauthenticated`, and authenticated relay helpers. Add:

```rust
#[tokio::test]
async fn task_file_resolver_route_returns_unique_and_ambiguous_matches() {
    let fixture = TaskFileRouteFixture::new();
    fixture.write("src/Unique.ts", b"unique");
    fixture.write("a/Shared.ts", b"a");
    fixture.write("b/Shared.ts", b"b");

    let response = fixture.post_resolve("task-file", json!({
        "mentions": [
            { "path": "Unique.ts", "line": 7 },
            { "path": "Shared.ts" }
        ]
    })).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let resolved: TaskFileMentionResolution = from_slice(&body).unwrap();
    assert_eq!(resolved.mentions[0].matches[0].path, "src/Unique.ts");
    assert_eq!(
        resolved.mentions[1].matches.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(),
        vec!["a/Shared.ts", "b/Shared.ts"]
    );
}
```

Also assert ordinary POST receives `401`, authenticated relay dispatch receives `200`, oversized batches receive `413`, and missing workspaces receive `409`.

- [ ] **Step 2: Run route test and verify RED**

Run:

```bash
cargo test -p kanna-server task_file_resolver_route_returns_unique_and_ambiguous_matches -- --exact
```

Expected: FAIL because `/files/resolve-mentions` is not registered.

- [ ] **Step 3: Implement the route**

In `http_api/task_files.rs`, import the new types and add:

```rust
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResolveTaskFileMentionsRequest {
    mentions: Vec<TaskFileMention>,
}

pub(super) async fn resolve_task_file_mentions(
    State(state): State<Arc<AppState>>,
    access: Option<Extension<AuthenticatedTaskFileAccess>>,
    Path(task_id): Path<String>,
    Json(request): Json<ResolveTaskFileMentionsRequest>,
) -> Result<Json<TaskFileMentionResolution>, (StatusCode, String)> {
    require_authenticated_task_file_access(access)?;
    let db = open_db(&state)?;
    crate::task_files::resolve_task_file_mentions(&db, &task_id, request.mentions)
        .map(Json)
        .map_err(map_task_file_error)
}
```

Extract the duplicated access and DB checks from `get_task_file` into local helpers. Map `RequestTooLarge` to `PAYLOAD_TOO_LARGE`.

Register:

```rust
.route(
    "/v1/tasks/{task_id}/files/resolve-mentions",
    post(resolve_task_file_mentions),
)
```

- [ ] **Step 4: Verify server route GREEN**

Run:

```bash
cargo test -p kanna-server task_file_route
```

Expected: all content and resolver route tests pass.

- [ ] **Step 5: Write failing mobile client/routing tests**

Add these API contracts to `types.ts` in the test imports before production code:

```ts
export interface TaskFileMentionInput {
  path: string;
  line?: number;
}

export interface TaskFileMentionMatch {
  path: string;
}

export interface ResolvedTaskFileMention extends TaskFileMentionInput {
  matches: TaskFileMentionMatch[];
  truncated: boolean;
}

export interface TaskFileMentionResolution {
  mentions: ResolvedTaskFileMention[];
}
```

Test that `KannaClient` forwards:

```ts
await client.resolveTaskFileMentions("task/read", [
  { path: "TaskScreen.tsx", line: 42 }
]);
expect(transport.resolveTaskFileMentions).toHaveBeenCalledWith(
  "task/read",
  [{ path: "TaskScreen.tsx", line: 42 }]
);
```

Test that remote routing invokes:

```ts
expect(invokeDesktop).toHaveBeenCalledWith({
  desktopId: "desktop-owner",
  method: "POST",
  path: "/v1/tasks/local%2Ftask-1/files/resolve-mentions",
  body: { mentions: [{ path: "TaskScreen.tsx", line: 42 }] }
});
```

Test that a LAN projection uses its authenticated cloud fallback, a LAN-only task rejects without calling LAN, and `MobileController` forwards the method.

- [ ] **Step 6: Run mobile routing tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile exec vitest run \
  src/lib/api/client.test.ts \
  src/lib/transports/remoteTransport.test.ts \
  src/lib/transports/lanTransport.test.ts \
  src/lib/sources/cloudLanClient.test.ts \
  src/state/mobileController.test.ts
```

Expected: TypeScript/test failures because `resolveTaskFileMentions` is missing.

- [ ] **Step 7: Implement the mobile API surface**

Add the types above and add this method consistently to `KannaTransport`, `KannaClient`, controller interfaces, mocks, and implementations:

```ts
resolveTaskFileMentions(
  taskId: string,
  mentions: readonly TaskFileMentionInput[]
): Promise<TaskFileMentionResolution>;
```

Remote transport:

```ts
resolveTaskFileMentions: (taskId, mentions) =>
  requestTask<TaskFileMentionResolution>(
    taskId,
    "POST",
    (localTaskId) =>
      `/v1/tasks/${encodeURIComponent(localTaskId)}/files/resolve-mentions`,
    { mentions }
  ),
```

Cloud/LAN routing must mirror `readTaskFile`: a projected LAN task uses the cloud fallback identity, LAN-only rejects with `Task file resolution ... requires an authenticated relay connection`, and cloud routes call their resolved client.

- [ ] **Step 8: Verify mobile routing GREEN**

Run the command from Step 6.

Expected: all focused API/controller tests pass.

- [ ] **Step 9: Commit route and API**

```bash
git add \
  crates/kanna-server/src/http_api/task_files.rs \
  crates/kanna-server/src/http_api/router.rs \
  crates/kanna-server/src/http_api/tests/core_routes.rs \
  apps/mobile/src/lib/api/types.ts \
  apps/mobile/src/lib/api/client.ts \
  apps/mobile/src/lib/api/client.test.ts \
  apps/mobile/src/lib/transports/remoteTransport.ts \
  apps/mobile/src/lib/transports/remoteTransport.test.ts \
  apps/mobile/src/lib/transports/lanTransport.ts \
  apps/mobile/src/lib/transports/lanTransport.test.ts \
  apps/mobile/src/lib/sources/cloudLanClient.ts \
  apps/mobile/src/lib/sources/cloudLanClient.test.ts \
  apps/mobile/src/state/mobileController.ts \
  apps/mobile/src/state/mobileController.test.ts \
  apps/mobile/src/appModel.ts \
  apps/mobile/src/App.test.tsx \
  apps/mobile/src/App.component.test.tsx
git commit -m "feat(mobile): route mentioned file resolution"
```

## Task 3: Pure Mention History Contract

**Files:**

- Create: `apps/mobile/src/screens/terminalFileMentions.ts`
- Create: `apps/mobile/src/screens/terminalFileMentions.test.ts`

- [ ] **Step 1: Write failing validation and projection tests**

Specify:

```ts
expect(parseTerminalFileMentionHistory({
  type: "terminal-file-mentions",
  mentions: [
    { raw: "src/App.tsx:42:7", path: "src/App.tsx", line: 42 },
    { raw: "../escape.ts", path: "../escape.ts" },
    { raw: "forged.ts", path: "different.ts" }
  ],
  overflow: false
})).toEqual({
  mentions: [{ raw: "src/App.tsx:42:7", path: "src/App.tsx", line: 42 }],
  overflow: false
});

expect(mentionedFilesActionLabel({ mentions: new Array(20).fill(valid), overflow: true }))
  .toBe("Mentioned Files (20+)");
```

For canonical projection:

```ts
expect(projectResolvedMentionRows(history, resolution)).toEqual({
  rows: [
    { path: "src/Newest.ts", line: 9, mentionPath: "Newest.ts" },
    { path: "a/Shared.ts", mentionPath: "Shared.ts" },
    { path: "b/Shared.ts", mentionPath: "Shared.ts" }
  ],
  unmatchedCount: 1,
  truncated: false
});
```

Cover canonical duplicate collapse, newest-line preservation, malformed positive lines, payloads over 21 records, path/raw length limits, traversal, image extensions, and mismatched raw/path reparsing.

- [ ] **Step 2: Run the pure test and verify RED**

Run:

```bash
pnpm --dir apps/mobile exec vitest run src/screens/terminalFileMentions.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure contract**

Export:

```ts
export const MAX_TERMINAL_FILE_MENTIONS = 20;
export const MAX_TERMINAL_FILE_MENTION_PAYLOAD = 21;

export interface TerminalFileMention {
  raw: string;
  path: string;
  line?: number;
}

export interface TerminalFileMentionHistory {
  mentions: TerminalFileMention[];
  overflow: boolean;
}

export interface ResolvedMentionRow {
  path: string;
  mentionPath: string;
  line?: number;
}
```

Implement:

```ts
export function parseTerminalFileMentionRaw(
  raw: string
): { path: string; line?: number } | null;

export function parseTerminalFileMentionHistory(
  payload: unknown
): TerminalFileMentionHistory | null;

export function mentionedFilesActionLabel(
  history: TerminalFileMentionHistory
): string;

export function projectResolvedMentionRows(
  history: TerminalFileMentionHistory,
  resolution: TaskFileMentionResolution
): { rows: ResolvedMentionRow[]; unmatchedCount: number; truncated: boolean };
```

Use the shared image extension set from the design and require parsed `raw` to reproduce the supplied `path` and `line`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --dir apps/mobile exec vitest run src/screens/terminalFileMentions.test.ts
git add apps/mobile/src/screens/terminalFileMentions.ts apps/mobile/src/screens/terminalFileMentions.test.ts
git commit -m "feat(mobile): define terminal file mention history"
```

## Task 4: Incremental xterm Mention Detection

**Files:**

- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`

- [ ] **Step 1: Replace strip tests with failing MRU tests**

Update `StubTerminal.buffer` to expose `normal` and `alternate` buffers, then replace current persistent-button expectations with:

```ts
it("tracks source-file mentions as a reverse-chronological MRU", async () => {
  vi.useFakeTimers();
  const { messages, window } = createExecutedTerminalDocument();

  window.__replaceTerminalState({
    text: "Older src/Old.ts:2 then README.md\n"
  });
  window.__appendTerminalChunk({
    chunksB64: [b64("Changed src/New.tsx:42:7 and src/Old.ts:9\n")]
  });
  await vi.runAllTimersAsync();

  expect(lastMessageOfType(messages, "terminal-file-mentions")).toEqual({
    type: "terminal-file-mentions",
    mentions: [
      { raw: "src/Old.ts:9", path: "src/Old.ts", line: 9 },
      { raw: "src/New.tsx:42:7", path: "src/New.tsx", line: 42 },
      { raw: "README.md", path: "README.md" }
    ],
    overflow: false
  });
});
```

The expected order above is deliberate: `src/Old.ts:9` is the rightmost token on the newest row, followed by `src/New.tsx:42:7`, then the prior-row `README.md`.

Add instrumented tests proving:

- no `#terminal-file-links` markup or native discovery message;
- 21 unique tokens emit only 20 records with `overflow: true`;
- repeated mentions update line and order;
- append scanning calls `getLine` only from `previousLength - 2` through the current end;
- three rapid appends produce one debounced scan;
- replacement examines no more than 1,000 rows and stops after overflow;
- alternate-buffer-only writes do not emit a history change;
- unchanged history emits no duplicate message;
- direct provider links include `.ts`, `.tsx`, `.rs`, `.json`, and `.md`, but reject traversal and the explicit image set.

- [ ] **Step 2: Run generated-document tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile exec vitest run src/screens/buildTerminalDocument.test.ts
```

Expected: failures because strips still exist and no `terminal-file-mentions` message is emitted.

- [ ] **Step 3: Remove both generated strip implementations**

Delete:

- `.terminal-file-links` CSS and markup;
- `terminalFileLinks`/`terminalFileLinkButtons` lookups;
- `MAX_DISCOVERABLE_FILE_LINKS`, `MAX_FILE_LINK_SCAN_ROWS`;
- `refreshTerminalFileLinks()` and its `finalizeRender` call.

Retain the xterm `registerLinkProvider`, cell-boundary conversion, direct activation gesture cooldown, and `terminal-file-link` message.

- [ ] **Step 4: Restore conservative text/source grammar**

Use:

```ts
const TERMINAL_FILE_PATH_PATTERN =
  /(?:^|[\s"'`(<\[])(\/?[a-zA-Z0-9_.\-][\w.\-/]*\.[a-zA-Z][a-zA-Z0-9]*(?::\d+){0,2})(?=$|[\s"'`)\]}>,;!?]|\.(?=$|[\s"'`)\]}>,;!?]))/g.source;
```

In generated JavaScript, reject `..` components and image extensions before returning a parsed candidate.

- [ ] **Step 5: Implement bounded MRU and delta scans**

Add constants:

```js
const MAX_RETAINED_FILE_MENTIONS = 20;
const MAX_FILE_MENTION_PAYLOAD = 21;
const MAX_INITIAL_FILE_MENTION_SCAN_ROWS = 1000;
const FILE_MENTION_SCAN_OVERLAP_ROWS = 2;
const FILE_MENTION_SCAN_DEBOUNCE_MS = 200;
```

Add state:

```js
const terminalFileMentionHistory = new Map();
let terminalFileMentionOverflow = false;
let pendingFileMentionScanStart = null;
let pendingFileMentionScanTimer = null;
let previousNormalBufferLength = term.buffer.normal.length;
let lastPostedFileMentionSnapshot = "";
```

Implement:

```js
function normalBuffer() {
  return term.buffer.normal;
}

function recordTerminalFileMention(candidate) {
  terminalFileMentionHistory.delete(candidate.parsed.path);
  terminalFileMentionHistory.set(candidate.parsed.path, {
    raw: candidate.raw,
    path: candidate.parsed.path,
    ...(candidate.parsed.line === undefined ? {} : { line: candidate.parsed.line })
  });
  if (terminalFileMentionHistory.size > MAX_RETAINED_FILE_MENTIONS) {
    terminalFileMentionOverflow = true;
    terminalFileMentionHistory.delete(terminalFileMentionHistory.keys().next().value);
  }
}

function postTerminalFileMentionsIfChanged() {
  const mentions = Array.from(terminalFileMentionHistory.values()).reverse();
  const payload = {
    type: "terminal-file-mentions",
    mentions,
    overflow: terminalFileMentionOverflow
  };
  const snapshot = JSON.stringify(payload);
  if (snapshot === lastPostedFileMentionSnapshot) return;
  lastPostedFileMentionSnapshot = snapshot;
  window.ReactNativeWebView?.postMessage(snapshot);
}
```

Implement `rebuildTerminalFileMentions()` by scanning newest rows backward and candidates right-to-left until 21 distinct tokens are found, then retaining the newest 20 in MRU order.

Implement `scheduleIncrementalFileMentionScan(previousLength)` by merging `Math.max(0, previousLength - 2)` into `pendingFileMentionScanStart`, resetting one 200 ms timer, scanning ascending rows when it fires, and posting only on change.

Call rebuild once after `__replaceTerminalState` finishes. Capture `previousNormalBufferLength` before append writes. After `__appendTerminalChunk` finishes, skip scheduling only when the active buffer is alternate and the normal-buffer length is unchanged; otherwise schedule the overlap scan. This detects same-tail-row updates in the normal buffer while doing no scan for alternate-screen-only writes.

- [ ] **Step 6: Verify generated-document GREEN**

Run:

```bash
pnpm --dir apps/mobile exec vitest run src/screens/buildTerminalDocument.test.ts
```

Expected: all generated terminal tests pass with bounded `getLine` call assertions.

- [ ] **Step 7: Commit detector**

```bash
git add apps/mobile/src/screens/buildTerminalDocument.ts apps/mobile/src/screens/buildTerminalDocument.test.ts
git commit -m "feat(mobile): track terminal file mentions incrementally"
```

## Task 5: Native Bridge Without a Horizontal Strip

**Files:**

- Modify: `apps/mobile/src/screens/TerminalWebView.test.tsx`
- Modify: `apps/mobile/src/screens/TerminalWebView.tsx`

- [ ] **Step 1: Write failing bridge tests**

Replace native-strip tests with:

```tsx
it("reports validated mention history without rendering a horizontal strip", async () => {
  const onMentionedFilesChange = vi.fn();
  const webView = await renderTerminalWebView({ onMentionedFilesChange });

  send(webView, {
    type: "terminal-file-mentions",
    mentions: [{ raw: "src/App.tsx:42", path: "src/App.tsx", line: 42 }],
    overflow: false
  });

  expect(onMentionedFilesChange).toHaveBeenCalledWith({
    mentions: [{ raw: "src/App.tsx:42", path: "src/App.tsx", line: 42 }],
    overflow: false
  });
  expect(findByType(lastTree, "ScrollView")).toBeNull();
});
```

Also assert malformed and oversized history is rejected, switching tasks reports an empty history, direct `.tsx` activation calls `onOpenFile`, images do not, and selection toolbar top no longer depends on strip height.

- [ ] **Step 2: Run test and verify RED**

```bash
pnpm --dir apps/mobile exec vitest run src/screens/TerminalWebView.test.tsx
```

Expected: FAIL because `onMentionedFilesChange` is absent and a `ScrollView` renders.

- [ ] **Step 3: Implement bridge handling**

Add:

```ts
onMentionedFilesChange?: (history: TerminalFileMentionHistory) => void;
```

Use `parseTerminalFileMentionHistory(payload)` for `terminal-file-mentions`. Delete `TerminalFileLink`, native strip state/render/styles/imports, and the Markdown-only guards. Use `parseTerminalFileMentionRaw` for direct activation validation.

On task change, call:

```ts
onMentionedFilesChange?.({ mentions: [], overflow: false });
```

Keep `terminal-file-link` activation as `onOpenFile(path, line)`; `TaskScreen` will reinterpret it as a mention to resolve.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --dir apps/mobile exec vitest run src/screens/TerminalWebView.test.tsx
git add apps/mobile/src/screens/TerminalWebView.tsx apps/mobile/src/screens/TerminalWebView.test.tsx
git commit -m "feat(mobile): bridge terminal mention history"
```

## Task 6: Mentioned-Files Modal

**Files:**

- Create: `apps/mobile/src/screens/TaskMentionedFiles.test.tsx`
- Create: `apps/mobile/src/screens/TaskMentionedFiles.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts`

- [ ] **Step 1: Write failing modal tests**

Use the existing manual React hook harness pattern from `TaskFilePreview.test.tsx`. Specify:

```tsx
const tree = renderMentionedFiles({
  history: {
    mentions: [
      { raw: "Newest.ts:9", path: "Newest.ts", line: 9 },
      { raw: "Shared.ts", path: "Shared.ts" },
      { raw: "Missing.ts", path: "Missing.ts" }
    ],
    overflow: false
  },
  resolveMentions: vi.fn().mockResolvedValue({
    mentions: [
      { path: "Newest.ts", line: 9, matches: [{ path: "src/Newest.ts" }], truncated: false },
      { path: "Shared.ts", matches: [{ path: "a/Shared.ts" }, { path: "b/Shared.ts" }], truncated: false },
      { path: "Missing.ts", matches: [], truncated: false }
    ]
  })
});
```

After effects settle, assert rows are ordered:

```ts
[
  "src/Newest.ts",
  "a/Shared.ts",
  "b/Shared.ts"
]
```

Assert selection calls `onSelect({ path: "src/Newest.ts", line: 9 })`, missing footer reads `1 mention couldn't be matched`, overflow/truncation copy appears, Retry repeats the request, empty history does not call the resolver, and a resolution completing after unmount/task-key change is ignored.

Add `autoSelectUnique` tests: one match calls `onSelect` without rendering rows; multiple matches render choices; zero matches renders unavailable state.

- [ ] **Step 2: Run modal test and verify RED**

```bash
pnpm --dir apps/mobile exec vitest run src/screens/TaskMentionedFiles.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the modal**

Props:

```ts
export interface TaskMentionedFilesProps {
  history: TerminalFileMentionHistory;
  autoSelectUnique?: boolean;
  resolveMentions(
    mentions: readonly TaskFileMentionInput[]
  ): Promise<TaskFileMentionResolution>;
  onSelect(selection: { path: string; line?: number }): void;
  onClose(): void;
}
```

Use a full-screen `Modal`, `SafeAreaView`, `FlatList`, and `ActivityIndicator`. Resolve once per history/retry generation. Guard the promise with an `active` cleanup boolean. Project rows through `projectResolvedMentionRows`. Add stable E2E ids:

```ts
taskMentionedFilesModal: "mobile.task-mentioned-files.modal",
taskMentionedFilesClose: "mobile.task-mentioned-files.close",
taskMentionedFilesError: "mobile.task-mentioned-files.error",
taskMentionedFilesRetry: "mobile.task-mentioned-files.retry",
taskMentionedFilesRow(path: string): string {
  return `mobile.task-mentioned-files.row.${path}`;
}
```

Render filename as the primary label and full canonical path as selectable secondary text.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm --dir apps/mobile exec vitest run src/screens/TaskMentionedFiles.test.tsx
git add apps/mobile/src/screens/TaskMentionedFiles.tsx apps/mobile/src/screens/TaskMentionedFiles.test.tsx apps/mobile/src/e2eTestIds.ts
git commit -m "feat(mobile): add mentioned files modal"
```

## Task 7: Dynamic Menu and Task Screen Wiring

**Files:**

- Modify: `apps/mobile/src/screens/taskActionMenu.test.ts`
- Modify: `apps/mobile/src/screens/taskActionMenu.ts`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.integration.test.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`

- [ ] **Step 1: Write failing action-sheet tests**

Specify:

```ts
showTaskActionMenu(
  { mentionedFilesLabel: "Mentioned Files (3)" },
  onSelect
);

expect(nativeMocks.actionSheet).toHaveBeenCalledWith(
  {
    title: "Task Actions",
    options: [
      "Mentioned Files (3)",
      "View Diff",
      "Advance Stage",
      "Close Task",
      "Cancel"
    ],
    cancelButtonIndex: 4,
    destructiveButtonIndex: 3
  },
  expect.any(Function)
);
```

Assert iOS/Android index zero maps to `mentioned-files`, all prior actions shift by one, and cancellation still dismisses.

- [ ] **Step 2: Run action-menu test and verify RED**

```bash
pnpm --dir apps/mobile exec vitest run src/screens/taskActionMenu.test.ts
```

Expected: FAIL because the function accepts no dynamic menu options.

- [ ] **Step 3: Implement the dynamic menu**

Change:

```ts
export type TaskAction = "mentioned-files" | "view-diff" | TaskStageAction;

export interface TaskActionMenuOptions {
  mentionedFilesLabel: string;
}

export function showTaskActionMenu(
  options: TaskActionMenuOptions,
  onSelect: (action: TaskAction) => void,
  onDismiss: () => void = () => undefined
): void;
```

Build the action array per invocation with the dynamic mentioned-files label first.

- [ ] **Step 4: Write failing TaskScreen integration tests**

Extend the test harness with `resolveTaskFileMentions` and a `TaskMentionedFiles` mock. Cover:

1. `TerminalWebView.onMentionedFilesChange` updates the label passed to `showTaskActionMenu`.
2. Selecting `mentioned-files` renders `TaskMentionedFiles` with newest-first history.
3. Selecting a canonical modal row opens `TaskFilePreview` and reads the canonical path.
4. Direct terminal activation renders `TaskMentionedFiles` with `autoSelectUnique: true`.
5. Switching tasks or switching to an SDK agent clears history/modal/preview.
6. Overflow passes `Mentioned Files (20+)`.

Core assertion:

```ts
(terminal.props.onMentionedFilesChange as Function)({
  mentions: [{ raw: "TaskScreen.tsx", path: "TaskScreen.tsx" }],
  overflow: false
});
openPlusAndSelect("mentioned-files");

expect(findByType(tree, "TaskMentionedFiles")?.props.history.mentions)
  .toEqual([{ raw: "TaskScreen.tsx", path: "TaskScreen.tsx" }]);
```

- [ ] **Step 5: Run TaskScreen tests and verify RED**

```bash
pnpm --dir apps/mobile exec vitest run src/screens/TaskScreen.test.tsx
```

Expected: FAIL because mention state/modal and resolver props do not exist.

- [ ] **Step 6: Wire TaskScreen**

Add prop:

```ts
onResolveTaskFileMentions(
  mentions: readonly TaskFileMentionInput[]
): Promise<TaskFileMentionResolution>;
```

Add task-scoped state:

```ts
const EMPTY_MENTION_HISTORY: TerminalFileMentionHistory = {
  mentions: [],
  overflow: false
};
const [mentionedFiles, setMentionedFiles] = useState(EMPTY_MENTION_HISTORY);
const [mentionedFilesRequest, setMentionedFilesRequest] = useState<{
  history: TerminalFileMentionHistory;
  autoSelectUnique: boolean;
  previewRevision: number;
} | null>(null);
```

Pass `mentionedFilesActionLabel(mentionedFiles)` into `showTaskActionMenu`. Menu selection opens the full history; direct `TerminalWebView.onOpenFile` opens a one-record request with `autoSelectUnique: true`. Modal selection sets `selectedFile` with the current `previewRevision`.

Clear mention and modal state in the existing task/agent scope reset. Ensure stale modal selections cannot cross `previewRevision`.

- [ ] **Step 7: Wire RootNavigator and test durable identity**

Pass:

```tsx
onResolveTaskFileMentions={(mentions) => {
  const durableTaskId = resolveDurableTaskId(state, routeTaskId);
  return durableTaskId
    ? controller.resolveTaskFileMentions(durableTaskId, mentions)
    : Promise.reject(new Error("Task creation is still in progress."));
}}
```

In `RootNavigator.integration.test.tsx`, invoke the captured callback and assert the controller receives the durable owner-local task identity used by existing file reads.

- [ ] **Step 8: Verify focused mobile UI GREEN**

```bash
pnpm --dir apps/mobile exec vitest run \
  src/screens/taskActionMenu.test.ts \
  src/screens/TaskScreen.test.tsx \
  src/navigation/RootNavigator.integration.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 9: Commit menu wiring**

```bash
git add apps/mobile/src/screens/taskActionMenu.ts apps/mobile/src/screens/taskActionMenu.test.ts apps/mobile/src/screens/TaskScreen.tsx apps/mobile/src/screens/TaskScreen.test.tsx apps/mobile/src/navigation/RootNavigator.tsx apps/mobile/src/navigation/RootNavigator.integration.test.tsx
git commit -m "feat(mobile): expose mentioned files from task actions"
```

## Task 8: Relay E2E Coverage and Final Verification

**Files:**

- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.test.ts`
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Modify: `apps/mobile/e2e/helpers/relay-harness.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Modify: `apps/mobile/e2e/file-preview-coverage.md`

- [ ] **Step 1: Write failing selector and journey-helper tests**

Add selectors for modal, close, retry, error, and canonical rows. In relay journey helper tests, specify a driver sequence that:

1. waits for the terminal bridge to report three unique mentions;
2. opens `mobile.task-more-button`;
3. selects native text `Mentioned Files (3)`;
4. waits for `mobile.task-mentioned-files.modal`;
5. asserts unique bare `TaskScreen.tsx` resolved to its fixture path;
6. asserts both ambiguous `shared.ts` paths appear newest-first;
7. selects the unique file and verifies the existing file-preview inspection payload.

Assert no accessibility element labeled `Files mentioned in terminal` and no removed horizontal strip selector exists.

- [ ] **Step 2: Run E2E helper tests and verify RED**

```bash
pnpm --dir apps/mobile exec vitest run \
  e2e/helpers/selectors.test.ts \
  e2e/helpers/relay-harness.test.ts \
  e2e/specs/relay/relay-task-flow.test.ts
```

Expected: FAIL because mentioned-file selectors and journey do not exist.

- [ ] **Step 3: Extend relay fixtures**

Seed:

```text
fixtures/unique/TaskScreen.tsx
fixtures/a/shared.ts
fixtures/b/shared.ts
docs/spec.md
```

Emit terminal text in a deterministic order with `TaskScreen.tsx:7`, both a source path and Markdown path, and `shared.ts`. Update the expected count and canonical paths in the fixture type.

- [ ] **Step 4: Implement the native journey**

Replace obsolete horizontal-button activation in `verifyTerminalFilePreviewFlow` with `verifyMentionedFileMenuFlow`. Keep rendered/raw preview assertions, keep missing-file error coverage through a direct explicit path, and update the WebView inspection fallback documentation.

- [ ] **Step 5: Verify E2E helper GREEN**

Run the command from Step 2.

Expected: all selector, harness, and journey helper unit tests pass.

- [ ] **Step 6: Run all focused unit tests**

```bash
pnpm --dir apps/mobile exec vitest run \
  src/screens/terminalFileMentions.test.ts \
  src/screens/buildTerminalDocument.test.ts \
  src/screens/TerminalWebView.test.tsx \
  src/screens/TaskMentionedFiles.test.tsx \
  src/screens/taskActionMenu.test.ts \
  src/screens/TaskScreen.test.tsx \
  src/navigation/RootNavigator.integration.test.tsx \
  src/lib/api/client.test.ts \
  src/lib/transports/remoteTransport.test.ts \
  src/lib/transports/lanTransport.test.ts \
  src/lib/sources/cloudLanClient.test.ts \
  src/state/mobileController.test.ts \
  e2e/helpers/selectors.test.ts \
  e2e/helpers/relay-harness.test.ts \
  e2e/specs/relay/relay-task-flow.test.ts
```

Expected: all focused tests pass with no warnings.

- [ ] **Step 7: Run typecheck and Rust verification**

```bash
pnpm --dir apps/mobile typecheck
cargo test -p kanna-server task_files
./kd test rust
```

Expected: TypeScript exits zero; resolver/route tests pass; canonical Rust suite passes.

- [ ] **Step 8: Run the simulator relay journey when the local iOS lane is available**

Use the canonical mobile workflow:

```bash
./kd dev up --mobile --emulators
pnpm --dir apps/mobile run test:e2e:relay
```

Expected: Appium opens `+ → Mentioned Files (n)`, selects the unique bare filename, and verifies real preview content. If the local simulator/Appium prerequisite is unavailable, record the exact preflight failure and retain the passing deterministic helper coverage.

- [ ] **Step 9: Run repository verification and inspect the diff**

```bash
pnpm test
git diff --check
git status --short
git diff --stat 50641809...HEAD
```

Expected: JS unit suite passes, no whitespace errors, and changes remain limited to the approved server/mobile feature, tests, locks, spec, and plan.

- [ ] **Step 10: Commit E2E coverage**

```bash
git add apps/mobile/e2e apps/mobile/src/e2eTestIds.ts
git commit -m "test(mobile): cover mentioned file menu flow"
```

- [ ] **Step 11: Review commit series**

```bash
git log --oneline --decorate -12
git status --short
```

Expected: design plus focused resolver, API, detector, bridge, modal, wiring, and E2E commits; clean worktree.
