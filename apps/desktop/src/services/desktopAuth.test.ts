import { describe, expect, it, vi } from "vitest";
import {
  createDesktopAuthSession,
  createDisabledDesktopAuthSession,
  type DesktopAuthSdk,
  type DesktopAuthUser,
} from "./desktopAuth";

function user(uid: string, email: string): DesktopAuthUser {
  return { uid, email, displayName: null };
}

function createSdkMock(initialUser: DesktopAuthUser | null = null): DesktopAuthSdk {
  let currentUser = initialUser;
  const listeners = new Set<(user: DesktopAuthUser | null) => void>();

  return {
    getCurrentUser: vi.fn(() => currentUser),
    onAuthStateChanged(listener) {
      listeners.add(listener);
      listener(currentUser);
      return () => listeners.delete(listener);
    },
    signInWithEmailPassword: vi.fn(async (email: string) => {
      currentUser = user("user-1", email);
      for (const listener of listeners) listener(currentUser);
      return currentUser;
    }),
    signOut: vi.fn(async () => {
      currentUser = null;
      for (const listener of listeners) listener(null);
      return { desktopCredentialError: null };
    }),
    getIdToken: vi.fn(async () => currentUser ? `token:${currentUser.uid}` : null),
  };
}

describe("createDesktopAuthSession", () => {
  it("publishes signing-in and signed-in states after email sign-in", async () => {
    const session = createDesktopAuthSession({ sdk: createSdkMock() });
    const states: string[] = [];
    session.subscribe((state) => states.push(state.status));

    await session.signInWithEmailPassword({
      email: "upvote.sieve.7t@icloud.com",
      password: "password123",
    });

    expect(states).toEqual(["signedOut", "signingIn", "signedIn"]);
    expect(session.getState()).toEqual({
      status: "signedIn",
      user: user("user-1", "upvote.sieve.7t@icloud.com"),
    });
  });

  it("returns null tokens while disabled", async () => {
    const session = createDisabledDesktopAuthSession("Firebase Auth is not configured.");

    await expect(session.getIdToken()).resolves.toBeNull();
  });
});
