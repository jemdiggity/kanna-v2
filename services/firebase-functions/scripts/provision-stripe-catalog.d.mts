interface StripeProvisionClient {
  products: {
    list(input: object): Promise<{ data: Array<{ id: string; metadata?: Record<string, string> }> }>;
    retrieve(id: string): Promise<{ id: string; metadata?: Record<string, string> }>;
    create(input: object): Promise<{ id: string; metadata?: Record<string, string> }>;
  };
  prices: {
    list(input: object): Promise<{ data: Array<{
      id: string;
      lookup_key?: string | null;
      product: string | object;
      currency?: string;
      unit_amount?: number;
      recurring?: { interval?: string };
      currency_options?: Record<string, { unit_amount?: number }>;
    }> }>;
    create(input: object): Promise<{ id: string }>;
    update(id: string, input: object): Promise<{ id: string }>;
  };
}

export const PRODUCT_MARKER: string;
export const MONTHLY_LOOKUP_KEY: string;
export const MONTHLY_AMOUNTS: Readonly<Record<string, number>>;
export const LEGACY_MONTHLY_LOOKUP_KEYS: readonly string[];
export function provisionStripeCatalog(
  client: StripeProvisionClient | null,
  options?: { dryRun?: boolean }
): Promise<{
  dryRun: boolean;
  price: { lookupKey: string; action: string; id?: string };
  legacyPrices: Array<{ lookupKey: string; action: string; id?: string }>;
}>;
