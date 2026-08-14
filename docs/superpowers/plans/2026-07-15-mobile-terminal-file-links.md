# Mobile Terminal File Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mobile users tap workspace file paths in PTY output and read task-owned Markdown or UTF-8 text files through a secure relay-backed preview.

**Architecture:** A task-scoped `kanna-server` file provider is the sole filesystem authority and returns normalized UTF-8 content. Mobile xterm emits row-scoped file-link bridge messages, authenticated relay routing resolves the owning task, and a full-screen mobile preview renders Markdown locally or raw source at an optional line.

**Tech Stack:** Rust, axum, SQLite, Vue-independent Kanna server APIs, React Native 0.79, React 19, react-native-webview, xterm.js, markdown-it, Vitest, cargo test.

**Stage constraint:** Do not commit during this Kanna stage. The workflow performs the commit after user review, so the usual per-task commit steps are replaced by explicit test checkpoints.

### Security-review amendment

Final review found that the shared HTTP router is unauthenticated, LAN-bound, and permissive-CORS. The file-content route therefore must not be callable over ordinary HTTP or direct LAN. Only the authenticated relay dispatcher attaches its unforgeable in-process capability; LAN transports reject locally, and LAN task projections use their canonical cloud fallback identity. LAN-only file reads remain unavailable until a device-bound LAN bearer protocol exists.

The final filesystem implementation also supersedes the canonicalization sketch below: it opens and holds the worktree root descriptor once, performs raw `openat`/`O_NOFOLLOW` traversal, rejects all symlinks and non-regular nodes, and never probes an absolute path outside the lexical worktree root. Raw preview output uses at most one target-line span; rendered Markdown falls back to raw above 128 Ki characters, 5,000 LF/CRLF/CR lines, 10,000 syntax markers, or 10,000 parsed block/inline tokens, and its prepared output is memoized by content; xterm string offsets are mapped to terminal-cell columns.

---

## File Structure

- Create `crates/kanna-server/src/task_files.rs`: task/worktree resolution, containment policy, size/UTF-8 validation, and normalized content response.
- Create `crates/kanna-server/src/http_api/task_files.rs`: axum query extraction and domain-error-to-status mapping.
- Modify `crates/kanna-server/src/main.rs`: register the focused server domain module.
- Modify `crates/kanna-server/src/http_api.rs`: register the HTTP handler module.
- Modify `crates/kanna-server/src/http_api/router.rs`: expose the owner file-content route.
- Modify `crates/kanna-server/src/http_api/tests/core_routes.rs`: prove route success and error statuses.
- Modify `apps/mobile/src/lib/api/types.ts`: define `TaskFileContent`.
- Modify `apps/mobile/src/lib/api/client.ts`: add the task-file method to the transport/client contract.
- Modify `apps/mobile/src/lib/transports/lanTransport.ts`: fail closed because no device-bound LAN bearer exists.
- Modify `apps/mobile/src/lib/transports/remoteTransport.ts`: route cloud identities to the owner-local task id.
- Modify `apps/mobile/src/lib/sources/cloudLanClient.ts`: route file content through the selected task's authenticated cloud fallback identity.
- Modify `apps/mobile/src/appModel.ts`: keep disconnected, resolving, and delegating clients structurally complete.
- Modify corresponding mobile transport/client tests: verify exact routes and delegation.
- Modify `apps/mobile/src/screens/buildTerminalDocument.ts`: install the row-scoped xterm link provider and emit bridge messages.
- Modify `apps/mobile/src/screens/buildTerminalDocument.test.ts`: execute provider behavior under happy-dom.
- Modify `apps/mobile/src/screens/TerminalWebView.tsx`: validate and forward file-link bridge messages.
- Modify `apps/mobile/src/screens/TerminalWebView.test.tsx`: cover valid and malformed messages.
- Create `apps/mobile/src/screens/buildTaskFilePreviewDocument.ts`: safely build rendered Markdown and raw-line HTML.
- Create `apps/mobile/src/screens/buildTaskFilePreviewDocument.test.ts`: cover escaping, HTML-disabled Markdown, and line targeting.
- Create `apps/mobile/src/screens/TaskFilePreview.tsx`: own loading/retry/mode UI and preview WebView.
- Create `apps/mobile/src/screens/TaskFilePreview.test.tsx`: cover component state and navigation blocking.
- Modify `apps/mobile/src/screens/TaskScreen.tsx`: connect terminal activation to preview state.
- Modify `apps/mobile/src/screens/TaskScreen.test.tsx`: cover link-to-preview wiring.
- Modify `apps/mobile/src/state/mobileController.ts`: expose task-scoped file reads.
- Modify `apps/mobile/src/state/mobileController.test.ts`: prove controller delegation.
- Modify `apps/mobile/src/App.tsx`: supply the selected task's read callback.
- Modify `apps/mobile/src/App.test.tsx`: prove app-level callback wiring through the existing `TaskScreen` stub.
- Modify `apps/mobile/package.json` and `pnpm-lock.yaml`: add `markdown-it` and its TypeScript types without native dependencies.

