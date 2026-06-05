import type { TrustedDesktopRecord } from "../../state/sessionPersistence";
import type { FetchLike } from "../transports/lanTransport";
import type { BonjourService } from "./bonjour";

export interface TrustedBonjourEndpoint {
  baseUrl: string;
  desktopId: string;
  displayName: string;
}

export async function resolveTrustedBonjourEndpoint(input: {
  fetchImpl: FetchLike;
  services: readonly BonjourService[];
  trustedDesktops: readonly TrustedDesktopRecord[];
  selectedDesktopId: string | null;
}): Promise<TrustedBonjourEndpoint | null> {
  for (const service of orderServices(input.services, input.selectedDesktopId)) {
    const desktopId = service.txt.desktopId;
    const trusted = input.trustedDesktops.find(
      (desktop) => desktop.desktopId === desktopId
    );
    if (!trusted) {
      continue;
    }

    const baseUrl = `http://${service.host}:${service.port}`;
    const status = await fetchStatus(baseUrl, input.fetchImpl);
    if (status?.desktopId !== trusted.desktopId) {
      continue;
    }

    return {
      baseUrl,
      desktopId: trusted.desktopId,
      displayName: trusted.displayName
    };
  }

  return null;
}

function orderServices(
  services: readonly BonjourService[],
  selectedDesktopId: string | null
): BonjourService[] {
  return [...services].sort((left, right) => {
    const leftSelected = left.txt.desktopId === selectedDesktopId ? 0 : 1;
    const rightSelected = right.txt.desktopId === selectedDesktopId ? 0 : 1;
    return leftSelected - rightSelected;
  });
}

async function fetchStatus(
  baseUrl: string,
  fetchImpl: FetchLike
): Promise<{ desktopId?: string } | null> {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/status`);
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body && typeof body === "object" ? (body as { desktopId?: string }) : null;
  } catch {
    return null;
  }
}
