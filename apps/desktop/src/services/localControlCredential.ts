import { invoke } from "../invoke";

/**
 * This webview is a browser. It reaches `kanna-server` over the same loopback
 * port any page the user opens can reach, so the server no longer treats a
 * loopback address as authority on its own — a browser-originated request must
 * present this desktop's local control credential instead. The credential
 * lives in a 0600 file only a process running as the user can read, which the
 * Tauri side hands us; a cross-origin page has no way to obtain it.
 *
 * See `crates/kanna-server/src/http_api/lan_trust.rs` and
 * `docs/kanna-server-boundary.md`.
 */
let cached: string | null = null;
let inFlight: Promise<string> | null = null;

export async function localControlCredential(forceRefresh = false): Promise<string> {
  if (forceRefresh) {
    cached = null;
    inFlight = null;
  }
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = invoke<string>("local_control_credential")
    .then((token) => {
      cached = token;
      return token;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Authorization header for a `kanna-server` request from this webview.
 *
 * A failure to read the credential is not fatal here: the request proceeds
 * unauthenticated and the server answers with the boundary's own 403, which is
 * a far more diagnosable failure than a thrown error inside every caller's
 * retry loop.
 */
export async function localControlAuthHeaders(): Promise<Record<string, string>> {
  try {
    return { Authorization: `Bearer ${await localControlCredential()}` };
  } catch (error) {
    console.debug("[runtime] local control credential unavailable:", error);
    return {};
  }
}

export function resetLocalControlCredentialForTests(): void {
  cached = null;
  inFlight = null;
}
