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
  };
}
