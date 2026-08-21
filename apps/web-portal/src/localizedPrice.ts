export type CloudCurrency = "JPY" | "USD" | "CAD" | "AUD" | "EUR" | "GBP";

interface MonthlyPrice {
  amount: number;
  currency: CloudCurrency;
}

const EURO_AREA_REGIONS = new Set([
  "AT", "BE", "BG", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES",
]);

const MONTHLY_PRICES: Record<CloudCurrency, MonthlyPrice> = {
  JPY: { amount: 500, currency: "JPY" },
  USD: { amount: 5, currency: "USD" },
  CAD: { amount: 5, currency: "CAD" },
  AUD: { amount: 5, currency: "AUD" },
  EUR: { amount: 5, currency: "EUR" },
  GBP: { amount: 5, currency: "GBP" },
};

export function cloudCurrencyForLocale(locale: string): CloudCurrency {
  let region: string | undefined;
  try {
    region = new Intl.Locale(locale).maximize().region?.toUpperCase();
  } catch {
    return "USD";
  }

  if (region === "JP") return "JPY";
  if (region === "CA") return "CAD";
  if (region === "AU") return "AUD";
  if (region === "GB") return "GBP";
  if (region && EURO_AREA_REGIONS.has(region)) return "EUR";
  return "USD";
}

export function formatCloudMonthlyPrice(locale: string): string {
  const price = MONTHLY_PRICES[cloudCurrencyForLocale(locale)];
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(price.amount);

  // Intl spells the Canadian discriminator as "CA$"; the catalog's display
  // card uses the conventional compact "C$" alongside "A$" for Australia.
  return formatted.replace("CA$", "C$");
}
