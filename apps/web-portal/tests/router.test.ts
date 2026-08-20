import { describe, expect, it } from "vitest";
import type { RouteLocationNormalized } from "vue-router";
import { authRedirect } from "../src/router";

function route(path: string, meta: Record<string, boolean> = {}): RouteLocationNormalized {
  return { path, meta } as RouteLocationNormalized;
}

describe("account portal route states", () => {
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

  it("allows the checkout-cancelled return for verified users", () => {
    expect(authRedirect(route("/checkout/cancelled"), { signedIn: true, emailVerified: true, subscribed: false })).toBeUndefined();
  });
});
