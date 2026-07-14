import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  associateDesktopCloudCredential,
  revokeDesktopCloudCredential,
} from "./desktopCloudAssociation";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setDoc: vi.fn(async () => undefined),
  doc: vi.fn((...segments: unknown[]) => ({ segments })),
  serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
}));

vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => mocks.doc(...args),
  serverTimestamp: () => mocks.serverTimestamp(),
  setDoc: (...args: unknown[]) => mocks.setDoc(...args),
}));
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("./desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    getState: () => ({
      status: "signedIn",
      user: { uid: "user-1", email: "user@example.com" },
    }),
  })),
}));
vi.mock("./desktopCloudTaskIndex", () => ({
  getConfiguredDesktopFirestore: vi.fn(async () => ({ app: "firestore" })),
}));

describe("desktop cloud credential association", () => {
  beforeEach(() => {
    mocks.setDoc.mockClear();
    mocks.doc.mockClear();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_cloud_credential") {
        return { desktopId: "desktop-1", desktopSecretHash: "secret-hash" };
      }
      if (command === "mobile_server_status") return { desktopName: "Studio Mac" };
      return "";
    });
  });

  it("associates only the user profile and deterministic desktop credential document", async () => {
    await associateDesktopCloudCredential();

    expect(mocks.setDoc).toHaveBeenCalledTimes(2);
    expect(mocks.setDoc).toHaveBeenCalledWith(
      { segments: [{ app: "firestore" }, "users", "user-1"] },
      { primaryEmail: "user@example.com", updatedAt: "SERVER_TIMESTAMP" },
      { merge: true },
    );
    expect(mocks.setDoc).toHaveBeenCalledWith(
      { segments: [{ app: "firestore" }, "desktopCredentials", "desktop-1"] },
      {
        desktopId: "desktop-1",
        desktopSecretHash: "secret-hash",
        displayName: "Studio Mac",
        revokedAt: null,
        uid: "user-1",
        updatedAt: "SERVER_TIMESTAMP",
      },
      { merge: true },
    );
    expect(mocks.doc.mock.calls.flat()).not.toContain("tasks");
  });

  it("is idempotent when two renderer windows bootstrap the same association", async () => {
    await Promise.all([
      associateDesktopCloudCredential(),
      associateDesktopCloudCredential(),
    ]);
    const desktopWrites = mocks.setDoc.mock.calls.filter(([ref]) =>
      (ref as { segments: unknown[] }).segments.includes("desktopCredentials"));
    expect(desktopWrites).toHaveLength(2);
    expect(desktopWrites[0]).toEqual(desktopWrites[1]);
  });

  it("tombstones the canonical credential before account sign-out", async () => {
    await revokeDesktopCloudCredential();

    expect(mocks.setDoc).toHaveBeenCalledWith(
      { segments: [{ app: "firestore" }, "desktopCredentials", "desktop-1"] },
      {
        desktopId: "desktop-1",
        desktopSecretHash: "secret-hash",
        displayName: "Studio Mac",
        revokedAt: "SERVER_TIMESTAMP",
        uid: "user-1",
        updatedAt: "SERVER_TIMESTAMP",
      },
      { merge: true },
    );
  });
});
