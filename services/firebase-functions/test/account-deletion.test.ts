import { describe, expect, it, vi } from "vitest";
import {
  deleteAccount,
  type AccountDeletionAuth,
  type AccountDeletionStore,
} from "../src/accountDeletion.js";
import type { StripeSubscriptionGateway } from "../src/billing/stripeGateway.js";

function harness(options: {
  failBillingIndexesOnce?: boolean;
  checkoutSessionIds?: string[];
  customerIds?: string[];
  legacySessionIds?: string[];
  customerSubscriptionIds?: string[];
} = {}) {
  const calls: string[] = [];
  let subscriptionPresent = true;
  let userTreePresent = true;
  let failBillingIndexesOnce = options.failBillingIndexesOnce ?? false;
  const usableLegacySessions = new Set(options.legacySessionIds ?? []);
  const liveCustomerSubscriptions = new Set(options.customerSubscriptionIds ?? []);
  const store: AccountDeletionStore = {
    async markAccountDeletionStarted() {
      calls.push("mark-account-deletion-started");
      return options.checkoutSessionIds ?? [];
    },
    async stripeBillingReferences() {
      calls.push("read-stripe-billing-references");
      return {
        customerIds: options.customerIds ?? [],
        subscriptionIds: subscriptionPresent ? ["sub_active"] : [],
      };
    },
    async deleteUserTree() {
      calls.push("delete-user-tree");
      userTreePresent = false;
      subscriptionPresent = false;
    },
    async deleteBillingIndexes() {
      calls.push("delete-billing-indexes");
      if (failBillingIndexesOnce) {
        failBillingIndexesOnce = false;
        throw new Error("injected index failure");
      }
    },
    async revokeDesktopPairings() {
      calls.push("revoke-desktop-pairings");
    },
    async deleteLegacyDevicePairings() {
      calls.push("delete-legacy-device-pairings");
    },
  };
  const stripe: StripeSubscriptionGateway = {
    cancelSubscription: vi.fn(async () => {
      calls.push("cancel-stripe");
    }),
    closeCheckoutSession: vi.fn(async () => {
      calls.push("close-checkout-session");
    }),
    closeCustomerBilling: vi.fn(async () => {
      calls.push("close-customer-billing");
      usableLegacySessions.clear();
      liveCustomerSubscriptions.clear();
    }),
  };
  const auth: AccountDeletionAuth = {
    revokeRefreshTokens: vi.fn(async () => {
      calls.push("revoke-refresh-tokens");
    }),
    deleteUser: vi.fn(async () => {
      calls.push("delete-auth-user");
    }),
  };
  return {
    calls,
    dependencies: { store, stripe, auth },
    userTreePresent: () => userTreePresent,
    usableLegacySessions,
    liveCustomerSubscriptions,
  };
}

describe("deleteAccount", () => {
  it("requires authentication", async () => {
    const { dependencies } = harness();
    await expect(deleteAccount(null, dependencies)).rejects.toMatchObject({
      code: "unauthenticated",
      reason: "sign_in_required",
    });
  });

  it("cancels Stripe first and deletes Auth last", async () => {
    const { calls, dependencies } = harness({ checkoutSessionIds: ["cs_open"] });
    await expect(deleteAccount({ uid: "user-1" }, dependencies)).resolves.toEqual({
      deleted: true,
    });
    expect(calls).toEqual([
      "mark-account-deletion-started",
      "read-stripe-billing-references",
      "cancel-stripe",
      "close-checkout-session",
      "revoke-desktop-pairings",
      "delete-legacy-device-pairings",
      "delete-user-tree",
      "delete-billing-indexes",
      "revoke-refresh-tokens",
      "delete-auth-user",
    ]);
  });

  it("leaves Auth retryable after a mid-delete failure and completes on rerun", async () => {
    const { calls, dependencies, userTreePresent } = harness({ failBillingIndexesOnce: true });

    await expect(deleteAccount({ uid: "user-1" }, dependencies)).rejects.toThrow(
      "injected index failure",
    );
    expect(userTreePresent()).toBe(false);
    expect(dependencies.auth.deleteUser).not.toHaveBeenCalled();

    await expect(deleteAccount({ uid: "user-1" }, dependencies)).resolves.toEqual({
      deleted: true,
    });
    expect(calls).toEqual([
      "mark-account-deletion-started",
      "read-stripe-billing-references",
      "cancel-stripe",
      "revoke-desktop-pairings",
      "delete-legacy-device-pairings",
      "delete-user-tree",
      "delete-billing-indexes",
      "mark-account-deletion-started",
      "read-stripe-billing-references",
      "revoke-desktop-pairings",
      "delete-legacy-device-pairings",
      "delete-user-tree",
      "delete-billing-indexes",
      "revoke-refresh-tokens",
      "delete-auth-user",
    ]);
  });

  it("treats an already-absent Auth user as a completed rerun", async () => {
    const { dependencies } = harness();
    dependencies.store.stripeBillingReferences = vi.fn(async () => ({
      customerIds: [],
      subscriptionIds: [],
    }));
    const missing = Object.assign(new Error("missing"), { code: "auth/user-not-found" });
    dependencies.auth.revokeRefreshTokens = vi.fn(async () => { throw missing; });
    dependencies.auth.deleteUser = vi.fn(async () => { throw missing; });

    await expect(deleteAccount({ uid: "user-1" }, dependencies)).resolves.toEqual({
      deleted: true,
    });
  });

  it("closes pre-ledger customer sessions and subscriptions across a failed rerun", async () => {
    const state = harness({
      failBillingIndexesOnce: true,
      customerIds: ["cus_legacy"],
      legacySessionIds: ["cs_unrecorded"],
      customerSubscriptionIds: ["sub_from_legacy", "sub_other_live"],
    });

    await expect(deleteAccount({ uid: "user-1" }, state.dependencies)).rejects.toThrow(
      "injected index failure",
    );
    expect(state.dependencies.stripe.closeCheckoutSession).not.toHaveBeenCalled();
    expect(state.dependencies.stripe.closeCustomerBilling).toHaveBeenCalledWith("cus_legacy");
    expect(state.usableLegacySessions.size).toBe(0);
    expect(state.liveCustomerSubscriptions.size).toBe(0);
    expect(state.dependencies.auth.deleteUser).not.toHaveBeenCalled();

    await expect(deleteAccount({ uid: "user-1" }, state.dependencies)).resolves.toEqual({
      deleted: true,
    });
    expect(state.dependencies.stripe.closeCustomerBilling).toHaveBeenCalledTimes(2);
    expect(state.dependencies.auth.deleteUser).toHaveBeenCalledWith("user-1");
  });
});
