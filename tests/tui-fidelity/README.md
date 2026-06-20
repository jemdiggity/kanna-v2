# TUI Fidelity Harness

This package measures Kanna's mobile terminal path:

```text
raw PTY bytes -> daemon HeadlessTerminal snapshot -> KSP term frames -> real mobile xterm document
```

The oracle renders the same raw fixture bytes directly into a fresh xterm.js instance at 220 columns. The harness compares the mobile-path grid against that oracle cell-by-cell, including text, width, foreground, background, and attributes.

## Run

```bash
pnpm test:tui-fidelity
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
- `alt-screen` - alternate screen enter/exit
- `scroll-region` - DECSTBM scroll region
- `cursor-save-restore` - DECSC/DECRC
- `spinner-redraw` - carriage-return redraw loop
- `split-sensitive` - live chunks that split UTF-8 and escape sequences

Each fixture sets `snapshotAt`. Bytes before that offset are fed through the real daemon `HeadlessTerminal` and serialized into the initial `term_snapshot`; bytes after that offset are emitted as chunked `term_output` frames.

## Current Report

Initial corpus result:

```text
PASS synthetic-basics: 0 divergent cells, fallback=false
PASS wide-chars-emoji: 0 divergent cells, fallback=false
PASS box-drawing-table: 0 divergent cells, fallback=false
PASS color-blocks: 0 divergent cells, fallback=false
PASS alt-screen: 0 divergent cells, fallback=false
PASS scroll-region: 0 divergent cells, fallback=false
PASS cursor-save-restore: 0 divergent cells, fallback=false
PASS spinner-redraw: 0 divergent cells, fallback=true
PASS split-sensitive: 0 divergent cells, fallback=true
```

The fallback cases are expected because those fixtures intentionally start from a blank snapshot and measure live chunk replay. Unexpected `visible_text_vt` fallback fails the run before golden comparison.
