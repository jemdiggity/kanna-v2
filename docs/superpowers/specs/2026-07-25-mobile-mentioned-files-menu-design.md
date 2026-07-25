# Mobile Mentioned Files Menu

## Summary

Replace the mobile terminal's horizontal file-link strips with a task action that exposes a bounded, reverse-chronological list of files mentioned in PTY output. The `+` menu shows `Mentioned Files (n)`, where `n` is the number of distinct detected path tokens retained for the task, capped as `20+`. Selecting the action opens a dedicated native list. Direct taps on file paths inside xterm remain available.

Detection must stay out of the terminal's hot path. After writes settle, the WebView incrementally examines newly appended normal-buffer rows, a bounded tail when existing normal rows are redrawn, and the bounded alternate buffer while a full-screen terminal application is active. It does not rescan an unbounded terminal tail after every update. Filesystem validation and bare-filename lookup run on the task owner only after the user opens the list or directly taps a file mention.

## Problem

The current implementation has three related problems:

1. It renders recent links twice: once as semantic buttons inside the WebView and again as a native horizontal strip above it. These layers compete with xterm's horizontal pan and pinch gestures, making the desired file difficult to select.
2. It rescans the newest 200 rendered rows after every terminal write even when no file history changes.
3. It recognizes only Markdown paths and forwards the literal token to the existing exact-path reader. A bare nested filename such as `TaskScreen.tsx` is therefore either ignored or treated as a worktree-root file and fails to open.

Desktop's Cmd+L remains useful because it scans on demand and validates paths before activating them. Mobile needs the same reliable outcome in a touch-friendly form without continuous full-buffer processing.

## Scope

This change covers PTY tasks rendered by `TerminalWebView`.

It includes:

- a bounded, task-local mentioned-file history;
- a dynamic `Mentioned Files (n)` task action;
- a dedicated native mentioned-files list;
- owner-side resolution for exact, absolute, and bare filename mentions;
- direct terminal-link activation through the same resolver;
- source/text file extensions and optional `:line[:column]` suffixes;
- existing Markdown rendered/raw preview behavior and raw preview for other UTF-8 text files.

Structured SDK agent events, persistence across app launches, arbitrary file browsing, images and other binary previews, and changes to desktop Cmd+L are out of scope.

## User Experience

### Task action

The `+` action sheet always contains `Mentioned Files (n)`. It appears above `View Diff`. With no detected mentions it reads `Mentioned Files (0)` and opens the list's empty state rather than relying on platform-specific disabled action behavior.

The count represents distinct detected path tokens in the retained MRU history. It is not a count of occurrences. Mentioning the same token again moves it to the front and updates its latest source line without increasing the count. The history retains 20 entries plus an overflow sentinel; its label is exact from zero through 20 and becomes `Mentioned Files (20+)` after a twenty-first distinct token is seen.

### Mentioned-files list

Selecting the action opens a full-screen native modal immediately. While the owner resolves candidates, the modal shows the detected tokens in reverse chronological order with a loading state. Resolution then replaces raw tokens with selectable worktree-relative paths.

- An exact nested or allowed absolute path becomes one row.
- A bare filename with one match becomes one row showing the canonical relative path.
- A bare filename with multiple matches expands into separate rows showing their full relative paths.
- Repeated raw mentions that resolve to the same canonical path collapse to the newest occurrence.
- Missing candidates are omitted, with a footer such as `2 mentions couldn't be matched`.
- A resolved file that is not valid UTF-8 reaches the existing preview's unsupported-content error; resolution does not read every match merely to preflight its encoding.
- An empty detected history shows `No files mentioned yet`.

Selecting a resolved row closes the list and opens the existing `TaskFilePreview`, preserving the most recent line number associated with that mention.

### Direct terminal activation

The row-scoped xterm link provider remains. A direct tap sends the detected mention to the same owner resolver:

- one result opens the preview;
- multiple results open the mentioned-files modal narrowed to those choices;
- no result opens the modal's concise unavailable state.

This makes direct taps a convenient shortcut while the action-menu list remains the reliable touch target.

## Incremental Detection

The generated xterm document owns mention detection because its rendered buffer is the authoritative view after ANSI parsing, cursor control, Unicode cell-width handling, and line wrapping.

The detector restores the desktop-style conservative file-token grammar instead of limiting matches to Markdown. It rejects parent traversal and the image extensions already recognized by desktop (`apng`, `avif`, `bmp`, `gif`, `jpg`, `jpeg`, `png`, `svg`, and `webp`) before recording a token because mobile image preview is outside this change. Other extensions remain candidates; the owner remains authoritative for existence, workspace containment, regular-file status, and UTF-8 content.

### Initial attach and replacement

