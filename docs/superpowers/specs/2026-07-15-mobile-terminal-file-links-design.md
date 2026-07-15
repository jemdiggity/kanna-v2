# Mobile Terminal File Links

## Summary

Add desktop-style smart file links to PTY terminal output on mobile. Tapping a recognized workspace file path opens a task-scoped in-app preview. Markdown files open rendered by default, while other UTF-8 text files open as raw monospace text.

The mobile app must fetch file content from the task's owner through the existing authenticated relay route. It must never dereference or expose arbitrary paths on the Mac.

## Scope

This first version covers PTY tasks rendered by `TerminalWebView`.

It supports:

- bare filenames with extensions, such as `README.md`;
- nested relative paths, such as `docs/specs/design.md`;
- absolute paths when the resolved file belongs to the task's current worktree;
- optional `:line` and `:line:column` suffixes, with the first number treated as the line;
- rendered and raw Markdown modes;
- raw previews for other UTF-8 text files.

Structured SDK agent messages, terminal HTTP links, images, file browsing, search, editing, sharing, and a mobile equivalent of desktop's Cmd+L shortcut are out of scope.

## Architecture

### Task-scoped file provider

Add an owner-server route:

```text
GET /v1/tasks/{task_id}/files/content?path={encoded_path}
```

The response is JSON:

```json
{
  "path": "docs/specs/design.md",
  "content": "# Design\n..."
}
```

`path` is the normalized worktree-relative display path, even when the request used an absolute path.

The server resolves the durable task id to its current worktree. A focused `task_files` module owns path resolution and reading so filesystem policy does not live in the HTTP handler.

The mobile `KannaTransport` and `KannaClient` interfaces gain `readTaskFile(taskId, path)`. Remote transport uses the existing task-owner routing helper so canonical cloud task ids become owner-local task ids.

File content is more sensitive than the existing task metadata API. The network HTTP router therefore denies this route, including loopback and LAN requests, and only an in-process capability attached by the authenticated relay dispatcher may invoke it. A browser or arbitrary LAN peer cannot forge that request extension. When a cloud task is projected through LAN, the cloud/LAN composite deliberately uses its canonical cloud fallback identity for file reads. LAN-only tasks fail closed with a clear authenticated-relay error until Kanna has a device-bound LAN bearer protocol.

### Terminal link provider

The generated mobile xterm document registers a row-scoped `ILinkProvider`. It follows the desktop provider's current grammar and one-based xterm row mapping. Link offsets are converted from JavaScript string positions to terminal cell columns through the requested `IBufferLine`, so wide and combining Unicode before a path cannot shift its hitbox.

Xterm link decorations only become visible on hover, which does not exist on touch-only devices. The generated document therefore reports the six most recently mentioned unique paths to `TerminalWebView`, which maintains a persistent, horizontally scrollable native `Files` strip above the xterm surface. Refreshing the list scans at most the last 200 terminal rows after a render; it never traverses unbounded scrollback. The compact, middle-truncated buttons are persistently underlined, expose the full path and line through native assistive-technology labels, and use the same parser as the xterm provider. The document also retains semantic HTML buttons as a browser/WebView fallback.

Touch movement and multi-touch gestures impose a short activation cooldown inside the generated document. A horizontal scroll or pinch over the native strip is handled by React Native's `ScrollView`, while the xterm surface keeps its existing pan and pinch behavior. Neither gesture opens a preview. A settled one-tap native button activation calls the same validated `onOpenFile(path, line)` boundary used by this document bridge message:

```json
{
  "type": "terminal-file-link",
  "path": "docs/specs/design.md",
  "line": 42
}
```

Unlike desktop, mobile cannot validate on hover. Candidate matching therefore stays intentionally conservative, and the owner server performs authoritative validation after a tap. A failed candidate opens the preview's error state instead of silently doing nothing.

`TerminalWebView` validates the bridge payload before calling `onOpenFile(path, line)`. Existing terminal-ready, terminal-tap, and E2E inspection messages remain unchanged.

### Preview UI

`TaskScreen` owns the transient selected-file state and renders a full-screen `TaskFilePreview` modal. Opening a link shows the modal immediately in a loading state, then calls a task-scoped read callback supplied by `App` through `MobileController`.

The preview has:

- a close control and normalized file path;
- loading, error, and content states, with Retry for failures that can change without editing the link;
- rendered/raw toggle for `.md` files;
- rendered Markdown by default when no line is requested;
- raw mode by default when a source line is requested;
- raw monospace display for non-Markdown text files;
- scroll-to-line and a brief target-line highlight in raw mode.

Raw previews remain bounded for the full 1 MiB server limit: untargeted source is one escaped text node, while line targeting wraps only the requested line. Newline-heavy files therefore cannot expand into hundreds of thousands of WebView nodes.

Markdown is rendered locally with `markdown-it`, with raw HTML and automatic URL/email linkification disabled. Explicit Markdown link labels remain readable, but their destinations are stripped. To bound synchronous parsing and generated DOM complexity, rendered mode is limited to 128 Ki characters, 5,000 source lines (counting LF, CRLF, and bare CR), 10,000 Markdown syntax-marker characters before parsing, and 10,000 parsed tokens including inline children. Markdown above any limit falls back to the same constant-node raw preview, explains why rendered mode is unavailable, and does not offer an unsafe toggle. For eligible files, the sanitized rendered result is prepared once per content value and reused across React rerenders and raw/rendered toggles. The resulting HTML is displayed in the existing React Native WebView dependency with mobile-specific typography and code/table styles. Preview document navigation is disabled in this version; rendered links do not navigate the WebView or open arbitrary URL schemes.

