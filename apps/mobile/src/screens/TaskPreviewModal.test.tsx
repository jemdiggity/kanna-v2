import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface EffectSlot {
  cleanup?: () => void;
  dependencies?: readonly unknown[];
}

const harness = vi.hoisted(() => ({
  effects: [] as Array<{
    callback: () => void | (() => void);
    dependencies?: readonly unknown[];
    index: number;
  }>,
  effectSlots: [] as EffectSlot[],
  hookIndex: 0,
  memo: [] as Array<{ dependencies?: readonly unknown[]; value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
  states: [] as unknown[],
  openUrl: vi.fn()
}));

function changed(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined
): boolean {
  if (!previous || !next || previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}

vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return {
    ...actual,
    useEffect(
      callback: () => void | (() => void),
      dependencies?: readonly unknown[]
    ) {
      const index = harness.hookIndex++;
      if (changed(harness.effectSlots[index]?.dependencies, dependencies)) {
        harness.effects.push({ callback, dependencies, index });
      }
    },
    useMemo(factory: () => unknown, dependencies?: readonly unknown[]) {
      const index = harness.hookIndex++;
      if (
        !harness.memo[index] ||
        changed(harness.memo[index]?.dependencies, dependencies)
      ) {
        harness.memo[index] = { dependencies, value: factory() };
      }
      return harness.memo[index]?.value;
    },
    useRef(initialValue: unknown) {
      const index = harness.hookIndex++;
      harness.refs[index] ??= { current: initialValue };
      return harness.refs[index];
    },
    useState(initialValue: unknown) {
      const index = harness.hookIndex++;
      if (!(index in harness.states)) {
        harness.states[index] =
          typeof initialValue === "function"
            ? (initialValue as () => unknown)()
            : initialValue;
      }
      return [
        harness.states[index],
        (next: unknown) => {
          harness.states[index] =
            typeof next === "function"
              ? (next as (value: unknown) => unknown)(harness.states[index])
              : next;
        }
      ];
    }
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Linking: { openURL: harness.openUrl },
  Modal: "Modal",
  Pressable: "Pressable",
  SafeAreaView: "SafeAreaView",
  ScrollView: "ScrollView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));
vi.mock("react-native-webview", () => ({ WebView: "WebView" }));

interface ElementNode {
  type: unknown;
  props?: { children?: unknown; testID?: string; [key: string]: unknown };
}

let TaskPreviewModal: typeof import("./TaskPreviewModal").TaskPreviewModal;

beforeAll(async () => {
  TaskPreviewModal = (await import("./TaskPreviewModal")).TaskPreviewModal;
});

beforeEach(() => {
  harness.effectSlots.forEach((slot) => slot.cleanup?.());
  harness.effects.length = 0;
  harness.effectSlots.length = 0;
  harness.hookIndex = 0;
  harness.memo.length = 0;
  harness.refs.length = 0;
  harness.states.length = 0;
  harness.openUrl.mockReset().mockResolvedValue(undefined);
});

function render(onOpen: () => Promise<{
  url: string;
  portName: string;
  port: number;
  expiresAt: number;
  ports: Array<{ name: string; port: number; listening: boolean }>;
}>): ElementNode {
  harness.hookIndex = 0;
  return TaskPreviewModal({
    taskTitle: "Portfolio",
    ports: [{ name: "DEV_PORT", port: 8471 }],
    onOpen,
    onClose: vi.fn()
  }) as ElementNode;
}

async function runEffects(): Promise<void> {
  const pending = [...harness.effects];
  harness.effects.length = 0;
  for (const effect of pending) {
    harness.effectSlots[effect.index]?.cleanup?.();
    const cleanup = effect.callback();
    harness.effectSlots[effect.index] = {
      dependencies: effect.dependencies,
      cleanup: typeof cleanup === "function" ? cleanup : undefined
    };
  }
  await Promise.resolve();
  await Promise.resolve();
}

function find(node: unknown, testID: string): ElementNode | null {
  if (!node || typeof node === "string" || typeof node === "number") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = find(child, testID);
      if (match) return match;
    }
    return null;
  }
  const element = node as ElementNode;
  return element.props?.testID === testID
    ? element
    : find(element.props?.children, testID);
}

describe("TaskPreviewModal", () => {
  it("does not remint the preview when its parent recreates the callback", async () => {
    const firstOpen = vi.fn().mockResolvedValue({
      url: "http://192.168.1.20:55321/__kanna_preview__/enter?t=first",
      portName: "DEV_PORT",
      port: 55321,
      expiresAt: 123,
      ports: [{ name: "DEV_PORT", port: 8471, listening: true }]
    });
    const nextOpen = vi.fn().mockResolvedValue({
      url: "http://192.168.1.20:55322/__kanna_preview__/enter?t=next",
      portName: "DEV_PORT",
      port: 55322,
      expiresAt: 456,
      ports: [{ name: "DEV_PORT", port: 8471, listening: true }]
    });

    render(firstOpen);
    await runEffects();
    render(nextOpen);
    await runEffects();

    expect(firstOpen).toHaveBeenCalledOnce();
    expect(nextOpen).not.toHaveBeenCalled();
  });

  it("loads only the minted preview origin in a bridge-free WebView", async () => {
    const onOpen = vi.fn().mockResolvedValue({
      url: "http://192.168.1.20:55321/__kanna_preview__/enter?t=secret",
      portName: "DEV_PORT",
      port: 55321,
      expiresAt: 123,
      ports: [{ name: "DEV_PORT", port: 8471, listening: true }]
    });
    render(onOpen);
    await runEffects();
    const webView = find(render(onOpen), "mobile.task-preview.webview");
    expect(webView?.props).toMatchObject({
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      javaScriptCanOpenWindowsAutomatically: false,
      setSupportMultipleWindows: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      originWhitelist: ["http://192.168.1.20:55321"],
      source: {
        uri: "http://192.168.1.20:55321/__kanna_preview__/enter?t=secret"
      }
    });
    expect(webView?.props?.onMessage).toBeUndefined();
    const shouldStart = webView?.props?.onShouldStartLoadWithRequest as (
      request: {
        url: string;
        isTopFrame: boolean;
        navigationType: "click" | "other";
      }
    ) => boolean;
    expect(
      shouldStart({
        url: "http://192.168.1.20:55321/assets/app.js",
        isTopFrame: true,
        navigationType: "other"
      })
    ).toBe(true);
    expect(
      shouldStart({
        url: "http://127.0.0.1:48120/v1/tasks",
        isTopFrame: true,
        navigationType: "click"
      })
    ).toBe(false);
    expect(harness.openUrl).toHaveBeenCalledWith("http://127.0.0.1:48120/v1/tasks");

    const browser = find(render(onOpen), "mobile.task-preview.browser");
    (browser?.props?.onPress as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(harness.openUrl).toHaveBeenCalledWith(
      "http://192.168.1.20:55321/__kanna_preview__/enter?t=secret"
    );
  });

  it("shows a retry action when the declared server is not listening", async () => {
    const onOpen = vi.fn().mockRejectedValue(
      new Error("Nothing is listening on DEV_PORT (8471).")
    );
    render(onOpen);
    await runEffects();
    const tree = render(onOpen);
    expect(find(tree, "mobile.task-preview.error")).not.toBeNull();
    const retry = find(tree, "mobile.task-preview.retry");
    expect(retry).not.toBeNull();
    (retry?.props?.onPress as () => void)();
    render(onOpen);
    await runEffects();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
