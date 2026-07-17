import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebViewMessageEvent } from "react-native-webview";
import type { TaskTerminalStatus } from "../state/sessionStore";
import {
  buildTerminalAppendScript,
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

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn<(value: string) => Promise<void>>()
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
  outputEpoch?: number;
  outputStart?: number;
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
    outputEpoch: input.outputEpoch ?? 1,
    outputStart: input.outputStart ?? 0,
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
    clipboardMocks.setStringAsync.mockReset();
    clipboardMocks.setStringAsync.mockResolvedValue(undefined);
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

  it("renders native controls only for discovered Markdown files", async () => {
    const onOpenFile = vi.fn();
    const webView = await renderTerminalWebView({ onOpenFile });

    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-file-links",
          links: [
            { raw: "docs/SPEC.MD:42", path: "  docs/SPEC.MD  ", line: 42 },
            { raw: "src/App.tsx:12", path: "src/App.tsx", line: 12 },
            { raw: "config.json", path: "config.json" },
            { raw: "src/lib.rs", path: "src/lib.rs" },
            { raw: "pnpm-lock.yaml", path: "pnpm-lock.yaml" },
            { raw: "Cargo.toml", path: "Cargo.toml" },
            { raw: "src/theme.css", path: "src/theme.css" },
            { raw: "src/Forged.tsx", path: "README.md" }
          ]
        })
      }
    } as WebViewMessageEvent);
    await renderTerminalWebView({ onOpenFile });

    const strip = React.Children.toArray(lastTree?.props.children).find(
      (child): child is ElementNode =>
        typeof child === "object" && child !== null &&
        "type" in child && (child as ElementNode).type === "ScrollView"
    );
    const buttons = React.Children.toArray(strip?.props.children).filter(
      (child): child is ElementNode =>
        typeof child === "object" && child !== null &&
        "type" in child && (child as ElementNode).type === "Pressable"
    );
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      "Open file docs/SPEC.MD at line 42"
    ]);

    (buttons[0]?.props.onPress as () => void)();
    expect(onOpenFile).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenCalledWith("docs/SPEC.MD", 42);
  });

  it("clears discovered links when switching tasks", async () => {
    const webView = await renderTerminalWebView({ taskId: "task-1" });
    runEffects();
    (webView.props.onMessage as (event: WebViewMessageEvent) => void)({
      nativeEvent: {
        data: JSON.stringify({
          type: "terminal-file-links",
          links: [{ raw: "docs/old.md", path: "docs/old.md" }]
        })
      }
    } as WebViewMessageEvent);

    await renderTerminalWebView({ taskId: "task-1" });
    expect(
      React.Children.toArray(lastTree?.props.children).some(
        (child) =>
          typeof child === "object" && child !== null &&
          "type" in child && (child as ElementNode).type === "ScrollView"
      )
    ).toBe(true);
    runEffects();

    await renderTerminalWebView({ taskId: "task-2" });
    runEffects();
    await renderTerminalWebView({ taskId: "task-2" });
    expect(
      React.Children.toArray(lastTree?.props.children).some(
        (child) =>
          typeof child === "object" && child !== null &&
          "type" in child && (child as ElementNode).type === "ScrollView"
      )
    ).toBe(false);
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
    send({ type: "terminal-file-link", path: "src/App.tsx", line: 1 });
    send({ type: "terminal-file-link", path: "config.json" });
    send({ type: "terminal-file-link", path: "src/lib.rs" });
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
      buildTerminalReplaceScript({ output: "fresh\n", status: "live" })
    );
    expect(
      injectedScripts.filter((script) => script.includes("__replaceTerminalState"))
    ).toHaveLength(1);
  });
});
