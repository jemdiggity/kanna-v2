/**
 * Billing fixtures for the emulator.
 *
 * One source of truth for two consumers: the reducer/rules test matrix, and
 * `scripts/seed-billing-fixtures.mjs`, which writes the same accounts into a
 * running emulator so the portal and the relay can be developed against real
 * entitlement states. Every entitlement doc the seeder writes is produced by
 * the reducer itself, so a fixture can never drift from the rules that derive it.
 *
 * `expected` is the matrix: what the reducer must derive for that account.
 */
import {
  type BilledSourceState,
  type BillingEnvironment,
  type BillingSourceSnapshot,
  type CompSourceState,
  type EntitlementSource,
  type EntitlementStatus,
} from "./types.js";

export const FIXTURE_ENVIRONMENT: BillingEnvironment = "staging";

/** Fixed instants so fixtures are byte-stable across runs. */
const NOW = "2026-08-20T00:00:00.000Z";
const PERIOD_END_SOON = "2026-09-20T00:00:00.000Z";
const PERIOD_END_LATER = "2026-11-20T00:00:00.000Z";
const GRACE_END = "2026-09-27T00:00:00.000Z";

export function stripeSource(overrides: Partial<BilledSourceState> = {}): BilledSourceState {
  return {
    source: "stripe",
    status: "active",
    currentPeriodEndsAt: PERIOD_END_SOON,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    environment: FIXTURE_ENVIRONMENT,
    stripeCustomerId: "cus_fixture",
    stripeSubscriptionId: "sub_fixture",
    appStoreOriginalTransactionId: null,
    lastEventAt: NOW,
    lastEventId: "evt_fixture",
    updatedAt: NOW,
    ...overrides,
  };
}

export function appStoreSource(overrides: Partial<BilledSourceState> = {}): BilledSourceState {
  return {
    source: "app_store",
    status: "active",
    currentPeriodEndsAt: PERIOD_END_SOON,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    environment: FIXTURE_ENVIRONMENT,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    appStoreOriginalTransactionId: "2000000000000001",
    lastEventAt: NOW,
    lastEventId: "apple-notification-fixture",
    updatedAt: NOW,
    ...overrides,
  };
}