### Task 1: Secure owner-side task file reads

**Files:**
- Create: `crates/kanna-server/src/task_files.rs`
- Create: `crates/kanna-server/src/http_api/task_files.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Modify: `crates/kanna-server/src/http_api.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`

- [ ] **Step 1: Write failing domain tests for safe reads**

Create tests in `task_files.rs` that build a temporary worktree row and assert the public contract:

```rust
#[test]
fn reads_relative_utf8_file_and_normalizes_path() {
    let fixture = TaskFileFixture::new();
    fixture.write("docs/spec.md", b"# Spec\n");
    let result = read_task_file(&fixture.db, "task-1", "docs/spec.md").unwrap();
    assert_eq!(result.path, "docs/spec.md");
    assert_eq!(result.content, "# Spec\n");
}

#[test]
fn rejects_parent_components_and_symlink_escape() {
    let fixture = TaskFileFixture::new();
    assert!(matches!(
        read_task_file(&fixture.db, "task-1", "../secret.md"),
        Err(TaskFileError::InvalidPath(_))
    ));
    fixture.symlink_outside("escape.md", b"secret");
    assert!(matches!(
        read_task_file(&fixture.db, "task-1", "escape.md"),
        Err(TaskFileError::InvalidPath(_))
    ));
}
```

Add these explicit assertions to the same fixture suite:

```rust
#[test]
fn accepts_absolute_path_only_inside_the_worktree() {
    let fixture = TaskFileFixture::new();
    fixture.write("docs/spec.md", b"# Spec\n");
    let inside = fixture.root.join("docs/spec.md");
    assert_eq!(
        read_task_file(&fixture.db, "task-1", inside.to_str().unwrap()).unwrap().path,
        "docs/spec.md"
    );
    assert!(matches!(
        read_task_file(&fixture.db, "task-1", fixture.outside_file.to_str().unwrap()),
        Err(TaskFileError::InvalidPath(_))
    ));
}

#[test]
fn rejects_directory_missing_large_and_non_utf8_content() {
    let fixture = TaskFileFixture::new();
    fixture.write("large.md", &vec![b'x'; MAX_TASK_FILE_BYTES as usize + 1]);
    fixture.write("binary.md", &[0xff, 0xfe]);
    assert!(matches!(
        read_task_file(&fixture.db, "task-1", "docs"),
        Err(TaskFileError::InvalidPath(_))
    ));
    assert!(matches!(
        read_task_file(&fixture.db, "task-1", "missing.md"),
        Err(TaskFileError::FileNotFound)
    ));
    assert!(matches!(
        read_task_file(&fixture.db, "task-1", "large.md"),
        Err(TaskFileError::TooLarge)
    ));
    assert!(matches!(
        read_task_file(&fixture.db, "task-1", "binary.md"),
        Err(TaskFileError::UnsupportedContent)
    ));
}
```

Define `TaskFileFixture` in the test module using a unique `std::env::temp_dir()` root, `Db::open` on a database beneath that root, `insert_test_repo`, `insert_test_pipeline_item`, and `upsert_worktree`. Its `Drop` implementation removes the root and outside fixture file. On Unix, `symlink_outside` uses `std::os::unix::fs::symlink`.

- [ ] **Step 2: Run the domain tests and verify RED**

Run:

```bash
cargo test -p kanna-server task_files -- --nocapture
```

Expected: compilation fails because `task_files`, `read_task_file`, and the response/error types do not exist.

- [ ] **Step 3: Implement the focused domain module**

Add the module declaration to `main.rs` and implement this API in `task_files.rs`:

```rust
pub const MAX_TASK_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TaskFileError {
    InvalidPath(String),
    TaskNotFound,
    WorkspaceUnavailable,
    FileNotFound,
    TooLarge,
    UnsupportedContent,
    Internal(String),
}

