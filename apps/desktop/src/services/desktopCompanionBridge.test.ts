import type { CompanionEvent } from "@kanna/agent-protocol";
import type { CompanionSnapshot } from "@kanna/stream-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopCompanionBridgeManager,
  desktopCompanionRemoteKey,
  disposeDesktopCompanionBridgeManager,
  getDesktopCompanionBridgeManager,
  type DesktopCompanionBridgeManager,
} from "./desktopCompanionBridge";
import { createE2ERemoteCompanionApi } from "../e2eRemoteCompanion";
import type {
  DesktopRemoteCompanionEvent,
  DesktopRemoteCompanionSubscription,
  DesktopRemoteTaskClient,
} from "./desktopRemoteTaskClient";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const BRIDGE_ONE = "1".repeat(32);
const BRIDGE_TWO = "2".repeat(32);
const BRIDGE_THREE = "3".repeat(32);
const BRIDGE_FOUR = "4".repeat(32);
const BRIDGE_FIVE = "5".repeat(32);
const entryUrl = (capability = "a".repeat(32)) =>
  `http://${"b".repeat(32)}.localhost:61234/?cap=${capability}`;

const snapshot = (overrides: Partial<CompanionSnapshot> = {}): CompanionSnapshot => ({
  sessionId: "session-1",
  revision: "revision-1",
  documentKind: "fragment",
  html: '<button data-choice="ship">Ship</button>',
  sourceOrigin: "http://localhost:52341",
  assets: [{
    name: "layout.png",
    contentType: "image/png",
    digest: "digest-1",
    dataB64: "UE5H",
  }],
  ...overrides,
});

const choice = (eventId = "browser-1"): CompanionEvent => ({
  event_id: eventId,
  type: "click",
  choice: "ship",
  text: "Ship",
  id: null,
  timestamp: 1,
});

function subscription() {
  return {
    close: vi.fn(),
    sendEvent: vi.fn(() => true),
  } satisfies DesktopRemoteCompanionSubscription;
}

function taskClient(
  remoteSubscription = subscription(),
  onObserve?: (listener: (event: DesktopRemoteCompanionEvent) => void) => void,
) {
  return {
    close: vi.fn(),
    observeCompanion: vi.fn((options) => {
      onObserve?.(options.listener);
      return remoteSubscription;
    }),
    observeTerminal: vi.fn(() => ({ close: vi.fn() })),
    sendInput: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    closeTask: vi.fn(async () => undefined),
    advanceStage: vi.fn(async () => undefined),
  } satisfies DesktopRemoteTaskClient;
}

