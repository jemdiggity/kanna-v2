import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import { ARTIFACT_DIR, PACKAGE_ROOT, REPO_ROOT } from "./paths.ts";
import type { EmitterOutput, GridSnapshot, TerminalFrame } from "./types.ts";

interface MobileDocumentModule {
  buildTerminalDocument(options: { bottomInset: number }): string;
}

interface BrowserGridSnapshot {
  cols: number;
  rows: number;
  serialized: string;
  cells: GridSnapshot["cells"];
}

interface TerminalHookState {
  text?: string;
  chunksB64?: string[];
}

const VIEWPORT = { width: 1900, height: 624 };

export async function renderPathGrid(browser: Browser, emitted: EmitterOutput): Promise<GridSnapshot> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    const html = await buildInstrumentedMobileDocument();
    await page.setContent(html, { waitUntil: "load" });
    await installSerializeAddon(page);
    await page.waitForFunction(() => typeof window.__replaceTerminalState === "function");

    for (const frame of emitted.frames) {
      if (frame.type === "term_snapshot") {
        await callHook(page, "__replaceTerminalState", { chunksB64: [frame.data_b64] });
      } else {
        await callHook(page, "__appendTerminalChunk", { chunksB64: [frame.data_b64] });
      }
    }
    await waitForWrites(page);
    return await extractGrid(page);
  } finally {
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, `${path.basename(emitted.fixture, ".ansi")}.path.png`),
      fullPage: true
    });
    await page.close();
  }
}

export async function renderReferenceGrid(
  browser: Browser,
  name: string,
  bytes: Uint8Array,
  rows: number
): Promise<GridSnapshot> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    await page.setContent(await buildReferenceDocument(rows), { waitUntil: "load" });
    await installSerializeAddon(page);
    await page.waitForFunction(() => window.__kannaTerminals.length > 0);
    await callReferenceWrite(page, new TextDecoder().decode(bytes));
    await waitForWrites(page);
    return await extractGrid(page);
  } finally {
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, `${name}.reference.png`),
      fullPage: true
    });
    await page.close();
  }
}

async function buildInstrumentedMobileDocument(): Promise<string> {
  const moduleUrl = pathToFileURL(
    path.join(REPO_ROOT, "apps/mobile/src/screens/buildTerminalDocument.ts")
  ).href;
  const mod = (await import(moduleUrl)) as MobileDocumentModule;
  return mod
    .buildTerminalDocument({ bottomInset: 0 })
    .replace("    <script>", `    <script>${terminalProbeScript()}</script>\n    <script>`);
}

