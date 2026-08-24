import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import { ARTIFACT_DIR, PACKAGE_ROOT, REPO_ROOT } from "./paths.ts";
import type {
  EmitterOutput,
  GridSnapshot,
  SessionStoreRenderResult,
  TermSnapshotFrame
} from "./types.ts";

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

interface MobileSelectionResult {
  doubleTapFileLinkMessages: number;
  initialSelection: string;
  extendedSelection: string;
  singleTapFileLinkMessages: number;
  scrollTargetsDuringSelection: number[];
  viewportYBeforeSelectionDrag: number;
  viewportYAfterSelectionDrag: number;
  viewportYBeforeOrdinaryDrag: number;
  viewportYAfterOrdinaryDrag: number;
}

interface TerminalHookState {
  contentRevision?: number;
  text?: string;
  chunksB64?: string[];
}

interface HarnessTerminalOutputBuffer {
  scrollbackSegments: readonly string[];
  snapshot: string;
  liveSegments: readonly string[];
}

type HarnessTerminalOutput = string | HarnessTerminalOutputBuffer;

interface HarnessSessionState {
  taskTerminalOutput: HarnessTerminalOutput;
  taskTerminalOutputEpoch: number;
  taskTerminalOutputStart: number;
  taskTerminalCols: number | null;
  taskTerminalRows: number | null;
  taskTerminalStatus: "idle" | "connecting" | "live" | "closed" | "error";
}

interface HarnessSessionStore {
  getState(): HarnessSessionState;
  beginTaskTerminal(taskId: string, initialOutput: string): void;
  appendTaskTerminal(taskId: string, chunk: string): void;
  replaceTaskTerminalSnapshot(taskId: string, dataB64: string, cols: number, rows: number): void;
}

interface SessionStoreModule {
  createSessionStore(): HarnessSessionStore;
}

type HarnessTerminalMutation =
  | { kind: "none" }
  | { kind: "append"; chunk: string }
  | {
      kind: "replace";
      output: HarnessTerminalOutput;
      status: HarnessSessionState["taskTerminalStatus"];
    };

