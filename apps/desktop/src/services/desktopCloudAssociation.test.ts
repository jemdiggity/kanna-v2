import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  associateDesktopCloudCredential,
  revokeDesktopCloudCredential,
} from "./desktopCloudAssociation";
import { DesktopCloudCredentialConflictError } from "./desktopCloudCredentialConflict";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setDoc: vi.fn(async () => undefined),
  reconnectDesktopCloudRelay: vi.fn(async () => undefined),
  doc: vi.fn((...segments: unknown[]) => ({ segments })),
  serverTimestamp: vi.fn(() => "SERVER_TIMESTAMP"),
}));

vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => mocks.doc(...args),
  serverTimestamp: () => mocks.serverTimestamp(),
  setDoc: (...args: unknown[]) => mocks.setDoc(...args),
}));
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("./desktopServerClient", () => ({
  reconnectDesktopCloudRelay: () => mocks.reconnectDesktopCloudRelay(),
}));
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
    mocks.setDoc.mockReset().mockImplementation(async () => undefined);
    mocks.doc.mockClear();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_cloud_credential") {
        return { desktopId: "desktop-1", desktopSecretHash: "secret-hash" };
      }
      if (command === "mobile_server_status") return { desktopName: "Studio Mac" };
      return "";
    });
    mocks.reconnectDesktopCloudRelay.mockClear();
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

  it("reports a credential conflict when the desktop document is denied", async () => {
    mocks.setDoc.mockImplementation(async (ref: unknown) => {
      if ((ref as { segments: unknown[] }).segments.includes("desktopCredentials")) {
        throw Object.assign(new Error("Missing or insufficient permissions."), {
          code: "permission-denied",
        });
      }
    });

    await expect(associateDesktopCloudCredential()).rejects.toBeInstanceOf(
      DesktopCloudCredentialConflictError,
    );
    await expect(associateDesktopCloudCredential()).rejects.toMatchObject({
      desktopId: "desktop-1",
    });
  });

  it("raises rather than silently skipping revocation when the local credential is unavailable", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_cloud_credential") throw new Error("mobile server unavailable");
      if (command === "mobile_server_status") return { desktopName: "Studio Mac" };
      return "";
    });

    await expect(revokeDesktopCloudCredential()).rejects.toThrow("mobile server unavailable");
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });

  it("raises rather than silently skipping revocation when the credential payload is blank", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "desktop_cloud_credential") return { desktopId: "  ", desktopSecretHash: "" };
      if (command === "mobile_server_status") return { desktopName: "Studio Mac" };
      return "";
    });

    await expect(revokeDesktopCloudCredential()).rejects.toThrow(
      "cannot release this desktop: its local credential is unavailable",
    );
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });

  it("reports a credential conflict when revocation is denied", async () => {
    mocks.setDoc.mockRejectedValue(
      Object.assign(new Error("Missing or insufficient permissions."), {
        code: "permission-denied",
      }),
    );

    await expect(revokeDesktopCloudCredential()).rejects.toBeInstanceOf(
      DesktopCloudCredentialConflictError,
    );
    expect(mocks.reconnectDesktopCloudRelay).not.toHaveBeenCalled();
  });

  it("passes non-permission association failures through unchanged", async () => {
    const unavailable = Object.assign(new Error("backend unavailable"), { code: "unavailable" });
    mocks.setDoc.mockRejectedValue(unavailable);

    await expect(associateDesktopCloudCredential()).rejects.toBe(unavailable);
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
    expect(mocks.setDoc).toHaveBeenCalledTimes(1);
    expect(mocks.reconnectDesktopCloudRelay).toHaveBeenCalledOnce();
    expect(mocks.setDoc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reconnectDesktopCloudRelay.mock.invocationCallOrder[0]!,
    );
  });
});
