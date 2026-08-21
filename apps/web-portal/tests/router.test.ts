import { describe, expect, it } from "vitest";
import type { RouteLocationNormalized } from "vue-router";
import { authRedirect, checkoutSuccessProps, router } from "../src/router";

function route(
  path: string,
  meta: Record<string, boolean> = {},
  query: Record<string, string> = {},
): RouteLocationNormalized {
  return { path, meta, query } as unknown as RouteLocationNormalized;
}

describe("account portal route states", () => {
  it("defines the billing return paths emitted by the checkout function", () => {
    const paths = router.getRoutes().map((record) => record.path);
    expect(paths).toContain("/billing/success");
    expect(paths).toContain("/billing/canceled");
    expect(paths).not.toContain("/checkout/success");
    expect(paths).not.toContain("/checkout/cancelled");
  });

  it("passes Stripe's session_id query parameter to the success page", () => {
    expect(checkoutSuccessProps(route("/billing/success", {}, { session_id: "cs_test_return" })))
      .toEqual({ result: "success", sessionId: "cs_test_return" });
  });

  it("sends signed-out visitors to sign in", () => {
    expect(authRedirect(route("/account"), { signedIn: false, emailVerified: false, subscribed: false })).toBe("/sign-in");
    expect(authRedirect(route("/register", { public: true }), { signedIn: false, emailVerified: false, subscribed: false })).toBeUndefined();
  });

  it("holds unverified users at verification", () => {
    expect(authRedirect(route("/subscribe"), { signedIn: true, emailVerified: false, subscribed: false })).toBe("/verify-email");
  });

  it("lets verified unsubscribed users reach Checkout", () => {
    expect(authRedirect(route("/subscribe"), { signedIn: true, emailVerified: true, subscribed: false })).toBeUndefined();
  });

  it("keeps subscribed users on their account", () => {
    expect(authRedirect(route("/subscribe"), { signedIn: true, emailVerified: true, subscribed: true })).toBe("/account");
  });

  it("allows the checkout-canceled return for verified users", () => {
    expect(authRedirect(route("/billing/canceled"), { signedIn: true, emailVerified: true, subscribed: false })).toBeUndefined();
  });
});
