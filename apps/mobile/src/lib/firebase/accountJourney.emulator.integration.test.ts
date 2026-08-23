import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getApps } from "firebase/app";
import { applyActionCode, getAuth } from "firebase/auth";
import { createAppModel } from "../../appModel";
import { createStaticBonjourBrowser } from "../discovery/bonjour";
import type { RelayDesktopClient } from "../transports/relayClient";
import { createConfiguredMobileAuthSession } from "./sdk";

const run = process.env.KANNA_RUN_MOBILE_FIREBASE_ACCOUNT_INTEGRATION === "1";
const integration = run ? describe : describe.skip;
const projectId = "kanna-local";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;

interface OutOfBandCode {
  email: string;
  oobCode: string;
  requestType: string;
}

function requireEmulatorHost(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function clearEmulators(): Promise<void> {
  const auth = requireEmulatorHost(authHost, "FIREBASE_AUTH_EMULATOR_HOST");
  const firestore = requireEmulatorHost(firestoreHost, "FIRESTORE_EMULATOR_HOST");
  const responses = await Promise.all([
    fetch(`http://${auth}/emulator/v1/projects/${projectId}/accounts`, {
      method: "DELETE"
    }),
    fetch(
      `http://${firestore}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
      { method: "DELETE" }
    )
  ]);
  for (const response of responses) {
    if (!response.ok) {
      throw new Error(`Could not reset Firebase emulator: ${response.status}`);
    }
  }
}

async function verificationCode(email: string): Promise<string> {
  const auth = requireEmulatorHost(authHost, "FIREBASE_AUTH_EMULATOR_HOST");
  const response = await fetch(
    `http://${auth}/emulator/v1/projects/${projectId}/oobCodes`
  );
  const body = (await response.json()) as { oobCodes?: OutOfBandCode[] };
  const code = body.oobCodes?.find(
    (candidate) =>
      candidate.email === email && candidate.requestType === "VERIFY_EMAIL"
  );
  if (!code) throw new Error(`No verification code was issued for ${email}`);
  return code.oobCode;
}

async function seedCloudAccess(uid: string, status: "active" | "inactive"): Promise<void> {
  const firestore = requireEmulatorHost(firestoreHost, "FIRESTORE_EMULATOR_HOST");
  const response = await fetch(
    `http://${firestore}/v1/projects/${projectId}/databases/(default)/documents/users/${uid}/entitlements/cloud_access`,
    {
      method: "PATCH",
      headers: {
        Authorization: "Bearer owner",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: { status: { stringValue: status } } })
    }
  );
  if (!response.ok) {
    throw new Error(`Could not seed cloud entitlement: ${response.status} ${await response.text()}`);
  }
}

function createRelayClient(): RelayDesktopClient {
  return {
    close: vi.fn(),
    invokeDesktop: vi.fn().mockResolvedValue(null),
    observeTaskTerminal: vi.fn(() => ({ close: vi.fn() })),
    observeTaskAgent: vi.fn(() => ({
      close: vi.fn(),
      sendInput: vi.fn(),
      sendPermission: vi.fn(),
      interrupt: vi.fn()
    })),
    sendTaskInput: vi.fn().mockResolvedValue(undefined),
    listActiveDesktopIds: vi.fn().mockResolvedValue(new Set<string>())
  };
}

integration("mobile Firebase account journey", () => {
  beforeAll(async () => {
    await clearEmulators();
    const firestore = requireEmulatorHost(
      firestoreHost,
      "FIRESTORE_EMULATOR_HOST"
    );
    const [firestoreHostName, firestorePort] = firestore.split(":");
    process.env.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST = firestoreHostName;
    process.env.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT = firestorePort;
  });

  afterAll(async () => {
    await clearEmulators();
  });

  it("creates, verifies, refreshes credentials, and reads inactive then active access", async () => {
    const authEmulator = requireEmulatorHost(
      authHost,
      "FIREBASE_AUTH_EMULATOR_HOST"
    );
    const [authHostName, authPortText] = authEmulator.split(":");
    if (!authHostName || !authPortText) throw new Error("Invalid Auth emulator host");
    const session = createConfiguredMobileAuthSession({
      app: {
        apiKey: projectId,
        authDomain: `${projectId}.firebaseapp.com`,
        projectId,
        appId: "kanna-mobile-account-integration"
      },
      authEmulator: {
        host: authHostName,
        port: Number(authPortText),
        url: `http://${authEmulator}`
      },
      firestoreEmulator: {
        host: requireEmulatorHost(
          process.env.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST,
          "EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST"
        ),
        port: Number(process.env.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT)
      }
    });
    await session.initialize();
    const relayClients: RelayDesktopClient[] = [];
    const appModel = createAppModel({
      authSession: session,
      persistence: {
        load: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined)
      },
      options: {
        forceCloud: true,
        relayUrl: "wss://relay.integration.test",
        bonjourBrowser: createStaticBonjourBrowser([]),
        taskIndex: {
          listDesktops: vi.fn().mockResolvedValue([]),
          listRecentTasks: vi.fn().mockResolvedValue([]),
          subscribeRecentTasks: vi.fn(() => vi.fn())
        },
        createRelayClient: () => {
          const client = createRelayClient();
          relayClients.push(client);
          return client;
        }
      }
    });
    await appModel.initialize();
    const email = `mobile-${Date.now()}@example.test`;

    await session.createUserWithEmailPassword({
      email,
      password: "correct-horse-battery-staple"
    });
    expect(session.getState()).toMatchObject({
      status: "signedIn",
      user: { email, emailVerified: false, cloudAccess: "inactive" }
    });
    expect(relayClients).toHaveLength(1);
    const unverifiedRelay = relayClients[0];

    const app = getApps()[0];
    if (!app) throw new Error("Firebase app was not initialized");
    await applyActionCode(getAuth(app), await verificationCode(email));
    await appModel.controller.refreshAccount();

    const verifiedState = appModel.sessionStore.getState().auth;
    expect(verifiedState).toMatchObject({
      status: "signedIn",
      user: { emailVerified: true, cloudAccess: "inactive" }
    });
    expect(relayClients).toHaveLength(2);
    expect(unverifiedRelay?.close).toHaveBeenCalledOnce();
    const uid = verifiedState.status === "signedIn" ? verifiedState.user.uid : null;
    if (!uid) throw new Error("Verified account UID was unavailable");
    const token = await session.getIdToken();
    const payload = token?.split(".")[1];
    expect(payload).toBeDefined();
    expect(
      JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))
    ).toMatchObject({ email_verified: true, user_id: uid });

    await seedCloudAccess(uid, "active");
    await appModel.controller.refreshAccount();
    expect(appModel.sessionStore.getState().auth).toMatchObject({
      status: "signedIn",
      user: { emailVerified: true, cloudAccess: "active" }
    });
  });
});
