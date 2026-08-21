/**
 * `createCheckoutSession` — the web channel's only purchase entry point.
 *
 * Every refusal here is prevention rather than cleanup
 * (`docs/specs/accounts-and-billing.md`, Decisions 1, 3 and 4): an unverified
 * account cannot activate an entitlement, a comped account must never be
 * allowed to pay, and an App-Store-sourced subscriber must be sent to Apple's
 * settings instead of into a second, parallel subscription.
 */
import type { Firestore } from "firebase-admin/firestore";
import { resolveCheckoutConfig } from "./config.js";
import { readBillingState } from "./entitlement.js";
import { BillingRequestError } from "./errors.js";
import { consoleBillingLogger, type BillingLogger } from "./logger.js";
import type { StripeCheckoutGateway, StripePriceCurrency } from "./stripeGateway.js";
import {
  accountDeletionPath,
  stripeCustomerPath,
  userDocPath,
  type BilledSourceState,
} from "./types.js";

export type CheckoutPlan = "monthly";

export interface CreateCheckoutSessionRequest {
  plan?: unknown;
  currency?: unknown;
}

export interface CheckoutCaller {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

export interface CreateCheckoutSessionResult {
  sessionId: string;
  url: string | null;
  customerId: string;
  plan: CheckoutPlan;
  currency: StripePriceCurrency;
}

export interface CreateCheckoutSessionDependencies {
  db: Firestore;
  env: NodeJS.ProcessEnv;
  /** Defaults to the live Stripe client built from the configured secret key. */
  gateway?: StripeCheckoutGateway;
  logger?: BillingLogger;
  now?: () => string;
}

function isBlockingStatus(state: BilledSourceState | null): boolean {
  return state !== null && (state.status === "active" || state.status === "grace");
}

function parsePlan(value: unknown): CheckoutPlan {
  if (value === "monthly") return value;
  throw new BillingRequestError(
    "invalid-argument",
    "unknown_plan",
    `Unknown plan: ${String(value)}. Expected "monthly".`
  );
}

const SUPPORTED_CURRENCIES = new Set<StripePriceCurrency>([
  "jpy", "usd", "cad", "aud", "eur", "gbp",
]);

function parseCurrency(value: unknown): StripePriceCurrency {
  const currency = value === undefined ? "usd" : String(value).toLowerCase();
  if (SUPPORTED_CURRENCIES.has(currency as StripePriceCurrency)) {
    return currency as StripePriceCurrency;
  }
  throw new BillingRequestError(
    "invalid-argument",
    "unknown_currency",
    `Unknown currency: ${String(value)}.`
  );
}

export async function createCheckoutSession(
  request: CreateCheckoutSessionRequest,
  caller: CheckoutCaller | null,
  deps: CreateCheckoutSessionDependencies
): Promise<CreateCheckoutSessionResult> {
  const logger = deps.logger ?? consoleBillingLogger;
  const now = deps.now ?? (() => new Date().toISOString());

  if (!caller) {
    throw new BillingRequestError(
      "unauthenticated",
      "sign_in_required",
      "Sign in before starting a subscription."
    );
  }
  const deletion = await deps.db.doc(accountDeletionPath(caller.uid)).get();
  if (deletion.exists) {
    throw new BillingRequestError(
      "failed-precondition",
      "account_deleted",
      "This account has been permanently deleted.",
    );
  }
  if (!caller.emailVerified) {
    throw new BillingRequestError(
      "failed-precondition",
      "email_verification_required",
      "Verify your email address before subscribing."
    );
  }

  const plan = parsePlan(request.plan);
  const currency = parseCurrency(request.currency);

  let config: ReturnType<typeof resolveCheckoutConfig>;
  try {
    config = resolveCheckoutConfig(deps.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("createCheckoutSession is not configured", { message });
    throw new BillingRequestError("internal", "not_configured", message);
  }

  const state = await readBillingState(deps.db, caller.uid);

  if (state.sources.comp?.active) {
    throw new BillingRequestError(
      "failed-precondition",
      "comp_active",
      "This account has complimentary Kanna Cloud access and does not need a subscription."
    );
  }
  if (isBlockingStatus(state.sources.app_store)) {
    throw new BillingRequestError(
      "failed-precondition",
      "app_store_active",
      "This account is subscribed through the App Store. Manage it in Apple's subscription settings."
    );
  }
  if (isBlockingStatus(state.sources.stripe)) {
    throw new BillingRequestError(
      "failed-precondition",
      "already_subscribed",
      "This account already has an active Kanna Cloud subscription."
    );
  }

  const gateway = deps.gateway ?? (await liveGateway(config.secretKey));
  const customerId = await resolveCustomerId({
    db: deps.db,
    gateway,
    caller,
    existing: state.sources.stripe?.stripeCustomerId ?? null,
    now: now(),
  });

  const base = config.portalBaseUrl.replace(/\/+$/, "");

  let session: Awaited<ReturnType<StripeCheckoutGateway["createCheckoutSession"]>>;
  try {
    const lookupKey = `cloud_monthly_${currency}`;
    const priceId = await gateway.resolvePriceId(lookupKey);
    if (!priceId) {
      throw new Error(`No active Stripe price has lookup_key ${lookupKey}`);
    }
    session = await gateway.createCheckoutSession({
      uid: caller.uid,
      customerId,
      priceId,
      successUrl: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/billing/canceled`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Stripe rejected a checkout session request", { uid: caller.uid, message });
    throw new BillingRequestError(
      "internal",
      "stripe_error",
      "Could not start checkout. Please try again."
    );
  }

  logger.info("Created a Stripe checkout session", {
    uid: caller.uid,
    plan,
    currency,
    sessionId: session.id,
  });
  return { sessionId: session.id, url: session.url, customerId, plan, currency };
}

/**
 * Reuse the account's Stripe customer, or create one stamped with its uid.
 *
 * The customer id is recorded on `users/{uid}` and in the `stripeCustomers`
 * reverse map — not in `billing/stripe`, because merely opening checkout is not
 * a billing state and must not cause an entitlement record to be written.
 */
async function resolveCustomerId(input: {
  db: Firestore;
  gateway: StripeCheckoutGateway;
  caller: CheckoutCaller;
  existing: string | null;
  now: string;
}): Promise<string> {
  const { db, gateway, caller, now } = input;
  if (input.existing) return input.existing;

  const userDoc = await db.doc(userDocPath(caller.uid)).get();
  const stored = (userDoc.data() as { stripeCustomerId?: unknown } | undefined)?.stripeCustomerId;
  if (typeof stored === "string" && stored.length > 0) return stored;

  const customer = await gateway.createCustomer({ uid: caller.uid, email: caller.email });
  await db
    .doc(userDocPath(caller.uid))
    .set({ stripeCustomerId: customer.id, updatedAt: now }, { merge: true });
  await db
    .doc(stripeCustomerPath(customer.id))
    .set({ uid: caller.uid, stripeCustomerId: customer.id, updatedAt: now }, { merge: true });
  return customer.id;
}

/** Imported lazily so a missing Stripe key never breaks module load or deploy. */
async function liveGateway(secretKey: string): Promise<StripeCheckoutGateway> {
  const { stripeCheckoutGateway } = await import("./stripeGateway.js");
  return stripeCheckoutGateway(secretKey);
}