pub fn read_task_file(
    db: &crate::db::Db,
    task_or_branch_id: &str,
    requested_path: &str,
) -> Result<TaskFileContent, TaskFileError>;
```

Implementation rules:

```rust
let requested = std::path::Path::new(requested_path);
if requested_path.trim().is_empty()
    || requested.components().any(|part| matches!(part, std::path::Component::ParentDir))
{
    return Err(TaskFileError::InvalidPath("file path must stay within the task workspace".into()));
}

let root = std::fs::canonicalize(worktree_path)
    .map_err(|_| TaskFileError::WorkspaceUnavailable)?;
let candidate = if requested.is_absolute() {
    requested.to_path_buf()
} else {
    root.join(requested)
};
let target = std::fs::canonicalize(candidate).map_err(|error| {
    if error.kind() == std::io::ErrorKind::NotFound {
        TaskFileError::FileNotFound
    } else {
        TaskFileError::Internal(error.to_string())
    }
})?;
if !target.starts_with(&root) {
    return Err(TaskFileError::InvalidPath("file path must stay within the task workspace".into()));
}
```

Require `metadata.is_file()`, check the metadata and actual byte length against `MAX_TASK_FILE_BYTES`, convert through `String::from_utf8`, and derive the response path with `target.strip_prefix(&root)` using `/` separators.

- [ ] **Step 4: Run domain tests and verify GREEN**

Run the command from Step 2.

Expected: every `task_files` unit test passes.

- [ ] **Step 5: Write failing HTTP route tests**

In `core_routes.rs`, seed a real temporary worktree and add:

```rust
let response = app.clone().oneshot(
    Request::get("/v1/tasks/task-1/files/content?path=docs%2Fspec.md")
        .body(Body::empty())
        .unwrap(),
).await.unwrap();
assert_eq!(response.status(), StatusCode::OK);
let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
let file: crate::task_files::TaskFileContent = from_slice(&body).unwrap();
assert_eq!(file.path, "docs/spec.md");
assert_eq!(file.content, "# Spec\n");
```

Add focused requests that expect `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, and `UNSUPPORTED_MEDIA_TYPE`.

- [ ] **Step 6: Run route tests and verify RED**

Run:

```bash
cargo test -p kanna-server http_api::tests::core_routes::task_file -- --nocapture
```

Expected: `404` from the unregistered route.

- [ ] **Step 7: Add the axum handler and route**

In `http_api/task_files.rs`:

```rust
#[derive(Debug, serde::Deserialize)]
pub(super) struct TaskFileQuery {
    path: String,
}

pub(super) async fn get_task_file(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<TaskFileQuery>,
) -> Result<Json<crate::task_files::TaskFileContent>, (StatusCode, String)> {
    let db = Db::open(&state.config().db_path)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, format!("db error: {error}")))?;
    crate::task_files::read_task_file(&db, &task_id, &query.path)
        .map(Json)
        .map_err(map_task_file_error)
}
```

Map the domain variants to the specified status codes and register:

```rust
.route("/v1/tasks/{task_id}/files/content", get(get_task_file))
```

- [ ] **Step 8: Run route and domain tests and verify GREEN**

Run both commands from Steps 2 and 6. Expected: PASS.

### Task 2: Add task-file reads to every mobile transport route

**Files:**
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/api/client.test.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.test.ts`
- Modify: `apps/mobile/src/appModel.ts`

- [ ] **Step 1: Add failing LAN and client delegation tests**

Use an encoded task id and path:

```ts
await expect(transport.readTaskFile("task/read", "docs/spec one.md")).resolves.toEqual({
  path: "docs/spec one.md",
  content: "# Spec"
});
expect(fetchImpl).toHaveBeenCalledWith(
  "http://127.0.0.1:48120/v1/tasks/task%2Fread/files/content?path=docs%2Fspec%20one.md",
  undefined
);
```

In `client.test.ts`, assert `createKannaClient(transport).readTaskFile(...)` delegates exactly once.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- lib/api/client.test.ts lib/transports/lanTransport.test.ts
```

Expected: type/runtime failure because `readTaskFile` is missing.

- [ ] **Step 3: Add the shared response and required method**

In `types.ts`:

```ts
export interface TaskFileContent {
  path: string;
  content: string;
}
```

Add to both `KannaTransport` and `KannaClient`:

```ts
readTaskFile(taskId: string, path: string): Promise<TaskFileContent>;
```

Delegate it in `createKannaClient`, and implement LAN:

