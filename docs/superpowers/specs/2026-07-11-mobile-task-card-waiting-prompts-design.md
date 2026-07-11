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

Firestore publication is event-driven and change-aware:

- title changes continue through the existing display-name structural publication path;
- a changed waiting prompt schedules a per-task trailing-edge publication;
- multiple changes inside a five-second window collapse into the newest prompt;
- only `waitingPromptSnippet` on the already-existing task document is updated;
- a value equal to the last successfully published value is skipped; and
- a failed settled update receives one delayed retry, then stops; and
- close/dispose cancels pending work.

There are no writes for terminal output chunks and no periodic preview writes. At most one Firestore write is produced for a settled burst of waiting-prompt changes, in addition to already-required structural task writes. Task creation from any window publishes its LAN snapshot and emits a shared invalidation; it never writes Firestore directly, so the elected owner remains the only automatic cloud writer.

Exactly one desktop window owns automatic local Firestore publication: the first live window in the persisted workspace order. Restored secondary windows still subscribe to cloud state but do not reconcile local snapshots or schedule waiting-prompt writes. Window open/close events re-elect the owner; if the current owner closes, it first fences new cloud work and drains any in-flight write before atomically removing its membership and notifying the successor. The drain is bounded to five seconds: a timeout keeps the window open and restores its previous publication role rather than allowing an unsafe overlapping handoff. If local workspace recovery is also unavailable, the previous owner remains the fallback publisher until election can be read again. The next live window only takes over after a successful drain and removal. Writes within the elected window are serialized so a delayed structural reconcile cannot overwrite a newer title or waiting prompt.

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
- per-task cloud publication coalesces changes, deduplicates successful values, corrects an in-flight A→B→A change, and never runs periodically;
- sign-out/re-authentication, secondary-window ownership, owner handoff fencing, and structural/prompt write ordering do not lose or duplicate updates;
- concurrent workspace membership and selection mutations, including close-during-startup, neither resurrect closed windows nor discard newly opened windows;
- an offline cloud drain times out safely without transferring ownership, and recovery failures retain the previous publisher;
- desktop title edits map to the mobile task title;
- the mobile card omits card type and repository name;
- title and waiting prompt bounds append `…` without splitting Unicode scalar values; and
- the pre-capture state renders a muted `…` placeholder.

Focused daemon, server, desktop, and mobile tests run first, followed by the affected Rust suites, TypeScript package tests, and desktop/mobile typechecks.

## Out of Scope

- Showing repository identity inside each card.
- Showing the original task prompt as card preview content.
- Syncing terminal scrollback or raw output through Firestore.
- Publishing every waiting-state repaint or output line.
- Editing task titles from mobile.
- Changing the mobile OTA runtime version.
