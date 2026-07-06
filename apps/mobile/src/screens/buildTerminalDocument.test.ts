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
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1000 }
    });
    xterm.append(screen, viewport);
    root.append(xterm);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeCalls.push({ cols, rows });
  }

  scrollToBottom(): void {
    this.scrollToBottomCalls += 1;
  }

  write(data: unknown, done?: () => void): void {
    this.writes.push(data);
    done?.();
  }

  reset(): void {
    this.resets += 1;
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

function createExecutedTerminalDocument(): {
  terminal: StubTerminal;
  window: Window & typeof globalThis;
  root: HTMLElement;
  viewport: HTMLElement;
  terminalViewport: HTMLElement;
  messages: string[];
} {
  const html = buildTerminalDocument({ bottomInset: 24 });
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

  window.eval(extractTerminalScript(html));

  const root = window.document.getElementById("terminal-root");
  const terminalViewport = root?.querySelector<HTMLElement>(".xterm-viewport");
  if (!terminal || !root || !terminalViewport) {
    throw new Error("generated terminal script did not initialize xterm");
  }

  return {
    terminal,
    window,
    root,
    viewport,
    terminalViewport,
    messages
  };
}

describe("buildTerminalDocument", () => {
  it("builds an xterm shell with sticky scroll behavior and bottom inset", () => {
    const html = buildTerminalDocument({
      bottomInset: 132
    });

    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('id="viewport"');
    expect(html).toContain('id="terminal-root"');
    expect(html).toContain("padding-bottom: 132px;");
    expect(html).toContain("overflow-x: auto;");
    expect(html).toContain("-webkit-overflow-scrolling: touch;");
    expect(html).toContain("touch-action: pan-x pan-y pinch-zoom;");
    expect(html).toContain("terminalViewport.style.overflowX = \"visible\"");
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
    expect(html).toContain("terminalViewport.style.bottom = stickyToBottom");
    expect(html).not.toContain("<pre id=\"terminal\"></pre>");
  });

  it("enables mobile pinch zoom and bidirectional touch scrolling for xterm", () => {
    const html = buildTerminalDocument({
      bottomInset: 24
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

  it("executes one-finger fallback touch scrolling across the viewport and xterm buffer", () => {
    const { terminalViewport, viewport, window } = createExecutedTerminalDocument();
    viewport.scrollLeft = 12;
    terminalViewport.scrollTop = 80;

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }]));
    const touchMove = createTouchEvent(window, "touchmove", [{ clientX: 175, clientY: 180 }]);
    viewport.dispatchEvent(touchMove);

    expect(viewport.scrollLeft).toBe(57);
    expect(terminalViewport.scrollTop).toBe(140);
    expect(touchMove.defaultPrevented).toBe(true);
  });

  it("executes two-finger fallback pinch scaling with clamping and keeps terminal scripts working", () => {
    const { messages, root, terminal, viewport, window } = createExecutedTerminalDocument();

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
    expect(root.dataset.kannaByteCount).toBe("16");
    expect(messages.map((message) => JSON.parse(message).type)).toContain("terminal-ready");
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
    const html = buildTerminalDocument({ bottomInset: 24 });
    const script = buildTerminalResizeScript(132, 43);

    expect(html).toContain("window.__setTerminalDims");
    expect(html).toContain("term.resize(pinnedCols, pinnedRows)");
    expect(html).toContain("root.dataset.kannaCols = String(pinnedCols)");
    expect(html).toContain("root.dataset.kannaRows = String(pinnedRows)");
    expect(html).toContain("root.dataset.kannaFrameCount");
    expect(html).toContain("new TextDecoder");
    expect(html).toContain("applyPinnedSize()");
    expect(script).toBe('window.__setTerminalDims({"cols":132,"rows":43}); true;');
  });

  it("keeps echoed terminal input control stripping in the webview byte path", () => {
    const html = buildTerminalDocument({ bottomInset: 24 });
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
