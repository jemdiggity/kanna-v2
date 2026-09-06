import { ref } from "vue";

export type MobileInstallEnvironment = "dev" | "staging" | "production";

const e2eMobileInstallUrl = ref<string | undefined>();

export function setE2EMobileInstallUrl(value: string | undefined): void {
  e2eMobileInstallUrl.value = value;
}

export function getE2EMobileInstallUrl(): string | undefined {
  return e2eMobileInstallUrl.value;
}

/**
 * Replace these values with the published App Store and TestFlight links.
 * Keeping the placeholders in the map makes an unconfigured build explicit:
 * callers must not turn them into QR codes.
 */
export const MOBILE_INSTALL_LINKS: Record<MobileInstallEnvironment, string> = {
  production: "__CONFIGURE_PRODUCTION_APP_STORE_URL__",
  staging: "__CONFIGURE_STAGING_TESTFLIGHT_URL__",
  dev: "__CONFIGURE_STAGING_TESTFLIGHT_URL__",
};

export function normalizeMobileInstallEnvironment(
  environment: string | null | undefined,
): MobileInstallEnvironment | null {
  const normalized = environment?.trim().toLowerCase();
  if (normalized === "production" || normalized === "prod") return "production";
  if (normalized === "staging") return "staging";
  if (
    normalized === "dev"
    || normalized === "development"
    || normalized === "local"
    || normalized === "test"
  ) {
    return "dev";
  }
  return null;
}

export function isConfiguredMobileInstallLink(value: string | null | undefined): value is string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.startsWith("__CONFIGURE_")) return false;

  try {
    const url = new URL(normalized);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getMobileInstallLink(environment: string | null | undefined): string | null {
  const normalizedEnvironment = normalizeMobileInstallEnvironment(environment);
  if (!normalizedEnvironment) return null;

  // The mock desktop E2E supplies a known test URL so it can verify two real
  // QR renderings without making the shipped placeholder look configured.
  const e2eLink = e2eMobileInstallUrl.value;
  const link = normalizedEnvironment === "dev" && e2eLink
    ? e2eLink
    : MOBILE_INSTALL_LINKS[normalizedEnvironment];
  return isConfiguredMobileInstallLink(link) ? link.trim() : null;
}
