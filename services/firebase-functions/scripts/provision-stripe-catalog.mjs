#!/usr/bin/env node
/** Idempotently provision the Kanna Cloud monthly catalogue in Stripe. */
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PRODUCT_NAME = "Kanna Cloud";
export const PRODUCT_MARKER = "kanna_cloud";
export const MONTHLY_PRICES = Object.freeze([
  { currency: "jpy", unitAmount: 500, lookupKey: "cloud_monthly_jpy" },
  { currency: "usd", unitAmount: 500, lookupKey: "cloud_monthly_usd" },
  { currency: "cad", unitAmount: 500, lookupKey: "cloud_monthly_cad" },
  { currency: "aud", unitAmount: 500, lookupKey: "cloud_monthly_aud" },
  { currency: "eur", unitAmount: 500, lookupKey: "cloud_monthly_eur" },
  { currency: "gbp", unitAmount: 500, lookupKey: "cloud_monthly_gbp" },
]);

export async function provisionStripeCatalog(client, { dryRun = false } = {}) {
  if (dryRun) {
    return { dryRun: true, product: "would-create-if-absent", prices: MONTHLY_PRICES.map((price) => ({ ...price, action: "would-create-if-absent" })) };
  }

  const existingPrices = await client.prices.list({
    active: true,
    lookup_keys: MONTHLY_PRICES.map((price) => price.lookupKey),
    limit: 100,
  });
  const pricesByLookupKey = new Map(
    existingPrices.data.flatMap((price) => price.lookup_key ? [[price.lookup_key, price]] : [])
  );

  let product = existingPrices.data[0]?.product;
  if (typeof product === "string") {
    product = await client.products.retrieve(product);
  }
  if (!product) {
    const products = await client.products.list({ active: true, limit: 100 });
    product = products.data.find((candidate) =>
      candidate.metadata?.kanna_catalog === PRODUCT_MARKER
    ) ?? null;
  }
  let productCreated = false;
  if (!product) {
    product = await client.products.create({
      name: PRODUCT_NAME,
      metadata: { kanna_catalog: PRODUCT_MARKER },
    });
    productCreated = true;
  }

  const prices = [];
  for (const definition of MONTHLY_PRICES) {
    const existing = pricesByLookupKey.get(definition.lookupKey);
    if (existing) {
      prices.push({ ...definition, id: existing.id, action: "existing" });
      continue;
    }
    const created = await client.prices.create({
      product: product.id,
      currency: definition.currency,
      unit_amount: definition.unitAmount,
      recurring: { interval: "month" },
      lookup_key: definition.lookupKey,
    });
    prices.push({ ...definition, id: created.id, action: "created" });
  }
  return {
    dryRun: false,
    product: { id: product.id, action: productCreated ? "created" : "existing" },
    prices,
  };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
  const dryRun = args.includes("--dry-run");
  if (dryRun) {
    console.log(JSON.stringify(await provisionStripeCatalog(null, { dryRun: true }), null, 2));
    return;
  }
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is required (use the test or live key for the mode to provision).");
  const { default: Stripe } = await import("stripe");
  const result = await provisionStripeCatalog(new Stripe(secretKey));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