## Data Flow

```text
PTY bytes -> mobile xterm buffer path detector
  -> bridge reports recent paths to native Files strip
  -> native button tap selects {path, line}
  -> TerminalWebView validates {path, line}
  -> TaskScreen opens TaskFilePreview
  -> MobileController.readTaskFile(taskId, path)
  -> KannaClient chooses the authenticated relay task-owner route
  -> owner kanna-server resolves current task worktree
  -> task_files validates and reads content
  -> preview renders Markdown or raw text
```

## Filesystem Safety

The owner server is the only filesystem authority. It must:

1. Resolve the task or branch alias to a durable task id.
2. Load the task's current worktree from the database.
3. Reject empty paths, embedded NULs, and paths containing parent-directory components.
4. Lexically require absolute requests to begin at the configured worktree root before touching the requested path.
5. Open the workspace root once and keep its descriptor anchored for the entire operation.
6. Traverse raw relative components with `openat`, `O_NOFOLLOW`, and directory descriptors; reject every symlink and non-regular node.
7. Reject files larger than 1 MiB before reading and recheck the actual byte count after reading.
8. Require valid UTF-8.

Expected errors:

- `401 Unauthorized` for ordinary HTTP, loopback, or LAN access without the in-process relay capability;
- `400 Bad Request` for malformed or disallowed paths;
- `404 Not Found` for an unknown task or missing file;
- `409 Conflict` when the task has no current readable worktree;
- `413 Payload Too Large` above 1 MiB;
- `415 Unsupported Media Type` for non-UTF-8 content.

The preview presents these as concise errors. Missing files, missing worktrees, and transport failures offer Retry because their state can change; malformed paths and unsupported content do not. Offline-owner and relay failures use the existing client error path and remain local to the preview instead of replacing the whole task screen.

## Testing

### Rust

- Unit-test relative and allowed absolute path resolution.
- Reject parent traversal, existing and missing absolute paths outside the worktree, all symlinks, root-replacement races, sockets, directories, oversized files, and invalid UTF-8.
- Route-test direct/browser-style denial, authenticated relay success, normalized responses, and each status class.
- Route-test multiple task worktrees with tied timestamps and prove the newest inserted workspace is selected deterministically.

### Mobile client and routing

- Assert direct LAN file reads fail closed without making a request.
- Assert remote canonical task ids route to the owner-local task id.
- Assert LAN projections use their authenticated cloud fallback identity for file content.
- Assert disconnected routes reject clearly.

### Mobile terminal and UI

- Execute the generated terminal document under happy-dom with a stub xterm implementation and activate its generated semantic file buttons through real DOM clicks.
- Cover bare, nested, absolute, line, column, traversal, non-file-like candidates, and terminal-cell ranges after wide/combining Unicode.
- Verify the persistent button strip is visible and assistive-technology accessible, retains the newest six unique paths, emits the bridge payload through an actual one-tap DOM activation, and bounds its production buffer scan.
- Verify touch scrolling and pinch gestures over a path do not activate it.
- Verify `TerminalWebView` rejects malformed payloads and forwards valid ones.
- Cover preview loading, success, retry, close, rendered/raw Markdown, disabled navigation, raw text, line targeting, constant-node rendering for a newline-heavy 1 MiB file, safe raw fallback before parsing oversized or highly fragmented Markdown, and single preparation across stable React rerenders.
- Cover `TaskScreen` wiring from terminal activation to the task-scoped read callback.
- Run the simulator relay lane against a scripted PTY and a real Markdown file in the task worktree. After the simulator attaches, send path-bearing input through the authenticated owner route and wait for the real PTY output. Xterm detects those buffer paths and reports them through the React Native bridge; Appium then performs actual native button presses rather than invoking a callback. Assert fetched rendered content, raw line targeting, close behavior, a missing-file error, and gesture non-activation in the real preview modal. Direct Appium DOM/coordinate activation is not currently viable on the installed iOS 26.2 simulator: Appium discovers the inspectable WKWebView, but every `Runtime.evaluate` request fails with WebKit error `-32601 ('Runtime' domain was not found)`, and WKWebView DOM buttons are not projected into XCUITest's native tree. A WebKit/Appium combination that restores the Runtime domain would make CSS-coordinate coverage feasible. The native strip is the strongest real-component substitute: detection still occurs in the real xterm WebView, crosses the real bridge, and activation is an actual accessible one-tap UI interaction.

## Acceptance Criteria

- A mobile user can tap a generated spec path in PTY output and read the current worktree file without returning to desktop.
- The behavior works through authenticated relay-owned task routes, including cloud tasks whose mutable state is projected from LAN; unauthenticated LAN-only reads fail closed.
- Markdown is readable by default and can be switched to source.
- A `:line[:column]` suffix opens raw source at the requested line.
- No request can read outside the task's current worktree.
- Existing terminal streaming, touch scrolling, pinch zoom, and E2E instrumentation gating continue to pass their tests.
