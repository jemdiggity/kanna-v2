import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  customersCreate: vi.fn(),
  pricesList: vi.fn(),
  sessionsCreate: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class MockStripe {
    customers = { create: stripeMocks.customersCreate };
    prices = { list: stripeMocks.pricesList };
    checkout = {
      sessions: { create: stripeMocks.sessionsCreate },
    };
  },
}));

import { stripeCheckoutGateway } from "../src/billing/stripeGateway.js";

describe("Stripe checkout gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.sessionsCreate.mockResolvedValue({
      id: "cs_test_3ds",
      url: "https://checkout.stripe.com/c/pay/cs_test_3ds",
    });
  });

  it("explicitly requests 3D Secure on the Checkout Session", async () => {
    const gateway = stripeCheckoutGateway("sk_test_mocked");

    await gateway.createCheckoutSession({
      uid: "firebase-user",
      customerId: "cus_test_3ds",
      priceId: "price_test_jpy",
      successUrl: "https://portal.kanna.build/billing/success",
      cancelUrl: "https://portal.kanna.build/billing/canceled",
    });

    expect(stripeMocks.sessionsCreate).toHaveBeenCalledOnce();
    expect(stripeMocks.sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
      payment_method_options: {
        card: { request_three_d_secure: "any" },
      },
    }));
  });
});
