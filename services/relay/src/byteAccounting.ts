import type { RawData, WebSocket } from "ws";

/**
 * The relay's byte odometer.
 *
 * Cumulative sent/received byte counters per WebSocket connection, attributed
 * to the authenticated Firebase uid and desktop id and split by message class,
 * so real per-user traffic can be measured ahead of subscription pricing
 * (`docs/specs/accounts-and-billing.md`).
 *
 * Counters live in this process only: they are reported through the log lines
 * below and `GET /stats`, and a relay restart resets them. Every accumulator
 * is an integer add on a path that already measured the payload for
 * backpressure — the odometer never re-measures a frame and never logs one.
 *
 * Per-user attribution is operator-only. `GET /stats` reports process
 * aggregates with no uid, desktop id, or per-connection row to a Firebase ID
 * token, so an ordinary authenticated caller learns nothing about another
 * account; the per-connection readers below (`getLiveConnectionReports`,
 * `getRecentConnectionReports`) are served only to a caller presenting the
 * operator credential `KANNA_RELAY_STATS_TOKEN` (see `relayStatus.ts`).
 */

/**
 * Message classes, split so the dominant traffic driver is visible.
 *
 * - `tunnel` — spliced `ksp` tunnel frames (the Kanna Server Protocol,
 *   including raw terminal bytes). The relay never parses tunnel frames, so a
 *   tunnel's class comes from the service it was opened for, not its content.
 * - `taskTransfer` — spliced `task-transfer` tunnel frames.
 * - `terminalEvent` — session-scoped terminal stream events routed over the
 *   control channel to `observe_session` observers. This is how the mobile
 *   app's remote transport streams a terminal, so it is terminal traffic even
 *   though it is not a tunnel.
 * - `control` — everything else: auth, invokes, responses, task snapshot
 *   publication, mobile notifications, acks.
 */
export const RELAY_BYTE_CLASSES = [
  "tunnel",
  "taskTransfer",
  "terminalEvent",
  "control",
] as const;

export type RelayByteClass = (typeof RELAY_BYTE_CLASSES)[number];

export type RelayByteTotals = Record<RelayByteClass, number>;

export type RelayConnectionRole = "unauthenticated" | "phone" | "server";

export interface RelayByteAccountIdentity {
  uid?: string | null;
  desktopId?: string | null;
  role?: RelayConnectionRole;
  tunnelService?: string | null;
}

export interface RelayByteAccount {
  readonly connectionId: number;
  readonly uid: string | null;
  readonly desktopId: string | null;
  readonly role: RelayConnectionRole;
  readonly tunnelService: string | null;
  readonly openedAtMs: number;
  readonly received: RelayByteTotals;
  readonly sent: RelayByteTotals;
}

export interface RelayByteStats {
  startedAt: string;
  uptimeMs: number;
  connections: {
    open: number;
    opened: number;
    closed: number;
  };
  received: RelayByteTotals & { total: number };
  sent: RelayByteTotals & { total: number };
  totalBytes: number;
}

/**
 * One connection's odometer, flattened for reporting. The same shape is used
 * for a live connection, for its close-time rollup, and for the `[bytes]` log
 * line, so an operator reading the dashboard and an operator reading the logs
 * are reading the same record.
 */
export interface RelayConnectionReport {
  connectionId: number;
  uid: string | null;
  desktopId: string | null;
  role: RelayConnectionRole;
  tunnelService: string | null;
  /** Whether this socket negotiated `permessage-deflate` at the upgrade. */
  compressed: boolean;
  openedAt: string;
  /** Present only on a closed connection's rollup. */
  closedAt?: string;
  durationMs: number;
  received: RelayByteTotals & { total: number };
  sent: RelayByteTotals & { total: number };
  totalBytes: number;
}

export interface RelayCompressionStats {
  /** Connections that negotiated `permessage-deflate`, since process start. */
  negotiated: number;
  /** Connections that did not — the desktop client, today. */
  plain: number;
}

interface ConnectionByteAccount {
  connectionId: number;
  uid: string | null;
  desktopId: string | null;
  role: RelayConnectionRole;
  tunnelService: string | null;
  compressed: boolean;
  openedAtMs: number;
  received: RelayByteTotals;
  sent: RelayByteTotals;
}

/**
 * Default rollup cadence. Long-lived tunnels can stay open for days, so their
 * bytes must be visible before the close line eventually lands.
 */
export const DEFAULT_BYTE_ROLLUP_INTERVAL_MS = 60 * 60 * 1_000;
const MIN_BYTE_ROLLUP_INTERVAL_MS = 1_000;

function emptyTotals(): RelayByteTotals {
  return { tunnel: 0, taskTransfer: 0, terminalEvent: 0, control: 0 };
}

