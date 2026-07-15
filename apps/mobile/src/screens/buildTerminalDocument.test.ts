import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  buildTerminalAppendScript,
  buildTerminalDocument,
  buildTerminalReplaceScript,
  buildTerminalResizeScript
} from "./buildTerminalDocument";

interface TouchPoint {
  clientX: number;
  clientY: number;
}

interface StubTerminalLink {
  activate(): void;
  decorations: {
    pointerCursor: boolean;
    underline: boolean;
  };
  range: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  text: string;
}

interface StubTerminalLinkProvider {
  provideLinks(
    bufferLineNumber: number,
    callback: (links: StubTerminalLink[] | undefined) => void
  ): void;
}

interface StubBufferCell {
  getChars(): string;
  getWidth(): number;
}

function terminalCells(text: string): Array<{ chars: string; width: number }> {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const character of text) {
    if (/\p{Mark}/u.test(character) && cells.length > 0) {
      const previous = cells.findLast((cell) => cell.width > 0);
      if (previous) previous.chars += character;
      continue;
    }
    const width = /\p{Script=Han}/u.test(character) ? 2 : 1;
    cells.push({ chars: character, width });
    if (width === 2) cells.push({ chars: "", width: 0 });
  }
  return cells;
}

class StubTerminal {
  cols: number;
  rows = 0;
  options: { fontSize: number; smoothScrollDuration?: number };
  linkProvider: StubTerminalLinkProvider | null = null;
  bufferLines = new Map<number, string>();
  getLineCalls: number[] = [];
  translateToStringCalls: Array<{ index: number; trimRight: boolean | undefined }> = [];
  buffer = {
    active: {
      baseY: 100,
      viewportY: 100,
      length: 101,
      getLine: (index: number) => {
        this.getLineCalls.push(index);
        const text = this.bufferLines.get(index);
        if (text === undefined) {
          return undefined;
        }
        const cells = terminalCells(text);
        return {
          length: cells.length,
          getCell: (cellIndex: number): StubBufferCell | undefined => {
            const cell = cells[cellIndex];
            return cell
              ? {
                  getChars: () => cell.chars,
                  getWidth: () => cell.width
                }
              : undefined;
          },
          translateToString: (trimRight?: boolean) => {
            this.translateToStringCalls.push({ index, trimRight });
            return text;
          }
        };
      }
    }
  };
  resizeCalls: Array<{ cols: number; rows: number }> = [];
  scrollToBottomCalls = 0;
  scrollToBottomHook: (() => void) | null = null;
  scrollToLineCalls: number[] = [];
  writes: unknown[] = [];
  resets = 0;
  dimensions = {
    css: {
      canvas: { width: 1980, height: 774 },
      cell: { width: 9, height: 18 }
    },
    device: {
      canvas: { width: 1980, height: 774 },
      cell: { width: 9, height: 18 },
      char: { width: 9, height: 18 }
    }
  };
  private scrollListeners: Array<(viewportY: number) => void> = [];

  constructor(options: {
    cols: number;
    fontSize: number;
    smoothScrollDuration?: number;
  }) {
    this.cols = options.cols;
    this.options = {
      fontSize: options.fontSize,
      smoothScrollDuration: options.smoothScrollDuration
    };
  }

  loadAddon(): void {}

  registerLinkProvider(provider: StubTerminalLinkProvider): { dispose(): void } {
    this.linkProvider = provider;
    return { dispose() {} };
  }

  open(root: HTMLElement): void {
    const xterm = root.ownerDocument.createElement("div");
    xterm.className = "xterm";
    const screen = root.ownerDocument.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () => {
      const width = this.cols * 9;
      const height = this.rows * 18;
      return {
        x: 0,
        y: 0,
        width,
        height,
        top: 0,
        right: width,
        bottom: height,
        left: 0,
        toJSON: () => ({})
      };
    };
    const viewport = root.ownerDocument.createElement("div");
    viewport.className = "xterm-viewport";
    const scrollableElement = root.ownerDocument.createElement("div");
    scrollableElement.className = "xterm-scrollable-element";
    scrollableElement.append(screen);
    xterm.append(viewport, scrollableElement);
    root.append(xterm);
  }

