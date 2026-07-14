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
}): Promise<ElementNode> {
  resetRenderState();
  const { TerminalWebView } = await import("./TerminalWebView");
  const tree = TerminalWebView({
    taskId: input.taskId ?? "task-1",
    output: input.output ?? `${Buffer.from("large snapshot").toString("base64")}\n`,
    status: input.status ?? "live",
    cols: input.cols ?? null,
    rows: input.rows ?? null
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

describe("TerminalWebView", () => {
  beforeEach(() => {
    resetTestState();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