interface TerminalMutationModule {
  planTerminalMutation(options: {
    previousEpoch: number;
    previousOutput: HarnessTerminalOutput;
    previousStart: number;
    previousStatus: HarnessSessionState["taskTerminalStatus"];
    nextEpoch: number;
    nextOutput: HarnessTerminalOutput;
    nextStart: number;
    nextStatus: HarnessSessionState["taskTerminalStatus"];
  }): HarnessTerminalMutation;
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

interface MobileAltScreenScrollResult {
  altScreenActive: boolean;
  mouseTrackingDragUpPayload: string;
  mouseTrackingDragDownPayload: string;
  arrowFallbackPayload: string;
  altScrollToLineTargets: number[];
  altViewportYBefore: number;
  altViewportYAfter: number;
  normalBufferAfterExit: boolean;
  normalBufferPayload: string;
  normalScrollToLineTargets: number[];
  normalViewportYBefore: number;
  normalViewportYAfter: number;
}

/**
 * Regression coverage for Claude-style fullscreen TUIs: the real bundled
 * xterm runtime, in a touch-enabled Chromium context, must convert vertical
 * drags on the alternate screen buffer into PTY input posted over the
 * ReactNativeWebView bridge — SGR wheel reports while the TUI's negotiated
 * mouse tracking is active, arrow-key fallback once it is not — while
 * normal-buffer drags keep scrolling local scrollback without emitting any
 * bridge input.
 */
export async function verifyMobileAltScreenScrollInput(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    hasTouch: true
  });
  let page: Page | null = null;
  try {
    page = await context.newPage();
    await page.setContent(await buildInstrumentedMobileDocument(), { waitUntil: "load" });
    await page.waitForFunction(() => typeof window.__replaceTerminalState === "function");
    await page.evaluate((dims) => window.__setTerminalDims(dims), {
      cols: MOBILE_SCROLL_COLS,
      rows: MOBILE_SCROLL_ROWS
    });
    await page.waitForFunction(
      ({ cols, rows }) => {
        const term = window.__kannaTerminals[0];
        return term?.cols === cols && term.rows === rows;
      },
      { cols: MOBILE_SCROLL_COLS, rows: MOBILE_SCROLL_ROWS }
    );

    // Seed real normal-buffer scrollback first so the post-exit phase can
    // prove local scrollback scrolling still works.
    const scrollbackLines = Array.from(
      { length: MOBILE_SCROLL_LINE_COUNT },
      (_, index) => `alt-scroll-history-${String(index + 1).padStart(3, "0")}`
    ).join("\r\n") + "\r\n";
    await callHook(page, "__replaceTerminalState", { text: scrollbackLines });
    await page.waitForTimeout(120);

    // Enter the alternate screen exactly like Claude Code's fullscreen TUI:
    // alt buffer plus button-event mouse tracking with SGR encoding.
    const altScreenEntry =
      "\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[H" +
      Array.from({ length: MOBILE_SCROLL_ROWS - 1 }, (_, index) => `ALT ROW ${index + 1}`).join("\r\n");
    await callHook(page, "__appendTerminalChunk", {
      chunksB64: [Buffer.from(altScreenEntry, "latin1").toString("base64")]
    });
    await page.waitForFunction(
      () => window.__kannaTerminals[0]?.buffer.active.type === "alternate"
    );
    await page.addScriptTag({
      content: "globalThis.__name = (target) => target;"
    });

    const result = await page.evaluate(async (): Promise<MobileAltScreenScrollResult> => {
      const term = window.__kannaTerminals[0];
      const screen = document.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !screen) {
        throw new Error("mobile alt-screen gesture elements were not available");
      }
      const terminalScreen = screen;

      function touchAt(clientX: number, clientY: number) {
        return {
          identifier: 1,
          target: terminalScreen,
          clientX,
          clientY,
          pageX: clientX,
          pageY: clientY,
          screenX: clientX,
          screenY: clientY,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1
        };
      }

      function dispatchTouch(
        type: "touchstart" | "touchmove" | "touchend",
        touches: ReturnType<typeof touchAt>[],
        changedTouches: ReturnType<typeof touchAt>[] = touches
      ) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: {
            configurable: true,
            value: Object.assign(touches, { item: Array.prototype.at })
          },
          targetTouches: {
            configurable: true,
            value: Object.assign(touches, { item: Array.prototype.at })
          },
          changedTouches: {
            configurable: true,
            value: Object.assign(changedTouches, { item: Array.prototype.at })
          }
        });
        terminalScreen.dispatchEvent(event);
      }

      function drag(fromY: number, toY: number, clientX: number) {
        const start = touchAt(clientX, fromY);
        const end = touchAt(clientX, toY);
        dispatchTouch("touchstart", [start]);
        dispatchTouch("touchmove", [end]);
        dispatchTouch("touchend", [], [end]);
      }

      function collectBridgeInput(): string {
        const payload = window.__kannaBridgeMessages
          .map((message) => JSON.parse(message) as { type?: string; dataB64?: string })
          .filter((message) => message.type === "terminal-input")
          .map((message) => atob(message.dataB64 ?? ""))
          .join("");
        window.__kannaBridgeMessages.length = 0;
        return payload;
      }

      async function writeTerminal(data: string): Promise<void> {
        await new Promise<void>((resolve) => term.write(data, resolve));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
      }

      const buffer = term.buffer.active;
      const rect = terminalScreen.getBoundingClientRect();
      const cellHeight = rect.height / term.rows;
      const dragPx = 3 * cellHeight + 2;
      const clientX = Math.round(rect.left + 200);
      const startY = Math.round(rect.top + cellHeight * 12);

      const altScrollToLineTargets: number[] = [];
      const originalScrollToLine = term.scrollToLine.bind(term);
      term.scrollToLine = (line: number) => {
        altScrollToLineTargets.push(line);
        originalScrollToLine(line);
      };

      const altScreenActive = buffer.type === "alternate";
      const altViewportYBefore = buffer.viewportY;
      window.__kannaBridgeMessages.length = 0;

      drag(startY, startY - dragPx, clientX);
      const mouseTrackingDragUpPayload = collectBridgeInput();

      drag(startY - dragPx, startY, clientX);
      const mouseTrackingDragDownPayload = collectBridgeInput();

      // The TUI turns mouse tracking off: desktop parity is xterm's built-in
      // wheel-to-arrow-key fallback for alternate-screen apps.
      await writeTerminal("\x1b[?1002l\x1b[?1006l");
      drag(startY, startY - dragPx, clientX);
      const arrowFallbackPayload = collectBridgeInput();
      const altViewportYAfter = buffer.viewportY;
      const altScrollTargets = [...altScrollToLineTargets];

      // Leave the alternate screen: drags must return to local scrollback
      // scrolling with no bridge input. The viewport sits at the scrollback
      // bottom, so drag downward to scroll up into history, then let the
      // 80ms smooth scroll settle before sampling the viewport.
      await writeTerminal("\x1b[?1049l");
      const normalBufferAfterExit = term.buffer.active.type === "normal";
      altScrollToLineTargets.length = 0;
      const normalViewportYBefore = term.buffer.active.viewportY;
      window.__kannaBridgeMessages.length = 0;
      drag(startY, startY + dragPx, clientX);
      const normalBufferPayload = collectBridgeInput();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 220));
      term.scrollToLine = originalScrollToLine;

      return {
        altScreenActive,
        mouseTrackingDragUpPayload,
        mouseTrackingDragDownPayload,
        arrowFallbackPayload,
        altScrollToLineTargets: altScrollTargets,
        altViewportYBefore,
        altViewportYAfter,
        normalBufferAfterExit,
        normalBufferPayload,
        normalScrollToLineTargets: [...altScrollToLineTargets],
        normalViewportYBefore,
        normalViewportYAfter: term.buffer.active.viewportY
      };
    });

    if (!result.altScreenActive) {
      throw new Error("mobile alt-screen scroll fixture did not enter the alternate buffer");
    }
    assertRepeatedMouseWheelReports(
      "mobile alt-screen drag up",
      result.mouseTrackingDragUpPayload,
      65,
      3
    );
    assertRepeatedMouseWheelReports(
      "mobile alt-screen drag down",
      result.mouseTrackingDragDownPayload,
      64,
      3
    );
    if (result.arrowFallbackPayload !== "\x1b[B".repeat(3)) {
      throw new Error(
        "mobile alt-screen drag without mouse tracking did not emit 3 arrow-key fallbacks " +
        `(${JSON.stringify(result.arrowFallbackPayload)})`
      );
    }
    if (result.altScrollToLineTargets.length !== 0) {
      throw new Error(
        "mobile alt-screen drags requested scrollback targets " +
        JSON.stringify(result.altScrollToLineTargets)
      );
    }
    if (result.altViewportYAfter !== result.altViewportYBefore) {
      throw new Error(
        `mobile alt-screen drags moved the xterm viewport ` +
        `(${result.altViewportYBefore} -> ${result.altViewportYAfter})`
      );
    }
    if (!result.normalBufferAfterExit) {
      throw new Error("mobile terminal did not return to the normal buffer after ?1049l");
    }
    if (result.normalBufferPayload !== "") {
      throw new Error(
        "mobile normal-buffer drag leaked bridge input " +
        JSON.stringify(result.normalBufferPayload)
      );
    }
    if (result.normalScrollToLineTargets.length === 0) {
      throw new Error("mobile normal-buffer drag after alt-screen exit did not scroll scrollback");
    }
    if (result.normalViewportYAfter === result.normalViewportYBefore) {
      throw new Error(
        `mobile normal-buffer drag did not move the xterm viewport ` +
        `(stuck at ${result.normalViewportYBefore})`
      );
    }
  } finally {
    try {
      await page?.close();
    } finally {
      await context.close();
    }
  }
}

