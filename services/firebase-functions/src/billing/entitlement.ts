/**
 * The entitlement reducer — the only writer of
 * `users/{uid}/entitlements/cloud_access`.
 *
 * Source-blind writers racing on one entitlement doc is how a canceled Stripe
 * subscription erases a live Apple one, so every source writes its own
 * source-state doc and this reducer derives the single record from all of them
 * in one transaction (`docs/specs/accounts-and-billing.md`, Decisions 3 and 4).
 *
 * The reducer is source-complete from day one: it already honors an
 * `app_store` source doc even though nothing writes one until Slice 2.
 * Retrofitting it after Apple ships is the expensive order.
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";
import {
  CLOUD_ACCESS_CAPABILITIES,
  billingSourcePath,
  entitlementPath,
  type BilledSourceId,
  type BilledSourceState,
  type BillingEnvironment,
  type BillingSourceSnapshot,
  type CompSourceState,
  type EntitlementRecord,
  type EntitlementStatus,
} from "./types.js";

/** Fixed order so a tie the other rules cannot break still resolves the same way. */
const BILLED_SOURCE_ORDER: readonly BilledSourceId[] = ["stripe", "app_store"];

const STATUS_RANK: Record<EntitlementStatus, number> = {
  active: 3,
  grace: 2,
  expired: 1,
  revoked: 0,
};

function isHonoredStatus(status: EntitlementStatus): boolean {
  return status === "active" || status === "grace";
}

