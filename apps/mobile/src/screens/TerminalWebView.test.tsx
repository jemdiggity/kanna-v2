import React from "react";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebViewMessageEvent } from "react-native-webview";
import type {
  TaskTerminalOutputSnapshot,
  TaskTerminalOutputSource,
  TaskTerminalStatus
} from "../state/sessionStore";
import {
  appendTerminalOutput,
  createTerminalOutput,
  type TerminalOutputLike
} from "../state/terminalOutputBuffer";
import {
  buildTerminalAppendScript,
  buildTerminalDocument,
  buildTerminalReplaceScript,
  buildTerminalResizeScript
} from "./buildTerminalDocument";
import { getTerminalSelectionToolbarTop } from "./terminalSafeArea";
import type { TerminalFileMentionHistory } from "./terminalFileMentions";

interface EffectRecord {
  callback: () => void;
}

interface ElementNode {
  type: unknown;
  props: Record<string, unknown>;
}

const injectedScripts: string[] = [];
const effects: EffectRecord[] = [];
const refs: Array<{ current: unknown }> = [];
const states: unknown[] = [];
const stateUpdates: unknown[] = [];
let hookIndex = 0;
let stateHookIndex = 0;
let lastTree: ElementNode | null = null;

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn<(value: string) => Promise<void>>()
}));
const diagnosticMocks = vi.hoisted(() => ({
  capture: vi.fn()
}));

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useEffect: vi.fn((callback: () => void) => {
      effects.push({ callback });
    }),
    useMemo: vi.fn((factory: () => unknown) => factory()),
    useState: vi.fn((initialValue: unknown) => {
      const index = stateHookIndex;
      stateHookIndex += 1;
      if (states[index] === undefined) {
        states[index] = initialValue;
      }
      return [states[index], (value: unknown) => {
        stateUpdates.push(value);
        states[index] = value;
      }];
    }),
    useRef: vi.fn((initialValue: unknown) => {
      const index = hookIndex;
      hookIndex += 1;
      if (!refs[index]) {
        refs[index] = {
          current:
            index === 0
              ? {
                  injectJavaScript(script: string) {
                    injectedScripts.push(script);
                  }
                }
              : initialValue
        };
      }
      return refs[index];
    })
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

vi.mock("react-native-webview", () => ({
  WebView: "WebView"
}));

vi.mock("expo-clipboard", () => clipboardMocks);
vi.mock("../lib/diagnostics/mobileCrashDiagnostics", () => ({
  captureMobileCrashDiagnostic: diagnosticMocks.capture
}));

function findByAccessibilityLabel(
  node: ElementNode | null,
  label: string
): ElementNode | null {
  if (!node) return null;
  if (node.props.accessibilityLabel === label) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    if (typeof child === "object" && child !== null && "type" in child) {
      const match = findByAccessibilityLabel(child as ElementNode, label);
      if (match) return match;
    }
  }
  return null;
}

function findByType(node: ElementNode | null, type: unknown): ElementNode | null {
  if (!node) return null;
  if (node.type === type) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    if (typeof child === "object" && child !== null && "type" in child) {
      const match = findByType(child as ElementNode, type);
      if (match) return match;
    }
  }
  return null;
}

function resetRenderState() {
  hookIndex = 0;
  stateHookIndex = 0;
  effects.length = 0;
}

function resetTestState() {
  injectedScripts.length = 0;
  effects.length = 0;
  refs.length = 0;
  states.length = 0;
  stateUpdates.length = 0;
  hookIndex = 0;
  stateHookIndex = 0;
  lastTree = null;
}

function runEffects() {
  const pending = [...effects];
  effects.length = 0;
  for (const effect of pending) {
    effect.callback();
  }
}

async function renderTerminalWebView(input: {
  taskId?: string;
  output?: TerminalOutputLike;
  outputEpoch?: number;
  outputStart?: number;
  status?: TaskTerminalStatus;
  cols?: number | null;
  rows?: number | null;
  fullscreen?: boolean;
  bottomInset?: number;
  directInputEnabled?: boolean;
  directInputFocusRequest?: number;
  selectionToolbarTop?: number;
  onConsolePress?: () => void;
  onMentionedFilesChange?: (history: TerminalFileMentionHistory) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onTerminalInput?: (
    dataB64: string,
    kind: "draft" | "submission" | "control"
  ) => void;
  onRequestScrollback?: () => void;
  terminalOutputSource?: TaskTerminalOutputSource;
}): Promise<ElementNode> {
  resetRenderState();
  // The exported TerminalWebView is memoized; this harness drives the component
  // implementation directly against its own hook mocks.
  const { TerminalWebViewComponent } = await import("./TerminalWebView");
  const tree = TerminalWebViewComponent({
    taskId: input.taskId ?? "task-1",
    output: input.output ?? `${Buffer.from("large snapshot").toString("base64")}\n`,
    outputEpoch: input.outputEpoch ?? 1,
    outputStart: input.outputStart ?? 0,
    status: input.status ?? "live",
    cols: input.cols ?? null,
    rows: input.rows ?? null,
    fullscreen: input.fullscreen,
    bottomInset: input.bottomInset,
    directInputEnabled: input.directInputEnabled,
    directInputFocusRequest: input.directInputFocusRequest,
    selectionToolbarTop: input.selectionToolbarTop,
    onConsolePress: input.onConsolePress,
    onMentionedFilesChange: input.onMentionedFilesChange,
    onOpenFile: input.onOpenFile,
    onTerminalInput: input.onTerminalInput,
    onRequestScrollback: input.onRequestScrollback,
    terminalOutputSource: input.terminalOutputSource
  }) as ElementNode;
  lastTree = tree;

  const webView = React.Children.toArray(tree.props.children).find(
    (child): child is ElementNode =>
      typeof child === "object" &&
      child !== null &&
      "type" in child &&
      (child as ElementNode).type === "WebView"
  );

  if (!webView) {
    throw new Error("TerminalWebView did not render a WebView child");
  }

  return webView;
}

function bottomInsetScript(bottomInset: number): string {
  return `window.__setTerminalBottomInset(${JSON.stringify({ bottomInset })}); true;`;
}

interface BurstTerminalBuffer {
  type: "normal" | "alternate";
  baseY: number;
  viewportY: number;
  length: number;
  getLine(): undefined;
}

