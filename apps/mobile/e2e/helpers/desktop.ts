import { networkInterfaces } from "node:os";
import { localProcessFetch, type LocalProcessFetch } from "./local-process-fetch";

type FetchLike = LocalProcessFetch;

type MobileE2eTarget = "simulator" | "device";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function selectPreferredLanAddress(): string | undefined {
  const interfaces = networkInterfaces();
  const preferredInterfaceNames = ["en0", "en1", "bridge100"];

  for (const interfaceName of preferredInterfaceNames) {
    const entries = interfaces[interfaceName];
    const ipv4Address = entries?.find(
      (entry) => entry.family === "IPv4" && entry.internal === false
    )?.address;

    if (ipv4Address) {
      return ipv4Address;
    }
  }

  for (const entries of Object.values(interfaces)) {
    const ipv4Address = entries?.find(
      (entry) => entry.family === "IPv4" && entry.internal === false
    )?.address;

    if (ipv4Address) {
      return ipv4Address;
    }
  }

  return undefined;
}

export function resolveDesktopServerUrlForTarget(
  baseUrl: string,
  target: MobileE2eTarget,
  resolveLanAddress: () => string | undefined = selectPreferredLanAddress
): string {
  if (target !== "device") {
    return baseUrl;
  }

  const parsedUrl = new URL(baseUrl);
  if (!isLoopbackHostname(parsedUrl.hostname)) {
    return baseUrl;
  }

  const lanAddress = resolveLanAddress();
  if (!lanAddress) {
    throw new Error(
      `Could not determine a host LAN IP address for physical-device mobile E2E. ` +
        `Connect the phone to the same network as this Mac or set KANNA_MOBILE_SERVER_HOST.`
    );
  }

  parsedUrl.hostname = lanAddress;
  return parsedUrl.toString().replace(/\/$/, "");
}

export async function assertDesktopServerReachable(
  baseUrl: string,
  fetchImpl: FetchLike = localProcessFetch
): Promise<void> {
  const statusUrl = `${baseUrl}/v1/status`;

  try {
    const response = await fetchImpl(statusUrl);
    if (!response.ok) {
      throw new Error(`Desktop mobile server check failed for ${statusUrl}: ${response.status}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Desktop mobile server check failed")) {
      throw error;
    }

    const wrappedError = new Error(`Desktop mobile server check failed for ${statusUrl}`);
    Object.assign(wrappedError, { cause: error });
    throw wrappedError;
  }
}

export async function readDesktopIdentity(
  baseUrl: string,
  fetchImpl: FetchLike = localProcessFetch
): Promise<{ desktopId: string; desktopName: string }> {
  const statusUrl = `${baseUrl}/v1/status`;
  const response = await fetchImpl(statusUrl);
  if (!response.ok) {
    throw new Error(`Desktop mobile server check failed for ${statusUrl}: ${response.status}`);
  }

  const body = (await response.json()) as {
    desktopId?: string;
    desktopName?: string;
  };
  if (!body.desktopId || !body.desktopName) {
    throw new Error("Desktop status did not include desktopId and desktopName.");
  }

  return {
    desktopId: body.desktopId,
    desktopName: body.desktopName
  };
}