function periodRank(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export interface ReduceEntitlementInput {
  sources: BillingSourceSnapshot;
  /** The record currently stored, used only to keep the honored source stable. */
  previous: EntitlementRecord | null;
  now: string;
  /** Stamped when no source names one (comp carries no environment). */
  defaultEnvironment: BillingEnvironment;
}

/**
 * Derive the entitlement record from every source state.
 *
 * Returns null when there is nothing to say at all — no source doc and no
 * previously written record.
 */
export function reduceEntitlement(input: ReduceEntitlementInput): EntitlementRecord | null {
  const { sources, previous, now, defaultEnvironment } = input;
  const billed = BILLED_SOURCE_ORDER.map((id) => sources[id]).filter(
    (state): state is BilledSourceState => state !== null
  );

  const stripeCustomerId = sources.stripe?.stripeCustomerId ?? null;
  const stripeSubscriptionId = sources.stripe?.stripeSubscriptionId ?? null;
  const appStoreOriginalTransactionId = sources.app_store?.appStoreOriginalTransactionId ?? null;

  // Comp takes absolute precedence: while active it never bills, never duns and
  // never expires, and a comp beside a paid subscription is a gift rather than a
  // double-pay, so it raises no `duplicateSources` flag.
  if (isCompActive(sources.comp)) {
    return {
      status: "active",
      source: "comp",
      capabilities: [...CLOUD_ACCESS_CAPABILITIES],
      currentPeriodEndsAt: null,
      graceEndsAt: null,
      stripeCustomerId,
      stripeSubscriptionId,
      appStoreOriginalTransactionId,
      duplicateSources: false,
      environment: defaultEnvironment,
      updatedAt: now,
    };
  }

  if (billed.length === 0) {
    if (!previous) return null;
    // Every source doc is gone; say so rather than leaving a stale grant.
    return {
      ...previous,
      status: "expired",
      capabilities: [],
      currentPeriodEndsAt: null,
      graceEndsAt: null,
      stripeCustomerId,
      stripeSubscriptionId,
      appStoreOriginalTransactionId,
      duplicateSources: false,
      updatedAt: now,
    };
  }

  // The entitlement takes the best status any source holds; a revoked source
  // contributes nothing but never suppresses the other one.
  const bestRank = Math.max(...billed.map((state) => STATUS_RANK[state.status]));
  const candidates = billed.filter((state) => STATUS_RANK[state.status] === bestRank);
  const honored = pickHonoredSource(candidates, previous);

  const duplicateSources =
    billed.length > 1 && billed.every((state) => isHonoredStatus(state.status));

  return {
    status: honored.status,
    source: honored.source,
    capabilities: isHonoredStatus(honored.status) ? [...CLOUD_ACCESS_CAPABILITIES] : [],
    currentPeriodEndsAt: honored.currentPeriodEndsAt,
    graceEndsAt: honored.graceEndsAt,
    stripeCustomerId,
    stripeSubscriptionId,
    appStoreOriginalTransactionId,
    duplicateSources,
    environment: honored.environment,
    updatedAt: now,
  };
}

function isCompActive(comp: CompSourceState | null): boolean {
  return comp !== null && comp.active === true;
}

/**
 * Tie-break between sources holding the same status: later period end first,
 * then whichever source was honored last time (stable, no flapping), then the
 * fixed source order so repeated runs agree.
 */
function pickHonoredSource(
  candidates: BilledSourceState[],
  previous: EntitlementRecord | null
): BilledSourceState {
  const sorted = [...candidates].sort((left, right) => {
    const byPeriod = periodRank(right.currentPeriodEndsAt) - periodRank(left.currentPeriodEndsAt);
    if (byPeriod !== 0) return byPeriod;

    const leftWasHonored = previous?.source === left.source;
    const rightWasHonored = previous?.source === right.source;
    if (leftWasHonored !== rightWasHonored) return leftWasHonored ? -1 : 1;

    return BILLED_SOURCE_ORDER.indexOf(left.source) - BILLED_SOURCE_ORDER.indexOf(right.source);
  });
  const [honored] = sorted;
  if (!honored) {
    throw new Error("pickHonoredSource requires at least one candidate source");
  }
  return honored;
}

/**
 * True when the two records differ in anything but their `updatedAt` stamp.
 *
 * Compared field by field rather than by serializing whole objects: `previous`
 * comes back from Firestore, whose field order need not match the order the
 * reducer builds, and an order-sensitive compare would report every replay as a
 * change.
 */
export function entitlementChanged(
  previous: EntitlementRecord | null,
  next: EntitlementRecord
): boolean {
  if (!previous) return true;
  return (
    previous.status !== next.status ||
    previous.source !== next.source ||
    previous.currentPeriodEndsAt !== next.currentPeriodEndsAt ||
    previous.graceEndsAt !== next.graceEndsAt ||
    previous.stripeCustomerId !== next.stripeCustomerId ||
    previous.stripeSubscriptionId !== next.stripeSubscriptionId ||
    previous.appStoreOriginalTransactionId !== next.appStoreOriginalTransactionId ||
    previous.duplicateSources !== next.duplicateSources ||
    previous.environment !== next.environment ||
    previous.capabilities.length !== next.capabilities.length ||
    previous.capabilities.some((capability, index) => capability !== next.capabilities[index])
  );
}

export interface BillingState {
  sources: BillingSourceSnapshot;
  previous: EntitlementRecord | null;
}

/** Anything that can batch-read documents: the Firestore root or a transaction. */
interface DocumentReader {
  getAll(...refs: DocumentReference[]): Promise<DocumentSnapshot[]>;
}

/**
 * Read every billing source doc plus the stored entitlement for `uid`.
 *
 * Firestore transactions require all reads before any write, so a caller that
 * also writes a source doc must call this first and overlay its pending state
 * onto the returned snapshot rather than re-reading afterwards.
 */
export async function readBillingState(
  db: Firestore,
  uid: string,
  /** Defaults to the Firestore root; pass a transaction to read inside one. */
  reader: DocumentReader = db
): Promise<BillingState> {
  const [stripeDoc, appStoreDoc, compDoc, entitlementDoc] = await reader.getAll(
    db.doc(billingSourcePath(uid, "stripe")),
    db.doc(billingSourcePath(uid, "app_store")),
    db.doc(billingSourcePath(uid, "comp")),
    db.doc(entitlementPath(uid))
  );
  return {
    sources: {
      stripe: (stripeDoc?.data() as BilledSourceState | undefined) ?? null,
      app_store: (appStoreDoc?.data() as BilledSourceState | undefined) ?? null,
      comp: (compDoc?.data() as CompSourceState | undefined) ?? null,
    },
    previous: (entitlementDoc?.data() as EntitlementRecord | undefined) ?? null,
  };
}

export interface ApplyEntitlementOptions extends BillingState {
  db: Firestore;
  uid: string;
  now: string;
  defaultEnvironment: BillingEnvironment;
  transaction: Transaction;
}

export interface EntitlementWriteResult {
  entitlement: EntitlementRecord | null;
  /** False when the derived record matched the stored one apart from `updatedAt`. */
  written: boolean;
}

/**
 * Derive the entitlement from an already-read billing state and stage the write.
 *
 * `updatedAt` is a last-*changed* stamp: an unchanged record is not rewritten,
 * so a replay that produces the same state leaves no trace on the doc.
 */
export function applyEntitlement(options: ApplyEntitlementOptions): EntitlementWriteResult {
  const { db, uid, sources, previous, now, defaultEnvironment, transaction } = options;
  const entitlement = reduceEntitlement({ sources, previous, now, defaultEnvironment });

  if (!entitlement) {
    return { entitlement: null, written: false };
  }
  if (!entitlementChanged(previous, entitlement)) {
    return { entitlement: previous, written: false };
  }
  transaction.set(db.doc(entitlementPath(uid)), entitlement);
  return { entitlement, written: true };
}

export interface RecomputeEntitlementOptions {
  db: Firestore;
  uid: string;
  now?: string;
  defaultEnvironment: BillingEnvironment;
}

/**
 * Read every source doc for `uid` and rewrite the entitlement record from them.
 *
 * This is the standalone entry point — the comp admin path and tests — for
 * callers that are not already inside a transaction of their own.
 */
export async function recomputeEntitlement(
  options: RecomputeEntitlementOptions
): Promise<EntitlementWriteResult> {
  const { db, uid, defaultEnvironment } = options;
  const now = options.now ?? new Date().toISOString();
  return db.runTransaction(async (transaction) => {
    const state = await readBillingState(db, uid, transaction);
    return applyEntitlement({ db, uid, now, defaultEnvironment, transaction, ...state });
  });
}