class BurstTerminal {
  cols: number;
  rows = 42;
  options: { fontSize: number; smoothScrollDuration?: number; wordSeparator?: string };
  resets = 0;
  writes: unknown[] = [];
  focused = false;
  private dataHandler: ((data: string) => void) | null = null;
  private readonly deferredWriteCallbacks: Array<() => void> = [];
  dimensions = {
    css: { cell: { width: 9, height: 18 } }
  };
  private normalBuffer: BurstTerminalBuffer = {
    type: "normal",
    baseY: 0,
    viewportY: 0,
    length: 0,
    getLine: () => undefined
  };
  private alternateBuffer: BurstTerminalBuffer = {
    type: "alternate",
    baseY: 0,
    viewportY: 0,
    length: 0,
    getLine: () => undefined
  };
  buffer = {
    active: this.normalBuffer,
    normal: this.normalBuffer,
    alternate: this.alternateBuffer
  };

  constructor(
    options: {
      cols: number;
      fontSize: number;
      smoothScrollDuration?: number;
    },
    private readonly deferWrites = false
  ) {
    this.cols = options.cols;
    this.options = {
      fontSize: options.fontSize,
      smoothScrollDuration: options.smoothScrollDuration
    };
  }

  loadAddon(): void {}

  open(root: HTMLElement): void {
    const xterm = root.ownerDocument.createElement("div");
    xterm.className = "xterm";
    const screen = root.ownerDocument.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: this.cols * 9,
      height: this.rows * 18,
      top: 0,
      right: this.cols * 9,
      bottom: this.rows * 18,
      left: 0,
      toJSON: () => ({})
    });
    xterm.append(screen);
    root.append(xterm);
  }

  onScroll(): { dispose(): void } {
    return { dispose() {} };
  }

  onData(handler: (data: string) => void): { dispose(): void } {
    this.dataHandler = handler;
    return { dispose() {} };
  }

  onBinary(): { dispose(): void } {
    return { dispose() {} };
  }

  onSelectionChange(): { dispose(): void } {
    return { dispose() {} };
  }

  registerLinkProvider(): { dispose(): void } {
    return { dispose() {} };
  }

  getSelection(): string {
    return "";
  }

  clearSelection(): void {}

  focus(): void {
    this.focused = true;
  }

  blur(): void {
    this.focused = false;
  }

  emitData(data: string): void {
    this.dataHandler?.(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  scrollToBottom(): void {
    this.buffer.active.viewportY = this.buffer.active.baseY;
  }

  scrollToLine(line: number): void {
    this.buffer.active.viewportY = line;
  }

  select(): void {}

  write(data: unknown, done?: () => void): void {
    this.writes.push(data);
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(0);
    let addedLines = 0;
    for (const byte of bytes) {
      if (byte === 10) addedLines += 1;
    }
    this.normalBuffer.length += Math.max(1, addedLines);
    this.normalBuffer.baseY = Math.max(0, this.normalBuffer.length - this.rows);
    this.normalBuffer.viewportY = this.normalBuffer.baseY;
    if (done && this.deferWrites) {
      this.deferredWriteCallbacks.push(done);
    } else {
      done?.();
    }
  }

  flushNextWrite(): void {
    this.deferredWriteCallbacks.shift()?.();
  }

  reset(): void {
    this.resets += 1;
    for (const buffer of [this.normalBuffer, this.alternateBuffer]) {
      buffer.baseY = 0;
      buffer.viewportY = 0;
      buffer.length = 0;
    }
    this.buffer.active = this.normalBuffer;
  }
}

function extractTerminalScript(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1]
  );
  return scripts.at(-1) ?? "";
}

function createBurstTerminalDocument(
  documentOptions: { deferWrites?: boolean } = {}
): {
  messages: unknown[];
  terminal: BurstTerminal;
  window: Window & typeof globalThis;
} {
  const html = buildTerminalDocument({
    bottomInset: 24,
    enableE2EInspection: false
  });
  const window = new Window() as Window & typeof globalThis;
  window.document.documentElement.innerHTML =
    html.match(/<html[^>]*>([\s\S]*)<\/html>/)?.[1] ?? html;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof window.requestAnimationFrame;
  // File-mention debounce work is unrelated to the terminal write bound under
  // test, so keep it pending just as it would be during one continuous burst.
  window.setTimeout = (() => 1) as typeof window.setTimeout;
  window.clearTimeout = (() => undefined) as typeof window.clearTimeout;
  const messages: unknown[] = [];
  window.ReactNativeWebView = {
    postMessage(message: string) {
      messages.push(JSON.parse(message) as unknown);
    }
  };

  let terminal: BurstTerminal | null = null;
  window.Terminal = class extends BurstTerminal {
    constructor(options: {
      cols: number;
      fontSize: number;
      smoothScrollDuration?: number;
    }) {
      super(options, documentOptions.deferWrites ?? false);
      terminal = this;
    }
  };
  window.FitAddon = {
    FitAddon: class {
      proposeDimensions(): { rows: number } {
        return { rows: 42 };
      }
      fit(): void {}
    }
  };

  const viewport = window.document.getElementById("viewport");
  if (!viewport) throw new Error("generated terminal viewport was not rendered");
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 390 },
    clientHeight: { configurable: true, value: 844 },
    scrollHeight: { configurable: true, value: 1000 }
  });
  window.eval(extractTerminalScript(html));
  if (!terminal) throw new Error("generated terminal script did not initialize xterm");
  return { messages, terminal, window };
}

function burstTerminalText(terminal: BurstTerminal): string {
  return terminal.writes
    .map((write) => {
      if (typeof write === "string") return write;
      if (!ArrayBuffer.isView(write)) return "";
      return new TextDecoder().decode(
        new Uint8Array(write.buffer, write.byteOffset, write.byteLength)
      );
    })
    .join("");
}

function resolvedSelectionToolbarTop(tree: ElementNode | null): number | null {
  const toolbar = findByAccessibilityLabel(
    tree,
    "Terminal text selection controls"
  );
  if (!toolbar) return null;
  const style = toolbar.props.style;
  const entries = Array.isArray(style) ? style : [style];
  let top: number | null = null;
  for (const entry of entries) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { top?: unknown }).top === "number"
    ) {
      top = (entry as { top: number }).top;
    }
  }
  return top;
}

