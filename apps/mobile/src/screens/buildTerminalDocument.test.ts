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

class StubTerminal {
  cols: number;
  rows = 0;
  options: { fontSize: number };
  resizeCalls: Array<{ cols: number; rows: number }> = [];
  scrollToBottomCalls = 0;
  writes: unknown[] = [];
  resets = 0;
  buffer = {
    active: {
      baseY: 100,
      viewportY: 100,
      length: 101,
      getLine: (_index: number) => ({
        translateToString: (_trimRight?: boolean) => ""
      })
    }
  };
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
  _core = {
    _renderService: {
      dimensions: {
        css: {
          cell: {
            width: 9,
            height: 18
          }
        }
      }
    }
  };

  constructor(options: { cols: number; fontSize: number }) {
    this.cols = options.cols;
    this.options = { fontSize: options.fontSize };
  }

  loadAddon(): void {}

  open(root: HTMLElement): void {
    const xterm = root.ownerDocument.createElement("div");
    xterm.className = "xterm";
    const screen = root.ownerDocument.createElement("div");
    screen.className = "xterm-screen";
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
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this.emitScroll();
  }

  scrollToLine(line: number): void {
    this.buffer.active.viewportY = Math.max(
      0,
      Math.min(this.buffer.active.baseY, line)
    );
    this.emitScroll();
  }

  write(data: unknown, done?: () => void): void {
    this.writes.push(data);
    const previousBaseY = this.buffer.active.baseY;
    this.buffer.active.baseY += 1;
    this.buffer.active.length += 1;
    if (this.buffer.active.viewportY === previousBaseY) {
      this.buffer.active.viewportY = this.buffer.active.baseY;
    }
    this.emitScroll();
    done?.();
  }

  reset(): void {
    this.resets += 1;
  }

  private emitScroll(): void {
    for (const listener of this.scrollListeners) {
      listener(this.buffer.active.viewportY);
    }
  }
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
  options: EventInit = { cancelable: true }
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
    constructor(options: { cols: number; fontSize: number }) {
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
    expect(script).not.toContain("translateToString");
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
    expect(html).toContain("term.scrollToBottom()");
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
  });

  it("executes one-finger fallback horizontal scrolling across the viewport", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    viewport.scrollLeft = 12;
    terminal.scrollToLine(80);

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }]));
    const touchMove = createTouchEvent(window, "touchmove", [{ clientX: 175, clientY: 232 }]);
    viewport.dispatchEvent(touchMove);

    expect(viewport.scrollLeft).toBe(57);
    expect(terminal.buffer.active.viewportY).toBe(80);
    expect(touchMove.defaultPrevented).toBe(true);
  });

  it("leaves primarily vertical one-finger scrolling to the xterm viewport", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    viewport.scrollLeft = 12;
    terminal.scrollToLine(80);

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }]));
    const touchMove = createTouchEvent(window, "touchmove", [{ clientX: 216, clientY: 180 }]);
    viewport.dispatchEvent(touchMove);

    expect(viewport.scrollLeft).toBe(12);
    expect(terminal.buffer.active.viewportY).toBe(80);
    expect(touchMove.defaultPrevented).toBe(false);
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
    expect(terminal.resizeCalls).toContainEqual({ cols: 132, rows: 43 });
    expect(terminal.resets).toBe(1);
    expect(terminal.writes).toHaveLength(1);
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
