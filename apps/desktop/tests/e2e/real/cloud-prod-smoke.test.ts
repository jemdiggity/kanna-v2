import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { missingCloudSmokeEnv } from "./cloudSmokeEnv";

const cloudEnv = process.env.KANNA_CLOUD_ENV ?? "staging";
const missingEnv = missingCloudSmokeEnv(process.env);

type FirestoreValue =
  | { nullValue: null }
  | { stringValue: string }
  | { integerValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields: FirestoreFields } };

type FirestoreFields = Record<string, FirestoreValue>;

interface FirestoreDocument {
  name: string;
  fields?: FirestoreFields;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for cloud smoke tests`);
  return value;
}

async function signInForIdToken(): Promise<{ idToken: string; localId: string; email: string }> {
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
  const body = await response.json().catch(() => null) as {
    idToken?: string;
    localId?: string;
    email?: string;
  } | null;
  if (!response.ok || !body?.idToken || !body.localId) {
    throw new Error(`failed to sign in cloud smoke user: ${response.status} ${JSON.stringify(body)}`);
  }
  return { idToken: body.idToken, localId: body.localId, email: body.email ?? email };
}

function smokeSnapshot(runId: string, title: string) {
  const now = new Date().toISOString();
  return {
    cloudTaskId: `${cloudEnv}:smoke:${runId}`,
    localRepoId: `repo-smoke-${runId}`,
    ownerDesktopId: `desktop-smoke-${runId}`,
    ownerLocalTaskId: `task-smoke-${runId}`,
    title,
    promptSnippet: "Kanna cloud smoke",
    displayName: title,
    stage: "in progress",
    activity: "idle",
    status: "active",
    repo: {
      cloudRepoId: `${cloudEnv}:smoke-repo`,
      name: "kanna-smoke",
      remoteUrl: "https://example.invalid/kanna-smoke.git",
      remoteUrlHash: `smoke-${cloudEnv}`,
      defaultBranch: "main",
    },
    branch: `task-smoke-${runId}`,
    baseRef: "origin/main",
    prNumber: null,
    prUrl: null,
    agent: { provider: "codex", type: "pty" },
    transfer: {
      state: "none",
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null,
    },
    blockedByTaskIds: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
}

function firestoreBaseUrl(): string {
  const projectId = requireEnv("KANNA_FIREBASE_PROJECT_ID");
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

function documentUrl(path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${firestoreBaseUrl()}/${encodedPath}`;
}

function collectionUrl(path: string): string {
  return documentUrl(path);
}

function authHeaders(idToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${idToken}`,
    "Content-Type": "application/json",
  };
}

async function patchFirestoreDocument(
  idToken: string,
  path: string,
  fields: FirestoreFields,
): Promise<FirestoreDocument> {
  const mask = Object.keys(fields).map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join("&");
  const response = await fetch(`${documentUrl(path)}?${mask}`, {
    method: "PATCH",
    headers: authHeaders(idToken),
    body: JSON.stringify({ fields }),
  });
  return readFirestoreResponse(response, `failed to patch Firestore document at ${path}`);
}

async function createFirestoreDocument(
  idToken: string,
  collectionPath: string,
  fields: FirestoreFields,
): Promise<FirestoreDocument> {
  const response = await fetch(collectionUrl(collectionPath), {
    method: "POST",
    headers: authHeaders(idToken),
    body: JSON.stringify({ fields }),
  });
  return readFirestoreResponse(response, `failed to create Firestore document under ${collectionPath}`);
}

async function getFirestoreDocument(
  idToken: string,
  path: string,
): Promise<FirestoreDocument> {
  const response = await fetch(documentUrl(path), {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return readFirestoreResponse(response, `failed to read Firestore document at ${path}`);
}

async function deleteFirestoreDocument(
  idToken: string,
  path: string,
): Promise<void> {
  const response = await fetch(documentUrl(path), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`failed to delete Firestore document at ${path}: ${response.status} ${await response.text()}`);
  }
}

async function expectFirestoreWriteDenied(
  idToken: string,
  path: string,
  fields: FirestoreFields,
): Promise<void> {
  const response = await fetch(documentUrl(path), {
    method: "PATCH",
    headers: authHeaders(idToken),
    body: JSON.stringify({ fields }),
  });
  if (response.ok) await deleteFirestoreDocument(idToken, path).catch(() => undefined);
  expect(response.status).toBe(403);
}

async function readFirestoreResponse(response: Response, message: string): Promise<FirestoreDocument> {
  const body = await response.json().catch(() => null) as FirestoreDocument | Record<string, unknown> | null;
  if (!response.ok || !body || typeof body.name !== "string") {
    throw new Error(`${message}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body as FirestoreDocument;
}

function documentPath(document: FirestoreDocument): string {
  const path = document.name.split("/documents/")[1];
  if (!path) throw new Error(`Firestore document has unexpected name: ${document.name}`);
  return path;
}

function snapshotFields(snapshot: ReturnType<typeof smokeSnapshot>): FirestoreFields {
  return toFirestoreFields(snapshot);
}

function toFirestoreFields(value: Record<string, unknown>): FirestoreFields {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toFirestoreValue(entry)]),
  );
}

function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === "object") return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
  throw new Error(`unsupported Firestore smoke value: ${String(value)}`);
}

function readFirestoreString(document: FirestoreDocument, field: string): string | null {
  const value = document.fields?.[field];
  return value && "stringValue" in value ? value.stringValue : null;
}

describe.skipIf(missingEnv.length > 0)("cloud production/staging smoke", () => {
  it("keeps renderer task publication read-only in deployed Firestore rules", async () => {
    const runId = randomUUID().slice(0, 8);
    const { idToken, localId, email } = await signInForIdToken();
    const desktopPath = `users/${localId}/desktops/desktop-smoke-${runId}`;
    await patchFirestoreDocument(idToken, `users/${localId}`, {
      primaryEmail: { stringValue: email },
      updatedAt: { stringValue: new Date().toISOString() },
    });
    await expectFirestoreWriteDenied(idToken, desktopPath, {
      desktopId: { stringValue: `desktop-smoke-${runId}` },
      displayName: { stringValue: "Kanna Smoke Desktop" },
      updatedAt: { stringValue: new Date().toISOString() },
    });
    await expectFirestoreWriteDenied(
      idToken,
      `${desktopPath}/tasks/task-smoke-${runId}`,
      snapshotFields(smokeSnapshot(runId, `Kanna cloud smoke ${runId}`)),
    );
    await expectFirestoreWriteDenied(idToken, `users/${localId}/tasks/${runId}`, {
      title: { stringValue: "flat task writes stay denied" },
    });
  }, 60_000);
});