  onScroll(listener: (viewportY: number) => void): { dispose(): void } {
    this.scrollListeners.push(listener);
    return {
      dispose: () => {
        this.scrollListeners = this.scrollListeners.filter(
          (candidate) => candidate !== listener
        );
      }
    };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeCalls.push({ cols, rows });
  }

  scrollToBottom(): void {
    this.scrollToBottomCalls += 1;
    if (this.scrollToBottomHook) {
      this.scrollToBottomHook();
      return;
    }
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this.emitScroll();
  }

  scrollToLine(line: number): void {
    if (!Number.isInteger(line)) {
      throw new Error("This API only accepts integers");
    }
    this.scrollToLineCalls.push(line);
    this.buffer.active.viewportY = Math.max(
      0,
      Math.min(this.buffer.active.baseY, line)
    );
    this.emitScroll();
  }

  write(data: unknown, done?: () => void): void {
    this.writes.push(data);
    const previousBaseY = this.buffer.active.baseY;
    const text =
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
          ? new TextDecoder().decode(data)
          : "";
    const parts = text.replace(/\r\n|\r/g, "\n").split("\n");
    let lineIndex = Math.max(0, this.buffer.active.length - 1);
    const firstLine = this.bufferLines.get(lineIndex) ?? "";
    this.bufferLines.set(lineIndex, firstLine + (parts.shift() ?? ""));
    for (const part of parts) {
      lineIndex += 1;
      this.bufferLines.set(lineIndex, part);
    }
    this.buffer.active.length = Math.max(this.buffer.active.length, lineIndex + 1);
    this.buffer.active.baseY += 1;
    if (this.buffer.active.viewportY === previousBaseY) {
      this.buffer.active.viewportY = this.buffer.active.baseY;
    }
    this.emitScroll();
    done?.();
  }

  reset(): void {
    this.resets += 1;
    this.bufferLines.clear();
    this.buffer.active.baseY = 0;
    this.buffer.active.viewportY = 0;
    this.buffer.active.length = 0;
  }

  emitScroll(viewportY?: number): void {
    if (viewportY !== undefined) {
      this.buffer.active.viewportY = viewportY;
    }
    for (const listener of this.scrollListeners) {
      listener(this.buffer.active.viewportY);
    }
  }
}

function provideLinks(
  terminal: StubTerminal,
  bufferLineNumber: number,
  lineText: string
): StubTerminalLink[] | undefined {
  terminal.bufferLines.set(bufferLineNumber - 1, lineText);
  if (!terminal.linkProvider) {
    throw new Error("generated terminal did not register a file link provider");
  }
  let result: StubTerminalLink[] | undefined;
  terminal.linkProvider.provideLinks(bufferLineNumber, (links) => {
    result = links;
  });
  return result;
}

class StubFitAddon {
  fitCalls = 0;
  proposeDimensions(): { rows: number } {
    return { rows: 42 };
  }
  fit(): void {
    this.fitCalls += 1;
  }
}

function b64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

function createTouchEvent(
  window: Window,
  type: string,
  touches: TouchPoint[],
  options: EventInit = { bubbles: true, cancelable: true }
): Event {
  const event = new window.Event(type, options);
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: touches
  });
  return event;
}

function extractTerminalScript(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1]
  );
  return scripts.at(-1) ?? "";
}

function createExecutedTerminalDocument({
  enableE2EInspection = false
}: {
  enableE2EInspection?: boolean;
} = {}): {
  terminal: StubTerminal;
  window: Window & typeof globalThis;
  root: HTMLElement;
  viewport: HTMLElement;
  terminalViewport: HTMLElement;
  scrollableElement: HTMLElement;
  messages: string[];
} {
  const html = buildTerminalDocument({ bottomInset: 24, enableE2EInspection });
  const window = new Window() as Window & typeof globalThis;
  const messages: string[] = [];

  window.document.documentElement.innerHTML =
    html.match(/<html[^>]*>([\s\S]*)<\/html>/)?.[1] ?? html;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof window.requestAnimationFrame;
  window.ReactNativeWebView = {
    postMessage(message: string) {
      messages.push(message);
    }
  };

  let terminal: StubTerminal | null = null;
  window.Terminal = class extends StubTerminal {
    constructor(options: {
      cols: number;
      fontSize: number;
      smoothScrollDuration?: number;
    }) {
      super(options);
      terminal = this;
    }
  };
  window.FitAddon = {
    FitAddon: StubFitAddon
  };

  const viewport = window.document.getElementById("viewport");
  if (!viewport) {
    throw new Error("generated terminal viewport was not rendered");
  }
  Object.defineProperty(viewport, "clientWidth", {
    configurable: true,
    value: 390
  });
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 844 },
    scrollHeight: { configurable: true, value: 1000 }
  });

  window.eval(extractTerminalScript(html));

  const root = window.document.getElementById("terminal-root");
  const terminalViewport = root?.querySelector<HTMLElement>(".xterm-viewport");
  const scrollableElement = root?.querySelector<HTMLElement>(
    ".xterm-scrollable-element"
  );
  if (!terminal || !root || !terminalViewport || !scrollableElement) {
    throw new Error("generated terminal script did not initialize xterm");
  }

  return {
    terminal,
    window,
    root,
    viewport,
    terminalViewport,
    scrollableElement,
    messages
  };
}