After a terminal snapshot is written, the detector performs one bounded backward reconstruction. When the alternate buffer is active, it scans that no-scrollback buffer first, newest row first, and then examines at most the newest 1,000 physical rows of the normal buffer. Otherwise it scans only the bounded normal-buffer tail. It stops early after finding the overflow sentinel beyond the 20 retained distinct tokens. This reconstructs recent history after reconnect without traversing the full 10,000-row normal scrollback while still retaining filenames visible in a full-screen terminal redraw.

### Appends

After an append finishes parsing, the detector records the previous and current normal-buffer lengths and queues a coalesced scan after 200 milliseconds of inactivity. When the normal buffer grows, the pending range begins two physical rows before the earliest append boundary, allowing tokens split across the prior line tail or changed by wrapping to be reconsidered. When output rewrites existing normal rows without growing scrollback, the scan is capped to the newest 200 physical rows. Multiple writes within the debounce window merge into one bounded range.

While the alternate buffer is active, each settled batch also scans the complete alternate buffer. Xterm alternate buffers have no scrollback, so this scan is bounded by the visible terminal row count and captures filenames painted or repainted by full-screen agent TUIs. Normal-buffer rows are scanned at the same time only if the write also changed normal-buffer length; otherwise the preserved normal history is left untouched. Recorded entries form an MRU mention history, so a later redraw can add or refresh a mention but erasing a row does not erase an earlier mention.

The detector stores entries in MRU order keyed by the parsed path token without line or column suffixes. A newer occurrence replaces the retained line number and moves the entry to the front. It posts a `terminal-file-mentions` bridge message only when the ordered bounded history or overflow state changes.

### Bridge validation

`TerminalWebView` validates every bridge record:

- the payload must be an array of at most 21 records;
- paths and raw tokens must be nonblank bounded strings that reparse identically;
- paths may not contain parent-directory components;
- line values must be positive integers;
- overflow must be a boolean.

Malformed records are discarded. Switching tasks clears native mention state before the new WebView history is accepted. The component exposes the validated history through an `onMentionedFilesChange` callback to `TaskScreen`.

## Owner-Side Resolution

### API

Add an authenticated task-file capability route:

```text
POST /v1/tasks/{task_id}/files/resolve-mentions
```

Request:

```json
{
  "mentions": [
    { "path": "TaskScreen.tsx", "line": 625 },
    { "path": "apps/mobile/src/screens/taskActionMenu.ts" }
  ]
}
```

The route accepts at most 21 mentions. Each path and the total request body have explicit size limits.

Response:

```json
{
  "mentions": [
    {
      "path": "TaskScreen.tsx",
      "line": 625,
      "matches": [
        { "path": "apps/mobile/src/screens/TaskScreen.tsx" }
      ],
      "truncated": false
    }
  ]
}
```

The remote transport maps canonical cloud task ids to owner-local ids through the existing task-owner route. The LAN-only transport continues to fail closed. Like task-file reads, ordinary HTTP, loopback, and LAN callers cannot invoke the route without the in-process authenticated relay capability.

### Resolution rules

The task-file service resolves the durable task to its current worktree.

1. Nested relative and absolute-in-worktree mentions use the existing normalization and descriptor-anchored containment rules.
2. A bare filename first checks the worktree root exactly.
3. If the root file is absent, an ignore-aware workspace walk searches regular, non-symlink files by exact basename.
4. The walk never follows symlinks, excludes `.git` and ignored/generated directories, stops at 50,000 visited entries, and returns at most 10 matches per mention.
5. A root-level exact match wins over same-basename files nested elsewhere.
6. Matches are returned as normalized worktree-relative paths. Resolution does not return file content.

The subsequent existing file-content route remains the authority for size, UTF-8, symlink, and regular-file validation at read time. This preserves the anchored read boundary even if the workspace changes between resolution and preview.

## Components and Data Flow

### `buildTerminalDocument`

- Retain the xterm row link provider and gesture guards.
- Remove WebView file-strip markup, styles, semantic fallback buttons, and fixed-tail refresh scanning.
- Add the bounded MRU detector, initial reconstruction, incremental coalescing, and `terminal-file-mentions` bridge message.
- Restore source/text file-token detection.

### `TerminalWebView`

- Remove the native horizontal `ScrollView` strip.
- Validate mention-history messages and report changes to `TaskScreen`.
- Continue forwarding direct activation, but route it through `TaskScreen` resolution rather than opening the literal path immediately.

### `TaskScreen`

- Own transient mention history for the current PTY task.
- Supply the dynamic count to `showTaskActionMenu`.
- Open and close the mentioned-files modal.
- Resolve either the full history or one directly activated mention through callbacks supplied by `RootNavigator`.
- Open `TaskFilePreview` only with a canonical resolved path.

