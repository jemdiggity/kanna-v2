import { beforeEach, describe, expect, it } from "vitest";
import { e2eAppMetrics } from "./e2eAppMetrics";
import { e2eInvokeHistory } from "./e2eInvokeHistory";

const SECRET_HTML = "<h1>secret companion document</h1>";
const SECRET_ASSET = "c2VjcmV0IGFzc2V0";
const SECRET_CAPABILITY =
  `http://${"a".repeat(32)}.localhost:4312/?cap=${"b".repeat(32)}`;
const SECRET_LAN_EVENT = "lan-choice-secret";

const diagnosticSinks = [
  {
    name: "app metrics",
    record: (command: string, args: unknown) =>
      e2eAppMetrics.recordInvoke(command, args),
    read: () => e2eAppMetrics.snapshot().invokeCalls,
  },
  {
    name: "invoke history",
    record: (command: string, args: unknown) =>
      e2eInvokeHistory.record(command, args),
    read: () => e2eInvokeHistory.getAll(),
  },
] as const;

describe("E2E invoke redaction", () => {
  beforeEach(() => {
    e2eAppMetrics.clear();
    e2eInvokeHistory.clear();
  });

  it.each(diagnosticSinks)("retains only safe metadata for companion bundles in $name", ({
    record,
    read,
  }) => {
    record("upsert_remote_companion_bridge", {
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      sessionId: "session-1",
      revision: "revision-1",
      documentHtml: SECRET_HTML,
      assets: [{ name: "layout.png", dataB64: SECRET_ASSET }],
      entryUrl: SECRET_CAPABILITY,
      capability: SECRET_CAPABILITY,
    });

    const serialized = JSON.stringify(read());
    expect(serialized).toContain("desktop-1");
    expect(serialized).toContain("task-1");
    expect(serialized).toContain("session-1");
    expect(serialized).toContain("revision-1");
    expect(serialized).not.toContain(SECRET_HTML);
    expect(serialized).not.toContain(SECRET_ASSET);
    expect(serialized).not.toContain("documentHtml");
    expect(serialized).not.toContain("assets");
    expect(serialized).not.toContain("cap=");
    expect(serialized).not.toContain("capability");
  });

  it.each(diagnosticSinks)(
    "deny-lists LAN companion payloads while retaining routing metadata in $name",
    ({ record, read }) => {
      record("observe_transfer_peer_companion", {
        peerId: "peer-1",
        taskId: "task-1",
        generation: "generation-1",
        event: {
          eventId: SECRET_LAN_EVENT,
          choice: SECRET_LAN_EVENT,
          text: SECRET_LAN_EVENT,
          id: SECRET_LAN_EVENT,
        },
        unexpected: SECRET_HTML,
      });
      record("unobserve_transfer_peer_companion", {
        peerId: "peer-1",
        taskId: "task-1",
        generation: "generation-1",
        eventId: SECRET_LAN_EVENT,
        unexpected: SECRET_ASSET,
      });
      record("send_transfer_peer_companion_event", {
        peerId: "peer-1",
        taskId: "task-1",
        generation: "generation-1",
        sessionId: "session-1",
        revision: "revision-1",
        event: {
          eventId: SECRET_LAN_EVENT,
          choice: SECRET_LAN_EVENT,
          text: SECRET_LAN_EVENT,
          id: SECRET_LAN_EVENT,
        },
        eventId: SECRET_LAN_EVENT,
        choice: SECRET_LAN_EVENT,
        text: SECRET_LAN_EVENT,
        id: SECRET_LAN_EVENT,
        unexpected: {
          documentHtml: SECRET_HTML,
          asset: SECRET_ASSET,
          capability: SECRET_CAPABILITY,
        },
      });

      const serialized = JSON.stringify(read());
      expect(serialized).toContain("peer-1");
      expect(serialized).toContain("task-1");
      expect(serialized).toContain("generation-1");
      expect(serialized).toContain("session-1");
      expect(serialized).toContain("revision-1");
      expect(serialized).not.toContain(SECRET_LAN_EVENT);
      expect(serialized).not.toContain(SECRET_HTML);
      expect(serialized).not.toContain(SECRET_ASSET);
      expect(serialized).not.toContain("cap=");
      expect(serialized).not.toContain('"event"');
      expect(serialized).not.toContain('"eventId"');
      expect(serialized).not.toContain('"choice"');
      expect(serialized).not.toContain('"text"');
      expect(serialized).not.toContain('"id"');
      expect(serialized).not.toContain('"unexpected"');
    },
  );

  it.each([
    [
      "set_remote_companion_bridge_state",
      {
        bridgeId: "bridge-1",
        status: "reconnecting",
        selected: true,
        unexpected: { documentHtml: SECRET_HTML, capability: SECRET_CAPABILITY },
      },
    ],
    [
      "set_remote_companion_event_result",
      {
        bridgeId: "bridge-1",
        sessionId: "session-1",
        revision: "revision-1",
        eventId: `event:${SECRET_HTML}`,
        accepted: false,
        code: "rejected",
        message: SECRET_HTML,
        unexpected: { assets: [SECRET_ASSET], entryUrl: SECRET_CAPABILITY },
      },
    ],
    [
      "close_remote_companion_bridge",
      {
        bridgeId: "bridge-1",
        unexpected: { cookies: SECRET_HTML, entryUrl: SECRET_CAPABILITY },
      },
    ],
    [
      "future_remote_companion_operation",
      {
        ownerDesktopId: "desktop-1",
        documentHtml: SECRET_HTML,
        assets: [SECRET_ASSET],
        entryUrl: SECRET_CAPABILITY,
      },
    ],
    [
      "future_transfer_peer_companion_operation",
      {
        peerId: "peer-1",
        taskId: "task-1",
        generation: "generation-1",
        event: {
          eventId: SECRET_LAN_EVENT,
          choice: SECRET_LAN_EVENT,
          text: SECRET_LAN_EVENT,
          id: SECRET_LAN_EVENT,
        },
      },
    ],
  ])("uses an adversarial allowlist for %s", (command, args) => {
    e2eAppMetrics.recordInvoke(command, args);
    e2eInvokeHistory.record(command, args);

    const serialized = JSON.stringify({
      metrics: e2eAppMetrics.snapshot().invokeCalls,
      history: e2eInvokeHistory.getAll(),
    });
    expect(serialized).not.toContain(SECRET_HTML);
    expect(serialized).not.toContain(SECRET_ASSET);
    expect(serialized).not.toContain("cap=");
    expect(serialized).not.toContain("unexpected");
    if (command.startsWith("future_")) {
      expect(serialized).toContain('"redacted":true');
      expect(serialized).not.toContain("desktop-1");
      expect(serialized).not.toContain("peer-1");
    }
  });

  it("does not mutate ordinary invoke arguments", () => {
    const args = { sessionId: "task-1", cols: 80, rows: 24 };
    e2eAppMetrics.recordInvoke("resize_pty", args);
    e2eInvokeHistory.record("resize_pty", args);

    expect(e2eAppMetrics.snapshot().invokeCalls).toEqual([
      { command: "resize_pty", args },
    ]);
    expect(e2eInvokeHistory.getAll()).toEqual([
      { cmd: "resize_pty", args },
    ]);
  });
});
