import { afterEach, describe, expect, it } from "vitest";

const PROJECT_ID = "kanna-local";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = firestoreHost ? describe : describe.skip;

interface FirestoreValue {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  nullValue?: null;
  mapValue?: { fields: FirestoreFields };
}

interface FirestoreFields {
  [key: string]: FirestoreValue;
}

interface FirestoreDocument {
  fields?: FirestoreFields;
}

function baseUrl(): string {
  if (!firestoreHost) {
    throw new Error("FIRESTORE_EMULATOR_HOST is required for firestore rules tests");
  }
  return `http://${firestoreHost}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
}

function emulatorUrl(): string {
  if (!firestoreHost) {
    throw new Error("FIRESTORE_EMULATOR_HOST is required for firestore rules tests");
  }
  return `http://${firestoreHost}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
}

function mockUserToken(uid: string): string {
  const iat = 0;
  const header = { alg: "none", type: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    iat,
    exp: iat + 3600,
    auth_time: iat,
    sub: uid,
    user_id: uid,
    firebase: {
      sign_in_provider: "custom",
      identities: {},
    },
  };
  return `${base64UrlJson(header)}.${base64UrlJson(payload)}.`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function toFirestoreValue(value: unknown): FirestoreValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  if (value === null) return { nullValue: null };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
  }
  throw new Error(`Unsupported Firestore test value: ${String(value)}`);
}

function toFirestoreFields(data: Record<string, unknown>): FirestoreFields {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)]));
}

async function clearFirestore(): Promise<void> {
  const response = await fetch(emulatorUrl(), { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Failed to clear Firestore emulator: ${response.status} ${await response.text()}`);
  }
}

async function seedDoc(path: string, data: Record<string, unknown>): Promise<Response> {
  return writeDoc("owner", path, data);
}

async function clientUpdate(uid: string, path: string, data: Record<string, unknown>): Promise<Response> {
  return writeDoc(mockUserToken(uid), path, data, Object.keys(data));
}

async function writeDoc(
  bearerToken: string,
  path: string,
  data: Record<string, unknown>,
  updateMask: string[] = []
): Promise<Response> {
  const url = new URL(`${baseUrl()}/${path}`);
  for (const field of updateMask) {
    url.searchParams.append("updateMask.fieldPaths", field);
  }
  return fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) } satisfies FirestoreDocument),
  });
}

async function readDoc(bearerToken: string, path: string): Promise<Response> {
  return fetch(`${baseUrl()}/${path}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
}

async function deleteDoc(uid: string, path: string): Promise<Response> {
  return fetch(`${baseUrl()}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${mockUserToken(uid)}` },
  });
}

async function expectSucceeds(response: Promise<Response>): Promise<Response> {
  const resolved = await response;
  expect(resolved.status).toBeGreaterThanOrEqual(200);
  expect(resolved.status).toBeLessThan(300);
  return resolved;
}

async function expectDenied(response: Promise<Response>): Promise<Response> {
  const resolved = await response;
  expect(resolved.status).toBe(403);
  return resolved;
}

describeWithEmulator("firestore security rules", () => {
  afterEach(async () => {
    await clearFirestore();
  });

  it("allows authenticated users to update only expected profile fields on their own user document", async () => {
    await seedDoc("users/alice", {
      createdAt: "2026-05-01T00:00:00.000Z",
      primaryEmail: "alice@example.com",
    });

    await expectSucceeds(
      clientUpdate("alice", "users/alice", {
        displayName: "Alice",
        photoURL: "https://example.com/alice.png",
        locale: "en",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );

    const response = await expectSucceeds(readDoc("owner", "users/alice"));
    const document = (await response.json()) as FirestoreDocument;
    expect(document.fields).toMatchObject({
      displayName: { stringValue: "Alice" },
      photoURL: { stringValue: "https://example.com/alice.png" },
      locale: { stringValue: "en" },
      updatedAt: { stringValue: "2026-05-08T00:00:00.000Z" },
    });
  });

  it("denies updates to other users", async () => {
    await seedDoc("users/bob", { createdAt: "2026-05-01T00:00:00.000Z" });

    await expectDenied(
      clientUpdate("alice", "users/bob", {
        displayName: "Alice",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
  });

  it("denies user updates that include secret or admin fields", async () => {
    await seedDoc("users/alice", { createdAt: "2026-05-01T00:00:00.000Z" });

    await expectDenied(
      clientUpdate("alice", "users/alice", {
        displayName: "Alice",
        isAdmin: true,
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
    await expectDenied(
      clientUpdate("alice", "users/alice", {
        desktopSecret: "secret",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
  });

  it("denies user updates outside the expected profile field set", async () => {
    await seedDoc("users/alice", {
      createdAt: "2026-05-01T00:00:00.000Z",
      primaryEmail: "alice@example.com",
    });

    await expectDenied(
      clientUpdate("alice", "users/alice", {
        primaryEmail: "new-alice@example.com",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
  });

  it("keeps desktopPresence direct client reads and writes denied while privileged server writes bypass rules", async () => {
    await expectSucceeds(
      seedDoc("desktopPresence/desktop-1", {
        uid: "alice",
        online: true,
        reachableViaRelay: true,
        lastSeenAt: "2026-05-08T00:00:00.000Z",
        brokerConnectionId: "broker-1",
      })
    );

    await expectDenied(readDoc(mockUserToken("alice"), "desktopPresence/desktop-1"));
    await expectDenied(
      clientUpdate("alice", "desktopPresence/desktop-1", {
        uid: "alice",
        online: false,
        reachableViaRelay: false,
        lastSeenAt: "2026-05-08T00:01:00.000Z",
        brokerConnectionId: "broker-2",
      })
    );
  });

  it("allows users to manage their own desktop task snapshots but keeps flat task writes denied", async () => {
    await seedDoc("users/user-1/desktops/desktop-doc-1/tasks/task-doc-1", {
      cloudTaskId: "cloud-task-1",
      ownerDesktopId: "desktop-1",
      localRepoId: "repo-1",
      ownerLocalTaskId: "task-1",
      title: "Cloud task",
    });

    await expectSucceeds(readDoc(mockUserToken("user-1"), "users/user-1/desktops/desktop-doc-1/tasks/task-doc-1"));
    await expectDenied(readDoc(mockUserToken("user-2"), "users/user-1/desktops/desktop-doc-1/tasks/task-doc-1"));
    await expectSucceeds(
      clientUpdate("user-1", "users/user-1/desktops/desktop-doc-2", {
        desktopId: "desktop-2",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
    await expectSucceeds(
      clientUpdate("user-1", "users/user-1/desktops/desktop-doc-2/tasks/task-doc-2", {
        cloudTaskId: "cloud-task-2",
        ownerDesktopId: "desktop-2",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-2",
        title: "Cloud task 2",
      })
    );
    await expectSucceeds(deleteDoc("user-1", "users/user-1/desktops/desktop-doc-2/tasks/task-doc-2"));
    await expectDenied(
      clientUpdate("user-2", "users/user-1/desktops/desktop-doc-3", {
        desktopId: "desktop-3",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
    await expectDenied(
      clientUpdate("user-1", "users/user-1/tasks/cloud-task-2", { title: "spoofed" })
    );
  });
});
