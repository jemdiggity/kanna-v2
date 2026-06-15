import { describe, expect, it, vi } from "vitest";
import {
  createMobileAuthSession,
  type MobileAuthSdk,
  type MobileAuthUser
} from "./auth";

function createUser(uid: string, email: string): MobileAuthUser {
  return {
    uid,
    email,
    displayName: null
  };
}

function createSdkMock(initialUser: MobileAuthUser | null = null): MobileAuthSdk {
  let currentUser = initialUser;
  const listeners = new Set<(user: MobileAuthUser | null) => void>();

  return {
    getCurrentUser: vi.fn(() => currentUser),
    onAuthStateChanged(listener) {
      listeners.add(listener);
      listener(currentUser);
      return () => {
        listeners.delete(listener);
      };
    },
    signInWithEmailPassword: vi.fn(async (email: string) => {
      currentUser = createUser("user-1", email);
      for (const listener of listeners) {
        listener(currentUser);
      }
      return currentUser;
    }),
    signOut: vi.fn(async () => {
      currentUser = null;
      for (const listener of listeners) {
        listener(null);
      }
    }),
    getIdToken: vi.fn(async (forceRefresh?: boolean) =>
      currentUser ? `token-${currentUser.uid}-${forceRefresh ? "fresh" : "cached"}` : null
    )
  };
}

describe("createMobileAuthSession", () => {
  it("starts signed out and notifies subscribers when email sign-in succeeds", async () => {
    const sdk = createSdkMock();
    const session = createMobileAuthSession({ sdk });
    const states: string[] = [];

    session.subscribe((state) => {
      states.push(state.status);
    });

    await session.signInWithEmailPassword({
      email: "dev@kanna.test",
      password: "secret"
    });

    expect(states).toEqual(["signedOut", "signingIn", "signedIn"]);
    expect(session.getState()).toEqual({
      status: "signedIn",
      user: createUser("user-1", "dev@kanna.test")
    });
  });

  it("keeps the auth session in an error state when sign-in fails", async () => {
    const sdk = createSdkMock();
    vi.mocked(sdk.signInWithEmailPassword).mockRejectedValueOnce(
      new Error("invalid credentials")
    );
    const session = createMobileAuthSession({ sdk });

    await session.signInWithEmailPassword({
      email: "dev@kanna.test",
      password: "bad"
    });

    expect(session.getState()).toEqual({
      status: "error",
      message: "invalid credentials",
      user: null
    });
  });

  it("returns a fresh ID token for the current signed-in user", async () => {
    const sdk = createSdkMock(createUser("user-2", "signed-in@kanna.test"));
    const session = createMobileAuthSession({ sdk });

    await session.initialize();

    await expect(session.getIdToken(true)).resolves.toBe("token-user-2-fresh");
  });

  it("clears the user after sign-out", async () => {
    const sdk = createSdkMock(createUser("user-3", "signed-in@kanna.test"));
    const session = createMobileAuthSession({ sdk });
    await session.initialize();

    await session.signOut();

    expect(session.getState()).toEqual({ status: "signedOut" });
  });

  it("surfaces an auth-expired error and keeps the user for re-login when notified", async () => {
    const user = createUser("user-4", "signed-in@kanna.test");
    const sdk = createSdkMock(user);
    const session = createMobileAuthSession({ sdk });
    await session.initialize();

    session.notifyAuthExpired();

    expect(session.getState()).toEqual({
      status: "error",
      message: "Your session expired. Please sign in again.",
      user
    });
  });

  it("ignores an auth-expired notification while signed out", async () => {
    const sdk = createSdkMock();
    const session = createMobileAuthSession({ sdk });
    await session.initialize();

    session.notifyAuthExpired();

    expect(session.getState()).toEqual({ status: "signedOut" });
  });
});
