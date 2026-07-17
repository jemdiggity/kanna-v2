# Mobile Terminal Stream Compaction Design

## Goal

Stop the mobile agent terminal from repeatedly resetting and replaying its
entire retained screen while a TUI status line updates. Preserve the existing
terminal-fidelity architecture: daemon `HeadlessTerminal` snapshots, KSP
`term_snapshot` / `term_output` semantics, newline-delimited base64 storage,
and the real xterm document remain the source of truth.

The fix must also make a reconnect repair the terminal in one authoritative
replacement. Static TUI content such as `esc to interrupt` must remain present
while an adjacent working timer changes.

## Root Cause

The mobile session store retains at most 1,000,000 characters of
newline-delimited base64 output. Once appending a live frame crosses that cap,
the store drops the oldest complete frames. The resulting retained string no
longer starts with the string rendered by `TerminalWebView`.

`planTerminalMutation` currently recognizes an append only with
`nextOutput.startsWith(previousOutput)`. After the first trim, every timer
frame fails that check. Each failure calls `__replaceTerminalState`, which
resets xterm and replays roughly one megabyte. Repeating this on every animated
status update causes the visible full-screen rewrite and high update rate.

The transport layer compounds the recovery problem. KSP preserves
`term_snapshot` as an authoritative screen image, but both mobile transports
flatten it into a `ready` event followed by an ordinary `output` event. The
controller therefore appends a reconnect snapshot to stale history rather
than treating it as a new terminal baseline. Reopening the task appears to fix
the problem because it happens to build a new store before receiving that
snapshot.

## Approaches Considered

### Preserve KSP semantics and track retained stream positions (selected)

Carry snapshots as snapshots through the mobile transport and controller. Give
each authoritative baseline an epoch, and track the absolute character offset
of the store's first retained base64 character inside that epoch. The WebView
can then append by range even when storage compaction changes the retained
prefix.

This uses explicit protocol facts, stays linear in the newly appended data,
and gives reconnect a deliberate single-reset path.

### Infer overlap between old and new retained strings

Search for a common suffix/prefix after every mismatch and append the inferred
tail. Repeated frames and base64 substrings make the match ambiguous, and
searching megabyte strings on each timer tick adds work to the failure path.

### Periodically restart the terminal subscription

Force a fresh snapshot whenever retained history approaches the cap. This can
bound replay state, but it introduces avoidable detach/reattach churn and
visible resets while the existing stream already contains enough ordering
information to continue rendering.

## Stream Contract

### Terminal events

`TaskTerminalStreamEvent` will represent the KSP frames without collapsing
their meaning:

- `snapshot`: task id, PTY columns, PTY rows, and base64 snapshot bytes;
- `output`: task id and base64 live bytes;
- `exit` and `error`: unchanged.

LAN and relay transports emit one `snapshot` event from `onSnapshot`, including
an empty snapshot when the daemon reports one. They no longer synthesize
`ready` plus `output`.

The controller applies a snapshot atomically: dimensions, live status, output
baseline, and epoch change become one store publication. A live output frame
only appends within the current epoch. A reconnect-generated snapshot replaces
the prior epoch exactly once.

### Retained terminal state

Alongside `taskTerminalOutput`, the session store exposes:

- `taskTerminalOutputEpoch`: a monotonically increasing identity for the
  current authoritative baseline; and
- `taskTerminalOutputStart`: the absolute character offset of the first
  retained character in that epoch.

Beginning a terminal session and applying a snapshot establish a new epoch at
offset zero. Appending retains the current whole-frame cap behavior. When the
cap removes `n` characters, the retained start advances by `n`; the logical
end remains `start + output.length`.

The offset counts characters in the newline-delimited base64 representation,
not decoded PTY bytes. That is the exact representation passed through React
and lets the store retain its existing frame-safe compaction boundary.

The existing single-frame exception remains: a frame larger than the cap is
kept whole instead of being sliced into invalid base64.

## WebView Mutation Planning

`TerminalWebView` retains the previously rendered epoch, retained start, output
string, and status. For states in the same epoch, it compares absolute ranges:

```text
previous rendered end = previous start + previous output length
next retained range   = [next start, next start + next output length]
```

- If the previous rendered end is inside the next retained range, inject only
  the substring after that end with `__appendTerminalChunk`.
- If the output and status are unchanged, do nothing.
- If the epoch changes, use `__replaceTerminalState` once.
- If the ranges reveal a genuine gap, use the existing safe replacement path.
- If the terminal is still empty and only its status changes, replace the
  placeholder as today.

