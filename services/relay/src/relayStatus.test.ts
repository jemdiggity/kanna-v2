import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  closeByteAccount,
  identifyByteAccount,
  openByteAccount,
  recordBytesReceived,
  RECENT_CONNECTION_REPORT_LIMIT,
  resetByteAccountingForTests,
} from "./byteAccounting.js";
import {
  buildRelayStatsPayload,
  matchesStatsToken,
  resolveStatsToken,
  statsRequestToken,
} from "./relayStatus.js";
import type { UpgradeAdmissionStats } from "./webSocketLimits.js";

const UPGRADES: UpgradeAdmissionStats = {
  admitted: 3,
  refused: { total: 1, byStatus: { "429": 1 } },
  trackedAddresses: 2,
};

/**
 * The odometer keys accounts by socket identity alone, so a bare object with
 * the one field `openByteAccount` reads is a faithful stand-in here; the real
 * sockets are exercised in `test/byteAccounting.test.ts`.
 */
function fakeSocket(extensions = ""): WebSocket {
  return { extensions } as unknown as WebSocket;
}

describe("operator stats token", () => {
  it("is absent unless the environment sets one", () => {
    expect(resolveStatsToken({})).toBeNull();
    expect(resolveStatsToken({ KANNA_RELAY_STATS_TOKEN: "   " })).toBeNull();
  });

  it("refuses a token too short to be a credential rather than half-enabling the dashboard", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveStatsToken({ KANNA_RELAY_STATS_TOKEN: "hunter2" })).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("KANNA_RELAY_STATS_TOKEN"));
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts a long enough token, trimmed", () => {
    expect(resolveStatsToken({ KANNA_RELAY_STATS_TOKEN: " 0123456789abcdef \n" }))
      .toBe("0123456789abcdef");
  });

  it("compares tokens without leaking length or prefix", () => {
    expect(matchesStatsToken("0123456789abcdef", "0123456789abcdef")).toBe(true);
    expect(matchesStatsToken("0123456789abcde", "0123456789abcdef")).toBe(false);
    expect(matchesStatsToken("0123456789abcdefg", "0123456789abcdef")).toBe(false);
    expect(matchesStatsToken("", "0123456789abcdef")).toBe(false);
  });
});

describe("status request credential", () => {
  it("reads a bearer header, then the query parameter the dashboard URL carries", () => {
    expect(statsRequestToken({ headers: { authorization: "Bearer abc" }, url: "/stats" }))
      .toBe("abc");
    expect(statsRequestToken({ headers: {}, url: "/stats?token=xyz" })).toBe("xyz");
    expect(statsRequestToken({ headers: {}, url: "/dashboard?token=x%20y" })).toBe("x y");
    // The header is the stronger channel, so it wins.
    expect(statsRequestToken({ headers: { authorization: "Bearer abc" }, url: "/stats?token=xyz" }))
      .toBe("abc");
  });

  it("is null when the request presents nothing", () => {
    expect(statsRequestToken({ headers: {}, url: "/stats" })).toBeNull();
    expect(statsRequestToken({ headers: {}, url: "/stats?token=" })).toBeNull();
    expect(statsRequestToken({ headers: { authorization: "Basic abc" }, url: "/stats" })).toBeNull();
  });
});

describe("stats payload visibility", () => {
  beforeEach(() => resetByteAccountingForTests());
  afterEach(() => resetByteAccountingForTests());

  it("gives an ordinary account aggregates only — no uid, desktop id, or connection row", () => {
    const socket = fakeSocket();
    openByteAccount(socket);
    identifyByteAccount(socket, { uid: "user-1", desktopId: "desktop-1", role: "server" });
    recordBytesReceived(socket, "tunnel", 512);

    const payload = buildRelayStatsPayload({
      commit: "abc123",
      upgrades: UPGRADES,
      audience: "account",
    });

    expect(payload.liveConnections).toBeUndefined();
    expect(payload.recentConnections).toBeUndefined();
    expect(payload.bytes.received.tunnel).toBe(512);
    expect(payload.upgrades).toEqual(UPGRADES);
    expect(JSON.stringify(payload)).not.toContain("user-1");
  });

  it("gives the operator the live connection rows the dashboard renders", () => {
    const socket = fakeSocket("permessage-deflate");
    openByteAccount(socket);
    identifyByteAccount(socket, {
      uid: "user-1",
      desktopId: "desktop-1",
      role: "server",
      tunnelService: "ksp",
    });
    recordBytesReceived(socket, "tunnel", 1_024);

    const payload = buildRelayStatsPayload({
      commit: "abc123",
      upgrades: UPGRADES,
      audience: "operator",
    });

    expect(payload.compression).toEqual({ negotiated: 1, plain: 0 });
    expect(payload.recentConnections).toEqual([]);
    expect(payload.liveConnections).toEqual([
      expect.objectContaining({
        connectionId: 1,
        uid: "user-1",
        desktopId: "desktop-1",
        role: "server",
        tunnelService: "ksp",
        compressed: true,
        received: { tunnel: 1_024, taskTransfer: 0, terminalEvent: 0, fileBrowse: 0, control: 0, total: 1_024 },
        sent: { tunnel: 0, taskTransfer: 0, terminalEvent: 0, fileBrowse: 0, control: 0, total: 0 },
        totalBytes: 1_024,
      }),
    ]);
  });

  it("moves a closed connection into the recent rollups, newest first and bounded", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let index = 0; index < RECENT_CONNECTION_REPORT_LIMIT + 3; index += 1) {
        const socket = fakeSocket();
        openByteAccount(socket);
        identifyByteAccount(socket, { uid: `user-${index}`, role: "phone" });
        closeByteAccount(socket);
      }
    } finally {
      log.mockRestore();
    }

    const payload = buildRelayStatsPayload({
      commit: "abc123",
      upgrades: UPGRADES,
      audience: "operator",
    });

    expect(payload.liveConnections).toEqual([]);
    expect(payload.recentConnections).toHaveLength(RECENT_CONNECTION_REPORT_LIMIT);
    expect(payload.recentConnections?.[0]?.uid)
      .toBe(`user-${RECENT_CONNECTION_REPORT_LIMIT + 2}`);
    expect(typeof payload.recentConnections?.[0]?.closedAt).toBe("string");
    expect(payload.bytes.connections.closed).toBe(RECENT_CONNECTION_REPORT_LIMIT + 3);
  });
});
