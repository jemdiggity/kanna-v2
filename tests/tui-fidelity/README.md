# TUI Fidelity Harness

This package measures Kanna's mobile terminal path:

```text
raw PTY bytes -> daemon HeadlessTerminal snapshot -> KSP term frames -> real mobile xterm document
```

The oracle renders the same raw fixture bytes directly into a fresh xterm.js instance at the fixture's PTY dimensions. The harness compares the mobile-path grid against that oracle cell-by-cell, including text, width, foreground, background, and attributes.

The harness also covers three mobile layers that are easy to bypass accidentally:

- Snapshot dimensions: `term_snapshot.cols`/`rows` are applied through the mobile document's `__setTerminalDims` hook before replay. The `bottom-anchored-80x24` fixture fails if mobile rendering drops the PTY dimensions and falls back to the old fixed 220-column, viewport-fitted grid.
- Session accumulation: `large-session-store-snapshot` sends a large snapshot plus live frames through the real `sessionStore` accumulation/cap path before mobile replay. It fails if a large base64 snapshot is sliced mid-frame or renders blank after store replay.
- Stream compaction and reconnect: `status-redraw-stream-compaction` renders every real store publication through the production mutation planner and generated xterm hooks. It crosses the 1 MB retained-history cap during rapid timer redraws, asserts those updates stay append-only, then applies a second real daemon snapshot and asserts exactly one authoritative reset.
- Composer safe region: Chromium loads the generated mobile document with the bundled xterm 6.1 beta runtime, applies normal, multiline, keyboard-shifted, and keyboard-plus-multiline obstructions, and verifies that the real `.xterm-scrollable-element` stays clear. It also verifies that an append preserves manual scrollback and that following resumes within one row of the live bottom.

## Run

```bash
pnpm test:tui-fidelity
```

To run only the composer-safe-region regression:

```bash
pnpm --filter @kanna/tui-fidelity test:terminal-safe-region
```

The first run on a new machine may need:

```bash
pnpm --filter @kanna/tui-fidelity exec playwright install chromium
```

Runtime artifacts are written to `.build/tui-fidelity/`:

- `*.path.png` - mobile-path render screenshots
- `*.reference.png` - raw xterm oracle screenshots
- `summary.json` - full result summary

## Update Goldens

After reviewing diffs and screenshots:

```bash
pnpm test:tui-fidelity -- --update-goldens
```

Goldens live in `tests/tui-fidelity/goldens/*.json`. They include the serialized path grid, serialized reference grid, fallback status, divergent-cell count, and the first cell diffs.

## Fixtures

Synthetic fixtures are defined in `src/fixtures.ts` and materialized as raw `.ansi` byte streams under `fixtures/` each run. Current corpus:

- `synthetic-basics` - ASCII baseline
- `wide-chars-emoji` - CJK, emoji, skin tone, ZWJ
- `box-drawing-table` - Unicode table
- `color-blocks` - 256-color and truecolor
- `attribute-blocks` - bold, dim, inverse, foreground, and background attributes
- `alt-screen` - alternate screen enter/exit
- `scroll-region` - DECSTBM scroll region
- `cursor-save-restore` - DECSC/DECRC
- `spinner-redraw` - carriage-return redraw loop
- `split-sensitive` - live chunks that split UTF-8 and escape sequences
- `bottom-anchored-80x24` - non-220 PTY grid with UI anchored to row 24
- `large-session-store-snapshot` - large snapshot and live output replayed through `sessionStore`
- `status-redraw-stream-compaction` - Codex-like working timer with stable `esc to interrupt` text across retained-history compaction and a reconnect snapshot
- `codex-pwd-tool` - captured Codex CLI TUI session with status/title spinner redraws, shell tool calls, and a final settled answer
- `codex-live-20260905` - current interactive Codex CLI TUI session with three turns, long dictated-like input, multiline input with a blank line, and settled formatted output

Each fixture sets `snapshotAt`. Bytes before that offset are fed through the real daemon `HeadlessTerminal` and serialized into the initial `term_snapshot`; bytes after that offset are emitted as chunked `term_output` frames.

Fixtures may also set explicit `cols`/`rows`. When omitted, the legacy 220x48 grid is used. The mobile-path renderer and the oracle both use the emitted snapshot dimensions, so a dimension-plumbing regression shows up as cell divergence instead of being hidden by a fixed-size oracle.

Captured fixtures are checked in under `fixtures/codex-*.ansi` and loaded by `src/fixtures.ts` without being regenerated. The current Codex fixture was captured from the interactive `codex` TUI, not `codex exec`, in a task-local disposable workspace. The raw bytes were inspected for absolute home paths, auth strings, session ids, and token-like strings before committing.

## Current Report

Initial corpus result:

```text
PASS synthetic-basics: 0 divergent cells, fallback=false
PASS wide-chars-emoji: 0 divergent cells, fallback=false
PASS box-drawing-table: 0 divergent cells, fallback=false
PASS color-blocks: 0 divergent cells, fallback=false
PASS attribute-blocks: 0 divergent cells, fallback=false
PASS alt-screen: 0 divergent cells, fallback=false
PASS scroll-region: 0 divergent cells, fallback=false
PASS cursor-save-restore: 0 divergent cells, fallback=false
PASS spinner-redraw: 0 divergent cells, fallback=true
PASS split-sensitive: 0 divergent cells, fallback=true
PASS bottom-anchored-80x24: 0 divergent cells, fallback=false
PASS large-session-store-snapshot: 0 divergent cells, fallback=false
PASS status-redraw-stream-compaction: 0 divergent cells, fallback=false
PASS codex-pwd-tool: 0 divergent cells, fallback=false
PASS codex-live-20260905: 0 divergent cells, fallback=false
```

The fallback cases are expected because those fixtures intentionally start from a blank snapshot and measure live chunk replay. Unexpected `visible_text_vt` fallback fails the run before golden comparison.

The current captured fixture emitted two daemon snapshots (initial attach and reconnect) plus eight live output frames, with no `visible_text_vt` fallback. Its path grid matched the direct xterm oracle at 0 divergent cells, including text, width, foreground/background, bold/dim/inverse flags, scroll position, blank lines, and prompt markers. The older `codex-pwd-tool` fixture also matches at 0 divergent cells in the current checkout; its previous 59-cell attribute-only report was stale.
