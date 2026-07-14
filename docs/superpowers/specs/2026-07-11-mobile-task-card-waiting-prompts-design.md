# Mobile Task Card Waiting Prompts

## Goal

Make mobile task cards concise and useful. A card shows only the task stage, current editable title, and most recent agent-authored content visible when the session entered `waiting` or `idle`. It must not repeat the original task prompt or show redundant card-type and repository labels.

## Card Contract

Each card contains:

- the current stage;
- the current task title, bounded to 80 visible characters; and
- the most recent waiting-state prompt snippet, bounded to 240 visible characters.

Both bounds include the typographic ellipsis (`…`) appended when truncation occurs and must not split a Unicode scalar value: truncated output therefore contains at most 80 or 240 visible characters in total. The title may occupy at most two rendered lines and the waiting prompt at most three. Before the first waiting prompt has been captured, the card renders a muted `…` placeholder.

The card no longer shows `TASK`/`RECENT` or the repository name. Repository selection remains outside the card, and the same compact card is used on every task-list surface.

## Nomenclature and Sources of Truth

The concepts remain separate:

- **Title** is the task's current editable display name. When no display name exists, the existing prompt-derived fallback remains. A desktop rename must propagate to mobile through the normal LAN or cloud task snapshot.
- **Task prompt** is the original user request. The existing cloud `promptSnippet` remains available for task reconstruction and compatibility but is never rendered as a card's waiting prompt.
- **Waiting prompt snippet** is the latest bounded agent-authored text captured when the agent becomes `waiting` or `idle`. New API and cloud fields use the explicit name `waitingPromptSnippet` rather than the ambiguous generic `snippet` name.

The existing SQLite `last_output_preview` column is retained as the physical compatibility column for this release, but server methods and transport models treat its value as the waiting prompt snippet. This avoids a schema-only migration while preventing the legacy column name from leaking into new mobile and cloud contracts.

## Capture at the Daemon Status Boundary

The daemon already maintains a provider-aware headless terminal and derives `busy`, `waiting`, and `idle` from its visible footer. The prompt should be extracted at that same boundary instead of scraping arbitrary output chunks elsewhere.

For PTY sessions, status detection returns both the detected status and an optional waiting prompt snippet. On a transition to `waiting` or `idle`, extraction:

1. takes the trailing agent-authored block visible immediately before the input prompt, or the visible permission/question block that caused `waiting`;
2. removes the `❯`/`›` input glyph, provider status chrome, worktree footer, and keyboard hints;
3. normalizes internal whitespace for a compact card; and
4. bounds the result to 240 visible characters.

For headless agent sessions, the equivalent value comes from the latest `AssistantText` visible when a turn completes or waits for interaction. A permission request with no preceding assistant text does not invent content; the prior waiting prompt remains.

`StatusChanged` gains an optional waiting-prompt field. Busy transitions omit it. Existing consumers remain compatible because the field is optional, and status detection still works when extraction yields no meaningful text.

This is transition-driven: there is no all-session output observer and no periodic terminal scraping.

## Server Persistence

`kanna-server`'s existing daemon status watcher receives the optional waiting prompt. When it resolves to an open task and differs from the stored value, the server updates the compatibility column and publishes one task-state invalidation. Empty extraction leaves the previous prompt unchanged.

Persistence is best effort. A database failure is logged and must not interfere with agent status, terminal output, task completion, or stage transitions. Daemon or server restart retains the last successfully persisted waiting prompt.

## LAN and Cloud Synchronization

LAN task summaries expose `waitingPromptSnippet` from the durable task value.

Cloud task snapshots add nullable `waitingPromptSnippet` while keeping the original `promptSnippet` separate. The mobile and remote-desktop cloud mappers use only `waitingPromptSnippet` for card preview content.

`kanna-server` is the sole automatic Firestore task-index producer. It maps the authoritative SQLite UI snapshot, including `last_output_preview`, and sends full reconciliations over its authenticated relay WebSocket. Its publication state machine permits one request in flight, coalesces newer SQLite states, retries failures with bounded backoff, and forces an authoritative reconciliation after reconnect. The relay validates the authenticated desktop and reconciles only that desktop's Firestore task subtree.

Renderer windows perform idempotent credential association and read subscriptions only. They do not elect a Firestore publisher, drain cloud writes, or hand publication ownership between windows. Closing a renderer removes its workspace membership before taking the explicit final native-close path; `kanna-server` continues observing SQLite independently of renderer lifetime. Task creation, title changes, activity changes, and waiting-prompt changes therefore reach the same server-owned publication path from every window without per-output-chunk writes.

