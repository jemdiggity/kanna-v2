import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tauriInvoke } from "../helpers/vue";
import { WebDriverClient } from "../helpers/webdriver";

interface MobileServerStatus {
  desktopId?: string;
  desktopName?: string;
  pairingCode?: string | null;
  state?: string;
}

interface DesktopCloudCredential {
  desktopId?: string;
  desktopSecretHash?: string;
}

interface RelayMessage extends Record<string, unknown> {
  data?: unknown;
  id?: unknown;
  type?: unknown;
}

const client = new WebDriverClient();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for mobile pairing UI E2E`);
  }
  return value;
}

async function setSetupState(key: string, value: unknown): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const key = ${JSON.stringify(key)};
    const value = ${JSON.stringify(value)};
    if (ctx[key]?.__v_isRef) ctx[key].value = value;
    else ctx[key] = value;
  `);
}

interface AuthSession {
  idToken: string;
  localId: string;
}

async function signInForAuthSession(): Promise<AuthSession> {
  const authPort = requireEnv("KANNA_FIREBASE_AUTH_PORT");
  const response = await fetch(
    `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "upvote.sieve.7t@icloud.com",
        password: "password123",
        returnSecureToken: true
      })
    }
  );
  const body = await response.json().catch(() => null) as { idToken?: string; localId?: string } | null;
  if (!response.ok || !body?.idToken || !body.localId) {
    throw new Error(`failed to sign into auth emulator: ${response.status} ${JSON.stringify(body)}`);
  }
  return { idToken: body.idToken, localId: body.localId };
}

function firestoreDocumentsUrl(): string {
  return `http://127.0.0.1:${requireEnv("KANNA_FIREBASE_FIRESTORE_PORT")}/v1/projects/kanna-local/databases/(default)/documents`;
}

async function createDesktopCredentialDoc(
  auth: AuthSession,
  status: MobileServerStatus,
  credential: DesktopCloudCredential
): Promise<string> {
  if (!status.desktopId || !credential.desktopId || !credential.desktopSecretHash) {
    throw new Error(
      `desktop credential status is incomplete: status=${JSON.stringify(status)} credential=${JSON.stringify(credential)}`
    );
  }
  if (credential.desktopId !== status.desktopId) {
    throw new Error(`desktop credential id ${credential.desktopId} did not match status id ${status.desktopId}`);
  }

  const path = `desktopCredentials/${status.desktopId.replaceAll("/", "_")}`;
  const response = await fetch(
    `${firestoreDocumentsUrl()}/${path}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${auth.idToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fields: {
          desktopId: { stringValue: status.desktopId },
          displayName: { stringValue: status.desktopName || "Kanna E2E Desktop" },
          desktopSecretHash: { stringValue: credential.desktopSecretHash },
          revokedAt: { nullValue: null },
          uid: { stringValue: auth.localId },
          updatedAt: { stringValue: new Date().toISOString() }
        }
      })
    }
  );
  const body = await response.json().catch(() => null) as { name?: string } | null;
  if (!response.ok || typeof body?.name !== "string") {
    throw new Error(`failed to create relay desktop doc: ${response.status} ${JSON.stringify(body)}`);
  }
  return path;
}

async function deleteFirestoreDocument(idToken: string, path: string): Promise<void> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${firestoreDocumentsUrl()}/${encodedPath}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`failed to delete Firestore document ${path}: ${response.status} ${await response.text()}`);
  }
}

function relayUrl(): string {
  const configured = process.env.KANNA_RELAY_URL?.trim();
  if (configured) {
    return configured;
  }
  return `ws://127.0.0.1:${requireEnv("KANNA_RELAY_PORT")}`;
}

async function connectPhoneRelay(): Promise<WebSocket> {
  const socket = new WebSocket(relayUrl());
  await waitForSocketOpen(socket);
  socket.send(JSON.stringify({
    type: "auth",
    id_token: (await signInForAuthSession()).idToken
  }));
  await waitForRelayMessage(socket, (message) => message.type === "auth_ok");
  return socket;
}

async function listActiveDesktopIds(socket: WebSocket): Promise<string[]> {
  const id = `list-active-${Date.now()}`;
  socket.send(JSON.stringify({
    type: "invoke",
    id,
    command: "list_active_desktops"
  }));
  const response = await waitForRelayMessage(
    socket,
    (message) => message.type === "response" && message.id === id
  );
  const data = response.data;
  if (!isRecord(data) || !Array.isArray(data.desktopIds)) {
    throw new Error(`relay returned invalid active desktops response: ${JSON.stringify(response)}`);
  }
  return data.desktopIds.filter((desktopId): desktopId is string => typeof desktopId === "string");
}

async function waitForActiveDesktop(desktopId: string): Promise<void> {
  const socket = await connectPhoneRelay();
  try {
    const deadline = Date.now() + 15_000;
    let lastIds: string[] = [];
    while (Date.now() < deadline) {
      lastIds = await listActiveDesktopIds(socket);
      if (lastIds.includes(desktopId)) {
        return;
      }
      await sleep(250);
    }
    throw new Error(`timed out waiting for relay desktop ${desktopId}; active=${JSON.stringify(lastIds)}`);
  } finally {
    socket.close();
  }
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectOpen(new Error("timed out opening relay websocket"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolveOpen();
    };
    const onError = () => {
      cleanup();
      rejectOpen(new Error("relay websocket failed before open"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

async function waitForRelayMessage(
  socket: WebSocket,
  predicate: (message: RelayMessage) => boolean
): Promise<RelayMessage> {
  await waitForSocketOpen(socket);
  return await new Promise<RelayMessage>((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error("timed out waiting for relay message"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      const message = parseRelayMessage(event.data);
      if (!message || !predicate(message)) {
        return;
      }
      cleanup();
      resolveMessage(message);
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      rejectMessage(new Error(`relay websocket closed while waiting for message: ${event.code}`));
    };
    const onError = () => {
      cleanup();
      rejectMessage(new Error("relay websocket failed while waiting for message"));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

function parseRelayMessage(data: unknown): RelayMessage | null {
  const raw = data instanceof ArrayBuffer
    ? Buffer.from(data).toString("utf8")
    : typeof data === "string"
      ? data
      : String(data);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("mobile pairing UI", () => {
  beforeAll(async () => {
    await client.createSession();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("starts pairing and registers this desktop online with the relay", async () => {
    await setSetupState("showPreferencesPanel", true);
    await client.waitForElement(".prefs-panel");
    await client.click(await client.waitForElement('[data-testid="preferences-mobile-tab"]'));

    const panel = await client.waitForElement('[data-testid="mobile-access-panel"]');
    expect(await client.getText(panel)).toContain("Mobile Access");
    await client.click(await client.waitForElement('[data-testid="mobile-access-start-pairing"]'));

    const codeElement = await client.waitForElement('[data-testid="mobile-access-pairing-code"]', 10_000);
    const pairingCode = (await client.getText(codeElement)).trim();
    expect(pairingCode).toMatch(/^[A-Z0-9]{6}$/);

    const statusElement = await client.waitForElement('[data-testid="mobile-access-status"]');
    expect(await client.getText(statusElement)).toBe("Online");

    const status = await tauriInvoke(client, "mobile_server_status") as MobileServerStatus;
    expect(status.state).toBe("running");
    // The one-time code is held by the Preferences pairing session, not
    // re-exposed by the general server-status surface.
    expect(status.pairingCode).toBeNull();
    expect(status.desktopId).toEqual(expect.any(String));

    const auth = await signInForAuthSession();
    const credential = await tauriInvoke(client, "desktop_cloud_credential") as DesktopCloudCredential;
    const desktopPath = await createDesktopCredentialDoc(auth, status, credential);
    try {
      await waitForActiveDesktop(status.desktopId!);
    } finally {
      await deleteFirestoreDocument(auth.idToken, desktopPath).catch(() => undefined);
    }
  }, 45_000);
});
