import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { buildCompanionDocument } from "./index";

const browserStrings = {
  connecting: "Connecting…",
  retry: "Retry",
  available: "Connected.",
  reconnecting: "Reconnecting…",
  unavailable: "This visual companion has ended.",
  error: "Connection failed.",
  sending: "Sending selection…",
  sent: "Selection delivered.",
  selectionFailed: "Selection failed. Try again.",
  unavailableDetail: "The companion is no longer available.",
  errorDetail: "The companion could not be displayed."
};

function websocketTarget(path: string) {
  return {
    kind: "websocket" as const,
    path,
    sessionId: "session-1",
    revision: "revision-1",
    strings: browserStrings
  };
}

function bridgeSource(document: string): string {
  const match = document.match(
    /<script id="kanna-companion-bridge"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) throw new Error("companion bridge script is missing");
  return match[1]!;
}

function renderSanitizedDocument(document: string): Window {
  const window = new Window();
  window.document.write(document);
  const render = window.document.querySelector("#kanna-companion-render") as unknown as {
    textContent: string | null;
  } | null;
  expect(render).not.toBeNull();
  window.eval(render?.textContent ?? "");
  return window;
}

function runWebsocketBridge(
  document: string,
  expectedSocketUrl =
    "ws://127.0.0.1:4312/events?sessionId=session-1&revision=revision-1"
) {
  const documentListeners = new Map<string, (event: unknown) => void>();
  const retryListeners = new Map<string, (event: unknown) => void>();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const scheduledDelays: number[] = [];
  const status = { textContent: "", dataset: {} as Record<string, string> };
  const content = {
    inert: false,
    dataset: {} as Record<string, string>,
    children: [] as Array<{ textContent: string }>,
    replaceChildren(...children: Array<{ textContent: string }>) {
      this.children = children;
    },
    querySelectorAll() {
      return [];
    },
    removeAttribute(name: string) {
      delete this.dataset[name];
    },
    setAttribute(name: string, value: string) {
      this.dataset[name] = value;
    }
  };
  const retry = {
    disabled: true,
    hidden: true,
    addEventListener(type: string, listener: (event: unknown) => void) {
      retryListeners.set(type, listener);
    }
  };
  const reload = () => {
    reload.calls += 1;
  };
  reload.calls = 0;
  type BridgeSocket = {
    url: string;
    readyState: number;
    sent: string[];
    throwOnSend: boolean;
    listeners: Map<string, (event: unknown) => void>;
    send(data: string): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
  };
  const sockets: BridgeSocket[] = [];
  const WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    readonly sent: string[] = [];
    readonly listeners = new Map<string, (event: unknown) => void>();
    throwOnSend = false;

    constructor(readonly url: string) {
      expect(url).toBe(expectedSocketUrl);
      sockets.push(this);
    }

    send(data: string) {
      if (this.throwOnSend) throw new Error("send failed");
      this.sent.push(data);
    }

    addEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.set(type, listener);
    }
  };
  const setTimeout = (callback: () => void, delay = 0) => {
    timers.push({ callback, delay });
    scheduledDelays.push(delay);
    return timers.length;
  };
  const window = {
    location: {
      href: "http://127.0.0.1:4312/",
      protocol: "http:",
      host: "127.0.0.1:4312",
      reload
    },
    toggleSelect: () => undefined,
    selectedChoice: null
  };
  const fakeDocument = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      documentListeners.set(type, listener);
    },
    getElementById(idValue: string) {
      if (idValue === "kanna-companion-status") return status;
      if (idValue === "kanna-companion-retry") return retry;
      if (idValue === "kanna-companion-content") return content;
      return null;
    },
    createElement() {
      return { textContent: "" };
    }
  };

  new Function(
    "window",
    "document",
    "WebSocket",
    "setTimeout",
    bridgeSource(document)
  )(
    window,
    fakeDocument,
    WebSocket,
    setTimeout
  );

  const currentSocket = (index = sockets.length - 1) => sockets[index]!;
  let lastChoiceSelected = false;
  const click = (input: {
    choice: string;
    text: string;
    id: string;
  }) => {
    const classes = new Set<string>();
    const target = {
      dataset: { choice: input.choice },
      id: input.id,
      textContent: input.text,
      classList: {
        add: (name: string) => {
          classes.add(name);
          lastChoiceSelected = classes.has("selected");
        },
        remove: (name: string) => {
          classes.delete(name);
          lastChoiceSelected = classes.has("selected");
        },
        toggle: (name: string) => {
          classes.has(name) ? classes.delete(name) : classes.add(name);
          lastChoiceSelected = classes.has("selected");
        }
      },
      closest(selector: string) {
        if (selector === "[data-choice]") return this;
        return null;
      },
      hasAttribute: () => false
    };
    documentListeners.get("click")?.({ target });
  };

  return {
    click,
    content,
    lastChoiceSelected: () => lastChoiceSelected,
    message(value: unknown, socketIndex = sockets.length - 1) {
      currentSocket(socketIndex).listeners.get("message")?.({
        data: JSON.stringify(value)
      });
    },
    pendingTimerCount() {
      return timers.length;
    },
    reload,
    retry,
    retrySelection() {
      retryListeners.get("click")?.({ preventDefault: () => undefined });
    },
    runNextTimer() {
      const timer = timers.shift();
      if (!timer) throw new Error("no reconnect timer is pending");
      timer.callback();
    },
    scheduledDelays,
    socket: currentSocket,
    socketCount() {
      return sockets.length;
    },
    socketEvent(type: string, socketIndex = sockets.length - 1) {
      const target = currentSocket(socketIndex);
      if (type === "open") target.readyState = WebSocket.OPEN;
      if (type === "close") target.readyState = 3;
      target.listeners.get(type)?.({});
    },
    status
  };
}

