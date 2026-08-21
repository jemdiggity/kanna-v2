#!/usr/bin/env node
/** Idempotently provision the Kanna Cloud monthly catalogue in Stripe. */
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PRODUCT_NAME = "Kanna Cloud";
export const PRODUCT_MARKER = "kanna_cloud";
export const MONTHLY_LOOKUP_KEY = "cloud_monthly";
export const MONTHLY_AMOUNTS = Object.freeze({
  jpy: 500,
  usd: 500,
  cad: 500,
  aud: 500,
  eur: 500,
  gbp: 500,
});
export const LEGACY_MONTHLY_LOOKUP_KEYS = Object.freeze(
  Object.keys(MONTHLY_AMOUNTS).map((currency) => `cloud_monthly_${currency}`),
);

function currencyOptions() {
  return Object.fromEntries(
    Object.entries(MONTHLY_AMOUNTS)
      .filter(([currency]) => currency !== "usd")
      .map(([currency, unitAmount]) => [currency, { unit_amount: unitAmount }]),
  );
}

function matchesMonthlyPrice(price) {
  if (price.currency !== "usd" || price.unit_amount !== MONTHLY_AMOUNTS.usd) return false;
  if (price.recurring?.interval !== "month") return false;
  const options = price.currency_options ?? {};
  return Object.entries(currencyOptions()).every(
    ([currency, definition]) => options[currency]?.unit_amount === definition.unit_amount,
  );
}

export async function provisionStripeCatalog(client, { dryRun = false } = {}) {
  if (dryRun) {
    return {
      dryRun: true,
      product: "would-create-if-absent",
      price: { lookupKey: MONTHLY_LOOKUP_KEY, action: "would-create-or-update" },
      legacyPrices: LEGACY_MONTHLY_LOOKUP_KEYS.map((lookupKey) => ({
        lookupKey,
        action: "would-deactivate-if-active",
      })),
    };
  }

  const existingPrices = await client.prices.list({
    active: true,
    lookup_keys: [MONTHLY_LOOKUP_KEY, ...LEGACY_MONTHLY_LOOKUP_KEYS],
    limit: 100,
    expand: ["data.currency_options"],
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

  const existingMonthly = pricesByLookupKey.get(MONTHLY_LOOKUP_KEY);
  let monthlyPrice;
  let monthlyAction;
  if (existingMonthly && matchesMonthlyPrice(existingMonthly)) {
    monthlyPrice = existingMonthly;
    monthlyAction = "existing";
  } else if (existingMonthly
    && existingMonthly.currency === "usd"
    && existingMonthly.unit_amount === MONTHLY_AMOUNTS.usd
    && existingMonthly.recurring?.interval === "month") {
    monthlyPrice = await client.prices.update(existingMonthly.id, {
      currency_options: currencyOptions(),
      expand: ["currency_options"],
    });
    monthlyAction = "updated";
  } else {
    monthlyPrice = await client.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: MONTHLY_AMOUNTS.usd,
      currency_options: currencyOptions(),
      recurring: { interval: "month" },
      lookup_key: MONTHLY_LOOKUP_KEY,
      ...(existingMonthly ? { transfer_lookup_key: true } : {}),
    });
    monthlyAction = existingMonthly ? "replaced" : "created";
    if (existingMonthly) await client.prices.update(existingMonthly.id, { active: false });
  }

  const legacyPrices = [];
  for (const lookupKey of LEGACY_MONTHLY_LOOKUP_KEYS) {
    const legacy = pricesByLookupKey.get(lookupKey);
    if (!legacy) continue;
    // Archiving prevents new Checkouts while preserving the Price records used
    // by existing subscriptions, invoices, and Stripe's audit history.
    await client.prices.update(legacy.id, { active: false });
    legacyPrices.push({ id: legacy.id, lookupKey, action: "deactivated" });
  }

  return {
    dryRun: false,
    product: { id: product.id, action: productCreated ? "created" : "existing" },
    price: { id: monthlyPrice.id, lookupKey: MONTHLY_LOOKUP_KEY, action: monthlyAction },
    legacyPrices,
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