```ts
readTaskFile: (taskId, path) =>
  request<TaskFileContent>(
    `/v1/tasks/${encodeURIComponent(taskId)}/files/content?path=${encodeURIComponent(path)}`
  ),
```

- [ ] **Step 4: Complete structurally typed client wrappers**

Add `readTaskFile` to `createDisconnectedClient`, `createResolvingClient`, and `createDelegatingClient` in `appModel.ts`. The disconnected implementation uses the existing `unavailable` rejection; resolving/delegating variants forward both arguments unchanged.

- [ ] **Step 5: Run client/LAN tests and verify GREEN**

Run Step 2's command. Expected: PASS.

- [ ] **Step 6: Write failing owner-route and cloud/LAN tests**

Remote test:

```ts
await transport.readTaskFile("cloud-task-1", "docs/spec.md");
expect(invokeDesktop).toHaveBeenCalledWith({
  desktopId: "desktop-owner",
  method: "GET",
  path: "/v1/tasks/local-task-1/files/content?path=docs%2Fspec.md",
  body: null
});
```

Cloud/LAN test: configure a LAN route and assert `lan.readTaskFile("local-task-1", "docs/spec.md")` is called while the cloud client is not.

- [ ] **Step 7: Run routing tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- lib/transports/remoteTransport.test.ts lib/sources/cloudLanClient.test.ts
```

Expected: missing method failures.

- [ ] **Step 8: Implement route reuse**

In `remoteTransport.ts`:

```ts
readTaskFile: (taskId, path) =>
  requestTask<TaskFileContent>(
    taskId,
    "GET",
    (localTaskId) =>
      `/v1/tasks/${encodeURIComponent(localTaskId)}/files/content?path=${encodeURIComponent(path)}`,
    null
  ),
```

In `cloudLanClient.ts`:

```ts
readTaskFile: (taskId, path) =>
  invokeTaskRoute(taskId, (client, routedTaskId) =>
    client.readTaskFile(routedTaskId, path)
  ),
```

Update the central client mock factory with a resolved `readTaskFile` default.

- [ ] **Step 9: Run all four transport/client test files and verify GREEN**

Run the commands from Steps 2 and 7. Expected: PASS.

### Task 3: Add row-scoped xterm file-link activation

**Files:**
- Modify: `apps/mobile/src/screens/buildTerminalDocument.ts`
- Modify: `apps/mobile/src/screens/buildTerminalDocument.test.ts`
- Modify: `apps/mobile/src/screens/TerminalWebView.tsx`
- Modify: `apps/mobile/src/screens/TerminalWebView.test.tsx`

- [ ] **Step 1: Extend the happy-dom xterm stub and write failing provider tests**

Capture the provider without scanning the full buffer:

```ts
linkProvider: { provideLinks(line: number, callback: (links: unknown[]) => void): void } | null = null;
bufferLines = new Map<number, string>();
buffer = {
  active: {
    getLine: (index: number) => ({
      translateToString: () => this.bufferLines.get(index) ?? ""
    })
  }
};
registerLinkProvider(provider: StubTerminal["linkProvider"]): { dispose(): void } {
  this.linkProvider = provider;
  return { dispose() {} };
}
```

Assert `README.md`, `docs/spec.md:42:7`, and an absolute `.md` path become links; `../secret.md` and `error.message` do not. Activate the `:42:7` link and expect:

```ts
expect(JSON.parse(messages.at(-1)!)).toEqual({
  type: "terminal-file-link",
  path: "docs/spec.md",
  line: 42
});
```

- [ ] **Step 2: Run generated-document tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- screens/buildTerminalDocument.test.ts
```

Expected: no link provider is registered.

- [ ] **Step 3: Install and implement the row provider**

In the generated script, compile the desktop-compatible candidate regex from a JSON-escaped TypeScript string. Add helpers that remove one or two trailing numeric suffixes, reject a literal `..` segment, and calculate one-based xterm ranges. Register:

```js
term.registerLinkProvider({
  provideLinks(bufferLineNumber, callback) {
    const line = term.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }
    const links = detectFileLinks(line.translateToString(true), bufferLineNumber);
    callback(links.length ? links : undefined);
  }
});
```

Each link uses visible underline/pointer decorations and posts `terminal-file-link` on activation. Adjust the instrumentation-gating test to prohibit full-buffer loops and `renderedTerminalText` in production rather than prohibiting the row-scoped `term.buffer.active.getLine` access.

- [ ] **Step 4: Run generated-document tests and verify GREEN**

Run Step 2's command. Expected: PASS, including existing touch/pinch tests.