export function compSource(overrides: Partial<CompSourceState> = {}): CompSourceState {
  return {
    source: "comp",
    active: true,
    reason: "owner account",
    grantedBy: "operator",
    grantedAt: NOW,
    revokedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

export interface ExpectedEntitlement {
  status: EntitlementStatus;
  source: EntitlementSource;
  duplicateSources: boolean;
  currentPeriodEndsAt: string | null;
  graceEndsAt: string | null;
  entitled: boolean;
}

export interface BillingFixtureAccount {
  uid: string;
  email: string;
  emailVerified: boolean;
  /** Why this account exists in the matrix. */
  description: string;
  sources: Partial<BillingSourceSnapshot>;
  /** Null when the reducer must write no entitlement record at all. */
  expected: ExpectedEntitlement | null;
}

function expected(
  status: EntitlementStatus,
  source: EntitlementSource,
  overrides: Partial<ExpectedEntitlement> = {}
): ExpectedEntitlement {
  return {
    status,
    source,
    duplicateSources: false,
    currentPeriodEndsAt: null,
    graceEndsAt: null,
    entitled: status === "active" || status === "grace",
    ...overrides,
  };
}

export const billingFixtureAccounts: readonly BillingFixtureAccount[] = [
  {
    uid: "fixture-stripe-active",
    email: "stripe-active@example.com",
    emailVerified: true,
    description: "Paying web subscriber in good standing.",
    sources: { stripe: stripeSource() },
    expected: expected("active", "stripe", { currentPeriodEndsAt: PERIOD_END_SOON }),
  },
  {
    uid: "fixture-stripe-grace",
    email: "stripe-grace@example.com",
    emailVerified: true,
    description: "Stripe dunning: past_due inside the Smart Retries window.",
    sources: { stripe: stripeSource({ status: "grace", graceEndsAt: GRACE_END }) },
    expected: expected("grace", "stripe", {
      currentPeriodEndsAt: PERIOD_END_SOON,
      graceEndsAt: GRACE_END,
    }),
  },
  {
    uid: "fixture-stripe-expired",
    email: "stripe-expired@example.com",
    emailVerified: true,
    description: "Canceled subscription past its period end.",
    sources: { stripe: stripeSource({ status: "expired" }) },
    expected: expected("expired", "stripe", { currentPeriodEndsAt: PERIOD_END_SOON }),
  },
  {
    uid: "fixture-app-store-active",
    email: "app-store-active@example.com",
    emailVerified: true,
    description:
      "Apple-sourced subscriber. No writer creates this doc until Slice 2; it exists so the reducer is source-complete today.",
    sources: { app_store: appStoreSource() },
    expected: expected("active", "app_store", { currentPeriodEndsAt: PERIOD_END_SOON }),
  },
  {
    uid: "fixture-comp-only",
    email: "comp-only@example.com",
    emailVerified: true,
    description: "Complimentary access with no billing relationship (the owner's own accounts).",
    sources: { comp: compSource() },
    expected: expected("active", "comp"),
  },
  {
    uid: "fixture-comp-over-stripe",
    email: "comp-over-stripe@example.com",
    emailVerified: true,
    description: "Comped while also paying: comp wins, and a gift is not a double-pay.",
    sources: { comp: compSource(), stripe: stripeSource() },
    expected: expected("active", "comp"),
  },
  {
    uid: "fixture-comp-revoked",
    email: "comp-revoked@example.com",
    emailVerified: true,
    description: "Comp revoked with a live Stripe subscription: falls back to the paid source.",
    sources: {
      comp: compSource({ active: false, revokedAt: NOW }),
      stripe: stripeSource(),
    },
    expected: expected("active", "stripe", { currentPeriodEndsAt: PERIOD_END_SOON }),
  },
  {
    uid: "fixture-duplicate-sources",
    email: "duplicate-sources@example.com",
    emailVerified: true,
    description: "Both billed sources active: honored source is the later period end, flag raised.",
    sources: {
      stripe: stripeSource(),
      app_store: appStoreSource({ currentPeriodEndsAt: PERIOD_END_LATER }),
    },
    expected: expected("active", "app_store", {
      currentPeriodEndsAt: PERIOD_END_LATER,
      duplicateSources: true,
    }),
  },
  {
    uid: "fixture-revoked-beside-active",
    email: "revoked-beside-active@example.com",
    emailVerified: true,
    description: "A refunded Apple transaction must not suppress a live Stripe subscription.",
    sources: {
      stripe: stripeSource(),
      app_store: appStoreSource({ status: "revoked" }),
    },
    expected: expected("active", "stripe", { currentPeriodEndsAt: PERIOD_END_SOON }),
  },
  {
    uid: "fixture-unverified",
    email: "unverified@example.com",
    emailVerified: false,
    description: "Signed up but never verified: checkout must refuse before Stripe is called.",
    sources: {},
    expected: null,
  },
  {
    uid: "fixture-unsubscribed",
    email: "unsubscribed@example.com",
    emailVerified: true,
    description: "Verified and unentitled: the account that can start a checkout session.",
    sources: {},
    expected: null,
  },
] as const;

export function billingFixtureAccount(uid: string): BillingFixtureAccount {
  const account = billingFixtureAccounts.find((candidate) => candidate.uid === uid);
  if (!account) {
    throw new Error(`Unknown billing fixture account: ${uid}`);
  }
  return account;
}

/** Fill the absent sources so a fixture can be handed straight to the reducer. */
export function fixtureSourceSnapshot(account: BillingFixtureAccount): BillingSourceSnapshot {
  return {
    stripe: account.sources.stripe ?? null,
    app_store: account.sources.app_store ?? null,
    comp: account.sources.comp ?? null,
  };
}