describe("buildTerminalDocument", () => {
  it("provides bare, nested, and absolute file links with one-based ranges", () => {
    const { messages, terminal } = createExecutedTerminalDocument();
    const row = 7;
    const line = "See README.md and docs/spec.md:42:7 then /tmp/task/notes.md:9";

    const links = provideLinks(terminal, row, line);

    expect(links?.map((link) => link.text)).toEqual([
      "README.md",
      "docs/spec.md:42:7",
      "/tmp/task/notes.md:9"
    ]);
    expect(links?.map((link) => link.range)).toEqual(
      ["README.md", "docs/spec.md:42:7", "/tmp/task/notes.md:9"].map((text) => {
        const start = line.indexOf(text);
        return {
          start: { x: start + 1, y: row },
          end: { x: start + text.length, y: row }
        };
      })
    );
    expect(links?.map((link) => link.decorations)).toEqual([
      { pointerCursor: true, underline: true },
      { pointerCursor: true, underline: true },
      { pointerCursor: true, underline: true }
    ]);

    expect(
      messages.map((message) => JSON.parse(message).type)
    ).not.toContain("terminal-file-link");
  });

  it("renders persistent accessible file buttons and opens one through a real click", () => {
    const { messages, window } = createExecutedTerminalDocument();

    window.__replaceTerminalState({
      text: "See README.md and docs/spec.md:42\n"
    });

    const region = window.document.getElementById("terminal-file-links");
    const button = region?.querySelector<HTMLButtonElement>(
      'button[data-terminal-file-raw="docs/spec.md:42"]'
    );
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("aria-label")).toBe(
      "Files mentioned in terminal"
    );
    expect(region?.hidden).toBe(false);
    expect(button?.textContent).toBe("docs/spec.md:42");
    expect(button?.getAttribute("aria-label")).toBe(
      "Open file docs/spec.md at line 42"
    );
    expect(button?.classList.contains("terminal-file-link")).toBe(true);

    button?.click();

    expect(JSON.parse(messages.at(-1) ?? "null")).toEqual({
      type: "terminal-file-link",
      path: "docs/spec.md",
      line: 42
    });
  });

  it("keeps the newest six unique file buttons visible", () => {
    const { window } = createExecutedTerminalDocument();
    window.__replaceTerminalState({
      text: [
        "docs/one.md",
        "docs/two.md",
        "docs/three.md",
        "docs/four.md",
        "docs/five.md",
        "docs/six.md",
        "docs/seven.md",
        "docs/two.md"
      ].join("\n")
    });

    const buttons = Array.from(
      window.document.querySelectorAll<HTMLButtonElement>(
        "#terminal-file-links button"
      )
    );
    expect(buttons.map((button) => button.textContent)).toEqual([
      "docs/three.md",
      "docs/four.md",
      "docs/five.md",
      "docs/six.md",
      "docs/seven.md",
      "docs/two.md"
    ]);
  });

  it("rejects literal parent segments and non-file-like rows", () => {
    const { terminal } = createExecutedTerminalDocument();

    expect(provideLinks(terminal, 2, "../secret.md docs/../escape.md")).toBeUndefined();
    expect(provideLinks(terminal, 3, "No file path was written here")).toBeUndefined();
  });

  it("reads only the requested xterm row and trims its rendered right padding", () => {
    const { terminal } = createExecutedTerminalDocument();
    terminal.bufferLines.set(0, "README.md");
    terminal.bufferLines.set(8, "docs/spec.md");

    const links = provideLinks(terminal, 9, "docs/spec.md");

    expect(links?.map((link) => link.text)).toEqual(["docs/spec.md"]);
    expect(terminal.getLineCalls).toEqual([8]);
    expect(terminal.translateToStringCalls).toEqual([{ index: 8, trimRight: true }]);
  });

  it("maps file-link ranges to terminal cells after wide and combining characters", () => {
    const { terminal } = createExecutedTerminalDocument();

    const wide = provideLinks(terminal, 4, "界 docs/spec.md");
    expect(wide?.[0]?.range).toEqual({
      start: { x: 4, y: 4 },
      end: { x: 15, y: 4 }
    });

    const combining = provideLinks(terminal, 5, "e\u0301 docs/spec.md");
    expect(combining?.[0]?.range).toEqual({
      start: { x: 3, y: 5 },
      end: { x: 14, y: 5 }
    });
  });

  it("omits terminal inspection traversal and messages outside E2E builds", () => {
    const { messages, window } = createExecutedTerminalDocument();
    const script = extractTerminalScript(
      buildTerminalDocument({
        bottomInset: 24,
        enableE2EInspection: false
      })
    );

    window.__replaceTerminalState({ chunksB64: [b64("first frame\n")] });
    window.__appendTerminalChunk({ chunksB64: [b64("second frame\n")] });

    expect(script).not.toContain("terminal-inspection");
    expect(script).not.toContain("function renderedTerminalText");
    expect(script).toContain("const MAX_FILE_LINK_SCAN_ROWS = 200;");
    expect(script).toContain(
      "Math.max(0, buffer.length - MAX_FILE_LINK_SCAN_ROWS)"
    );
    expect(script).not.toContain("const firstLine = 0");
    expect(script).not.toContain("recordTerminalFrame");
    expect(messages.map((message) => JSON.parse(message).type)).not.toContain(
      "terminal-inspection"
    );
  });

  it("reports rendered terminal inspection after replace and append in E2E builds", () => {
    const { messages, window } = createExecutedTerminalDocument({ enableE2EInspection: true });
    const script = extractTerminalScript(
      buildTerminalDocument({
        bottomInset: 24,
        enableE2EInspection: true
      })
    );

    window.__replaceTerminalState({ chunksB64: [b64("first frame\n")] });
    window.__appendTerminalChunk({ chunksB64: [b64("second frame\n")] });

    const inspections = messages
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "terminal-inspection");
    expect(inspections).toHaveLength(2);
    expect(script).toContain("term.buffer.active");
    expect(script).toContain("recordTerminalFrame");
    expect(inspections.at(-1)?.inspection).toMatchObject({
      byteCount: 25,
      frameCount: 2
    });
  });

  it("builds an xterm shell with sticky scroll behavior and bottom inset", () => {
    const html = buildTerminalDocument({
      bottomInset: 132,
      enableE2EInspection: false
    });

    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('id="viewport"');
    expect(html).toContain('id="terminal-root"');
    expect(html).toContain("padding-bottom: 132px;");
    expect(html).toContain("overflow-x: auto;");
    expect(html).toContain("-webkit-overflow-scrolling: touch;");
    expect(html).toContain("touch-action: pan-x pan-y pinch-zoom;");
    expect(html).toContain("const TERMINAL_COLS = 220;");
    expect(html).toContain("term.resize(TERMINAL_COLS, proposed.rows)");
    expect(html).toContain("const term = new TerminalCtor(");
    expect(html).toContain("vtExtensions: { kittyKeyboard: true }");
    expect(html).toContain("new FitAddonCtor()");
    expect(html).toContain("term.open(root)");
    expect(html).toContain("function scrollToBottomImmediately()");
    expect(html).toContain("scrollToBottomImmediately();");
    expect(html).toContain("window.__replaceTerminalState");
    expect(html).toContain("window.__appendTerminalChunk");
    expect(html).toContain("window.ReactNativeWebView.postMessage");
    expect(html).toContain('type: "terminal-ready"');
    expect(html).toContain('type: "terminal-tap"');
    expect(html).toContain('viewport.addEventListener("pointerdown"');
    expect(html).toContain("term.onScroll");
    expect(html).toContain("window.__setTerminalBottomInset");
    expect(html).toContain("viewport.style.paddingBottom");
    expect(html).not.toContain('terminalViewport.addEventListener("scroll"');
    expect(html).not.toContain("terminalViewport.style.bottom");
    expect(html).not.toContain("<pre id=\"terminal\"></pre>");
  });

  it("keeps manual xterm scrollback stable and resumes following near the bottom", () => {
    const {
      scrollableElement,
      terminal,
      terminalViewport,
      window
    } = createExecutedTerminalDocument();
    const initialScrollToBottomCalls = terminal.scrollToBottomCalls;
    const screen = scrollableElement.querySelector(".xterm-screen");

    expect(screen).not.toBeNull();
    expect(terminalViewport.children).toHaveLength(0);
    terminal.scrollToLine(terminal.buffer.active.baseY - 3);
    const manualViewportY = terminal.buffer.active.viewportY;

    window.__appendTerminalChunk({ chunksB64: [b64("new output\n")] });

    expect(terminal.buffer.active.viewportY).toBe(manualViewportY);
    expect(terminal.scrollToBottomCalls).toBe(initialScrollToBottomCalls);
    expect(terminalViewport.style.bottom).toBe("");

    terminal.scrollToLine(terminal.buffer.active.baseY - 1);
    window.__appendTerminalChunk({ chunksB64: [b64("latest output\n")] });

    expect(terminal.scrollToBottomCalls).toBe(initialScrollToBottomCalls + 1);
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
  });

  it("updates and aligns the Kanna-owned viewport for measured composer insets", () => {
    const { root, viewport, window } = createExecutedTerminalDocument();

    window.__setTerminalBottomInset({ bottomInset: 212 });

    expect(viewport.style.paddingBottom).toBe("212px");
    expect(viewport.scrollTop).toBe(156);
    expect(root.dataset.kannaBottomInset).toBe("212");
  });

  it("enables mobile pinch zoom and bidirectional touch scrolling for xterm", () => {
    const html = buildTerminalDocument({
      bottomInset: 24,
      enableE2EInspection: false
    });
    const script = extractTerminalScript(html);

    expect(html).toContain("maximum-scale=3");
    expect(html).toContain("user-scalable=yes");
    expect(html).toContain("touch-action: pan-x pan-y pinch-zoom;");
    expect(html).toContain(".xterm .xterm-screen,");
    expect(html).toContain(".xterm .xterm-viewport {");
    expect(html).toContain("installPinchZoomFallback()");
    expect(html).toContain("const MIN_FONT_SCALE = 0.75;");
    expect(html).toContain("const MAX_FONT_SCALE = 1.8;");
    expect(html).toContain('viewport.addEventListener("touchstart"');
    expect(html).toContain('viewport.addEventListener("touchmove"');
    expect(html).toContain("term.options.fontSize = Math.round(BASE_FONT_SIZE * fontScale)");
    expect(script).not.toContain("term._core");
  });

  it("configures xterm with an 80 ms smooth scroll duration", () => {
    const { terminal } = createExecutedTerminalDocument();

    expect(terminal.options.smoothScrollDuration).toBe(80);
  });

  it("executes one-finger fallback horizontal scrolling across the viewport", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    viewport.scrollLeft = 12;
    terminal.scrollToLine(76);
    terminal.scrollToLineCalls = [];

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }]));
    const touchMove = createTouchEvent(window, "touchmove", [{ clientX: 175, clientY: 232 }]);
    viewport.dispatchEvent(touchMove);

    expect(viewport.scrollLeft).toBe(57);
    expect(terminal.scrollToLineCalls).toEqual([]);
    expect(terminal.buffer.active.viewportY).toBe(76);
    expect(touchMove.defaultPrevented).toBe(true);
  });

  it("eases a vertical one-finger drag through xterm buffer lines", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    viewport.scrollLeft = 12;
    terminal.scrollToLine(76);
    terminal.scrollToLineCalls = [];

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }]));
    const touchMove = createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 195 }]);
    viewport.dispatchEvent(touchMove);

    expect(viewport.scrollLeft).toBe(12);
    expect(terminal.scrollToLineCalls).toEqual([79]);
    expect(touchMove.defaultPrevented).toBe(true);
  });

  it("keeps a one-finger gesture vertically locked after horizontal displacement dominates", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    viewport.scrollLeft = 12;
    terminal.scrollToLine(76);
    terminal.scrollToLineCalls = [];

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }]));
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 217, clientY: 225 }])
    );
    const laterMove = createTouchEvent(window, "touchmove", [{ clientX: 170, clientY: 242 }]);
    viewport.dispatchEvent(laterMove);

    expect(terminal.scrollToLineCalls).toEqual([77, 76]);
    expect(viewport.scrollLeft).toBe(12);
    expect(laterMove.defaultPrevented).toBe(true);
  });

  it("keeps the outer safe-region inset while public xterm scroll positions change", () => {
    const { terminal, viewport } = createExecutedTerminalDocument();

    terminal.emitScroll(97);
    expect(viewport.style.paddingBottom).toBe("24px");

    terminal.emitScroll(100);
    expect(viewport.style.paddingBottom).toBe("24px");
  });

  it("keeps rapid consecutive appends following bottom while gesture scrolling stays smooth", () => {
    const { terminal, window } = createExecutedTerminalDocument();
    terminal.emitScroll(99);
    const initialScrollToBottomCalls = terminal.scrollToBottomCalls;
    const autoFollowDurations: Array<number | undefined> = [];
    terminal.scrollToBottomHook = () => {
      autoFollowDurations.push(terminal.options.smoothScrollDuration);
      terminal.emitScroll(
        terminal.options.smoothScrollDuration === 0
          ? terminal.buffer.active.baseY
          : 50
      );
    };

    window.__appendTerminalChunk({ chunksB64: [b64("first append\n")] });
    window.__appendTerminalChunk({ chunksB64: [b64("second append\n")] });

    expect(terminal.scrollToBottomCalls - initialScrollToBottomCalls).toBe(2);
    expect(autoFollowDurations).toEqual([0, 0]);
    expect(terminal.options.smoothScrollDuration).toBe(80);
  });

  it("executes two-finger fallback pinch scaling with clamping and keeps terminal scripts working", () => {
    const { root, terminal, viewport, window } = createExecutedTerminalDocument();

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [
        { clientX: 0, clientY: 0 },
        { clientX: 100, clientY: 0 }
      ])
    );
    const pinchOut = createTouchEvent(window, "touchmove", [
      { clientX: 0, clientY: 0 },
      { clientX: 260, clientY: 0 }
    ]);
    viewport.dispatchEvent(pinchOut);

    expect(root.dataset.kannaFontScale).toBe("1.80");
    expect(terminal.options.fontSize).toBe(23);
    expect(terminal.scrollToLineCalls).toEqual([]);
    expect(pinchOut.defaultPrevented).toBe(true);

    viewport.dispatchEvent(createTouchEvent(window, "touchend", []));
    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [
        { clientX: 0, clientY: 0 },
        { clientX: 100, clientY: 0 }
      ])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 }
      ])
    );

    expect(root.dataset.kannaFontScale).toBe("0.75");
    expect(terminal.options.fontSize).toBe(10);

    window.__setTerminalDims({ cols: 132, rows: 43 });
    window.__replaceTerminalState({ chunksB64: [b64("mobile terminal\n")] });

    expect(root.dataset.kannaCols).toBe("132");
    expect(root.dataset.kannaRows).toBe("43");
    expect(root.style.width).toBe("1188px");
    expect(root.style.height).toBe("774px");
    expect(terminal.resizeCalls).toContainEqual({ cols: 132, rows: 43 });
    expect(terminal.resets).toBe(1);
    expect(terminal.writes).toHaveLength(1);
    expect(terminal.scrollToLineCalls).toEqual([]);
  });

  it.each([
    [
      "scroll",
      [{ clientX: 220, clientY: 240 }],
      [{ clientX: 150, clientY: 230 }]
    ],
    [
      "pinch",
      [
        { clientX: 100, clientY: 200 },
        { clientX: 200, clientY: 200 }
      ],
      [
        { clientX: 60, clientY: 200 },
        { clientX: 240, clientY: 200 }
      ]
    ]
  ])("does not open a file after a %s gesture over its button", (_label, start, move) => {
    const { messages, window } = createExecutedTerminalDocument();
    window.__replaceTerminalState({ text: "docs/spec.md\n" });
    const button = window.document.querySelector<HTMLButtonElement>(
      "#terminal-file-links button"
    );
    expect(button).not.toBeNull();

    button?.dispatchEvent(createTouchEvent(window, "touchstart", start));
    button?.dispatchEvent(createTouchEvent(window, "touchmove", move));
    button?.dispatchEvent(createTouchEvent(window, "touchend", []));
    button?.click();

    expect(
      messages.map((message) => JSON.parse(message).type)
    ).not.toContain("terminal-file-link");
  });

  it("writes base64 terminal chunks as bytes in replace scripts", () => {
    const script = buildTerminalReplaceScript({
      output: `${b64("╭── Claude Code ──╮")}\n`,
      status: "live"
    });

    expect(script).toContain(b64("╭── Claude Code ──╮"));
    expect(script).not.toContain("╭── Claude Code ──╮");
    expect(script).not.toContain("â­");
    expect(script).toContain("window.__replaceTerminalState");
    expect(script).toContain("chunksB64");
  });

  it("preserves split multibyte terminal chunks in append scripts", () => {
    const script = buildTerminalAppendScript("8J8=\nmIA=\n");

    expect(script).toContain("8J8=");
    expect(script).toContain("mIA=");
    expect(script).not.toContain("😀");
    expect(script).toContain("window.__appendTerminalChunk");
  });

  it("renders terminal status copy when no output is available", () => {
    const connectingScript = buildTerminalReplaceScript({
      output: "",
      status: "connecting"
    });
    const idleScript = buildTerminalReplaceScript({
      output: "   ",
      status: "idle"
    });

    expect(connectingScript).toContain("Connecting to desktop daemon...");
    expect(idleScript).toContain("Waiting for terminal output...");
  });

  it("builds append scripts for incremental terminal output", () => {
    const script = buildTerminalAppendScript(`${b64("Second line\n")}\n`);

    expect(script).toContain("window.__appendTerminalChunk");
    expect(script).toContain(b64("Second line\n"));
    expect(script).not.toContain("Second line");
  });

  it("keeps large newline-delimited base64 snapshot frames as separate chunks", () => {
    const firstFrame = "A".repeat(64_000);
    const secondFrame = b64("terminal prompt\n");
    const script = buildTerminalReplaceScript({
      output: `${firstFrame}\n${secondFrame}\n`,
      status: "live"
    });

    expect(script).toContain(`"chunksB64":["${firstFrame}","${secondFrame}"]`);
    expect(script).not.toContain(`${firstFrame}\\n${secondFrame}`);
  });

  it("builds resize scripts for the WebView terminal dimension bridge", () => {
    const html = buildTerminalDocument({ bottomInset: 24, enableE2EInspection: false });
    const script = buildTerminalResizeScript(132, 43);

    expect(html).toContain("window.__setTerminalDims");
    expect(html).toContain("term.resize(pinnedCols, pinnedRows)");
    expect(html).toContain("root.dataset.kannaCols = String(pinnedCols)");
    expect(html).toContain("root.dataset.kannaRows = String(pinnedRows)");
    expect(html).toContain("applyPinnedSize()");
    expect(script).toBe('window.__setTerminalDims({"cols":132,"rows":43}); true;');
  });

  it("keeps echoed terminal input control stripping in the webview byte path", () => {
    const html = buildTerminalDocument({ bottomInset: 24, enableE2EInspection: false });
    const replaceScript = buildTerminalReplaceScript({
      output: `${b64("\u001b[200~continue\u001b[201~\u001b[13u\nClaude response\n")}\n`,
      status: "live"
    });
    const appendScript = buildTerminalAppendScript(`${b64("\u001b[>1u\u001b[13;5u")}\n`);

    expect(html).toContain("removeEchoedTerminalInputControls");
    expect(replaceScript).toContain(b64("\u001b[200~continue\u001b[201~\u001b[13u\nClaude response\n"));
    expect(replaceScript).not.toContain("[200~");
    expect(replaceScript).not.toContain("[201~");
    expect(replaceScript).not.toContain("[13u");
    expect(appendScript).not.toContain("[>1u");
    expect(appendScript).not.toContain("[13;5u");
  });
});