### `TaskMentionedFiles`

A focused native component owns loading, resolved, ambiguous, empty, unavailable, and retry states. It renders canonical paths as vertically scrollable rows and returns a selected path and optional line to `TaskScreen`.

### Client and server

`KannaTransport`, `KannaClient`, `MobileController`, and cloud/LAN routing gain `resolveTaskFileMentions(taskId, mentions)`. `kanna-server` adds the capability-only route and the task-file resolver.

Data flow:

```text
PTY append
  -> xterm parses output
  -> coalesced delta scan updates bounded MRU only when rows changed
  -> bridge sends changed history
  -> TaskScreen updates Mentioned Files (n)

User opens Mentioned Files
  -> one authenticated resolution request
  -> owner resolves exact paths and bare basenames
  -> native list displays canonical matches newest first
  -> selection uses existing authenticated file-content read
  -> TaskFilePreview renders content
```

## Error Handling

- Resolver transport or owner failure keeps the modal open and offers `Retry`.
- A task without a current workspace reports that files are unavailable for this task.
- An oversized request is rejected before workspace traversal.
- A traversal limit produces a bounded result with truncation metadata rather than an unbounded walk.
- Missing mentions do not fail the whole batch.
- A resolved file that disappears before reading uses the existing preview error and retry behavior.
- Task changes invalidate in-flight resolution responses and clear mention, modal, and selected-file state.

## Testing

### Generated terminal document

Execute the real generated document under happy-dom with the xterm stub and assert:

- no WebView file strip or semantic fallback buttons exist;
- source, Markdown, absolute, and line/column mentions are recognized;
- traversal and the explicit image-extension set are rejected;
- repeated tokens move to the front and update their line without increasing the count;
- a twenty-first token produces overflow without growing the bridge payload;
- initial reconstruction is bounded to 1,000 rows and stops early after overflow;
- append detection reads only the merged delta range plus overlap;
- normal-buffer redraws without scrollback growth scan at most the newest 200 rows;
- rapid writes coalesce into one scan;
- alternate-screen redraws enter mention history through the bounded no-scrollback buffer without rescanning unchanged normal scrollback;
- unchanged history does not emit another bridge message;
- direct xterm activation still sends one mention.

### React Native

- `TerminalWebView` validates bounded history, rejects forged records, clears state on task switch, renders no horizontal file strip, and forwards direct mentions.
- `taskActionMenu` renders `Mentioned Files (0)`, exact counts, and `20+`, and maps its dynamic indices correctly on iOS and Android.
- `TaskMentionedFiles` covers loading, canonical rows, ambiguous expansion, deduplication, unmatched footer, empty, retry, selection, and stale-response suppression.
- `TaskScreen` covers menu-to-modal flow, direct unique activation, direct ambiguity, canonical preview reads, close behavior, and task-switch reset.
- Client, controller, remote routing, cloud/LAN fallback, and LAN fail-closed tests cover the new resolution method.

### Server

- Resolve exact root, nested, and allowed absolute paths.
- Resolve a unique nested basename.
- Prefer an exact root file over nested duplicates.
- Return deterministic sorted candidates for ambiguous basenames.
- Include untracked non-ignored files and exclude ignored files, `.git`, directories, symlinks, sockets, and outside-worktree paths.
- Reject traversal, NULs, oversized batches, and unauthenticated route access.
- Bound visited entries and returned matches.
- Preserve deterministic current-worktree selection.

### End to end

Extend the simulator relay journey to emit source and Markdown paths, including a unique bare nested filename and an ambiguous basename. Through native controls:

1. Open `+` and assert `Mentioned Files (n)`.
2. Open the list and assert reverse chronological canonical paths.
3. Select the unique bare filename and verify its real task file preview.
4. Reopen the list, select one ambiguous full path, and verify the chosen content.
5. Confirm no native or WebView horizontal file strip appears.

Direct xterm coordinate activation remains unit-tested because the installed iOS WebView does not expose xterm link hitboxes reliably to Appium.

## Acceptance Criteria

- Mobile PTY tasks show `Mentioned Files (n)` in the `+` menu.
- The count and reverse-chronological list update as the agent mentions distinct files.
- Terminal streaming does not repeatedly rescan a fixed terminal tail.
- Opening the list resolves bare nested filenames on the task owner and handles ambiguity explicitly.
- Selecting a resolved entry opens the existing file preview at its latest mentioned line.
- Direct terminal file taps continue to work through the same resolver.
- Horizontal file strips are removed.
- Processing, bridge payloads, workspace traversal, and match results are explicitly bounded.
- Existing terminal scrolling, pinch zoom, selection, streaming, authenticated task-file security, and preview behavior remain intact.