Workspace membership and selection changes use narrow server-side mutations inside a SQLite `BEGIN IMMEDIATE` transaction rather than replacing a whole JSON snapshot from each Webview. Removal carries the caller's observed and currently live window ids, so stale members are pruned without deleting a concurrently opened window or resurrecting a window that already closed. Each Webview registers its close handler before ensuring its own membership; an opener only creates the Webview and never performs a second ensure on the child's behalf.

Older cloud snapshots without `waitingPromptSnippet` remain valid and render the muted placeholder.

## Mobile Presentation

The mobile task model exposes `waitingPromptSnippet`. The presentation helper applies the 80/240 display bounds and placeholder behavior. `TaskCard` removes its scope/repository row and renders:

1. bounded title and stage pill; then
2. bounded waiting prompt or muted `…`.

The mobile Firestore subscription updates the title when a desktop rename changes `displayName`. LAN polling receives the same current title from `kanna-server`. No native mobile code or dependency changes are required, so the OTA runtime version remains unchanged.

## Testing

Regression coverage verifies:

- provider-specific PTY status detection extracts the agent-authored block while excluding prompt glyphs and terminal chrome;
- headless agent completion uses the latest assistant text;
- busy transitions and meaningless footer content do not overwrite the stored prompt;
- the server persists only changed waiting prompts and publishes one task invalidation;
- cloud and LAN snapshots keep original `promptSnippet` separate from `waitingPromptSnippet`;
- server-owned cloud publication coalesces changes, retries bounded failures, and reconciles current SQLite state after reconnect;
- sign-out/re-authentication and multiple renderer windows cannot create competing task publishers;
- concurrent workspace membership and selection mutations, including close-during-startup, neither resurrect closed windows nor discard newly opened windows;
- every native close request is prevented throughout initialization, membership removal, and finalization; only the explicit programmatic `destroy()` path, which bypasses `CloseRequested`, may destroy the window;
- a failed membership removal keeps the window open and restores removed membership best effort;
- desktop title edits map to the mobile task title;
- the mobile card omits card type and repository name;
- title and waiting prompt bounds append `…` without splitting Unicode scalar values; and
- the pre-capture state renders a muted `…` placeholder.

Focused daemon, server, desktop, and mobile tests run first, followed by the affected Rust suites, TypeScript package tests, and desktop/mobile typechecks.

### Cross-boundary E2E coverage and exceptions

The desktop `mock/new-window.test.ts` lane contains a real Tauri-window scenario that closes the source window through the application lifecycle and checks the surviving membership. In this worktree the native-close run could not complete: macOS WebDriver timed out after destroying the focused window, and subsequent commands reported `No window could be found`. Running this scenario requires a WebDriver harness that can reattach to or switch sessions after focused native-window destruction. The narrower App regressions model Tauri's close wrapper with deferred initialization, membership removal, and final destruction; dispatch overlapping native close requests; prove every request remains prevented; and prove the one explicit programmatic destroy still completes. A destroy-failure regression also proves membership compensation and retry. Tauri-controller and server workspace-mutation tests cover the adjacent native and persistence boundaries.

The server-owned `cloud-task-mobile-index` E2E starts `kanna-server`, relay, and fresh Firebase emulators; it changes SQLite `last_output_preview` and verifies the exact waiting text reaches the mobile Firestore mapper while retaining activity. This is the positive desktop-owner publication path and does not depend on a renderer being alive to publish.

The mobile relay lane seeds distinct title, original prompt, repository, and non-null waiting-prompt values through the authoritative local server fixture, then inspects the exact row before opening it. Its run in this worktree reached authenticated server/relay/Firebase publication and created a live Appium/WebDriverAgent session, but the installed `build.kanna.app.dev` simulator app never exposed `mobile.app-shell` within 30 seconds. A current dev build installed for the iOS 26.2 simulator and configured to boot the matching Metro bundle on the lane's assigned port would make the UI journey runnable. Relay-row helper tests and focused task-card, presentation, screen, and Firestore-index tests prove the exact row includes title, stage, and waiting text while excluding the original prompt, repository label, `TASK`, and `RECENT` in the meantime.

## Out of Scope

- Showing repository identity inside each card.
- Showing the original task prompt as card preview content.
- Syncing terminal scrollback or raw output through Firestore.
- Publishing every waiting-state repaint or output line.
- Editing task titles from mobile.
- Changing the mobile OTA runtime version.
