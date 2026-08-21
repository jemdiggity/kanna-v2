export type CheckoutPlan = "monthly";
export type CheckoutContractErrorReason = "unknown_plan";

export interface CheckoutSessionRequest {
  plan: CheckoutPlan;
}

export interface CheckoutSessionResponse {
  sessionId: string;
  url: string | null;
  customerId: string;
  plan: CheckoutPlan;
}

export class CheckoutContractError extends Error {
  constructor(
    readonly reason: CheckoutContractErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "CheckoutContractError";
  }
}

export function parseCheckoutSessionRequest(value: unknown): CheckoutSessionRequest {
  const request = typeof value === "object" && value !== null
    ? value as { plan?: unknown }
    : {};

  if (request.plan !== "monthly") {
    throw new CheckoutContractError(
      "unknown_plan",
      `Unknown plan: ${String(request.plan)}. Expected "monthly".`,
    );
  }

  return { plan: request.plan };
}
