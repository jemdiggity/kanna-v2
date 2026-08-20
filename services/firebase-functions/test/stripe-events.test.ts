import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  interpretStripeEvent,
  isHandledStripeEventType,
  mapSubscriptionStatus,
  parseStripeEventEnvelope,
  stripeEventCreatedAt,
  type StripeEventEnvelope,
} from "../src/billing/stripeEvents.js";
import { mergeStripeSourceState } from "../src/billing/stripeWebhook.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures/stripe");
const GRACE_FALLBACK_DAYS = 14;

function fixture(name: string): StripeEventEnvelope {
  const parsed = parseStripeEventEnvelope(
    JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"))
  );
  if (!parsed) {
    throw new Error(`Fixture ${name} is not a Stripe event envelope`);
  }
  return parsed;
}

function interpret(name: string) {
  return interpretStripeEvent(fixture(name), { graceFallbackDays: GRACE_FALLBACK_DAYS });
}

describe("Stripe event mapping", () => {
  it("maps every Stripe subscription status onto a source status", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("trialing")).toBe("active");
    expect(mapSubscriptionStatus("past_due")).toBe("grace");
    expect(mapSubscriptionStatus("canceled")).toBe("expired");
    expect(mapSubscriptionStatus("unpaid")).toBe("expired");
    expect(mapSubscriptionStatus("incomplete")).toBe("expired");
    expect(mapSubscriptionStatus("incomplete_expired")).toBe("expired");
    expect(mapSubscriptionStatus("paused")).toBe("expired");
  });

  it("treats an unrecognized status as unentitled rather than assuming access", () => {
    expect(mapSubscriptionStatus("something_stripe_added_later")).toBe("expired");
  });

  it("only handles the event types Decision 3 lists", () => {
    expect(isHandledStripeEventType("checkout.session.completed")).toBe(true);
    expect(isHandledStripeEventType("customer.subscription.updated")).toBe(true);
    expect(isHandledStripeEventType("invoice.paid")).toBe(true);
    expect(isHandledStripeEventType("customer.updated")).toBe(false);
  });

  it("rejects a body that is not an event envelope", () => {
    expect(parseStripeEventEnvelope({ id: "evt_1", type: "invoice.paid" })).toBeNull();
    expect(parseStripeEventEnvelope("not-an-object")).toBeNull();
  });

  it("reads the account binding a completed checkout session carries", () => {
    const result = interpret("checkout.session.completed.json");
    expect(result).toMatchObject({
      kind: "apply",
      account: { uid: "fixture-checkout-user", customerId: "cus_TestSlice1" },
      patch: {
        status: "active",
        stripeCustomerId: "cus_TestSlice1",
        stripeSubscriptionId: "sub_TestSlice1",
      },
    });
  });

  it("binds the ids but grants nothing for an unpaid checkout session", () => {
    const result = interpret("checkout.session.completed.unpaid.json");
    expect(result.kind).toBe("apply");
    if (result.kind !== "apply") return;
    expect(result.patch.status).toBeUndefined();
    expect(result.patch.stripeSubscriptionId).toBe("sub_TestSlice1");
  });

  it("reads the period end from subscription items, where Stripe now puts it", () => {
    const result = interpret("customer.subscription.created.json");
    expect(result).toMatchObject({
      kind: "apply",
      account: { uid: "fixture-checkout-user" },
      patch: {
        status: "active",
        currentPeriodEndsAt: "2026-09-19T00:00:00.000Z",
        cancelAtPeriodEnd: false,
      },
    });
  });

  it("treats a trial as active", () => {
    expect(interpret("customer.subscription.updated.trialing.json")).toMatchObject({
      patch: { status: "active" },
    });
  });

  it("keeps a subscription canceling at period end active until the period passes", () => {
    expect(interpret("customer.subscription.updated.cancel_at_period_end.json")).toMatchObject({
      patch: {
        status: "active",
        cancelAtPeriodEnd: true,
        currentPeriodEndsAt: "2026-09-19T00:00:00.000Z",
      },
    });
  });

  it("maps past_due to grace and unpaid to expired", () => {
    expect(interpret("customer.subscription.updated.past_due.json")).toMatchObject({
      patch: { status: "grace" },
    });
    expect(interpret("customer.subscription.updated.unpaid.json")).toMatchObject({
      patch: { status: "expired" },
    });
  });

  it("expires a deleted subscription", () => {
    expect(interpret("customer.subscription.deleted.json")).toMatchObject({
      patch: { status: "expired", graceEndsAt: null },
    });
  });

  it("takes graceEndsAt from the failing invoice's next retry attempt", () => {
    expect(interpret("invoice.payment_failed.json")).toMatchObject({
      patch: { status: "grace", graceEndsAt: "2026-09-26T00:00:00.000Z" },
    });
  });

  it("falls back to a fixed window when Stripe names no next retry", () => {
    // Period end 2026-09-19 plus the 14-day fallback.
    expect(interpret("invoice.payment_failed.no_retry.json")).toMatchObject({
      patch: { status: "grace", graceEndsAt: "2026-10-03T00:00:00.000Z" },
    });
  });

  it("reads the renewed period from a paid invoice and clears grace", () => {
    expect(interpret("invoice.paid.json")).toMatchObject({
      patch: {
        status: "active",
        currentPeriodEndsAt: "2026-10-19T00:00:00.000Z",
        graceEndsAt: null,
        stripeSubscriptionId: "sub_TestSlice1",
      },
    });
  });

  it("ignores an event type it does not handle", () => {
    expect(interpret("customer.updated.json")).toMatchObject({ kind: "ignored" });
  });

  it("reports the event's own timestamp, which resolves out-of-order delivery", () => {
    expect(stripeEventCreatedAt(fixture("checkout.session.completed.json"))).toBe(
      "2026-08-19T00:00:00.000Z"
    );
  });
});

describe("mergeStripeSourceState", () => {
  const base = {
    eventId: "evt_1",
    eventCreatedAt: "2026-08-19T00:00:00.000Z",
    environment: "staging" as const,
    now: "2026-08-19T00:00:05.000Z",
  };

  it("keeps fields the incoming event knows nothing about", () => {
    const created = mergeStripeSourceState({
      ...base,
      existing: null,
      patch: { status: "active", currentPeriodEndsAt: "2026-09-19T00:00:00.000Z" },
    });
    const afterCheckout = mergeStripeSourceState({
      ...base,
      existing: created,
      eventId: "evt_2",
      patch: { status: "active", stripeSubscriptionId: "sub_TestSlice1" },
    });

    expect(afterCheckout.currentPeriodEndsAt).toBe("2026-09-19T00:00:00.000Z");
    expect(afterCheckout.stripeSubscriptionId).toBe("sub_TestSlice1");
    expect(afterCheckout.lastEventId).toBe("evt_2");
  });

  it("starts an unknown source unentitled rather than assuming access", () => {
    const created = mergeStripeSourceState({ ...base, existing: null, patch: {} });
    expect(created).toMatchObject({ source: "stripe", status: "expired", cancelAtPeriodEnd: false });
  });
});
