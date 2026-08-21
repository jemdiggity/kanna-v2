import type { CheckoutSessionRequest } from "@kanna/firebase-functions/billing-contract";

export function checkoutSessionRequest(): CheckoutSessionRequest {
  return { plan: "monthly" };
}
