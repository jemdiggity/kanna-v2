import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebViewMessageEvent } from "react-native-webview";
import type { TaskTerminalStatus } from "../state/sessionStore";
import {
  buildTerminalReplaceScript,
  buildTerminalResizeScript
} from "./buildTerminalDocument";

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
  output?: string;
  status?: TaskTerminalStatus;
  cols?: number | null;
  rows?: number | null;
  fullscreen?: boolean;
  bottomInset?: number;
  onConsolePress?: () => void;
  onOpenFile?: (path: string, line?: number) => void;
}): Promise<ElementNode> {
  resetRenderState();
  const { TerminalWebView } = await import("./TerminalWebView");
  const tree = TerminalWebView({
    taskId: input.taskId ?? "task-1",
    output: input.output ?? `${Buffer.from("large snapshot").toString("base64")}\n`,
    status: input.status ?? "live",
    cols: input.cols ?? null,
    rows: input.rows ?? null,
    fullscreen: input.fullscreen,
    bottomInset: input.bottomInset,
    onConsolePress: input.onConsolePress,
    onOpenFile: input.onOpenFile
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

describe("TerminalWebView", () => {
  beforeEach(() => {
    resetTestState();
    vi.resetModules();
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

  it("does not render a native strip for discovered file-list messages", async () => {
    const onOpenFile = vi.fn();
    const webView = await renderTerminalWebView({ onOpenFile });

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-file-links",
          links: [{ raw: "docs/spec.md:42", path: "  docs/spec.md  ", line: 42 }]
        })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({ onOpenFile });

    expect(
      React.Children.toArray(lastTree?.props.children).some(
        (child) =>
          typeof child === "object" && child !== null &&
          "type" in child && (child as ElementNode).type === "ScrollView"
      )
    ).toBe(false);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("ignores terminal file links without a nonblank string path", async () => {
    const onOpenFile = vi.fn();
    const webView = await renderTerminalWebView({ onOpenFile });
    const send = (payload: unknown) => {
      (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
        nativeEvent: { data: JSON.stringify(payload) }
      } as WebViewMessageEvent);
    };

    send({ type: "terminal-file-link", path: "   ", line: 1 });
    send({ type: "terminal-file-link", path: 123, line: 1 });
    send(null);
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: { data: "not-json" }
    } as WebViewMessageEvent);

    expect(onOpenFile).not.toHaveBeenCalled();
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

  it("exposes rendered terminal diagnostics to native E2E automation", async () => {
    vi.stubEnv("EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED", "1");
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
    expect(marker?.props.testID).toBe("mobile.terminal-inspection");
    expect(marker?.props.accessibilityValue).toEqual({
      text: JSON.stringify(inspection)
    });
    expect(stateUpdates).toEqual([inspection]);
    expect((webView.props.source as { html: string }).html).toContain("terminal-inspection");
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
        output,
        status: "live"
      })
    );
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
});