describe("TerminalWebView", () => {
  beforeEach(() => {
    resetTestState();
    vi.resetModules();
    clipboardMocks.setStringAsync.mockReset();
    clipboardMocks.setStringAsync.mockResolvedValue(undefined);
    diagnosticMocks.capture.mockReset();
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED;
    vi.unstubAllGlobals();
  });

  it("makes the real terminal WebView inspectable for simulator E2E", async () => {
    process.env.EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED = "1";
    const webView = await renderTerminalWebView({});

    expect(webView.props.webviewDebuggingEnabled).toBe(true);
  });

  it("forwards xterm keyboard data only while direct input is enabled", () => {
    const bridge = createBurstTerminalDocument();
    const directInputWindow = bridge.window as unknown as {
      __setTerminalDirectInput(enabled: boolean): void;
    };
    bridge.messages.length = 0;

    bridge.terminal.emitData("ignored");
    expect(bridge.messages).toEqual([]);

    directInputWindow.__setTerminalDirectInput(true);
    expect(bridge.terminal.focused).toBe(true);
    bridge.terminal.emitData("a");
    bridge.terminal.emitData("\u001b[B");
    bridge.terminal.emitData("\u001b[C");
    bridge.terminal.emitData("\r");

    expect(bridge.messages).toEqual([
      { type: "terminal-input", dataB64: "YQ==", kind: "draft" },
      { type: "terminal-input", dataB64: "G1tC", kind: "draft" },
      { type: "terminal-input", dataB64: "G1tD", kind: "control" },
      { type: "terminal-input", dataB64: "DQ==", kind: "submission" }
    ]);

    directInputWindow.__setTerminalDirectInput(false);
    expect(bridge.terminal.focused).toBe(false);
    bridge.terminal.emitData("ignored again");
    expect(bridge.messages).toHaveLength(4);
  });

  it("captures terminal WebView load and process failures with bounded state", async () => {
    const webView = await renderTerminalWebView({
      taskId: "task-crash",
      output: "encoded-output",
      outputEpoch: 7,
      outputStart: 250_000,
      status: "live",
      cols: 132,
      rows: 48
    });

    webView.props.onError({
      nativeEvent: {
        code: -1,
        description: "WebView load failed",
        domain: "WKErrorDomain",
        url: "about:blank"
      }
    });
    webView.props.onContentProcessDidTerminate({
      nativeEvent: { url: "about:blank" }
    });
    webView.props.onRenderProcessGone({
      nativeEvent: { didCrash: true }
    });

    expect(diagnosticMocks.capture).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "webview-load-error",
        message: "WebView load failed",
        details: expect.objectContaining({
          taskId: "task-crash",
          outputChars: 14,
          outputEpoch: 7,
          outputStart: 250_000,
          cols: 132,
          rows: 48
        })
      })
    );
    expect(diagnosticMocks.capture).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "webview-process-terminated",
        message: "The iOS terminal WebView content process terminated."
      })
    );
    expect(diagnosticMocks.capture).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        kind: "webview-process-terminated",
        message: "The Android terminal WebView render process crashed."
      })
    );
  });

  it("reports validated mention history without rendering a horizontal strip", async () => {
    const onMentionedFilesChange = vi.fn();
    const webView = await renderTerminalWebView({ onMentionedFilesChange });

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-file-mentions",
          mentions: [
            { raw: "src/App.tsx:42", path: "src/App.tsx", line: 42 }
          ],
          overflow: false
        })
      }
    } as WebViewMessageEvent);

    expect(onMentionedFilesChange).toHaveBeenCalledWith({
      mentions: [
        { raw: "src/App.tsx:42", path: "src/App.tsx", line: 42 }
      ],
      overflow: false
    });
    expect(findByType(lastTree, "ScrollView")).toBeNull();
  });

  it("rejects malformed and oversized mention history", async () => {
    const onMentionedFilesChange = vi.fn();
    const webView = await renderTerminalWebView({ onMentionedFilesChange });
    const send = (payload: unknown) => {
      (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: { data: JSON.stringify(payload) }
      } as WebViewMessageEvent);
    };

    send({
      type: "terminal-file-mentions",
      mentions: [{ raw: "forged.ts", path: "different.ts" }],
      overflow: false
    });
    expect(onMentionedFilesChange).toHaveBeenCalledWith({
      mentions: [],
      overflow: false
    });
    onMentionedFilesChange.mockClear();
    send({
      type: "terminal-file-mentions",
      mentions: new Array(22).fill({ raw: "file.ts", path: "file.ts" }),
      overflow: false
    });
    send({
      type: "terminal-file-mentions",
      mentions: [],
      overflow: "false"
    });

    expect(onMentionedFilesChange).not.toHaveBeenCalled();
  });

  it("clears mentioned-file history when switching tasks", async () => {
    const onMentionedFilesChange = vi.fn();
    const webView = await renderTerminalWebView({
      taskId: "task-1",
      onMentionedFilesChange
    });
    runEffects();
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-file-mentions",
          mentions: [{ raw: "src/Old.ts", path: "src/Old.ts" }],
          overflow: false
        })
      }
    } as WebViewMessageEvent);
    onMentionedFilesChange.mockClear();

    await renderTerminalWebView({
      taskId: "task-2",
      onMentionedFilesChange
    });
    runEffects();

    expect(onMentionedFilesChange).toHaveBeenCalledWith({
      mentions: [],
      overflow: false
    });
  });

  it("forwards validated source-file activations and rejects images", async () => {
    const onOpenFile = vi.fn();
    const webView = await renderTerminalWebView({ onOpenFile });
    const send = (payload: unknown) => {
      (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: { data: JSON.stringify(payload) }
      } as WebViewMessageEvent);
    };

    send({ type: "terminal-file-link", path: "   ", line: 1 });
    send({ type: "terminal-file-link", path: 123, line: 1 });
    send({ type: "terminal-file-link", path: "../escape.ts", line: 1 });
    send({ type: "terminal-file-link", path: "assets/logo.png", line: 1 });
    send({ type: "terminal-file-link", path: "src/App.tsx", line: 12 });
    send({ type: "terminal-file-link", path: "config.json" });
    send({ type: "terminal-file-link", path: "src/lib.rs" });
    send(null);
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: { data: "not-json" }
    } as WebViewMessageEvent);

    expect(onOpenFile.mock.calls).toEqual([
      ["src/App.tsx", 12],
      ["config.json"],
      ["src/lib.rs"]
    ]);
  });

  it("omits invalid line values while still forwarding valid paths", async () => {
    const onOpenFile = vi.fn();
    const webView = await renderTerminalWebView({ onOpenFile });

    for (const line of [0, -1, 1.5, "42", null]) {
      (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: {
          data: JSON.stringify({ type: "terminal-file-link", path: "README.md", line })
        }
      } as WebViewMessageEvent);
    }

    expect(onOpenFile).toHaveBeenCalledTimes(5);
    for (const call of onOpenFile.mock.calls) {
      expect(call).toEqual(["README.md"]);
    }
  });

  it("forwards validated alt-screen scroll input frames to the PTY callback", async () => {
    const onTerminalInput = vi.fn();
    const webView = await renderTerminalWebView({ onTerminalInput });
    const send = (payload: unknown) => {
      (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: { data: JSON.stringify(payload) }
      } as WebViewMessageEvent);
    };

    send({
      type: "terminal-input",
      dataB64: "G1s8NjU7MTsxTQ==",
      kind: "control"
    });
    send({ type: "terminal-input", dataB64: "" });
    send({ type: "terminal-input", dataB64: 42 });
    send({ type: "terminal-input", dataB64: "A".repeat(9_000) });
    send({ type: "terminal-input" });
    send({ type: "terminal-input", dataB64: "QQ==", kind: "unknown" });

    expect(onTerminalInput).toHaveBeenCalledOnce();
    expect(onTerminalInput).toHaveBeenCalledWith(
      "G1s8NjU7MTsxTQ==",
      "control"
    );
  });

  it("forwards a near-the-top scroll as a scrollback request", async () => {
    const onRequestScrollback = vi.fn();
    const webView = await renderTerminalWebView({ onRequestScrollback });

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-scrollback-request" })
      }
    } as WebViewMessageEvent);

    expect(onRequestScrollback).toHaveBeenCalledOnce();
  });

  it("splices a scrollback revision above the buffer instead of replacing it", async () => {
    const older = Buffer.from("older scrollback").toString("base64");
    const window = Buffer.from("window").toString("base64");
    const initial = await renderTerminalWebView({
      output: `${window}\n`,
      outputEpoch: 1
    });
    runEffects();
    (initial.props.onMessage as (event: { nativeEvent: { data: string } }) => void)({
      nativeEvent: { data: JSON.stringify({ type: "terminal-ready" }) }
    });
    injectedScripts.length = 0;

    const source = {
      getSnapshot: () => ({
        taskId: "task-1",
        output: createTerminalOutput(`${older}\n${window}\n`),
        outputEpoch: 2,
        outputStart: 0,
        status: "live" as TaskTerminalStatus,
        prependedScrollback: true
      }),
      subscribe: () => () => {}
    };
    await renderTerminalWebView({
      output: `${older}\n${window}\n`,
      outputEpoch: 2,
      terminalOutputSource: source
    });
    runEffects();

    expect(
      injectedScripts.some((script) =>
        script.includes("__prependTerminalScrollback")
      )
    ).toBe(true);
    expect(
      injectedScripts.some((script) => script.includes("__replaceTerminalState"))
    ).toBe(false);
  });

  it("preserves unrelated terminal message handling", async () => {
    const onConsolePress = vi.fn();
    const onOpenFile = vi.fn();
    const webView = await renderTerminalWebView({ onConsolePress, onOpenFile });

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-tap" })
      }
    } as WebViewMessageEvent);

    expect(onConsolePress).toHaveBeenCalledOnce();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("renders native controls for a validated terminal selection", async () => {
    const webView = await renderTerminalWebView({});
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-selection-change",
          text: "selected output"
        })
      }
    } as WebViewMessageEvent);

    await renderTerminalWebView({});

    expect(
      findByAccessibilityLabel(lastTree, "Copy selected terminal text")
    ).not.toBeNull();
    expect(
      findByAccessibilityLabel(lastTree, "Cancel terminal text selection")
    ).not.toBeNull();
  });

  it("positions the selection toolbar at the owner-measured chrome clearance", async () => {
    const webView = await renderTerminalWebView({
      fullscreen: true,
      selectionToolbarTop: 96
    });
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-selection-change",
          text: "selected output"
        })
      }
    } as WebViewMessageEvent);

    await renderTerminalWebView({ fullscreen: true, selectionToolbarTop: 96 });

    expect(resolvedSelectionToolbarTop(lastTree)).toBe(96);
  });

  it("keeps the fullscreen toolbar clear of unmeasured floating chrome", async () => {
    const webView = await renderTerminalWebView({ fullscreen: true });
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-selection-change",
          text: "selected output"
        })
      }
    } as WebViewMessageEvent);

    await renderTerminalWebView({ fullscreen: true });

    expect(resolvedSelectionToolbarTop(lastTree)).toBe(
      getTerminalSelectionToolbarTop(null)
    );
  });

  it("hugs the top of non-fullscreen cards that have no floating chrome", async () => {
    const webView = await renderTerminalWebView({});
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-selection-change",
          text: "selected output"
        })
      }
    } as WebViewMessageEvent);

    await renderTerminalWebView({});

    expect(resolvedSelectionToolbarTop(lastTree)).toBe(12);
  });

  it("ignores malformed and oversized terminal selections", async () => {
    const webView = await renderTerminalWebView({});
    const send = (text: unknown) => {
      (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: {
          data: JSON.stringify({ type: "terminal-selection-change", text })
        }
      } as WebViewMessageEvent);
    };

    send(null);
    send(42);
    send("x".repeat(2_300_001));
    await renderTerminalWebView({});

    expect(
      findByAccessibilityLabel(lastTree, "Copy selected terminal text")
    ).toBeNull();
  });

  it("copies exact terminal text and clears only after clipboard success", async () => {
    let resolveCopy!: () => void;
    clipboardMocks.setStringAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCopy = resolve;
      })
    );
    const webView = await renderTerminalWebView({});
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-selection-change",
          text: "  exact\ntext  "
        })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({});

    const copy = findByAccessibilityLabel(lastTree, "Copy selected terminal text");
    const pending = (copy?.props.onPress as () => Promise<void>)();
    expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith("  exact\ntext  ");
    expect(injectedScripts).not.toContain("window.__clearTerminalSelection(); true;");

    resolveCopy();
    await pending;
    expect(injectedScripts).toContain("window.__clearTerminalSelection(); true;");
  });

  it("keeps selection available when clipboard writing fails", async () => {
    clipboardMocks.setStringAsync.mockRejectedValue(new Error("denied"));
    const webView = await renderTerminalWebView({});
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-selection-change", text: "retry me" })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({});

    await (findByAccessibilityLabel(
      lastTree,
      "Copy selected terminal text"
    )?.props.onPress as () => Promise<void>)();
    await renderTerminalWebView({});

    expect(injectedScripts).not.toContain("window.__clearTerminalSelection(); true;");
    expect(JSON.stringify(lastTree)).toContain("Couldn’t copy. Try again.");
    expect(
      findByAccessibilityLabel(lastTree, "Copy selected terminal text")
    ).not.toBeNull();
  });

  it("cancels terminal selection without writing the clipboard", async () => {
    const webView = await renderTerminalWebView({});
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-selection-change", text: "discard me" })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({});

    (findByAccessibilityLabel(
      lastTree,
      "Cancel terminal text selection"
    )?.props.onPress as () => void)();

    expect(clipboardMocks.setStringAsync).not.toHaveBeenCalled();
    expect(injectedScripts).toContain("window.__clearTerminalSelection(); true;");
  });

  it("clears stale selection when switching tasks or reloading the WebView", async () => {
    const initial = await renderTerminalWebView({ taskId: "task-1" });
    runEffects();
    (initial.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-selection-change", text: "old task" })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({ taskId: "task-1" });
    expect(
      findByAccessibilityLabel(lastTree, "Copy selected terminal text")
    ).not.toBeNull();

    await renderTerminalWebView({ taskId: "task-2" });
    runEffects();
    await renderTerminalWebView({ taskId: "task-2" });
    expect(
      findByAccessibilityLabel(lastTree, "Copy selected terminal text")
    ).toBeNull();

    (initial.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-selection-change", text: "reload" })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({ taskId: "task-2" });
    (initial.props.onLoadStart as () => void)();
    await renderTerminalWebView({ taskId: "task-2" });
    expect(
      findByAccessibilityLabel(lastTree, "Copy selected terminal text")
    ).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "ignores pending clipboard %s after switching tasks",
    async (outcome) => {
      let settleCopy!: () => void;
      clipboardMocks.setStringAsync.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          settleCopy = () => {
            if (outcome === "success") resolve();
            else reject(new Error("denied"));
          };
        })
      );
      const initial = await renderTerminalWebView({ taskId: "task-1" });
      runEffects();
      (initial.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: {
          data: JSON.stringify({
            type: "terminal-selection-change",
            text: "old task selection"
          })
        }
      } as WebViewMessageEvent);
      await renderTerminalWebView({ taskId: "task-1" });
      const pending = (findByAccessibilityLabel(
        lastTree,
        "Copy selected terminal text"
      )?.props.onPress as () => Promise<void>)();

      await renderTerminalWebView({ taskId: "task-2" });

      settleCopy();
      await pending;
      await renderTerminalWebView({ taskId: "task-2" });

      expect(injectedScripts).not.toContain(
        "window.__clearTerminalSelection(); true;"
      );
      expect(JSON.stringify(lastTree)).not.toContain("Couldn’t copy. Try again.");

      runEffects();
      const replacement = await renderTerminalWebView({ taskId: "task-2" });
      (replacement.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: {
          data: JSON.stringify({
            type: "terminal-selection-change",
            text: "replacement selection"
          })
        }
      } as WebViewMessageEvent);
      await renderTerminalWebView({ taskId: "task-2" });
      injectedScripts.length = 0;

      await renderTerminalWebView({ taskId: "task-2" });

      expect(injectedScripts).not.toContain(
        "window.__clearTerminalSelection(); true;"
      );
      expect(JSON.stringify(lastTree)).not.toContain("Couldn’t copy. Try again.");
      expect(
        findByAccessibilityLabel(lastTree, "Copy selected terminal text")
      ).not.toBeNull();
    }
  );

  it.each(["success", "failure"] as const)(
    "ignores pending clipboard %s after the WebView reloads",
    async (outcome) => {
      let settleCopy!: () => void;
      clipboardMocks.setStringAsync.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          settleCopy = () => {
            if (outcome === "success") resolve();
            else reject(new Error("denied"));
          };
        })
      );
      const initial = await renderTerminalWebView({ taskId: "task-1" });
      runEffects();
      (initial.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: {
          data: JSON.stringify({
            type: "terminal-selection-change",
            text: "old document selection"
          })
        }
      } as WebViewMessageEvent);
      const current = await renderTerminalWebView({ taskId: "task-1" });
      const pending = (findByAccessibilityLabel(
        lastTree,
        "Copy selected terminal text"
      )?.props.onPress as () => Promise<void>)();

      (current.props.onLoadStart as () => void)();
      const replacement = await renderTerminalWebView({ taskId: "task-1" });
      (replacement.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: {
          data: JSON.stringify({
            type: "terminal-selection-change",
            text: "replacement selection"
          })
        }
      } as WebViewMessageEvent);
      await renderTerminalWebView({ taskId: "task-1" });
      injectedScripts.length = 0;

      settleCopy();
      await pending;
      await renderTerminalWebView({ taskId: "task-1" });

      expect(injectedScripts).not.toContain(
        "window.__clearTerminalSelection(); true;"
      );
      expect(JSON.stringify(lastTree)).not.toContain("Couldn’t copy. Try again.");
      expect(
        findByAccessibilityLabel(lastTree, "Copy selected terminal text")
      ).not.toBeNull();
    }
  );

  it("allows only one clipboard write for repeated Copy presses", async () => {
    let resolveCopy!: () => void;
    clipboardMocks.setStringAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCopy = resolve;
      })
    );
    const webView = await renderTerminalWebView({});
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-selection-change", text: "copy once" })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({});
    const copy = findByAccessibilityLabel(lastTree, "Copy selected terminal text");

    const first = (copy?.props.onPress as () => Promise<void>)();
    const second = (copy?.props.onPress as () => Promise<void>)();
    await renderTerminalWebView({});

    expect(clipboardMocks.setStringAsync).toHaveBeenCalledTimes(1);
    expect(
      findByAccessibilityLabel(lastTree, "Copy selected terminal text")?.props.disabled
    ).toBe(true);

    resolveCopy();
    await Promise.all([first, second]);
  });

  it("exposes rendered terminal diagnostics to native E2E automation", async () => {
    vi.stubEnv("EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED", "1");
    const webView = await renderTerminalWebView({});
    const inspection = {
      byteCount: 128,
      cols: 80,
      cursorColumn: 4,
      cursorRow: 2,
      frameCount: 2,
      rows: 24,
      text: "SCRIPT_READY"
    };

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-inspection", inspection })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({});

    const marker = React.Children.toArray(lastTree?.props.children).find(
      (child): child is ElementNode =>
        typeof child === "object" &&
        child !== null &&
        "type" in child &&
        (child as ElementNode).type === "Text"
    );
    expect(marker?.props.testID).toBe("mobile.terminal-inspection");
    expect(marker?.props.accessibilityValue).toEqual({
      text: JSON.stringify(inspection)
    });
    expect(stateUpdates).toEqual([inspection]);
    expect((webView.props.source as { html: string }).html).toContain("terminal-inspection");
  });

  it("only relaxes the iOS keyboard gesture gate while direct input is active", async () => {
    const inactive = await renderTerminalWebView({ directInputEnabled: false });
    expect(inactive.props.keyboardDisplayRequiresUserAction).toBe(true);

    const active = await renderTerminalWebView({ directInputEnabled: true });
    expect(active.props.keyboardDisplayRequiresUserAction).toBe(false);
  });

  it("ignores terminal inspection messages and instrumentation outside E2E builds", async () => {
    vi.stubEnv("EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED", "0");
    const webView = await renderTerminalWebView({});
    const inspection = {
      byteCount: 128,
      cols: 80,
      frameCount: 2,
      rows: 24,
      text: "SCRIPT_READY"
    };

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-inspection", inspection })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({});

    const marker = React.Children.toArray(lastTree?.props.children).find(
      (child): child is ElementNode =>
        typeof child === "object" &&
        child !== null &&
        "type" in child &&
        (child as ElementNode).type === "Text"
    );
    expect(marker).toBeUndefined();
    expect(stateUpdates).toEqual([]);
    expect((webView.props.source as { html: string }).html).not.toContain(
      "terminal-inspection"
    );
  });

  it("injects queued PTY dimensions before a queued terminal snapshot once the bridge is ready", async () => {
    const output = `${Buffer.from("large snapshot").toString("base64")}\n`;
    const initialWebView = await renderTerminalWebView({
      output,
      cols: null,
      rows: null
    });
    (initialWebView.props.onLoadStart as () => void)();
    runEffects();

    await renderTerminalWebView({
      output,
      cols: 132,
      rows: 43
    });
    runEffects();

    const readyMessage = {
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-ready" })
      }
    };
    (initialWebView.props.onMessage as (event: typeof readyMessage) => void)(readyMessage);

    expect(injectedScripts[0]).toBe(buildTerminalResizeScript(132, 43));
    expect(injectedScripts).toContain(
      buildTerminalReplaceScript({
        contentRevision: 1,
        output,
        status: "live"
      })
    );
    expect(
      injectedScripts.filter((script) =>
        script.includes("__replaceTerminalState")
      )
    ).toHaveLength(1);
  });

  it("does not let load completion skip retained output received before the terminal effect", async () => {
    const initialOutput = `${Buffer.from("initial snapshot").toString("base64")}\n`;
    const updatedOutput = `${initialOutput}${Buffer.from(
      "submitted command authoritative output"
    ).toString("base64")}\n`;
    const initialWebView = await renderTerminalWebView({ output: initialOutput });
    runEffects();
    (initialWebView.props.onLoadStart as () => void)();

    const updatedWebView = await renderTerminalWebView({ output: updatedOutput });
    // A local WebView document can finish loading before React flushes the
    // effect for output delivered by the terminal stream in the same turn.
    const finishLoading = updatedWebView.props.onLoadEnd;
    if (typeof finishLoading === "function") {
      finishLoading();
    }
    runEffects();
    injectedScripts.length = 0;

    (updatedWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-ready" })
      }
    } as WebViewMessageEvent);

    expect(injectedScripts).toContain(
      buildTerminalReplaceScript({
        contentRevision: 1,
        output: updatedOutput,
        status: "live"
      })
    );
  });

  it("keeps accessible loading feedback until the current snapshot epoch is rendered", async () => {
    const webView = await renderTerminalWebView({
      output: `${Buffer.from("scrollback\n".repeat(20_000)).toString("base64")}\n`,
      outputEpoch: 7
    });

    expect(
      findByAccessibilityLabel(lastTree, "Loading terminal content")?.props
    ).toMatchObject({
      accessibilityLiveRegion: "polite",
      accessibilityRole: "progressbar",
      accessibilityState: { busy: true },
      pointerEvents: "none",
      testID: "mobile.terminal-overlay"
    });

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: { data: JSON.stringify({ type: "terminal-ready" }) }
    } as WebViewMessageEvent);
    await renderTerminalWebView({ outputEpoch: 7 });
    expect(
      findByAccessibilityLabel(lastTree, "Loading terminal content")
    ).not.toBeNull();

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-content-ready",
          contentRevision: 7
        })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({ outputEpoch: 7 });
    expect(
      findByAccessibilityLabel(lastTree, "Loading terminal content")
    ).toBeNull();
  });

  it("ignores stale render acknowledgements and becomes pending again for reconnect snapshots", async () => {
    const initialWebView = await renderTerminalWebView({ outputEpoch: 3 });
    (initialWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-content-ready",
          contentRevision: 3
        })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({ outputEpoch: 3 });
    expect(
      findByAccessibilityLabel(lastTree, "Loading terminal content")
    ).toBeNull();

    const reconnectWebView = await renderTerminalWebView({ outputEpoch: 4 });
    expect(
      findByAccessibilityLabel(lastTree, "Loading terminal content")
    ).not.toBeNull();
    (reconnectWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-content-ready",
          contentRevision: 3
        })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({ outputEpoch: 4 });
    expect(
      findByAccessibilityLabel(lastTree, "Loading terminal content")
    ).not.toBeNull();
  });

  it("finishes empty snapshots and does not return to loading for live output in the same epoch", async () => {
    const webView = await renderTerminalWebView({
      output: "",
      outputEpoch: 9
    });
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-content-ready",
          contentRevision: 9
        })
      }
    } as WebViewMessageEvent);

    await renderTerminalWebView({ output: "", outputEpoch: 9 });
    expect(
      findByAccessibilityLabel(lastTree, "Loading terminal content")
    ).toBeNull();

    await renderTerminalWebView({
      output: `${Buffer.from("first live frame").toString("base64")}\n`,
      outputEpoch: 9
    });
    runEffects();
    expect(
      findByAccessibilityLabel(lastTree, "Loading terminal content")
    ).toBeNull();
  });

  it("coalesces measured insets after resize and before terminal state", async () => {
    const output = `${Buffer.from("large snapshot").toString("base64")}\n`;
    const initialWebView = await renderTerminalWebView({
      output,
      cols: 132,
      rows: 43,
      fullscreen: true,
      bottomInset: 132
    });
    (initialWebView.props.onLoadStart as () => void)();
    runEffects();

    await renderTerminalWebView({
      output,
      cols: 132,
      rows: 43,
      fullscreen: true,
      bottomInset: 212
    });
    runEffects();
    await renderTerminalWebView({
      output,
      cols: 132,
      rows: 43,
      fullscreen: true,
      bottomInset: 526
    });
    runEffects();

    (initialWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-ready" })
      }
    } as WebViewMessageEvent);

    const insetScripts = injectedScripts.filter((script) =>
      script.includes("__setTerminalBottomInset")
    );
    expect(insetScripts).toEqual([bottomInsetScript(526)]);
    expect(injectedScripts[0]).toBe(buildTerminalResizeScript(132, 43));
    expect(injectedScripts[1]).toBe(bottomInsetScript(526));
    expect(injectedScripts.some((script) => script.includes("__replaceTerminalState"))).toBe(
      true
    );
  });

  it("injects measured inset changes immediately after the bridge is ready", async () => {
    const initialWebView = await renderTerminalWebView({
      fullscreen: true,
      bottomInset: 132
    });
    (initialWebView.props.onLoadStart as () => void)();
    runEffects();
    (initialWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({ type: "terminal-ready" })
      }
    } as WebViewMessageEvent);
    injectedScripts.length = 0;

    await renderTerminalWebView({
      fullscreen: true,
      bottomInset: 212
    });
    runEffects();

    expect(injectedScripts).toContain(bottomInsetScript(212));
  });

  it("keeps generated HTML stable when only measured inset changes", async () => {
    const initialWebView = await renderTerminalWebView({
      fullscreen: true,
      bottomInset: 132
    });
    const initialHtml = (initialWebView.props.source as { html: string }).html;

    const multilineWebView = await renderTerminalWebView({
      fullscreen: true,
      bottomInset: 212
    });
    const multilineHtml = (multilineWebView.props.source as { html: string }).html;

    expect(multilineHtml).toBe(initialHtml);
  });

  it("appends the unseen logical suffix when retained history is compacted", async () => {
    const initialWebView = await renderTerminalWebView({
      output: "A\nB\n",
      outputEpoch: 7,
      outputStart: 0
    });
    (initialWebView.props.onLoadStart as () => void)();
    runEffects();
    (initialWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: { data: JSON.stringify({ type: "terminal-ready" }) }
    } as WebViewMessageEvent);
    injectedScripts.length = 0;

    await renderTerminalWebView({
      output: "B\nC\n",
      outputEpoch: 7,
      outputStart: 2
    });
    runEffects();

    expect(injectedScripts).toContain(buildTerminalAppendScript("C\n"));
    expect(injectedScripts.some((script) => script.includes("__replaceTerminalState"))).toBe(
      false
    );
  });

  it("applies authoritative snapshot geometry before replacing its bytes", async () => {
    let sourceSnapshot: TaskTerminalOutputSnapshot = {
      taskId: "task-1",
      cols: 132,
      rows: 43,
      output: createTerminalOutput("d2lkZQ==\n"),
      outputEpoch: 7,
      outputStart: 0,
      status: "live",
      prependedScrollback: false
    };
    let sourceListener: (() => void) | null = null;
    const terminalOutputSource: TaskTerminalOutputSource = {
      getSnapshot: () => sourceSnapshot,
      subscribe(listener) {
        sourceListener = listener;
        return () => {
          sourceListener = null;
        };
      }
    };
    const webView = await renderTerminalWebView({ terminalOutputSource });
    (webView.props.onLoadStart as () => void)();
    runEffects();
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: { data: JSON.stringify({ type: "terminal-ready" }) }
    } as WebViewMessageEvent);
    injectedScripts.length = 0;

    sourceSnapshot = {
      ...sourceSnapshot,
      cols: 180,
      rows: 51,
      output: createTerminalOutput("bmV3IHdpZGUgc25hcHNob3Q=\n"),
      outputEpoch: 8
    };
    sourceListener?.();

    expect(injectedScripts.at(-2)).toBe(buildTerminalResizeScript(180, 51));
    expect(injectedScripts.at(-1)).toContain("__replaceTerminalState");
  });

  it("bounds pre-ready coalescing and steady-state xterm work for large bursts", async () => {
    const frameCount = 2_000;
    const frames = Array.from({ length: frameCount }, (_, index) =>
      `${Buffer.from(`BURST_${String(index + 1).padStart(4, "0")}_${"X".repeat(128)}\r\n`).toString("base64")}\n`
    );
    let preReadyOutput = createTerminalOutput(frames[0]);
    let sourceSnapshot: TaskTerminalOutputSnapshot = {
      taskId: "task-1",
      output: preReadyOutput,
      outputEpoch: 7,
      outputStart: 0,
      status: "live"
    };
    let sourceListener: (() => void) | null = null;
    const terminalOutputSource: TaskTerminalOutputSource = {
      getSnapshot: () => sourceSnapshot,
      subscribe: vi.fn((listener) => {
        sourceListener = listener;
        return () => {
          sourceListener = null;
        };
      })
    };
    const publishOutput = () => {
      sourceSnapshot = { ...sourceSnapshot, output: preReadyOutput };
      sourceListener?.();
    };
    const initialWebView = await renderTerminalWebView({
      output: preReadyOutput,
      outputEpoch: 7,
      terminalOutputSource
    });
    (initialWebView.props.onLoadStart as () => void)();
    runEffects();

    const splitSpy = vi.spyOn(String.prototype, "split");
    const stringifySpy = vi.spyOn(JSON, "stringify");
    for (const frame of frames.slice(1)) {
      preReadyOutput = appendTerminalOutput(preReadyOutput, frame).output;
      publishOutput();
    }

    expect(
      splitSpy.mock.contexts.filter(
        (value) => String(value).length === preReadyOutput.length
      )
    ).toHaveLength(0);
    expect(
      stringifySpy.mock.calls.filter(
        ([value]) =>
          typeof value === "object" &&
          value !== null &&
          "chunksB64" in value &&
          Array.isArray(value.chunksB64) &&
          value.chunksB64.length > 1
      )
    ).toHaveLength(0);
    expect(
      injectedScripts.filter((script) => script.includes("__replaceTerminalState"))
    ).toHaveLength(0);

    (initialWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: { data: JSON.stringify({ type: "terminal-ready" }) }
    } as WebViewMessageEvent);

    const readyScripts = [...injectedScripts];
    expect(
      splitSpy.mock.contexts.filter(
        (value) => String(value).length === preReadyOutput.length
      )
    ).toHaveLength(0);
    expect(
      stringifySpy.mock.calls.filter(
        ([value]) =>
          typeof value === "object" &&
          value !== null &&
          "chunksB64" in value &&
          Array.isArray(value.chunksB64) &&
          value.chunksB64.length === frameCount
      )
    ).toHaveLength(1);
    expect(
      readyScripts.filter((script) => script.includes("__replaceTerminalState"))
    ).toHaveLength(1);

    const bridge = createBurstTerminalDocument();
    for (const script of readyScripts) bridge.window.eval(script);
    expect(bridge.terminal.resets).toBe(1);
    expect(bridge.terminal.writes).toHaveLength(frameCount);

    injectedScripts.length = 0;
    const writesAtReady = bridge.terminal.writes.length;
    const postReadyFrames = frames.map((_frame, index) =>
      `${Buffer.from(`LIVE_${String(index + 1).padStart(4, "0")}_${"Y".repeat(128)}\r\n`).toString("base64")}\n`
    );
    let steadyOutput = preReadyOutput;
    for (const frame of postReadyFrames) {
      steadyOutput = appendTerminalOutput(steadyOutput, frame).output;
      preReadyOutput = steadyOutput;
      publishOutput();
    }

    const terminalMutationScripts = injectedScripts.filter((script) =>
      script.includes("__appendTerminalChunk") ||
      script.includes("__replaceTerminalState")
    );
    expect(terminalMutationScripts).toHaveLength(frameCount);
    expect(
      terminalMutationScripts.every(
        (script) =>
          script.includes("__appendTerminalChunk") &&
          !script.includes("__replaceTerminalState") &&
          script.length < 512
      )
    ).toBe(true);
    expect(
      splitSpy.mock.contexts.filter(
        (value) => String(value).length === steadyOutput.length
      )
    ).toHaveLength(0);
    for (const script of terminalMutationScripts) bridge.window.eval(script);

    splitSpy.mockRestore();
    stringifySpy.mockRestore();
    expect(bridge.terminal.resets).toBe(1);
    expect(bridge.terminal.writes).toHaveLength(writesAtReady + frameCount);
    expect(terminalOutputSource.subscribe).toHaveBeenCalledOnce();
  });

  it("finishes snapshot replay before writing live output that arrives during it", () => {
    const bridge = createBurstTerminalDocument({ deferWrites: true });
    const snapshot = [
      Buffer.from("SNAPSHOT_START\r\n").toString("base64"),
      Buffer.from("SNAPSHOT_END\r\n").toString("base64")
    ].join("\n");
    const liveOutput = `${Buffer.from(
      "USER_INPUT\r\nAGENT_RESPONSE\r\n"
    ).toString("base64")}\n`;

    bridge.window.eval(
      buildTerminalReplaceScript({
        contentRevision: 1,
        output: snapshot,
        status: "live"
      })
    );
    bridge.window.eval(buildTerminalAppendScript(liveOutput));

    expect(bridge.terminal.writes).toHaveLength(1);
    expect(burstTerminalText(bridge.terminal)).toBe("SNAPSHOT_START\r\n");

    bridge.terminal.flushNextWrite();
    expect(bridge.terminal.writes).toHaveLength(2);
    expect(burstTerminalText(bridge.terminal)).toBe(
      "SNAPSHOT_START\r\nSNAPSHOT_END\r\n"
    );

    bridge.terminal.flushNextWrite();
    expect(bridge.terminal.writes).toHaveLength(3);
    expect(burstTerminalText(bridge.terminal)).toBe(
      "SNAPSHOT_START\r\nSNAPSHOT_END\r\nUSER_INPUT\r\nAGENT_RESPONSE\r\n"
    );
  });

  it("does not roll back a direct source frame when stale prop effects run", async () => {
    const initialFrame = `${Buffer.from("FRAME_N\r\n").toString("base64")}\n`;
    const directFrame = `${Buffer.from("FRAME_N_PLUS_1\r\n").toString("base64")}\n`;
    let sourceSnapshot: TaskTerminalOutputSnapshot = {
      taskId: "task-1",
      output: createTerminalOutput(initialFrame),
      outputEpoch: 4,
      outputStart: 0,
      status: "live"
    };
    let sourceListener: (() => void) | null = null;
    const terminalOutputSource: TaskTerminalOutputSource = {
      getSnapshot: () => sourceSnapshot,
      subscribe: (listener) => {
        sourceListener = listener;
        return () => {
          sourceListener = null;
        };
      }
    };
    const initialWebView = await renderTerminalWebView({
      output: sourceSnapshot.output,
      outputEpoch: sourceSnapshot.outputEpoch,
      terminalOutputSource
    });
    (initialWebView.props.onLoadStart as () => void)();
    runEffects();
    (initialWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: { data: JSON.stringify({ type: "terminal-ready" }) }
    } as WebViewMessageEvent);

    const bridge = createBurstTerminalDocument();
    for (const script of injectedScripts) bridge.window.eval(script);
    injectedScripts.length = 0;

    await renderTerminalWebView({
      output: sourceSnapshot.output,
      outputEpoch: sourceSnapshot.outputEpoch,
      terminalOutputSource
    });
    sourceSnapshot = {
      ...sourceSnapshot,
      output: appendTerminalOutput(sourceSnapshot.output, directFrame).output
    };
    sourceListener?.();
    runEffects();

    const terminalMutationScripts = injectedScripts.filter((script) =>
      script.includes("__appendTerminalChunk") ||
      script.includes("__replaceTerminalState")
    );
    expect(terminalMutationScripts).toEqual([
      buildTerminalAppendScript(directFrame)
    ]);
    for (const script of terminalMutationScripts) bridge.window.eval(script);
    expect(bridge.terminal.resets).toBe(1);
    expect(bridge.terminal.writes).toHaveLength(2);
    expect(burstTerminalText(bridge.terminal)).toBe(
      "FRAME_N\r\nFRAME_N_PLUS_1\r\n"
    );
  });

  it("replaces terminal state once when a new snapshot epoch arrives", async () => {
    const initialWebView = await renderTerminalWebView({
      output: "old\n",
      outputEpoch: 2,
      outputStart: 100
    });
    (initialWebView.props.onLoadStart as () => void)();
    runEffects();
    (initialWebView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: { data: JSON.stringify({ type: "terminal-ready" }) }
    } as WebViewMessageEvent);
    injectedScripts.length = 0;

    await renderTerminalWebView({
      output: "fresh\n",
      outputEpoch: 3,
      outputStart: 0
    });
    runEffects();

    expect(injectedScripts).toContain(
      buildTerminalReplaceScript({
        contentRevision: 3,
        output: "fresh\n",
        status: "live"
      })
    );
    expect(
      injectedScripts.filter((script) => script.includes("__replaceTerminalState"))
    ).toHaveLength(1);
  });
});