const accounts = new WeakMap<WebSocket, ConnectionByteAccount>();
/** Strongly held so the periodic rollup can walk live connections. */
const openAccounts = new Set<ConnectionByteAccount>();

/**
 * How many close-time rollups the status dashboard can look back over. A ring,
 * because this is a 1 GB e2-micro and an unbounded history of every connection
 * the process ever served is a leak with a nice name.
 */
export const RECENT_CONNECTION_REPORT_LIMIT = 25;

let nextConnectionId = 1;
let processStartedAtMs = Date.now();
let connectionsOpened = 0;
let connectionsClosed = 0;
let compressionNegotiated = 0;
let compressionPlain = 0;
let processReceived = emptyTotals();
let processSent = emptyTotals();
/** Newest last; trimmed to RECENT_CONNECTION_REPORT_LIMIT. */
let recentReports: RelayConnectionReport[] = [];
let rollupTimer: ReturnType<typeof setInterval> | null = null;

/** Byte length of a `ws` frame without copying or re-encoding it. */
export function rawDataByteLength(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data.byteLength;
}

/**
 * Class of a parsed control-channel message. Terminal stream events are the
 * only control-channel traffic the relay already identifies by shape (it
 * routes them to session observers), so classification is free here.
 */
export function relayMessageByteClass(
  message: { type?: unknown; payload?: unknown } | null | undefined,
): RelayByteClass {
  if (message?.type !== "event") return "control";
  const payload = message.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "control";
  }
  const sessionId = (payload as Record<string, unknown>).session_id;
  return typeof sessionId === "string" && sessionId.length > 0
    ? "terminalEvent"
    : "control";
}

export function openByteAccount(ws: WebSocket): void {
  // `ws.extensions` is settled by the time the `connection` event fires — the
  // extension is negotiated during the HTTP upgrade — so reading it here costs
  // one string test per connection and answers "is compression actually being
  // used?" without instrumenting the compression path itself.
  const compressed = typeof ws.extensions === "string"
    && ws.extensions.includes("permessage-deflate");
  const account: ConnectionByteAccount = {
    connectionId: nextConnectionId++,
    uid: null,
    desktopId: null,
    role: "unauthenticated",
    tunnelService: null,
    compressed,
    openedAtMs: Date.now(),
    received: emptyTotals(),
    sent: emptyTotals(),
  };
  accounts.set(ws, account);
  openAccounts.add(account);
  connectionsOpened += 1;
  if (compressed) compressionNegotiated += 1;
  else compressionPlain += 1;
}

/**
 * Attach or refine the identity a connection's bytes are attributed to.
 * Only supplied fields are applied, so a phone socket that later opens a
 * tunnel keeps its uid while gaining the desktop it tunnels to.
 */
export function identifyByteAccount(
  ws: WebSocket,
  identity: RelayByteAccountIdentity,
): void {
  const account = accounts.get(ws);
  if (!account) return;
  if (identity.uid != null) account.uid = identity.uid;
  if (identity.desktopId != null) account.desktopId = identity.desktopId;
  if (identity.role) account.role = identity.role;
  if (identity.tunnelService != null) account.tunnelService = identity.tunnelService;
}

export function recordBytesReceived(
  ws: WebSocket,
  byteClass: RelayByteClass,
  byteLength: number,
): void {
  const account = accounts.get(ws);
  if (!account) return;
  account.received[byteClass] += byteLength;
  processReceived[byteClass] += byteLength;
}

export function recordBytesSent(
  ws: WebSocket,
  byteClass: RelayByteClass,
  byteLength: number,
): void {
  const account = accounts.get(ws);
  if (!account) return;
  account.sent[byteClass] += byteLength;
  processSent[byteClass] += byteLength;
}

/** Read a connection's odometer. Exposed for tests and rollup composition. */
export function byteAccountFor(ws: WebSocket): RelayByteAccount | null {
  return accounts.get(ws) ?? null;
}

/**
 * Emit the connection's close-time rollup and stop tracking it. Idempotent:
 * `ws` close handlers can fire more than once per socket.
 */
export function closeByteAccount(ws: WebSocket): void {
  const account = accounts.get(ws);
  if (!account) return;
  accounts.delete(ws);
  openAccounts.delete(account);
  connectionsClosed += 1;
  const closedAtMs = Date.now();
  recentReports.push(describeAccount(account, closedAtMs, closedAtMs));
  if (recentReports.length > RECENT_CONNECTION_REPORT_LIMIT) {
    recentReports.splice(0, recentReports.length - RECENT_CONNECTION_REPORT_LIMIT);
  }
  logAccount("connection_close", account, closedAtMs);
}

/** Emit one rollup line per still-open connection. */
export function emitByteRollups(nowMs = Date.now()): void {
  for (const account of openAccounts) {
    logAccount("connection_rollup", account, nowMs);
  }
}

