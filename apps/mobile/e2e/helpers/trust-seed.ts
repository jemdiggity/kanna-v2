import type { Browser } from "webdriverio";

export interface TrustedDesktopSeed {
  desktopId: string;
  displayName: string;
}

export async function seedTrustedDesktopThroughDeepLink(input: {
  bundleId: string;
  driver: Browser;
  desktop: TrustedDesktopSeed;
}): Promise<void> {
  const url =
    `kanna://e2e-trust?desktopId=${encodeURIComponent(input.desktop.desktopId)}` +
    `&displayName=${encodeURIComponent(input.desktop.displayName)}`;
  await input.driver.execute("mobile: deepLink", {
    bundleId: input.bundleId,
    url
  });
}
