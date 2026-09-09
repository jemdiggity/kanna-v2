import { getCurrentBuildIdentity, type BuildIdentity } from "./buildIdentity";
import type { FetchLike, LanDeviceCredentials } from "../transports/lanTransport";

/** Best effort alongside trusted LAN connection setup, independent of push permission. */
export async function reportMobileBuild(
  baseUrl: string,
  fetchImpl: FetchLike,
  credentials: LanDeviceCredentials,
  readIdentity: () => BuildIdentity = getCurrentBuildIdentity
): Promise<void> {
  try {
    const identity = readIdentity();
    const known = (value: string) => value === "Unknown" ? null : value;
    const response = await fetchImpl(`${baseUrl}/v1/mobile/build`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kanna-Device-Id": credentials.deviceId,
        "X-Kanna-Device-Secret": credentials.deviceSecret
      },
      body: JSON.stringify({
        environment: identity.environment,
        channel: identity.channel,
        runtimeVersion: identity.source.kind === "development" ? null : known(identity.runtimeVersion),
        nativeVersion: known(identity.nativeVersion),
        nativeBuild: known(identity.nativeBuild),
        updateId: identity.source.kind === "ota" ? identity.source.updateId : null,
        source: identity.source.kind
      })
    });
    if (!response.ok) console.warn(`Mobile build report unavailable (${response.status}).`);
  } catch {
    // An older/offline desktop must not prevent connection or pairing refresh.
    console.warn("Mobile build report unavailable.");
  }
}
