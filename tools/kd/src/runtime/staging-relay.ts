import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readStagingDesktopAuth, type DeveloperCredentials } from "./developer-config";

export interface StagingRelayActiveDesktopIdsInput {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  relayUrl: string;
}

export interface FirebasePasswordCredentials {
  email: string;
  password: string;
}

interface KdWebSocketMessageEvent {
  data?: unknown;
}

interface KdWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: KdWebSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type KdWebSocketCtor = new (url: string) => KdWebSocket;

export async function readMobileFirebaseApiKey(repoRoot: string, environment: "staging" | "prod"): Promise<string> {
  const raw = await readFile(join(repoRoot, "apps", "mobile", "src", "mobileEnvironments.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, { firebase?: { apiKey?: unknown } } | undefined>;
  const apiKey = parsed[environment]?.firebase?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error(`Missing Firebase apiKey for ${environment} in apps/mobile/src/mobileEnvironments.json.`);
  }
  return apiKey;
}

export async function fetchFirebaseIdToken(
  apiKey: string,
  credentials: FirebasePasswordCredentials
): Promise<string> {
  const fetchFn = (globalThis as unknown as {
    fetch?: typeof fetch;
  }).fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("Node fetch is not available; cannot verify staging relay active desktops.");
  }

  const response = await fetchFn(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
        returnSecureToken: true
      })
    }
  );
  if (!response.ok) {
    throw new Error(`Firebase sign-in failed while verifying staging relay active desktops: HTTP ${response.status}`);
  }

  const body = await response.json() as { idToken?: unknown };
  if (typeof body.idToken !== "string" || !body.idToken) {
    throw new Error("Firebase sign-in did not return an idToken.");
  }
  return body.idToken;
}

function parseRelayActiveDesktopIdsResponse(payload: unknown): Set<string> | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { data?: unknown };
  const data = record.data;
  if (!data || typeof data !== "object") return null;
  const desktopIds = (data as { desktopIds?: unknown }).desktopIds;
  if (!Array.isArray(desktopIds)) return null;
  return new Set(
    desktopIds.filter((desktopId): desktopId is string => typeof desktopId === "string" && desktopId.length > 0)
  );
}

export async function listRelayActiveDesktopIds(input: {
  idToken: string;
  relayUrl: string;
}): Promise<Set<string>> {
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: KdWebSocketCtor }).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("Node WebSocket is not available; cannot verify staging relay active desktops.");
  }

  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocketCtor(input.relayUrl);
    let authenticated = false;
    let finished = false;
    const timeout = setTimeout(() => {
      fail(new Error("Timed out while verifying staging relay active desktops."));
    }, 10_000);
    const finish = (result: Set<string>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      ws.close();
      resolvePromise(result);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      ws.close();
      reject(error);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", id_token: input.idToken }));
    };
    ws.onerror = () => {
      fail(new Error("Relay WebSocket failed while verifying staging relay active desktops."));
    };
    ws.onclose = () => {
      if (!authenticated) {
        fail(new Error("Relay WebSocket closed before authentication completed."));
      }
    };
    ws.onmessage = (event) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(event.data ?? ""));
      } catch {
        return;
      }

      const message = payload as { type?: unknown; id?: unknown; error?: unknown; message?: unknown };
      if (message.type === "auth_ok") {
        authenticated = true;
        ws.send(JSON.stringify({
          type: "invoke",
          id: "kd-active-desktops",
          command: "list_active_desktops",
          args: {}
        }));
        return;
      }

      if (message.type === "error") {
        fail(new Error(typeof message.message === "string" ? message.message : "Relay returned an error."));
        return;
      }

      if (message.type === "response" && message.id === "kd-active-desktops") {
        if (typeof message.error === "string" && message.error) {
          fail(new Error(message.error));
          return;
        }
        const ids = parseRelayActiveDesktopIdsResponse(payload);
        if (!ids) {
          fail(new Error("Relay list_active_desktops returned invalid data."));
          return;
        }
        finish(ids);
      }
    };
  });
}

export async function listStagingRelayActiveDesktopIds(input: StagingRelayActiveDesktopIdsInput): Promise<Set<string>> {
  const credentials: DeveloperCredentials = readStagingDesktopAuth(input.env.HOME?.trim());
  const apiKey = await readMobileFirebaseApiKey(input.repoRoot, "staging");
  const idToken = await fetchFirebaseIdToken(apiKey, credentials);
  return listRelayActiveDesktopIds({
    idToken,
    relayUrl: input.relayUrl
  });
}
