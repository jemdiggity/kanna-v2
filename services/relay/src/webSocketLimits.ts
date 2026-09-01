import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";

/**
 * Largest inbound WebSocket message the relay will assemble, in bytes.
 *
 * `ws` applies this to the *decompressed* size, which is why it is a security
 * bound and not just a sanity check: `perMessageDeflate` (enabled in
 * `webSocketCompression.ts`) lets a highly compressible upload force a
 * `maxPayload`-sized allocation off roughly a thousandth of the wire bytes, and extension negotiation happens during the
 * HTTP upgrade — before the 10 s auth handshake — so an unauthenticated caller
 * can do it. At ws's 100 MiB default that is a 1 GB e2-micro killed by a few
 * hundred KiB of traffic.
 *
 * What it actually costs: ws's `zlibLimiter` is a process-wide singleton with
 * `concurrencyLimit` jobs, and `inflateOnData` aborts the moment the
 * accumulated decompressed length passes `maxPayload`. So peak concurrent
 * decompression memory across the whole relay is
 * `concurrencyLimit × maxPayload` — 10 × 100 MiB = 1 GB before, 10 × 16 MiB =
 * 160 MiB now. `Receiver#haveLength` bounds the *compressed* bytes of one
 * message by the same number, so fragmenting does not get around it.
 *
 * Why 16 MiB, derived from the frame inventory in
 * `docs/task-specs/7a38cc18.md` (every producer that sends into this socket,
 * with citations):
 *
 * - 2× the largest *enforced* legitimate frame in the system — the 8 MiB
 *   task-input body (`crates/kanna-server/src/task_input_attachments.rs:44`),
 *   which carries a phone's ≤3 MiB image attachment as base64.
 * - Above the relay's own control frames by two orders of magnitude: task
 *   snapshots cap at 512 KiB + 16 KiB, mobile notifications at 16 KiB.
 * - Above every tunnel frame class: task-transfer splices a TCP socket in
 *   64 KiB reads, and KSP companion snapshots are chunked at 96 KiB of data.
 * - ~9× a *full* plain 10,000-row terminal scrollback snapshot (measured:
 *   1.28 MiB serialized, 1.71 MiB once base64'd into the frame) and ~17× the
 *   largest snapshot ever observed in the field (977 KB).
 *
 * `agent_snapshot` still has no producer-side bound at all, so no value here is
 * provably safe for it. `term_snapshot` is bounded only for a client that
 * negotiated `term_scrollback_window` (Kanna Mobile;
 * `docs/task-specs/226a06b2.md`) — the phone's snapshot is a bounded window
 * with the rest pulled on demand — while a client that negotiated nothing
 * still receives the whole terminal. That
 * is not a reason to keep 100 MiB: a per-cell-truecolor 240×60 scrollback
 * measures 114.81 MiB in the frame, i.e. the ws default already clips it. The
 * cap is therefore chosen to clear every *bounded* class with margin and made
 * observable (the relay logs each oversize close) and reversible without a
 * redeploy (`KANNA_RELAY_MAX_PAYLOAD_BYTES`) instead of pretending to be
 * provable.
 */
export const RELAY_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Concurrent connections one client address may hold **while still
 * unauthenticated**.
 *
 * The slot is taken at the HTTP upgrade and released the moment the socket
 * authenticates, so this bounds the pre-auth population — which is the only
 * population that can spend `maxPayload` without proving anything — without
 * bounding how many desktops, phones, or tunnels a household or a
 * carrier-NAT'd range may run. A legitimate client holds its slot for one
 * Firestore round trip; an abusive one holds it until the 10 s auth timeout.
 */
export const MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP = 8;

/**
 * Upgrades one client address may complete per {@link UPGRADE_RATE_WINDOW_MS}.
 *
 * This is a *churn* bound, not the memory bound —
 * {@link MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP} is what caps how much a single
 * address can have inflating at once, and reconnecting faster does not raise
 * that. What this stops is an attacker paying nothing to make the relay run
 * handshakes in a tight loop. It is set well above any plausible legitimate
 * burst — a carrier-NAT'd range reconnecting a few hundred phones after a relay
 * restart stays under it — because refusing a real reconnect storm would be a
 * worse outage than the churn it prevents.
 */
