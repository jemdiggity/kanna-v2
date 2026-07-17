# Mobile Terminal Snapshot Retention Design

## Problem

Revisiting an idle task in the mobile app can show a blank terminal even though the daemon still has complete terminal scrollback. Sending new input such as `status?` makes only the new output appear; the older terminal content remains missing.

The mobile terminal stream arrives as newline-delimited base64 frames. The first output frame after attachment is the daemon's full terminal snapshot, and later frames are live PTY deltas. `sessionStore.ts` currently limits the combined encoded string to 1,000,000 characters by dropping everything through the first newline after the size cutoff.

When the first snapshot frame itself exceeds the limit, that newline is the snapshot's trailing delimiter. The cap therefore drops the entire snapshot and stores an empty string. A later delta is retained, which exactly explains why new output appears without prior scrollback. A captured 1,454,831-byte daemon snapshot encoded to 1,939,776 base64 characters and reproduced this transition: the store held zero characters after the snapshot, then held only the subsequent status delta.

The daemon's transient `invalid value` serialization messages are a separate startup condition. They occur before an empty Ghostty grid has allocated rows. Direct comparisons of mature live daemon snapshots with recovery files showed that the live headless terminal had equal or newer content, so this fix must not replace the live snapshot with the recovery file. The desktop app's ten-terminal component cache is also outside this data path.

## Goals

- Always retain the complete attachment snapshot, regardless of its encoded size.
- Bound accumulated live terminal deltas so a long-running mobile view does not grow without limit.
- Drop only complete base64 frames; never retain a partial token.
- Preserve snapshot identity across the mobile transport boundary so reconnects
  replace stale replay state.
- Preserve the existing `taskTerminalOutput` and `TerminalWebView` replay contract.
- Keep the daemon, KSP protocol, recovery snapshots, and desktop terminal cache unchanged.

## Design

### Snapshot-aware retention

Keep `taskTerminalOutput` as one newline-delimited string, but make its retention logic aware of the stream structure:

1. Treat the first complete newline-delimited frame as the authoritative attachment snapshot.
2. Exclude that frame from the live-output character budget.
3. Apply the existing 1,000,000-character budget only to the frames after the snapshot.
4. When live output exceeds the budget, remove the oldest complete live frames until the retained suffix fits.
5. If one live frame alone exceeds the budget, retain that entire newest frame. Exceeding the soft character budget is preferable to corrupting or silently discarding the newest frame.

The snapshot and retained live suffix are then concatenated into the existing `taskTerminalOutput` value. This protects the snapshot logically without adding a second public store field or changing the WebView API.

The mobile terminal event contract distinguishes `snapshot` from `output`.
LAN and relay transports forward every stream-client snapshot as a `snapshot`
event with its dimensions and base64 payload instead of flattening it into a
ready event plus ordinary output. The controller atomically replaces the active
task's replay buffer when a snapshot arrives. This applies both to initial
attachment and to the fresh snapshot emitted after network or daemon reconnect.

`beginTaskTerminal` continues to clear output for a new attachment. Switching
tasks therefore establishes a new protected snapshot rather than carrying a
previous task's state forward. A reconnect snapshot replaces the prior snapshot
and accumulated deltas, preventing stale terminal state from being replayed in
front of newer output.

### Frame-boundary behavior

The cap locates the newline ending the snapshot, then examines only the live suffix. If the suffix is over budget, it selects a newline boundary near the cutoff and retains the newest complete-frame suffix. It never slices at an arbitrary character position.

If no complete snapshot delimiter exists yet, the partial first frame is retained unchanged. Current transports append a newline to each complete event, but this behavior keeps the store safe if frame delivery is ever split before it reaches the store.

### Data flow

The attachment flow remains:

1. The mobile controller starts a task terminal and clears the prior task's terminal state.
2. The desktop server attaches to the live daemon session.
3. The live headless terminal serializes its current screen and scrollback into a snapshot frame.
4. The mobile transport forwards that frame as a snapshot event, preserving its dimensions and identity.
5. The controller replaces the store's replay buffer with that snapshot.
6. Subsequent PTY output frames are appended, with only their oldest complete frames eligible for eviction.
7. On reconnect, the new authoritative snapshot repeats steps 3-5 and replaces stale replay state.
8. `TerminalWebView` replays the current snapshot and retained deltas as it does today.

No recovery-file fallback or additional desktop request is introduced.

## Alternatives Considered

### Increase or remove the total cap

Raising the limit would postpone the same failure for larger histories, while removing it would allow an actively viewed terminal to consume memory indefinitely. Neither expresses the actual invariant that the snapshot is required state and live deltas are expendable history.

### Store snapshot and deltas in separate public state fields

This makes the distinction explicit but would require changes across the session state, app props, and WebView boundary. The transport already guarantees snapshot-first ordering, so a frame-aware internal retention function provides the same correctness with a smaller API surface.

### Restore from the daemon recovery file

Recovery files are trailing-debounced and can be older than the live headless terminal. Direct inspection showed that mature live snapshots contain the needed scrollback. Using recovery first would mask the mobile eviction bug and could display stale content.

## Testing

Add focused store regressions before changing the implementation:

- Append a snapshot frame larger than 1,000,000 characters and assert that it remains intact.
- Append a live delta after that oversized snapshot and assert that both decode and replay in order.
- Append enough live frames to exceed the live budget and assert that the snapshot and newest complete frames remain while old live frames are removed.
- Append a single live frame larger than the live budget and assert that it is retained whole.
- Send initial snapshot, live output, a reconnect snapshot larger than the live
  budget, and another delta through the controller; assert only the reconnect
  snapshot and its later delta remain.
- Assert both LAN and relay transports expose terminal snapshots distinctly from
  live output.
- Keep the existing task-retagging and terminal-clearing tests to ensure snapshot ownership follows the active task.

Run the mobile session-store test file first, followed by the mobile package's normal type and test checks that cover the changed module.

## Out of Scope

- Ghostty serialization behavior for a newly spawned empty grid.
- Recovery snapshot write scheduling and filesystem-event load.
- Spotlight or `fseventsd` performance while worktrees and build artifacts are busy.
- Desktop Vue terminal component caching.