- [ ] **Step 5: Write failing native bridge tests**

Pass `onOpenFile` into the test renderer and send:

```ts
{ type: "terminal-file-link", path: "docs/spec.md", line: 42 }
```

Assert the callback receives `("docs/spec.md", 42)`. Also cover blank paths, non-string paths, zero/negative/non-integer lines, and unrelated messages.

- [ ] **Step 6: Run TerminalWebView tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- screens/TerminalWebView.test.tsx
```

Expected: `onOpenFile` is not a recognized prop/message.

- [ ] **Step 7: Validate and forward the bridge payload**

Add the optional prop:

```ts
onOpenFile?(path: string, line?: number): void;
```

Only forward a nonblank string path. Forward `line` only when it is a positive integer; otherwise omit it. Return immediately after handling the file message so it cannot enter ready/inspection branches.

- [ ] **Step 8: Run both terminal test files and verify GREEN**

Run Steps 2 and 6 commands. Expected: PASS.

### Task 4: Build the safe Markdown/raw preview

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/mobile/src/screens/buildTaskFilePreviewDocument.ts`
- Create: `apps/mobile/src/screens/buildTaskFilePreviewDocument.test.ts`
- Create: `apps/mobile/src/screens/TaskFilePreview.tsx`
- Create: `apps/mobile/src/screens/TaskFilePreview.test.tsx`

- [ ] **Step 1: Add Markdown dependencies through pnpm**

Run:

```bash
pnpm --dir apps/mobile add markdown-it@14.1.1
pnpm --dir apps/mobile add -D @types/markdown-it@14.1.2
```

Expected: only `apps/mobile/package.json` and `pnpm-lock.yaml` dependency metadata changes; no native dependency or runtime-version change.

- [ ] **Step 2: Write failing preview-document tests**

Cover these exact contracts:

```ts
expect(buildTaskFilePreviewDocument({
  path: "docs/spec.md",
  content: "# Heading\n\n<table><tr><td>unsafe</td></tr></table>",
  mode: "rendered"
})).toContain("<h1>Heading</h1>");
expect(html).toContain("&lt;table&gt;");
expect(html).not.toContain("<table><tr>");

const raw = buildTaskFilePreviewDocument({
  path: "src/file.ts",
  content: "first\n<script>alert(1)</script>\nthird",
  mode: "raw",
  initialLine: 2
});
expect(raw).toContain('data-line="2"');
expect(raw).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
expect(raw).toContain("scrollIntoView");
```

- [ ] **Step 3: Run document tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- screens/buildTaskFilePreviewDocument.test.ts
```

Expected: module not found.

- [ ] **Step 4: Implement the pure document builder**

Expose:

```ts
export type TaskFilePreviewMode = "rendered" | "raw";

export function buildTaskFilePreviewDocument(options: {
  path: string;
  content: string;
  mode: TaskFilePreviewMode;
  initialLine?: number;
}): string;
```

Use one `MarkdownIt({ html: false, linkify: true, typographer: false })` singleton for rendered mode. Escape path and raw content with `&`, `<`, `>`, `"`, and `'`. In raw mode, emit one escaped text node and wrap only a requested target line in a `data-line` element. Add a short inline script only when a positive `initialLine` is present; it finds the numeric selector, calls `scrollIntoView({ block: "center" })`, and applies the flash class.

- [ ] **Step 5: Run document tests and verify GREEN**

Run Step 3's command. Expected: PASS.

- [ ] **Step 6: Write failing TaskFilePreview component tests**

Mock `Modal`, `ActivityIndicator`, `Pressable`, and `WebView`. Assert:

- the component calls `readFile()` on mount and renders loading first;
- a resolved response replaces the requested absolute path with the normalized response path;
- `.md` without a line starts rendered and exposes a Raw toggle;
- `.md` with a line starts raw;
- Retry invokes a new read after failure;
- `onShouldStartLoadWithRequest` returns `true` for `about:blank` and `false` for other URLs;
- Close calls `onClose`.

- [ ] **Step 7: Run component tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- screens/TaskFilePreview.test.tsx
```

Expected: module not found.

- [ ] **Step 8: Implement TaskFilePreview**

Use this public boundary:

```ts
interface TaskFilePreviewProps {
  path: string;
  initialLine?: number;
  readFile(): Promise<TaskFileContent>;
  onClose(): void;
}
```

Mount a full-screen `Modal`; keep `{loading, file, error, retryGeneration, mode}` locally. Ignore stale async completions after unmount or retry. Render Markdown/raw HTML through `buildTaskFilePreviewDocument`, and block all WebView navigation except the initial local document.

- [ ] **Step 9: Run preview tests and verify GREEN**

Run Steps 3 and 7 commands. Expected: PASS.

### Task 5: Wire task-scoped reads from App through TaskScreen

**Files:**
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/App.test.tsx`

