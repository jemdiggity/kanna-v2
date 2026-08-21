/**
 * The narrow slice of the Stripe API the billing backend calls.
 *
 * Kept behind an interface so the emulator tests exercise the real
 * `createCheckoutSession` logic — its guards, its customer reuse, the metadata
 * it stamps — without making live Stripe calls in CI.
 */
import Stripe from "stripe";

export interface StripeCustomerInput {
  uid: string;
  email: string | null;
}

export interface StripeCheckoutSessionInput {
  uid: string;
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export type StripePriceCurrency = "jpy" | "usd" | "cad" | "aud" | "eur" | "gbp";

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

export interface StripeCheckoutGateway {
  createCustomer(input: StripeCustomerInput): Promise<{ id: string }>;
  resolvePriceId(lookupKey: string): Promise<string | null>;
  createCheckoutSession(input: StripeCheckoutSessionInput): Promise<StripeCheckoutSession>;
  closeCheckoutSession(sessionId: string): Promise<void>;
}

export interface StripeSubscriptionGateway {
  cancelSubscription(subscriptionId: string): Promise<void>;
  closeCheckoutSession(sessionId: string): Promise<void>;
  closeCustomerBilling(customerId: string): Promise<void>;
}

/**
 * The live gateway.
 *
 * `client_reference_id` and `subscription_data.metadata.firebase_uid` are what
 * make every later webhook resolvable to an account without a lookup race: the
 * subscription events carry the uid themselves rather than depending on the
 * checkout event having landed first.
 */
export function stripeCheckoutGateway(secretKey: string): StripeCheckoutGateway {
  const stripe = new Stripe(secretKey);
  return {
    async createCustomer(input) {
      const customer = await stripe.customers.create({
        ...(input.email ? { email: input.email } : {}),
        metadata: { firebase_uid: input.uid },
      });
      return { id: customer.id };
    },
    async resolvePriceId(lookupKey) {
      const prices = await stripe.prices.list({ active: true, lookup_keys: [lookupKey], limit: 1 });
      return prices.data[0]?.id ?? null;
    },
    async createCheckoutSession(input) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: input.customerId,
        client_reference_id: input.uid,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        subscription_data: { metadata: { firebase_uid: input.uid } },
        metadata: { firebase_uid: input.uid },
      });
      return { id: session.id, url: session.url };
    },
    async closeCheckoutSession(sessionId) {
      await closeStripeCheckoutSession(stripe, sessionId);
    },
  };
}

async function cancelStripeSubscription(stripe: Stripe, subscriptionId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError
      && error.code === "resource_missing") {
      return;
    }
    throw error;
  }
}

/** Live cancel-at-once gateway used by account deletion. */
export function stripeSubscriptionGateway(secretKey: string): StripeSubscriptionGateway {
  const stripe = new Stripe(secretKey);
  return {
    async cancelSubscription(subscriptionId) {
      await cancelStripeSubscription(stripe, subscriptionId);
    },
    async closeCheckoutSession(sessionId) {
      await closeStripeCheckoutSession(stripe, sessionId);
    },
    async closeCustomerBilling(customerId) {
      const sessions = stripe.checkout.sessions.list({
        customer: customerId,
        status: "open",
        limit: 100,
      });
      for await (const session of sessions) {
        await closeStripeCheckoutSession(stripe, session.id);
      }
      for await (const subscription of stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      })) {
        if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") {
          await cancelStripeSubscription(stripe, subscription.id);
        }
      }
    },
  };
}

async function closeStripeCheckoutSession(stripe: Stripe, sessionId: string): Promise<void> {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "open") {
      await stripe.checkout.sessions.expire(sessionId);
      return;
    }
    const subscriptionId = typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
    if (subscriptionId) {
      await cancelStripeSubscription(stripe, subscriptionId);
    }
  } catch (error) {
    // Closing an already-closed or removed session is idempotent. A completed
    // session is handled above by canceling the subscription it created.
    if (error instanceof Stripe.errors.StripeInvalidRequestError
      && error.code === "resource_missing") {
      return;
    }
    throw error;
  }
}
