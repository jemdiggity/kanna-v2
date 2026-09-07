import { localProcessFetch, type LocalProcessFetch } from "@kanna/local-process-fetch";

export interface DesktopPairingSession {
  code: string;
  desktopId: string;
  desktopName: string;
  pairingPayload: string;
  lanHost: string;
  lanPort: number;
  expiresAtUnixMs: number;
}

export async function createDesktopPairingSession(
  baseUrl: string,
  fetchImpl: LocalProcessFetch = localProcessFetch,
): Promise<DesktopPairingSession> {
  const response = await fetchImpl(`${baseUrl}/v1/pairing/sessions`, {
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`desktop pairing failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
  const pairing = JSON.parse(body) as Partial<DesktopPairingSession>;
  if (!pairing.code || !pairing.desktopId || !pairing.desktopName) {
    throw new Error("desktop pairing returned an incomplete response");
  }
  return pairing as DesktopPairingSession;
}
