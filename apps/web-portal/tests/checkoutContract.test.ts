import {
  parseCheckoutSessionRequest,
} from "@kanna/firebase-functions/billing-contract";
import { describe, expect, it } from "vitest";
import { checkoutSessionRequest } from "../src/checkout";

describe("portal and Firebase checkout contract", () => {
  it("accepts the real portal request through the parser used by the function", () => {
    const portalRequest = checkoutSessionRequest();
    expect(parseCheckoutSessionRequest(portalRequest)).toEqual({ plan: "monthly" });
    expect(portalRequest).not.toHaveProperty("currency");
  });
});
