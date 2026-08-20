/**
 * Stripe webhook signature verification.
 *
 * Verification needs the endpoint's webhook signing secret and nothing else, so
 * this builds a client whose only job is `webhooks.constructEvent` — no API key
 * is required or used, and no request ever leaves the process. Stripe's own
 * implementation is used rather than a hand-rolled HMAC compare because it also
 * enforces the replay-tolerance window.
 */
import Stripe from "stripe";

/**
 * Placeholder credential for the verification-only client. Stripe's constructor
 * requires a key string; nothing in this module performs an API call.
 */
const VERIFY_ONLY_API_KEY = "sk_verification_only";

let verifier: Stripe | null = null;

function verificationClient(): Stripe {
  verifier ??= new Stripe(VERIFY_ONLY_API_KEY);
  return verifier;
}

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSignatureError";
  }
}

/**
 * Verify `stripe-signature` against the raw request body.
 *
 * The body must be the exact bytes Stripe sent — a re-serialized JSON object
 * will not match.
 */
export function verifyStripeSignature(input: {
  rawBody: Buffer | string;
  signature: string | undefined;
  webhookSecret: string;
}): unknown {
  if (!input.signature) {
    throw new StripeSignatureError("Missing stripe-signature header");
  }
  try {
    return verificationClient().webhooks.constructEvent(
      input.rawBody,
      input.signature,
      input.webhookSecret
    );
  } catch (error) {
    throw new StripeSignatureError(
      error instanceof Error ? error.message : "Stripe signature verification failed"
    );
  }
}

/** Sign a payload the way Stripe would, for fixture-driven tests. */
export function signStripePayload(payload: string, webhookSecret: string, timestamp?: number): string {
  return verificationClient().webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}
