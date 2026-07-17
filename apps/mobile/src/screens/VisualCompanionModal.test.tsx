import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRelayDesktopClient,
  type RelaySocketLike
} from "../lib/transports/relayClient";

const harness = vi.hoisted(() => ({
  hookIndex: 0,
  memo: [] as Array<{ dependencies?: readonly unknown[]; value: unknown }>,
  states: [] as unknown[]
}));

function dependenciesChanged(
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
    useMemo(factory: () => unknown, dependencies?: readonly unknown[]) {
      const index = harness.hookIndex++;
      const previous = harness.memo[index];
      if (!previous || dependenciesChanged(previous.dependencies, dependencies)) {
        harness.memo[index] = { dependencies, value: factory() };
      }
      return harness.memo[index]!.value;
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
        (nextValue: unknown) => {
          harness.states[index] =
            typeof nextValue === "function"
              ? (nextValue as (current: unknown) => unknown)(harness.states[index])
              : nextValue;
        }
      ];
    }
  };
});

vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  SafeAreaView: "SafeAreaView",
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles
  },
  Text: "Text",
  View: "View"
}));

vi.mock("react-native-webview", () => ({ WebView: "WebView" }));

interface ElementNode {
  type: unknown;
  props?: {
    children?: unknown;
    testID?: string;
    [key: string]: unknown;
  };
}

let VisualCompanionModal:
  typeof import("./VisualCompanionModal").VisualCompanionModal;

beforeAll(async () => {
  VisualCompanionModal = (await import("./VisualCompanionModal"))
    .VisualCompanionModal;
});

beforeEach(() => {
  harness.hookIndex = 0;
  harness.memo.length = 0;
  harness.states.length = 0;
});

const snapshot = {
  sessionId: "123-456",
  revision: "rev-1",
  documentKind: "fragment" as const,
  html: '<button data-choice="ship">Ship</button>'
};

function renderModal(overrides: Partial<{
  status: "available" | "unavailable" | "error";
  snapshot: typeof snapshot | null;
  errorMessage: string | null;
  eventStatus: "idle" | "sending" | "sent" | "error";
  onClose: () => void;
  onSendEvent: (...args: unknown[]) => void;
}> = {}): ElementNode {
  harness.hookIndex = 0;
  return VisualCompanionModal({
    status: overrides.status ?? "available",
    snapshot: overrides.snapshot === undefined ? snapshot : overrides.snapshot,
    errorMessage: overrides.errorMessage ?? null,
    eventStatus: overrides.eventStatus ?? "idle",
    onClose: overrides.onClose ?? vi.fn(),
    onSendEvent: overrides.onSendEvent ?? vi.fn()
  }) as ElementNode;
}

function findByType(
  node: unknown,
  type: string
): ElementNode | null {
  if (!node || typeof node === "string" || typeof node === "number") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  const element = node as ElementNode;
  if (element.type === type) return element;
  return findByType(element.props?.children, type);
}

function findByTestId(node: unknown, testID: string): ElementNode | null {
  if (!node || typeof node === "string" || typeof node === "number") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testID);
      if (found) return found;
    }
    return null;
  }
  const element = node as ElementNode;
  if (element.props?.testID === testID) return element;
  return findByTestId(element.props?.children, testID);
}

function bridgeMessage(data: string): { nativeEvent: { data: string } } {
  return { nativeEvent: { data } };
}

