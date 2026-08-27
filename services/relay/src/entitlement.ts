/**
 * Relay-side entitlement enforcement (`docs/specs/accounts-and-billing.md`,
 * Decision 5).
 *
 * The relay is the enforcement point because it terminates every unit of remote
 * value — tunnels, cloud task snapshot publication, and remote task control —
 * and already re-reads
 * Firestore per connection for credential revalidation. After identity
 * verification the session's uid is resolved to
 * `users/{uid}/entitlements/cloud_access`, the single record the reducer in
 * `services/firebase-functions` derives from every billing source.
 *
 * Two properties this module exists to hold:
 *
 * - **Enforcement is source-agnostic.** It reads `status` and `capabilities`
 *   and never branches on `source`, which is exactly why adding the Apple
 *   channel or a `comp` grant touches the writers and the reducer, never here.
 * - **It is off until Slice 3.** Every entry point is behind
 *   `KANNA_RELAY_ENTITLEMENT_ENFORCEMENT`, which defaults to off; with the flag
 *   off nothing here reads Firestore and no relay response changes shape.
 */
import { getFirebaseServices } from "./firebase.js";

/**
 * The refusal code, shared by every path that turns a request down for want of
 * an entitlement. Distinct on purpose: a client that sees it renders the
 * neutral "subscription required" state, where a generic error would read as a
 * connection fault (Decision 5).
 *
 * The relay never closes an ordinary session over an entitlement — an
 * unentitled account still authenticates and still holds its socket, so it can
 * read its own state and recover the moment it subscribes. The one close that
 * uses this code is a tunnel socket, which carries nothing but the payload it
 * was refused permission to move; it lives in the WebSocket private range for
 * exactly that use.
 */
export const ENTITLEMENT_REQUIRED_CODE = 4402;
export const ENTITLEMENT_REQUIRED_ERROR = "entitlement required";

/**
 * Capability names on the entitlement record (the reducer's own vocabulary).
 *
 * What each gates at the relay: `cloud_relay` covers tunnels,
 * `cloud_task_index` covers task snapshot publication, and
 * `remote_task_control` covers `invoke` routing — phone-to-desktop and
 * desktop-to-desktop alike. Notifications deliberately sit outside this
 * capability set: the owner's 2026-08-24 amendment makes account and anonymous
 * push free while tunnels, snapshots, and remote task control stay paid.
 *
 * The reducer writes all three or none, so these distinctions do not change any
 * behaviour today; they exist so a future partial capability set means what it
 * says.
 */
export type CloudAccessCapability =
  | "cloud_relay"
  | "cloud_task_index"
  | "remote_task_control";

export type EntitlementStatus = "active" | "grace" | "expired" | "revoked";

/**
 * The subset of the entitlement record this service reads. The reducer writes
 * more (billing ids, `duplicateSources`, `environment`); none of it is an
 * enforcement input.
 */
export interface EntitlementRecord {
  status: EntitlementStatus;
  capabilities: CloudAccessCapability[];
  currentPeriodEndsAt: string | null;
  graceEndsAt: string | null;
}

/** What a session may be told about its own entitlement in `auth_ok`. */
export interface EntitlementSnapshot {
  active: boolean;
  /**
   * `none` means no entitlement document exists for the account at all;
   * `unknown` means the relay could not read one and is serving the session
   * anyway, which a client should treat as "leave the display alone" rather
   * than as either state.
   */
  status: EntitlementStatus | "none" | "unknown";
  currentPeriodEndsAt: string | null;
  graceEndsAt: string | null;
  /**
   * Present only when access is refused for a reason the entitlement record
   * does not carry, so a client can say "verify your email" instead of sending
   * the account to a checkout page that would refuse it too.
   */
  reason?: "unverified_email";
}

/** The account behind a session, as far as entitlement is concerned. */
export interface EntitlementSubject {
  userId: string;
  /**
   * The phone ID token's `email_verified` claim. Null for desktop
   * `desktopCredentials` sessions, which carry no token and so make no claim —
   * Decision 1 gates *phone tokens* on verification, not desktops.
   */
  emailVerified: boolean | null;
}

const ENFORCEMENT_ENV = "KANNA_RELAY_ENTITLEMENT_ENFORCEMENT";
const CACHE_TTL_ENV = "KANNA_RELAY_ENTITLEMENT_CACHE_TTL_MS";

/**
 * Resolve the enforcement flag.
 *
 * Default **off**, and off in every deployment until the Slice-3 flag day. Only
 * an explicit affirmative turns it on; anything unrecognised is off and says so
 * once, because the failure mode of a typo must be "the relay serves everyone"
 * rather than "the relay refuses everyone".
 */
export function resolveEntitlementEnforcement(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[ENFORCEMENT_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === "on" || raw === "true" || raw === "1") return true;
  if (raw === "off" || raw === "false" || raw === "0") return false;
  console.warn(`[entitlement] Ignoring unrecognized ${ENFORCEMENT_ENV}=${raw}; enforcement stays off`);
  return false;
}

