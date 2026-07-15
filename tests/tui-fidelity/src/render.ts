import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import { ARTIFACT_DIR, PACKAGE_ROOT, REPO_ROOT } from "./paths.ts";
import type { EmitterOutput, GridSnapshot, TermSnapshotFrame } from "./types.ts";

interface MobileDocumentModule {
  buildTerminalDocument(options: {
    bottomInset: number;
    enableE2EInspection: boolean;
  }): string;
}

interface BrowserGridSnapshot {
  cols: number;
  rows: number;
  serialized: string;
  cells: GridSnapshot["cells"];
}

interface MobileScrollSample {
  elapsedMs: number;
  terminalViewportScrollTop: number;
  viewportY: number;
}

interface MobileEasedScrollResult {
  baseY: number;
  initialViewportY: number;
  requestedTarget: number | null;
  samples: MobileScrollSample[];
}

interface TerminalHookState {
  text?: string;
  chunksB64?: string[];
}

interface HarnessSessionState {
  taskTerminalOutput: string;
  taskTerminalCols: number | null;
  taskTerminalRows: number | null;
}

interface HarnessSessionStore {
  getState(): HarnessSessionState;
  beginTaskTerminal(taskId: string, initialOutput: string): void;
  appendTaskTerminal(taskId: string, chunk: string): void;
  setTaskTerminalDims(taskId: string, cols: number, rows: number): void;
}

interface SessionStoreModule {
  createSessionStore(): HarnessSessionStore;
}

const VIEWPORT = { width: 1900, height: 624 };
const MOBILE_SCROLL_COLS = 80;
const MOBILE_SCROLL_ROWS = 20;
const MOBILE_SCROLL_LINE_COUNT = 140;
const MOBILE_SCROLL_SAMPLE_DELAYS_MS = [8, 20, 36, 52, 68, 92, 128, 180];

