import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
let hookIndex = 0;

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();

  return {
    ...actual,
    useEffect: vi.fn((callback: () => void) => {
      effects.push({ callback });
    }),
    useMemo: vi.fn((factory: () => unknown) => factory()),
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
  View: "View"
}));

vi.mock("react-native-webview", () => ({
  WebView: "WebView"
}));

function resetRenderState() {
  hookIndex = 0;
  effects.length = 0;
}

function resetTestState() {
  injectedScripts.length = 0;
  effects.length = 0;
  refs.length = 0;
  hookIndex = 0;
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
