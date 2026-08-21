import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_MONTHLY_LOOKUP_KEYS,
  MONTHLY_AMOUNTS,
  MONTHLY_LOOKUP_KEY,
  PRODUCT_MARKER,
  provisionStripeCatalog,
} from "../scripts/provision-stripe-catalog.mjs";

function monthlyPrice() {
  return {
    id: "price_monthly",
    lookup_key: MONTHLY_LOOKUP_KEY,
    product: "prod_kanna",
    currency: "usd",
    unit_amount: 500,
    recurring: { interval: "month" },
    currency_options: {
      jpy: { unit_amount: 500 },
      cad: { unit_amount: 500 },
      aud: { unit_amount: 500 },
      eur: { unit_amount: 500 },
      gbp: { unit_amount: 500 },
    },
  };
}

function mockClient(options: { existingMonthly?: boolean; legacy?: boolean } = {}) {
  const product = { id: "prod_kanna", metadata: { kanna_catalog: PRODUCT_MARKER } };
  const prices = [
    ...(options.existingMonthly ? [monthlyPrice()] : []),
    ...(options.legacy ? LEGACY_MONTHLY_LOOKUP_KEYS.map((lookupKey) => ({
      id: `price_${lookupKey}`,
      lookup_key: lookupKey,
      product: product.id,
    })) : []),
  ];
  return {
    products: {
      list: vi.fn(async () => ({ data: prices.length > 0 ? [product] : [] })),
      retrieve: vi.fn(async () => product),
      create: vi.fn(async () => product),
    },
    prices: {
      list: vi.fn(async () => ({ data: prices })),
      create: vi.fn(async () => monthlyPrice()),
      update: vi.fn(async (id: string) => ({ ...monthlyPrice(), id })),
    },
  };
}

describe("Stripe catalogue provisioning", () => {
  it("creates one multi-currency monthly price when the catalog is absent", async () => {
    const client = mockClient();
    const result = await provisionStripeCatalog(client);
    expect(client.products.create).toHaveBeenCalledOnce();
    expect(client.prices.create).toHaveBeenCalledOnce();
    expect(client.prices.create).toHaveBeenCalledWith(expect.objectContaining({
      currency: "usd",
      unit_amount: MONTHLY_AMOUNTS.usd,
      lookup_key: MONTHLY_LOOKUP_KEY,
      currency_options: {
        jpy: { unit_amount: 500 },
        cad: { unit_amount: 500 },
        aud: { unit_amount: 500 },
        eur: { unit_amount: 500 },
        gbp: { unit_amount: 500 },
      },
    }));
    expect(result.price.action).toBe("created");
  });

  it("reuses an existing matching multi-currency price", async () => {
    const client = mockClient({ existingMonthly: true });
    const result = await provisionStripeCatalog(client);
    expect(client.products.create).not.toHaveBeenCalled();
    expect(client.prices.create).not.toHaveBeenCalled();
    expect(client.prices.update).not.toHaveBeenCalled();
    expect(result.price.action).toBe("existing");
  });

  it("deactivates all active per-currency legacy prices after provisioning", async () => {
    const client = mockClient({ legacy: true });
    const result = await provisionStripeCatalog(client);
    expect(client.prices.create).toHaveBeenCalledOnce();
    for (const lookupKey of LEGACY_MONTHLY_LOOKUP_KEYS) {
      expect(client.prices.update).toHaveBeenCalledWith(`price_${lookupKey}`, { active: false });
    }
    expect(result.legacyPrices).toHaveLength(6);
  });

  it("makes no Stripe calls during a dry run", async () => {
    const client = mockClient();
    const result = await provisionStripeCatalog(client, { dryRun: true });
    expect(result.dryRun).toBe(true);
    for (const group of [client.products, client.prices]) {
      for (const method of Object.values(group)) expect(method).not.toHaveBeenCalled();
    }
  });
});
