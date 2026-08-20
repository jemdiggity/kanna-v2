/**
 * Kanna Firebase Functions entry point.
 *
 * Function deployment is deliberate, not incidental. Until Slice 1 of
 * `docs/specs/accounts-and-billing.md` this module exported nothing at all so
 * that `firebase deploy --only functions` could not resurrect retired
 * endpoints; the same posture holds now that billing lives here. Only the
 * billing surface below is exported, the retired `createPairingCode` bootstrap
 * stays deleted and unexported, and deploys go through
 * `./kd cloud deploy --functions` rather than bare `firebase deploy`.
 *
 * Stripe credentials are read from the environment at call time — Secret
 * Manager in staging and production, process env under the emulator. Nothing
 * secret is committed, and a missing key surfaces as a clear error on the
 * request that needs it rather than as a module-load crash that would take the
 * whole deploy down.
 */
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import * as functionsLogger from "firebase-functions/logger";
import { createCheckoutSession as createCheckoutSessionCore } from "./billing/checkout.js";
import { BillingRequestError } from "./billing/errors.js";
import type { BillingLogger } from "./billing/logger.js";
import { handleStripeWebhook } from "./billing/stripeWebhook.js";

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const logger: BillingLogger = {
  info: (message, context) => functionsLogger.info(message, context ?? {}),
  warn: (message, context) => functionsLogger.warn(message, context ?? {}),
  error: (message, context) => functionsLogger.error(message, context ?? {}),
};

function db(): Firestore {
  if (getApps().length === 0) {
    initializeApp();
  }
  return getFirestore();
}

/**
 * Start a Stripe Checkout session for the signed-in, email-verified caller.
 *
 * Refuses with a distinct `reason` when the account holds complimentary access
 * or an active App Store subscription, so the portal can render the right
 * explanation instead of a generic failure.
 */
export const createCheckoutSession = onCall(async (request) => {
  try {
    return await createCheckoutSessionCore(
      { plan: (request.data as { plan?: unknown } | undefined)?.plan },
      request.auth
        ? {
            uid: request.auth.uid,
            email: typeof request.auth.token.email === "string" ? request.auth.token.email : null,
            emailVerified: request.auth.token.email_verified === true,
          }
        : null,
      { db: db(), env: process.env, logger }
    );
  } catch (error) {
    if (error instanceof BillingRequestError) {
      throw new HttpsError(error.code, error.message, { reason: error.reason });
    }
    throw error;
  }
});

/**
 * Stripe's webhook endpoint: the only writer of `users/{uid}/billing/stripe`.
 *
 * Signature verification runs against `rawBody` — the exact bytes Stripe sent,
 * which a re-serialized body would not match.
 */
export const stripeWebhook = onRequest(async (request, response) => {
  const outcome = await handleStripeWebhook(
    {
      rawBody: request.rawBody,
      signature: request.header("stripe-signature"),
    },
    { db: db(), env: process.env, logger }
  );
  response.status(outcome.httpStatus).json({
    code: outcome.code,
    ...(outcome.message ? { message: outcome.message } : {}),
  });
});