export function resolveByteRollupIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.KANNA_RELAY_BYTE_ROLLUP_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_BYTE_ROLLUP_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_BYTE_ROLLUP_INTERVAL_MS) {
    console.warn(
      `[bytes] Ignoring invalid KANNA_RELAY_BYTE_ROLLUP_INTERVAL_MS=${raw}`,
    );
    return DEFAULT_BYTE_ROLLUP_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

export function startByteRollups(intervalMs = resolveByteRollupIntervalMs()): void {
  stopByteRollups();
  rollupTimer = setInterval(() => emitByteRollups(), intervalMs);
  rollupTimer.unref?.();
}

export function stopByteRollups(): void {
  if (!rollupTimer) return;
  clearInterval(rollupTimer);
  rollupTimer = null;
}

/**
 * Process-wide aggregates. Deliberately carries no uid, desktop id, or
 * per-connection row: this is what `GET /stats` serves.
 */
export function getByteStats(nowMs = Date.now()): RelayByteStats {
  return {
    startedAt: new Date(processStartedAtMs).toISOString(),
    uptimeMs: Math.max(0, nowMs - processStartedAtMs),
    connections: {
      open: openAccounts.size,
      opened: connectionsOpened,
      closed: connectionsClosed,
    },
    received: withTotal(processReceived),
    sent: withTotal(processSent),
    totalBytes: sumTotals(processReceived) + sumTotals(processSent),
  };
}

/**
 * Per-connection rows for the still-open connections, newest connection last.
 *
 * This carries uid and desktop id, so it is **operator-only** — see the
 * visibility split in `relayStatus.ts`. Walks `openAccounts`, which the rollup
 * timer already walks; there is no second registry to keep in step.
 */
export function getLiveConnectionReports(nowMs = Date.now()): RelayConnectionReport[] {
  const reports: RelayConnectionReport[] = [];
  for (const account of openAccounts) reports.push(describeAccount(account, nowMs));
  return reports;
}

/**
 * The last `RECENT_CONNECTION_REPORT_LIMIT` close-time rollups, newest first —
 * the same records the `[bytes] connection_close` log lines carry. Also
 * operator-only.
 */
export function getRecentConnectionReports(): RelayConnectionReport[] {
  return [...recentReports].reverse();
}

/** How many connections negotiated compression, since process start. */
export function getCompressionStats(): RelayCompressionStats {
  return { negotiated: compressionNegotiated, plain: compressionPlain };
}

/**
 * Authorize a `GET /stats` request. The relay already verifies Firebase ID
 * tokens for its other authenticated HTTP routes; this only extracts the
 * bearer credential.
 */
export function statsBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function withTotal(totals: RelayByteTotals): RelayByteTotals & { total: number } {
  return { ...totals, total: sumTotals(totals) };
}

function sumTotals(totals: RelayByteTotals): number {
  let total = 0;
  for (const byteClass of RELAY_BYTE_CLASSES) total += totals[byteClass];
  return total;
}

/** Flatten one account into the record every reader and the log line share. */
function describeAccount(
  account: ConnectionByteAccount,
  nowMs: number,
  closedAtMs?: number,
): RelayConnectionReport {
  const received = withTotal(account.received);
  const sent = withTotal(account.sent);
  return {
    connectionId: account.connectionId,
    uid: account.uid,
    desktopId: account.desktopId,
    role: account.role,
    tunnelService: account.tunnelService,
    compressed: account.compressed,
    openedAt: new Date(account.openedAtMs).toISOString(),
    ...(closedAtMs === undefined ? {} : { closedAt: new Date(closedAtMs).toISOString() }),
    durationMs: Math.max(0, nowMs - account.openedAtMs),
    received,
    sent,
    totalBytes: received.total + sent.total,
  };
}

function logAccount(
  event: "connection_close" | "connection_rollup",
  account: ConnectionByteAccount,
  nowMs: number,
): void {
  const receivedTotal = sumTotals(account.received);
  const sentTotal = sumTotals(account.sent);
  console.log(`[bytes] ${JSON.stringify({
    event,
    connectionId: account.connectionId,
    uid: account.uid,
    desktopId: account.desktopId,
    role: account.role,
    tunnelService: account.tunnelService,
    durationMs: Math.max(0, nowMs - account.openedAtMs),
    received: account.received,
    sent: account.sent,
    receivedTotal,
    sentTotal,
    totalBytes: receivedTotal + sentTotal,
  })}`);
}

export function resetByteAccountingForTests(): void {
  openAccounts.clear();
  nextConnectionId = 1;
  processStartedAtMs = Date.now();
  connectionsOpened = 0;
  connectionsClosed = 0;
  compressionNegotiated = 0;
  compressionPlain = 0;
  recentReports = [];
  processReceived = emptyTotals();
  processSent = emptyTotals();
  stopByteRollups();
}
