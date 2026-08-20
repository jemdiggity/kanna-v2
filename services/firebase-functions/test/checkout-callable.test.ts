import type { CallableRequest } from "firebase-functions/v2/https";
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkoutMocks = vi.hoisted(() => ({
  createCheckoutSessionCore: vi.fn(),
}));

vi.mock("../src/billing/checkout.js", () => ({
  createCheckoutSession: checkoutMocks.createCheckoutSessionCore,
}));

import { createCheckoutSession } from "../src/index.js";

describe("createCheckoutSession callable adapter", () => {
  beforeEach(() => {
    checkoutMocks.createCheckoutSessionCore.mockReset();
    checkoutMocks.createCheckoutSessionCore.mockResolvedValue({
      sessionId: "cs_test_jpy",
      url: "https://checkout.stripe.test/cs_test_jpy",
      customerId: "cus_test",
      plan: "monthly",
      currency: "jpy",
    });
  });

  it("forwards a selected non-USD currency to the checkout core", async () => {
    const request = {
      data: { plan: "monthly", currency: "jpy" },
      auth: {
        uid: "user-jpy",
        token: { email: "jpy@example.com", email_verified: true },
      },
    } as unknown as CallableRequest<{ plan: string; currency: string }>;

    await createCheckoutSession.run(request);

    expect(checkoutMocks.createCheckoutSessionCore).toHaveBeenCalledOnce();
    expect(checkoutMocks.createCheckoutSessionCore).toHaveBeenCalledWith(
      { plan: "monthly", currency: "jpy" },
      { uid: "user-jpy", email: "jpy@example.com", emailVerified: true },
      expect.objectContaining({ env: process.env })
    );
  });
});
