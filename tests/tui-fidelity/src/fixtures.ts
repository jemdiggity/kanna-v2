import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE_DIR } from "./paths.ts";
import type { FixtureDefinition } from "./types.ts";

const encoder = new TextEncoder();

export async function writeFixtures(): Promise<FixtureDefinition[]> {
  const fixtures = buildFixtures();
  await mkdir(FIXTURE_DIR, { recursive: true });
  await Promise.all(
    fixtures.map((fixture) =>
      writeFile(path.join(FIXTURE_DIR, `${fixture.name}.ansi`), fixture.bytes)
    )
  );
  return fixtures;
}

function buildFixtures(): FixtureDefinition[] {
  return [
    syntheticBasics(),
    wideChars(),
    boxDrawing(),
    colorBlocks(),
    altScreen(),
    scrollRegion(),
    cursorSaveRestore(),
    spinnerRedraw(),
    splitSensitiveUtf8AndEscape()
  ];
}

function bytes(input: string): Uint8Array {
  return encoder.encode(input);
}

function syntheticBasics(): FixtureDefinition {
  const text = "\x1b[2J\x1b[Hkanna tui fidelity\r\nplain ascii baseline\r\n";
  return {
    name: "synthetic-basics",
    description: "Plain ASCII baseline with clear screen and home cursor.",
    bytes: bytes(text),
    snapshotAt: text.length
  };
}

function wideChars(): FixtureDefinition {
  const text =
    "\x1b[2J\x1b[Hwide: 漢字かなカナ\r\nemoji: 😀 🚀 👩‍💻 🧑🏽‍💻\r\nmix: A界B🙂C\r\n";
  return {
    name: "wide-chars-emoji",
    description: "CJK, emoji, skin tone, and ZWJ sequences.",
    bytes: bytes(text),
    snapshotAt: text.length
  };
}

function boxDrawing(): FixtureDefinition {
  const text = [
    "\x1b[2J\x1b[H┌──────────┬────────┐",
    "│ task     │ state  │",
    "├──────────┼────────┤",
    "│ claude   │ busy   │",
    "│ copilot  │ idle   │",
    "└──────────┴────────┘"
  ].join("\r\n");
  return {
    name: "box-drawing-table",
    description: "Unicode box drawing table.",
    bytes: bytes(`${text}\r\n`),
    snapshotAt: text.length
  };
}

function colorBlocks(): FixtureDefinition {
  const text = [
    "\x1b[2J\x1b[H256-color:",
    "\x1b[48;5;196m 196 \x1b[48;5;46m 046 \x1b[48;5;21m 021 \x1b[0m",
    "truecolor:",
    "\x1b[38;2;255;122;144mfg-rgb\x1b[0m \x1b[48;2;30;64;175m bg-rgb \x1b[0m"
  ].join("\r\n");
  return {
    name: "color-blocks",
    description: "256-color and 24-bit truecolor foreground/background blocks.",
    bytes: bytes(`${text}\r\n`),
    snapshotAt: text.length
  };
}

function altScreen(): FixtureDefinition {
  const text =
    "before alt\r\n\x1b[?1049h\x1b[2J\x1b[Hinside alt screen\r\n\x1b[3;10Hpositioned\x1b[?1049lafter alt\r\n";
  return {
    name: "alt-screen",
    description: "Alternate screen enter/exit with absolute positioning.",
    bytes: bytes(text),
    snapshotAt: text.length
  };
}

function scrollRegion(): FixtureDefinition {
  let text = "\x1b[2J\x1b[Htop fixed\r\n\x1b[3;8r\x1b[3;1H";
  for (let line = 1; line <= 10; line += 1) {
    text += `region line ${line}\r\n`;
  }
  text += "\x1b[r\x1b[10;1Hbottom after region\r\n";
  return {
    name: "scroll-region",
    description: "DECSTBM scroll region with overflowing content.",
    bytes: bytes(text),
    snapshotAt: text.length
  };
}

function cursorSaveRestore(): FixtureDefinition {
  const text = "\x1b[2J\x1b[Hstart\x1b7\x1b[5;20Hfar\x1b8 restored\r\n";
  return {
    name: "cursor-save-restore",
    description: "DECSC/DECRC cursor save and restore.",
    bytes: bytes(text),
    snapshotAt: text.length
  };
}

function spinnerRedraw(): FixtureDefinition {
  const text = "\x1b[2J\x1b[Hworking ⠁\rworking ⠂\rworking ⠄\rworking done\r\n";
  return {
    name: "spinner-redraw",
    description: "In-place carriage-return redraw loop.",
    bytes: bytes(text),
    snapshotAt: 0,
    allowFallback: true
  };
}

function splitSensitiveUtf8AndEscape(): FixtureDefinition {
  const text = "\x1b[2J\x1b[Hsplit utf8: 界😀\r\nsplit color: \x1b[38;2;1;2;3mRGB\x1b[0m\r\n";
  return {
    name: "split-sensitive",
    description: "Fixture replayed as live chunks to split UTF-8 and escape sequences.",
    bytes: bytes(text),
    snapshotAt: 0,
    allowFallback: true
  };
}
