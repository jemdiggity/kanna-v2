interface StripeProvisionClient {
  products: {
    list(input: object): Promise<{ data: Array<{ id: string; metadata?: Record<string, string> }> }>;
    retrieve(id: string): Promise<{ id: string; metadata?: Record<string, string> }>;
    create(input: object): Promise<{ id: string; metadata?: Record<string, string> }>;
  };
  prices: {
    list(input: object): Promise<{ data: Array<{ id: string; lookup_key?: string | null; product: string | object }> }>;
    create(input: object): Promise<{ id: string }>;
  };
}

export const PRODUCT_MARKER: string;
export const MONTHLY_PRICES: readonly Array<{ currency: string; unitAmount: number; lookupKey: string }>;
export function provisionStripeCatalog(
  client: StripeProvisionClient | null,
  options?: { dryRun?: boolean }
): Promise<{
  dryRun: boolean;
  prices: Array<{ currency: string; unitAmount: number; lookupKey: string; action: string; id?: string }>;
}>;