describe("desktop companion bridge manager", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let openUrl: ReturnType<typeof vi.fn>;
  let unlisten: ReturnType<typeof vi.fn>;
  let browserListener: ((event: { payload: unknown }) => void) | undefined;
  let listen: ReturnType<typeof vi.fn>;
  let manager: DesktopCompanionBridgeManager;

  beforeEach(() => {
    invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "upsert_remote_companion_bridge") {
        const revision = String(args?.revision);
        return {
          bridgeId: revision === "revision-2" ? BRIDGE_TWO : BRIDGE_ONE,
          entryUrl: entryUrl(revision === "revision-2" ? "d".repeat(32) : "c".repeat(32)),
        };
      }
      return undefined;
    });
    openUrl = vi.fn(async () => undefined);
    unlisten = vi.fn();
    listen = vi.fn(async (_name: string, listener: (event: { payload: unknown }) => void) => {
      browserListener = listener;
      return unlisten;
    });
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      gracePeriodMs: 30_000,
    });
  });

  afterEach(async () => {
    await manager.dispose();
    vi.useRealTimers();
  });

  function adopt(
    remoteSubscription = subscription(),
    key = desktopCompanionRemoteKey("desktop-1", "task-1"),
  ) {
    const transport = taskClient(remoteSubscription);
    return {
      key,
      remoteSubscription,
      transport,
      ownership: manager.adoptRemote({
        remoteKey: key,
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport,
      }),
    };
  }

  it("installs ownership before observing so a synchronous snapshot is not lost", async () => {
    const remoteSubscription = subscription();
    const transport = taskClient(remoteSubscription, (listener) => {
      listener({
        type: "snapshot",
        taskId: "task-1",
        snapshot: snapshot(),
      });
    });
    const key = desktopCompanionRemoteKey("desktop-1", "task-1");

    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport,
    });

    expect(transport.observeCompanion).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      listener: expect.any(Function),
    });
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "companion", bridgeId: BRIDGE_ONE });
  });

  it("opens the current authenticated companion without a pointer-derived URL", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());

    await expect(manager.openCurrent(key)).resolves.toEqual({
      kind: "companion",
      bridgeId: BRIDGE_ONE,
    });
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(
      entryUrl("c".repeat(32)),
    );
  });

  it("processes synchronous unavailable and error events emitted during observation", async () => {
    const unavailableSubscription = subscription();
    const unavailableTransport = taskClient(unavailableSubscription, (listener) => {
      listener({ type: "snapshot", taskId: "task-1", snapshot: snapshot() });
      listener({ type: "unavailable", taskId: "task-1" });
    });
    const key = desktopCompanionRemoteKey("desktop-1", "task-1");
    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: unavailableTransport,
    });
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "unavailable" });
    await manager.closeRemote(key);

    const errorSubscription = subscription();
    const errorTransport = taskClient(errorSubscription, (listener) => {
      listener({ type: "snapshot", taskId: "task-2", snapshot: snapshot() });
      listener({
        type: "error",
        taskId: "task-2",
        code: "relay",
        message: "private",
      });
    });
    const errorKey = desktopCompanionRemoteKey("desktop-2", "task-2");
    manager.adoptRemote({
      remoteKey: errorKey,
      ownerDesktopId: "desktop-2",
      ownerTaskId: "task-2",
      transport: errorTransport,
    });
    expect(await manager.openForClickedLink(errorKey, "http://localhost:52341"))
      .toEqual({ kind: "companion", bridgeId: BRIDGE_ONE });
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_bridge_state", {
      bridgeId: BRIDGE_ONE,
      status: "error",
      selected: true,
    });
  });

  it("coalesces a synchronous observation burst to its latest complete snapshot", async () => {
    const remoteSubscription = subscription();
    const transport = taskClient(remoteSubscription, (listener) => {
      for (let index = 1; index <= 64; index += 1) {
        listener({
          type: "snapshot",
          taskId: "task-1",
          snapshot: snapshot({
            revision: `revision-${index}`,
            html: `<main>${index}:${"x".repeat(32_000)}</main>`,
          }),
        });
      }
    });
    const key = desktopCompanionRemoteKey("desktop-1", "task-1");
    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport,
    });

    await manager.openForClickedLink(key, "http://localhost:52341");
    const upserts = invoke.mock.calls.filter(
      ([command]) => command === "upsert_remote_companion_bridge",
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0][1]).toMatchObject({
      revision: "revision-64",
      documentHtml: expect.stringContaining("\\u003cmain>64:"),
    });
  });

  it("removes inserted ownership and closes the parent when observation throws", () => {
    const failedTransport = taskClient();
    failedTransport.observeCompanion.mockImplementation(() => {
      throw new Error("observe failed");
    });
    const key = desktopCompanionRemoteKey("desktop-1", "task-1");

    expect(() => manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: failedTransport,
    })).toThrow("observe failed");
    expect(failedTransport.close).toHaveBeenCalledTimes(1);

    expect(() => adopt(subscription(), key)).not.toThrow();
  });

  it("keeps existing ownership when replacement observation throws", async () => {
    const { key, remoteSubscription, transport } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("still-owned"),
      },
    });
    const failedTransport = taskClient();
    failedTransport.observeCompanion.mockImplementation((options) => {
      for (let index = 2; index <= 64; index += 1) {
        options.listener({
          type: "snapshot",
          taskId: "task-1",
          snapshot: snapshot({
            revision: `failed-${index}`,
            html: `<main>${index}:${"x".repeat(32_000)}</main>`,
            sourceOrigin: "http://localhost:60000",
          }),
        });
      }
      options.listener({
        type: "error",
        taskId: "task-1",
        code: "failed",
        message: "failed replacement",
      });
      throw new Error("observe failed");
    });

    expect(() => manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: failedTransport,
    })).toThrow("observe failed");
    expect(failedTransport.close).toHaveBeenCalledTimes(1);
    expect(remoteSubscription.close).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    manager.acceptRemoteEvent(key, {
      type: "event_result",
      taskId: "task-1",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "still-owned",
        accepted: true,
      },
    });
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "still-owned",
      accepted: true,
      code: undefined,
      message: undefined,
    });
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "companion", bridgeId: BRIDGE_ONE });
    expect(invoke).toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.objectContaining({
        revision: "revision-1",
        documentHtml: expect.stringContaining("Ship"),
      }),
    );
  });

  it("preserves a released ownership grace probe when replacement observation throws", async () => {
    vi.useFakeTimers();
    const { key, ownership, remoteSubscription, transport } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    ownership.release();
    await manager.whenIdle();

    const failedTransport = taskClient();
    failedTransport.observeCompanion.mockImplementation(() => {
      throw new Error("observe failed");
    });
    expect(() => manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: failedTransport,
    })).toThrow("observe failed");

    invoke.mockImplementation(async (command: string) => {
      if (command === "set_remote_companion_bridge_state") {
        throw Object.assign(new Error("gone"), { code: "bridge_not_found" });
      }
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await manager.whenIdle();

    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a same-client replacement observation attached", async () => {
    let currentListener:
      | ((event: DesktopRemoteCompanionEvent) => void)
      | undefined;
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const sharedTransport = taskClient();
    sharedTransport.observeCompanion.mockImplementation((options) => {
      currentListener = options.listener;
      const close = vi.fn(() => {
        currentListener = undefined;
      });
      closes.push(close);
      return {
        close,
        sendEvent: vi.fn(() => true),
      };
    });
    const key = desktopCompanionRemoteKey("desktop-1", "task-1");
    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: sharedTransport,
    });
    currentListener?.({
      type: "snapshot",
      taskId: "task-1",
      snapshot: snapshot(),
    });
    await manager.openForClickedLink(key, "http://localhost:52341");

    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: sharedTransport,
    });
    expect(closes[0]).not.toHaveBeenCalled();
    expect(sharedTransport.observeCompanion).toHaveBeenCalledTimes(1);
    currentListener?.({
      type: "snapshot",
      taskId: "task-1",
      snapshot: snapshot({ revision: "revision-2" }),
    });
    await manager.whenIdle();

    expect(invoke).toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.objectContaining({ revision: "revision-2" }),
    );
    await manager.closeRemote(key);
    expect(closes[0]).toHaveBeenCalledTimes(1);
  });

  it("abandons the old observation before a replacement close can emit queued callbacks", async () => {
    let firstListener:
      | ((event: DesktopRemoteCompanionEvent) => void)
      | undefined;
    const firstSubscription = subscription();
    const firstTransport = taskClient(firstSubscription, (listener) => {
      firstListener = listener;
    });
    firstSubscription.close.mockImplementation(() => {
      firstListener?.({
        type: "snapshot",
        taskId: "task-1",
        snapshot: snapshot({
          revision: "late-old-revision",
          html: "<main>late old observation</main>",
        }),
      });
    });
    const key = desktopCompanionRemoteKey("desktop-1", "task-1");
    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: firstTransport,
    });
    firstListener?.({
      type: "snapshot",
      taskId: "task-1",
      snapshot: snapshot(),
    });
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();

    let replacementListener:
      | ((event: DesktopRemoteCompanionEvent) => void)
      | undefined;
    const replacementTransport = taskClient(subscription(), (listener) => {
      replacementListener = listener;
    });
    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: replacementTransport,
    });
    await manager.whenIdle();
    expect(invoke).not.toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.objectContaining({ revision: "late-old-revision" }),
    );
    invoke.mockClear();

    firstListener?.({
      type: "snapshot",
      taskId: "task-1",
      snapshot: snapshot({
        revision: "queued-old-revision",
        html: "<main>queued old observation</main>",
      }),
    });
    await manager.whenIdle();
    expect(invoke).not.toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.objectContaining({ revision: "queued-old-revision" }),
    );
    replacementListener?.({
      type: "snapshot",
      taskId: "task-1",
      snapshot: snapshot({
        revision: "replacement-revision",
        html: "<main>replacement observation</main>",
      }),
    });
    await manager.whenIdle();

    const publishedRevisions = invoke.mock.calls
      .filter(([command]) => command === "upsert_remote_companion_bridge")
      .map(([, args]) => args?.revision);
    expect(publishedRevisions).toEqual(["replacement-revision"]);
  });

  it("contains an invalid synchronous replacement snapshot after ownership commits", async () => {
    const first = subscription();
    const { key, transport: firstTransport } = adopt(first);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");

    const replacementSubscription = subscription();
    const replacementTransport = taskClient(
      replacementSubscription,
      (listener) => {
        listener({
          type: "snapshot",
          taskId: "task-1",
          snapshot: snapshot({ revision: "" }),
        });
      },
    );
    let replacementOwnership:
      | ReturnType<DesktopCompanionBridgeManager["adoptRemote"]>
      | undefined;
    expect(() => {
      replacementOwnership = manager.adoptRemote({
        remoteKey: key,
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: replacementTransport,
      });
    }).not.toThrow();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(firstTransport.close).toHaveBeenCalledTimes(1);
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "unavailable" });
    replacementOwnership?.release();
    await manager.closeRemote(key);
    expect(replacementSubscription.close).toHaveBeenCalledTimes(1);
    expect(replacementTransport.close).toHaveBeenCalledTimes(1);
  });

  it("captures one complete snapshot and opens only its exact companion origin", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());

    expect(await manager.openForClickedLink(key, "http://localhost:52341/files/other")).toEqual({
      kind: "companion",
      bridgeId: BRIDGE_ONE,
    });

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith("remote-companion-browser-event", expect.any(Function));
    expect(invoke).toHaveBeenCalledWith("upsert_remote_companion_bridge", {
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      sessionId: "session-1",
      revision: "revision-1",
      documentHtml: expect.stringContaining("/ws"),
      lifecyclePageStrings: {
        unavailableTitle: "This visual companion has ended.",
        unavailableDetail: "The companion is no longer available.",
        errorTitle: "Visual companion unavailable",
        errorDetail: "The companion could not be displayed.",
      },
      assets: [{
        name: "layout.png",
        content_type: "image/png",
        digest: "digest-1",
        data_b64: "UE5H",
      }],
    });
    const documentHtml = invoke.mock.calls.find(
      ([command]) => command === "upsert_remote_companion_bridge",
    )?.[1]?.documentHtml as string;
    expect(documentHtml).toContain("session-1");
    expect(documentHtml).toContain("revision-1");
    expect(documentHtml).toContain(
      '\\u003cbutton data-choice=\\"ship\\">Ship\\u003c/button>',
    );
    expect(openUrl).toHaveBeenCalledWith(entryUrl("c".repeat(32)));

    expect(await manager.openForClickedLink(key, "http://localhost:60000")).toEqual({
      kind: "ordinary",
      url: "http://localhost:60000/",
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("captures app-owned non-English browser and lifecycle strings", async () => {
    await manager.dispose();
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      documentStrings: () => ({
        connecting: "接続しています…",
        retry: "再試行",
        available: "接続済みです。",
        reconnecting: "再接続しています…",
        unavailable: "ビジュアルコンパニオンは終了しました。",
        error: "ビジュアルコンパニオンを利用できません",
        sending: "選択内容を送信しています…",
        sent: "選択内容を送信しました。",
        selectionFailed: "選択内容を送信できませんでした。",
        unavailableDetail: "このコンパニオンは利用できなくなりました。",
        errorDetail: "コンパニオンを表示できませんでした。",
      }),
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());

    await manager.openForClickedLink(key, "http://localhost:52341");

    const args = invoke.mock.calls.find(
      ([command]) => command === "upsert_remote_companion_bridge",
    )?.[1];
    expect(args?.documentHtml).toContain("接続しています…");
    expect(args?.documentHtml).not.toContain(">Connecting…<");
    expect(args?.lifecyclePageStrings).toEqual({
      unavailableTitle: "ビジュアルコンパニオンは終了しました。",
      unavailableDetail: "このコンパニオンは利用できなくなりました。",
      errorTitle: "ビジュアルコンパニオンを利用できません",
      errorDetail: "コンパニオンを表示できませんでした。",
    });
  });

  it("preserves ordinary links before discovery while suppressing unknown loopback links", async () => {
    const { key } = adopt();

    expect(await manager.openForClickedLink(key, "https://example.com/report"))
      .toEqual({ kind: "ordinary", url: "https://example.com/report" });
    expect(await manager.openForClickedLink(key, "not a URL"))
      .toEqual({ kind: "invalid" });
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "unavailable" });
    expect(invoke).not.toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.anything(),
    );
  });

  it("never mixes a replacement snapshot identity into an in-flight render", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstUpsert = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      order.push(`upsert:${String(args?.revision)}`);
      if (args?.revision === "revision-1") await firstUpsert;
      return {
        bridgeId: BRIDGE_ONE,
        entryUrl: entryUrl(args?.revision === "revision-2" ? "d".repeat(32) : "c".repeat(32)),
      };
    });
    openUrl.mockImplementation(async (url: string) => {
      order.push(`open:${url.slice(url.lastIndexOf("=") + 1)}`);
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());

    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(order).toEqual(["upsert:revision-1"]));
    manager.acceptSnapshot(key, snapshot({
      revision: "revision-2",
      html: "<main>Second</main>",
      assets: [],
    }));
    releaseFirst();
    expect(await opening).toEqual({ kind: "companion", bridgeId: BRIDGE_ONE });
    await manager.whenIdle();

    const upserts = invoke.mock.calls.filter(([command]) =>
      command === "upsert_remote_companion_bridge");
    expect(upserts).toHaveLength(2);
    expect(upserts[0][1]).toMatchObject({
      sessionId: "session-1",
      revision: "revision-1",
      documentHtml: expect.stringContaining("Ship"),
    });
    expect(upserts[1][1]).toMatchObject({
      sessionId: "session-1",
      revision: "revision-2",
      documentHtml: expect.stringContaining("Second"),
    });
    expect(upserts[0][1].documentHtml).not.toContain("revision-2");
    expect(upserts[1][1].documentHtml).not.toContain("revision-1");
    expect(order).toEqual([
      "upsert:revision-1",
      "upsert:revision-2",
      `open:${"d".repeat(32)}`,
    ]);
  });

  it("keeps streaming revisions after Rust replaces a same-session bridge identity", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      return {
        bridgeId: args?.revision === "revision-1" ? BRIDGE_ONE : BRIDGE_TWO,
        entryUrl: entryUrl(),
      };
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");

    manager.acceptSnapshot(key, snapshot({ revision: "revision-2" }));
    await manager.whenIdle();
    manager.acceptSnapshot(key, snapshot({ revision: "revision-3" }));
    await manager.whenIdle();

    expect(invoke.mock.calls
      .filter(([command]) => command === "upsert_remote_companion_bridge")
      .map(([, args]) => args?.revision))
      .toEqual(["revision-1", "revision-2", "revision-3"]);
  });

  it("does not retain failed activation sessions behind an unrelated live bridge", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      if (args?.sessionId === "session-2") throw new Error("upsert failed");
      return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    manager.acceptSnapshot(key, snapshot({
      sessionId: "session-2",
      revision: "revision-2",
      sourceOrigin: "http://localhost:52342",
    }));
    await expect(manager.openForClickedLink(key, "http://localhost:52342"))
      .rejects.toThrow("upsert failed");
    invoke.mockClear();

    manager.acceptSnapshot(key, snapshot({
      sessionId: "session-3",
      revision: "revision-3",
      sourceOrigin: "http://localhost:52343",
    }));
    manager.acceptSnapshot(key, snapshot({
      sessionId: "session-2",
      revision: "revision-4",
      sourceOrigin: "http://localhost:52342",
    }));
    await manager.whenIdle();

    expect(invoke).not.toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.anything(),
    );
  });

  it("retains only one active and the latest pending complete bundle during a blocked publication burst", async () => {
    const revisions: string[] = [];
    let releaseActive!: () => void;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      const revision = String(args?.revision);
      revisions.push(revision);
      if (revision === "revision-1") {
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
      }
      return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(releaseActive).toBeTypeOf("function"));

    for (let index = 2; index <= 64; index += 1) {
      manager.acceptSnapshot(key, snapshot({
        revision: `revision-${index}`,
        html: `<main>${index}:${"x".repeat(32_000)}</main>`,
      }));
    }
    releaseActive();

    expect(await opening).toEqual({ kind: "companion", bridgeId: BRIDGE_ONE });
    await manager.whenIdle();
    expect(revisions).toEqual(["revision-1", "revision-64"]);
  });

  it("deduplicates concurrent activation clicks behind one bounded publication", async () => {
    let releaseActive!: () => void;
    let upserts = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      upserts += 1;
      if (upserts === 1) {
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
      }
      return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());

    const openings = Array.from(
      { length: 32 },
      () => manager.openForClickedLink(key, "http://localhost:52341"),
    );
    await vi.waitFor(() => expect(releaseActive).toBeTypeOf("function"));
    releaseActive();

    expect(await Promise.all(openings)).toEqual(
      Array.from(
        { length: 32 },
        () => ({ kind: "companion", bridgeId: BRIDGE_ONE }),
      ),
    );
    expect(upserts).toBe(1);
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("never shares an activation promise across source origins or sessions", async () => {
    let releaseFirst!: () => void;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      if (args?.sessionId === "session-1") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return {
        bridgeId: args?.sessionId === "session-1" ? BRIDGE_ONE : BRIDGE_TWO,
        entryUrl: entryUrl(),
      };
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const first = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));

    manager.acceptSnapshot(key, snapshot({
      sessionId: "session-2",
      revision: "revision-2",
      sourceOrigin: "http://localhost:52342",
    }));
    expect(await manager.openForClickedLink(key, "http://localhost:52342"))
      .toEqual({ kind: "unavailable" });
    releaseFirst();
    expect(await first).toEqual({ kind: "unavailable" });
    expect(openUrl).not.toHaveBeenCalled();

    expect(await manager.openForClickedLink(key, "http://localhost:52342"))
      .toEqual({ kind: "companion", bridgeId: BRIDGE_TWO });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("lets terminal close cancel a never-resolving opener", async () => {
    openUrl.mockImplementation(() => new Promise(() => undefined));
    window.__KANNA_E2E__ = {
      remoteCompanion: {},
      reset: () => undefined,
      taskStore: {
        add: () => undefined,
        clear: () => undefined,
        snapshot: () => [],
      },
      terminalOutputPerf: {
        beginEventLoopProbe: () => undefined,
        clear: () => undefined,
        endEventLoopProbe: () => undefined,
        snapshot: () => ({
          activeSessions: 0,
          latestEvent: null,
          maxEventLoopDriftMs: 0,
          maxFrameGapMs: 0,
          maxXtermBacklogMs: 0,
          pendingBytes: 0,
          pendingChunks: 0,
        }),
      },
    };
    const { key, remoteSubscription, transport } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));

    await expect(manager.closeRemote(key)).resolves.toBeUndefined();
    await expect(opening).resolves.toEqual({ kind: "unavailable" });
    expect(invoke).toHaveBeenCalledWith("close_remote_companion_bridge", {
      bridgeId: BRIDGE_ONE,
    });
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(window.__KANNA_E2E__.remoteCompanion?.lastEntryUrl).toBeUndefined();
    delete window.__KANNA_E2E__;
  });

  it("makes close terminal while one bundle is active and a latest bundle is pending", async () => {
    const revisions: string[] = [];
    let releaseActive!: () => void;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "upsert_remote_companion_bridge") {
        revisions.push(String(args?.revision));
        if (revisions.length === 1) {
          await new Promise<void>((resolve) => {
            releaseActive = resolve;
          });
        }
        return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
      }
      return undefined;
    });
    const { key, remoteSubscription, transport } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(releaseActive).toBeTypeOf("function"));
    manager.acceptSnapshot(key, snapshot({ revision: "revision-2" }));
    manager.acceptSnapshot(key, snapshot({ revision: "revision-3" }));

    const closing = manager.closeRemote(key);
    releaseActive();

    expect(await opening).toEqual({ kind: "unavailable" });
    await closing;
    expect(revisions).toEqual(["revision-1"]);
    expect(invoke).toHaveBeenCalledWith("close_remote_companion_bridge", {
      bridgeId: BRIDGE_ONE,
    });
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("services lifecycle between an active and continuously replaced bundle", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();

    const commands: string[] = [];
    let releaseActive!: () => void;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "upsert_remote_companion_bridge") {
        commands.push(`upsert:${String(args?.revision)}`);
        if (args?.revision === "revision-2") {
          await new Promise<void>((resolve) => {
            releaseActive = resolve;
          });
        }
        return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
      }
      if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.status)}`);
      }
      if (command === "set_remote_companion_event_result") {
        commands.push(`result:${String(args?.eventId)}`);
      }
      return undefined;
    });
    manager.acceptSnapshot(key, snapshot({ revision: "revision-2" }));
    await vi.waitFor(() => expect(releaseActive).toBeTypeOf("function"));
    for (let index = 3; index <= 40; index += 1) {
      manager.acceptSnapshot(key, snapshot({ revision: `revision-${index}` }));
    }
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("fair-result"),
      },
    });
    manager.acceptRemoteEvent(key, {
      type: "event_result",
      taskId: "task-1",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "fair-result",
        accepted: true,
      },
    });
    releaseActive();
    await manager.whenIdle();

    expect(commands).toEqual([
      "upsert:revision-2",
      "state:reconnecting",
      "upsert:revision-40",
      "state:reconnecting",
    ]);
  });

  it("routes strict correlated browser events and transport results to the current subscription", async () => {
    const { key, remoteSubscription } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice(),
      },
    });
    await flush();
    expect(remoteSubscription.sendEvent).toHaveBeenCalledWith(
      "session-1",
      "revision-1",
      {
        ...choice(),
        session_id: "session-1",
        revision: "revision-1",
      },
    );

    manager.acceptRemoteEvent(key, {
      type: "event_result",
      taskId: "task-1",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "browser-1",
        accepted: true,
      },
    });
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "browser-1",
      accepted: true,
      code: undefined,
      message: undefined,
    });

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "other-session",
        revision: "revision-1",
        event: choice("stale"),
      },
    });
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: { ...choice("extra"), extra: true },
      },
    });
    await flush();
    expect(remoteSubscription.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("reports a failed result immediately when the current transport rejects delivery", async () => {
    const remoteSubscription = subscription();
    remoteSubscription.sendEvent.mockReturnValue(false);
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice(),
      },
    });
    await manager.whenIdle();

    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "browser-1",
      accepted: false,
      code: "transport_unavailable",
      message: "Selection could not be delivered.",
    });
  });

  it("reports transport throws as failed results without escaping the global listener", async () => {
    const remoteSubscription = subscription();
    remoteSubscription.sendEvent.mockImplementation(() => {
      throw new Error("transport closed");
    });
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");

    expect(() => browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice(),
      },
    })).not.toThrow();
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith(
      "set_remote_companion_event_result",
      expect.objectContaining({
        eventId: "browser-1",
        accepted: false,
        code: "transport_unavailable",
      }),
    );
  });

  it("registers pending delivery before a transport reports a synchronous result", async () => {
    const remoteSubscription = subscription();
    const { key } = adopt(remoteSubscription);
    remoteSubscription.sendEvent.mockImplementation((_session, _revision, event) => {
      manager.acceptRemoteEvent(key, {
        type: "event_result",
        taskId: "task-1",
        result: {
          sessionId: "session-1",
          revision: "revision-1",
          eventId: event.event_id,
          accepted: true,
        },
      });
      return true;
    });
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice(),
      },
    });
    await manager.whenIdle();

    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "browser-1",
      accepted: true,
      code: undefined,
      message: undefined,
    });
  });

  it("times out unconfirmed browser events and restores bounded admission capacity", async () => {
    vi.useFakeTimers();
    await manager.dispose();
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      gracePeriodMs: 30_000,
      pendingEventTimeoutMs: 100,
    });
    const remoteSubscription = subscription();
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    invoke.mockClear();

    for (let index = 0; index < 65; index += 1) {
      browserListener?.({
        payload: {
          bridgeId: BRIDGE_ONE,
          sessionId: "session-1",
          revision: "revision-1",
          event: choice(`timeout-${index}`),
        },
      });
    }
    expect(remoteSubscription.sendEvent).toHaveBeenCalledTimes(64);
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_remote_companion_event_result") {
        throw Object.assign(new Error("browser disconnected"), {
          code: "bridge_not_found",
        });
      }
      return undefined;
    });

    await vi.advanceTimersByTimeAsync(100);
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "timeout-0",
      accepted: false,
      code: "event_timeout",
      message: "Selection confirmation timed out.",
    });

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("admitted-after-timeout"),
      },
    });
    expect(remoteSubscription.sendEvent).toHaveBeenCalledTimes(65);
  });

  it("lets an exact owner result win the pending deadline race", async () => {
    vi.useFakeTimers();
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    invoke.mockClear();
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("owner-before-timeout"),
      },
    });

    await vi.advanceTimersByTimeAsync(29_999);
    manager.acceptRemoteEvent(key, {
      type: "event_result",
      taskId: "task-1",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "owner-before-timeout",
        accepted: true,
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    await manager.whenIdle();

    const results = invoke.mock.calls.filter(
      ([command]) => command === "set_remote_companion_event_result",
    );
    expect(results).toEqual([[
      "set_remote_companion_event_result",
      expect.objectContaining({
        eventId: "owner-before-timeout",
        accepted: true,
      }),
    ]]);
  });

  it("clears every pending event deadline during disposal", async () => {
    vi.useFakeTimers();
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("dispose-pending"),
      },
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await manager.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds pending browser identities across many bundle replacements", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "upsert_remote_companion_bridge"
        ? { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() }
        : undefined);
    const remoteSubscription = subscription();
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    for (let index = 1; index <= 80; index += 1) {
      browserListener?.({
        payload: {
          bridgeId: BRIDGE_ONE,
          sessionId: "session-1",
          revision: `revision-${index}`,
          event: choice("reused"),
        },
      });
      manager.acceptSnapshot(key, snapshot({
        revision: `revision-${index + 1}`,
      }));
      await manager.whenIdle();
    }

    expect(remoteSubscription.sendEvent).toHaveBeenCalledTimes(80);
    expect(invoke).not.toHaveBeenCalledWith(
      "set_remote_companion_event_result",
      expect.anything(),
    );
  });

  it("fails unavailable pending events and enforces the Rust per-remote bound", async () => {
    const remoteSubscription = subscription();
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");

    for (let index = 0; index < 65; index += 1) {
      browserListener?.({
        payload: {
          bridgeId: BRIDGE_ONE,
          sessionId: "session-1",
          revision: "revision-1",
          event: choice(`bounded-${index}`),
        },
      });
    }
    expect(remoteSubscription.sendEvent).toHaveBeenCalledTimes(64);

    manager.acceptRemoteEvent(key, {
      type: "unavailable",
      taskId: "task-1",
    });
    manager.acceptRemoteEvent(key, {
      type: "event_result",
      taskId: "task-1",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "bounded-0",
        accepted: true,
      },
    });
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "bounded-0",
      accepted: false,
      code: "transport_unavailable",
      message: "Selection could not be delivered.",
    });
  });

  it("applies Rust's pending bound to the current live bridge", async () => {
    const remoteSubscription = subscription();
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");

    for (let index = 0; index < 65; index += 1) {
      browserListener?.({
        payload: {
          bridgeId: BRIDGE_ONE,
          sessionId: "session-1",
          revision: "revision-1",
          event: choice(`first-${index}`),
        },
      });
    }

    expect(remoteSubscription.sendEvent).toHaveBeenCalledTimes(64);
  });

  it("correlates out-of-order results when current bridges on two remotes reuse an event id", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      return {
        bridgeId: args?.ownerDesktopId === "desktop-1" ? BRIDGE_ONE : BRIDGE_TWO,
        entryUrl: entryUrl(),
      };
    });
    const firstSubscription = subscription();
    const first = adopt(firstSubscription);
    const secondSubscription = subscription();
    const secondTransport = taskClient(secondSubscription);
    const secondKey = desktopCompanionRemoteKey("desktop-2", "task-2");
    manager.adoptRemote({
      remoteKey: secondKey,
      ownerDesktopId: "desktop-2",
      ownerTaskId: "task-2",
      transport: secondTransport,
    });
    manager.acceptSnapshot(first.key, snapshot());
    manager.acceptSnapshot(secondKey, snapshot({
      sessionId: "session-2",
      revision: "revision-2",
      sourceOrigin: "http://localhost:52342",
    }));
    await manager.openForClickedLink(first.key, "http://localhost:52341");
    await manager.openForClickedLink(secondKey, "http://localhost:52342");
    invoke.mockClear();

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("same-generated-id"),
      },
    });
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_TWO,
        sessionId: "session-2",
        revision: "revision-2",
        event: choice("same-generated-id"),
      },
    });
    await manager.whenIdle();

    expect(firstSubscription.sendEvent).toHaveBeenCalledTimes(1);
    expect(secondSubscription.sendEvent).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "set_remote_companion_event_result",
      expect.anything(),
    );
    manager.acceptRemoteEvent(secondKey, {
      type: "event_result",
      taskId: "task-2",
      result: {
        sessionId: "session-2",
        revision: "revision-2",
        eventId: "same-generated-id",
        accepted: false,
        code: "second-first",
      },
    });
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_TWO,
      sessionId: "session-2",
      revision: "revision-2",
      eventId: "same-generated-id",
      accepted: false,
      code: "second-first",
      message: undefined,
    });
    manager.acceptRemoteEvent(first.key, {
      type: "event_result",
      taskId: "task-1",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "same-generated-id",
        accepted: true,
      },
    });
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "same-generated-id",
      accepted: true,
      code: undefined,
      message: undefined,
    });
  });

  it("fails pending delivery on ownership replacement and never routes its late result to the replacement", async () => {
    const first = subscription();
    const { key } = adopt(first);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice(),
      },
    });

    const second = subscription();
    const secondTransport = taskClient(second);
    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: secondTransport,
    });
    manager.acceptRemoteEvent(key, {
      type: "event_result",
      taskId: "task-1",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "browser-1",
        accepted: true,
      },
    });
    await manager.whenIdle();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.sendEvent).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "browser-1",
      accepted: false,
      code: "transport_replaced",
      message: "Selection could not be delivered.",
    });
  });

  it("coalesces lifecycle and selection changes to the latest authoritative state", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    invoke.mockClear();

    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    manager.setSelected(key, false);
    manager.acceptRemoteEvent(key, {
      type: "error",
      taskId: "task-1",
      code: "relay",
      message: "private transport detail",
    });
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: true,
    });
    await manager.whenIdle();

    expect(invoke.mock.calls.map(([command, args]) => [command, args?.status, args?.selected]))
      .toEqual([
        ["set_remote_companion_bridge_state", "reconnecting", false],
      ]);
  });

  it("keeps relay recovery reconnecting until a fresh authoritative snapshot is upserted", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    const commands: string[] = [];
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "upsert_remote_companion_bridge") {
        commands.push(`upsert:${String(args?.revision)}`);
        return {
          bridgeId: BRIDGE_ONE,
          entryUrl: entryUrl("c".repeat(32)),
        };
      }
      if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.status)}`);
      }
      return undefined;
    });

    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    await manager.whenIdle();
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: true,
    });
    await manager.whenIdle();

    expect(commands).toEqual(["state:reconnecting", "state:reconnecting"]);

    manager.acceptSnapshot(key, snapshot({
      revision: "revision-2",
      html: "<h1>Recovered</h1>",
    }));
    await manager.whenIdle();

    expect(commands).toEqual([
      "state:reconnecting",
      "state:reconnecting",
      "upsert:revision-2",
      "state:available",
    ]);
  });

  it("does not publish recovery availability while the fresh snapshot upsert is pending", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    const commands: string[] = [];
    let releaseReconnectState!: () => void;
    let releaseRecoveryUpsert!: () => void;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "set_remote_companion_bridge_state"
        && args?.status === "reconnecting"
      ) {
        commands.push("state:reconnecting:start");
        await new Promise<void>((resolve) => {
          releaseReconnectState = resolve;
        });
        commands.push("state:reconnecting:end");
      } else if (command === "upsert_remote_companion_bridge") {
        commands.push(`upsert:${String(args?.revision)}:start`);
        await new Promise<void>((resolve) => {
          releaseRecoveryUpsert = resolve;
        });
        commands.push(`upsert:${String(args?.revision)}:end`);
        return {
          bridgeId: BRIDGE_ONE,
          entryUrl: entryUrl("c".repeat(32)),
        };
      } else if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.status)}`);
      }
      return undefined;
    });

    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    await vi.waitFor(() =>
      expect(commands).toContain("state:reconnecting:start")
    );
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: true,
    });
    manager.acceptSnapshot(key, snapshot({
      revision: "revision-2",
      html: "<h1>Recovered</h1>",
    }));
    releaseReconnectState();
    await vi.waitFor(() =>
      expect(commands).toContain("upsert:revision-2:start")
    );

    expect(commands).not.toContain("state:available");

    releaseRecoveryUpsert();
    await manager.whenIdle();
    expect(commands.indexOf("upsert:revision-2:end")).toBeLessThan(
      commands.indexOf("state:available"),
    );
  });

  it("upserts a recovery snapshot that arrives before connected before publishing available", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    const commands: string[] = [];
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "upsert_remote_companion_bridge") {
        commands.push(`upsert:${String(args?.revision)}`);
        return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
      }
      if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.status)}`);
      }
      return undefined;
    });

    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    await manager.whenIdle();
    commands.length = 0;

    manager.acceptRemoteEvent(key, {
      type: "snapshot",
      taskId: "task-1",
      snapshot: snapshot({
        revision: "revision-2",
        html: "<h1>Recovered before connected</h1>",
      }),
    });
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: true,
    });
    await manager.whenIdle();

    const upsertIndex = commands.indexOf("upsert:revision-2");
    const availableIndex = commands.indexOf("state:available");
    expect(upsertIndex).toBeGreaterThanOrEqual(0);
    expect(availableIndex).toBeGreaterThan(upsertIndex);
    expect(commands.slice(0, upsertIndex)).not.toContain("state:available");
  });

  it("retries a failed recovery upsert without publishing stale availability", async () => {
    vi.useFakeTimers();
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    const commands: string[] = [];
    let upsertAttempts = 0;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "upsert_remote_companion_bridge") {
        upsertAttempts += 1;
        commands.push(`upsert:${String(args?.revision)}:${upsertAttempts}`);
        if (upsertAttempts === 1) throw new Error("transient bridge failure");
        return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
      }
      if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.status)}`);
      }
      return undefined;
    });

    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    await manager.whenIdle();
    commands.length = 0;
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: true,
    });
    manager.acceptRemoteEvent(key, {
      type: "snapshot",
      taskId: "task-1",
      snapshot: snapshot({ revision: "revision-2" }),
    });
    await manager.whenIdle();

    expect(commands).toContain("upsert:revision-2:1");
    expect(commands).not.toContain("state:available");
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.whenIdle();
    expect(commands).toContain("upsert:revision-2:2");
    expect(commands.indexOf("upsert:revision-2:2")).toBeLessThan(
      commands.indexOf("state:available"),
    );
  });

  it("revokes stale availability when ownership moves to a new observation", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    invoke.mockClear();

    const replacementSubscription = subscription();
    const replacementTransport = taskClient(replacementSubscription);
    manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: replacementTransport,
    });
    await manager.whenIdle();

    expect(invoke).toHaveBeenCalledWith(
      "set_remote_companion_bridge_state",
      expect.objectContaining({ status: "reconnecting" }),
    );
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "unavailable" });
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("stale-replacement-event"),
      },
    });
    expect(replacementSubscription.sendEvent).not.toHaveBeenCalled();
  });

  it("publishes reliable disconnect and error failures before lifecycle state", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    const commands: string[] = [];
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "set_remote_companion_event_result") {
        commands.push(`result:${String(args?.code)}`);
      } else if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.status)}`);
      }
      return undefined;
    });

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("disconnect-pending"),
      },
    });
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    await manager.whenIdle();
    expect(commands).toEqual([
      "result:transport_ambiguous",
      "state:reconnecting",
    ]);

    commands.length = 0;
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("error-pending"),
      },
    });
    manager.acceptRemoteEvent(key, {
      type: "error",
      taskId: "task-1",
      code: "private",
      message: "private",
    });
    await manager.whenIdle();
    expect(commands).toEqual([
      "result:transport_unavailable",
      "state:error",
    ]);
  });

  it("preserves an accepted send identity across ambiguous disconnect retry", async () => {
    const remoteSubscription = subscription();
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    invoke.mockClear();
    const original = choice("ambiguous-x");
    const identifiedOriginal = {
      ...original,
      session_id: "session-1",
      revision: "revision-1",
    };

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: original,
      },
    });
    expect(remoteSubscription.sendEvent).toHaveBeenLastCalledWith(
      "session-1",
      "revision-1",
      identifiedOriginal,
    );
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    await manager.whenIdle();
    expect(invoke).toHaveBeenCalledWith("set_remote_companion_event_result", {
      bridgeId: BRIDGE_ONE,
      sessionId: "session-1",
      revision: "revision-1",
      eventId: "ambiguous-x",
      accepted: false,
      code: "transport_ambiguous",
      message: "Selection confirmation was interrupted. Retry is safe.",
    });

    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: true,
    });
    manager.acceptSnapshot(key, snapshot());
    await manager.whenIdle();
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: original,
      },
    });
    expect(remoteSubscription.sendEvent).toHaveBeenLastCalledWith(
      "session-1",
      "revision-1",
      identifiedOriginal,
    );
    expect(remoteSubscription.sendEvent).toHaveBeenCalledTimes(2);
  });

  it("yields a blocked activation catch-up to result and lifecycle lanes", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();

    const commands: string[] = [];
    let releaseUpsert!: () => void;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "upsert_remote_companion_bridge") {
        commands.push(`upsert:${String(args?.revision)}`);
        if (args?.revision === "revision-1") {
          await new Promise<void>((resolve) => {
            releaseUpsert = resolve;
          });
        }
        return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
      }
      if (command === "set_remote_companion_event_result") {
        commands.push(`result:${String(args?.code)}`);
      } else if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.status)}`);
      }
      return undefined;
    });
    const reopening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(releaseUpsert).toBeTypeOf("function"));
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("blocked-activation"),
      },
    });
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    manager.acceptSnapshot(key, snapshot({ revision: "revision-2" }));
    releaseUpsert();

    await reopening;
    await manager.whenIdle();
    expect(commands).toEqual([
      "upsert:revision-1",
      "result:transport_ambiguous",
      "state:reconnecting",
      "upsert:revision-2",
      "state:reconnecting",
    ]);
  });

  it("keeps an older session unavailable when lifecycle changes belong to its replacement", async () => {
    let bridgeCounter = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      bridgeCounter += 1;
      return {
        bridgeId: bridgeCounter === 1 ? BRIDGE_ONE : BRIDGE_TWO,
        entryUrl: entryUrl(bridgeCounter === 1 ? "c".repeat(32) : "d".repeat(32)),
      };
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    manager.acceptSnapshot(key, snapshot({
      sessionId: "session-2",
      revision: "revision-2",
      sourceOrigin: "http://localhost:52342",
    }));
    await manager.openForClickedLink(key, "http://localhost:52342");
    await manager.whenIdle();
    invoke.mockClear();

    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    await manager.whenIdle();

    expect(invoke.mock.calls).toEqual([
      ["set_remote_companion_bridge_state", {
        bridgeId: BRIDGE_ONE,
        status: "unavailable",
        selected: true,
      }],
      ["set_remote_companion_bridge_state", {
        bridgeId: BRIDGE_ONE,
        status: "unavailable",
        selected: true,
      }],
      ["set_remote_companion_bridge_state", {
        bridgeId: BRIDGE_TWO,
        status: "reconnecting",
        selected: true,
      }],
    ]);
  });

  it("fails old-session pending events before unavailable and restores admission capacity", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      return {
        bridgeId: args?.sessionId === "session-1" ? BRIDGE_ONE : BRIDGE_TWO,
        entryUrl: entryUrl(),
      };
    });
    const remoteSubscription = subscription();
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();

    const commands: string[] = [];
    let releaseFirstResult!: () => void;
    let blockedFirstResult = false;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "set_remote_companion_event_result") {
        commands.push(
          `result:${String(args?.eventId)}:${String(args?.accepted)}:${String(args?.code)}`,
        );
        if (!blockedFirstResult) {
          blockedFirstResult = true;
          await new Promise<void>((resolve) => {
            releaseFirstResult = resolve;
          });
        }
      } else if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.bridgeId)}:${String(args?.status)}`);
      } else if (command === "upsert_remote_companion_bridge") {
        return { bridgeId: BRIDGE_TWO, entryUrl: entryUrl() };
      }
      return undefined;
    });
    for (const eventId of ["owner-won", "replace-1", "replace-2"]) {
      browserListener?.({
        payload: {
          bridgeId: BRIDGE_ONE,
          sessionId: "session-1",
          revision: "revision-1",
          event: choice(eventId),
        },
      });
    }
    manager.acceptRemoteEvent(key, {
      type: "event_result",
      taskId: "task-1",
      result: {
        sessionId: "session-1",
        revision: "revision-1",
        eventId: "owner-won",
        accepted: true,
      },
    });
    manager.acceptSnapshot(key, snapshot({
      sessionId: "session-2",
      revision: "revision-2",
      sourceOrigin: "http://localhost:52342",
    }));
    await vi.waitFor(() => expect(releaseFirstResult).toBeTypeOf("function"));
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("late-old-session"),
      },
    });
    releaseFirstResult();
    await manager.whenIdle();

    expect(commands).toEqual([
      "result:owner-won:true:undefined",
      "result:replace-1:false:session_replaced",
      "result:replace-2:false:session_replaced",
      `state:${BRIDGE_ONE}:unavailable`,
      `state:${BRIDGE_ONE}:unavailable`,
    ]);

    commands.length = 0;
    await manager.openForClickedLink(key, "http://localhost:52342");
    for (let index = 0; index < 64; index += 1) {
      browserListener?.({
        payload: {
          bridgeId: BRIDGE_TWO,
          sessionId: "session-2",
          revision: "revision-2",
          event: choice(`new-${index}`),
        },
      });
    }
    expect(remoteSubscription.sendEvent).toHaveBeenCalledTimes(3 + 64);
  });

  it("rejects old-revision ingress during a blocked same-session bundle swap", async () => {
    const remoteSubscription = subscription();
    const { key } = adopt(remoteSubscription);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();

    let releaseRevision!: () => void;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "upsert_remote_companion_bridge" &&
        args?.revision === "revision-2"
      ) {
        await new Promise<void>((resolve) => {
          releaseRevision = resolve;
        });
        return { bridgeId: BRIDGE_ONE, entryUrl: entryUrl() };
      }
      return undefined;
    });
    manager.acceptSnapshot(key, snapshot({ revision: "revision-2" }));
    await vi.waitFor(() => expect(releaseRevision).toBeTypeOf("function"));
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("revision-window"),
      },
    });
    expect(remoteSubscription.sendEvent).not.toHaveBeenCalledWith(
      "session-1",
      "revision-1",
      expect.objectContaining({ event_id: "revision-window" }),
    );
    releaseRevision();
    await manager.whenIdle();
    expect(invoke).not.toHaveBeenCalledWith(
      "set_remote_companion_event_result",
      expect.objectContaining({ eventId: "revision-window" }),
    );

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_ONE,
        sessionId: "session-1",
        revision: "revision-2",
        event: choice("current-revision"),
      },
    });
    expect(remoteSubscription.sendEvent).toHaveBeenCalledWith(
      "session-1",
      "revision-2",
      expect.objectContaining({ event_id: "current-revision" }),
    );
  });

  it("clears ended discovery metadata so an unavailable companion cannot be reopened", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    manager.acceptRemoteEvent(key, {
      type: "unavailable",
      taskId: "task-1",
    });
    await manager.whenIdle();
    invoke.mockClear();
    openUrl.mockClear();

    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "unavailable" });
    expect(invoke).not.toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.anything(),
    );
    expect(openUrl).not.toHaveBeenCalled();

    manager.acceptSnapshot(key, snapshot({
      revision: "revision-2",
      html: "<main>Fresh</main>",
    }));
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "companion", bridgeId: BRIDGE_TWO });
  });

  it("immediately reconciles a browserless unavailable bridge while retaining selected observation", async () => {
    const { key, remoteSubscription, transport } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    invoke.mockClear();
    let unavailableCalls = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_remote_companion_bridge_state") {
        unavailableCalls += 1;
        if (unavailableCalls === 2) {
          throw Object.assign(new Error("gone"), { code: "bridge_not_found" });
        }
      }
      if (command === "upsert_remote_companion_bridge") {
        return { bridgeId: BRIDGE_TWO, entryUrl: entryUrl() };
      }
      return undefined;
    });

    manager.acceptRemoteEvent(key, {
      type: "unavailable",
      taskId: "task-1",
    });
    await manager.whenIdle();

    expect(unavailableCalls).toBe(2);
    expect(remoteSubscription.close).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    manager.acceptSnapshot(key, snapshot({ revision: "revision-2" }));
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "companion", bridgeId: BRIDGE_TWO });
  });

  it("closes released ownership as soon as unavailable reconciliation finds no browser", async () => {
    const { key, remoteSubscription, transport, ownership } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    ownership.release();
    await manager.whenIdle();
    let unavailableCalls = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_remote_companion_bridge_state") {
        unavailableCalls += 1;
        if (unavailableCalls === 2) {
          throw Object.assign(new Error("gone"), { code: "bridge_not_found" });
        }
      }
      return undefined;
    });

    manager.acceptRemoteEvent(key, {
      type: "unavailable",
      taskId: "task-1",
    });
    await manager.whenIdle();

    expect(unavailableCalls).toBe(2);
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("re-probes a browser-retained unavailable bridge without renewing grace", async () => {
    vi.useFakeTimers();
    const { key, remoteSubscription, transport, ownership } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    ownership.release();
    await manager.whenIdle();
    let unavailableCalls = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_remote_companion_bridge_state") {
        unavailableCalls += 1;
        if (unavailableCalls === 3) {
          throw Object.assign(new Error("gone"), { code: "bridge_not_found" });
        }
      }
      return undefined;
    });

    manager.acceptRemoteEvent(key, {
      type: "unavailable",
      taskId: "task-1",
    });
    await manager.whenIdle();
    expect(unavailableCalls).toBe(2);
    expect(remoteSubscription.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await manager.whenIdle();
    expect(unavailableCalls).toBe(3);
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale unavailable probe retire a fresh replacement snapshot", async () => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    const commands: string[] = [];
    let releaseUnavailable!: () => void;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "set_remote_companion_bridge_state" &&
        args?.status === "unavailable"
      ) {
        commands.push("unavailable");
        await new Promise<void>((resolve) => {
          releaseUnavailable = resolve;
        });
        return undefined;
      }
      if (command === "upsert_remote_companion_bridge") {
        commands.push(`upsert:${String(args?.revision)}`);
        return { bridgeId: BRIDGE_TWO, entryUrl: entryUrl() };
      }
      if (command === "set_remote_companion_bridge_state") {
        commands.push(`state:${String(args?.status)}`);
      }
      return undefined;
    });
    manager.acceptRemoteEvent(key, {
      type: "unavailable",
      taskId: "task-1",
    });
    await vi.waitFor(() => expect(releaseUnavailable).toBeTypeOf("function"));
    manager.acceptSnapshot(key, snapshot({ revision: "revision-2" }));
    releaseUnavailable();
    await manager.whenIdle();

    expect(commands.filter((command) => command === "unavailable")).toHaveLength(1);
    expect(commands).toContain("upsert:revision-2");
    expect(commands.at(-1)).toBe("state:available");
  });

  it("retires stale bridge identities across repeated unavailable and new-session cycles", async () => {
    vi.useFakeTimers();
    const { key, remoteSubscription, transport } = adopt();
    const bridgeIds = [BRIDGE_ONE, BRIDGE_TWO, BRIDGE_THREE];
    const unavailableCounts = new Map<string, number>();
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "upsert_remote_companion_bridge") {
        const sessionIndex = Number(String(args?.sessionId).split("-").at(-1)) - 1;
        return {
          bridgeId: bridgeIds[sessionIndex],
          entryUrl: entryUrl(String(sessionIndex + 1).repeat(32)),
        };
      }
      if (
        command === "set_remote_companion_bridge_state" &&
        args?.status === "unavailable"
      ) {
        const bridgeId = String(args.bridgeId);
        const count = (unavailableCounts.get(bridgeId) ?? 0) + 1;
        unavailableCounts.set(bridgeId, count);
        if (count === 2) {
          throw Object.assign(new Error("gone"), { code: "bridge_not_found" });
        }
      }
      return undefined;
    });

    for (let index = 1; index <= 3; index += 1) {
      manager.acceptSnapshot(key, snapshot({
        sessionId: `session-${index}`,
        revision: `revision-${index}`,
        sourceOrigin: `http://localhost:${52340 + index}`,
      }));
      expect(await manager.openForClickedLink(
        key,
        `http://localhost:${52340 + index}`,
      )).toEqual({ kind: "companion", bridgeId: bridgeIds[index - 1] });
      manager.acceptRemoteEvent(key, {
        type: "unavailable",
        taskId: "task-1",
      });
      await manager.whenIdle();
    }

    expect([...unavailableCounts.values()]).toEqual([2, 2, 2]);
    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.whenIdle();
    expect(invoke).not.toHaveBeenCalled();
    expect(remoteSubscription.close).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("hands ownership to a replacement and keeps it past component release while a bridge may be open", async () => {
    vi.useFakeTimers();
    const first = subscription();
    const { key, ownership, transport: firstTransport } = adopt(first);
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");

    const second = subscription();
    const secondTransport = taskClient(second);
    const replacement = manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: secondTransport,
    });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(firstTransport.close).toHaveBeenCalledTimes(1);
    ownership.release();
    replacement.release();
    expect(second.close).not.toHaveBeenCalled();

    invoke.mockRejectedValueOnce(new Error("visual companion bridge not found"));
    await vi.advanceTimersByTimeAsync(30_000);
    await manager.whenIdle();
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(secondTransport.close).toHaveBeenCalledTimes(1);
  });

  it("rejects an ownership replacement whose identity does not match the remote key", () => {
    const { key, remoteSubscription } = adopt();
    const attacker = subscription();
    const attackerTransport = taskClient(attacker);
    expect(() => manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-other",
      ownerTaskId: "task-other",
      transport: attackerTransport,
    })).toThrow("remote companion owner task is already adopted");
    expect(attackerTransport.observeCompanion).not.toHaveBeenCalled();
    expect(attackerTransport.close).toHaveBeenCalledTimes(1);
    expect(remoteSubscription.close).not.toHaveBeenCalled();
  });

  it("retries transient grace probes but retires only a classified missing bridge", async () => {
    vi.useFakeTimers();
    const { key, remoteSubscription, ownership } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    ownership.release();
    await manager.whenIdle();

    invoke.mockRejectedValueOnce(new Error("temporary IPC interruption"));
    await vi.advanceTimersByTimeAsync(30_000);
    await manager.whenIdle();
    expect(remoteSubscription.close).not.toHaveBeenCalled();

    const retired = Object.assign(new Error("localized message"), {
      code: "bridge_not_found",
    });
    invoke.mockRejectedValueOnce(retired);
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.whenIdle();
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
  });

  it("cancels the grace probe when the remote is reselected", async () => {
    vi.useFakeTimers();
    const { key, remoteSubscription, ownership } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    ownership.release();
    manager.setSelected(key, true);
    await manager.whenIdle();

    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.whenIdle();
    expect(remoteSubscription.close).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("retries a transient reselect before the original deselection grace expires", async () => {
    vi.useFakeTimers();
    const { key, remoteSubscription, ownership } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    ownership.release();
    await manager.whenIdle();
    invoke.mockClear();
    let selectedAttempts = 0;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (
        command === "set_remote_companion_bridge_state" &&
        args?.selected === true
      ) {
        selectedAttempts += 1;
        if (selectedAttempts === 1) {
          throw new Error("temporary IPC interruption");
        }
      }
      return undefined;
    });

    manager.setSelected(key, true);
    await manager.whenIdle();
    expect(selectedAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await manager.whenIdle();
    expect(selectedAttempts).toBe(2);
    expect(remoteSubscription.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    await manager.whenIdle();
    expect(selectedAttempts).toBe(2);
    expect(remoteSubscription.close).not.toHaveBeenCalled();
  });

  it("retries only the latest authoritative lifecycle after a transient failure", async () => {
    vi.useFakeTimers();
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.whenIdle();
    invoke.mockClear();
    const statuses: unknown[] = [];
    let rejectFirst!: (error: unknown) => void;
    let stateCalls = 0;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "set_remote_companion_bridge_state") return undefined;
      stateCalls += 1;
      statuses.push(args?.status);
      if (stateCalls === 1) {
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return undefined;
    });

    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: false,
    });
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
    manager.acceptRemoteEvent(key, {
      type: "error",
      taskId: "task-1",
      code: "temporary",
      message: "temporary",
    });
    manager.acceptRemoteEvent(key, {
      type: "connection",
      taskId: "task-1",
      connected: true,
    });
    rejectFirst(new Error("temporary IPC interruption"));
    await manager.whenIdle();

    expect(statuses).toEqual(["reconnecting", "reconnecting"]);
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.whenIdle();
    expect(statuses).toEqual(["reconnecting", "reconnecting"]);
  });

  it("does not open an entry after component ownership is released during an upsert", async () => {
    let releaseUpsert!: () => void;
    invoke.mockImplementation(async (command: string) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      await new Promise<void>((resolve) => {
        releaseUpsert = resolve;
      });
      return {
        bridgeId: BRIDGE_ONE,
        entryUrl: entryUrl("c".repeat(32)),
      };
    });
    const { key, ownership } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(releaseUpsert).toBeTypeOf("function"));
    ownership.release();
    releaseUpsert();

    expect(await opening).toEqual({ kind: "unavailable" });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not start an upsert after ownership is released during listener installation", async () => {
    let releaseListen!: (unlisten: () => void) => void;
    listen.mockImplementation(() => new Promise((resolve) => {
      releaseListen = resolve;
    }));
    await manager.dispose();
    unlisten.mockClear();
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      gracePeriodMs: 30_000,
    });
    const { key, ownership } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    ownership.release();
    releaseListen(unlisten);

    expect(await opening).toEqual({ kind: "unavailable" });
    expect(invoke).not.toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.anything(),
    );
  });

  it("does not capture a snapshot cleared while listener installation is pending", async () => {
    let releaseListen!: (unlisten: () => void) => void;
    listen.mockImplementation(() => new Promise((resolve) => {
      releaseListen = resolve;
    }));
    await manager.dispose();
    unlisten.mockClear();
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      gracePeriodMs: 30_000,
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");

    manager.acceptRemoteEvent(key, {
      type: "unavailable",
      taskId: "task-1",
    });
    releaseListen(unlisten);

    expect(await opening).toEqual({ kind: "unavailable" });
    expect(invoke).not.toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.anything(),
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not open a replacement snapshot whose origin changed during listener installation", async () => {
    let releaseListen!: (unlisten: () => void) => void;
    listen.mockImplementation(() => new Promise((resolve) => {
      releaseListen = resolve;
    }));
    await manager.dispose();
    unlisten.mockClear();
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      gracePeriodMs: 30_000,
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");

    manager.acceptSnapshot(key, snapshot({
      sessionId: "session-2",
      revision: "revision-2",
      sourceOrigin: "http://localhost:52342",
    }));
    releaseListen(unlisten);

    expect(await opening).toEqual({ kind: "unavailable" });
    expect(invoke).not.toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.anything(),
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("captures a replacement snapshot atomically when its origin is unchanged during listener installation", async () => {
    let releaseListen!: (unlisten: () => void) => void;
    listen.mockImplementation(() => new Promise((resolve) => {
      releaseListen = resolve;
    }));
    await manager.dispose();
    unlisten.mockClear();
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      gracePeriodMs: 30_000,
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");

    manager.acceptSnapshot(key, snapshot({
      sessionId: "session-2",
      revision: "revision-2",
      html: "<p>replacement</p>",
    }));
    releaseListen(unlisten);

    expect(await opening).toEqual({
      kind: "companion",
      bridgeId: BRIDGE_TWO,
    });
    expect(invoke).toHaveBeenCalledWith("upsert_remote_companion_bridge", expect.objectContaining({
      sessionId: "session-2",
      revision: "revision-2",
      documentHtml: expect.stringContaining("\\u003cp>replacement\\u003c/p>"),
    }));
  });

  it("closes an unneeded subscription and its transport immediately when its component releases before a click", () => {
    const { remoteSubscription, transport, ownership } = adopt();
    ownership.release();
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("rejects the same owner task under a second caller-controlled remote key", () => {
    adopt();
    const duplicate = subscription();
    const duplicateTransport = taskClient(duplicate);
    expect(() => manager.adoptRemote({
      remoteKey: "view-b",
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: duplicateTransport,
    })).toThrow("remote companion owner task is already adopted");
    expect(duplicateTransport.observeCompanion).not.toHaveBeenCalled();
    expect(duplicateTransport.close).toHaveBeenCalledTimes(1);
  });

  it("builds canonical owner-task keys without delimiter collisions", () => {
    expect(desktopCompanionRemoteKey("a:b", "c"))
      .not.toBe(desktopCompanionRemoteKey("a", "b:c"));
    expect(desktopCompanionRemoteKey("a\u0000b", "c"))
      .not.toBe(desktopCompanionRemoteKey("a", "b\u0000c"));
  });

  it("provides one lazy application-scoped manager with idempotent shutdown", async () => {
    const first = getDesktopCompanionBridgeManager();
    expect(getDesktopCompanionBridgeManager()).toBe(first);
    await disposeDesktopCompanionBridgeManager();
    await disposeDesktopCompanionBridgeManager();
  });

  it("bulk-releases its window lease during deterministic disposal", async () => {
    let releaseLease!: () => void;
    const leaseInvoke = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseLease = resolve;
      }),
    );
    const leasedManager = createDesktopCompanionBridgeManager({
      invoke: leaseInvoke,
      listen: async () => () => undefined,
      leaseGeneration: "lease-test",
    });

    const firstDisposal = leasedManager.dispose();
    const secondDisposal = leasedManager.dispose();
    await vi.waitFor(() => expect(releaseLease).toBeTypeOf("function"));
    let secondSettled = false;
    void secondDisposal.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    releaseLease();
    await Promise.all([firstDisposal, secondDisposal]);

    expect(leaseInvoke).toHaveBeenCalledWith(
      "close_remote_companion_bridges_for_lease",
      { leaseGeneration: "lease-test" },
    );
    expect(leaseInvoke).toHaveBeenCalledOnce();
  });

  it("isolates multiple entries and rejects duplicate pending event ids within one remote task", async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      return {
        bridgeId: args?.ownerDesktopId === "desktop-1" ? BRIDGE_THREE : BRIDGE_FOUR,
        entryUrl: entryUrl(args?.ownerDesktopId === "desktop-1" ? "3".repeat(32) : "4".repeat(32)),
      };
    });
    const first = adopt(
      subscription(),
      desktopCompanionRemoteKey("desktop-1", "task-1"),
    );
    const secondSubscription = subscription();
    const secondTransport = taskClient(secondSubscription);
    const second = {
      key: desktopCompanionRemoteKey("desktop-2", "task-2"),
      remoteSubscription: secondSubscription,
      ownership: manager.adoptRemote({
        remoteKey: desktopCompanionRemoteKey("desktop-2", "task-2"),
        ownerDesktopId: "desktop-2",
        ownerTaskId: "task-2",
        transport: secondTransport,
      }),
    };
    manager.acceptSnapshot(first.key, snapshot());
    manager.acceptSnapshot(second.key, snapshot({
      sessionId: "session-2",
      sourceOrigin: "http://localhost:52342",
    }));
    await manager.openForClickedLink(first.key, "http://localhost:52341");
    await manager.openForClickedLink(second.key, "http://localhost:52342");

    browserListener?.({
      payload: {
        bridgeId: BRIDGE_THREE,
        sessionId: "session-1",
        revision: "revision-1",
        event: choice("same-id"),
      },
    });
    browserListener?.({
      payload: {
        bridgeId: BRIDGE_FOUR,
        sessionId: "session-2",
        revision: "revision-1",
        event: choice("same-id"),
      },
    });
    await flush();
    expect(first.remoteSubscription.sendEvent).toHaveBeenCalledTimes(1);
    expect(second.remoteSubscription.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("publishes selected B as available while released A remains isolated by its browser lease", async () => {
    window.__KANNA_E2E__ = {
      remoteCompanion: createE2ERemoteCompanionApi(),
    } as Window["__KANNA_E2E__"];
    const ownerA = {
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
    };
    const ownerB = {
      ownerDesktopId: "desktop-2",
      ownerTaskId: "task-2",
    };

    try {
      const remoteA = adopt(
        subscription(),
        desktopCompanionRemoteKey(
          ownerA.ownerDesktopId,
          ownerA.ownerTaskId,
        ),
      );
      manager.acceptRemoteEvent(remoteA.key, {
        type: "connection",
        taskId: ownerA.ownerTaskId,
        connected: true,
      });
      manager.acceptSnapshot(remoteA.key, snapshot());
      window.__KANNA_E2E__?.remoteCompanion?.captureNextOpen(ownerA);
      await manager.openForClickedLink(
        remoteA.key,
        "http://localhost:52341",
      );
      remoteA.ownership.release();
      await manager.whenIdle();
      const releasedA =
        window.__KANNA_E2E__?.remoteCompanion?.snapshot(ownerA);
      expect(releasedA).toMatchObject({
        ...ownerA,
        sessionId: "session-1",
        revision: "revision-1",
        status: "available",
      });

      const remoteBKey = desktopCompanionRemoteKey(
        ownerB.ownerDesktopId,
        ownerB.ownerTaskId,
      );
      const remoteBTransport = taskClient();
      manager.adoptRemote({
        remoteKey: remoteBKey,
        ownerDesktopId: ownerB.ownerDesktopId,
        ownerTaskId: ownerB.ownerTaskId,
        transport: remoteBTransport,
      });
      manager.acceptRemoteEvent(remoteBKey, {
        type: "connection",
        taskId: ownerB.ownerTaskId,
        connected: true,
      });
      manager.acceptSnapshot(remoteBKey, snapshot({
        sessionId: "session-2",
        sourceOrigin: "http://localhost:52342",
      }));
      await manager.whenIdle();

      expect(
        window.__KANNA_E2E__?.remoteCompanion?.snapshot(ownerB),
      ).toMatchObject({
        ...ownerB,
        sessionId: "session-2",
        revision: "revision-1",
        status: "available",
      });
      expect(
        window.__KANNA_E2E__?.remoteCompanion?.snapshot(ownerA),
      ).toEqual(releasedA);
      expect(remoteA.remoteSubscription.close).not.toHaveBeenCalled();
      expect(remoteBTransport.close).not.toHaveBeenCalled();
    } finally {
      delete window.__KANNA_E2E__;
    }
  });

  it("accepts a reusable unconsumed capability and a fresh post-exchange capability without persisting either", async () => {
    let counter = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command !== "upsert_remote_companion_bridge") return undefined;
      counter += 1;
      return {
        bridgeId: BRIDGE_ONE,
        entryUrl: entryUrl(counter <= 2 ? "1".repeat(32) : "2".repeat(32)),
      };
    });
    await manager.dispose();
    window.__KANNA_E2E__ = {
      ready: false,
      setupState: null,
      dbName: "test",
      taskSwitchPerf: { getLatest: () => null, getAll: () => [], clear: () => undefined },
      appMetrics: { snapshot: () => ({
        invokeCounts: {}, listenCounts: {}, unlistenCounts: {}, activeListenCounts: {},
      }), clear: () => undefined },
      terminalOutputPerf: { snapshot: () => ({
        activeSessions: 0, maxFrameGapMs: 0, maxEventLoopDriftMs: 0,
        maxXtermBacklogMs: 0, pendingChunks: 0, pendingBytes: 0, latestEvent: null,
      }), clear: () => undefined, beginEventLoopProbe: () => undefined, endEventLoopProbe: () => undefined },
      remoteCompanion: createE2ERemoteCompanionApi(),
    };
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      gracePeriodMs: 30_000,
    });
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());

    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.openForClickedLink(key, "http://localhost:52341");
    await manager.openForClickedLink(key, "http://localhost:52341");
    expect(openUrl.mock.calls).toEqual([
      [entryUrl("1".repeat(32))],
      [entryUrl("1".repeat(32))],
      [entryUrl("2".repeat(32))],
    ]);
    expect(window.__KANNA_E2E__?.remoteCompanion?.snapshot({
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
    })?.entryUrl).toBeNull();

    delete window.__KANNA_E2E__;
  });

  it("captures an explicitly armed upsert before the OS opener and resumes normal opening afterward", async () => {
    window.__KANNA_E2E__ = {
      remoteCompanion: createE2ERemoteCompanionApi(),
    } as Window["__KANNA_E2E__"];
    const owner = {
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
    };
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());

    window.__KANNA_E2E__?.remoteCompanion?.captureNextOpen(owner);
    await expect(
      manager.openForClickedLink(key, "http://localhost:52341"),
    ).resolves.toEqual({ kind: "companion", bridgeId: BRIDGE_ONE });
    expect(invoke).toHaveBeenCalledWith(
      "upsert_remote_companion_bridge",
      expect.objectContaining({
        ownerDesktopId: owner.ownerDesktopId,
        ownerTaskId: owner.ownerTaskId,
        sessionId: "session-1",
        revision: "revision-1",
      }),
    );
    expect(openUrl).not.toHaveBeenCalled();
    expect(window.__KANNA_E2E__?.remoteCompanion?.snapshot(owner)).toEqual({
      ...owner,
      sessionId: "session-1",
      revision: "revision-1",
      status: "available",
      entryUrl: entryUrl("c".repeat(32)),
      openerAttempt: 0,
      openerOutcome: null,
    });

    await expect(
      manager.openForClickedLink(key, "http://localhost:52341"),
    ).resolves.toEqual({ kind: "companion", bridgeId: BRIDGE_ONE });
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(
      entryUrl("c".repeat(32)),
    );
    expect(window.__KANNA_E2E__?.remoteCompanion?.snapshot(owner)).toMatchObject({
      openerAttempt: 1,
      openerOutcome: "success",
    });

    manager.acceptSnapshot(key, snapshot({
      revision: "revision-2",
      html: "<h1>updated</h1>",
    }));
    await manager.whenIdle();
    expect(window.__KANNA_E2E__?.remoteCompanion?.snapshot(owner)).toEqual({
      ...owner,
      sessionId: "session-1",
      revision: "revision-2",
      status: "available",
      entryUrl: null,
      openerAttempt: 1,
      openerOutcome: null,
    });
    delete window.__KANNA_E2E__;
  });

  it.each(["invoke", "opener"] as const)("propagates %s failure without leaking the entry URL", async (failure) => {
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    if (failure === "invoke") {
      invoke.mockRejectedValueOnce(new Error("upsert failed"));
    } else {
      openUrl.mockRejectedValueOnce(new Error(
        `ForbiddenUrl ${entryUrl("f".repeat(32))}`,
      ));
    }

    await expect(manager.openForClickedLink(key, "http://localhost:52341"))
      .rejects.toMatchObject(
        failure === "invoke"
          ? { message: "upsert failed" }
          : {
              code: "companion_open_failed",
              message: "The visual companion could not be opened.",
            },
      );
  });

  it("consumes and sanitizes an opener rejection that arrives after terminal cleanup", async () => {
    let rejectOpen!: (error: unknown) => void;
    openUrl.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectOpen = reject;
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.__KANNA_E2E__ = {
      terminal: {
        maxXtermBacklogMs: 0,
        pendingChunks: 0,
        pendingBytes: 0,
        latestEvent: null,
      },
    };
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(rejectOpen).toBeTypeOf("function"));
    await manager.closeRemote(key);
    const forbidden = `ForbiddenUrl ${entryUrl("f".repeat(32))}`;

    rejectOpen(new Error(forbidden));
    await expect(opening).resolves.toEqual({ kind: "unavailable" });
    await flush();

    const surfaced = JSON.stringify({
      log: log.mock.calls,
      warn: warn.mock.calls,
      error: error.mock.calls,
      hook: window.__KANNA_E2E__,
    });
    expect(surfaced).not.toContain("ForbiddenUrl");
    expect(surfaced).not.toContain("cap=");
    delete window.__KANNA_E2E__;
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it.each([
    { bridgeId: BRIDGE_ONE, entryUrl: "https://example.com/?cap=secret" },
    { bridgeId: BRIDGE_ONE, entryUrl: `file:///tmp/?cap=${"a".repeat(32)}` },
    { bridgeId: BRIDGE_ONE, entryUrl: `http://127.0.0.1:61234/?cap=${"a".repeat(32)}` },
    { bridgeId: BRIDGE_ONE, entryUrl: `http://${"b".repeat(32)}.localhost:61234/files/x?cap=${"a".repeat(32)}` },
    { bridgeId: BRIDGE_ONE, entryUrl: `http://${"é".repeat(32)}.localhost:61234/?cap=${"a".repeat(32)}` },
    { bridgeId: BRIDGE_ONE, entryUrl: `http://${"b".repeat(32)}.localhost:0/?cap=${"a".repeat(32)}` },
    { bridgeId: "not-a-bridge-id", entryUrl: entryUrl() },
    { bridgeId: BRIDGE_ONE, entryUrl: entryUrl(), extra: true },
    { bridgeId: BRIDGE_ONE, entryUrl: `${entryUrl()}&extra=1` },
    { bridgeId: BRIDGE_ONE, entryUrl: `http://user@${"b".repeat(32)}.localhost:61234/?cap=${"a".repeat(32)}` },
  ])("rejects malformed privileged upsert result %#", async (result) => {
    invoke.mockImplementation(async (command: string) =>
      command === "upsert_remote_companion_bridge" ? result : undefined);
    const { key } = adopt();
    manager.acceptSnapshot(key, snapshot());

    await expect(manager.openForClickedLink(key, "http://localhost:52341"))
      .rejects.toThrow("invalid response");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("makes close terminal against a snapshot update queued after closure begins", async () => {
    const { key, remoteSubscription, transport } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    invoke.mockClear();

    const closing = manager.closeRemote(key);
    manager.acceptSnapshot(key, snapshot({
      revision: "revision-2",
      html: "<main>Late</main>",
    }));
    await closing;
    await flush();

    expect(invoke.mock.calls.filter(([command]) =>
      command === "upsert_remote_companion_bridge")).toHaveLength(0);
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    await manager.closeRemote(key);
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
  });

  it("closes a Rust bridge returned while close is waiting on the in-flight upsert", async () => {
    let releaseUpsert!: () => void;
    invoke.mockImplementation(async (command: string) => {
      if (command === "upsert_remote_companion_bridge") {
        await new Promise<void>((resolve) => {
          releaseUpsert = resolve;
        });
        return {
          bridgeId: BRIDGE_ONE,
          entryUrl: entryUrl(),
        };
      }
      return undefined;
    });
    const { key, remoteSubscription, transport } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(releaseUpsert).toBeTypeOf("function"));
    const closing = manager.closeRemote(key);
    releaseUpsert();

    await expect(opening).resolves.toEqual({ kind: "unavailable" });
    await closing;
    expect(invoke).toHaveBeenCalledWith("close_remote_companion_bridge", {
      bridgeId: BRIDGE_ONE,
    });
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent close and rejects re-adoption until terminal cleanup completes", async () => {
    const { key, remoteSubscription, transport } = adopt();
    manager.acceptSnapshot(key, snapshot());
    await manager.openForClickedLink(key, "http://localhost:52341");
    let releaseClose!: () => void;
    invoke.mockImplementation(async (command: string) => {
      if (command === "close_remote_companion_bridge") {
        await new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
      }
      return undefined;
    });

    const firstClose = manager.closeRemote(key);
    const secondClose = manager.closeRemote(key);
    await vi.waitFor(() => expect(releaseClose).toBeTypeOf("function"));
    const replacement = subscription();
    const replacementTransport = taskClient(replacement);
    expect(() => manager.adoptRemote({
      remoteKey: key,
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport: replacementTransport,
    })).toThrow("remote companion ownership is closing");
    releaseClose();
    await Promise.all([firstClose, secondClose]);

    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(replacementTransport.observeCompanion).not.toHaveBeenCalled();
    expect(replacementTransport.close).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.filter(([command]) =>
      command === "close_remote_companion_bridge")).toHaveLength(1);
  });

  it("cleans up adopted ownership even when global listener installation fails", async () => {
    await manager.dispose();
    const listenerError = new Error("listener setup failed");
    const failingListen = vi.fn(async () => {
      throw listenerError;
    });
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen: failingListen,
      openUrl,
      gracePeriodMs: 30_000,
    });
    const remoteSubscription = subscription();
    const transport = taskClient(remoteSubscription);
    manager.adoptRemote({
      remoteKey: desktopCompanionRemoteKey("desktop-1", "task-1"),
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      transport,
    });

    await expect(manager.openForClickedLink(
      desktopCompanionRemoteKey("desktop-1", "task-1"),
      "https://example.com/report",
    )).resolves.toEqual({
      kind: "ordinary",
      url: "https://example.com/report",
    });
    await expect(manager.openForClickedLink(
      desktopCompanionRemoteKey("desktop-1", "task-1"),
      "not a URL",
    )).resolves.toEqual({ kind: "invalid" });

    manager.acceptSnapshot(
      desktopCompanionRemoteKey("desktop-1", "task-1"),
      snapshot(),
    );
    await expect(manager.openForClickedLink(
      desktopCompanionRemoteKey("desktop-1", "task-1"),
      "http://localhost:52341",
    )).rejects.toThrow("listener setup failed");
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("disposes safely while listener setup is pending and ignores later browser events", async () => {
    let releaseListen!: (unlisten: () => void) => void;
    listen.mockImplementation(() => new Promise((resolve) => {
      releaseListen = resolve;
    }));
    await manager.dispose();
    unlisten.mockClear();
    manager = createDesktopCompanionBridgeManager({
      invoke,
      listen,
      openUrl,
      gracePeriodMs: 30_000,
    });
    const { key, remoteSubscription } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const disposing = manager.dispose();
    releaseListen(unlisten);
    await disposing;

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(await manager.openForClickedLink(key, "http://localhost:52341"))
      .toEqual({ kind: "unavailable" });
  });

  it("serializes disposal behind a pending upsert and never opens its capability", async () => {
    let releaseUpsert!: () => void;
    invoke.mockImplementation(async (command: string) => {
      if (command === "upsert_remote_companion_bridge") {
        await new Promise<void>((resolve) => {
          releaseUpsert = resolve;
        });
        return {
          bridgeId: BRIDGE_FIVE,
          entryUrl: entryUrl("5".repeat(32)),
        };
      }
      return undefined;
    });
    const { key, remoteSubscription } = adopt();
    manager.acceptSnapshot(key, snapshot());
    const opening = manager.openForClickedLink(key, "http://localhost:52341");
    await vi.waitFor(() => expect(releaseUpsert).toBeTypeOf("function"));
    const disposing = manager.dispose();
    releaseUpsert();

    await expect(opening).resolves.toEqual({ kind: "unavailable" });
    await disposing;
    expect(openUrl).not.toHaveBeenCalled();
    expect(remoteSubscription.close).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("close_remote_companion_bridge", {
      bridgeId: BRIDGE_FIVE,
    });
  });
});
