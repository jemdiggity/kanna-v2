import { describe, expect, it, vi } from "vitest";
import {
  MONTHLY_PRICES,
  PRODUCT_MARKER,
  provisionStripeCatalog,
} from "../scripts/provision-stripe-catalog.mjs";

function mockClient(options: { existing?: boolean } = {}) {
  const product = { id: "prod_kanna", metadata: { kanna_catalog: PRODUCT_MARKER } };
  const prices = options.existing
    ? MONTHLY_PRICES.map((price) => ({ id: `price_${price.currency}`, lookup_key: price.lookupKey, product: product.id }))
    : [];
  return {
    products: {
      list: vi.fn(async () => ({ data: options.existing ? [product] : [] })),
      retrieve: vi.fn(async () => product),
      create: vi.fn(async () => product),
    },
    prices: {
      list: vi.fn(async () => ({ data: prices })),
      create: vi.fn(async (input: { currency: string }) => ({ id: `price_${input.currency}` })),
    },
  };
}

describe("Stripe catalogue provisioning", () => {
  it("creates the product and every absent monthly price", async () => {
    const client = mockClient();
    const result = await provisionStripeCatalog(client);
    expect(client.products.create).toHaveBeenCalledOnce();
    expect(client.prices.create).toHaveBeenCalledTimes(6);
    expect(client.prices.create).toHaveBeenCalledWith(expect.objectContaining({
      currency: "jpy", unit_amount: 500, lookup_key: "cloud_monthly_jpy",
    }));
    expect(result.prices.every((price) => price.action === "created")).toBe(true);
  });

  it("reuses the product and prices when every lookup key exists", async () => {
    const client = mockClient({ existing: true });
    const result = await provisionStripeCatalog(client);
    expect(client.products.create).not.toHaveBeenCalled();
    expect(client.prices.create).not.toHaveBeenCalled();
    expect(result.prices.every((price) => price.action === "existing")).toBe(true);
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
