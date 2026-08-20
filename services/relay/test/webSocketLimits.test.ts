import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type ClientOptions } from "ws";
import {
  attachDesktopTunnel,
  forwardTunnelData,
  routeMessage,
  setPhoneConnection,
  setServerConnection,
} from "../src/router.js";
import {
  openByteAccount,
  resetByteAccountingForTests,
} from "../src/byteAccounting.js";
import { RELAY_PER_MESSAGE_DEFLATE } from "../src/webSocketCompression.js";
import {
  attachUpgradeAdmission,
  clientAddressForRequest,
  createUpgradeAdmission,
  RELAY_MAX_PAYLOAD_BYTES,
  resolveMaxPayloadBytes,
  resolveUpgradeAdmissionOptions,
  type UpgradeAdmission,
} from "../src/webSocketLimits.js";

const sockets: WebSocket[] = [];
const teardown: Array<() => Promise<void>> = [];

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing probe address"));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

interface RelayHarness {
  url: string;
  wss: WebSocketServer;
  admission: UpgradeAdmission;
  /** Every server-side socket the harness has accepted, newest last. */
  accepted: WebSocket[];
  refusals: string[];
}

/**
 * An HTTP server + `WebSocketServer` wired exactly the way `index.ts` wires the
 * relay's: `noServer`, the shipped compression bounds, the shipped
 * `maxPayload`, and the shipped `attachUpgradeAdmission`. The tests below
 * therefore exercise the code that ships rather than a copy of it.
 *
 * `releaseOnAuth` stands in for the connection handler's real
 * `releasePreAuthSlot`: the relay hands the pre-auth slot back the moment a
 * socket authenticates, and every test that models legitimate traffic has to
 * model that too or it is measuring the wrong bound.
 */
