/**
 * Runtime configuration for the billing backend.
 *
 * Every secret arrives through the environment (GCP Secret Manager bound to the
 * function, or the emulator's process env). This repository is public: no key,
 * price id, or webhook secret is ever committed. Resolution is deliberately
 * lazy — a missing key must surface as a clear error on the request that needs
 * it, not as a crash at module load that takes the whole deploy down.
 */
import type { BillingEnvironment } from "./types.js";

export const STRIPE_SECRET_KEY_ENV = "STRIPE_SECRET_KEY";
export const STRIPE_WEBHOOK_SECRET_ENV = "STRIPE_WEBHOOK_SECRET";
export const STRIPE_PRICE_MONTHLY_ENV = "STRIPE_PRICE_MONTHLY";
export const STRIPE_PRICE_ANNUAL_ENV = "STRIPE_PRICE_ANNUAL";
export const PORTAL_BASE_URL_ENV = "KANNA_PORTAL_BASE_URL";

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
 * Secret Manager entries each function must declare so its values reach
 * `process.env` at runtime.
 *
 * A deployed 2nd-gen function's environment is populated only from declared
 * secrets and committed `.env` files, so a variable read below but absent from
 * the matching list here is simply undefined in production, however carefully
 * it was stored in Secret Manager. `src/index.ts` binds these per function, and
 * `test/function-secrets.test.ts` pins that each list is exactly the set its
 * resolver requires.
 *
 * The price ids and the portal base URL are ordinary configuration rather than
 * secrets. They are bound this way because it is the only mechanism that
 * commits nothing to this public repository — the alternative, a
 * `.env.<project>` file in the functions source directory, would mean checking
 * per-environment values into git.
 *
 * `STRIPE_GRACE_FALLBACK_DAYS` is deliberately absent: it is optional and has a
 * documented default. Adding it to a list is what would make it overridable in
 * a deployed environment.
 */
export const CHECKOUT_SECRET_ENVS = [
  STRIPE_SECRET_KEY_ENV,
  STRIPE_PRICE_MONTHLY_ENV,
  STRIPE_PRICE_ANNUAL_ENV,
  PORTAL_BASE_URL_ENV,
] as const;

export const STRIPE_WEBHOOK_SECRET_ENVS = [STRIPE_WEBHOOK_SECRET_ENV] as const;

export class BillingConfigError extends Error {
  constructor(readonly variable: string) {
    super(
      `${variable} is not configured. Billing secrets are supplied through the environment (Secret Manager in staging/production, process env under the emulator) and are never committed.`
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
  priceMonthly: string;
  priceAnnual: string;
  portalBaseUrl: string;
  graceFallbackDays: number;
  environment: BillingEnvironment;
}

/** Everything `createCheckoutSession` needs; throws naming the missing variable. */
export function resolveCheckoutConfig(env: NodeJS.ProcessEnv): Omit<StripeConfig, "webhookSecret"> {
  return {
    secretKey: requireEnv(env, STRIPE_SECRET_KEY_ENV),
    priceMonthly: requireEnv(env, STRIPE_PRICE_MONTHLY_ENV),
    priceAnnual: requireEnv(env, STRIPE_PRICE_ANNUAL_ENV),
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
