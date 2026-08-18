import type { AgentProvider } from "@kanna/agent-protocol";
import { parseAgentProviderInventory } from "../api/agentProviders";
import type { FetchLike } from "../transports/lanTransport";
import type { BonjourService } from "./bonjour";

export interface TrustedBonjourEndpoint {
  baseUrl: string;
  desktopId: string;
  displayName: string;
  /** Agent provider CLIs the desktop reported on its status probe. Absent from
   * desktops that predate provider inventory. */
  agentProviders?: AgentProvider[];
}

export async function resolveTrustedBonjourEndpoint(input: {
  fetchImpl: FetchLike;
  services: readonly BonjourService[];
  trustedDesktopIds: readonly string[];
  preferredDesktopId: string | null;
  probeTimeoutMs?: number;
}): Promise<TrustedBonjourEndpoint | null> {
  const trustedDesktopIds = new Set(input.trustedDesktopIds);
  for (const service of orderServices(input.services, input.preferredDesktopId)) {
    const endpoint = await validateTrustedService(
      service,
      trustedDesktopIds,
      input.fetchImpl,
      input.probeTimeoutMs
    );
    if (endpoint) return endpoint;
  }

  return null;
}

export async function resolveTrustedBonjourEndpoints(input: {
  fetchImpl: FetchLike;
  services: readonly BonjourService[];
  trustedDesktopIds: readonly string[];
  preferredDesktopId: string | null;
  probeTimeoutMs?: number;
}): Promise<TrustedBonjourEndpoint[]> {
  const trustedDesktopIds = new Set(input.trustedDesktopIds);
  const candidates = await Promise.all(
    orderServices(input.services, input.preferredDesktopId).map((service) =>
      validateTrustedService(
        service,
        trustedDesktopIds,
        input.fetchImpl,
        input.probeTimeoutMs
      )
    )
  );
  const seenDesktopIds = new Set<string>();
  return candidates.filter((endpoint): endpoint is TrustedBonjourEndpoint => {
    if (!endpoint || seenDesktopIds.has(endpoint.desktopId)) return false;
    seenDesktopIds.add(endpoint.desktopId);
    return true;
  });
}

async function validateTrustedService(
  service: BonjourService,
  trustedDesktopIds: ReadonlySet<string>,
  fetchImpl: FetchLike,
  probeTimeoutMs?: number
): Promise<TrustedBonjourEndpoint | null> {
  const desktopId = service.txt.desktopId;
  if (!trustedDesktopIds.has(desktopId)) return null;

  const baseUrl = `http://${service.host}:${service.port}`;
  const status = await fetchStatus(baseUrl, fetchImpl, probeTimeoutMs);
  const displayName =
    typeof status?.desktopName === "string"
      ? status.desktopName.trim()
      : "";
  if (status?.desktopId !== desktopId || !displayName) return null;
  const agentProviders = parseAgentProviderInventory(status.agentProviders);
  return {
    baseUrl,
    desktopId,
    displayName,
    ...(agentProviders ? { agentProviders } : {})
  };
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
  fetchImpl: FetchLike,
  timeoutMs = 5_000
): Promise<{
  desktopId?: unknown;
  desktopName?: unknown;
  agentProviders?: unknown;
} | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const response = await Promise.race([
      fetchImpl(`${baseUrl}/v1/status`, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("LAN status probe timed out"));
        }, timeoutMs);
      })
    ]);
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body && typeof body === "object"
      ? (body as {
          desktopId?: unknown;
          desktopName?: unknown;
          agentProviders?: unknown;
        })
      : null;
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
