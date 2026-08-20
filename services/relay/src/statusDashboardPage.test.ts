import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { buildRelayStatsPayload } from "./relayStatus.js";
import {
  identifyByteAccount,
  openByteAccount,
  recordBytesReceived,
  recordBytesSent,
  resetByteAccountingForTests,
} from "./byteAccounting.js";
import { RELAY_STATUS_DASHBOARD_HTML } from "./statusDashboardPage.js";
import type { WebSocket } from "ws";

/**
 * The dashboard's script against a payload the relay actually produced.
 *
 * There is no browser in the relay's test tier, so the page runs here in a VM
 * with the smallest DOM that its own rendering uses. That is enough to hold the
 * one contract worth holding: the page reads the field names `/stats` writes,
 * so renaming a counter on the server cannot silently blank a panel.
 */

interface FakeElement {
  innerHTML: string;
  textContent: string;
  className: string;
}

function scriptSource(): string {
  const opening = RELAY_STATUS_DASHBOARD_HTML.indexOf("<script>");
  const closing = RELAY_STATUS_DASHBOARD_HTML.indexOf("</script>");
  expect(opening).toBeGreaterThan(-1);
  expect(closing).toBeGreaterThan(opening);
  return RELAY_STATUS_DASHBOARD_HTML.slice(opening + "<script>".length, closing);
}

function elementIds(): string[] {
  return [...RELAY_STATUS_DASHBOARD_HTML.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
}

function samplePayload(): ReturnType<typeof buildRelayStatsPayload> {
  resetByteAccountingForTests();
  const socket = { extensions: "permessage-deflate" } as unknown as WebSocket;
  openByteAccount(socket);
  identifyByteAccount(socket, {
    uid: "Bax9kQ2mLp",
    desktopId: "a1b2c3d4",
    role: "server",
    tunnelService: "ksp",
  });
  recordBytesReceived(socket, "tunnel", 19_283_746);
  recordBytesSent(socket, "terminalEvent", 2_048_000);
  return buildRelayStatsPayload({
    commit: "5022d3f9f0aa",
    upgrades: { admitted: 41, refused: { total: 3, byStatus: { "429": 3 } }, trackedAddresses: 5 },
    audience: "operator",
  });
}

/** Run the page's script with a stub DOM, and return what it wrote where. */
async function render(payload: unknown): Promise<Record<string, FakeElement>> {
  const elements: Record<string, FakeElement> = {};
  for (const id of elementIds()) {
    elements[id] = { innerHTML: "", textContent: "", className: "" };
  }

  const sandbox = {
    document: {
      getElementById(id: string): FakeElement | undefined {
        return elements[id];
      },
    },
    location: { search: "?token=operator-token" },
    URLSearchParams,
    Date,
    Math,
    isFinite,
    Object,
    JSON,
    console,
    setInterval: () => 0,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }),
  };

  runInNewContext(scriptSource(), sandbox);
  // The first poll is a promise chain kicked off during evaluation.
  await new Promise((resolve) => setImmediate(resolve));
  return elements;
}

describe("relay status dashboard page", () => {
  it("is one self-contained document with no external asset", () => {
    expect(RELAY_STATUS_DASHBOARD_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(RELAY_STATUS_DASHBOARD_HTML).not.toMatch(/<link[^>]+href="https?:/);
    expect(RELAY_STATUS_DASHBOARD_HTML).not.toMatch(/<script[^>]+src=/);
    expect(RELAY_STATUS_DASHBOARD_HTML).not.toMatch(/@import/);
  });

  it("renders the payload the relay serves", async () => {
    const elements = await render(samplePayload());

    expect(elements.banner.textContent).toBe("");
    expect(elements.commit.textContent).toBe("commit 5022d3f9f0aa");
    expect(elements.uptime.textContent).toMatch(/^up \d/);

    // Aggregates the operator is streaming a console for today.
    expect(elements.conn.innerHTML).toContain("sockets open");
    expect(elements.bytes.innerHTML).toContain("18.4 MiB");
    expect(elements.flow.innerHTML).toContain("cap rejects");
    expect(elements.upgrades.innerHTML).toContain("refused 429");
    expect(elements.upgrades.innerHTML).toContain("compression negotiated");

    // The per-connection row, with its byte classes.
    expect(elements.live.innerHTML).toContain("Bax9kQ2mLp");
    expect(elements.live.innerHTML).toContain("a1b2c3d4");
    expect(elements.live.innerHTML).toContain("ksp");
    expect(elements.live.innerHTML).toContain("deflate");
    expect(elements.live.innerHTML).toContain("18.4 MiB");
    expect(elements.live.innerHTML).toContain("1.95 MiB");
    expect(elements.recent.innerHTML).toContain("No connection has closed");

    resetByteAccountingForTests();
  });

  it("escapes identity fields rather than pasting them into the page", async () => {
    resetByteAccountingForTests();
    const socket = { extensions: "" } as unknown as WebSocket;
    openByteAccount(socket);
    identifyByteAccount(socket, { uid: "<img src=x onerror=alert(1)>", role: "phone" });
    const payload = buildRelayStatsPayload({
      commit: "abc",
      upgrades: { admitted: 0, refused: { total: 0, byStatus: {} }, trackedAddresses: 0 },
      audience: "operator",
    });

    const elements = await render(payload);

    expect(elements.live.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(elements.live.innerHTML).not.toContain("<img src=x");

    resetByteAccountingForTests();
  });

  it("tells the operator how to get a token instead of failing silently", async () => {
    const elements = await render({});
    // Rendering an empty body throws inside the promise chain, which the page
    // reports in its banner rather than leaving stale numbers on screen.
    expect(elements.banner.className).toBe("on");
    expect(elements.banner.textContent.length).toBeGreaterThan(0);
  });
});
