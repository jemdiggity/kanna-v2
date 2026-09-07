# Terminal cursor/rendered-screen divergence: two local windows on one task

Date: 2026-09-05. Task 36932e3b (diagnosis), reported by the owner against staging
0.3.0-staging.10 on `desktop-aa43ab36-e634-4ae9-b629-e8c8a91f7bff` (Mac Studio),
task manager task `14a4ed86`, Codex `gpt-6-astra`.

Owner's words: *"we have terminal fidelity issues. this terminal paints all the way
to the bottom, but the cursor is about 15% from the bottom so it looks like this
when I type."* Typed characters and the caret landed on a line of earlier tool
output, sixteen rows above the `Ask Codex to do anything` composer that was still
drawn at the bottom of the pane.

## Verdict

Not a rendering, snapshot, reconnect or provider bug. The agent's PTY was
**65 rows x 171 cols** while the window the owner was looking at rendered
**81 rows x 203 cols**. Codex addresses its composer relative to the grid the PTY
reports, so it painted the composer sixteen rows above the rendered bottom and
thirty-two columns short of the rendered right edge; the bottom rows still held the
last paint from when the grids agreed, which is why the pane "paints all the way to
the bottom" while the caret sits above it.

The PTY was pinned to the smaller grid by `effective_terminal_size` in
`crates/daemon/src/client.rs`, which sizes a session to `min(cols) x min(rows)`
across every attached client. The owner had **two desktop windows open on the same
task**. The smaller window won the minimum; every other viewer was left rendering a
grid the agent never sees.

This is the same policy that task **12f567e9** ("Terminal geometry: daemon-owned
size controller, local-preferred, followers render the owner's grid") was opened to
replace. The reported symptom therefore shares 12f567e9's proven cause; it is not a
separate defect. What is new here is that the two competing viewers are **two local
desktop windows**, not a phone or a cross-machine pane.

## Evidence

Six independent measurements agree. All were read-only; the owner's live session was
not resized and no input was injected into it.

1. **Live PTY geometry.** The Codex process for the manager worktree
   (`/Users/jeremyhale/.kanna/repos/kanna-2/.kanna-worktrees/task-14a4ed86`, pid
   74314, child of the staging daemon 57931) owns `ttys009`.
   `stty -f /dev/ttys009 size` reported `65 171`.

2. **Renderer geometry.** `/tmp/kanna-webview-58c79e45.log` — the two most recent
   resizes the desktop sent for session `14a4ed86` before the screenshot:
   `20:34:53.689 resize:single {"instanceId":"ehh0e8fq","cols":203,"rows":81}` and
   `20:35:31.351 resize:single {"instanceId":"9lpslbdb","cols":203,"rows":81}`.
   `resizeLiveSession` sends whatever `fitAddon.fit()` set the xterm grid to, so the
   visible window's xterm was 203x81.

3. **Two live viewers on one session.** Replaying the same log's
   `[terminal][instance] startListening` / `dispose:end` pairs leaves exactly two
   undisposed `useTerminal` instances for `14a4ed86` in the current app process:
   `uayso1ub` (started 19:49:01.244, resized to **171x65**, never paused, never
   disposed) and `9lpslbdb` (started 20:35:31.344, **203x81**).

4. **Two windows, both on this task.** `settings.window_workspace_v1` in the staging
   database:

   | windowId    | selectedItemId | geometry (physical px) | CSS px      |
   |-------------|----------------|------------------------|-------------|
   | `main`      | `14a4ed86`     | 3964 x 2670            | 1982 x 1335 |
   | `5c1e8318…` | `14a4ed86`     | 3490 x 2196            | 1745 x 1098 |

   The two windows differ by exactly **237 CSS px in both dimensions**.
   237 / 32 columns = 7.40625 px per cell; 237 / 16 rows = 14.8125 px per cell.
   Solving each window independently for its non-terminal chrome gives the *same*
   constants for both (58.5 px horizontal, 135.2 px vertical), which only happens if
   203x81 and 171x65 are these two geometries laid out by the same component tree.
   The 32-column and 16-row deltas are exactly the divergence seen on screen.

5. **The screenshot's pixels.** Cell size measured off the block cursor is 15 x 30
   device px. Every fixed-width thing Codex drew — both separator rules, the
   `— Worked for 7m 23s ────` rule, the composer box's top padding row — stops at
   x = 2619, i.e. column ~171. Wrapped tool-output text and the freshly typed
   composer's erase-to-end-of-line run past it to the crop edge, because
   erase-to-EOL clears to the *renderer's* width. The freshly typed composer is on
   row 9 and the stale composer on row 25: sixteen rows apart. Full numbers in
   `docs/task-screenshots/36932e3b-screenshots/MEASUREMENTS.md`; annotated overlay in
   `annotated-grid-divergence.png` (gitignored, described there).

6. **The smaller window is still attached.** Closing it would run
   `cleanup_client_writer_registries`, drop its size entry and re-apply the remaining
   minimum (203x81) to the PTY. The PTY is still 65x171, so the second window's
   client is still registered.

## Reproduction

Two desktop windows on the same PTY task, different sizes:

1. Open a PTY task in the main window and size the window large.
2. `⌘`-open the same task in a second window (`windowWorkspace.openWindow`) and make
   that window smaller.
3. Type into the large window. The PTY is now the small window's grid; the agent's
   composer and caret sit `rowsLarge - rowsSmall` rows above the bottom of the large
   window, and its box art stops `colsLarge - colsSmall` columns short.

This is already exercised deterministically, and asserted as *correct*, by
`apps/desktop/tests/e2e/real/pty-session.test.ts:1392`
("keeps an existing PTY stream alive when a secondary window attaches and
detaches"). Lines 1462-1470 assert that the second, smaller window shrinks the
source window's PTY:

```ts
expect(sharedSize.cols).toBeLessThanOrEqual(sourceSize.cols);
expect(sharedSize.rows).toBeLessThanOrEqual(sourceSize.rows);
expect(samePtySize(sharedSize, sourceSize)).toBe(false);
```

**That assertion is the owner's bug, encoded as an expectation.** Whoever replaces
the minimum policy has to rewrite this test; it is not in 12f567e9's listed test
lanes, so it is easy to miss and would otherwise either fail the gate or be
"fixed" by preserving minima for same-class local viewers.

## Why this task did not implement a fix

Every repair for this symptom is inside 12f567e9's owned, owner-approved surface:

- Not taking a minimum across same-class viewers is its election policy.
- Making the non-controlling window render the authoritative grid is its
  follower-rendering item.
- Telling a viewer what geometry was actually applied (the daemon reports nothing
  today — `Command::Resize` answers `Event::Ok`, `ResizeNoReply` answers nothing)
  is its "publish effective dimensions + controller state" item, which needs
  protocol fields, capability negotiation, generated TS and both clients.

Task 36932e3b was instructed to report proof and coordinate rather than duplicate
that policy, so it changed no behaviour. No test pinning the current minimum policy
was added either, because that would obstruct the replacement.

## What 12f567e9 should pick up

1. Treat **two local desktop windows on one task** as a first-class case of
   "multiple same-class viewers never take minima". It is the case the owner
   actually hit.
2. Update `apps/desktop/tests/e2e/real/pty-session.test.ts:1392` — its multi-window
   assertions encode the old minimum policy.
3. Add the fidelity assertion this report is really about: after the trigger, the
   non-controlling window's rendered grid must match the authoritative grid, and a
   typed character must appear at the composer position that window is showing.

## Immediate mitigation for the owner

Close the second window on that task, or make both windows the same size. The PTY
re-sizes to the remaining viewer as soon as the smaller one detaches.
