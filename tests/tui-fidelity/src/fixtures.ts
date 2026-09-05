import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE_DIR } from "./paths.ts";
import type { FixtureDefinition } from "./types.ts";

const encoder = new TextEncoder();

interface CapturedFixtureSpec {
  name: string;
  description: string;
  snapshotAt: number;
  resnapshotAt?: number;
  cols?: number;
  rows?: number;
  chunkPattern?: number[];
  allowFallback?: boolean;
}

export async function writeFixtures(): Promise<FixtureDefinition[]> {
  const fixtures = [
    ...buildSyntheticFixtures(),
    ...(await Promise.all(
      capturedFixtureSpecs().map((fixture) => loadCapturedFixture(FIXTURE_DIR, fixture))
    ))
  ];
  await mkdir(FIXTURE_DIR, { recursive: true });
  await Promise.all(
    fixtures.filter(isSyntheticFixture).map((fixture) =>
      writeFile(path.join(FIXTURE_DIR, `${fixture.name}.ansi`), fixture.bytes)
    )
  );
  return fixtures;
}

export async function loadCapturedFixture(
  fixtureDir: string,
  spec: CapturedFixtureSpec
): Promise<FixtureDefinition> {
  const bytes = await readFile(path.join(fixtureDir, `${spec.name}.ansi`));
  return {
    ...spec,
    bytes: new Uint8Array(bytes)
  };
}

function buildSyntheticFixtures(): FixtureDefinition[] {
  return [
    syntheticBasics(),
    wideChars(),
    boxDrawing(),
    colorBlocks(),
    attributeBlocks(),
    altScreen(),
    scrollRegion(),
    cursorSaveRestore(),
    spinnerRedraw(),
    splitSensitiveUtf8AndEscape(),
    bottomAnchoredNon220(),
    largeSnapshotThroughSessionStore(),
    statusRedrawAcrossCompaction()
  ];
}

function capturedFixtureSpecs(): CapturedFixtureSpec[] {
  return [
    {
      name: "codex-pwd-tool",
      description:
        "Captured Codex CLI TUI session with update notice, status/title spinner redraws, shell tool calls, and final settled answer.",
      snapshotAt: 4687
    },
    {
      name: "codex-live-20260905",
      description:
        "Current interactive Codex CLI TUI probe with three user turns, long and multiline input, blank lines, and settled formatted replies.",
      snapshotAt: 13000,
      resnapshotAt: 21200,
      cols: 120,
      rows: 36,
      chunkPattern: [4096]
    }
  ];
}

function isSyntheticFixture(fixture: FixtureDefinition): boolean {
  return !fixture.name.startsWith("codex-");
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

function attributeBlocks(): FixtureDefinition {
  const text = [
    "\x1b[2J\x1b[Hbold: \x1b[1mBOLD\x1b[22m dim: \x1b[2mDIM\x1b[22m inverse: \x1b[7mINVERSE\x1b[27m",
    "fg/bg: \x1b[38;2;255;122;144mRED-FG\x1b[39m \x1b[48;2;30;64;175mBLUE-BG\x1b[49m"
  ].join("\r\n");
  return {
    name: "attribute-blocks",
    description: "Bold, dim, inverse, foreground, and background attributes.",
    bytes: bytes(`${text}\r\n`),
    snapshotAt: text.length + 2
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

function bottomAnchoredNon220(): FixtureDefinition {
  const text = [
    "\x1b[2J\x1b[Hnon-220 PTY dimensions",
    "\x1b[12;1Hmiddle row marker",
    "\x1b[24;1HBOTTOM-ANCHORED-80x24"
  ].join("");
  return {
    name: "bottom-anchored-80x24",
    description:
      "80x24 PTY with bottom-anchored UI; catches mobile renders that ignore snapshot rows/cols.",
    bytes: bytes(text),
    snapshotAt: text.length,
    cols: 80,
    rows: 24
  };
}

function largeSnapshotThroughSessionStore(): FixtureDefinition {
  const rows = 72;
  const snapshotLines: string[] = ["\x1b[2J\x1b[Hlarge snapshot through sessionStore"];
  for (let row = 2; row <= rows; row += 1) {
    const fill = `${String(row).padStart(2, "0")} session-store snapshot frame `.padEnd(
      170,
      "."
    );
    snapshotLines.push(`\x1b[${row};1H${fill}`);
  }
  const snapshot = snapshotLines.join("");
  const liveOutput = "\x1b[72;1HLIVE-APPEND-CORRECT";
  return {
    name: "large-session-store-snapshot",
    description:
      "Large snapshot plus live output replayed through sessionStore accumulation before mobile render.",
    bytes: bytes(`${snapshot}${liveOutput}`),
    snapshotAt: snapshot.length,
    cols: 220,
    rows,
    replayThroughSessionStore: true
  };
}

function statusRedrawAcrossCompaction(): FixtureDefinition {
  const cols = 80;
  const rows = 24;
  const initial = [
    "\x1b[2J\x1b[HAgent response remains stable",
    "\x1b[24;1H\x1b[2KWorking (0s - esc to interrupt)"
  ].join("");
  const updates = Array.from({ length: 230 }, (_value, index) => {
    const seconds = index + 1;
    // The title update is intentionally large but grid-neutral. Its KSP/base64
    // representation pushes the real sessionStore across the 1 MB cap while
    // the visible status line behaves like Codex's rapid timer redraw.
    return `\x1b[24;1H\x1b[2KWorking (${seconds}s - esc to interrupt)\x1b]0;${"x".repeat(3600)}\x07`;
  });
  const snapshotAt = encoder.encode(initial).length;
  const beforeReconnect = updates.slice(0, 220).join("");
  const text = `${initial}${updates.join("")}`;

  return {
    name: "status-redraw-stream-compaction",
    description:
      "Codex-like working timer crosses the mobile retained-history cap, then receives an authoritative reconnect snapshot.",
    bytes: bytes(text),
    snapshotAt,
    resnapshotAt: snapshotAt + encoder.encode(beforeReconnect).length,
    chunkPattern: [4096],
    cols,
    rows,
    replayThroughSessionStore: true,
    assertStreamCompaction: true
  };
}