function assertRepeatedMouseWheelReports(
  label: string,
  payload: string,
  buttonCode: 64 | 65,
  expectedCount: number
): void {
  const reportPattern = new RegExp(`^\\x1b\\[<${buttonCode};(\\d+);(\\d+)M`);
  const first = reportPattern.exec(payload);
  if (!first) {
    throw new Error(`${label} did not emit SGR wheel reports (${JSON.stringify(payload)})`);
  }
  const report = first[0];
  if (payload !== report.repeat(expectedCount)) {
    throw new Error(
      `${label} expected ${expectedCount} identical ${JSON.stringify(report)} reports, ` +
      `got ${JSON.stringify(payload)}`
    );
  }
  const col = Number.parseInt(first[1], 10);
  const row = Number.parseInt(first[2], 10);
  if (col < 1 || col > MOBILE_SCROLL_COLS || row < 1 || row > MOBILE_SCROLL_ROWS) {
    throw new Error(`${label} reported out-of-bounds coordinates (${col};${row})`);
  }
}

export async function verifyMobileTerminalSelection(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    hasTouch: true
  });
  let page: Page | null = null;
  try {
    page = await context.newPage();
    await page.setContent(await buildInstrumentedMobileDocument(), { waitUntil: "load" });
    await page.waitForFunction(() => typeof window.__replaceTerminalState === "function");
    await page.evaluate((dims) => window.__setTerminalDims(dims), {
      cols: MOBILE_SCROLL_COLS,
      rows: MOBILE_SCROLL_ROWS
    });

    const lines = [
      ...Array.from({ length: 60 }, (_, index) => `selection-scroll-${index + 1}`),
      "alpha docs/selected.md omega",
      ...Array.from({ length: 18 }, (_, index) => `selection-tail-${index + 1}`)
    ].join("\r\n") + "\r\n";
    await callHook(page, "__replaceTerminalState", { text: lines });
    await page.waitForTimeout(120);
    await page.addScriptTag({
      content: "globalThis.__name = (target) => target;"
    });

    const result = await page.evaluate(async (): Promise<MobileSelectionResult> => {
      const term = window.__kannaTerminals[0];
      const screen = document.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !screen) {
        throw new Error("mobile terminal selection elements were not available");
      }
      const terminalScreen = screen;

      function touchAt(clientX: number, clientY: number) {
        return {
          identifier: 1,
          target: terminalScreen,
          clientX,
          clientY,
          pageX: clientX,
          pageY: clientY,
          screenX: clientX,
          screenY: clientY,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1
        };
      }

      function dispatchTouch(
        type: "touchstart" | "touchmove" | "touchend",
        touches: ReturnType<typeof touchAt>[],
        changedTouches: ReturnType<typeof touchAt>[] = touches
      ) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: {
            configurable: true,
            value: Object.assign(touches, { item: Array.prototype.at })
          },
          targetTouches: {
            configurable: true,
            value: Object.assign(touches, { item: Array.prototype.at })
          },
          changedTouches: {
            configurable: true,
            value: Object.assign(changedTouches, { item: Array.prototype.at })
          }
        });
        terminalScreen.dispatchEvent(event);
      }

      async function tap(clientX: number, clientY: number) {
        const touch = touchAt(clientX, clientY);
        dispatchTouch("touchstart", [touch]);
        dispatchTouch("touchend", [], [touch]);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
      }

      const buffer = term.buffer.active;
      let targetRow = -1;
      for (let row = 0; row <= buffer.baseY + term.rows; row += 1) {
        if (
          buffer.getLine(row)?.translateToString(true) ===
          "alpha docs/selected.md omega"
        ) {
          targetRow = row;
          break;
        }
      }
      if (targetRow < 0) {
        throw new Error("selection fixture row was not rendered");
      }
      term.scrollToLine(Math.max(0, targetRow - 8));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));

      const rect = terminalScreen.getBoundingClientRect();
      const cellWidth = rect.width / term.cols;
      const cellHeight = rect.height / term.rows;
      const visibleRow = targetRow - buffer.viewportY;
      const selectedX = rect.left + cellWidth * 10.5;
      const omegaX = rect.left + cellWidth * 27.5;
      const lineY = rect.top + cellHeight * (visibleRow + 0.5);

      const provider = window.__kannaTerminalLinkProviders[0];
      if (!provider) {
        throw new Error("selection fixture terminal link provider was not registered");
      }
      const links = await new Promise<Window["__kannaTerminalLinks"]>((resolve) => {
        provider.provideLinks(targetRow + 1, resolve);
      });
      const markdownLink = links?.find((link) => link.text === "docs/selected.md");
      if (!markdownLink) {
        throw new Error("selection fixture Markdown link was not registered");
      }

      window.__kannaBridgeMessages.length = 0;
      await tap(selectedX, lineY);
      markdownLink.activate();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 320));
      const singleTapFileLinkMessages = window.__kannaBridgeMessages.filter(
        (message) => JSON.parse(message).type === "terminal-file-link"
      ).length;

      window.__kannaBridgeMessages.length = 0;
      await tap(selectedX, lineY);
      markdownLink.activate();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      await tap(selectedX, lineY);
      markdownLink.activate();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 320));
      const initialSelection = term.getSelection();
      const doubleTapFileLinkMessages = window.__kannaBridgeMessages.filter(
        (message) => JSON.parse(message).type === "terminal-file-link"
      ).length;

      const originalScrollToLine = term.scrollToLine.bind(term);
      const scrollTargetsDuringSelection: number[] = [];
      term.scrollToLine = (line: number) => {
        scrollTargetsDuringSelection.push(line);
        originalScrollToLine(line);
      };
      const viewportYBeforeSelectionDrag = buffer.viewportY;
      const selectionStart = touchAt(selectedX, lineY);
      const selectionEnd = touchAt(omegaX, lineY);
      dispatchTouch("touchstart", [selectionStart]);
      dispatchTouch("touchmove", [selectionEnd]);
      dispatchTouch("touchend", [], [selectionEnd]);
      const extendedSelection = term.getSelection();
      const viewportYAfterSelectionDrag = buffer.viewportY;
      const selectionScrollTargets = [...scrollTargetsDuringSelection];
      term.scrollToLine = originalScrollToLine;

      window.__clearTerminalSelection();
      const viewportYBeforeOrdinaryDrag = buffer.viewportY;
      const ordinaryStart = touchAt(rect.left + 220, rect.top + 160);
      const ordinaryEnd = touchAt(rect.left + 224, rect.top + 340);
      dispatchTouch("touchstart", [ordinaryStart]);
      dispatchTouch("touchmove", [ordinaryEnd]);
      dispatchTouch("touchend", [], [ordinaryEnd]);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 140));

      return {
        doubleTapFileLinkMessages,
        initialSelection,
        extendedSelection,
        singleTapFileLinkMessages,
        scrollTargetsDuringSelection: selectionScrollTargets,
        viewportYBeforeSelectionDrag,
        viewportYAfterSelectionDrag,
        viewportYBeforeOrdinaryDrag,
        viewportYAfterOrdinaryDrag: buffer.viewportY
      };
    });

    if (result.singleTapFileLinkMessages !== 1) {
      throw new Error(
        `mobile single tap emitted ${result.singleTapFileLinkMessages} terminal file links`
      );
    }
    if (result.doubleTapFileLinkMessages !== 0) {
      throw new Error(
        `mobile double tap emitted ${result.doubleTapFileLinkMessages} terminal file links`
      );
    }
    if (result.initialSelection !== "docs/selected.md") {
      throw new Error(
        `mobile selection chose ${JSON.stringify(result.initialSelection)}`
      );
    }
    if (!result.extendedSelection.includes("docs/selected.md omega")) {
      throw new Error(
        `mobile selection did not extend (${JSON.stringify(result.extendedSelection)})`
      );
    }
    if (result.scrollTargetsDuringSelection.length !== 0) {
      throw new Error(
        `mobile selection drag requested scroll targets ` +
        `${JSON.stringify(result.scrollTargetsDuringSelection)} ` +
        `(viewport ${result.viewportYBeforeSelectionDrag} -> ` +
        `${result.viewportYAfterSelectionDrag})`
      );
    }
    if (result.viewportYAfterOrdinaryDrag === result.viewportYBeforeOrdinaryDrag) {
      throw new Error("ordinary terminal drag stopped scrolling after selection clear");
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
): Promise<SessionStoreRenderResult> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    const html = await buildInstrumentedMobileDocument();
    await page.setContent(html, { waitUntil: "load" });
    await installSerializeAddon(page);
    await page.waitForFunction(() => typeof window.__replaceTerminalState === "function");

    const store = await createHarnessSessionStore();
    const planTerminalMutation = await loadTerminalMutationPlanner();
    const taskId = emitted.frames[0]?.task_id ?? "tui-fidelity";
    store.beginTaskTerminal(taskId, "");
    let renderedState = store.getState();
    const metrics = {
      appendCount: 0,
      maxRetainedStart: 0,
      replaceCount: 0,
      snapshotCount: 0
    };
    for (const frame of emitted.frames) {
      if (frame.type === "term_snapshot") {
        metrics.snapshotCount += 1;
        store.replaceTaskTerminalSnapshot(
          frame.task_id,
          frame.data_b64,
          frame.cols,
          frame.rows
        );
        await setTerminalDims(page, frame);
      } else {
        store.appendTaskTerminal(frame.task_id, `${frame.data_b64}\n`);
      }

      const nextState = store.getState();
      metrics.maxRetainedStart = Math.max(
        metrics.maxRetainedStart,
        nextState.taskTerminalOutputStart
      );
      const mutation = planTerminalMutation({
        previousEpoch: renderedState.taskTerminalOutputEpoch,
        previousOutput: renderedState.taskTerminalOutput,
        previousStart: renderedState.taskTerminalOutputStart,
        previousStatus: renderedState.taskTerminalStatus,
        nextEpoch: nextState.taskTerminalOutputEpoch,
        nextOutput: nextState.taskTerminalOutput,
        nextStart: nextState.taskTerminalOutputStart,
        nextStatus: nextState.taskTerminalStatus
      });
      if (mutation.kind === "replace") {
        metrics.replaceCount += 1;
        await callHook(page, "__replaceTerminalState", {
          chunksB64: terminalChunksFromOutput(mutation.output)
        });
      } else if (mutation.kind === "append") {
        metrics.appendCount += 1;
        await callHook(page, "__appendTerminalChunk", {
          chunksB64: terminalChunksFromOutput(mutation.chunk)
        });
      }
      renderedState = nextState;
    }

    await waitForWrites(page);
    return { grid: await extractGrid(page), metrics };
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

