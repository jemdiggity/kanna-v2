import { Window } from "happy-dom";
import {
  createTerminalOutput,
  prependTerminalScrollback
} from "../state/terminalOutputBuffer";
import { describe, expect, it, vi } from "vitest";
import {
  buildTerminalAppendScript,
  buildTerminalDocument,
  buildTerminalPrependScript,
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

interface StubTerminalBuffer {
  type: "normal" | "alternate";
  baseY: number;
  viewportY: number;
  length: number;
  getLine(index: number): {
    length: number;
    getCell(cellIndex: number): StubBufferCell | undefined;
    translateToString(trimRight?: boolean): string;
  } | undefined;
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
  alternateBufferLines = new Map<number, string>();
  getLineCalls: number[] = [];
  translateToStringCalls: Array<{ index: number; trimRight: boolean | undefined }> = [];
  normalBuffer = this.createBuffer("normal", this.bufferLines);
  alternateBuffer = this.createBuffer("alternate", this.alternateBufferLines);
  buffer = {
    active: this.normalBuffer,
    normal: this.normalBuffer,
    alternate: this.alternateBuffer
  };
  resizeCalls: Array<{ cols: number; rows: number }> = [];
  scrollToBottomCalls = 0;
  scrollToBottomHook: (() => void) | null = null;
  scrollToLineCalls: number[] = [];
  writes: unknown[] = [];
  resets = 0;
  selection = "";
  selectionCalls: Array<{ column: number; row: number; length: number }> = [];
  clearSelectionCalls = 0;
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
  wheelEvents: Array<{
    clientX: number;
    clientY: number;
    deltaMode: number;
    deltaY: number;
  }> = [];
  private scrollListeners: Array<(viewportY: number) => void> = [];
  private selectionListeners: Array<() => void> = [];
  private dataListeners: Array<(data: string) => void> = [];
  private binaryListeners: Array<(data: string) => void> = [];

  private createBuffer(
    type: "normal" | "alternate",
    lines: Map<number, string>
  ): StubTerminalBuffer {
    return {
      type,
      baseY: 100,
      viewportY: 100,
      length: 101,
      getLine: (index: number) => {
        this.getLineCalls.push(index);
        const text = lines.get(index);
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
    };
  }

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
    // Mirror real xterm: wheel events reaching the terminal element are
    // encoded as SGR mouse-wheel reports when the alternate buffer is active.
    xterm.addEventListener("wheel", (event) => {
      const wheel = event as unknown as {
        clientX: number;
        clientY: number;
        deltaMode: number;
        deltaY: number;
      };
      this.wheelEvents.push({
        clientX: wheel.clientX,
        clientY: wheel.clientY,
        deltaMode: wheel.deltaMode,
        deltaY: wheel.deltaY
      });
      if (this.buffer.active.type !== "alternate") {
        return;
      }
      const code = wheel.deltaY < 0 ? 64 : 65;
      const report = `\u001b[<${code};1;1M`.repeat(Math.abs(Math.round(wheel.deltaY)));
      if (report) {
        this.emitData(report);
      }
    });
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter(
          (candidate) => candidate !== listener
        );
      }
    };
  }

  onBinary(listener: (data: string) => void): { dispose(): void } {
    this.binaryListeners.push(listener);
    return {
      dispose: () => {
        this.binaryListeners = this.binaryListeners.filter(
          (candidate) => candidate !== listener
        );
      }
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitBinary(data: string): void {
    for (const listener of this.binaryListeners) listener(data);
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

  onSelectionChange(listener: () => void): { dispose(): void } {
    this.selectionListeners.push(listener);
    return {
      dispose: () => {
        this.selectionListeners = this.selectionListeners.filter(
          (candidate) => candidate !== listener
        );
      }
    };
  }

  select(column: number, row: number, length: number): void {
    this.selectionCalls.push({ column, row, length });
    const endOffset = column + length;
    const endRow = row + Math.floor(endOffset / this.cols);
    const endColumn = endOffset % this.cols;
    const selectedLines: string[] = [];
    for (let lineIndex = row; lineIndex <= endRow; lineIndex += 1) {
      const line = this.bufferLines.get(lineIndex) ?? "";
      const start = lineIndex === row ? column : 0;
      const end = lineIndex === endRow ? endColumn : line.length;
      selectedLines.push(line.slice(start, end).trimEnd());
    }
    this.selection = selectedLines.join("\n");
    for (const listener of this.selectionListeners) listener();
  }

  getSelection(): string {
    return this.selection;
  }

  clearSelection(): void {
    this.clearSelectionCalls += 1;
    this.selection = "";
    for (const listener of this.selectionListeners) listener();
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
        : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(
              new Uint8Array(
                data.buffer,
                data.byteOffset,
                data.byteLength
              )
            )
          : "";
    const parts = text.replace(/\r\n|\r/g, "\n").split("\n");
    const lines =
      this.buffer.active.type === "normal"
        ? this.bufferLines
        : this.alternateBufferLines;
    let lineIndex = Math.max(0, this.buffer.active.length - 1);
    const firstLine = lines.get(lineIndex) ?? "";
    lines.set(lineIndex, firstLine + (parts.shift() ?? ""));
    for (const part of parts) {
      lineIndex += 1;
      lines.set(lineIndex, part);
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
    this.alternateBufferLines.clear();
    for (const buffer of [this.buffer.normal, this.buffer.alternate]) {
      buffer.baseY = 0;
      buffer.viewportY = 0;
      buffer.length = 0;
    }
    this.buffer.active = this.buffer.normal;
  }

  useAlternateBuffer(): void {
    this.buffer.active = this.buffer.alternate;
  }

  useNormalBuffer(): void {
    this.buffer.active = this.buffer.normal;
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

function lastMessageOfType(messages: string[], type: string): unknown {
  return messages
    .map((message) => JSON.parse(message))
    .findLast((message) => message.type === type);
}

function createTouchEvent(
  window: Window,
  type: string,
  touches: TouchPoint[],
  options: EventInit = { bubbles: true, cancelable: true },
  changedTouches: TouchPoint[] = touches
): Event {
  const event = new window.Event(type, options);
  Object.defineProperties(event, {
    touches: {
      configurable: true,
      value: touches
    },
    changedTouches: {
      configurable: true,
      value: changedTouches
    }
  });
  return event;
}

function tapTerminal(
  window: Window,
  viewport: HTMLElement,
  point: TouchPoint,
  at: number
): void {
  tapElement(window, viewport, point, at);
}

function tapElement(
  window: Window,
  target: HTMLElement,
  point: TouchPoint,
  at: number
): void {
  const windowDate = (window as unknown as { Date: DateConstructor }).Date;
  const now = vi.spyOn(windowDate, "now").mockReturnValue(at);
  try {
    target.dispatchEvent(createTouchEvent(window, "touchstart", [point]));
    target.dispatchEvent(
      createTouchEvent(window, "touchend", [], undefined, [point])
    );
  } finally {
    now.mockRestore();
  }
}

function activateLinkAt(
  window: Window,
  link: StubTerminalLink,
  at: number
): void {
  const windowDate = (window as unknown as { Date: DateConstructor }).Date;
  const now = vi.spyOn(windowDate, "now").mockReturnValue(at);
  try {
    link.activate();
  } finally {
    now.mockRestore();
  }
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
  window.setTimeout = globalThis.setTimeout.bind(globalThis) as typeof window.setTimeout;
  window.clearTimeout = globalThis.clearTimeout.bind(
    globalThis
  ) as typeof window.clearTimeout;
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
  it("provides conservative source-file links with line suffixes", () => {
    const { messages, terminal } = createExecutedTerminalDocument();
    const row = 7;
    const line =
      "See README.md. app.tsx config.json docs/SPEC.MD:42:7 src/lib.rs image.png ../escape.ts /tmp/task/code.rs:9";

    const links = provideLinks(terminal, row, line);

    expect(links?.map((link) => link.text)).toEqual([
      "README.md",
      "app.tsx",
      "config.json",
      "docs/SPEC.MD:42:7",
      "src/lib.rs",
      "/tmp/task/code.rs:9"
    ]);
    expect(links?.map((link) => link.range)).toEqual(
      [
        "README.md",
        "app.tsx",
        "config.json",
        "docs/SPEC.MD:42:7",
        "src/lib.rs",
        "/tmp/task/code.rs:9"
      ].map((text) => {
        const start = line.indexOf(text);
        return {
          start: { x: start + 1, y: row },
          end: { x: start + text.length, y: row }
        };
      })
    );
    expect(links?.every((link) =>
      link.decorations.pointerCursor && link.decorations.underline
    )).toBe(true);

    expect(
      messages.map((message) => JSON.parse(message).type)
    ).not.toContain("terminal-file-link");

    links?.[3]?.activate();
    expect(JSON.parse(messages.at(-1) ?? "null")).toEqual({
      type: "terminal-file-link",
      path: "docs/SPEC.MD",
      line: 42
    });
  });

  it("tracks source-file mentions as a reverse-chronological MRU without file-strip markup", async () => {
    vi.useFakeTimers();
    try {
      const { messages, window } = createExecutedTerminalDocument();

      window.__replaceTerminalState({
        text: "Older src/Old.ts:2 then README.md\n"
      });
      await vi.runAllTimersAsync();
      window.__appendTerminalChunk({
        chunksB64: [b64("Changed src/New.tsx:42:7 and src/Old.ts:9\n")]
      });
      await vi.runAllTimersAsync();

      expect(lastMessageOfType(messages, "terminal-file-mentions")).toEqual({
        type: "terminal-file-mentions",
        mentions: [
          { raw: "src/Old.ts:9", path: "src/Old.ts", line: 9 },
          { raw: "src/New.tsx:42:7", path: "src/New.tsx", line: 42 },
          { raw: "README.md", path: "README.md" }
        ],
        overflow: false
      });
      expect(window.document.getElementById("terminal-file-links")).toBeNull();
      expect(messages.map((message) => JSON.parse(message).type))
        .not.toContain("terminal-file-links");
    } finally {
      vi.useRealTimers();
    }
  });

  it("promotes a later identical mention without increasing the bounded history", async () => {
    vi.useFakeTimers();
    try {
      const { messages, window } = createExecutedTerminalDocument();

      window.__replaceTerminalState({ text: "A.ts\nB.ts\n" });
      await vi.runAllTimersAsync();
      window.__appendTerminalChunk({ chunksB64: [b64("A.ts\n")] });
      await vi.runAllTimersAsync();

      expect(lastMessageOfType(messages, "terminal-file-mentions")).toEqual({
        type: "terminal-file-mentions",
        mentions: [
          { raw: "A.ts", path: "A.ts" },
          { raw: "B.ts", path: "B.ts" }
        ],
        overflow: false
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reorder or repost mentions from unchanged overlap or redraw scans", async () => {
    vi.useFakeTimers();
    try {
      const { messages, window } = createExecutedTerminalDocument();

      window.__replaceTerminalState({ text: "A.ts\nB.ts\n" });
      await vi.runAllTimersAsync();
      const mentionMessagesBeforeOverlap = messages.filter(
        (message) => JSON.parse(message).type === "terminal-file-mentions"
      );

      window.__appendTerminalChunk({ chunksB64: [b64("ordinary output\n")] });
      await vi.runAllTimersAsync();
      window.__appendTerminalChunk({ chunksB64: [b64("redrawn output")] });
      await vi.runAllTimersAsync();

      const mentionMessagesAfterOverlap = messages.filter(
        (message) => JSON.parse(message).type === "terminal-file-mentions"
      );
      expect(mentionMessagesAfterOverlap).toEqual(mentionMessagesBeforeOverlap);
      expect(lastMessageOfType(messages, "terminal-file-mentions")).toEqual({
        type: "terminal-file-mentions",
        mentions: [
          { raw: "B.ts", path: "B.ts" },
          { raw: "A.ts", path: "A.ts" }
        ],
        overflow: false
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains twenty unique mentions and reports overflow", async () => {
    vi.useFakeTimers();
    try {
      const { messages, window } = createExecutedTerminalDocument();
      window.__replaceTerminalState({
        text: Array.from(
          { length: 21 },
          (_, index) => `src/File${index}.ts`
        ).join("\n")
      });
      await vi.runAllTimersAsync();

      const history = lastMessageOfType(
        messages,
        "terminal-file-mentions"
      ) as { mentions: unknown[]; overflow: boolean };
      expect(history.mentions).toHaveLength(20);
      expect(history.overflow).toBe(true);
      expect(history.mentions[0]).toEqual({
        raw: "src/File20.ts",
        path: "src/File20.ts"
      });
    } finally {
      vi.useRealTimers();
    }
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

  it("scans only the appended normal-buffer delta plus two overlap rows", async () => {
    vi.useFakeTimers();
    try {
      const { terminal, window } = createExecutedTerminalDocument();
      window.__replaceTerminalState({ text: "zero.ts\none.ts\ntwo.ts\n" });
      await vi.runAllTimersAsync();
      terminal.getLineCalls = [];
      const previousLength = terminal.buffer.normal.length;

      window.__appendTerminalChunk({
        chunksB64: [b64("three.ts\n")]
      });
      await vi.runAllTimersAsync();

      expect(terminal.getLineCalls).toEqual(
        Array.from(
          { length: terminal.buffer.normal.length - (previousLength - 2) },
          (_, offset) => previousLength - 2 + offset
        )
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces rapid appends into one mention scan", async () => {
    vi.useFakeTimers();
    try {
      const { terminal, window } = createExecutedTerminalDocument();
      window.__replaceTerminalState({ text: "base.ts\n" });
      await vi.runAllTimersAsync();
      terminal.getLineCalls = [];

      window.__appendTerminalChunk({ chunksB64: [b64("one.ts\n")] });
      window.__appendTerminalChunk({ chunksB64: [b64("two.ts\n")] });
      window.__appendTerminalChunk({ chunksB64: [b64("three.ts\n")] });
      expect(terminal.getLineCalls).toEqual([]);
      await vi.runAllTimersAsync();

      expect(terminal.getLineCalls).toEqual(
        Array.from(
          { length: terminal.buffer.normal.length },
          (_, index) => index
        )
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds replacement reconstruction and stops once overflow is known", async () => {
    vi.useFakeTimers();
    try {
      const first = createExecutedTerminalDocument();
      first.window.__replaceTerminalState({
        text: Array.from({ length: 1_100 }, () => "ordinary output").join("\n")
      });
      await vi.runAllTimersAsync();
      expect(first.terminal.getLineCalls).toHaveLength(1_000);

      const second = createExecutedTerminalDocument();
      second.window.__replaceTerminalState({
        text: Array.from(
          { length: 1_100 },
          (_, index) => `src/File${index}.ts`
        ).join("\n")
      });
      await vi.runAllTimersAsync();
      expect(second.terminal.getLineCalls.length).toBeLessThanOrEqual(22);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks alternate-buffer mentions without reposting unchanged history", async () => {
    vi.useFakeTimers();
    try {
      const { messages, terminal, window } = createExecutedTerminalDocument();
      window.__replaceTerminalState({ text: "src/Existing.ts\n" });
      await vi.runAllTimersAsync();
      const initialMessages = messages.filter(
        (message) => JSON.parse(message).type === "terminal-file-mentions"
      ).length;

      terminal.useAlternateBuffer();
      window.__appendTerminalChunk({
        chunksB64: [b64("src/AlternateOnly.ts\n")]
      });
      await vi.runAllTimersAsync();
      terminal.useNormalBuffer();
      window.__appendTerminalChunk({ chunksB64: [b64("ordinary output\n")] });
      await vi.runAllTimersAsync();

      expect(messages.filter(
        (message) => JSON.parse(message).type === "terminal-file-mentions"
      )).toHaveLength(initialMessages + 1);
      expect(lastMessageOfType(messages, "terminal-file-mentions")).toEqual({
        type: "terminal-file-mentions",
        mentions: [
          {
            raw: "src/AlternateOnly.ts",
            path: "src/AlternateOnly.ts"
          },
          {
            raw: "src/Existing.ts",
            path: "src/Existing.ts"
          }
        ],
        overflow: false
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks mentions when terminal output rewrites rows without growing scrollback", async () => {
    vi.useFakeTimers();
    try {
      const { messages, terminal, window } = createExecutedTerminalDocument();
      window.__replaceTerminalState({ text: "ordinary output\n" });
      await vi.runAllTimersAsync();
      const previousLength = terminal.buffer.normal.length;

      window.__appendTerminalChunk({
        chunksB64: [b64("src/Rewritten.ts:14")]
      });
      expect(terminal.buffer.normal.length).toBe(previousLength);
      await vi.runAllTimersAsync();

      expect(lastMessageOfType(messages, "terminal-file-mentions")).toEqual({
        type: "terminal-file-mentions",
        mentions: [{
          raw: "src/Rewritten.ts:14",
          path: "src/Rewritten.ts",
          line: 14
        }],
        overflow: false
      });
    } finally {
      vi.useRealTimers();
    }
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
    expect(script).toContain(
      "const MAX_INITIAL_FILE_MENTION_SCAN_ROWS = 1000;"
    );
    expect(script).toMatch(
      /normalBuffer\(\)\.length\s*-\s*MAX_INITIAL_FILE_MENTION_SCAN_ROWS/
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
    expect(inspections.length).toBeGreaterThanOrEqual(2);
    expect(script).toContain("term.buffer.active");
    expect(script).toContain("recordTerminalFrame");
    expect(inspections.at(-1)?.inspection).toMatchObject({
      byteCount: 25,
      frameCount: 2,
      mentionedFiles: {
        mentions: [],
        overflow: false
      }
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
    expect(html).toContain('type: "terminal-content-ready"');
    expect(html).toContain('type: "terminal-tap"');
    expect(html).toContain('viewport.addEventListener("pointerdown"');
    expect(html).toContain("term.onScroll");
    expect(html).toContain("window.__setTerminalBottomInset");
    expect(html).toContain("viewport.style.paddingBottom");
    expect(html).not.toContain('terminalViewport.addEventListener("scroll"');
    expect(html).not.toContain("terminalViewport.style.bottom");
    expect(html).not.toContain("<pre id=\"terminal\"></pre>");
  });

  it("acknowledges the applied terminal content revision through the native bridge", () => {
    const { messages, terminal, window } = createExecutedTerminalDocument();

    window.__replaceTerminalState({
      contentRevision: 23,
      text: "rendered snapshot"
    });

    expect(terminal.writes).toContain("rendered snapshot");
    expect(lastMessageOfType(messages, "terminal-content-ready")).toEqual({
      type: "terminal-content-ready",
      contentRevision: 23
    });
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

  it("does not select terminal text after only one tap", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, "alpha selected omega");

    tapTerminal(window, viewport, { clientX: 9 * 9, clientY: 18 * 2 + 9 }, 1_000);

    expect(terminal.selectionCalls).toEqual([]);
  });

  it("selects the terminal word under a qualifying double tap", () => {
    const { messages, terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, "alpha selected omega");

    tapTerminal(window, viewport, { clientX: 9 * 7, clientY: 18 * 2 + 9 }, 1_000);
    tapTerminal(window, viewport, { clientX: 9 * 9, clientY: 18 * 2 + 9 }, 1_200);

    expect(terminal.selectionCalls.at(-1)).toEqual({ column: 6, row: 2, length: 8 });
    expect(terminal.getSelection()).toBe("selected");
    expect(messages.map((value) => JSON.parse(value))).toContainEqual({
      type: "terminal-selection-change",
      text: "selected"
    });
  });

  it("opens a registered Markdown link after a settled single tap", async () => {
    const { messages, terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    const line = "docs/spec.md suffix";
    const link = provideLinks(terminal, 3, line)?.[0];
    expect(link).toBeDefined();
    const point = { clientX: 9 * 3 + 4, clientY: 18 * 2 + 9 };

    tapTerminal(window, viewport, point, 1_000);
    activateLinkAt(window, link!, 1_010);

    expect(messages.map((value) => JSON.parse(value).type)).not.toContain(
      "terminal-file-link"
    );

    await new Promise<void>((resolve) => window.setTimeout(resolve, 320));

    expect(messages.map((value) => JSON.parse(value))).toContainEqual({
      type: "terminal-file-link",
      path: "docs/spec.md"
    });
  });

  it("selects a registered Markdown link on double tap without opening it", async () => {
    const { messages, terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    const line = "docs/spec.md suffix";
    const link = provideLinks(terminal, 3, line)?.[0];
    expect(link).toBeDefined();
    const point = { clientX: 9 * 3 + 4, clientY: 18 * 2 + 9 };

    tapTerminal(window, viewport, point, 1_000);
    activateLinkAt(window, link!, 1_010);
    tapTerminal(window, viewport, point, 1_180);
    activateLinkAt(window, link!, 1_190);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 320));

    expect(terminal.getSelection()).toBe("docs/spec.md");
    expect(messages.map((value) => JSON.parse(value))).toContainEqual({
      type: "terminal-selection-change",
      text: "docs/spec.md"
    });
    expect(messages.map((value) => JSON.parse(value).type)).not.toContain(
      "terminal-file-link"
    );
  });

  it("selects one separator cell when double tapping whitespace", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, "alpha selected");
    const point = { clientX: 9 * 5 + 4, clientY: 18 * 2 + 9 };

    tapTerminal(window, viewport, point, 1_000);
    tapTerminal(window, viewport, point, 1_150);

    expect(terminal.selectionCalls.at(-1)).toEqual({ column: 5, row: 2, length: 1 });
  });

  it.each([
    ["too slowly", { secondAt: 1_301, secondX: 9 * 9 + 4 }],
    ["too far apart", { secondAt: 1_200, secondX: 9 * 9 + 4 + 25 }]
  ])("does not select terminal text when taps land %s", (_label, second) => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, "alpha selected omega");
    const first = { clientX: 9 * 9 + 4, clientY: 18 * 2 + 9 };

    tapTerminal(window, viewport, first, 1_000);
    tapTerminal(
      window,
      viewport,
      { clientX: second.secondX, clientY: first.clientY },
      second.secondAt
    );

    expect(terminal.selectionCalls).toEqual([]);
  });

  it.each([
    ["wide", "界 selected", 3],
    ["combining", "e\u0301 selected", 2]
  ])("maps a word after a %s character to terminal cells", (_label, line, startColumn) => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, line);
    const point = { clientX: 9 * (startColumn + 2), clientY: 18 * 2 + 9 };

    tapTerminal(window, viewport, point, 1_000);
    tapTerminal(window, viewport, point, 1_180);

    expect(terminal.selectionCalls.at(-1)).toEqual({
      column: startColumn,
      row: 2,
      length: 8
    });
  });

  it("extends a selected word forward without scrolling the terminal", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, "alpha selected omega");
    const selectedPoint = { clientX: 9 * 9 + 4, clientY: 18 * 2 + 9 };
    tapTerminal(window, viewport, selectedPoint, 1_000);
    tapTerminal(window, viewport, selectedPoint, 1_180);
    terminal.scrollToLineCalls = [];
    viewport.scrollLeft = 12;

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [selectedPoint]));
    const move = createTouchEvent(window, "touchmove", [
      { clientX: 9 * 19 + 4, clientY: 18 * 2 + 9 }
    ]);
    viewport.dispatchEvent(move);

    expect(terminal.selectionCalls.at(-1)).toEqual({ column: 6, row: 2, length: 14 });
    expect(terminal.getSelection()).toBe("selected omega");
    expect(terminal.scrollToLineCalls).toEqual([]);
    expect(viewport.scrollLeft).toBe(12);
    expect(move.defaultPrevented).toBe(true);
  });

  it("extends a selected word backward from its original anchor", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, "alpha selected omega");
    const selectedPoint = { clientX: 9 * 9 + 4, clientY: 18 * 2 + 9 };
    tapTerminal(window, viewport, selectedPoint, 1_000);
    tapTerminal(window, viewport, selectedPoint, 1_180);
    terminal.scrollToLineCalls = [];

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [selectedPoint]));
    const move = createTouchEvent(window, "touchmove", [
      { clientX: 9 * 1 + 4, clientY: 18 * 2 + 9 }
    ]);
    viewport.dispatchEvent(move);

    expect(terminal.selectionCalls.at(-1)).toEqual({ column: 1, row: 2, length: 13 });
    expect(terminal.getSelection()).toBe("lpha selected");
    expect(terminal.scrollToLineCalls).toEqual([]);
  });

  it("extends a selected word across visible terminal rows", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, "alpha selected omega");
    terminal.bufferLines.set(3, "later row");
    const selectedPoint = { clientX: 9 * 9 + 4, clientY: 18 * 2 + 9 };
    tapTerminal(window, viewport, selectedPoint, 1_000);
    tapTerminal(window, viewport, selectedPoint, 1_180);
    terminal.scrollToLineCalls = [];

    viewport.dispatchEvent(createTouchEvent(window, "touchstart", [selectedPoint]));
    const move = createTouchEvent(window, "touchmove", [
      { clientX: 9 * 4 + 4, clientY: 18 * 3 + 9 }
    ]);
    viewport.dispatchEvent(move);

    expect(terminal.selectionCalls.at(-1)).toEqual({ column: 6, row: 2, length: 219 });
    expect(terminal.getSelection()).toBe("selected omega\nlater");
    expect(terminal.scrollToLineCalls).toEqual([]);
  });

  it("does not resume sticky-bottom following while selection mode is active", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = terminal.buffer.active.baseY - 1;
    terminal.bufferLines.set(terminal.buffer.active.viewportY, "selected output");
    const point = { clientX: 9 * 3 + 4, clientY: 9 };
    tapTerminal(window, viewport, point, 1_000);
    tapTerminal(window, viewport, point, 1_180);
    const initialScrollToBottomCalls = terminal.scrollToBottomCalls;

    window.__appendTerminalChunk({ chunksB64: [b64("new output\n")] });

    expect(terminal.scrollToBottomCalls).toBe(initialScrollToBottomCalls);
  });

  it("clears selection on replace and restores ordinary drag scrolling after cancel", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.buffer.active.viewportY = 0;
    terminal.bufferLines.set(2, "alpha selected omega");
    const point = { clientX: 9 * 9 + 4, clientY: 18 * 2 + 9 };
    tapTerminal(window, viewport, point, 1_000);
    tapTerminal(window, viewport, point, 1_180);

    window.__replaceTerminalState({ text: "replacement" });
    expect(terminal.getSelection()).toBe("");
    expect(terminal.clearSelectionCalls).toBe(1);

    terminal.buffer.active.baseY = 100;
    terminal.buffer.active.viewportY = 76;
    terminal.buffer.active.length = 101;
    terminal.scrollToLineCalls = [];
    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 195 }])
    );
    expect(terminal.scrollToLineCalls).toEqual([79]);
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

  it("replays alt-screen vertical drags as forwarded wheel input instead of scrollback scrolling", () => {
    const { terminal, viewport, window, messages } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    const touchMove = createTouchEvent(window, "touchmove", [
      { clientX: 220, clientY: 195 }
    ]);
    viewport.dispatchEvent(touchMove);

    // 45px of upward drag over 18px cells forwards 2 whole wheel-down lines,
    // one per-click wheel event each.
    expect(terminal.scrollToLineCalls).toEqual([]);
    expect(terminal.wheelEvents).toEqual([
      expect.objectContaining({ deltaMode: 1, deltaY: 1 }),
      expect.objectContaining({ deltaMode: 1, deltaY: 1 })
    ]);
    const inputs = messages
      .map((message) => JSON.parse(message) as { type: string; dataB64?: string })
      .filter((message) => message.type === "terminal-input");
    expect(inputs).toHaveLength(1);
    expect(
      Buffer.from(inputs[0].dataB64 ?? "", "base64").toString("latin1")
    ).toBe("\u001b[<65;1;1M\u001b[<65;1;1M");
    expect(touchMove.defaultPrevented).toBe(true);
  });

  it("accumulates sub-cell alt-screen drags and forwards opposite directions as wheel up", () => {
    const { terminal, viewport, window, messages } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();
    // Already panned to the top of the frame, so the drag has no clipped rows
    // left to uncover and every pixel reaches the TUI.
    viewport.scrollTop = 0;

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 250 }])
    );
    expect(terminal.wheelEvents).toEqual([]);

    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 262 }])
    );
    expect(terminal.wheelEvents).toEqual([
      expect.objectContaining({ deltaMode: 1, deltaY: -1 })
    ]);
    const inputs = messages
      .map((message) => JSON.parse(message) as { type: string; dataB64?: string })
      .filter((message) => message.type === "terminal-input");
    expect(inputs).toHaveLength(1);
    expect(
      Buffer.from(inputs[0].dataB64 ?? "", "base64").toString("latin1")
    ).toBe("\u001b[<64;1;1M");
  });

  it("keeps normal-buffer drags on local scrollback without forwarding PTY input", () => {
    const { terminal, viewport, window, messages } = createExecutedTerminalDocument();
    terminal.scrollToLine(76);
    terminal.scrollToLineCalls = [];

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 195 }])
    );

    expect(terminal.scrollToLineCalls).toEqual([79]);
    expect(terminal.wheelEvents).toEqual([]);
    expect(viewport.scrollTop).toBe(156);
    const inputs = messages
      .map((message) => JSON.parse(message) as { type: string })
      .filter((message) => message.type === "terminal-input");
    expect(inputs).toEqual([]);
  });

  it("uncovers the alt-screen rows clipped above the composer before forwarding wheel input", () => {
    const { terminal, viewport, window, messages } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();
    expect(viewport.scrollTop).toBe(156);

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    const touchMove = createTouchEvent(window, "touchmove", [
      { clientX: 220, clientY: 300 }
    ]);
    viewport.dispatchEvent(touchMove);

    // 60px of downward drag is absorbed by the 156px of frame the composer
    // safe region hides, so nothing is replayed to the TUI.
    expect(viewport.scrollTop).toBe(96);
    expect(terminal.wheelEvents).toEqual([]);
    expect(terminal.scrollToLineCalls).toEqual([]);
    expect(
      messages
        .map((message) => JSON.parse(message) as { type: string })
        .filter((message) => message.type === "terminal-input")
    ).toEqual([]);
    expect(touchMove.defaultPrevented).toBe(true);
  });

  it("chains the drag left over past a fully uncovered alt-screen frame to the PTY", () => {
    const { terminal, viewport, window, messages } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 432 }])
    );

    // 192px of drag: 156px uncovers the frame, the remaining 36px is two
    // 18px cells of wheel-up replayed to the TUI.
    expect(viewport.scrollTop).toBe(0);
    expect(terminal.wheelEvents).toEqual([
      expect.objectContaining({ deltaMode: 1, deltaY: -1 }),
      expect.objectContaining({ deltaMode: 1, deltaY: -1 })
    ]);
    const inputs = messages
      .map((message) => JSON.parse(message) as { type: string; dataB64?: string })
      .filter((message) => message.type === "terminal-input");
    expect(inputs).toHaveLength(1);
    expect(
      Buffer.from(inputs[0].dataB64 ?? "", "base64").toString("latin1")
    ).toBe("\u001b[<64;1;1M\u001b[<64;1;1M");
  });

  it("holds an uncovered alt-screen frame in place while the TUI keeps redrawing", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 300 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchend", [], undefined, [
        { clientX: 220, clientY: 300 }
      ])
    );
    expect(viewport.scrollTop).toBe(96);

    window.__appendTerminalChunk({ chunksB64: [b64("redrawn frame")] });

    expect(viewport.scrollTop).toBe(96);
  });

  it("hands the viewport back to the safe region when the TUI leaves the alternate screen", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 300 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchend", [], undefined, [
        { clientX: 220, clientY: 300 }
      ])
    );
    expect(viewport.scrollTop).toBe(96);

    // The agent exits, restoring the normal buffer: its closing output must
    // not stay stranded under the composer.
    terminal.useNormalBuffer();
    window.__appendTerminalChunk({ chunksB64: [b64("agent exited\n")] });

    expect(viewport.scrollTop).toBe(156);

    window.__appendTerminalChunk({ chunksB64: [b64("final summary\n")] });
    expect(viewport.scrollTop).toBe(156);

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 300 }])
    );
    window.__appendTerminalChunk({ chunksB64: [b64("still following\n")] });

    expect(viewport.scrollTop).toBe(156);
  });

  it("releases a pan once the alternate-screen frame stops overflowing", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 300 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchend", [], undefined, [
        { clientX: 220, clientY: 300 }
      ])
    );
    expect(viewport.scrollTop).toBe(96);

    // The frame comes to fit the safe region exactly — the keyboard closed —
    // so the next drag has nothing left to pan.
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 844
    });
    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 300 }])
    );

    // It overflows again: alignment must own the viewport rather than stay
    // stranded on the pan that no longer has anything to hold.
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 1000
    });
    window.__appendTerminalChunk({ chunksB64: [b64("redrawn frame")] });

    expect(viewport.scrollTop).toBe(156);
  });

  it("re-pins the alt-screen frame to the composer safe region when dragged back down", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 300 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchend", [], undefined, [
        { clientX: 220, clientY: 300 }
      ])
    );
    expect(viewport.scrollTop).toBe(96);

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 300 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 200 }])
    );

    expect(viewport.scrollTop).toBe(156);

    window.__appendTerminalChunk({ chunksB64: [b64("redrawn frame")] });

    expect(viewport.scrollTop).toBe(156);
  });

  it("re-pins an uncovered alt-screen frame when the terminal state is replaced", () => {
    const { terminal, viewport, window } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();

    viewport.dispatchEvent(
      createTouchEvent(window, "touchstart", [{ clientX: 220, clientY: 240 }])
    );
    viewport.dispatchEvent(
      createTouchEvent(window, "touchmove", [{ clientX: 220, clientY: 300 }])
    );
    expect(viewport.scrollTop).toBe(96);

    window.__replaceTerminalState({ chunksB64: [b64("fresh session")] });

    expect(viewport.scrollTop).toBe(156);
  });

  it("ignores terminal data emitted outside an alt-screen scroll dispatch", () => {
    const { terminal, messages } = createExecutedTerminalDocument();
    terminal.useAlternateBuffer();

    terminal.emitData("\u001b[?1u");
    terminal.emitBinary(" ");

    const inputs = messages
      .map((message) => JSON.parse(message) as { type: string })
      .filter((message) => message.type === "terminal-input");
    expect(inputs).toEqual([]);
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

  it("writes base64 terminal chunks as bytes in replace scripts", () => {
    const script = buildTerminalReplaceScript({
      contentRevision: 4,
      output: `${b64("╭── Claude Code ──╮")}\n`,
      status: "live"
    });

    expect(script).toContain(b64("╭── Claude Code ──╮"));
    expect(script).not.toContain("╭── Claude Code ──╮");
    expect(script).not.toContain("â­");
    expect(script).toContain("window.__replaceTerminalState");
    expect(script).toContain("chunksB64");
    expect(script).toContain('"contentRevision":4');
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
      contentRevision: 5,
      output: "",
      status: "connecting"
    });
    const idleScript = buildTerminalReplaceScript({
      contentRevision: 6,
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
      contentRevision: 7,
      output: `${firstFrame}\n${secondFrame}\n`,
      status: "live"
    });

    expect(script).toContain(`"chunksB64":["${firstFrame}","${secondFrame}"]`);
    expect(script).not.toContain(`${firstFrame}\\n${secondFrame}`);
  });

  it("asks for older scrollback only near the top, and only once per gesture", () => {
    const { messages, terminal, window } = createExecutedTerminalDocument();
    const scrollbackRequests = () =>
      messages.filter((message) => message.includes("terminal-scrollback-request"))
        .length;

    const rows = Array.from({ length: 200 }, (_, index) => `row ${index}`).join("\n");
    window.__replaceTerminalState({
      contentRevision: 1,
      chunksB64: [b64(`${rows}\n`)]
    });

    // Parked at the bottom of a long buffer: nothing older is wanted yet.
    terminal.scrollToLine(terminal.buffer.active.baseY);
    const atBottom = scrollbackRequests();

    const windowDate = (window as unknown as { Date: DateConstructor }).Date;
    const later = Date.now() + 60_000;
    const now = vi.spyOn(windowDate, "now").mockReturnValue(later);
    terminal.scrollToLine(0);
    expect(scrollbackRequests()).toBe(atBottom + 1);

    // Debounced: one gesture emits many scroll events, and each one must not
    // become its own request.
    terminal.scrollToLine(1);
    expect(scrollbackRequests()).toBe(atBottom + 1);

    now.mockReturnValue(later + 1_000);
    terminal.scrollToLine(0);
    expect(scrollbackRequests()).toBe(atBottom + 2);
    now.mockRestore();
  });

  it("prepends older scrollback without snapping the reader to the bottom", () => {
    const { terminal, window } = createExecutedTerminalDocument();

    window.__replaceTerminalState({
      contentRevision: 1,
      chunksB64: [b64("newer one\nnewer two\nnewer three\n")]
    });
    terminal.scrollToLine(1);
    const viewportBefore = terminal.buffer.active.viewportY;
    const linesBefore = terminal.buffer.normal.length;
    const resetsBefore = terminal.resets;
    const scrollToBottomBefore = terminal.scrollToBottomCalls;

    window.__prependTerminalScrollback({
      contentRevision: 2,
      chunksB64: [b64("older one\nolder two\nnewer one\nnewer two\nnewer three\n")]
    });

    expect(terminal.resets).toBe(resetsBefore + 1);
    expect(terminal.scrollToBottomCalls).toBe(scrollToBottomBefore);
    // The store refuses a chunk it cannot fit rather than evicting to make
    // room, so a prepend only ever grows the buffer upward: every row that was
    // loaded is still loaded, two arrived above them, and restoring
    // `viewportY + addedRows` therefore lands on the same content.
    expect(terminal.buffer.normal.length).toBe(linesBefore + 2);
    expect(terminal.scrollToLineCalls.at(-1)).toBe(viewportBefore + 2);
    const rendered = [...terminal.bufferLines.values()].join("\n");
    for (const line of ["older one", "older two", "newer one", "newer two", "newer three"]) {
      expect(rendered).toContain(line);
    }
  });

  it("builds prepend scripts that keep the whole buffer in order", () => {
    const script = buildTerminalPrependScript({
      contentRevision: 7,
      output: `${b64("older\n")}\n${b64("newer\n")}`,
      status: "live"
    });

    expect(script).toContain("window.__prependTerminalScrollback(");
    expect(script).toContain(b64("older\n"));
    expect(script).toContain(b64("newer\n"));
    expect(script).toContain('"contentRevision":7');
  });

  it("builds an empty prepend with the chunks shape the page consumes", () => {
    const script = buildTerminalPrependScript({
      contentRevision: 8,
      output: "",
      status: "live"
    });

    expect(script).toContain('"chunksB64":[]');
    expect(script).not.toContain('"text"');
  });

  it("carries pulled scrollback above the snapshot into the injected script", () => {
    const withHistory = prependTerminalScrollback(
      createTerminalOutput(`${b64("window\n")}\n${b64("live\n")}\n`),
      `${b64("older\n")}\n`
    );
    expect(withHistory.accepted).toBe(true);

    const script = buildTerminalPrependScript({
      contentRevision: 8,
      output: withHistory.output,
      status: "live"
    });

    const chunks = JSON.parse(
      script.slice(
        script.indexOf("(") + 1,
        script.lastIndexOf(")")
      )
    ) as { chunksB64: string[] };
    expect(chunks.chunksB64).toEqual([
      b64("older\n"),
      b64("window\n"),
      b64("live\n")
    ]);
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
      contentRevision: 8,
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