export const MAX_UPGRADES_PER_IP_PER_WINDOW = 600;

/** Window for {@link MAX_UPGRADES_PER_IP_PER_WINDOW}. */
export const UPGRADE_RATE_WINDOW_MS = 60_000;

/**
 * Client addresses tracked at once. Reconnect storms and botnets both create
 * entries, so the table that bounds memory must be bounded itself; entries are
 * dropped as soon as they hold no slots and their rate window has lapsed, and
 * this is the backstop for the case where they never do.
 */
export const MAX_TRACKED_CLIENT_ADDRESSES = 20_000;

function positiveIntFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[ws] Ignoring ${name}=${raw}; expected a positive integer`);
    return fallback;
  }
  return parsed;
}

/**
 * The effective `maxPayload`, honouring the operator override.
 *
 * The escape hatch exists because the two unbounded frame classes above mean a
 * real user *could* be clipped by a cap that is otherwise correct; raising it
 * on the VM must not take a redeploy. It follows the
 * `KANNA_RELAY_DESKTOP_CREDENTIAL_CACHE_TTL_MS` precedent, and the deploy does
 * not set it.
 */
export function resolveMaxPayloadBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveIntFromEnv(
    env,
    "KANNA_RELAY_MAX_PAYLOAD_BYTES",
    RELAY_MAX_PAYLOAD_BYTES,
  );
}

/**
 * The effective per-IP bounds, honouring the operator overrides.
 *
 * Both caps can produce a false positive that a user experiences as "the relay
 * will not let me connect" — a shared NAT is the obvious way — and neither is
 * worth a redeploy to relax, so both are readable from the environment for the
 * same reason `maxPayload` is. The deploy sets neither.
 */
export function resolveUpgradeAdmissionOptions(
  env: NodeJS.ProcessEnv = process.env,
): UpgradeAdmissionOptions {
  return {
    maxUnauthenticatedPerAddress: positiveIntFromEnv(
      env,
      "KANNA_RELAY_MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP",
      MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP,
    ),
    maxUpgradesPerWindow: positiveIntFromEnv(
      env,
      "KANNA_RELAY_MAX_UPGRADES_PER_IP_PER_MINUTE",
      MAX_UPGRADES_PER_IP_PER_WINDOW,
    ),
  };
}

/**
 * True for the address families a trusted reverse proxy occupies: loopback and
 * the RFC1918 / RFC4193 ranges Docker bridges and private networks live in.
 *
 * This is what makes reading `X-Forwarded-For` safe. The header is
 * caller-controlled, so trusting it from an arbitrary peer would let anyone
 * pick their own rate-limit bucket; trusting it only from a private peer means
 * the only host that can set it is one already inside the deployment.
 */
function isPrivatePeerAddress(address: string): boolean {
  const value = normalizeAddress(address);
  if (value === "::1" || value === "localhost") return true;
  if (/^127\./.test(value)) return true;
  if (/^10\./.test(value) || /^192\.168\./.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
  // Unique-local and link-local IPv6.
  if (/^f[cd][0-9a-f]{2}:/i.test(value) || /^fe80:/i.test(value)) return true;
  return false;
}

/** Strip the IPv4-mapped IPv6 prefix and any zone/port decoration. */
function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const unmapped = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  const zoned = unmapped.split("%")[0] ?? unmapped;
  return zoned;
}

/**
 * The client address to key per-IP bounds on.
 *
 * In production the relay never sees a client directly: `docker-compose.yml`
 * publishes only Caddy's 80/443 and `Caddyfile` reverse-proxies to
 * `relay:8080`, so `req.socket.remoteAddress` is Caddy's address on the Docker
 * bridge and is the *same for every connection in the fleet*. Keying on it
 * would cap every user together, which is why this reads
 * `X-Forwarded-For` — and reads the **last** entry, because Caddy appends the
 * address it observed to whatever the client sent. Anything a client forges
 * lands earlier in the list and is ignored.
 *
 * With a second proxy hop in front of Caddy the index would have to move; there
 * is one hop today and the tests pin that assumption.
 */
export function clientAddressForRequest(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!isPrivatePeerAddress(peer)) return normalizeAddress(peer);

  const forwarded = req.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  if (!header) return normalizeAddress(peer);

  const hops = header.split(",").map((hop) => hop.trim()).filter(Boolean);
  const nearest = hops[hops.length - 1];
  return nearest ? normalizeAddress(nearest) : normalizeAddress(peer);
}

export type UpgradeRefusal =
  | { admitted: true }
  | { admitted: false; status: number; reason: string };

interface ClientAddressState {
  /** Upgraded sockets from this address that have not authenticated yet. */
  unauthenticated: number;
  /** Upgrades counted in the current rate window. */
  upgrades: number;
  /** When the current rate window started. */
  windowStartedAt: number;
}

export interface UpgradeAdmissionStats {
  /** Upgrades admitted since process start. */
  admitted: number;
  /** Upgrades refused since process start, split by the status answered. */
  refused: { total: number; byStatus: Record<string, number> };
  /** Client addresses currently tracked. */
  trackedAddresses: number;
}

export interface UpgradeAdmission {
  /** Take a pre-auth slot for `address`, or refuse the upgrade. */
  admit(address: string, now?: number): UpgradeRefusal;
  /** Release the pre-auth slot: the socket authenticated, or it closed. */
  release(address: string, now?: number): void;
  /** Number of addresses currently tracked (bounded, for tests and logging). */
  trackedAddressCount(): number;
  /** Pre-auth slots held by `address`; for tests. */
  unauthenticatedCount(address: string): number;
  /**
   * Admission counters since process start, for `GET /stats`. Counted inside
   * `admit`, which every upgrade decision passes through, so no caller can
   * forget to report one.
   */
  stats(): UpgradeAdmissionStats;
}

export interface UpgradeAdmissionOptions {
  maxUnauthenticatedPerAddress?: number;
  maxUpgradesPerWindow?: number;
  windowMs?: number;
  maxTrackedAddresses?: number;
}

/**
 * Per-IP admission control for the WebSocket upgrade.
 *
 * Deliberately a `Map` and two counters: the relay has no dependency budget for
 * a rate-limiter library, and these bounds only have to raise an attacker's
 * cost above "one host, unlimited sockets", which is where it sits today.
 */
export function createUpgradeAdmission(
  options: UpgradeAdmissionOptions = {},
): UpgradeAdmission {
  const maxUnauthenticated =
    options.maxUnauthenticatedPerAddress ?? MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP;
  const maxUpgrades = options.maxUpgradesPerWindow ?? MAX_UPGRADES_PER_IP_PER_WINDOW;
  const windowMs = options.windowMs ?? UPGRADE_RATE_WINDOW_MS;
  const maxTracked = options.maxTrackedAddresses ?? MAX_TRACKED_CLIENT_ADDRESSES;
  const states = new Map<string, ClientAddressState>();
  let admittedCount = 0;
  const refusedByStatus = new Map<number, number>();

  function refuse(status: number, reason: string): UpgradeRefusal {
    refusedByStatus.set(status, (refusedByStatus.get(status) ?? 0) + 1);
    return { admitted: false, status, reason };
  }

  /** Drop entries that hold no slot and whose rate window has lapsed. */
  function collect(now: number): void {
    for (const [address, state] of states) {
      if (state.unauthenticated === 0 && now - state.windowStartedAt >= windowMs) {
        states.delete(address);
      }
    }
  }

  return {
    admit(address, now = Date.now()): UpgradeRefusal {
      let state = states.get(address);
      if (!state) {
        if (states.size >= maxTracked) {
          collect(now);
          if (states.size >= maxTracked) {
            // Refusing is the conservative branch: the table is already at a
            // size that only a flood produces, and admitting untracked
            // connections would silently disable both bounds exactly when they
            // are needed.
            return refuse(503, "relay is shedding new connections");
          }
        }
        state = { unauthenticated: 0, upgrades: 0, windowStartedAt: now };
        states.set(address, state);
      }

      if (now - state.windowStartedAt >= windowMs) {
        state.windowStartedAt = now;
        state.upgrades = 0;
      }

      if (state.unauthenticated >= maxUnauthenticated) {
        return refuse(
          429,
          `too many unauthenticated connections (limit ${maxUnauthenticated})`,
        );
      }
      if (state.upgrades >= maxUpgrades) {
        return refuse(
          429,
          `too many connection attempts (limit ${maxUpgrades} per ${windowMs} ms)`,
        );
      }

      state.unauthenticated += 1;
      state.upgrades += 1;
      admittedCount += 1;
      return { admitted: true };
    },

    release(address, now = Date.now()): void {
      const state = states.get(address);
      if (!state || state.unauthenticated === 0) return;
      state.unauthenticated -= 1;
      // An entry holding no slot whose rate window has lapsed carries no
      // information, so dropping it here keeps the table at the size of the
      // *live* population instead of every address ever seen. `now` is a
      // parameter for the same reason `admit`'s is: the two must read one
      // clock, or a released entry can be collected against a window it was
      // never measured on.
      if (state.unauthenticated === 0 && now - state.windowStartedAt >= windowMs) {
        states.delete(address);
      }
    },

    trackedAddressCount(): number {
      return states.size;
    },

    unauthenticatedCount(address): number {
      return states.get(address)?.unauthenticated ?? 0;
    },

    stats(): UpgradeAdmissionStats {
      let total = 0;
      const byStatus: Record<string, number> = {};
      for (const [status, count] of refusedByStatus) {
        byStatus[String(status)] = count;
        total += count;
      }
      return {
        admitted: admittedCount,
        refused: { total, byStatus },
        trackedAddresses: states.size,
      };
    },
  };
}

/**
 * Own the HTTP server's `upgrade` event so per-IP admission runs before `ws`
 * allocates anything for the connection.
 *
 * This is why the relay's `WebSocketServer` is built with `noServer: true`:
 * `ws` in `server` mode installs this listener itself and exposes no hook that
 * runs first. `verifyClient` is not that hook either — it is deprecated, and it
 * runs after the socket is already ws's.
 *
 * Returns the pre-auth slot releaser the connection handler must call: once
 * when the socket authenticates, and again (harmlessly) when it closes.
 */
export function attachUpgradeAdmission(options: {
  server: Server;
  wss: WebSocketServer;
  admission: UpgradeAdmission;
  onRefused?(address: string, reason: string): void;
}): void {
  const { server, wss, admission } = options;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const clientAddress = clientAddressForRequest(req);
    const decision = admission.admit(clientAddress);
    if (!decision.admitted) {
      options.onRefused?.(clientAddress, decision.reason);
      const status = decision.status === 503
        ? "503 Service Unavailable"
        : "429 Too Many Requests";
      const body = `${decision.reason}\n`;
      // Admission runs before the WebSocket upgrade so an HTTP refusal is the
      // protocol-level equivalent of a close frame. Finish the response with
      // the reason before closing; write()+destroy() can discard buffered
      // bytes and surface to clients as an unexplained TCP reset.
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      );
      return;
    }

    let admitted = false;
    try {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        admitted = true;
        wss.emit("connection", ws, req);
      });
    } finally {
      // `handleUpgrade` invokes its callback synchronously on success, and
      // destroys the socket itself when the request is not a valid WebSocket
      // upgrade — in which case no `connection`, and so no `close`, ever fires
      // to give the slot back.
      if (!admitted) admission.release(clientAddress);
    }
  });
}
