/**
 * Pure translation from a Stripe webhook event into a `billing/stripe`
 * source-state patch.
 *
 * Nothing here touches Firestore or the network, so the whole mapping table in
 * `docs/specs/accounts-and-billing.md` Decision 3 is testable against captured
 * Stripe fixture payloads.
 *
 * Only the raw fields the mapping reads are typed here rather than Stripe's own
 * `Stripe.Event`: webhook payloads arrive as JSON whose shape is pinned by the
 * endpoint's API version, and reading both the pre- and post-2025 spellings of
 * the moved fields is more honest than casting fixtures into a type that only
 * describes one of them.
 */
import type { SourceStatus } from "./types.js";

export interface StripeEventEnvelope {
  id: string;
  type: string;
  /** Stripe's own event timestamp, in unix seconds; resolves out-of-order delivery. */
  created: number;
  data: { object: Record<string, unknown> };
}

/** What the event says about which account it belongs to. */
export interface StripeAccountHint {
  uid: string | null;
  customerId: string | null;
}

/** The known-field subset of a source-state write; absent keys keep their stored value. */
export interface StripeSourcePatch {
  status?: SourceStatus;
  currentPeriodEndsAt?: string | null;
  graceEndsAt?: string | null;
  cancelAtPeriodEnd?: boolean;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}

export type StripeEventInterpretation =
  | { kind: "ignored"; reason: string }
  | { kind: "apply"; account: StripeAccountHint; patch: StripeSourcePatch };

export interface InterpretStripeEventOptions {
  /**
   * Fallback grace window, in days past the current period end, when a failing
   * invoice names no next retry attempt. See `config.ts`.
   */
  graceFallbackDays: number;
}

const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

/** Stripe subscription status → Kanna source status (Decision 3). */
export function mapSubscriptionStatus(status: string): SourceStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "grace";
    case "canceled":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return "expired";
    default:
      // An unrecognized status is not evidence of entitlement.
      return "expired";
  }
}

export function isHandledStripeEventType(type: string): boolean {
  return HANDLED_EVENT_TYPES.has(type);
}

export function stripeEventCreatedAt(event: StripeEventEnvelope): string {
  return new Date(event.created * 1000).toISOString();
}

export function interpretStripeEvent(
  event: StripeEventEnvelope,
  options: InterpretStripeEventOptions
): StripeEventInterpretation {
  const object = event.data.object;

  switch (event.type) {
    case "checkout.session.completed":
      return interpretCheckoutSession(object);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return interpretSubscription(object, false);
    case "customer.subscription.deleted":
      return interpretSubscription(object, true);
    case "invoice.paid":
      return interpretInvoicePaid(object);
    case "invoice.payment_failed":
      return interpretInvoiceFailed(object, options.graceFallbackDays);
    default:
      return { kind: "ignored", reason: `unhandled event type ${event.type}` };
  }
}

/**
 * Checkout completion binds the Stripe customer and subscription to the account.
 *
 * A paid, complete session is itself proof of entitlement, so it activates the
 * source immediately rather than waiting for `customer.subscription.created`;
 * the period end it does not know arrives with that event moments later. An
 * unpaid or still-open session binds the ids and nothing else.
 */
function interpretCheckoutSession(object: Record<string, unknown>): StripeEventInterpretation {
  const account: StripeAccountHint = {
    uid: readString(object, "client_reference_id") ?? readMetadataUid(object),
    customerId: readReferenceId(object.customer),
  };
  const patch: StripeSourcePatch = {
    stripeCustomerId: account.customerId,
    stripeSubscriptionId: readReferenceId(object.subscription),
  };

  const paid =
    readString(object, "status") === "complete" &&
    ["paid", "no_payment_required"].includes(readString(object, "payment_status") ?? "");
  if (paid) {
    patch.status = "active";
    patch.graceEndsAt = null;
  }
  return { kind: "apply", account, patch };
}

function interpretSubscription(
  object: Record<string, unknown>,
  deleted: boolean
): StripeEventInterpretation {
  const account: StripeAccountHint = {
    uid: readMetadataUid(object),
    customerId: readReferenceId(object.customer),
  };
  const status = deleted ? "expired" : mapSubscriptionStatus(readString(object, "status") ?? "");
  const currentPeriodEndsAt = readSubscriptionPeriodEnd(object);

  const patch: StripeSourcePatch = {
    status,
    currentPeriodEndsAt,
    cancelAtPeriodEnd: readBoolean(object, "cancel_at_period_end") ?? false,
    stripeCustomerId: account.customerId,
    stripeSubscriptionId: readString(object, "id"),
  };
  // Grace is entered by the failing invoice, which is the event that knows when
  // Stripe retries next; a subscription that is no longer past_due leaves it.
  if (status !== "grace") {
    patch.graceEndsAt = null;
  }
  return { kind: "apply", account, patch };
}

