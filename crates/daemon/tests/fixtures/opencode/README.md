# OpenCode TUI frames

Raw PTY output from a real `opencode` process, from launch up to the moment its
TUI reached the state in the filename. Replaying one into `HeadlessTerminal`
reconstructs the exact frame the daemon would have seen, which is what
`crates/daemon/src/headless_terminal.rs` pins its OpenCode status matcher
against.

**Captured from OpenCode CLI 1.18.15**, model `opencode/big-pickle`.

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
measured (80, 100, 120, 160), which is why the matcher keys on those.

The TUI is drawn by `opencode [project]`, the CLI's default command — which is
what the capture script launches. `opencode run`, which is what Kanna currently
spawns, streams plain text and exits at the end of its turn without drawing any
TUI at all — its own defect, recorded as "defect 2" in
`docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md`.

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