React may coalesce several store publications. Range planning therefore uses
the total unseen suffix, not assumptions about receiving one render per KSP
frame.

No generated-document rendering logic changes. In particular, this design
does not parse ANSI, synthesize a transcript, patch xterm, reload WebView HTML,
or alter the PTY dimensions.

## Fidelity-Harness Regression

The existing `tests/tui-fidelity` path is the blocking integration regression:

```text
raw PTY bytes
  -> daemon HeadlessTerminal
  -> KSP term_snapshot / term_output frames
  -> real mobile sessionStore
  -> real planTerminalMutation
  -> real generated mobile xterm document
  -> cell-by-cell fresh-xterm oracle comparison
```

The session-store renderer will stop doing a single final replay. It will apply
each store publication incrementally through the production mutation planner
and the production document hooks.

A generated Codex-like status fixture will contain a stable `esc to interrupt`
segment and rapid timer redraws. Its framed representation will exceed the
one-megabyte store cap so at least one whole-frame prefix is removed. The
regression will assert:

- compaction actually occurred (`taskTerminalOutputStart > 0`);
- the initial snapshot caused one replacement;
- timer deltas after compaction remained append mutations rather than repeated
  replacements;
- the final grid matches the raw xterm oracle cell by cell; and
- the final screen contains both the latest timer and `esc to interrupt`.

The same scenario will include a second authoritative snapshot after live
output, modeling StreamClient reconnect. That snapshot must advance the epoch,
cause exactly one additional replacement, and continue to match the oracle
after subsequent deltas. The emitter or fixture metadata will be extended only
as needed to produce that second snapshot from the real daemon headless
terminal rather than fabricating serialized screen bytes in TypeScript.

Existing corpus fixtures, fallback checks, dimensions, golden comparison,
composer safe-region checks, and captured Codex fidelity remain unchanged.

## Fast Test Coverage

- `sessionStore` tests prove atomic snapshot replacement, epoch advancement,
  whole-frame compaction, and retained-start accounting.
- `terminalMutation` tests prove same-epoch append across a trimmed prefix,
  React-coalesced appends, epoch replacement, no-op behavior, and safe fallback
  on a genuine range gap.
- LAN and relay transport tests prove one snapshot event preserves dimensions
  and data.
- Controller tests prove snapshots replace stale history atomically while
  output frames append.
- `TerminalWebView` tests prove epoch/start props reach the planner without
  rebuilding its HTML document.

## Error and Lifecycle Behavior

- An output frame received before a snapshot remains appendable to the empty
  session epoch, matching the current tolerant behavior.
- Empty snapshots still advance the epoch and update dimensions, so reconnect
  can authoritatively clear a stale screen.
- Late events from a closed subscription remain rejected by the controller's
  existing generation guard.
- A task change creates a new epoch and cannot append into the prior task's
  range.
- Backgrounding does not itself reset xterm. If the underlying StreamClient
  reconnects, its snapshot is an explicit epoch replacement. If it remains
  connected, offset-based appends continue without a reset.
- A WebView process reload hydrates from the retained whole-frame buffer as it
  does today. The normal task reopen/reconnect path supplies an authoritative
  snapshot; this change does not introduce periodic network resubscriptions.

## Verification

Run the focused mobile tests and typecheck, then the real-browser fidelity
suite:

```sh
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts \
  src/screens/terminalMutation.test.ts \
  src/state/mobileController.test.ts \
  src/lib/transports/lanTransport.test.ts \
  src/lib/transports/relayClient.test.ts
pnpm --dir apps/mobile run typecheck
pnpm test:tui-fidelity
```

Run broader repository checks if focused verification exposes shared-package
changes. Physical-device launch and Appium remain human-only; the checked-in
fidelity pipeline is deterministic and exercises the renderer used on device.

## Non-Goals

- Replacing xterm or the daemon `HeadlessTerminal`
- Changing the one-megabyte retention limit
- Periodic reconnects as a compaction mechanism
- PTY resize or mobile terminal geometry changes
- Changes to scroll, safe-region, link, keyboard, or composer behavior
- Hiding the problem by throttling timer frames

## Success Criteria

- Crossing the mobile output cap does not trigger repeated xterm resets.
- Rapid status updates append only their unseen framed suffix after compaction.
- A KSP snapshot replaces stale mobile history once, with its PTY dimensions.
- Static and changing portions of the agent status line remain visible.
- The real fidelity path reproduces the former failure and matches its raw
  xterm oracle after both compaction and reconnect.
- Existing mobile terminal fidelity and interaction regressions continue to
  pass.