function interpretInvoicePaid(object: Record<string, unknown>): StripeEventInterpretation {
  const subscriptionId = readInvoiceSubscriptionId(object);
  if (!subscriptionId) {
    return { kind: "ignored", reason: "invoice is not subscription-scoped" };
  }
  return {
    kind: "apply",
    account: { uid: readMetadataUid(object), customerId: readReferenceId(object.customer) },
    patch: {
      status: "active",
      currentPeriodEndsAt: readInvoicePeriodEnd(object),
      graceEndsAt: null,
      stripeCustomerId: readReferenceId(object.customer),
      stripeSubscriptionId: subscriptionId,
    },
  };
}

function interpretInvoiceFailed(
  object: Record<string, unknown>,
  graceFallbackDays: number
): StripeEventInterpretation {
  const subscriptionId = readInvoiceSubscriptionId(object);
  if (!subscriptionId) {
    return { kind: "ignored", reason: "invoice is not subscription-scoped" };
  }
  const nextAttempt = readUnixSeconds(object, "next_payment_attempt");
  const periodEnd = readInvoicePeriodEnd(object);
  return {
    kind: "apply",
    account: { uid: readMetadataUid(object), customerId: readReferenceId(object.customer) },
    patch: {
      status: "grace",
      graceEndsAt: nextAttempt ?? addDays(periodEnd, graceFallbackDays),
      stripeCustomerId: readReferenceId(object.customer),
      stripeSubscriptionId: subscriptionId,
    },
  };
}

function addDays(from: string | null, days: number): string | null {
  if (!from) return null;
  const parsed = Date.parse(from);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Stripe moved `current_period_end` from the subscription onto its items in the
 * 2025 API versions; read whichever spelling the endpoint's version sends.
 */
function readSubscriptionPeriodEnd(object: Record<string, unknown>): string | null {
  const direct = readUnixSeconds(object, "current_period_end");
  if (direct) return direct;

  const items = readRecord(object.items);
  const data = items ? readArray(items.data) : null;
  const ends = (data ?? [])
    .map((entry) => readRecord(entry))
    .map((entry) => (entry ? readUnixSeconds(entry, "current_period_end") : null))
    .filter((value): value is string => value !== null)
    .sort();
  return ends.at(-1) ?? null;
}

/** Invoices moved the subscription ref under `parent.subscription_details` in 2025. */
function readInvoiceSubscriptionId(object: Record<string, unknown>): string | null {
  const direct = readReferenceId(object.subscription);
  if (direct) return direct;

  const parent = readRecord(object.parent);
  const details = parent ? readRecord(parent.subscription_details) : null;
  return details ? readReferenceId(details.subscription) : null;
}

function readInvoicePeriodEnd(object: Record<string, unknown>): string | null {
  const lines = readRecord(object.lines);
  const data = lines ? readArray(lines.data) : null;
  const ends = (data ?? [])
    .map((entry) => readRecord(entry))
    .map((entry) => (entry ? readRecord(entry.period) : null))
    .map((period) => (period ? readUnixSeconds(period, "end") : null))
    .filter((value): value is string => value !== null)
    .sort();
  return ends.at(-1) ?? null;
}

function readMetadataUid(object: Record<string, unknown>): string | null {
  const metadata = readRecord(object.metadata);
  return metadata ? readString(metadata, "firebase_uid") : null;
}

function readString(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(object: Record<string, unknown>, key: string): boolean | null {
  const value = object[key];
  return typeof value === "boolean" ? value : null;
}

function readUnixSeconds(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

/** Stripe sends a related object either as its id or expanded inline. */
function readReferenceId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  const record = readRecord(value);
  return record ? readString(record, "id") : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Narrow an untrusted JSON body to the envelope fields the handler needs. */
export function parseStripeEventEnvelope(value: unknown): StripeEventEnvelope | null {
  const record = readRecord(value);
  if (!record) return null;
  const id = readString(record, "id");
  const type = readString(record, "type");
  const created = record.created;
  const data = readRecord(record.data);
  const object = data ? readRecord(data.object) : null;
  if (!id || !type || typeof created !== "number" || !object) return null;
  return { id, type, created, data: { object } };
}
