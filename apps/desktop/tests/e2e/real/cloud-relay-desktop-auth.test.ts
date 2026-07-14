import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { missingCloudSmokeEnv } from "./cloudSmokeEnv";

/**
 * Real-cloud smoke for the desktop relay credential path.
 *
 * Verifies the deployed relay can authenticate a kanna-server style desktop
 * connection from the canonical `desktopCredentials/{desktopId}` document that stores only the
 * SHA-256 hash of the desktop secret. Requires the same env credentials as
 * cloud-prod-smoke (never committed):
 *
 *   KANNA_FIREBASE_API_KEY, KANNA_FIREBASE_PROJECT_ID,
 *   KANNA_CLOUD_TEST_EMAIL, KANNA_CLOUD_TEST_PASSWORD
 *
 * Optional: KANNA_RELAY_SMOKE_URL (defaults to wss://relay.kanna.build).
 * The disposable credential is deleted in cleanup by its signed-in owner.
 */
const missingEnv = missingCloudSmokeEnv(process.env);
const relayUrl = process.env.KANNA_RELAY_SMOKE_URL?.trim() || "wss://relay.kanna.build";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for relay desktop auth smoke`);
  return value;
}

async function signInForIdToken(): Promise<{ idToken: string; localId: string }> {
  const apiKey = requireEnv("KANNA_FIREBASE_API_KEY");
  const email = requireEnv("KANNA_CLOUD_TEST_EMAIL");
  const password = requireEnv("KANNA_CLOUD_TEST_PASSWORD");
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await response.json().catch(() => null) as { idToken?: string; localId?: string } | null;
  if (!response.ok || !body?.idToken || !body.localId) {
    throw new Error(`failed to sign in relay smoke user: ${response.status} ${JSON.stringify(body)}`);
  }
  return { idToken: body.idToken, localId: body.localId };
}

function firestoreDocumentsUrl(): string {
  const projectId = requireEnv("KANNA_FIREBASE_PROJECT_ID");
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

async function createDesktopCredentialDoc(
  idToken: string,
  uid: string,
  desktopId: string,
  desktopSecretHash: string,
): Promise<string> {
  const path = `desktopCredentials/${desktopId.replaceAll("/", "_")}`;
  const response = await fetch(`${firestoreDocumentsUrl()}/${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        desktopId: { stringValue: desktopId },
        displayName: { stringValue: "Relay Smoke Desktop" },
        desktopSecretHash: { stringValue: desktopSecretHash },
        revokedAt: { nullValue: null },
        uid: { stringValue: uid },
        updatedAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  const body = await response.json().catch(() => null) as { name?: string } | null;
  if (!response.ok || typeof body?.name !== "string") {
    throw new Error(`failed to create relay smoke desktop doc: ${response.status} ${JSON.stringify(body)}`);
  }
  return path;
}

async function deleteFirestoreDocument(idToken: string, path: string): Promise<void> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${firestoreDocumentsUrl()}/${encodedPath}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`failed to delete relay smoke doc at ${path}: ${response.status} ${await response.text()}`);
  }
}

interface DesktopAuthAttempt {
  outcome: "auth_ok" | "closed";
  userId?: string;
  closeCode?: number;
}

function attemptDesktopAuth(desktopId: string, desktopSecret: string): Promise<DesktopAuthAttempt> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`relay desktop auth timed out against ${relayUrl}`));
    }, 15_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", desktop_id: desktopId, desktop_secret: desktopSecret }));
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; userId?: string };
      if (message.type === "auth_ok") {
        clearTimeout(timeout);
        ws.close(1000);
        resolve({ outcome: "auth_ok", userId: message.userId });
      }
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve({ outcome: "closed", closeCode: event.code });
    });
    ws.addEventListener("error", () => {
      // close fires afterwards with the code; nothing to do here
    });
  });
}

describe.skipIf(missingEnv.length > 0)("real relay desktop credential auth", () => {
  it("authenticates a desktop against the deployed relay via hashed credentials", async () => {
    const runId = randomUUID().slice(0, 8);
    const desktopId = `desktop-relay-smoke-${runId}`;
    const desktopSecret = randomBytes(32).toString("hex");
    const desktopSecretHash = createHash("sha256").update(desktopSecret).digest("hex");
    const { idToken, localId } = await signInForIdToken();
    let desktopPath: string | null = null;

    try {
      desktopPath = await createDesktopCredentialDoc(idToken, localId, desktopId, desktopSecretHash);

      const authenticated = await attemptDesktopAuth(desktopId, desktopSecret);
      expect(authenticated).toEqual({ outcome: "auth_ok", userId: localId });

      const rejected = await attemptDesktopAuth(desktopId, "wrong-secret");
      expect(rejected).toEqual({ outcome: "closed", closeCode: 4005 });
    } finally {
      if (desktopPath) await deleteFirestoreDocument(idToken, desktopPath).catch(() => undefined);
    }
  }, 60_000);
});