async function buildReferenceDocument(rows: number): Promise<string> {
  const xtermScript = await readPackageFile("@xterm/xterm/lib/xterm.js");
  const xtermCss = await readPackageFile("@xterm/xterm/css/xterm.css");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    ${xtermCss}
    html, body { margin: 0; height: 100%; background: #09111d; }
    #terminal-root { height: 100%; width: 1760px; }
  </style>
</head>
<body>
  <div id="terminal-root"></div>
  <script>${terminalProbeScript()}</script>
  <script>${xtermScript}</script>
  <script>
    const term = new Terminal({
      cols: 220,
      rows: ${rows},
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1,
      letterSpacing: 0,
      cursorBlink: false,
      scrollback: 10000,
      vtExtensions: { kittyKeyboard: true },
      theme: {
        background: "#09111d",
        foreground: "#dfe9f7",
        cursor: "#7dd3fc"
      }
    });
    term.open(document.getElementById("terminal-root"));
  </script>
</body>
</html>`;
}

async function installSerializeAddon(page: Page): Promise<void> {
  const serializeScript = await readPackageFile("@xterm/addon-serialize/lib/addon-serialize.js");
  await page.addScriptTag({ content: serializeScript });
  await page.evaluate(() => {
    const addon = new window.SerializeAddon.SerializeAddon();
    window.__kannaTerminals[0].loadAddon(addon);
    window.__kannaSerializeAddon = addon;
  });
}

async function callHook(
  page: Page,
  hook: "__replaceTerminalState" | "__appendTerminalChunk",
  state: TerminalHookState
): Promise<void> {
  if (!state.text && (!state.chunksB64 || state.chunksB64.length === 0)) {
    return;
  }
  await page.evaluate(
    ({ hookName, value }: { hookName: typeof hook; value: TerminalHookState }) => {
      window[hookName](value);
    },
    { hookName: hook, value: state }
  );
  await waitForWrites(page);
}

async function callReferenceWrite(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    window.__kannaTerminals[0].write(value);
  }, text);
}

async function waitForWrites(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__kannaPendingWrites === 0, undefined, {
    timeout: 5000
  });
  await page.waitForTimeout(20);
}

async function extractGrid(page: Page): Promise<GridSnapshot> {
  const grid = await page.evaluate((): BrowserGridSnapshot => {
    const term = window.__kannaTerminals[0];
    const buffer = term.buffer.active;
    const cells: BrowserGridSnapshot["cells"] = [];
    for (let row = 0; row < term.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row);
      for (let col = 0; col < term.cols; col += 1) {
        const cell = line?.getCell(col);
        cells.push({
          row,
          col,
          chars: cell?.getChars() ?? "",
          width: cell?.getWidth() ?? 1,
          fg: window.__kannaColorValue(cell, "fg"),
          bg: window.__kannaColorValue(cell, "bg"),
          flags: window.__kannaFlagValue(cell)
        });
      }
    }
    return {
      cols: term.cols,
      rows: term.rows,
      serialized: window.__kannaSerializeAddon.serialize(),
      cells
    };
  });
  return grid;
}

async function readPackageFile(packagePath: string): Promise<string> {
  return await readFile(path.join(PACKAGE_ROOT, "node_modules", packagePath), "utf8");
}

function terminalProbeScript(): string {
  return `
    window.__kannaTerminals = [];
    window.__kannaPendingWrites = 0;
    (function installTerminalProbe() {
      let actualTerminal = undefined;
      Object.defineProperty(window, "Terminal", {
        configurable: true,
        get() {
          return actualTerminal;
        },
        set(value) {
          function WrappedTerminal(...args) {
            const term = new value(...args);
            const originalWrite = term.write.bind(term);
            term.write = function patchedWrite(data, callback) {
              window.__kannaPendingWrites += 1;
              return originalWrite(data, function patchedCallback() {
                try {
                  if (callback) {
                    callback();
                  }
                } finally {
                  window.__kannaPendingWrites -= 1;
                }
              });
            };
            window.__kannaTerminals.push(term);
            return term;
          }
          Object.setPrototypeOf(WrappedTerminal, value);
          WrappedTerminal.prototype = value.prototype;
          actualTerminal = WrappedTerminal;
        }
      });
    })();

    window.__kannaColorValue = function colorValue(cell, kind) {
      if (!cell) {
        return 0;
      }
      const mode = kind === "fg" ? cell.getFgColorMode() : cell.getBgColorMode();
      const color = kind === "fg" ? cell.getFgColor() : cell.getBgColor();
      return mode * 100000000 + color;
    };

    window.__kannaFlagValue = function flagValue(cell) {
      if (!cell) {
        return 0;
      }
      let flags = 0;
      if (cell.isBold()) flags |= 1;
      if (cell.isItalic()) flags |= 2;
      if (cell.isDim()) flags |= 4;
      if (cell.isUnderline()) flags |= 8;
      if (cell.isBlink()) flags |= 16;
      if (cell.isInverse()) flags |= 32;
      if (cell.isInvisible()) flags |= 64;
      if (cell.isStrikethrough()) flags |= 128;
      if (cell.isOverline()) flags |= 256;
      return flags;
    };
  `;
}

declare global {
  interface Window {
    SerializeAddon: {
      SerializeAddon: new () => { serialize: () => string };
    };
    __appendTerminalChunk: (state: TerminalHookState) => void;
    __replaceTerminalState: (state: TerminalHookState) => void;
    __kannaPendingWrites: number;
    __kannaSerializeAddon: { serialize: () => string };
    __kannaColorValue: (
      cell:
        | {
            getFgColorMode: () => number;
            getBgColorMode: () => number;
            getFgColor: () => number;
            getBgColor: () => number;
          }
        | undefined,
      kind: "fg" | "bg"
    ) => number;
    __kannaFlagValue: (
      cell:
        | {
            isBold: () => boolean;
            isItalic: () => boolean;
            isDim: () => boolean;
            isUnderline: () => boolean;
            isBlink: () => boolean;
            isInverse: () => boolean;
            isInvisible: () => boolean;
            isStrikethrough: () => boolean;
            isOverline: () => boolean;
          }
        | undefined
    ) => number;
    __kannaTerminals: Array<{
      cols: number;
      rows: number;
      buffer: {
        active: {
          baseY: number;
          getLine: (row: number) =>
            | {
                getCell: (col: number) =>
                  | {
                      getChars: () => string;
                      getWidth: () => number;
                      getFgColorMode: () => number;
                      getBgColorMode: () => number;
                      getFgColor: () => number;
                      getBgColor: () => number;
                      isBold: () => boolean;
                      isItalic: () => boolean;
                      isDim: () => boolean;
                      isUnderline: () => boolean;
                      isBlink: () => boolean;
                      isInverse: () => boolean;
                      isInvisible: () => boolean;
                      isStrikethrough: () => boolean;
                      isOverline: () => boolean;
                    }
                  | undefined;
              }
            | undefined;
        };
      };
      loadAddon: (addon: { serialize: () => string }) => void;
      write: (text: string, callback?: () => void) => void;
    }>;
  }
}
