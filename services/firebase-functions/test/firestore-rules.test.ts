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

function mockUserToken(uid: string, email?: string): string {
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
    ...(email ? { email } : {}),
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

async function clientUpdate(uid: string, path: string, data: Record<string, unknown>, email?: string): Promise<Response> {
  return writeDoc(mockUserToken(uid, email), path, data, Object.keys(data));
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

async function deleteDocAsOwner(path: string): Promise<Response> {
  return fetch(`${baseUrl()}/${path}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer owner" },
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
        primaryEmail: "alice@example.com",
        updatedAt: "2026-05-08T00:00:00.000Z",
      }, "alice@example.com")
    );

    const response = await expectSucceeds(readDoc("owner", "users/alice"));
    const document = (await response.json()) as FirestoreDocument;
    expect(document.fields).toMatchObject({
      displayName: { stringValue: "Alice" },
      photoURL: { stringValue: "https://example.com/alice.png" },
      locale: { stringValue: "en" },
      primaryEmail: { stringValue: "alice@example.com" },
      updatedAt: { stringValue: "2026-05-08T00:00:00.000Z" },
    });
  });

  it("allows authenticated users to create their own user document with their email address", async () => {
    await expectSucceeds(
      clientUpdate("alice", "users/alice", {
        primaryEmail: "alice@example.com",
        updatedAt: "2026-05-08T00:00:00.000Z",
      }, "alice@example.com")
    );
  });

  it("fences cached owner writes once account deletion commits", async () => {
    const profile = {
      primaryEmail: "alice@example.com",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };
    const credential = {
      desktopId: "desktop-1",
      desktopSecretHash: "hash-1",
      displayName: "Alice Mac",
      revokedAt: null,
      uid: "alice",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };

    // Writes committed before the tombstone are allowed and remain eligible
    // for the deletion sweep.
    await expectSucceeds(clientUpdate("alice", "users/alice", profile, "alice@example.com"));
    await expectSucceeds(clientUpdate("alice", "desktopCredentials/desktop-1", credential));
    await expectSucceeds(seedDoc("accountDeletions/alice", { uid: "alice", started: true }));
    await expectSucceeds(deleteDocAsOwner("users/alice"));
    await expectSucceeds(deleteDocAsOwner("desktopCredentials/desktop-1"));

    // The same still-cached token cannot commit either direct desktop write
    // after the durable deletion fence exists.
    await expectDenied(clientUpdate("alice", "users/alice", profile, "alice@example.com"));
    await expectDenied(clientUpdate("alice", "desktopCredentials/desktop-1", credential));
    expect((await readDoc("owner", "users/alice")).status).toBe(404);
    expect((await readDoc("owner", "desktopCredentials/desktop-1")).status).toBe(404);
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

  it("denies user updates that spoof a different primary email", async () => {
    await seedDoc("users/alice", {
      createdAt: "2026-05-01T00:00:00.000Z",
      primaryEmail: "alice@example.com",
    });

    await expectDenied(
      clientUpdate("alice", "users/alice", {
        primaryEmail: "new-alice@example.com",
        updatedAt: "2026-05-08T00:00:00.000Z",
      }, "alice@example.com")
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

  it("allows a new owner to reclaim only a revoked canonical credential with the same secret hash", async () => {
    await expectSucceeds(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac",
        revokedAt: null,
        uid: "alice",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
    await expectDenied(readDoc(mockUserToken("alice"), "desktopCredentials/desktop-1"));
    await expectSucceeds(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac Updated",
        uid: "alice",
        updatedAt: "2026-05-08T00:00:01.000Z",
      })
    );
    await expectDenied(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1-rotated",
        displayName: "Alice Mac",
        uid: "alice",
        updatedAt: "2026-05-08T00:00:01.000Z",
      })
    );
    await expectDenied(
      clientUpdate("bob", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-2",
        displayName: "Bob Mac",
        uid: "alice",
        updatedAt: "2026-05-08T00:00:01.000Z",
      })
    );
    await expectDenied(
      clientUpdate("bob", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "bob-takeover-hash",
        displayName: "Bob Mac",
        uid: "bob",
        updatedAt: "2026-05-08T00:00:02.000Z",
      })
    );
    await expectDenied(
      clientUpdate("alice", "desktopCredentials/desktop-2", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac",
        uid: "alice",
        updatedAt: "2026-05-08T00:00:03.000Z",
      })
    );
    await expectSucceeds(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac Updated",
        revokedAt: "2026-05-08T00:00:04.000Z",
        uid: "alice",
        updatedAt: "2026-05-08T00:00:04.000Z",
      })
    );
    await expectDenied(deleteDoc("bob", "desktopCredentials/desktop-1"));
    await expectDenied(deleteDoc("alice", "desktopCredentials/desktop-1"));
    await expectDenied(
      clientUpdate("bob", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-2",
        displayName: "Bob Mac",
        revokedAt: null,
        uid: "bob",
        updatedAt: "2026-05-08T00:00:05.000Z",
      })
    );
    await expectSucceeds(
      clientUpdate("bob", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Bob Mac",
        revokedAt: null,
        uid: "bob",
        updatedAt: "2026-05-08T00:00:06.000Z",
      })
    );
    await expectDenied(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac",
        revokedAt: null,
        uid: "alice",
        updatedAt: "2026-05-08T00:00:07.000Z",
      })
    );
  });

  it("denies creation of an incomplete canonical credential tombstone", async () => {
    await expectDenied(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        revokedAt: "2026-05-08T00:00:00.000Z",
        uid: "alice",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
  });

  it("allows the same owner to reassociate after revoking an existing canonical credential", async () => {
    await expectSucceeds(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac",
        revokedAt: null,
        uid: "alice",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
    await expectSucceeds(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac",
        revokedAt: "2026-05-08T00:00:01.000Z",
        uid: "alice",
        updatedAt: "2026-05-08T00:00:01.000Z",
      })
    );
    await expectSucceeds(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac",
        revokedAt: null,
        uid: "alice",
        updatedAt: "2026-05-08T00:00:02.000Z",
      })
    );
  });

  it("allows the same owner to reassociate after creating a canonical revoke tombstone", async () => {
    await expectSucceeds(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac",
        revokedAt: "2026-05-08T00:00:00.000Z",
        uid: "alice",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
    await expectSucceeds(
      clientUpdate("alice", "desktopCredentials/desktop-1", {
        desktopId: "desktop-1",
        desktopSecretHash: "hash-1",
        displayName: "Alice Mac",
        revokedAt: null,
        uid: "alice",
        updatedAt: "2026-05-08T00:00:01.000Z",
      })
    );
  });

  it("keeps desktop publication documents read-only for signed-in renderer clients", async () => {
    await seedDoc("users/user-1/desktops/desktop-doc-1", {
      desktopId: "desktop-1",
      updatedAt: "2026-05-08T00:00:00.000Z",
    });
    await seedDoc("users/user-1/desktops/desktop-doc-1/tasks/task-doc-1", {
      cloudTaskId: "cloud-task-1",
      ownerDesktopId: "desktop-1",
      localRepoId: "repo-1",
      ownerLocalTaskId: "task-1",
      title: "Cloud task",
    });

    await expectSucceeds(readDoc(mockUserToken("user-1"), "users/user-1/desktops/desktop-doc-1"));
    await expectSucceeds(readDoc(mockUserToken("user-1"), "users/user-1/desktops/desktop-doc-1/tasks/task-doc-1"));
    await expectDenied(readDoc(mockUserToken("user-2"), "users/user-1/desktops/desktop-doc-1/tasks/task-doc-1"));
    await expectDenied(
      clientUpdate("user-1", "users/user-1/desktops/desktop-doc-2", {
        desktopId: "desktop-2",
        updatedAt: "2026-05-08T00:00:00.000Z",
      })
    );
    await expectDenied(
      clientUpdate("user-1", "users/user-1/desktops/desktop-doc-2/tasks/task-doc-2", {
        cloudTaskId: "cloud-task-2",
        ownerDesktopId: "desktop-2",
        localRepoId: "repo-1",
        ownerLocalTaskId: "task-2",
        title: "Cloud task 2",
      })
    );
    await expectDenied(
      clientUpdate("user-1", "users/user-1/desktops/desktop-doc-1", {
        displayName: "Renderer overwrite",
      })
    );
    await expectDenied(deleteDoc("user-1", "users/user-1/desktops/desktop-doc-1/tasks/task-doc-1"));
    await expectDenied(deleteDoc("user-1", "users/user-1/desktops/desktop-doc-1"));
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

  it("keeps the entitlement record owner-readable and unwritable by any client", async () => {
    await seedDoc("users/alice/entitlements/cloud_access", {
      status: "active",
      source: "stripe",
      duplicateSources: false,
      currentPeriodEndsAt: "2026-09-20T00:00:00.000Z",
      environment: "staging",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });

    await expectSucceeds(readDoc(mockUserToken("alice"), "users/alice/entitlements/cloud_access"));
    await expectDenied(readDoc(mockUserToken("bob"), "users/alice/entitlements/cloud_access"));
    await expectDenied(
      clientUpdate("alice", "users/alice/entitlements/cloud_access", { status: "active" })
    );
    await expectDenied(
      clientUpdate("alice", "users/alice/entitlements/cloud_access_self_granted", {
        status: "active",
        source: "comp",
      })
    );
    await expectDenied(deleteDoc("alice", "users/alice/entitlements/cloud_access"));
  });

  it("keeps every billing source doc owner-readable and unwritable by any client", async () => {
    for (const source of ["stripe", "app_store", "comp"]) {
      await seedDoc(`users/alice/billing/${source}`, {
        source,
        updatedAt: "2026-08-20T00:00:00.000Z",
      });

      await expectSucceeds(readDoc(mockUserToken("alice"), `users/alice/billing/${source}`));
      await expectDenied(readDoc(mockUserToken("bob"), `users/alice/billing/${source}`));
      await expectDenied(
        clientUpdate("alice", `users/alice/billing/${source}`, { status: "active" })
      );
      await expectDenied(deleteDoc("alice", `users/alice/billing/${source}`));
    }
  });

  it("denies a client granting itself a comp entitlement", async () => {
    await expectDenied(
      clientUpdate("alice", "users/alice/billing/comp", {
        source: "comp",
        active: true,
        reason: "self-granted",
        updatedAt: "2026-08-20T00:00:00.000Z",
      })
    );
    await expectDenied(
      clientUpdate("alice", "users/alice/billing/some_new_source", {
        source: "some_new_source",
        status: "active",
        updatedAt: "2026-08-20T00:00:00.000Z",
      })
    );
  });

  it("keeps appAccountToken bindings neither readable nor writable by clients", async () => {
    await expectSucceeds(
      seedDoc("appAccountTokens/2c9b4e64-6a1f-4d0f-9f4f-7b8f6a2a5f11", {
        uid: "alice",
        updatedAt: "2026-08-20T00:00:00.000Z",
      })
    );

    await expectDenied(
      readDoc(mockUserToken("alice"), "appAccountTokens/2c9b4e64-6a1f-4d0f-9f4f-7b8f6a2a5f11")
    );
    await expectDenied(
      clientUpdate("alice", "appAccountTokens/2c9b4e64-6a1f-4d0f-9f4f-7b8f6a2a5f11", {
        uid: "alice",
      })
    );
    await expectDenied(
      clientUpdate("bob", "appAccountTokens/9f0d2c31-1c2b-4a0e-8b23-2f0b1f6d4c77", { uid: "bob" })
    );
    await expectDenied(deleteDoc("alice", "appAccountTokens/2c9b4e64-6a1f-4d0f-9f4f-7b8f6a2a5f11"));
  });

  it("keeps the Stripe webhook ledger and customer map server-only", async () => {
    await expectSucceeds(
      seedDoc("stripeEvents/evt_1", { uid: "alice", type: "invoice.paid" })
    );
    await expectSucceeds(seedDoc("stripeCustomers/cus_1", { uid: "alice" }));

    await expectDenied(readDoc(mockUserToken("alice"), "stripeEvents/evt_1"));
    await expectDenied(readDoc(mockUserToken("alice"), "stripeCustomers/cus_1"));
    await expectDenied(clientUpdate("alice", "stripeEvents/evt_2", { uid: "alice" }));
    await expectDenied(clientUpdate("alice", "stripeCustomers/cus_2", { uid: "alice" }));
  });
});
