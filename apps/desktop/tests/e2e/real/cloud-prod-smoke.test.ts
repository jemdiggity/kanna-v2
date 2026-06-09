import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { missingCloudSmokeEnv } from "./cloudSmokeEnv";

const cloudEnv = process.env.KANNA_CLOUD_ENV ?? "staging";
const missingEnv = missingCloudSmokeEnv(process.env);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for cloud smoke tests`);
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
    throw new Error(`failed to sign in cloud smoke user: ${response.status} ${JSON.stringify(body)}`);
  }
  return { idToken: body.idToken, localId: body.localId };
}

function smokeSnapshot(runId: string) {
  const now = new Date().toISOString();
  return {
    cloudTaskId: `${cloudEnv}:smoke:${runId}`,
    ownerDesktopId: `desktop-smoke-${runId}`,
    ownerLocalTaskId: `task-smoke-${runId}`,
    title: `Kanna cloud smoke ${runId}`,
    promptSnippet: "Kanna cloud smoke",
    displayName: `Kanna cloud smoke ${runId}`,
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

async function readFirestoreDocument(
  uid: string,
  snapshot: ReturnType<typeof smokeSnapshot>,
  idToken: string,
): Promise<Record<string, unknown>> {
  const projectId = requireEnv("KANNA_FIREBASE_PROJECT_ID");
  const desktops = await listFirestoreDocuments(projectId, idToken, `users/${uid}/desktops`);
  const desktop = desktops.find((doc) =>
    readFirestoreString(doc, "desktopId") === snapshot.ownerDesktopId
  );
  if (!desktop?.name) {
    throw new Error(`failed to find smoke desktop document for ${snapshot.ownerDesktopId}`);
  }

  const desktopPath = String(desktop.name).split("/documents/")[1];
  if (!desktopPath) {
    throw new Error(`smoke desktop document has unexpected name: ${String(desktop.name)}`);
  }
  const tasks = await listFirestoreDocuments(projectId, idToken, `${desktopPath}/tasks`);
  const task = tasks.find((doc) =>
    readFirestoreString(doc, "cloudTaskId") === snapshot.cloudTaskId
  );
  if (!task) {
    throw new Error(`failed to find nested smoke task document for ${snapshot.cloudTaskId}`);
  }
  return task;
}

async function listFirestoreDocuments(
  projectId: string,
  idToken: string,
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${encodedPath}`,
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  const body = await response.json().catch(() => null) as { documents?: Array<Record<string, unknown>> } | null;
  if (!response.ok || !body) {
    throw new Error(`failed to list Firestore documents at ${path}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.documents ?? [];
}

function readFirestoreString(document: Record<string, unknown>, field: string): string | null {
  const fields = document.fields as Record<string, { stringValue?: string }> | undefined;
  return fields?.[field]?.stringValue ?? null;
}

async function publishSnapshot(
  endpoint: string,
  idToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(`failed to publish smoke snapshot: ${response.status} ${await response.text()}`);
  }
}

describe.skipIf(missingEnv.length > 0)("cloud production/staging smoke", () => {
  it("publishes a smoke task through the deployed function and reads it from Firestore", async () => {
    const runId = randomUUID().slice(0, 8);
    const { idToken, localId } = await signInForIdToken();
    const endpoint = requireEnv("KANNA_CLOUD_FUNCTIONS_ENDPOINT");
    const snapshot = smokeSnapshot(runId);
    try {
      await publishSnapshot(endpoint, idToken, snapshot);
      const document = await readFirestoreDocument(localId, snapshot, idToken);
      expect(JSON.stringify(document)).toContain(snapshot.title);
    } finally {
      await publishSnapshot(endpoint, idToken, {
        action: "delete",
        identity: {
          ownerDesktopId: snapshot.ownerDesktopId,
          localRepoId: snapshot.repo.cloudRepoId,
          ownerLocalTaskId: snapshot.ownerLocalTaskId,
        },
      }).catch(() => undefined);
    }
  });
});
