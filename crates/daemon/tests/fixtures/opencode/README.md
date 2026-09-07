# OpenCode TUI frames

Raw PTY output from a real `opencode` process, from launch up to the moment its
TUI reached the state in the filename. Replaying one into `HeadlessTerminal`
reconstructs the exact frame the daemon would have seen, which is what
`crates/daemon/src/headless_terminal.rs` pins its OpenCode status matcher
against.

**Captured from OpenCode CLI 1.18.15**, model `opencode/big-pickle`. That
version is named in `OPENCODE_FIXTURE_CLI_VERSION` in
`crates/daemon/src/headless_terminal.rs`, and the classification tests resolve
the detection rules against it — so these frames are checked under the rules
measured for the release they came from, not under whatever the newest rules
happen to be.

| File | State | What the bottom of the screen shows |
|---|---|---|
| `busy-*.ansi` | `Busy` | `⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt  tab agents  ctrl+p commands` |
| `idle-*.ansi` | `Idle` | the working footer replaced by the project bar, and `▣ Build · Big Pickle · 3.0s` above the composer |
| `permission-*.ansi` | `Waiting` | `┃ Allow once  Allow always  Reject  ctrl+f fullscreen  ⇆ select  enter confirm` |

Two geometries are pinned because OpenCode's chrome is width-dependent: the
`ctrl+p commands` hint bar is drawn at 120 columns, dropped at 80 on 1.16.2, and
wraps across two rows on 1.18.15 — so a marker picked from a wide terminal alone
fails silently on a narrow one. The composer's status line
(`┃ Build · Big Pickle OpenCode Zen`) and the working footer survive every width
measured (80, 100, 120, 160), which is why the matcher keys on those. The
matcher keys on the spaced middle dot rather than the mode word for the same
reason the badge above exists: what sits left of the dot varies with the flags.

The TUI is drawn by `opencode [project]`, the CLI's default command — which is
both what Kanna's PTY spawn runs and what the capture script launches.
`opencode run` streams plain text and exits at the end of its turn without
drawing any TUI at all, which is why it is not what a PTY task uses (recorded as
"defect 2" in `docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md`).

The capture script passes **the flags Kanna spawns with**, not a bare
invocation. That matters to what is rendered: with a permission-bypass flag the
composer's mode carries a badge, so `busy-*` and `idle-*` show
`┃ Build auto · Big Pickle OpenCode Zen`. `permission-*` is captured *without*
one — it is Kanna's spawn for permission modes other than `dontAsk`/default, and
`--auto` is precisely the flag that stops the dialog opening.

## Re-capturing

Do not hand-edit these files. The bug they exist to prevent — live sessions
stuck at `Busy` forever, and with them every OpenCode transfer's finalization —
came from a fixture written to match an assumed TUI rather than the drawn one
(`docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md`). OpenCode moves
fast: the working footer's wording changed from `escape interrupt` (1.16.2) to
`esc interrupt` (1.18.15) inside a single day of that investigation. When the
CLI moves, re-capture:

```sh
python3 crates/daemon/tests/fixtures/opencode/capture-tui-fixtures.py
```

It needs `opencode` installed and authenticated, spends a few free-tier turns,
and prints the CLI version it captured from. Update that version here and in the
`OPENCODE_FIXTURES` doc comment in `headless_terminal.rs`, then re-run
`cargo test -p kanna-daemon --lib headless_terminal`.

## What the tests assert

Beyond the final status, the tests name the **rule** that decided each frame:
`opencode/busy/interrupt-marker`, `opencode/idle/composer-status`,
`opencode/waiting/permission-action`. A frame that reaches the right status
through a rule written for a different release is rule selection drifting, and
the status alone cannot see it.

The two footer spellings this directory's history produced —
`escape interrupt` (1.16.2) and `esc interrupt` (1.18.15) — are now version-
tagged entries in `crates/daemon/src/detection/rules.json` rather than one
undifferentiated list, so a session on either release matches only the spelling
its own CLI draws. Re-capturing against a newer CLI means adding an entry with
its range, not replacing the one that is there: someone is still running the
old release.