export async function verifyMobileEasedScrolling(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    hasTouch: true
  });
  let page: Page | null = null;
  try {
    page = await context.newPage();
    const html = await buildInstrumentedMobileDocument();
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(() => typeof window.__replaceTerminalState === "function");
    const maxTouchPoints = await page.evaluate(() => navigator.maxTouchPoints);
    if (maxTouchPoints < 1) {
      throw new Error("mobile eased scrolling requires a touch-enabled browser context");
    }

    await page.evaluate(
      (dims) => {
        window.__setTerminalDims(dims);
      },
      { cols: MOBILE_SCROLL_COLS, rows: MOBILE_SCROLL_ROWS }
    );
    await page.waitForFunction(
      ({ cols, rows }) => {
        const term = window.__kannaTerminals[0];
        return term?.cols === cols && term.rows === rows;
      },
      { cols: MOBILE_SCROLL_COLS, rows: MOBILE_SCROLL_ROWS }
    );

    const numberedLines = Array.from(
      { length: MOBILE_SCROLL_LINE_COUNT },
      (_, index) => `mobile-scroll-line-${String(index + 1).padStart(3, "0")}`
    ).join("\r\n") + "\r\n";
    await callHook(page, "__replaceTerminalState", { text: numberedLines });

    await page.waitForFunction(() => {
      const buffer = window.__kannaTerminals[0]?.buffer.active;
      return Boolean(buffer && buffer.baseY > 0 && buffer.viewportY === buffer.baseY);
    });
    // Let xterm's render loop settle before installing the gesture probe.
    await page.waitForTimeout(120);
    await page.waitForFunction(() => {
      const buffer = window.__kannaTerminals[0]?.buffer.active;
      return Boolean(buffer && buffer.baseY > 0 && buffer.viewportY === buffer.baseY);
    });

    const result = await page.evaluate(
      async (sampleDelays): Promise<MobileEasedScrollResult> => {
        const term = window.__kannaTerminals[0];
        const screen = document.querySelector<HTMLElement>(".xterm-screen");
        const terminalViewport = document.querySelector<HTMLElement>(".xterm-viewport");
        if (!term || !screen || !terminalViewport) {
          throw new Error("mobile terminal gesture elements were not available");
        }

        const initialViewportY = term.buffer.active.viewportY;
        const baseY = term.buffer.active.baseY;
        const originalScrollToLine = term.scrollToLine.bind(term);
        window.__kannaScrollToLineTarget = undefined;
        term.scrollToLine = (line: number) => {
          window.__kannaScrollToLineTarget = line;
          originalScrollToLine(line);
        };

        const startTouch = {
          identifier: 1,
          target: screen,
          clientX: 220,
          clientY: 160,
          pageX: 220,
          pageY: 160,
          screenX: 220,
          screenY: 160,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1
        };
        const movedTouch = {
          identifier: 1,
          target: screen,
          clientX: 224,
          clientY: 340,
          pageX: 224,
          pageY: 340,
          screenX: 224,
          screenY: 340,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1
        };

        const touchStart = new Event("touchstart", { bubbles: true, cancelable: true });
        Object.defineProperties(touchStart, {
          touches: {
            configurable: true,
            value: Object.assign([startTouch], { item: Array.prototype.at })
          },
          targetTouches: {
            configurable: true,
            value: Object.assign([startTouch], { item: Array.prototype.at })
          },
          changedTouches: {
            configurable: true,
            value: Object.assign([startTouch], { item: Array.prototype.at })
          }
        });
        screen.dispatchEvent(touchStart);

        const startedAt = performance.now();
        const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
        Object.defineProperties(touchMove, {
          touches: {
            configurable: true,
            value: Object.assign([movedTouch], { item: Array.prototype.at })
          },
          targetTouches: {
            configurable: true,
            value: Object.assign([movedTouch], { item: Array.prototype.at })
          },
          changedTouches: {
            configurable: true,
            value: Object.assign([movedTouch], { item: Array.prototype.at })
          }
        });
        screen.dispatchEvent(touchMove);
        const samples: MobileScrollSample[] = [{
          elapsedMs: performance.now() - startedAt,
          terminalViewportScrollTop: terminalViewport.scrollTop,
          viewportY: term.buffer.active.viewportY
        }];

        const touchEnd = new Event("touchend", { bubbles: true, cancelable: true });
        Object.defineProperties(touchEnd, {
          touches: {
            configurable: true,
            value: Object.assign([], { item: Array.prototype.at })
          },
          targetTouches: {
            configurable: true,
            value: Object.assign([], { item: Array.prototype.at })
          },
          changedTouches: {
            configurable: true,
            value: Object.assign([movedTouch], { item: Array.prototype.at })
          }
        });
        screen.dispatchEvent(touchEnd);

        for (const delayMs of sampleDelays) {
          const remainingMs = Math.max(0, delayMs - (performance.now() - startedAt));
          await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs));
          samples.push({
            elapsedMs: performance.now() - startedAt,
            terminalViewportScrollTop: terminalViewport.scrollTop,
            viewportY: term.buffer.active.viewportY
          });
        }

        return {
          baseY,
          initialViewportY,
          requestedTarget: window.__kannaScrollToLineTarget ?? null,
          samples
        };
      },
      MOBILE_SCROLL_SAMPLE_DELAYS_MS
    );

    const trace = formatMobileEasedScrollResult(result);
    const target = result.requestedTarget;
    if (target === null) {
      throw new Error(`mobile eased scrolling recorded no public scrollToLine target (${trace})`);
    }
    if (!Number.isFinite(target) || !Number.isInteger(target)) {
      throw new Error(`mobile eased scrolling recorded a non-integer target (${trace})`);
    }
    if (target >= result.initialViewportY) {
      throw new Error(`mobile eased scrolling did not request an earlier buffer line (${trace})`);
    }

    const immediatePosition = result.samples[0]?.viewportY;
    if (immediatePosition === undefined) {
      throw new Error(`mobile eased scrolling produced no immediate position sample (${trace})`);
    }
    if (immediatePosition === target) {
      throw new Error(`mobile eased scrolling jumped directly to its requested target (${trace})`);
    }

    const finalPosition = result.samples.at(-1)?.viewportY;
    if (finalPosition === undefined) {
      throw new Error(`mobile eased scrolling produced no settled position sample (${trace})`);
    }
    const lowerBound = Math.min(result.initialViewportY, finalPosition);
    const upperBound = Math.max(result.initialViewportY, finalPosition);
    const hasIntermediatePosition = result.samples
      .slice(1, -1)
      .some(({ viewportY }) => viewportY > lowerBound && viewportY < upperBound);
    if (!hasIntermediatePosition) {
      throw new Error(`mobile eased scrolling produced no intermediate row transition (${trace})`);
    }
    if (Math.abs(finalPosition - target) > 1) {
      throw new Error(`mobile eased scrolling did not settle within one row of its target (${trace})`);
    }
    if (result.samples.some(({ terminalViewportScrollTop }) => terminalViewportScrollTop !== 0)) {
      throw new Error(`mobile eased scrolling mutated inert .xterm-viewport.scrollTop (${trace})`);
    }
  } finally {
    try {
      await page?.close();
    } finally {
      await context.close();
    }
  }
}

