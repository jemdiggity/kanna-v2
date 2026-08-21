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
 * Stripe configuration is read from the environment at call time. Credentials
 * are bound to each function from GCP Secret Manager by the `secrets`
 * declarations below; public parameters come from committed per-project `.env`
 * files and are declared with the Firebase Functions parameter API.
 *
 * Declaring them also decides how a missing credential fails. `firebase deploy`
 * refuses to deploy a function whose declared secret does not exist in the
 * target project, naming it — so before Slice 0 creates them, the deploy fails
 * loudly instead of publishing a billing backend that answers every Stripe
 * delivery with a 500 until Stripe disables the endpoint.
 *
 * Nothing secret is committed. Bindings are per function rather than global so
 * each carries only what it uses: the webhook never sees the Stripe API key,
 * and checkout never sees the webhook signing secret. The declarations live
 * beside the variables they name in `billing/config.ts`, so this module's own
 * exports stay exactly the functions it deploys.
 */
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import * as functionsLogger from "firebase-functions/logger";
import { createCheckoutSession as createCheckoutSessionCore } from "./billing/checkout.js";
import {
  CHECKOUT_SECRET_ENVS,
  DELETE_ACCOUNT_SECRET_ENVS,
  STRIPE_WEBHOOK_SECRET_ENVS,
} from "./billing/config.js";
import { BillingRequestError } from "./billing/errors.js";
import type { BillingLogger } from "./billing/logger.js";
import { handleStripeWebhook } from "./billing/stripeWebhook.js";
import { accountDeletionDependencies, deleteAccount as deleteAccountCore } from "./accountDeletion.js";

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
export const createCheckoutSession = onCall(
  { secrets: [...CHECKOUT_SECRET_ENVS] },
  async (request) => {
    try {
      return await createCheckoutSessionCore(
        {
          plan: (request.data as { plan?: unknown } | undefined)?.plan,
          currency: (request.data as { currency?: unknown } | undefined)?.currency,
        },
        request.auth
          ? {
              uid: request.auth.uid,
              email:
                typeof request.auth.token.email === "string" ? request.auth.token.email : null,
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
  }
);

/** Permanently delete the signed-in caller's cloud account and Auth identity. */
export const deleteAccount = onCall(
  { secrets: [...DELETE_ACCOUNT_SECRET_ENVS] },
  async (request) => {
    try {
      return await deleteAccountCore(
        request.auth ? { uid: request.auth.uid } : null,
        accountDeletionDependencies(db(), getAuth(), process.env),
      );
    } catch (error) {
      if (error instanceof BillingRequestError) {
        throw new HttpsError(error.code, error.message, { reason: error.reason });
      }
      throw error;
    }
  },
);

/**
 * Stripe's webhook endpoint: the only writer of `users/{uid}/billing/stripe`.
 *
 * Signature verification runs against `rawBody` — the exact bytes Stripe sent,
 * which a re-serialized body would not match.
 */
export const stripeWebhook = onRequest(
  { secrets: [...STRIPE_WEBHOOK_SECRET_ENVS] },
  async (request, response) => {
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
  }
);
