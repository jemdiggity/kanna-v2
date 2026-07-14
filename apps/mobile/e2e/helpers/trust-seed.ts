import type { Browser } from "webdriverio";

export interface TrustedDesktopSeed {
  desktopId: string;
  displayName: string;
  lanBaseUrl?: string;
}

export async function seedTrustedDesktopThroughDeepLink(input: {
  bundleId: string;
  driver: Browser;
  desktop: TrustedDesktopSeed;
  selectedRepoId?: string;
  selectedTaskId?: string;
}): Promise<void> {
  let url =
    `kanna://e2e-trust?desktopId=${encodeURIComponent(input.desktop.desktopId)}` +
    `&displayName=${encodeURIComponent(input.desktop.displayName)}`;
  if (input.desktop.lanBaseUrl) {
    url += `&lanBaseUrl=${encodeURIComponent(input.desktop.lanBaseUrl)}`;
  }
  if (input.selectedRepoId) {
    url += `&selectedRepoId=${encodeURIComponent(input.selectedRepoId)}`;
  }
  if (input.selectedTaskId) {
    url += `&selectedTaskId=${encodeURIComponent(input.selectedTaskId)}`;
  }
  await input.driver.execute("mobile: deepLink", {
    bundleId: input.bundleId,
    url
  });
}