async function loadTerminalMutationPlanner(): Promise<
  TerminalMutationModule["planTerminalMutation"]
> {
  const moduleUrl = pathToFileURL(
    path.join(REPO_ROOT, "apps/mobile/src/screens/terminalMutation.ts")
  ).href;
  const mod = (await import(moduleUrl)) as TerminalMutationModule;
  return mod.planTerminalMutation;
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

function terminalChunksFromOutput(output: HarnessTerminalOutput): string[] {
  const segments =
    typeof output === "string"
      ? [output]
      : [
          ...output.scrollbackSegments,
          output.snapshot,
          ...output.liveSegments
        ];
  return segments.flatMap((segment) =>
    segment
      .split("\n")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0)
  );
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
    window.__kannaBridgeMessages = [];
    window.__kannaTerminalLinkProviders = [];
    window.__kannaTerminals = [];
    window.__kannaPendingWrites = 0;
    window.ReactNativeWebView = {
      postMessage(message) {
        window.__kannaBridgeMessages.push(message);
      }
    };
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
            const originalRegisterLinkProvider = term.registerLinkProvider.bind(term);
            term.registerLinkProvider = function patchedRegisterLinkProvider(provider) {
              window.__kannaTerminalLinkProviders.push(provider);
              return originalRegisterLinkProvider(provider);
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
    __clearTerminalSelection: () => void;
    __replaceTerminalState: (state: TerminalHookState) => void;
    __setTerminalBottomInset: (state: { bottomInset: number }) => void;
    __setTerminalDims: (dims: { cols: number; rows: number }) => void;
    __kannaPendingWrites: number;
    __kannaBridgeMessages: string[];
    __kannaTerminalLinks: Array<{
      activate: () => void;
      text: string;
    }> | undefined;
    __kannaTerminalLinkProviders: Array<{
      provideLinks: (
        bufferLineNumber: number,
        callback: (links: Window["__kannaTerminalLinks"]) => void
      ) => void;
    }>;
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
          type: "normal" | "alternate";
          baseY: number;
          length: number;
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
      clearSelection: () => void;
      getSelection: () => string;
      select: (column: number, row: number, length: number) => void;
      scrollToLine: (line: number) => void;
      write: (text: string | Uint8Array, callback?: () => void) => void;
    }>;
  }
}
