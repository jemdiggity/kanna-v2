/**
 * The deployed functions' Secret Manager bindings.
 *
 * A deployed 2nd-gen function's environment is populated only from declared
 * secrets and committed `.env` files, so dropping a `secrets` declaration does
 * not fail a build, a typecheck, or any emulator test — it produces a billing
 * backend that answers every Stripe delivery with a 500 in production and
 * nowhere else. These assertions are the thing that would catch that.
 *
 * No emulator is needed: `src/index.ts` builds its deployment manifest at
 * import time, and Firebase admin is initialized lazily per request.
 */
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_SECRET_ENVS,
  DELETE_ACCOUNT_SECRET_ENVS,
  STRIPE_WEBHOOK_SECRET_ENVS,
  resolveCheckoutConfig,
  resolveWebhookConfig,
} from "../src/billing/config.js";
import * as functions from "../src/index.js";

/** The deployment manifest firebase-functions attaches to every v2 handler. */
interface DeployedFunction {
  __endpoint: { secretEnvironmentVariables?: { key: string }[] };
}

function boundSecrets(name: "createCheckoutSession" | "deleteAccount" | "stripeWebhook"): string[] {
  const endpoint = (functions[name] as unknown as DeployedFunction).__endpoint;
  return (endpoint.secretEnvironmentVariables ?? []).map((entry) => entry.key);
}

function envFor(names: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(names.map((name) => [name, `value-for-${name}`]));
}

describe("deployed function secret bindings", () => {
  it("deploys exactly the two billing functions and no stray endpoint", () => {
    const deployed = Object.entries(functions)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(deployed).toEqual(["createCheckoutSession", "deleteAccount", "stripeWebhook"]);
  });

  it("binds createCheckoutSession to its declared Secret Manager entries", () => {
    expect(boundSecrets("createCheckoutSession")).toEqual([...CHECKOUT_SECRET_ENVS]);
    expect(boundSecrets("createCheckoutSession")).toEqual([
      "STRIPE_SECRET_KEY",
      "KANNA_PORTAL_BASE_URL",
    ]);
  });

  it("binds stripeWebhook to the signing secret and nothing else", () => {
    expect(boundSecrets("stripeWebhook")).toEqual([...STRIPE_WEBHOOK_SECRET_ENVS]);
    expect(boundSecrets("stripeWebhook")).toEqual(["STRIPE_WEBHOOK_SECRET"]);
  });

  it("binds deleteAccount only to the Stripe API key", () => {
    expect(boundSecrets("deleteAccount")).toEqual([...DELETE_ACCOUNT_SECRET_ENVS]);
    expect(boundSecrets("deleteAccount")).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("never hands the webhook the Stripe API key", () => {
    expect(boundSecrets("stripeWebhook")).not.toContain("STRIPE_SECRET_KEY");
    expect(boundSecrets("createCheckoutSession")).not.toContain("STRIPE_WEBHOOK_SECRET");
  });

  describe("each binding list is exactly what its resolver requires", () => {
    it("resolves the checkout config from its bound entries alone", () => {
      expect(() => resolveCheckoutConfig(envFor(CHECKOUT_SECRET_ENVS))).not.toThrow();
    });

    it("resolves the webhook config from its bound entries alone", () => {
      expect(() => resolveWebhookConfig(envFor(STRIPE_WEBHOOK_SECRET_ENVS))).not.toThrow();
    });

    it.each([...CHECKOUT_SECRET_ENVS])(
      "fails checkout when %s is the one entry missing",
      (missing) => {
        const env = envFor(CHECKOUT_SECRET_ENVS.filter((name) => name !== missing));
        expect(() => resolveCheckoutConfig(env)).toThrow(missing);
      }
    );

    it.each([...STRIPE_WEBHOOK_SECRET_ENVS])(
      "fails the webhook when %s is the one entry missing",
      (missing) => {
        const env = envFor(STRIPE_WEBHOOK_SECRET_ENVS.filter((name) => name !== missing));
        expect(() => resolveWebhookConfig(env)).toThrow(missing);
      }
    );
  });
});