describe("buildCompanionDocument", () => {
  it("wraps fragments in the existing responsive companion frame", () => {
    const fragment =
      '<section data-note="raw"><button data-choice="a">A</button></section>';
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: fragment,
      target: { kind: "react-native" }
    });

    expect(document).toMatch(/^<!doctype html>/i);
    expect(document).toContain('<meta name="viewport"');
    expect(document).toContain('<main id="kanna-companion-content">');
    expect(document).not.toContain(fragment);
    expect(document).toContain("\\u003csection data-note");
    expect(document).toContain('id="kanna-companion-render"');
    expect(document).toContain(".option.selected");
    expect(document).toContain(".cards {");
    expect(document).toContain(".split {");
  });

  it("preserves the mobile CSP and native bridge", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: "<p>Companion</p>",
      target: { kind: "react-native" }
    });

    expect(document).toContain("default-src 'none'");
    expect(document).toContain("style-src 'unsafe-inline'");
    expect(document).toContain("script-src 'unsafe-inline'");
    expect(document).toContain("img-src https: data:");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("object-src 'none'");
    expect(document).toContain("base-uri 'none'");
    expect(document).not.toContain("navigate-to");
    expect(document).toContain(
      "window.ReactNativeWebView.postMessage(JSON.stringify(message))"
    );
    expect(document).not.toContain("new WebSocket");
  });

  it.each([
    ["mobile", { kind: "react-native" } as const],
    ["desktop", websocketTarget("/bridge")]
  ])("renders server-prepared local images on %s", (_name, target) => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<img id="gallery-image" src="data:image/png;base64,UE5H">',
      target
    });

    const window = renderSanitizedDocument(document);
    const image = window.document.querySelector("#gallery-image") as unknown as {
      src: string;
    } | null;
    expect(image?.src).toBe("data:image/png;base64,UE5H");
    expect(
      window.document.querySelector(".kanna-companion-image-placeholder")
    ).toBeNull();
  });

  it.each([
    ["relative", "01.png"],
    ["out-of-tree", "../secret.png"],
    ["hostile", "javascript:alert(1)"]
  ])("degrades an unprepared %s image visibly", (_name, source) => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: `<img id="unsafe-image" src="${source}">`,
      target: { kind: "react-native" }
    });

    const window = renderSanitizedDocument(document);
    const placeholder = window.document.querySelector(
      ".kanna-companion-image-placeholder"
    );
    expect(window.document.querySelector("#unsafe-image")).toBeNull();
    expect(placeholder?.textContent).toBe(
      `Image unavailable: ${source} (local image was not prepared safely).`
    );
    expect(placeholder?.getAttribute("role")).toBe("img");
  });

  it("sanitizes a full mobile document while preserving its passive content", () => {
    const source = [
      "<!doctype html>",
      "<html><head><title>Agent UI</title></head>",
      '<body><article id="kept">Keep me</article></body></html>'
    ].join("");
    const document = buildCompanionDocument({
      documentKind: "full_document",
      html: source,
      target: { kind: "react-native" }
    });

    expect(document).not.toContain('<article id="kept">Keep me</article>');
    expect(document).toContain("\\u003chtml>");
    expect(document).toContain("Keep me");
    expect(document).toContain("Agent UI");
    expect(document).toContain("allowedElements");
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(
      document.indexOf("</head>")
    );
    expect(document).toContain("kanna-companion-bridge");
  });

  it("keeps active mobile source markup inert despite the native inline-script policy", () => {
    const hostile = [
      "<script>window.pwned = true</script>",
      '<svg><animate attributeName="href" to="https://attacker.example"></animate></svg>',
      '<img src="https://images.example/passive.png" onerror="window.pwned=true">'
    ].join("");
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: hostile,
      target: { kind: "react-native" }
    });

    expect(document).not.toContain(hostile);
    expect(document).not.toContain("<script>window.pwned");
    expect(document).not.toContain("<animate ");
    expect(document).toContain("\\u003cscript>");
    expect(document).toContain("safeNetworkImage");
    expect(document).toContain("removeAttribute(attribute.name)");
  });

  it("keeps hostile source HTML out of the constant bridge", () => {
    const hostile =
      '<pre>` ${window.pwned} </script><script>window.agentScript = true</script></pre>';
    const baseline = buildCompanionDocument({
      documentKind: "fragment",
      html: "",
      target: websocketTarget("/bridge")
    });
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: hostile,
      target: websocketTarget("/bridge")
    });

    expect(document).not.toContain(hostile);
    expect(document).toContain('id="kanna-companion-source"');
    expect(document).toContain('id="kanna-companion-render"');
    expect(document).toContain("DOMParser");
    expect(document).toContain("allowedElements");
    expect(document).toContain("allowedAttributes");
    expect(document).toContain("startsWith('on')");
    expect(document).not.toContain("navigate-to");
    expect(document).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(document).not.toBe(baseline);
  });

  it("makes meta refresh and location scripts inert in browser delivery", () => {
    const document = buildCompanionDocument({
      documentKind: "full_document",
      html: [
        '<meta http-equiv="refresh" content="0;url=https://attacker.example/meta">',
        "<script>window.location='https://attacker.example/script'</script>",
        '<button onclick="window.location=`https://attacker.example/click`">Stay</button>'
      ].join(""),
      target: websocketTarget("/bridge")
    });

    expect(document).not.toContain('<meta http-equiv="refresh"');
    expect(document).not.toContain("<script>window.location=");
    expect(document).not.toContain('onclick="window.location');
    expect(document).toContain("\\u003cmeta");
    expect(document).toContain("\\u003cscript");
    expect(document).toContain("removeAttribute(attribute.name)");
  });

  it("uses a strict element and attribute allowlist that excludes SVG animation and navigation", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: [
        '<svg><animate attributeName="href" to="https://attacker.example">',
        '<set attributeName="href" to="https://attacker.example">',
        '<a href="/files/active.html"><text>escape</text></a></svg>',
        '<iframe src="/files/active.html"></iframe>',
        '<img src="/files/layout.png" onerror="window.pwned=true">',
      ].join(""),
      target: websocketTarget("/bridge")
    });

    expect(document).toContain("allowedElements");
    expect(document).toContain("allowedAttributes");
    expect(document).toContain("replaceChildren()");
    expect(document).not.toContain("parsed.querySelectorAll('script, noscript");
    expect(document).not.toContain("document.importNode(node, true)");
    expect(document).toContain("'svg'");
    expect(document).not.toMatch(/allowedElements[^;]*["']animate["']/u);
    expect(document).not.toMatch(/allowedElements[^;]*["']set["']/u);
    expect(document).not.toMatch(/allowedElements[^;]*["']iframe["']/u);
    expect(document).not.toMatch(/allowedAttributes[^;]*["']href["']/u);
  });

  it("connects the browser adapter to a same-origin WebSocket at the supplied path", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/bridge")
    });

    expect(document).toContain("connect-src 'self'");
    expect(document).toContain("img-src 'self' https: data:");
    expect(document).toContain("style-src 'self' 'unsafe-inline'");
    expect(document).toMatch(/script-src 'self' 'nonce-kanna-[^']+'/u);
    expect(document).toContain("font-src 'self'");
    expect(document).toContain("new WebSocket");
    expect(document).toContain('"/bridge"');
    expect(document).not.toContain("ReactNativeWebView");
    expect(document).not.toContain("https://");
    expect(document).not.toMatch(/>\s*remote\b/iu);
  });

  it("binds the browser WebSocket target to the rendered document identity", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: {
        kind: "websocket",
        path: "/events",
        sessionId: "session with spaces",
        revision: "revision/one",
        strings: browserStrings
      }
    });

    expect(document).toContain("encodeURIComponent");
    expect(document).toContain('"session with spaces"');
    expect(document).toContain('"revision/one"');
    expect(document).toContain("?sessionId=");
    expect(document).toContain("&revision=");
    const bridge = runWebsocketBridge(
      document,
      "ws://127.0.0.1:4312/events?sessionId=session%20with%20spaces&revision=revision%2Fone"
    );
    expect(bridge.socket().url).toContain(
      "sessionId=session%20with%20spaces&revision=revision%2Fone"
    );

    const hostileIdentity = buildCompanionDocument({
      documentKind: "fragment",
      html: "<p>Companion</p>",
      target: {
        ...websocketTarget("/events"),
        revision: "revision</script><script>window.pwned=true"
      }
    });
    expect(hostileIdentity).not.toContain(
      'revision</script><script>window.pwned=true'
    );
    expect(hostileIdentity).toContain("revision\\u003c/script>");
  });

  it("adds a visible browser lifecycle indicator to full documents", () => {
    const document = buildCompanionDocument({
      documentKind: "full_document",
      html: "<html><body><h1>Companion</h1></body></html>",
      target: websocketTarget("/bridge")
    });

    expect(document).toContain('id="kanna-companion-status"');
    expect(document).toContain('id="kanna-companion-status-style"');
    expect(document).toContain("[data-status=\"error\"]");
  });

  it("rejects paths that could escape the same origin", () => {
    expect(() =>
      buildCompanionDocument({
        documentKind: "fragment",
        html: "<p>Companion</p>",
        target: websocketTarget("//attacker.example/socket")
      })
    ).toThrow("same-origin");
    expect(() =>
      buildCompanionDocument({
        documentKind: "fragment",
        html: "<p>Companion</p>",
        target: websocketTarget(
          '/socket</script><script src="https://attacker.example">'
        )
      })
    ).toThrow("same-origin");
    for (const path of ["/events?existing=yes", "/events#fragment"]) {
      expect(() =>
        buildCompanionDocument({
          documentKind: "fragment",
          html: "<p>Companion</p>",
          target: websocketTarget(path)
        })
      ).toThrow("same-origin");
    }
  });

  it("rejects malformed or oversized browser document identities", () => {
    for (const target of [
      { ...websocketTarget("/events"), sessionId: "" },
      { ...websocketTarget("/events"), sessionId: "bad\ud800session" },
      { ...websocketTarget("/events"), revision: "bad\u0000revision" },
      { ...websocketTarget("/events"), revision: "bad\udfffrevision" },
      { ...websocketTarget("/events"), revision: "界".repeat(86) }
    ]) {
      expect(() =>
        buildCompanionDocument({
          documentKind: "fragment",
          html: "<p>Companion</p>",
          target
        })
      ).toThrow("document identity");
    }
  });

  it("sends bounded generated events and handles results, statuses, and reload", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    const choice = "界".repeat(86);
    const text = "🙂".repeat(1025);
    const id = "é".repeat(129);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice, text, id });

    const sentPayloads = bridge.socket().sent;
    expect(sentPayloads).toHaveLength(1);
    const sent = JSON.parse(sentPayloads[0]!) as {
      type: string;
      event: {
        event_id: string;
        choice: string;
        text: string;
        id: string;
      };
    };
    expect(sent.type).toBe("companion-event");
    expect(sent.event.event_id).toMatch(/^browser-\d+-1$/);
    expect(new TextEncoder().encode(sent.event.choice)).toHaveLength(255);
    expect(new TextEncoder().encode(sent.event.text)).toHaveLength(4096);
    expect(new TextEncoder().encode(sent.event.id)).toHaveLength(256);

    bridge.message({
      type: "event_result",
      event_id: sent.event.event_id,
      accepted: true
    });
    expect(bridge.status).toMatchObject({
      textContent: "Selection delivered.",
      dataset: { status: "sent" }
    });

    bridge.message({ type: "status", status: "reconnecting" });
    expect(bridge.status).toMatchObject({
      textContent: "Reconnecting…",
      dataset: { status: "reconnecting" }
    });

    bridge.message({ type: "reload" });
    expect(bridge.reload.calls).toBe(1);
  });

  it("ignores stale and malformed results while a newer selection is pending", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice: "first", text: "First", id: "first" });
    bridge.click({ choice: "second", text: "Second", id: "second" });
    const [first, second] = bridge.socket().sent.map(
      (payload) =>
        JSON.parse(payload) as {
          event: { event_id: string };
        }
    );

    bridge.message({
      type: "event_result",
      event_id: first!.event.event_id,
      accepted: false,
      message: "Stale rejection"
    });
    expect(bridge.status).toMatchObject({
      textContent: "Sending selection…",
      dataset: { status: "sending" }
    });
    expect(bridge.retry.hidden).toBe(true);

    bridge.message({
      type: "event_result",
      event_id: second!.event.event_id,
      accepted: "yes"
    });
    expect(bridge.status).toMatchObject({
      textContent: "Sending selection…",
      dataset: { status: "sending" }
    });
    expect(bridge.retry.hidden).toBe(true);

    bridge.message({
      type: "event_result",
      event_id: second!.event.event_id,
      accepted: false,
      message: "x".repeat(5_000)
    });
    expect(bridge.status).toMatchObject({
      textContent: "Sending selection…",
      dataset: { status: "sending" }
    });
    expect(bridge.retry.hidden).toBe(true);
  });

  it("retries a rejected semantic selection with the same durable identity", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice: "ship", text: "Ship it", id: "ship-button" });
    const first = JSON.parse(bridge.socket().sent[0]!) as {
      event: Record<string, unknown> & { event_id: string };
    };
    bridge.message({
      type: "event_result",
      event_id: first.event.event_id,
      accepted: false,
      code: "append_failed",
      message: "Selection failed."
    });

    expect(bridge.retry).toMatchObject({ disabled: false, hidden: false });
    expect(bridge.status).toMatchObject({
      textContent: "Selection failed.",
      dataset: { status: "error" }
    });

    bridge.retrySelection();
    expect(bridge.socket().sent).toHaveLength(2);
    const second = JSON.parse(bridge.socket().sent[1]!) as {
      event: Record<string, unknown> & { event_id: string };
    };
    expect(second.event).toEqual(first.event);
    expect(bridge.retry.hidden).toBe(true);
    expect(bridge.status).toMatchObject({
      textContent: "Sending selection…",
      dataset: { status: "sending" }
    });

    bridge.message({
      type: "event_result",
      event_id: first.event.event_id,
      accepted: false,
      message: "Late failure"
    });
    expect(bridge.status.dataset.status).toBe("error");
    expect(bridge.retry).toMatchObject({ disabled: false, hidden: false });
  });

  it("offers manual retry after a local send failure", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    bridge.socket().throwOnSend = true;
    bridge.click({ choice: "ship", text: "Ship it", id: "ship-button" });

    expect(bridge.socket().sent).toHaveLength(0);
    expect(bridge.retry).toMatchObject({ disabled: false, hidden: false });
    expect(bridge.status.dataset.status).toBe("error");

    bridge.socket().throwOnSend = false;
    bridge.retrySelection();
    expect(bridge.socket().sent).toHaveLength(1);
    expect(bridge.status.dataset.status).toBe("sending");
  });

  it("preserves an ambiguous retry across reconnect and reveals it when available", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    const rejectCurrent = () => {
      bridge.click({ choice: "ship", text: "Ship", id: "ship" });
      const sent = JSON.parse(bridge.socket().sent.at(-1)!) as {
        event: { event_id: string };
      };
      bridge.message({
        type: "event_result",
        event_id: sent.event.event_id,
        accepted: false
      });
      expect(bridge.retry.hidden).toBe(false);
    };

    rejectCurrent();
    const original = JSON.parse(bridge.socket().sent.at(-1)!) as {
      event: Record<string, unknown>;
    };
    bridge.socketEvent("close");
    expect(bridge.retry).toMatchObject({ disabled: true, hidden: true });
    const closedSocket = bridge.socket();
    const sentBeforeClosedRetry = closedSocket.sent.length;
    bridge.retrySelection();
    expect(closedSocket.sent).toHaveLength(sentBeforeClosedRetry);

    bridge.runNextTimer();
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    expect(bridge.retry).toMatchObject({ disabled: false, hidden: false });
    bridge.retrySelection();
    const retried = JSON.parse(bridge.socket().sent.at(-1)!) as {
      event: Record<string, unknown>;
    };
    expect(retried.event).toEqual(original.event);

    rejectCurrent();
    bridge.message({ type: "status", status: "reconnecting" });
    expect(bridge.retry).toMatchObject({ disabled: true, hidden: true });

    bridge.message({ type: "status", status: "available" });
    expect(bridge.retry).toMatchObject({ disabled: false, hidden: false });
    bridge.message({ type: "reload" });
    expect(bridge.retry).toMatchObject({ disabled: true, hidden: true });
    expect(bridge.reload.calls).toBe(1);
  });

  it("does not send before the local bridge WebSocket opens", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);

    bridge.click({ choice: "ship", text: "Ship", id: "ship" });

    expect(bridge.socket().sent).toHaveLength(0);
    expect(bridge.lastChoiceSelected()).toBe(false);
    expect(bridge.status).toMatchObject({
      textContent: "Connecting…",
      dataset: { status: "connecting" }
    });
  });

  it("does not send after the local socket opens until remote availability arrives", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);

    bridge.socketEvent("open");
    bridge.click({ choice: "ship", text: "Ship", id: "ship" });

    expect(bridge.socket().sent).toHaveLength(0);
    expect(bridge.lastChoiceSelected()).toBe(false);
    expect(bridge.status).toMatchObject({
      textContent: "Connecting…",
      dataset: { status: "connecting" }
    });
  });

  it("sends after the remote lifecycle explicitly becomes available", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);

    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice: "ship", text: "Ship", id: "ship" });

    expect(bridge.socket().sent).toHaveLength(1);
    expect(bridge.status.dataset.status).toBe("sending");
  });

  it("reconnects with a fresh socket without replaying a pending selection", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    const firstSocket = bridge.socket();
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice: "first", text: "First", id: "first" });
    expect(firstSocket.sent).toHaveLength(1);

    bridge.socketEvent("close");

    expect(bridge.pendingTimerCount()).toBe(1);
    expect(bridge.scheduledDelays).toEqual([250]);
    expect(bridge.socketCount()).toBe(1);
    expect(bridge.retry).toMatchObject({ disabled: true, hidden: true });

    bridge.runNextTimer();
    const secondSocket = bridge.socket();
    expect(bridge.socketCount()).toBe(2);
    expect(secondSocket).not.toBe(firstSocket);
    expect(secondSocket.sent).toHaveLength(0);

    bridge.socketEvent("open");
    bridge.click({ choice: "blocked", text: "Blocked", id: "blocked" });
    expect(secondSocket.sent).toHaveLength(0);
    expect(bridge.status.dataset.status).toBe("connecting");

    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice: "second", text: "Second", id: "second" });
    expect(secondSocket.sent).toHaveLength(1);
    expect(firstSocket.sent).toHaveLength(1);
  });

  it("ignores late events from stale socket generations", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open", 0);
    bridge.message({ type: "status", status: "available" }, 0);
    bridge.socketEvent("close", 0);
    bridge.runNextTimer();

    bridge.socketEvent("open", 0);
    bridge.message({ type: "status", status: "available" }, 0);
    bridge.click({ choice: "blocked", text: "Blocked", id: "blocked" });
    expect(bridge.socket(0).sent).toHaveLength(0);
    expect(bridge.socket(1).sent).toHaveLength(0);
    expect(bridge.status.dataset.status).toBe("connecting");

    bridge.socketEvent("open", 1);
    bridge.message({ type: "status", status: "available" }, 1);
    bridge.click({ choice: "second", text: "Second", id: "second" });
    const current = JSON.parse(bridge.socket(1).sent[0]!) as {
      event: { event_id: string };
    };

    bridge.message({ type: "status", status: "unavailable" }, 0);
    bridge.message({ type: "reload" }, 0);
    bridge.socketEvent("close", 0);
    bridge.message({
      type: "event_result",
      event_id: current.event.event_id,
      accepted: false
    }, 0);

    expect(bridge.status.dataset.status).toBe("sending");
    expect(bridge.retry.hidden).toBe(true);
    expect(bridge.reload.calls).toBe(0);
    expect(bridge.pendingTimerCount()).toBe(0);

    bridge.message({
      type: "event_result",
      event_id: current.event.event_id,
      accepted: true
    }, 1);
    expect(bridge.status.dataset.status).toBe("sent");
  });

  it("uses one reconnect timer with bounded deterministic backoff", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    const expectedDelays = [250, 500, 1000, 2000, 2000];

    expectedDelays.forEach((delay, socketIndex) => {
      bridge.socketEvent("close", socketIndex);
      bridge.socketEvent("close", socketIndex);
      expect(bridge.pendingTimerCount()).toBe(1);
      expect(bridge.scheduledDelays.at(-1)).toBe(delay);
      bridge.runNextTimer();
    });

    expect(bridge.scheduledDelays).toEqual(expectedDelays);
    expect(bridge.socketCount()).toBe(expectedDelays.length + 1);
  });

  it("preserves a pending event across duplicate available statuses", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice: "ship", text: "Ship", id: "ship" });
    const sent = JSON.parse(bridge.socket().sent[0]!) as {
      event: { event_id: string };
    };

    bridge.message({ type: "status", status: "available" });

    expect(bridge.status.dataset.status).toBe("sending");
    bridge.message({
      type: "event_result",
      event_id: sent.event.event_id,
      accepted: true
    });
    expect(bridge.status).toMatchObject({
      textContent: "Selection delivered.",
      dataset: { status: "sent" }
    });
  });

  it("preserves a rejected selection retry across duplicate available statuses", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice: "ship", text: "Ship", id: "ship" });
    const sent = JSON.parse(bridge.socket().sent[0]!) as {
      event: { event_id: string };
    };
    bridge.message({
      type: "event_result",
      event_id: sent.event.event_id,
      accepted: false
    });

    bridge.message({ type: "status", status: "available" });

    expect(bridge.retry).toMatchObject({ disabled: false, hidden: false });
    bridge.retrySelection();
    expect(bridge.socket().sent).toHaveLength(2);
    expect(bridge.status.dataset.status).toBe("sending");
  });

  it("reloads instead of reviving controls after a terminal lifecycle becomes available", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "unavailable" });
    bridge.click({ choice: "blocked", text: "Blocked", id: "blocked" });
    expect(bridge.socket().sent).toHaveLength(0);

    bridge.message({ type: "status", status: "available" });
    bridge.click({ choice: "ship", text: "Ship", id: "ship" });

    expect(bridge.reload.calls).toBe(1);
    expect(bridge.socket().sent).toHaveLength(0);
  });

  it.each([
    ["reconnecting", "Reconnecting…"],
    ["unavailable", "This visual companion has ended."],
    ["error", "Connection failed."]
  ] as const)(
    "blocks clicks and retry while the remote lifecycle is %s",
    (lifecycle, label) => {
      const document = buildCompanionDocument({
        documentKind: "fragment",
        html: '<button data-choice="ship">Ship</button>',
        target: websocketTarget("/events")
      });
      const bridge = runWebsocketBridge(document);
      bridge.socketEvent("open");
      bridge.message({ type: "status", status: "available" });
      bridge.click({ choice: "first", text: "First", id: "first" });
      const first = JSON.parse(bridge.socket().sent[0]!) as {
        event: { event_id: string };
      };
      bridge.message({
        type: "event_result",
        event_id: first.event.event_id,
        accepted: false
      });
      expect(bridge.retry.hidden).toBe(false);

      bridge.message({ type: "status", status: lifecycle });
      const sentBeforeBlockedActions = bridge.socket().sent.length;
      bridge.click({ choice: "second", text: "Second", id: "second" });
      bridge.retrySelection();

      expect(bridge.socket().sent).toHaveLength(sentBeforeBlockedActions);
      expect(bridge.retry).toMatchObject({ disabled: true, hidden: true });
      expect(bridge.status).toMatchObject({
        textContent: label,
        dataset: { status: lifecycle }
      });

      bridge.message({ type: "status", status: "available" });
      bridge.click({ choice: "second", text: "Second", id: "second" });
      if (lifecycle === "reconnecting") {
        expect(bridge.socket().sent).toHaveLength(sentBeforeBlockedActions + 1);
        expect(bridge.status.dataset.status).toBe("sending");
      } else {
        expect(bridge.reload.calls).toBe(1);
        expect(bridge.socket().sent).toHaveLength(sentBeforeBlockedActions);
      }
    }
  );

  it("makes reconnecting content inert and replaces terminal content", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">Ship</button>',
      target: websocketTarget("/events")
    });
    const bridge = runWebsocketBridge(document);
    bridge.socketEvent("open");
    bridge.message({ type: "status", status: "available" });

    bridge.message({ type: "status", status: "reconnecting" });
    expect(bridge.content.inert).toBe(true);
    expect(bridge.content.dataset).toMatchObject({
      kannaCompanionLifecycle: "reconnecting"
    });

    bridge.message({ type: "status", status: "unavailable" });
    expect(bridge.content.inert).toBe(true);
    expect(bridge.content.dataset).toMatchObject({
      kannaCompanionLifecycle: "unavailable"
    });
    expect(bridge.content.children.map((child) => child.textContent)).toEqual([
      "This visual companion has ended.",
      "The companion is no longer available."
    ]);
  });

  it("renders app-owned Japanese browser copy without English lifecycle fallback", () => {
    const document = buildCompanionDocument({
      documentKind: "fragment",
      html: '<button data-choice="ship">送信</button>',
      target: {
        ...websocketTarget("/events"),
        strings: {
          connecting: "接続しています…",
          retry: "再試行",
          available: "接続済み",
          reconnecting: "再接続しています…",
          unavailable: "ビジュアルコンパニオンは終了しました。",
          error: "接続に失敗しました。",
          sending: "選択内容を送信しています…",
          sent: "選択内容を送信しました。",
          selectionFailed: "選択内容を送信できませんでした。",
          unavailableDetail: "このコンパニオンは利用できません。",
          errorDetail: "コンパニオンを表示できませんでした。"
        }
      }
    });

    expect(document).toContain("接続しています…");
    expect(document).toContain("ビジュアルコンパニオンは終了しました。");
    expect(document).not.toContain("Connecting…");
    expect(document).not.toContain("This visual companion has ended.");
  });
});
