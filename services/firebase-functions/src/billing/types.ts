/**
 * Billing source-state and entitlement shapes.
 *
 * `docs/specs/accounts-and-billing.md` Decision 3: one entitlement, three
 * writers, one reducer. No handler ever upserts the entitlement doc — each
 * source writes its own source-state doc under `users/{uid}/billing/{source}`
 * and every write invokes `recomputeEntitlement(uid)`, which derives
 * `users/{uid}/entitlements/cloud_access` from all sources at once.
 */

/** The sources that write their own source-state doc. */
export type BillingSourceId = "stripe" | "app_store" | "comp";

/** Sources that carry a billing relationship (comp deliberately does not). */
export type BilledSourceId = Extract<BillingSourceId, "stripe" | "app_store">;

/** Every source that may end up named on the entitlement record. */
export type EntitlementSource =
  | BillingSourceId
  | "free_beta"
  | "grandfathered"
  | "promo";

export type EntitlementStatus = "active" | "grace" | "expired" | "revoked";

/** Per-source state; the same four words as the entitlement, per source. */
export type SourceStatus = EntitlementStatus;

export type BillingEnvironment = "production" | "sandbox" | "staging";

export const CLOUD_ACCESS_CAPABILITIES = [
  "cloud_relay",
  "cloud_task_index",
  "remote_task_control",
] as const;

export type CloudAccessCapability = (typeof CLOUD_ACCESS_CAPABILITIES)[number];

/**
 * State of one billed source, written only by that source's webhook/callable.
 *
 * `lastEventAt` is the source event's own timestamp (Stripe's `created`), which
 * is how out-of-order deliveries are resolved: an event older than the state it
 * would overwrite is dropped rather than applied.
 */
export interface BilledSourceState {
  source: BilledSourceId;
  status: SourceStatus;
  currentPeriodEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  environment: BillingEnvironment;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  appStoreOriginalTransactionId: string | null;
  lastEventAt: string;
  lastEventId: string | null;
  updatedAt: string;
}

/**
 * Complimentary access (Decision 3, owner's "leech flag"). No billing
 * relationship, never bills, never duns, never expires — only explicit
 * revocation ends it. Granted by a manual admin-SDK write for v1.
 */
export interface CompSourceState {
  source: "comp";
  active: boolean;
  reason: string | null;
  grantedBy: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
}

/** The single derived record the relay reads. Written only by the reducer. */
export interface EntitlementRecord {
  status: EntitlementStatus;
  source: EntitlementSource;
  capabilities: CloudAccessCapability[];
  currentPeriodEndsAt: string | null;
  graceEndsAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  appStoreOriginalTransactionId: string | null;
  duplicateSources: boolean;
  environment: BillingEnvironment;
  updatedAt: string;
}

/** All source docs for one account, as the reducer sees them. */
export interface BillingSourceSnapshot {
  stripe: BilledSourceState | null;
  app_store: BilledSourceState | null;
  comp: CompSourceState | null;
}

export const CLOUD_ACCESS_ENTITLEMENT_ID = "cloud_access";

export function userDocPath(uid: string): string {
  return `users/${uid}`;
}

/** Durable fence that prevents uid-owned cloud data from being recreated. */
export function accountDeletionPath(uid: string): string {
  return `accountDeletions/${uid}`;
}

export function billingSourcePath(uid: string, source: BillingSourceId): string {
  return `users/${uid}/billing/${source}`;
}

export function entitlementPath(uid: string): string {
  return `users/${uid}/entitlements/${CLOUD_ACCESS_ENTITLEMENT_ID}`;
}

/** Reverse map so subscription-scoped events can resolve their account. */
export function stripeCustomerPath(customerId: string): string {
  return `stripeCustomers/${customerId}`;
}

/** Webhook dedupe ledger; one doc per Stripe event id. */
export function stripeEventPath(eventId: string): string {
  return `stripeEvents/${eventId}`;
}

/** Reverse map for Apple's `appAccountToken` (written in Slice 2). */
export function appAccountTokenPath(token: string): string {
  return `appAccountTokens/${token}`;
}