- [ ] **Step 1: Write a failing controller delegation test**

Add `readTaskFile` to the shared client mock and assert:

```ts
client.readTaskFile.mockResolvedValue({ path: "docs/spec.md", content: "# Spec" });
await expect(controller.readTaskFile("task-1", "docs/spec.md")).resolves.toEqual({
  path: "docs/spec.md",
  content: "# Spec"
});
expect(client.readTaskFile).toHaveBeenCalledWith("task-1", "docs/spec.md");
```

- [ ] **Step 2: Run the focused controller test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- state/mobileController.test.ts -t "reads a task file"
```

Expected: controller method missing.

- [ ] **Step 3: Add the controller method**

Extend `MobileController` and its returned implementation:

```ts
readTaskFile(taskId: string, path: string): Promise<TaskFileContent>;
```

The implementation returns `client.readTaskFile(taskId, path)` without storing file content in `SessionStore`.

- [ ] **Step 4: Run the controller test and verify GREEN**

Run Step 2's command. Expected: PASS.

- [ ] **Step 5: Write failing TaskScreen wiring tests**

Mock `TaskFilePreview`. Capture `TerminalWebView.props.onOpenFile`, call it with `("docs/spec.md", 42)`, rerender with the test hook state, and assert the preview receives:

```ts
{
  path: "docs/spec.md",
  initialLine: 42
}
```

Invoke the preview `readFile` prop and assert `onReadTaskFile("docs/spec.md")` is called. Verify `onClose` clears the preview on rerender.

- [ ] **Step 6: Run TaskScreen tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- screens/TaskScreen.test.tsx
```

Expected: terminal callback and preview are absent.

- [ ] **Step 7: Implement transient preview state**

Add to `TaskScreenProps`:

```ts
onReadTaskFile(path: string): Promise<TaskFileContent>;
```

Store `{path, line}` or `null` in `TaskScreen`. Pass `onOpenFile` into `TerminalWebView`. When selected, render:

```tsx
<TaskFilePreview
  path={selectedFile.path}
  initialLine={selectedFile.line}
  readFile={() => onReadTaskFile(selectedFile.path)}
  onClose={() => setSelectedFile(null)}
/>
```

Do not mount this path for `agentType === "agent"` unless preview state was explicitly created by the PTY terminal.

- [ ] **Step 8: Wire App to the selected task**

Pass:

```tsx
onReadTaskFile={(path) => controller.readTaskFile(selectedTask.id, path)}
```

Add `onReadTaskFile: vi.fn().mockResolvedValue({ path: "docs/spec.md", content: "# Spec" })` to the `renderTaskScreen` fixture. In `App.test.tsx`, capture the `TaskScreen` props and assert invoking `onReadTaskFile("docs/spec.md")` calls the mocked controller with the currently selected task id and path.

- [ ] **Step 9: Run TaskScreen, controller, and App tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- screens/TaskScreen.test.tsx state/mobileController.test.ts App.test.tsx
```

Expected: PASS.

### Task 6: Focused integration and regression verification

**Files:**
- All files changed above

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
cargo fmt --all -- --check
pnpm --dir apps/mobile typecheck
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the complete mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: all mobile Vitest tests pass.

- [ ] **Step 3: Run the Kanna server Rust suite**

Run:

```bash
cargo test -p kanna-server
```

Expected: all `kanna-server` tests pass.

- [ ] **Step 4: Run canonical repository checks proportional to the change**

Run:

```bash
pnpm test
./kd test rust
```

Expected: both canonical suites exit 0. If a pre-existing unrelated failure appears, preserve its complete output and separately rerun every changed-package focused suite to prove the feature remains green.

- [ ] **Step 5: Review the final diff against acceptance criteria**

Confirm from the diff and test evidence that PTY file paths are tappable; authenticated relay routing is task-scoped while direct LAN fails closed; Markdown/raw/line modes work without unbounded DOM expansion; descriptor-rooted traversal rejects path escape, symlinks, sockets, and root swaps; and no SDK-message, image, web-link, Cmd+L, native dependency, runtime-version, push, PR, or commit work entered scope.
