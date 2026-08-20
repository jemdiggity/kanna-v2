import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  getByteStats,
  getCompressionStats,
  getLiveConnectionReports,
  getRecentConnectionReports,
  statsBearerToken,
  type RelayByteStats,
  type RelayCompressionStats,
  type RelayConnectionReport,
} from "./byteAccounting.js";
import { getConnectionCount, getTunnelFlowStats } from "./router.js";
import type { UpgradeAdmissionStats } from "./webSocketLimits.js";

/**
 * The relay's status surface: `GET /stats` and the `GET /dashboard` page it
 * feeds.
 *
 * There are two credentials, and they see different things:
 *
 * - A **Firebase ID token** — what `/stats` has always accepted — sees process
 *   aggregates only: bytes by class, connection totals, tunnel buffer pressure,
 *   upgrade admission, compression negotiation. No uid, no desktop id, no
 *   per-connection row, exactly as before.
 * - The **operator token** `KANNA_RELAY_STATS_TOKEN` additionally sees the live
 *   connection list and the recent close-time rollups, which carry uid and
 *   desktop id. That is per-user data, so it is deliberately not something an
 *   arbitrary signed-up account can read by holding a valid ID token.
 *
 * Neither is public: without a credential both routes answer 401, and `/health`
 * is unchanged and stays the unauthenticated liveness probe.
 */

/** Visibility a request's credential earned. */
export type RelayStatsAudience = "operator" | "account";

export interface RelayStatsPayload {
  status: "ok";
  commit: string;
  /** Paired desktop/phone connections known to the router. */
  connections: number;
  bytes: RelayByteStats;
  compression: RelayCompressionStats;
  tunnelFlow: ReturnType<typeof getTunnelFlowStats>;
  upgrades: UpgradeAdmissionStats;
  /** Operator credential only; carries uid and desktop id. */
  liveConnections?: RelayConnectionReport[];
  /** Operator credential only; carries uid and desktop id. */
  recentConnections?: RelayConnectionReport[];
}

/**
 * Shortest string accepted as the operator token. A token the length of a
 * password someone typed by hand is not a credential for a route that reports
 * which accounts are connected, and silently accepting one would be worse than
 * refusing to enable the dashboard at all.
 */
const MIN_STATS_TOKEN_LENGTH = 16;

/**
 * The operator token from the environment, or null when the relay is running
 * without one — which is how every relay deployed before this landed behaves,
 * and it leaves `/stats` exactly as it was.
 */
export function resolveStatsToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.KANNA_RELAY_STATS_TOKEN?.trim();
  if (!raw) return null;
  if (raw.length < MIN_STATS_TOKEN_LENGTH) {
    console.warn(
      `[stats] Ignoring KANNA_RELAY_STATS_TOKEN: it is shorter than ${MIN_STATS_TOKEN_LENGTH} characters, `
      + "so the status dashboard stays disabled.",
    );
    return null;
  }
  return raw;
}

/**
 * The credential a status request presented: `Authorization: Bearer …`, or a
 * `?token=` query parameter.
 *
 * The query parameter exists so `kd relay stats --open` can hand a browser a
 * working URL — a page cannot set a request header on its own navigation. It is
 * an accepted trade for a single-operator tool: both routes answer `no-store`
 * and `no-referrer`, and the token grants nothing but this read.
 */
export function statsRequestToken(req: Pick<IncomingMessage, "headers" | "url">): string | null {
  const header = statsBearerToken(req.headers.authorization);
  if (header) return header;
  const query = new URL(req.url ?? "/", "http://relay.invalid").searchParams.get("token");
  return query && query.length > 0 ? query : null;
}

/** Constant-time comparison over digests, so neither value's length leaks. */
export function matchesStatsToken(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function buildRelayStatsPayload(input: {
  commit: string;
  upgrades: UpgradeAdmissionStats;
  audience: RelayStatsAudience;
  nowMs?: number;
}): RelayStatsPayload {
  const nowMs = input.nowMs ?? Date.now();
  return {
    status: "ok",
    commit: input.commit,
    connections: getConnectionCount(),
    bytes: getByteStats(nowMs),
    compression: getCompressionStats(),
    tunnelFlow: getTunnelFlowStats(),
    upgrades: input.upgrades,
    ...(input.audience === "operator"
      ? {
          liveConnections: getLiveConnectionReports(nowMs),
          recentConnections: getRecentConnectionReports(),
        }
      : {}),
  };
}