export async function renderPathGrid(browser: Browser, emitted: EmitterOutput): Promise<GridSnapshot> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    const html = await buildInstrumentedMobileDocument();
    await page.setContent(html, { waitUntil: "load" });
    await installSerializeAddon(page);
    await page.waitForFunction(() => typeof window.__replaceTerminalState === "function");

    for (const frame of emitted.frames) {
      if (frame.type === "term_snapshot") {
        await setTerminalDims(page, frame);
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

export async function renderSessionStorePathGrid(
  browser: Browser,
  emitted: EmitterOutput
): Promise<GridSnapshot> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    const html = await buildInstrumentedMobileDocument();
    await page.setContent(html, { waitUntil: "load" });
    await installSerializeAddon(page);
    await page.waitForFunction(() => typeof window.__replaceTerminalState === "function");

    const store = await createHarnessSessionStore();
    const taskId = emitted.frames[0]?.task_id ?? "tui-fidelity";
    store.beginTaskTerminal(taskId, "");
    for (const frame of emitted.frames) {
      if (frame.type === "term_snapshot") {
        store.setTaskTerminalDims(frame.task_id, frame.cols, frame.rows);
      }
      store.appendTaskTerminal(frame.task_id, `${frame.data_b64}\n`);
    }

    const state = store.getState();
    if (state.taskTerminalCols && state.taskTerminalRows) {
      await setTerminalDims(page, {
        type: "term_snapshot",
        task_id: taskId,
        cols: state.taskTerminalCols,
        rows: state.taskTerminalRows,
        data_b64: ""
      });
    }
    await callHook(page, "__replaceTerminalState", {
      chunksB64: terminalChunksFromOutput(state.taskTerminalOutput)
    });
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
  cols: number,
  rows: number
): Promise<GridSnapshot> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    await page.setContent(await buildReferenceDocument(cols, rows), { waitUntil: "load" });
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

export async function buildInstrumentedMobileDocument(
  bottomInset: number = 0
): Promise<string> {
  const moduleUrl = pathToFileURL(
    path.join(REPO_ROOT, "apps/mobile/src/screens/buildTerminalDocument.ts")
  ).href;
  const mod = (await import(moduleUrl)) as MobileDocumentModule;
  return mod
    .buildTerminalDocument({ bottomInset, enableE2EInspection: false })
    .replace("    <script>", `    <script>${terminalProbeScript()}</script>\n    <script>`);
}

async function createHarnessSessionStore(): Promise<HarnessSessionStore> {
  const moduleUrl = pathToFileURL(
    path.join(REPO_ROOT, "apps/mobile/src/state/sessionStore.ts")
  ).href;
  const mod = (await import(moduleUrl)) as SessionStoreModule;
  return mod.createSessionStore();
}

async function buildReferenceDocument(cols: number, rows: number): Promise<string> {
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
      cols: ${cols},
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

async function setTerminalDims(page: Page, frame: TermSnapshotFrame): Promise<void> {
  await page.evaluate((dims) => {
    window.__setTerminalDims(dims);
  }, { cols: frame.cols, rows: frame.rows });
  await page.waitForTimeout(20);
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

function terminalChunksFromOutput(output: string): string[] {
  return output
    .split("\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

export async function waitForWrites(page: Page): Promise<void> {
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

function formatMobileEasedScrollResult(result: MobileEasedScrollResult): string {
  const samples = result.samples
    .map(
      ({ elapsedMs, terminalViewportScrollTop, viewportY }) =>
        `${Math.round(elapsedMs)}ms:${viewportY}/dom=${terminalViewportScrollTop}`
    )
    .join(", ");
  return [
    `baseY=${result.baseY}`,
    `start=${result.initialViewportY}`,
    `target=${String(result.requestedTarget)}`,
    `samples=[${samples}]`
  ].join(", ");
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
    __setTerminalBottomInset: (state: { bottomInset: number }) => void;
    __setTerminalDims: (dims: { cols: number; rows: number }) => void;
    __kannaPendingWrites: number;
    __kannaScrollToLineTarget: number | undefined;
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
          viewportY: number;
          getLine: (row: number) =>
            | {
                translateToString: (trimRight?: boolean) => string;
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
      scrollToLine: (line: number) => void;
      write: (text: string | Uint8Array, callback?: () => void) => void;
    }>;
  }
}
