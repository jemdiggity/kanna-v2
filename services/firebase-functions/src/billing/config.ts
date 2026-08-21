/**
 * Runtime configuration for the billing backend.
 *
 * Billing configuration arrives through the environment: credentials from GCP
 * Secret Manager, public parameters from committed Firebase `.env` files, and
 * emulator/test overrides from the process environment. Resolution is
 * deliberately lazy — a missing value must surface as a clear error on the
 * request that needs it, not as a crash at module load that takes the whole
 * deploy down.
 */
import { defineString } from "firebase-functions/params";
import type { BillingEnvironment } from "./types.js";

export const STRIPE_SECRET_KEY_ENV = "STRIPE_SECRET_KEY";
export const STRIPE_WEBHOOK_SECRET_ENV = "STRIPE_WEBHOOK_SECRET";
export const PORTAL_BASE_URL_ENV = "KANNA_PORTAL_BASE_URL";

/** Public Checkout return origin, resolved by Firebase from the project `.env`. */
export const PORTAL_BASE_URL_PARAM = defineString(PORTAL_BASE_URL_ENV, {
  description: "Public account portal origin used for Stripe Checkout return URLs",
  input: {
    text: {
      example: "https://kanna-build-account.web.app",
      validationRegex: "^https?://.+",
      validationErrorMessage: "Enter an absolute http(s) URL.",
      nonEmpty: true,
    },
  },
});

/**
 * How long past the current period a Stripe dunning failure keeps the account
 * in `grace` when the failing invoice names no next retry.
 *
 * Stripe exposes no "Smart Retries end" field. The concrete signal is the
 * failing invoice's `next_payment_attempt`, used when present; this window is
 * the fallback, and the authoritative end of grace is Stripe flipping the
 * subscription to `canceled`/`unpaid`, which maps to `expired`.
 */
export const STRIPE_GRACE_FALLBACK_DAYS_ENV = "STRIPE_GRACE_FALLBACK_DAYS";
const DEFAULT_STRIPE_GRACE_FALLBACK_DAYS = 14;

/**
 * Secret Manager entries each function must declare so its credentials reach
 * `process.env` at runtime.
 *
 * A deployed 2nd-gen function's environment is populated only from declared
 * secrets and committed `.env` files. `src/index.ts` binds these per function,
 * while the public portal URL is declared separately as a Firebase string
 * parameter above. `test/function-secrets.test.ts` pins both channels.
 *
 * `STRIPE_GRACE_FALLBACK_DAYS` is deliberately absent: it is optional and has a
 * documented default. Adding it to a list is what would make it overridable in
 * a deployed environment.
 */
export const CHECKOUT_SECRET_ENVS = [STRIPE_SECRET_KEY_ENV] as const;

/** Account deletion calls Stripe only to cancel an existing subscription. */
export const DELETE_ACCOUNT_SECRET_ENVS = [STRIPE_SECRET_KEY_ENV] as const;

export const STRIPE_WEBHOOK_SECRET_ENVS = [STRIPE_WEBHOOK_SECRET_ENV] as const;

export class BillingConfigError extends Error {
  constructor(readonly variable: string) {
    super(
      `${variable} is not configured. Billing configuration is supplied through the environment (Firebase parameters or Secret Manager in staging/production, process env under the emulator).`
    );
    this.name = "BillingConfigError";
  }
}

export function requireEnv(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable]?.trim();
  if (!value) {
    throw new BillingConfigError(variable);
  }
  return value;
}

export function stripeGraceFallbackDays(env: NodeJS.ProcessEnv): number {
  const raw = env[STRIPE_GRACE_FALLBACK_DAYS_ENV]?.trim();
  if (!raw) return DEFAULT_STRIPE_GRACE_FALLBACK_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${STRIPE_GRACE_FALLBACK_DAYS_ENV} must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}

/**
 * Which Firebase project this instance runs in, in entitlement vocabulary.
 *
 * `kanna-build` is the live-mode project; everything else — staging and the
 * `kanna-local` emulator — is Stripe test mode, so both stamp `staging`.
 * `sandbox` is reserved for Apple's own environment claim (Slice 2).
 */
export function resolveBillingEnvironment(env: NodeJS.ProcessEnv): BillingEnvironment {
  const projectId =
    env.GCLOUD_PROJECT?.trim() ||
    env.GOOGLE_CLOUD_PROJECT?.trim() ||
    env.FIREBASE_PROJECT_ID?.trim() ||
    "";
  return projectId === "kanna-build" ? "production" : "staging";
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  portalBaseUrl: string;
  graceFallbackDays: number;
  environment: BillingEnvironment;
}

/** Everything `createCheckoutSession` needs; throws naming the missing variable. */
export function resolveCheckoutConfig(env: NodeJS.ProcessEnv): Omit<StripeConfig, "webhookSecret"> {
  return {
    secretKey: requireEnv(env, STRIPE_SECRET_KEY_ENV),
    portalBaseUrl: requireEnv(env, PORTAL_BASE_URL_ENV),
    graceFallbackDays: stripeGraceFallbackDays(env),
    environment: resolveBillingEnvironment(env),
  };
}

/** Everything `stripeWebhook` needs; throws naming the missing variable. */
export function resolveWebhookConfig(
  env: NodeJS.ProcessEnv
): Pick<StripeConfig, "webhookSecret" | "graceFallbackDays" | "environment"> {
  return {
    webhookSecret: requireEnv(env, STRIPE_WEBHOOK_SECRET_ENV),
    graceFallbackDays: stripeGraceFallbackDays(env),
    environment: resolveBillingEnvironment(env),
  };
}