/**
 * How long a resolved entitlement stays usable.
 *
 * Same tradeoff, and the same 60s, as the desktop-credential cache in
 * `auth.ts`: the read happens on every publication, push and tunnel request, so
 * an uncached read costs a Firestore read per message for a document that
 * changes when somebody subscribes or cancels. The TTL is the window in which
 * an entitlement revoked out from under a session is still honoured, and the
 * relay sees no entitlement write of its own, so this bound is the real
 * revocation latency rather than a backstop behind a hook.
 */
export const DEFAULT_ENTITLEMENT_CACHE_TTL_MS = 60_000;

/** Override for the TTL above. `0` disables the cache, restoring a read per check. */
export function resolveEntitlementCacheTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[CACHE_TTL_ENV]?.trim();
  if (!raw) return DEFAULT_ENTITLEMENT_CACHE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[entitlement] Ignoring invalid ${CACHE_TTL_ENV}=${raw}`);
    return DEFAULT_ENTITLEMENT_CACHE_TTL_MS;
  }
  return Math.floor(parsed);
}

const enforcementEnabled = resolveEntitlementEnforcement();
const cacheTtlMs = resolveEntitlementCacheTtlMs();

/** Whether this process enforces entitlements at all. */
export function entitlementEnforcementEnabled(): boolean {
  return enforcementEnabled;
}

/**
 * Hard cap on cached accounts, so a relay that serves many accounts over its
 * lifetime cannot grow this map without bound on a 1 GB VM.
 */
export const ENTITLEMENT_CACHE_MAX_ENTRIES = 10_000;

interface CachedEntitlement {
  /** Null records an authoritative "no entitlement document"; it caches too. */
  record: EntitlementRecord | null;
  expiresAtMs: number;
}

const entitlementCache = new Map<string, CachedEntitlement>();

function cachedEntitlement(userId: string, nowMs: number): CachedEntitlement | null {
  const entry = entitlementCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    entitlementCache.delete(userId);
    return null;
  }
  return entry;
}

/**
 * Record an answer Firestore just gave. Only ever called for an authoritative
 * one — a read that threw is deliberately not cached, so a transient outage
 * degrades to a re-read rather than pinning a guess for a whole TTL window.
 */
function cacheEntitlement(
  userId: string,
  record: EntitlementRecord | null,
  nowMs: number,
): void {
  entitlementCache.delete(userId);
  if (cacheTtlMs <= 0) return;
  if (entitlementCache.size >= ENTITLEMENT_CACHE_MAX_ENTRIES) {
    evictForCapacity(nowMs);
  }
  entitlementCache.set(userId, { record, expiresAtMs: nowMs + cacheTtlMs });
}

/** Drop expired entries first; fall back to oldest-inserted. */
function evictForCapacity(nowMs: number): void {
  for (const [userId, entry] of entitlementCache) {
    if (entry.expiresAtMs <= nowMs) entitlementCache.delete(userId);
  }
  while (entitlementCache.size >= ENTITLEMENT_CACHE_MAX_ENTRIES) {
    const oldest = entitlementCache.keys().next();
    if (oldest.done) return;
    entitlementCache.delete(oldest.value);
  }
}

/** Drop a cached entitlement (or the whole cache when no uid is given). */
export function invalidateEntitlementCache(userId?: string): void {
  if (userId === undefined) {
    entitlementCache.clear();
    return;
  }
  entitlementCache.delete(userId);
}

function parseCapabilities(value: unknown): CloudAccessCapability[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is CloudAccessCapability =>
    entry === "cloud_relay" || entry === "cloud_task_index" || entry === "remote_task_control");
}

function parseTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseStatus(value: unknown): EntitlementStatus | null {
  return value === "active" || value === "grace" || value === "expired" || value === "revoked"
    ? value
    : null;
}

/**
 * Read the entitlement document itself. Returns null for an authoritative
 * absence (or a document too malformed to mean anything); an unavailable
 * Firestore throws, so the caller can tell the two apart.
 */
async function readEntitlementRecord(userId: string): Promise<EntitlementRecord | null> {
  const { db } = getFirebaseServices();
  const snapshot = await db
    .collection("users")
    .doc(userId)
    .collection("entitlements")
    .doc("cloud_access")
    .get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  const status = parseStatus(data?.status);
  if (!status) {
    console.warn(`[entitlement] Entitlement document for ${userId} has no usable status`);
    return null;
  }
  return {
    status,
    capabilities: parseCapabilities(data?.capabilities),
    currentPeriodEndsAt: parseTimestamp(data?.currentPeriodEndsAt),
    graceEndsAt: parseTimestamp(data?.graceEndsAt),
  };
}

/**
 * Resolve an account's entitlement, from the cache when it is fresh.
 *
 * A Firestore failure resolves to `undefined`, which every caller treats as
 * "no evidence" and therefore **fails open**. An outage of the billing
 * database must not disconnect every paying subscriber; only an authoritative
 * answer refuses. This is the same posture the credential cache takes when
 * Firestore is down.
 */
export async function resolveEntitlement(
  userId: string,
): Promise<EntitlementRecord | null | undefined> {
  const nowMs = Date.now();
  const cached = cachedEntitlement(userId, nowMs);
  if (cached) return cached.record;
  try {
    const record = await readEntitlementRecord(userId);
    cacheEntitlement(userId, record, nowMs);
    return record;
  } catch (err) {
    console.error(`[entitlement] Failed to read the entitlement for ${userId}:`, err);
    return undefined;
  }
}

/**
 * Whether a record grants access right now.
 *
 * `grace` is honoured only until `graceEndsAt`. Nothing sweeps expired grace:
 * the source doc stays `grace` until the billing source sends another event,
 * so a dunning process that leaves a subscription `past_due` indefinitely would
 * otherwise entitle it forever (billing-backend review on task `344057c3`).
 *
 * Deliberately *not* symmetric for `active` past `currentPeriodEndsAt`: a
 * renewal advances that field moments after the period ends, and denying that
 * gap would refuse paying subscribers for a webhook's latency. An `active`
 * record that should have ended is the writer's problem, not the enforcement
 * point's.
 */
export function isEntitlementHonored(
  record: EntitlementRecord | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!record) return false;
  if (record.status === "active") return true;
  if (record.status !== "grace") return false;
  if (!record.graceEndsAt) return true;
  const graceEndsAtMs = Date.parse(record.graceEndsAt);
  if (Number.isNaN(graceEndsAtMs)) return true;
  return graceEndsAtMs > nowMs;
}

function hasCapability(
  record: EntitlementRecord | null | undefined,
  capability: CloudAccessCapability,
  nowMs: number,
): boolean {
  return isEntitlementHonored(record, nowMs) && (record?.capabilities.includes(capability) ?? false);
}

/**
 * Whether a session may use a capability.
 *
 * The three ways this answers true: enforcement is off, the entitlement read
 * found no evidence either way (a Firestore failure — fail open), or the record
 * honours that capability. A phone token whose email is unverified is refused
 * before the document is even consulted (Decision 1).
 */
export async function sessionHasCapability(
  subject: EntitlementSubject,
  capability: CloudAccessCapability,
): Promise<boolean> {
  if (!enforcementEnabled) return true;
  if (subject.emailVerified === false) return false;
  const record = await resolveEntitlement(subject.userId);
  if (record === undefined) return true;
  return hasCapability(record, capability, Date.now());
}

/**
 * Everything a session needs to know about its own entitlement, resolved once
 * at authentication: what to tell the client, and which capabilities to
 * advertise.
 *
 * `grants` is the advertisement rule, not the enforcement rule — the value-
 * bearing paths re-check through `sessionHasCapability` on every request, which
 * is what makes a revocation land inside the TTL bound rather than at the next
 * reconnect.
 */
export interface SessionEntitlement {
  /**
   * The `entitlement` block for `auth_ok`, or null when enforcement is off — in
   * which case the field is omitted entirely and the response is byte-identical
   * to the pre-enforcement relay.
   */
  snapshot: EntitlementSnapshot | null;
  grants(capability: CloudAccessCapability): boolean;
}

/** Enforcement off, or no evidence: advertise and serve everything. */
const UNRESTRICTED_SESSION: SessionEntitlement = {
  snapshot: null,
  grants: () => true,
};

export async function resolveSessionEntitlement(
  subject: EntitlementSubject,
): Promise<SessionEntitlement> {
  if (!enforcementEnabled) return UNRESTRICTED_SESSION;
  if (subject.emailVerified === false) {
    // Decision 1: an unverified email cannot activate an entitlement, so the
    // relay treats the session as unentitled without consulting the document —
    // hence `unknown` rather than a status it never read, with the refusal's
    // real reason named beside it.
    return {
      snapshot: {
        active: false,
        status: "unknown",
        currentPeriodEndsAt: null,
        graceEndsAt: null,
        reason: "unverified_email",
      },
      grants: () => false,
    };
  }
  const record = await resolveEntitlement(subject.userId);
  if (record === undefined) {
    // Fail open: the session is served, and says so, rather than being told it
    // is unsubscribed because a database was briefly unreachable.
    return {
      snapshot: { active: true, status: "unknown", currentPeriodEndsAt: null, graceEndsAt: null },
      grants: () => true,
    };
  }
  const nowMs = Date.now();
  return {
    snapshot: record
      ? {
          active: isEntitlementHonored(record, nowMs),
          status: record.status,
          currentPeriodEndsAt: record.currentPeriodEndsAt,
          graceEndsAt: record.graceEndsAt,
        }
      : { active: false, status: "none", currentPeriodEndsAt: null, graceEndsAt: null },
    grants: (capability) => hasCapability(record, capability, nowMs),
  };
}