function createRelaySocket(): RelaySocketLike {
  return {
    readyState: 1,
    close: vi.fn(),
    send: vi.fn(),
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("VisualCompanionModal", () => {
  it("renders the current revision in a tightly constrained WebView", () => {
    let tree = renderModal();
    let webView = findByType(tree, "WebView");
    const firstDocument = (webView?.props?.source as { html: string }).html;

    expect(firstDocument).toContain('data-choice="ship"');
    expect(firstDocument).toContain("window.toggleSelect");
    expect(webView?.props).toMatchObject({
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      domStorageEnabled: false,
      javaScriptCanOpenWindowsAutomatically: false,
      mixedContentMode: "never",
      originWhitelist: ["about:blank"],
      setSupportMultipleWindows: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      testID: "mobile.visual-companion.webview"
    });

    tree = renderModal({
      snapshot: { ...snapshot, revision: "rev-2", html: "<h1>Second</h1>" }
    });
    webView = findByType(tree, "WebView");
    expect((webView?.props?.source as { html: string }).html).toContain("Second");
    expect((webView?.props?.source as { html: string }).html).not.toBe(firstDocument);
  });

  it("allows only the in-memory document navigation", () => {
    const webView = findByType(renderModal(), "WebView");
    const shouldStart = webView?.props?.onShouldStartLoadWithRequest as (
      request: { url: string }
    ) => boolean;

    expect(shouldStart({ url: "about:blank" })).toBe(true);
    expect(shouldStart({ url: "https://example.com" })).toBe(false);
    expect(shouldStart({ url: "file:///tmp/secret" })).toBe(false);
    expect(shouldStart({ url: "javascript:alert(1)" })).toBe(false);
  });

  it.each([
    ["sending", "Sending selection…"],
    ["sent", "Selection sent."]
  ] as const)("shows the %s acknowledgement state", (eventStatus, label) => {
    const tree = renderModal({ eventStatus });
    expect(findByTestId(tree, "mobile.visual-companion.status")?.props?.children)
      .toBe(label);
  });

  it("forwards a valid constrained event with the current session and revision", () => {
    const onSendEvent = vi.fn();
    const webView = findByType(renderModal({ onSendEvent }), "WebView");
    const event = {
      event_id: "mobile-1",
      type: "click",
      choice: "ship",
      text: "Ship",
      id: null,
      timestamp: 123
    };

    (webView?.props?.onMessage as (message: unknown) => void)(
      bridgeMessage(JSON.stringify({ type: "companion-event", event }))
    );

    expect(onSendEvent).toHaveBeenCalledWith("123-456", "rev-1", event);
  });

  it("accepts the largest timestamp represented exactly on the Rust u64 wire", () => {
    const onSendEvent = vi.fn();
    const webView = findByType(renderModal({ onSendEvent }), "WebView");
    const event = {
      event_id: "mobile-1",
      type: "click",
      choice: "ship",
      text: "Ship",
      id: null,
      timestamp: Number.MAX_SAFE_INTEGER
    };

    (webView?.props?.onMessage as (message: unknown) => void)(
      bridgeMessage(JSON.stringify({ type: "companion-event", event }))
    );

    expect(onSendEvent).toHaveBeenCalledWith("123-456", "rev-1", event);
  });

  it.each([
    "not-json",
    JSON.stringify({ type: "other", event: {} }),
    JSON.stringify({
      type: "companion-event",
      event: { event_id: "x", type: "click", choice: "", text: "", id: null, timestamp: 1 }
    }),
    JSON.stringify({
      type: "companion-event",
      event: { event_id: "x", type: "click", choice: "a", text: "x".repeat(8_192), id: null, timestamp: 1 }
    }),
    JSON.stringify({
      type: "companion-event",
      event: { event_id: "x", type: "click", choice: "a", text: "", id: null, timestamp: 1.5 }
    }),
    JSON.stringify({
      type: "companion-event",
      event: { event_id: "x", type: "click", choice: "a", text: "", id: null, timestamp: Number.MAX_SAFE_INTEGER + 1 }
    }),
    JSON.stringify({
      type: "companion-event",
      event: { event_id: "x", type: "click", choice: "a", text: "", id: null, timestamp: Number.MAX_VALUE }
    })
  ])("rejects malformed or oversized bridge data %#", (data) => {
    const onSendEvent = vi.fn();
    const webView = findByType(renderModal({ onSendEvent }), "WebView");

    (webView?.props?.onMessage as (message: unknown) => void)(bridgeMessage(data));

    expect(onSendEvent).not.toHaveBeenCalled();
  });

  it("keeps hostile bridge timestamps out of the shared relay and terminal stream", async () => {
    const socket = createRelaySocket();
    const client = createRelayDesktopClient({
      createSocket: () => socket,
      getIdToken: async () => "id-token-1",
      relayUrl: "wss://relay.example"
    });
    const terminalEvents: unknown[] = [];
    client.observeTaskTerminal(
      { desktopId: "desktop-1", taskId: "task-1" },
      (event) => terminalEvents.push(event)
    );
    const companion = client.observeTaskCompanion(
      { desktopId: "desktop-1", taskId: "task-1" },
      () => {}
    );

    socket.onopen?.();
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "tunnel_ready" }) });
    await flushPromises();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await flushPromises();

    const webView = findByType(
      renderModal({
        onSendEvent: (sessionId, revision, event) =>
          companion.sendEvent(sessionId, revision, event)
      }),
      "WebView"
    );
    const hostileEvent = {
      event_id: "hostile-1",
      type: "click",
      choice: "ship",
      text: "Ship",
      id: null,
      timestamp: 1.5
    };
    (webView?.props?.onMessage as (message: unknown) => void)(
      bridgeMessage(
        JSON.stringify({ type: "companion-event", event: hostileEvent })
      )
    );

    const frames = vi.mocked(socket.send).mock.calls.map(([payload]) =>
      JSON.parse(payload) as Record<string, unknown>
    );
    expect(frames).not.toContainEqual(
      expect.objectContaining({
        type: "companion_event",
        task_id: "task-1"
      })
    );
    expect(terminalEvents).not.toContainEqual(
      expect.objectContaining({ type: "error" })
    );
    client.close();
  });

  it("shows a local send failure without replacing the companion", () => {
    const onSendEvent = vi.fn(() => {
      throw new Error("relay unavailable");
    });
    let tree = renderModal({ onSendEvent });
    const webView = findByType(tree, "WebView");
    const event = {
      event_id: "mobile-1",
      type: "click",
      choice: "ship",
      text: "Ship",
      id: null,
      timestamp: 123
    };
    (webView?.props?.onMessage as (message: unknown) => void)(
      bridgeMessage(JSON.stringify({ type: "companion-event", event }))
    );

    tree = renderModal({ onSendEvent });
    expect(findByType(tree, "WebView")).not.toBeNull();
    expect(findByTestId(tree, "mobile.visual-companion.status")?.props?.children)
      .toBe("Couldn’t send selection: relay unavailable");
  });

  it("keeps an ended state visible and closes from both controls", () => {
    const onClose = vi.fn();
    const tree = renderModal({
      status: "unavailable",
      snapshot: null,
      onClose
    });

    expect(findByType(tree, "WebView")).toBeNull();
    expect(findByTestId(tree, "mobile.visual-companion.status")?.props?.children)
      .toBe("This visual companion has ended.");
    (findByTestId(tree, "mobile.visual-companion.close")?.props?.onPress as () => void)();
    (findByType(tree, "Modal")?.props?.onRequestClose as () => void)();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