async function startRelayHarness(options: {
  maxUnauthenticatedPerAddress?: number;
  maxUpgradesPerWindow?: number;
  windowMs?: number;
  releaseOnAuth?: boolean;
} = {}): Promise<RelayHarness> {
  const port = await freePort();
  const http = createHttpServer();
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: RELAY_PER_MESSAGE_DEFLATE,
    maxPayload: RELAY_MAX_PAYLOAD_BYTES,
  });
  const admission = createUpgradeAdmission(options);
  const refusals: string[] = [];
  attachUpgradeAdmission({
    server: http,
    wss,
    admission,
    onRefused: (_address, reason) => refusals.push(reason),
  });

  const accepted: WebSocket[] = [];
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    accepted.push(ws);
    openByteAccount(ws);
    const address = clientAddressForRequest(req);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      admission.release(address);
    };
    ws.on("close", release);
    if (options.releaseOnAuth) {
      // The relay releases on the auth frame; the harness releases on the
      // first message, which is the same moment for every real client.
      ws.once("message", release);
    }
  });

  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  teardown.push(async () => {
    for (const socket of accepted) socket.terminate();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${port}`, wss, admission, accepted, refusals };
}

async function connect(url: string, options?: ClientOptions): Promise<WebSocket> {
  const client = new WebSocket(url, options);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  sockets.push(client);
  return client;
}

function connectExpectingRefusal(url: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    sockets.push(client);
    // `ws` surfaces a non-101 upgrade response as `unexpected-response`.
    client.once("unexpected-response", (_req, res) => {
      res.resume();
      client.terminate();
      resolve({ status: res.statusCode ?? 0 });
    });
    client.once("open", () => reject(new Error("upgrade was admitted")));
    client.once("error", (error) => reject(error));
  });
}

/** Poll until `predicate` holds, so the tests wait on state rather than a clock. */
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function nextMessage(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    ws.once("message", (raw: Buffer) => resolve(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)));
  });
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code: number) => resolve(code)));
}

function nextServerError(ws: WebSocket): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve) => {
    ws.once("error", (error: Error) => resolve(error as NodeJS.ErrnoException));
  });
}

/**
 * Splice a phone socket to a desktop tunnel socket through the real router, so
 * a frame sent by one end has to survive the relay's actual forwarding path.
 */
async function establishTunnel(
  harness: RelayHarness,
  userId: string,
  service: "ksp" | "task-transfer",
): Promise<{ phone: WebSocket; desktopTunnel: WebSocket }> {
  const desktopControlClient = await connect(harness.url, { perMessageDeflate: false });
  const desktopControl = harness.accepted[harness.accepted.length - 1];
  setServerConnection(userId, "desktop", desktopControl);

  const phoneClient = await connect(harness.url);
  const phone = harness.accepted[harness.accepted.length - 1];
  setPhoneConnection(userId, phone);

  const establish = nextMessage(desktopControlClient);
  routeMessage(
    userId,
    "phone",
    JSON.stringify({
      type: "tunnel_request",
      id: `limits-${service}`,
      desktopId: "desktop",
      service,
    }),
    phone,
  );
  const signal = JSON.parse((await establish).toString()) as { tunnelId?: unknown };

  const desktopTunnelClient = await connect(harness.url, { perMessageDeflate: false });
  const desktopTunnel = harness.accepted[harness.accepted.length - 1];
  const ready = Promise.all([nextMessage(phoneClient), nextMessage(desktopTunnelClient)]);
  expect(attachDesktopTunnel(userId, "desktop", String(signal.tunnelId), desktopTunnel)).toBe(true);
  for (const frame of await ready) {
    expect(JSON.parse(frame.toString())).toMatchObject({ type: "tunnel_ready" });
  }

  phone.on("message", (data, isBinary) => forwardTunnelData(phone, data, isBinary));
  desktopTunnel.on("message", (data, isBinary) =>
    forwardTunnelData(desktopTunnel, data, isBinary));

  return { phone: phoneClient, desktopTunnel: desktopTunnelClient };
}

function upgradeRequest(
  peer: string,
  forwardedFor?: string | string[],
): IncomingMessage {
  return {
    socket: { remoteAddress: peer },
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  } as unknown as IncomingMessage;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const dispose of teardown.splice(0)) await dispose();
  resetByteAccountingForTests();
});

describe("client address derivation", () => {
  it("reads the proxy's own X-Forwarded-For hop when the peer is the trusted proxy", () => {
    // Caddy reverse-proxies to relay:8080 over the Docker bridge, so every
    // connection's peer is private and identical; without this the per-IP
    // bounds would cap the whole fleet together.
    expect(clientAddressForRequest(upgradeRequest("172.18.0.3", "203.0.113.7")))
      .toBe("203.0.113.7");
  });

  it("ignores a forged X-Forwarded-For prefix and keeps the proxy's last hop", () => {
    expect(clientAddressForRequest(
      upgradeRequest("172.18.0.3", "10.0.0.1, 198.51.100.9, 203.0.113.7"),
    )).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For entirely from a public peer", () => {
    // A caller that reaches the relay directly cannot pick its own bucket.
    expect(clientAddressForRequest(upgradeRequest("203.0.113.7", "10.0.0.1")))
      .toBe("203.0.113.7");
  });

  it("falls back to the peer when the trusted proxy sends no header", () => {
    expect(clientAddressForRequest(upgradeRequest("127.0.0.1"))).toBe("127.0.0.1");
  });

  it("normalizes IPv4-mapped IPv6 peers so one client is one bucket", () => {
    expect(clientAddressForRequest(upgradeRequest("::ffff:203.0.113.7")))
      .toBe("203.0.113.7");
  });
});

describe("upgrade admission bookkeeping", () => {
  it("caps unauthenticated connections per address and restores the slot on release", () => {
    const admission = createUpgradeAdmission({ maxUnauthenticatedPerAddress: 2 });
    expect(admission.admit("a").admitted).toBe(true);
    expect(admission.admit("a").admitted).toBe(true);
    const refused = admission.admit("a");
    expect(refused).toMatchObject({ admitted: false, status: 429 });
    // A different address is untouched by another's flood.
    expect(admission.admit("b").admitted).toBe(true);

    admission.release("a");
    expect(admission.admit("a").admitted).toBe(true);
  });

  it("bounds upgrades per window and starts a fresh window afterwards", () => {
    const admission = createUpgradeAdmission({
      maxUnauthenticatedPerAddress: 100,
      maxUpgradesPerWindow: 3,
      windowMs: 1_000,
    });
    for (let index = 0; index < 3; index += 1) {
      expect(admission.admit("a", 1_000).admitted).toBe(true);
      admission.release("a", 1_000);
    }
    expect(admission.admit("a", 1_000)).toMatchObject({ admitted: false, status: 429 });
    expect(admission.admit("a", 2_000).admitted).toBe(true);
  });

  it("bounds the address table itself rather than growing with a botnet", () => {
    const admission = createUpgradeAdmission({
      maxTrackedAddresses: 4,
      windowMs: 1_000,
    });
    for (let index = 0; index < 4; index += 1) {
      expect(admission.admit(`host-${index}`, 1_000).admitted).toBe(true);
    }
    expect(admission.trackedAddressCount()).toBe(4);
    expect(admission.admit("host-4", 1_000)).toMatchObject({ admitted: false, status: 503 });

    // Once the held slots are gone and the window has lapsed, the entries are
    // collected and the table takes new addresses again.
    for (let index = 0; index < 4; index += 1) admission.release(`host-${index}`, 1_000);
    expect(admission.admit("host-4", 3_000).admitted).toBe(true);
  });

  it("counts admitted and refused upgrades by status for GET /stats", () => {
    const admission = createUpgradeAdmission({
      maxUnauthenticatedPerAddress: 1,
      maxTrackedAddresses: 1,
      windowMs: 1_000,
    });

    expect(admission.stats()).toEqual({
      admitted: 0,
      refused: { total: 0, byStatus: {} },
      trackedAddresses: 0,
    });

    admission.admit("a", 1_000);
    // Second slot for the same address: over the per-address cap.
    admission.admit("a", 1_000);
    // A new address while the table is full and the held slot blocks collection.
    admission.admit("b", 1_000);

    expect(admission.stats()).toEqual({
      admitted: 1,
      refused: { total: 2, byStatus: { "429": 1, "503": 1 } },
      trackedAddresses: 1,
    });
  });
});

describe("per-IP upgrade admission over a real upgrade", () => {
  it("leaves ordinary multi-desktop usage from one address alone", async () => {
    // Two desktops and a phone behind one NAT, each authenticating on connect —
    // well past the unauthenticated cap in total, and none of them refused,
    // because the slot is released as soon as a socket proves who it is.
    const harness = await startRelayHarness({
      maxUnauthenticatedPerAddress: 2,
      releaseOnAuth: true,
    });
    const clients: WebSocket[] = [];
    for (let index = 0; index < 3; index += 1) {
      const client = await connect(harness.url);
      client.send(JSON.stringify({ type: "auth", id_token: `token-${index}` }));
      // Wait for the release before opening the next one, exactly as a real
      // client's handshake completes before its sibling's does.
      await waitFor(
        () => harness.admission.unauthenticatedCount("127.0.0.1") === 0,
        "the authenticated socket to release its pre-auth slot",
      );
      clients.push(client);
    }

    expect(harness.refusals).toEqual([]);
    for (const client of clients) expect(client.readyState).toBe(WebSocket.OPEN);
    expect(harness.admission.unauthenticatedCount("127.0.0.1")).toBe(0);
  });

  it("refuses an unauthenticated flood from one address without touching the live ones", async () => {
    const harness = await startRelayHarness({ maxUnauthenticatedPerAddress: 3 });
    const silent = [
      await connect(harness.url),
      await connect(harness.url),
      await connect(harness.url),
    ];

    const refused = await connectExpectingRefusal(harness.url);
    expect(refused.status).toBe(429);
    expect(harness.refusals[0]).toContain("too many unauthenticated connections");
    for (const client of silent) expect(client.readyState).toBe(WebSocket.OPEN);

    // Closing one hands its slot back, and the next caller is admitted.
    silent[0].close();
    await waitFor(
      () => harness.admission.unauthenticatedCount("127.0.0.1") === 2,
      "the closed socket to return its pre-auth slot",
    );
    const admitted = await connect(harness.url);
    expect(admitted.readyState).toBe(WebSocket.OPEN);
  });
});

describe("maxPayload", () => {
  it("is the derived bound, and is overridable for an operator", () => {
    expect(RELAY_MAX_PAYLOAD_BYTES).toBe(16 * 1024 * 1024);
    expect(resolveMaxPayloadBytes({})).toBe(RELAY_MAX_PAYLOAD_BYTES);
    expect(resolveMaxPayloadBytes({ KANNA_RELAY_MAX_PAYLOAD_BYTES: "33554432" }))
      .toBe(33_554_432);
    // A malformed override must not silently disable the bound.
    expect(resolveMaxPayloadBytes({ KANNA_RELAY_MAX_PAYLOAD_BYTES: "0" }))
      .toBe(RELAY_MAX_PAYLOAD_BYTES);
    expect(resolveMaxPayloadBytes({ KANNA_RELAY_MAX_PAYLOAD_BYTES: "unbounded" }))
      .toBe(RELAY_MAX_PAYLOAD_BYTES);
    expect(resolveUpgradeAdmissionOptions({}).maxUnauthenticatedPerAddress).toBe(8);
    expect(resolveUpgradeAdmissionOptions({
      KANNA_RELAY_MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP: "32",
    }).maxUnauthenticatedPerAddress).toBe(32);
  });

  // Every class in the frame inventory in docs/task-specs/7a38cc18.md, at the
  // largest size its producer can legitimately emit. If one of these ever
  // stops fitting, the cap is wrong — not the test.
  const legitimateControlFrames: Array<[string, () => Buffer]> = [
    ["task snapshot publication at its cap + envelope", () =>
      Buffer.from(JSON.stringify({
        type: "task_snapshot_publish",
        id: "snapshot-1",
        snapshot: "x".repeat(512 * 1024 + 16 * 1024 - 128),
      }))],
    ["mobile notification at its cap", () =>
      Buffer.from(JSON.stringify({
        type: "mobile_notification_publish",
        id: "notification-1",
        notification: "x".repeat(16 * 1024 - 128),
      }))],
    ["a task-input invoke carrying a maximum image attachment", () =>
      // MAX_TASK_INPUT_BODY_BYTES is 8 MiB and is the largest enforced frame
      // any producer in the system can send into the relay.
      Buffer.from(JSON.stringify({
        type: "invoke",
        id: "invoke-1",
        method: "POST",
        path: "/v1/tasks/task-1/input",
        body: { input: "look", attachment: randomBytes(6 * 1024 * 1024).toString("base64") },
      }))],
  ];

  for (const [label, build] of legitimateControlFrames) {
    it(`accepts ${label}`, async () => {
      const harness = await startRelayHarness();
      const client = await connect(harness.url);
      const server = harness.accepted[harness.accepted.length - 1];
      const frame = build();
      expect(frame.byteLength).toBeLessThanOrEqual(RELAY_MAX_PAYLOAD_BYTES);

      const received = nextMessage(server);
      client.send(frame);
      expect((await received).equals(frame)).toBe(true);
      expect(client.readyState).toBe(WebSocket.OPEN);
    }, 20_000);
  }

  it("carries a maximum KSP companion snapshot chunk and terminal snapshot through the tunnel intact", async () => {
    const harness = await startRelayHarness();
    const { phone, desktopTunnel } = await establishTunnel(harness, "ksp-user", "ksp");

    // COMPANION_SNAPSHOT_CHUNK_DATA_BYTES is 96 KiB of already-serialized JSON,
    // re-escaped once into the chunk frame; incompressible so the tunnel
    // watermarks see the real byte count.
    const chunk = Buffer.from(JSON.stringify({
      type: "companion_snapshot_chunk",
      task_id: "task-1",
      transfer_id: "session:revision",
      index: 0,
      count: 1,
      data: randomBytes(72 * 1024).toString("base64"),
    }));
    // A full 10,000-row plain terminal scrollback measures 1.28 MiB serialized,
    // 1.71 MiB once base64'd into the frame.
    const snapshot = Buffer.from(JSON.stringify({
      type: "term_snapshot",
      task_id: "task-1",
      cols: 120,
      rows: 42,
      data_b64: randomBytes(1_342_000).toString("base64"),
    }));

    for (const frame of [chunk, snapshot]) {
      expect(frame.byteLength).toBeLessThanOrEqual(RELAY_MAX_PAYLOAD_BYTES);
      const delivered = nextMessage(phone);
      desktopTunnel.send(frame);
      expect((await delivered).equals(frame)).toBe(true);
    }
    expect(phone.readyState).toBe(WebSocket.OPEN);
  }, 30_000);

  it("carries a maximum task-transfer tunnel frame through intact", async () => {
    const harness = await startRelayHarness();
    const { phone, desktopTunnel } = await establishTunnel(
      harness,
      "transfer-user",
      "task-transfer",
    );

    // Both ends of the task-transfer tunnel splice a TCP socket with a 64 KiB
    // read buffer and send each read as one binary frame.
    const frame = randomBytes(64 * 1024);
    const delivered = nextMessage(phone);
    desktopTunnel.send(frame, { binary: true });
    expect((await delivered).equals(frame)).toBe(true);
    expect(phone.readyState).toBe(WebSocket.OPEN);
  }, 20_000);

  it("closes only the offending connection when an uncompressed frame is over the cap", async () => {
    const harness = await startRelayHarness();
    const offender = await connect(harness.url, { perMessageDeflate: false });
    const offenderServer = harness.accepted[harness.accepted.length - 1];
    const bystander = await connect(harness.url, { perMessageDeflate: false });

    const serverError = nextServerError(offenderServer);
    const closed = nextClose(offender);
    offender.send(Buffer.alloc(RELAY_MAX_PAYLOAD_BYTES + 1));

    expect((await serverError).code).toBe("WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
    expect(await closed).toBe(1009);
    expect(bystander.readyState).toBe(WebSocket.OPEN);

    // The bystander still works, which is the property that matters: an
    // oversize frame is one connection's problem, not the relay's.
    const echoed = nextMessage(harness.accepted[harness.accepted.length - 1]);
    bystander.send("still here");
    expect((await echoed).toString()).toBe("still here");
  }, 30_000);

  it("refuses a compression bomb without allocating its decompressed size", async () => {
    // The regression this task exists for: `perMessageDeflate` bounds the
    // decompressed size at `maxPayload`, so a few KiB on the wire used to be
    // able to force a 100 MiB allocation, pre-auth. `ws` aborts as soon as the
    // inflate output passes the cap, so the bomb costs the cap and not its
    // uncompressed size.
    const harness = await startRelayHarness();
    const offender = await connect(harness.url);
    expect(offender.extensions).toContain("permessage-deflate");
    const offenderServer = harness.accepted[harness.accepted.length - 1];
    const bystander = await connect(harness.url);

    const bomb = Buffer.alloc(64 * 1024 * 1024);
    const serverError = nextServerError(offenderServer);
    const closed = nextClose(offender);
    offender.send(bomb, { compress: true });

    expect((await serverError).code).toBe("WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
    expect(await closed).toBe(1009);
    expect(bystander.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
});
